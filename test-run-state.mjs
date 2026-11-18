// Спринт 36.1.a: durable-состояние запуска.
//
// Проверяем:
//  - схема v6 создаёт runs/run_steps/run_dlq на свежей и на старой БД (user_version = 1);
//  - шаг хранит status, attempt, position, idempotency_key и timestamps;
//  - переход pending → running → passed/failed;
//  - недопустимые переходы отсекаются;
//  - retry увеличивает attempt, failed-шаг можно повторить;
//  - удаление запуска каскадно удаляет шаги;
//  - состояние переживает закрытие/переоткрытие БД.
//
// Запуск: node test-run-state.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-run-state-"));
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

const tableNames = () =>
  getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => String(row.name));

const columnsOf = (table) =>
  getDb()
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));

const indexNames = (table) =>
  getDb()
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((row) => String(row.name));

// --- 1. Свежая БД: схема v6 и таблицы durable DAG -----------------------
initDb(dbPath);
assert(SCHEMA_VERSION === 6, "SCHEMA_VERSION = 6");
assert(
  getSchemaVersion(getDb()) === SCHEMA_VERSION,
  `свежая БД: user_version = ${SCHEMA_VERSION}`,
);
assert(
  tableNames().includes("runs") && tableNames().includes("run_steps"),
  "свежая БД: таблицы runs и run_steps созданы",
);
assert(repo.isRunStateReady(), "isRunStateReady() подтверждает готовность схемы");

const stepColumns = columnsOf("run_steps");
for (const column of [
  "status",
  "attempt",
  "position",
  "idempotency_key",
  "started_at",
  "finished_at",
  "created_at",
  "updated_at",
]) {
  assert(stepColumns.includes(column), `run_steps содержит колонку ${column}`);
}
assert(
  indexNames("run_steps").some((name) => name.includes("run_steps_key")),
  "есть индекс по idempotency_key",
);

// --- 2. Создание запуска и шагов ---------------------------------------
const run = repo.createRun({
  taskName: "Nightly Build",
  workspaceId: "ws-1",
  metadata: { source: "test" },
  steps: [
    { stepName: "prepare", idempotencyKey: "nightly:prepare" },
    { stepName: "build" },
    { stepName: "publish" },
  ],
});
assert(run.status === "pending", "новый запуск создан в статусе pending");
assert(run.startedAt === null, "pending-запуск ещё не имеет started_at");
assert(run.metadata?.source === "test", "metadata запуска сохраняется как JSON");
assert(repo.countRunSteps(run.id) === 3, "все 3 шага созданы в одной транзакции");

const prepare = repo.getStep(run.id, "prepare");
assert(Boolean(prepare), "getStep находит шаг по имени");
assert(prepare.status === "pending" && prepare.attempt === 1, "шаг: pending, attempt = 1");
assert(prepare.startedAt === null && prepare.finishedAt === null, "pending-шаг без timestamps");
assert(
  repo.findStepByIdempotencyKey(run.id, "nightly:prepare")?.stepName === "prepare",
  "шаг находится по idempotency_key",
);

// Дубликат имени шага внутри запуска откатывает всю транзакцию создания.
const runsBefore = repo.listRuns().length;
assertThrows(
  () =>
    repo.createRun({
      taskName: "Broken",
      steps: [{ stepName: "same" }, { stepName: "same" }],
    }),
  "дубликат имени шага внутри запуска отклоняется",
);
assert(repo.listRuns().length === runsBefore, "неудачное создание не оставило запуск (ROLLBACK)");

// --- 3. Happy path: pending → running → passed -------------------------
assert(repo.startStep(prepare.id), "startStep переводит pending → running");
const runningStep = repo.getStepById(prepare.id);
assert(runningStep.status === "running", "шаг в статусе running");
assert(typeof runningStep.startedAt === "string" && runningStep.startedAt.length > 0, "started_at заполнен");
assert(runningStep.finishedAt === null, "пока шаг выполняется, finished_at пуст");

assert(
  repo.finishStep(prepare.id, "passed", { output: { files: 3 } }),
  "finishStep переводит running → passed",
);
const passedStep = repo.getStepById(prepare.id);
assert(passedStep.status === "passed", "шаг в статусе passed");
assert(typeof passedStep.finishedAt === "string", "finished_at заполнен");
assert(passedStep.output?.files === 3, "output шага сохраняется как JSON");
assert(repo.isTerminalStepStatus(passedStep.status), "passed — терминальный статус");

// --- 4. Недопустимые переходы ------------------------------------------
assertThrows(
  () => repo.finishStep(prepare.id, "failed"),
  "passed → failed запрещён",
);
assertThrows(
  () => repo.retryStep(prepare.id),
  "retry разрешён только для failed",
);

const build = repo.getStep(run.id, "build");
repo.startStep(build.id);
assertThrows(
  () => repo.startStep(build.id),
  "повторный running → running запрещён",
);

// --- 5. Failure path + retry: attempt увеличивается ---------------------
assert(
  repo.finishStep(build.id, "failed", { error: "exit code 1" }),
  "running → failed разрешён",
);
const failedBuild = repo.getStepById(build.id);
assert(failedBuild.status === "failed" && failedBuild.error === "exit code 1", "ошибка шага сохранена");
assert(failedBuild.attempt === 1, "после первого падения attempt = 1");

assert(repo.retryStep(build.id), "failed-шаг можно повторить");
const retriedBuild = repo.getStepById(build.id);
assert(retriedBuild.status === "running", "retry возвращает шаг в running");
assert(retriedBuild.attempt === 2, "retry увеличил attempt до 2");
assert(retriedBuild.finishedAt === null && retriedBuild.error === null, "retry очистил финал и ошибку");

repo.finishStep(build.id, "passed");
assert(repo.getStepById(build.id).attempt === 2, "после успеха attempt сохраняет номер попытки (2)");

// pending → skipped — осознанный пропуск без запуска.
const publish = repo.getStep(run.id, "publish");
assert(repo.finishStep(publish.id, "skipped", { error: "not needed" }), "pending → skipped разрешён");
assert(repo.getStepById(publish.id).status === "skipped", "шаг помечен skipped");

// --- 6. Статусы запуска -------------------------------------------------
assert(repo.startRun(run.id), "startRun переводит запуск pending → running");
assert(repo.getRun(run.id).status === "running", "запуск в статусе running");
assert(repo.getRun(run.id).startedAt !== null, "у running-запуска есть started_at");
assert(repo.finishRun(run.id, "passed"), "finishRun переводит running → passed");
assert(repo.getRun(run.id).status === "passed", "запуск завершён со статусом passed");
assert(repo.getRun(run.id).finishedAt !== null, "у завершённого запуска есть finished_at");
assertThrows(
  () => repo.finishRun(run.id, "failed"),
  "завершённый запуск нельзя завершить повторно",
);

// --- 7. Каскадное удаление ---------------------------------------------
assert(repo.deleteRun(run.id), "deleteRun удаляет запуск");
assert(repo.getRun(run.id) === undefined, "запуск больше не читается");
assert(repo.countRunSteps(run.id) === 0, "шаги удалены каскадом (ON DELETE CASCADE)");

// --- 8. Состояние переживает переоткрытие БД ---------------------------
const durable = repo.createRun({
  taskName: "Durable",
  steps: [{ stepName: "step-1" }],
});
repo.startStep(repo.getStep(durable.id, "step-1").id);
closeDb();
initDb(dbPath);

const reopened = repo.getRun(durable.id);
assert(reopened?.status === "pending", "запуск пережил переоткрытие БД");
const reopenedStep = repo.getStep(durable.id, "step-1");
assert(reopenedStep?.status === "running", "статус шага пережил переоткрытие БД");
assert(reopenedStep?.startedAt != null, "started_at шага пережил переоткрытие БД");

// --- 9. Старая БД (user_version = 1) догоняет миграцию v6 ---------------
closeDb();

const legacyPath = path.join(tempRoot, "legacy-v1", "scheduler.db");
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite");
const legacy = new DatabaseSync(legacyPath);
legacy.exec(`
  CREATE TABLE tasks (
    name TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  PRAGMA user_version = 1;
`);
legacy.close();

initDb(legacyPath);
assert(
  getSchemaVersion(getDb()) === SCHEMA_VERSION,
  `старая БД v1 поднята до user_version = ${SCHEMA_VERSION}`,
);
assert(
  tableNames().includes("runs") && tableNames().includes("run_steps"),
  "старая БД v1 получила runs и run_steps",
);
assert(repo.isRunStateReady(), "старая БД v1 готова к durable DAG");
assert(
  columnsOf("run_steps").includes("position"),
  "старая БД v1 получила колонку position",
);

const legacyRun = repo.createRun({
  taskName: "After migration",
  steps: [{ stepName: "only" }],
});
repo.startStep(repo.getStep(legacyRun.id, "only").id);
repo.finishStep(repo.getStep(legacyRun.id, "only").id, "passed");
assert(
  repo.getRun(legacyRun.id)?.status === "pending" &&
    repo.getStep(legacyRun.id, "only")?.status === "passed",
  "после миграции v6 переходы шагов работают",
);

// --- 10. БД v2 с существующей run_steps без position ----------------------
// Регрессия: индекс по position нельзя создавать в SCHEMA_SQL — на такой БД
// CREATE INDEX падал до миграции и ронял открытие соединения.
closeDb();

const v2Path = path.join(tempRoot, "legacy-v2", "scheduler.db");
fs.mkdirSync(path.dirname(v2Path), { recursive: true });
const v2 = new DatabaseSync(v2Path);
v2.exec(`
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    task_name TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_run_id TEXT,
    workspace_id TEXT,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
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
  INSERT INTO runs (id, task_name, status, created_at, updated_at)
    VALUES ('old-run', 'Old', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  INSERT INTO run_steps (id, run_id, step_name, status, created_at, updated_at)
    VALUES ('old-step', 'old-run', 'build', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  PRAGMA user_version = 2;
`);
v2.close();

initDb(v2Path);
assert(
  getSchemaVersion(getDb()) === SCHEMA_VERSION,
  "БД v2 с run_steps без position открылась и поднялась до v6",
);
assert(
  columnsOf("run_steps").includes("position"),
  "старая run_steps получила колонку position (ALTER, не падение)",
);
assert(
  repo.listRunSteps("old-run")[0]?.position === 1,
  "position существующей строки заполнен по rowid",
);
const positionIndex = getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_run_steps_position'")
  .get();
assert(Boolean(positionIndex?.name), "индекс idx_run_steps_position создан после миграции");

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть падения теста." : "\nВсе проверки durable-состояния пройдены.",
);
