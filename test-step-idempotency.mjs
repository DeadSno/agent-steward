// Спринт 36.3: идемпотентные ключи шагов.
//
// Проверяем:
//  - схема v7 (уникальность ключей появилась в v4) и частичный UNIQUE-индекс по (run_id, idempotency_key);
//  - повторный вызов с тем же ключом не выполняет тело второй раз;
//  - результат берётся из output_json, attempt не растёт;
//  - ключ уникален в пределах запуска, но переиспользуем между запусками;
//  - упавший шаг можно повторить с тем же ключом (attempt + 1);
//  - параллельный дубль в процессе отсекается StepInFlightError;
//  - ключ другого шага даёт IdempotencyConflictError;
//  - старая БД v3 с дублями ключей мигрирует: дубли обнуляются.
//
// Запуск: node test-step-idempotency.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-step-idem-"));
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
const idem = await import("./dist/db/step-idempotency.js");
const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

initDb(dbPath);

// --- 1. Схема v7 и уникальный индекс ---------------------------------------
assert(SCHEMA_VERSION === 7, "SCHEMA_VERSION = 7");
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, `user_version = ${SCHEMA_VERSION}`);

const indexes = getDb()
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_steps'")
  .all();
const uniqueIndex = indexes.find((row) => String(row.name) === "idx_run_steps_key_unique");
assert(Boolean(uniqueIndex), "есть индекс idx_run_steps_key_unique");
assert(
  String(uniqueIndex?.sql || "").toUpperCase().includes("UNIQUE"),
  "индекс по ключу идемпотентности уникальный",
);
assert(
  !indexes.some((row) => String(row.name) === "idx_run_steps_key"),
  "старый неуникальный индекс ключа удалён",
);

// --- 2. Первый запуск выполняет тело ---------------------------------------
const runA = repo.createRun({ taskName: "idempotent" });
let calls = 0;
const first = idem.runStepOnce(
  runA.id,
  "build",
  { idempotencyKey: "build-1" },
  () => {
    calls += 1;
    return { artifact: "app.zip", size: 42 };
  },
);
assert(calls === 1, "первый вызов выполнил тело один раз");
assert(first.executed === true && first.replayed === false, "первый вызов: executed, не replayed");
assert(first.attempt === 1, "первый вызов: attempt = 1");
assert(first.step.status === "passed", "первый вызов: шаг passed");
assert(first.step.idempotencyKey === "build-1", "ключ сохранён в шаге");
assert(repo.countRunSteps(runA.id) === 1, "создан ровно один шаг");

// --- 3. Повтор с тем же ключом не выполняет тело ----------------------------
const second = idem.runStepOnce(
  runA.id,
  "build",
  { idempotencyKey: "build-1" },
  () => {
    calls += 1;
    return { artifact: "duplicate.zip", size: 1 };
  },
);
assert(calls === 1, "повтор не вызвал тело шага");
assert(second.replayed === true && second.executed === false, "повтор: replayed, не executed");
assert(second.attempt === 1, "повтор: attempt не вырос");
assert(
  JSON.stringify(second.result) === JSON.stringify({ artifact: "app.zip", size: 42 }),
  "повтор вернул сохранённый output",
);
assert(repo.countRunSteps(runA.id) === 1, "повтор не создал второй шаг");

// --- 4. Кэш переживает переоткрытие БД --------------------------------------
closeDb();
initDb(dbPath);
const afterRestart = idem.runStepOnce(
  runA.id,
  "build",
  { idempotencyKey: "build-1" },
  () => {
    calls += 1;
    return null;
  },
);
assert(calls === 1, "после переоткрытия БД тело не вызвано");
assert(
  JSON.stringify(afterRestart.result) === JSON.stringify({ artifact: "app.zip", size: 42 }),
  "кэш output пережил переоткрытие БД",
);

// --- 5. Конфликт ключа с другим шагом --------------------------------------
assertThrows(
  () =>
    idem.runStepOnce(runA.id, "deploy", { idempotencyKey: "build-1" }, () => {
      calls += 1;
    }),
  "тот же ключ для другого шага запрещён",
);
assert(calls === 1, "при конфликте ключа тело не вызывалось");
assert(repo.countRunSteps(runA.id) === 1, "конфликт ключа не создал шаг");

// --- 6. Упавший шаг повторяется с тем же ключом -----------------------------
const runB = repo.createRun({ taskName: "retry" });
let attempts = 0;
assertThrows(
  () =>
    idem.runStepOnce(runB.id, "test", { idempotencyKey: "test-1" }, () => {
      attempts += 1;
      throw new Error("flaky");
    }),
  "ошибка тела пробрасывается",
);
assert(attempts === 1, "упавшее тело вызвано один раз");
assert(repo.getStep(runB.id, "test")?.status === "failed", "шаг записан как failed");
assert(repo.getStep(runB.id, "test")?.attempt === 1, "attempt = 1 после падения");

const retried = idem.runStepOnce(runB.id, "test", { idempotencyKey: "test-1" }, () => {
  attempts += 1;
  return "green";
});
assert(attempts === 2, "повтор после падения выполнил тело");
assert(retried.attempt === 2, "повтор увеличил attempt до 2");
assert(retried.step.status === "passed" && retried.result === "green", "повтор завершился passed");

const replayAfterRetry = idem.runStepOnce(
  runB.id,
  "test",
  { idempotencyKey: "test-1" },
  () => {
    attempts += 1;
  },
);
assert(attempts === 2, "после успеха тело больше не вызывается");
assert(replayAfterRetry.replayed === true && replayAfterRetry.attempt === 2, "replay сохраняет attempt = 2");

// --- 7. Заранее созданный шаг с ключом -------------------------------------
const runC = repo.createRun({ taskName: "precreated" });
repo.createStep(runC.id, { stepName: "prepare", idempotencyKey: "prep-1" });
let prepCalls = 0;
const prepared = idem.runStepOnce(runC.id, "prepare", { idempotencyKey: "prep-1" }, () => {
  prepCalls += 1;
  return "ready";
});
assert(prepCalls === 1, "заранее созданный шаг выполнен");
assert(prepared.attempt === 1 && prepared.step.status === "passed", "результат записан в существующий шаг");
assert(repo.countRunSteps(runC.id) === 1, "дубль шага не создан");

// --- 8. Параллельный дубль в одном процессе --------------------------------
const runD = repo.createRun({ taskName: "parallel" });
let parallelCalls = 0;
const firstPromise = idem.runStepOnceAsync(
  runD.id,
  "deploy",
  { idempotencyKey: "deploy-1" },
  async () => {
    parallelCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "deployed";
  },
);
const secondPromise = idem.runStepOnceAsync(
  runD.id,
  "deploy",
  { idempotencyKey: "deploy-1" },
  async () => {
    parallelCalls += 1;
    return "duplicate";
  },
);
const parallelResults = await Promise.allSettled([firstPromise, secondPromise]);
assert(parallelCalls === 1, "параллельный вызов выполнил тело один раз");
assert(parallelResults[0].status === "fulfilled", "первый параллельный вызов успешен");
assert(
  parallelResults[1].status === "rejected" &&
    parallelResults[1].reason?.name === "StepInFlightError",
  "второй параллельный вызов отсечён StepInFlightError",
);
const afterParallel = await idem.runStepOnceAsync(
  runD.id,
  "deploy",
  { idempotencyKey: "deploy-1" },
  async () => "again",
);
assert(afterParallel.replayed === true && afterParallel.result === "deployed", "после параллели кэш доступен");

// --- 9. Уникальность на уровне БД и границы запуска -------------------------
assertThrows(
  () => repo.createStep(runA.id, { stepName: "other", idempotencyKey: "build-1" }),
  "БД не принимает дубль ключа в одном запуске",
);
assert(repo.countRunSteps(runA.id) === 1, "отклонённая вставка не создала шаг");

const runE = repo.createRun({ taskName: "other-run" });
repo.createStep(runE.id, { stepName: "build", idempotencyKey: "build-1" });
assert(repo.countRunSteps(runE.id) === 1, "тот же ключ разрешён в другом запуске");

// --- 10. Миграция v3: дубли ключей обнуляются --------------------------------
closeDb();
const legacyPath = path.join(tempRoot, "legacy.db");
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, task_name TEXT NOT NULL, status TEXT NOT NULL,
    parent_run_id TEXT, workspace_id TEXT, started_at TEXT, finished_at TEXT,
    error TEXT, metadata_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    output_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(run_id, step_name)
  );
  CREATE INDEX idx_run_steps_key ON run_steps(run_id, idempotency_key);
  INSERT INTO runs (id, task_name, status, created_at, updated_at)
    VALUES ('legacy-run', 'legacy', 'running', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  INSERT INTO run_steps (id, run_id, step_name, position, status, attempt, idempotency_key, created_at, updated_at)
    VALUES ('s1', 'legacy-run', 'one', 0, 'passed', 1, 'dup', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  INSERT INTO run_steps (id, run_id, step_name, position, status, attempt, idempotency_key, created_at, updated_at)
    VALUES ('s2', 'legacy-run', 'two', 1, 'passed', 1, 'dup', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  PRAGMA user_version = 3;
`);
legacy.close();

initDb(legacyPath);
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, "старая БД v3 поднята до текущей версии");
const legacySteps = repo.listRunSteps("legacy-run");
assert(legacySteps.length === 2, "шаги старой БД на месте");
assert(legacySteps[0].idempotencyKey === "dup", "первый дубль ключа сохранён");
assert(legacySteps[1].idempotencyKey === null, "второй дубль ключа обнулён");
const legacyIndexes = getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'run_steps'")
  .all()
  .map((row) => String(row.name));
assert(legacyIndexes.includes("idx_run_steps_key_unique"), "миграция создала уникальный индекс");
assert(!legacyIndexes.includes("idx_run_steps_key"), "старый индекс удалён при миграции");

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть ошибки идемпотентности." : "\nВсе проверки идемпотентных ключей пройдены.",
);

