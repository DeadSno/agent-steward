// P3-4: версионирование схемы SQLite через PRAGMA user_version.
//
// Проверяем:
//  - свежая БД получает текущую SCHEMA_VERSION;
//  - повторное открытие не меняет версию и не падает;
//  - legacy-БД (user_version = 0, старый набор колонок) догоняется
//    миграцией и тоже фиксирует актуальную версию;
//  - /api/health отдаёт schemaVersion и expectedSchemaVersion.
//
// Запуск: node test-user-version.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-user-version-"));
process.env.APPDATA = tempRoot;

const freshDbPath = path.join(tempRoot, "fresh", "scheduler.db");
process.env.OPENCODE_SCHEDULER_DB = freshDbPath;

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const { initDb, closeDb, getDb, getDbStatus } = await import("./dist/db/index.js");
const { SCHEMA_VERSION, getSchemaVersion } = await import("./dist/db/schema.js");

const rawUserVersion = (db) => {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? -1);
};

const tableColumns = (db, table) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);

// --- 1. Свежая БД получает актуальную версию ---------------------------
{
  initDb(freshDbPath);
  const db = getDb();
  assert(
    rawUserVersion(db) === SCHEMA_VERSION,
    `свежая БД: user_version = ${SCHEMA_VERSION} (получено ${rawUserVersion(db)})`,
  );
  assert(getSchemaVersion(db) === SCHEMA_VERSION, "getSchemaVersion совпадает с константой");

  const status = getDbStatus();
  assert(status.schemaVersion === SCHEMA_VERSION, "health: schemaVersion актуален");
  assert(
    status.expectedSchemaVersion === SCHEMA_VERSION,
    "health: expectedSchemaVersion актуален",
  );
}

// --- 2. Повторное открытие идемпотентно --------------------------------
{
  closeDb();
  initDb(freshDbPath);
  const db = getDb();
  assert(rawUserVersion(db) === SCHEMA_VERSION, "повторный initDb не меняет версию схемы");
  assert(
    tableColumns(db, "metrics").includes("partial"),
    "повторный initDb не теряет колонку metrics.partial",
  );
}

// --- 3. Legacy-БД (user_version = 0) догоняется миграцией ---------------
{
  closeDb();

  const legacyPath = path.join(tempRoot, "legacy", "scheduler.db");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });

  const nodeRequire = createRequire(import.meta.url);
  const { DatabaseSync } = nodeRequire("node:sqlite");
  const legacy = new DatabaseSync(legacyPath);

  // Старый набор колонок: без workspace_id/allowed_tools/denied_tools,
  // без matrix-флагов, без env_json/env_file и без metrics.partial.
  legacy.exec(`
    CREATE TABLE tasks (
      name TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_name TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      error TEXT,
      tokens INTEGER,
      cost_usd REAL,
      model TEXT,
      pre_flight_status TEXT,
      post_flight_status TEXT,
      next_task TEXT
    );
    CREATE TABLE metrics (
      task_name TEXT PRIMARY KEY,
      total INTEGER DEFAULT 0,
      success INTEGER DEFAULT 0,
      error INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      git_remote TEXT,
      color TEXT,
      created_at TEXT NOT NULL
    );
  `);
  assert(rawUserVersion(legacy) === 0, "legacy-БД начинается с user_version = 0");
  legacy.close();

  initDb(legacyPath);
  const db = getDb();

  assert(
    tableColumns(db, "history").includes("workspace_id") &&
      tableColumns(db, "history").includes("allowed_tools") &&
      tableColumns(db, "history").includes("denied_tools"),
    "legacy: history догоняет workspace_id/allowed_tools/denied_tools",
  );
  assert(
    tableColumns(db, "tasks").includes("matrix_parent_id") &&
      tableColumns(db, "tasks").includes("is_matrix_parent"),
    "legacy: tasks догоняет matrix-флаги",
  );
  assert(
    tableColumns(db, "workspaces").includes("env_json") &&
      tableColumns(db, "workspaces").includes("env_file"),
    "legacy: workspaces догоняет env_json/env_file",
  );
  assert(
    tableColumns(db, "metrics").includes("partial"),
    "legacy: metrics догоняет partial",
  );
  assert(
    rawUserVersion(db) === SCHEMA_VERSION,
    `legacy: user_version поднят до ${SCHEMA_VERSION} (получено ${rawUserVersion(db)})`,
  );

  // Повторный прогон на уже мигрированной legacy-БД ничего не ломает.
  closeDb();
  initDb(legacyPath);
  assert(
    rawUserVersion(getDb()) === SCHEMA_VERSION,
    "legacy: повторная миграция оставляет версию стабильной",
  );
}

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть падения теста." : "\nВсе проверки версии схемы пройдены.",
);
