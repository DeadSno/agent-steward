import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { normalizeWatchPath, validateWatchGlobs } = await import("./dist/core/watch-paths.js");
const {
  FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,
  FILE_SELF_WRITE_SUPPRESS_ENV,
  parseFileSelfWriteSuppressMs,
  resolveFileSelfWriteSuppressMs,
} = await import("./dist/core/file-watcher.js");

const base = path.resolve("tmp-watch-base");

// Абсолютный путь остаётся абсолютным (явное намерение пользователя).
const absolute = path.resolve("tmp-watch-absolute", "app.log");
assert.equal(normalizeWatchPath(absolute, base), path.normalize(absolute), "абсолютный watchPath сохранён");

// Относительный путь резолвится от рабочей директории задачи.
assert.equal(
  normalizeWatchPath("logs/app.log", base),
  path.resolve(base, "logs/app.log"),
  "относительный watchPath резолвится от base"
);

// Выход за пределы base запрещён.
for (const evil of ["../evil", "a/../../evil", "..\\evil"]) {
  let failed = false;
  try {
    normalizeWatchPath(evil, base);
  } catch (err) {
    failed = /выходит за пределы/.test(err.message);
  }
  assert(failed, `watchPath "${evil}" отклонён`);
}

// Управляющие символы запрещены.
for (const bad of ["bad\npath", "bad\u0000path"]) {
  let failed = false;
  try {
    normalizeWatchPath(bad, base);
  } catch (err) {
    failed = /управляющих символов/.test(err.message);
  }
  assert(failed, "watchPath с управляющими символами отклонён");
}

// Пустой путь запрещён.
assert.throws(() => normalizeWatchPath("   ", base), /не может быть пустым/, "пустой watchPath отклонён");

// Валидные glob-маски проходят без изменений.
const globs = ["**/*.md", "src/**", "*.json"];
assert.deepEqual(validateWatchGlobs(globs), globs, "валидные glob-маски приняты");

// Абсолютные маски и выход через `..` запрещены.
for (const bad of ["../*.md", "a/../../*.md", "/etc/*", "C:/Windows/*", "C:\\Windows\\*"]) {
  let failed = false;
  try {
    validateWatchGlobs([bad]);
  } catch (err) {
    failed = /относительной|за пределы/.test(err.message);
  }
  assert(failed, `glob-маска "${bad}" отклонена`);
}

// Управляющие символы в маске запрещены.
assert.throws(
  () => validateWatchGlobs(["bad\nmask"]),
  /управляющих символов/,
  "glob-маска с переводом строки отклонена"
);

// PL-130: файловый триггер должен подавлять собственные записи агента.
// Проверки по исходникам детерминированы: реальный chokidar в тесте не поднимаем.
const watcherSrc = fs.readFileSync(path.resolve("src/core/file-watcher.ts"), "utf8");
assert(
  watcherSrc.includes("export const FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS = 15000"),
  "PL-130: объявлена константа окна подавления с значением по умолчанию 15000 мс"
);
assert(
  watcherSrc.includes(
    "suppressForTask(taskName: string, ms: number = this.suppressMs): void"
  ),
  "PL-130/PL-143: FileWatchManager объявляет публичный suppressForTask(taskName, ms?) с окном из env"
);
assert(
  watcherSrc.includes("this.suppressUntil.set(taskName.toLowerCase()"),
  "PL-130: задача помечается по имени в нижнем регистре до now+ms"
);
assert(
  watcherSrc.includes("Date.now() < until") &&
    watcherSrc.indexOf("Date.now() < until") < watcherSrc.indexOf("clearTimeout(entry.timer)"),
  "PL-130: onChange игнорирует изменение до истечения окна, не трогая дебаунс-таймер"
);
// Деталь 3.18 / P-1.1: обработчик перенесён из src/index.ts в src/runtime.ts
// при изоляции ядра; тест следует за кодом, а не тянет фрагмент обратно.
const runtimeSrc = fs.readFileSync(path.resolve("src/runtime.ts"), "utf8");
const SUPPRESS_CALL = "getFileWatcherManager()?.suppressForTask(taskName)";
const EVENT_RUN_CALL = 'scheduleEventRun(taskName, "изменение отслеживаемого файла")';
assert(
  runtimeSrc.includes(SUPPRESS_CALL),
  "PL-130: обработчик файлового триггера подавляет запись до scheduleEventRun (src/runtime.ts)"
);
assert(
  runtimeSrc.indexOf(SUPPRESS_CALL) < runtimeSrc.indexOf(EVENT_RUN_CALL),
  "PL-130: подавление вызывается ПЕРЕД запуском задачи"
);

// PL-143: окно подавления настраивается через env, дефолт — 15000 мс.
assert.equal(
  FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,
  15000,
  "PL-143: окно подавления по умолчанию равно 15000 мс"
);
assert.equal(
  FILE_SELF_WRITE_SUPPRESS_ENV,
  "AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS",
  "PL-143: имя переменной окружения зафиксировано"
);

// Чистая функция разбора: env задаёт окно (0 — подавление выключено).
assert.deepEqual(
  parseFileSelfWriteSuppressMs("1234"),
  { value: 1234, warning: null },
  "PL-143: валидное значение env задаёт окно подавления"
);
assert.deepEqual(
  parseFileSelfWriteSuppressMs(" 0 "),
  { value: 0, warning: null },
  "PL-143: 0 — корректное значение (подавление выключено)"
);
assert.deepEqual(
  parseFileSelfWriteSuppressMs(undefined),
  { value: 15000, warning: null },
  "PL-143: неустановленный env даёт дефолт 15000 без предупреждения"
);

// Невалидное значение → дефолт + предупреждение с именем переменной.
for (const bad of ["abc", "-5", "1.5", "", "   ", "999999999999999999999"]) {
  const parsed = parseFileSelfWriteSuppressMs(bad);
  assert.equal(parsed.value, 15000, `PL-143: невалидное "${bad}" → дефолт 15000`);
  assert(
    parsed.warning !== null &&
      parsed.warning.includes("PL-143") &&
      parsed.warning.includes("AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS"),
    `PL-143: невалидное "${bad}" сопровождается предупреждением`
  );
}
// Резолвер читает именно env и предупреждает о невалидном значении.
assert.equal(
  resolveFileSelfWriteSuppressMs({ AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS: "2500" }),
  2500,
  "PL-143: резолвер берёт окно из переданного env"
);
const originalWarn = console.warn;
const warnings = [];
console.warn = (msg) => warnings.push(String(msg));
let resolvedBad;
try {
  resolvedBad = resolveFileSelfWriteSuppressMs({
    AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS: " nonnegative ",
  });
} finally {
  console.warn = originalWarn;
}
assert.equal(resolvedBad, 15000, "PL-143: невалидное env → дефолт 15000");
assert(
  warnings.length === 1 && warnings[0].includes("PL-143"),
  "PL-143: невалидное env пишет предупреждение в консоль"
);

// Исходники: лог подавления обязателен и содержит имя задачи и путь.
assert(
  watcherSrc.includes(
    'FILE_SELF_WRITE_SUPPRESS_ENV = "AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS"'
  ),
  "PL-143: объявлено имя переменной окружения"
);
assert(
  watcherSrc.includes("[PL-143] Подавляю self-write задачи") &&
    watcherSrc.includes('изменение "${changedPath}"'),
  "PL-143: onChange логирует подавление с именем задачи и путём"
);
assert(
  runtimeSrc.includes("[PL-143]") && runtimeSrc.includes("selfWriteSuppressMs"),
  "PL-143: обработчик файлового триггера логирует настроенное окно"
);

console.log("Watch paths: все проверки пройдены.");
