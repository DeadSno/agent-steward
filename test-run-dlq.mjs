// Спринт 36.4: DLQ — детерминированно упавшие шаги и ручной retry.
//
// Проверяем:
//  - схема v5: таблица run_dlq и частичный UNIQUE по открытым записям;
//  - шаг, исчерпавший попытки, попадает в очередь со снимком ошибки;
//  - повторный скан не создаёт дублей, шаг ниже порога не попадает;
//  - ручной retry переоткрывает запуск, делает attempt + 1 и закрывает запись;
//  - запись закрывается и при осознанном отказе (discard);
//  - повторная обработка закрытой записи запрещена;
//  - удаление запуска уносит записи DLQ каскадом;
//  - старая БД v4 получает таблицу миграцией и работает с очередью.
//
// Запуск: node test-run-dlq.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-dlq-"));
const dbPath = path.join(tempRoot, "scheduler.db");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const assertThrows = (fn, msg) => {
  try {
    fn();
  } catch {
    assert(true, msg);
    return;
  }
  assert(false, msg);
};

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { SCHEMA_VERSION, getSchemaVersion } = await import("./dist/db/schema.js");
const repo = await import("./dist/db/runs-repo.js");
const dlq = await import("./dist/db/run-dlq.js");
const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

initDb(dbPath);

// Прогоняет шаг через N неудачных попыток и оставляет его failed.
function failStepN(runId, stepName, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const step = repo.getStep(runId, stepName);
    if (step.status === "failed") {
      repo.retryStep(step.id);
    } else {
      repo.startStep(step.id);
    }
    repo.finishStep(repo.getStep(runId, stepName).id, "failed", {
      error: `boom-${i + 1}`,
    });
  }
}

// --- 1. Схема v5 и индексы DLQ ---------------------------------------------
assert(SCHEMA_VERSION === 5, "SCHEMA_VERSION = 5");
assert(getSchemaVersion(getDb()) === 5, "user_version = 5");

const tables = getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_dlq'")
  .all();
assert(tables.length === 1, "есть таблица run_dlq");

const dlqIndexes = getDb()
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_dlq'")
  .all();
const openIndex = dlqIndexes.find((row) => String(row.name) === "idx_run_dlq_open_unique");
assert(Boolean(openIndex), "есть индекс idx_run_dlq_open_unique");
assert(
  String(openIndex?.sql || "").toUpperCase().includes("UNIQUE") &&
    String(openIndex?.sql || "").toUpperCase().includes("WHERE STATUS = 'OPEN'"),
  "индекс открытых записей частичный и уникальный",
);
assert(dlq.isDlqReady(), "isDlqReady() видит таблицу");

// --- 2. Детерминированно упавший шаг попадает в очередь --------------------
const runA = repo.createRun({ taskName: "dlq-task", steps: [{ stepName: "build" }, { stepName: "deploy" }] });
repo.startRun(runA.id);
failStepN(runA.id, "build", 3);
repo.finishRun(runA.id, "failed", { error: "build упал" });

assert(dlq.isDeadLetterStep(repo.getStep(runA.id, "build")), "шаг с attempt 3 — кандидат в DLQ");
assert(
  !dlq.isDeadLetterStep(repo.getStep(runA.id, "deploy")),
  "нетронутый шаг в DLQ не кандидат",
);

const scanned = dlq.scanDeadLetters();
assert(scanned.length === 1, "скан нашёл один упавший шаг");
const entry = scanned[0];
assert(entry.runId === runA.id && entry.stepName === "build", "запись указывает на build");
assert(entry.status === "open", "новая запись открыта");
assert(entry.reason === "attempts-exhausted", "причина — исчерпаны попытки");
assert(entry.attempts === 3, "снимок попыток = 3");
assert(entry.error === "boom-3", "снимок ошибки — последняя ошибка шага");
assert(dlq.countDeadLetters() === 1, "в очереди одна открытая запись");

// --- 3. Скан идемпотентен ---------------------------------------------------
const rescan = dlq.scanDeadLetters();
assert(rescan.length === 0, "повторный скан не создаёт новых записей");
assert(dlq.listDeadLetters({ status: "all" }).length === 1, "дублей в очереди нет");

// Повторная явная постановка возвращает существующую запись.
const duplicate = dlq.enqueueDeadLetter(runA.id, "build");
assert(duplicate.created === false && duplicate.entry.id === entry.id, "enqueue идемпотентен");

// --- 4. Шаг ниже порога в очередь не попадает ------------------------------
const runB = repo.createRun({ taskName: "dlq-threshold", steps: [{ stepName: "flaky" }] });
repo.startRun(runB.id);
failStepN(runB.id, "flaky", 1);
repo.finishRun(runB.id, "failed");
assert(
  dlq.scanDeadLetters({ runId: runB.id }).length === 0,
  "один фейл не считается детерминированным",
);
assert(
  dlq.scanDeadLetters({ runId: runB.id, minAttempts: 1 }).length === 1,
  "своим порогом шаг можно поставить в очередь",
);
dlq.discardDeadLetter(dlq.listDeadLetters({ status: "open" }).find((e) => e.runId === runB.id).id);

// --- 5. Ручной retry из DLQ -------------------------------------------------
const retried = dlq.retryDeadLetter(entry.id);
assert(retried.entry.status === "retried", "запись закрыта как retried");
assert(retried.entry.resolution === "manual-retry", "зафиксирован способ закрытия");
assert(retried.step.status === "running", "шаг переведён в running");
assert(retried.step.attempt === 4, "attempt вырос до 4");
assert(retried.run.status === "running", "упавший запуск переоткрыт");
assert(retried.runReopened === true, "runReopened = true");
assert(retried.run.finishedAt === null, "finished_at сброшен у запуска");
assert(dlq.countDeadLetters("open") === 0, "открытых записей не осталось");

assertThrows(() => dlq.retryDeadLetter(entry.id), "повторный retry закрытой записи запрещён");
assertThrows(() => dlq.discardDeadLetter(entry.id), "закрытую запись нельзя отменить");

// Завершаем шаг и запуск — очередь при этом не трогаем.
repo.finishStep(retried.step.id, "passed", { output: { ok: true } });
repo.finishRun(runA.id, "passed");
assert(dlq.countDeadLetters("open") === 0, "успешный retry не возвращает запись в очередь");

// --- 6. Discard и фильтры ---------------------------------------------------
const runC = repo.createRun({ taskName: "dlq-discard", steps: [{ stepName: "publish" }] });
repo.startRun(runC.id);
failStepN(runC.id, "publish", 3);
repo.finishRun(runC.id, "failed");
const [discardCandidate] = dlq.scanDeadLetters({ runId: runC.id });
const discarded = dlq.discardDeadLetter(discardCandidate.id, "не актуально");
assert(discarded.status === "discarded", "запись закрыта как discarded");
assert(discarded.resolution === "не актуально", "причина отказа сохранена");
assert(discarded.resolvedAt !== null, "resolved_at заполнен");
assert(dlq.countDeadLetters("discarded") === 2, "обе discarded-записи видны в счётчике");

assert(
  dlq.listDeadLetters({ status: "all" }).length === 3,
  "listDeadLetters(all) возвращает retried + discarded + прошлый discard",
);

// --- 7. Каскадное удаление запуска -----------------------------------------
const beforeCascade = dlq.listDeadLetters({ status: "all" }).length;
repo.deleteRun(runC.id);
assert(
  dlq.listDeadLetters({ status: "all" }).length === beforeCascade - 1,
  "удаление запуска уносит его запись DLQ",
);
assert(
  dlq.getDeadLetter(discardCandidate.id) === undefined,
  "запись удалённого запуска недоступна",
);

// --- 8. Переживает переподключение -----------------------------------------
closeDb();
initDb(dbPath);
assert(dlq.isDlqReady(), "после reconnect таблица DLQ на месте");
assert(dlq.listDeadLetters({ status: "all" }).length === 2, "история DLQ сохранилась");

// --- 9. Старая БД v4 получает DLQ миграцией --------------------------------
closeDb();
const legacyPath = path.join(tempRoot, "legacy-v4.db");
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_name TEXT NOT NULL, status TEXT NOT NULL,
    parent_run_id TEXT, workspace_id TEXT, started_at TEXT, finished_at TEXT,
    error TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE run_steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1, idempotency_key TEXT, started_at TEXT,
    finished_at TEXT, error TEXT, output_json TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, UNIQUE(run_id, step_name)
  );
  PRAGMA user_version = 4;
`);
legacy.close();

initDb(legacyPath);
assert(getSchemaVersion(getDb()) === 5, "legacy v4 мигрировала до v5");
assert(dlq.isDlqReady(), "в legacy-БД появилась run_dlq");
const legacyRun = repo.createRun({ taskName: "legacy", steps: [{ stepName: "old" }] });
repo.startRun(legacyRun.id);
failStepN(legacyRun.id, "old", 3);
repo.finishRun(legacyRun.id, "failed");
assert(dlq.scanDeadLetters({ runId: legacyRun.id }).length === 1, "очередь работает в мигрированной БД");

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("DLQ: проверки завершены.");
