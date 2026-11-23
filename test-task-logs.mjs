/**
 * PL-67 — регрессия поиска лога задачи по короткому/префиксному имени.
 *
 * get_task_logs должен находить лог и по полному имени задачи, и по короткому
 * (ARCH-7 → arch-7-approval-queue.log): через реестр задач или по шаблону
 * <slug>*.log в LOG_DIR. Публичный контракт {logs, error?} не меняется.
 *
 * Запуск: node test-task-logs.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-task-logs-"));
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "home");

const { LOG_DIR, sanitizeName } = await import("./dist/types.js");
const { getTaskLogs } = await import("./dist/core/scheduler/logs.js");
const { saveTask, deleteTask } = await import("./dist/db/tasks-repo.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const MARKER = "PL67-REGRESSION-MARKER";
const FULL_NAME = "ARCH-7 - Approval queue";
const FULL_BASE = sanitizeName(FULL_NAME); // arch-7-approval-queue

function writeLog(base, marker) {
  fs.writeFileSync(
    path.join(LOG_DIR, `${base}.log`),
    `[agent-steward] === Run started 2026-11-23\n${marker}\n`,
    "utf8",
  );
}

// Реальный сценарий из находки: файл arch-7-approval-queue.log, задача в реестре.
writeLog(FULL_BASE, MARKER);
saveTask({ name: FULL_NAME, schedule: "0 3 * * *", prompt: "PL-67 regression" });

// 1. Короткое имя ARCH-7 (главная регрессия PL-67).
const short = await getTaskLogs("ARCH-7");
check(
  "PL-67: короткое имя ARCH-7 находит лог полной задачи",
  short.error === undefined && short.logs.includes(MARKER),
);

// 2. Сравнение регистронезависимое и не зависит от дефисов/пробелов.
const lower = await getTaskLogs("arch-7");
check(
  "PL-67: регистронезависимый поиск по slug",
  lower.error === undefined && lower.logs.includes(MARKER),
);

// 3. Полное имя работает как раньше (сохранение текущего поведения).
const full = await getTaskLogs(FULL_NAME);
check(
  "PL-67: полное имя задачи по-прежнему возвращает лог",
  full.error === undefined && full.logs.includes(MARKER),
);

// 4. Действительно отсутствующий лог даёт прежнюю понятную ошибку.
const missing = await getTaskLogs("totally-unknown-task");
check(
  "PL-67: неизвестное имя даёт ошибку «не найден» с путём",
  missing.logs === "" &&
    typeof missing.error === "string" &&
    missing.error.includes("не найден") &&
    missing.error.includes("totally-unknown-task.log"),
);

// 5. Несколько кандидатов: реестр выбирает записанную задачу (приоритет).
writeLog("arch-7-r2-gate", "PL67-R2-GATE");
const multi = await getTaskLogs("ARCH-7");
check(
  "PL-67: несколько кандидатов — приоритет у задачи из реестра",
  multi.error === undefined &&
    multi.logs.includes(MARKER) &&
    !multi.logs.includes("PL67-R2-GATE"),
);

// 6. Несколько кандидатов без реестра — детерминированный выбор (самый короткий slug).
deleteTask(FULL_NAME);
const multiNoRegistry = await getTaskLogs("ARCH-7");
const repeat = await getTaskLogs("ARCH-7");
check(
  "PL-67: без реестра несколько <slug>*.log дают детерминированный результат",
  multiNoRegistry.error === undefined &&
    (multiNoRegistry.logs.includes(MARKER) ||
      multiNoRegistry.logs.includes("PL67-R2-GATE")) &&
    multiNoRegistry.logs === repeat.logs,
);

// 7. Fallback по единственному файлу <slug>*.log без записи в реестре.
fs.unlinkSync(path.join(LOG_DIR, "arch-7-r2-gate.log"));
const single = await getTaskLogs("ARCH-7");
check(
  "PL-67: единственный <slug>*.log находится без записи в реестре",
  single.error === undefined && single.logs.includes(MARKER),
);

// 8. Публичный контракт результата не расширялся.
check(
  "PL-67: контракт результата {logs, error?} сохранён",
  Object.keys(short).every((key) => key === "logs" || key === "error") &&
    typeof short.logs === "string",
);

const failed = results.filter((r) => !r.ok);
console.log(`\nTask logs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
