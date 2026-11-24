import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { normalizeWatchPath, validateWatchGlobs } = await import("./dist/core/watch-paths.js");

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
    "suppressForTask(\n    taskName: string,\n    ms: number = FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,\n  ): void"
  ),
  "PL-130: FileWatchManager объявляет публичный suppressForTask(taskName, ms?)"
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
const indexSrc = fs.readFileSync(path.resolve("src/index.ts"), "utf8");
assert(
  indexSrc.includes("fileWatcherManager?.suppressForTask(taskName)"),
  "PL-130: обработчик файлового триггера подавляет запись до scheduleEventRun"
);
assert(
  indexSrc.indexOf("fileWatcherManager?.suppressForTask(taskName)") <
    indexSrc.indexOf('scheduleEventRun(taskName, "изменение отслеживаемого файла")'),
  "PL-130: подавление вызывается ПЕРЕД запуском задачи"
);

console.log("Watch paths: все проверки пройдены.");
