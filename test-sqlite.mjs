// Тесты Спринта 12: миграция JSON → SQLite, репозитории, транзакции,
// crash recovery и экспорт .db-файла.
//
// Запуск: node test-sqlite.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-sqlite-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const tasksJson = [
  {
    name: "Daily Report",
    schedule: "0 9 * * *",
    prompt: "Сделай отчёт",
    createdAt: "2026-01-01T00:00:00.000Z",
    workdir: "C:\\projects\\report",
  },
  {
    name: "Nightly Build",
    schedule: "0 3 * * *",
    prompt: "Собери проект",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
];
const historyJson = [
  {
    taskName: "Daily Report",
    status: "success",
    startedAt: "2026-02-01T09:00:00.000Z",
    finishedAt: "2026-02-01T09:01:00.000Z",
    durationMs: 60000,
    tokens: 100,
    costUsd: 0.01,
    model: "test/model",
    preFlightStatus: "success",
    postFlightStatus: "skipped",
  },
  {
    taskName: "Nightly Build",
    status: "error",
    startedAt: "2026-02-01T03:00:00.000Z",
    finishedAt: "2026-02-01T03:00:30.000Z",
    durationMs: 30000,
    error: "exit code 1",
    tokens: 50,
    costUsd: 0.005,
  },
  {
    taskName: "Daily Report",
    status: "timeout",
    startedAt: "2026-02-02T09:00:00.000Z",
    finishedAt: "2026-02-02T09:05:00.000Z",
    durationMs: 300000,
    error: "timeout",
    tokens: 10,
    costUsd: 0.001,
  },
];
const metricsJson = {
  total: 5,
  success: 2,
  error: 3,
  tokens: 1000,
  costUsd: 0.5,
};
const templatesJson = [
  { id: "tpl-1", name: "Отчёт", prompt: "Сделай отчёт", schedule: "0 9 * * *" },
];

fs.writeFileSync(path.join(pluginDir, "tasks.json"), JSON.stringify(tasksJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "history.json"), JSON.stringify(historyJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "metrics.json"), JSON.stringify(metricsJson, null, 2));
fs.writeFileSync(path.join(pluginDir, "templates.json"), JSON.stringify(templatesJson, null, 2));

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const { initDb, closeDb, getDb, getDbFile, isDatabaseEmpty, getDbStatus } =
  await import("./dist/db/index.js");
const { migrateJsonToDb } = await import("./dist/db/migrate.js");
const { recoverInterruptedRuns } = await import("./dist/db/recovery.js");
const tasksRepo = await import("./dist/db/tasks-repo.js");
const historyRepo = await import("./dist/db/history-repo.js");
const { loadHistory } = await import("./dist/history.js");
const metricsRepo = await import("./dist/db/metrics-repo.js");
const templatesRepo = await import("./dist/db/templates-repo.js");

const dbPath = getDbFile();
initDb();

// --- 1. Миграция -------------------------------------------------------
assert(isDatabaseEmpty(), "до миграции БД пуста");
const migration = await migrateJsonToDb();
assert(migration.migrated, "миграция выполнена");
assert(migration.tasks === 2, "перенесено 2 задачи (получено " + migration.tasks + ")");
assert(migration.history === 3, "перенесено 3 записи истории (получено " + migration.history + ")");
assert(migration.templates === 1, "перенесён 1 шаблон (получено " + migration.templates + ")");
assert(
  fs.existsSync(path.join(pluginDir, "tasks.json.bak")) &&
    !fs.existsSync(path.join(pluginDir, "tasks.json")),
  "tasks.json переименован в tasks.json.bak"
);
assert(fs.existsSync(path.join(pluginDir, "history.json.bak")), "history.json переименован в .bak");
assert(fs.existsSync(path.join(pluginDir, "templates.json.bak")), "templates.json переименован в .bak");

const again = await migrateJsonToDb();
assert(!again.migrated && again.tasks === 0, "повторная миграция не выполняется (БД не пуста)");

// --- 2. Задачи: чтение/запись/удаление ---------------------------------
const tasks = tasksRepo.listTasks();
assert(tasks.length === 2, "listTasks вернул 2 задачи");
const report = tasksRepo.getTask("daily report");
assert(Boolean(report), "getTask ищет без учёта регистра");
assert(report.workingDirectory === "C:\\projects\\report", "workdir мигрирован в workingDirectory");
assert(!("workdir" in report), "старое поле workdir удалено");
assert(report.createdAt === "2026-01-01T00:00:00.000Z", "createdAt сохранён при миграции");

const beforeCreatedAt = report.createdAt;
tasksRepo.saveTask({ ...report, prompt: "Обновлённый промпт" });
const updated = tasksRepo.getTask("DAILY REPORT");
assert(updated.prompt === "Обновлённый промпт", "saveTask обновляет существующую задачу");
assert(updated.createdAt === beforeCreatedAt, "createdAt не перезаписывается при обновлении");

tasksRepo.saveTask({ name: "One-off", schedule: "0 0 * * *", prompt: "Разово" });
assert(tasksRepo.countTasks() === 3, "saveTask добавляет новую задачу");
assert(tasksRepo.deleteTask("one-off"), "deleteTask находит имя без учёта регистра");
assert(tasksRepo.countTasks() === 2, "deleteTask удаляет задачу");

// --- 3. История + метрики в транзакции ---------------------------------
historyRepo.recordRun(
  "Daily Report",
  "success",
  "2026-03-01T09:00:00.000Z",
  1200,
  null,
  "Nightly Build",
  200,
  0.02,
  "test/model",
  "success",
  "success"
);
const runHistory = historyRepo.getHistory("daily report", 10);
assert(runHistory.length === 3, "recordRun добавил запись в историю");
assert(runHistory[0].nextTask === "Nightly Build", "nextTask сохраняется");
assert(runHistory[0].tokens === 200 && runHistory[0].costUsd === 0.02, "токены и стоимость сохраняются");

const reportMetrics = metricsRepo.getMetrics("Daily Report");
assert(reportMetrics.total === 3, "метрики: 3 запуска Daily Report");
assert(reportMetrics.success === 2 && reportMetrics.error === 1, "метрики: success/error учтены");
assert(reportMetrics.tokens === 310, "метрики: токены суммируются (100+10+200)");

const totals = metricsRepo.getTotals();
// QA-P1.1: итоги считаются по истории, а не по таблице metrics (legacy-хвост
// без истории в общие итоги больше не входит).
assert(totals.total === 4, "общие метрики: 3 мигрировавших записи + 1 новый запуск");
assert(totals.success === 2 && totals.error === 2, "общие метрики: success/error по истории");
assert(totals.skipped === 0 && totals.interrupted === 0, "общие метрики: skipped/interrupted изначально нули");
assert(totals.tokens === 360, "токены: 100+10+50+200 по истории");
assert(Math.abs(totals.costUsd - 0.036) < 1e-9, "стоимость: 0.01+0.001+0.005+0.02 по истории");

// Частичный запуск учитывается отдельно и не попадает в error.
historyRepo.recordRun(
  "Partial Task",
  "partial",
  "2026-03-02T09:00:00.000Z",
  500,
  null
);
const partialMetrics = metricsRepo.getMetrics("Partial Task");
assert(
  partialMetrics.total === 1 && partialMetrics.partial === 1 && partialMetrics.error === 0,
  "метрики: partial хранится отдельно от error"
);
const totalsWithPartial = metricsRepo.getTotals();
assert(
  totalsWithPartial.total === 5 && totalsWithPartial.partial === 1 && totalsWithPartial.error === 2,
  "общие метрики: partial увеличивает total, но не error"
);

// --- 4. Crash recovery --------------------------------------------------
// B1.3: строка без владельца считается осиротевшей только после 24 ч,
// поэтому для проверки финализации заводим её просроченной.
const unfinishedId = historyRepo.startRun(
  "Nightly Build",
  new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
);
assert(
  historyRepo.getHistory("Nightly Build", 10).some((r) => r.id === unfinishedId && r.finishedAt === null),
  "startRun создаёт незавершённую запись (finished_at IS NULL)"
);
assert(recoverInterruptedRuns() === 1, "recovery нашёл 1 незавершённую запись");
const recovered = historyRepo.getHistory("Nightly Build", 10).find((r) => r.id === unfinishedId);
assert(recovered.status === "error", "незавершённая запись помечена как error");
assert(
  recovered.error === "Прервано (сбой/перезагрузка)",
  "запись содержит причину «Прервано (сбой/перезагрузка)»"
);
assert(typeof recovered.durationMs === "number" && recovered.durationMs >= 0, "duration_ms рассчитан");
assert(recoverInterruptedRuns() === 0, "повторный recovery ничего не меняет");

// QA-P1.1: прерванная запись из history теперь попадает в общие итоги,
// поэтому get_metrics / get_analytics / self_analysis считают по одной выборке.
const afterRecoveryTotals = metricsRepo.getTotals();
assert(
  afterRecoveryTotals.total === 6 && afterRecoveryTotals.success === 2 &&
    afterRecoveryTotals.partial === 1 && afterRecoveryTotals.error === 2 &&
    afterRecoveryTotals.interrupted === 1,
  "PL-24: crash recovery учтён отдельным счётчиком interrupted, не error"
);
const { buildAnalytics } = await import("./dist/core/analytics.js");
const analyticsTotals = buildAnalytics(await loadHistory(null, 200), { days: 3650 }).totals;
assert(
  afterRecoveryTotals.total === analyticsTotals.total &&
    afterRecoveryTotals.success === analyticsTotals.success &&
    afterRecoveryTotals.partial === analyticsTotals.partial &&
    afterRecoveryTotals.error + afterRecoveryTotals.interrupted === analyticsTotals.error,
  "QA-P1.1: getTotals совпадает с buildAnalytics (error + interrupted = общий bucket)"
);

// PL-37: внутренние probe-задачи (__*) не попадают в агрегаты.
historyRepo.recordRun("__bugprobe_internal", "success", new Date().toISOString(), 10, null);
const totalsWithoutInternal = metricsRepo.getTotals();
const totalsWithInternal = metricsRepo.getTotals(true);
assert(
  totalsWithoutInternal.total === afterRecoveryTotals.total &&
    totalsWithInternal.total === afterRecoveryTotals.total + 1,
  "PL-37: getTotals исключает внутренние задачи, includeInternal=true возвращает их"
);
const analyticsRecords = historyRepo.getHistoryForAnalytics(3650);
assert(
  analyticsRecords.every((record) => !record.taskName.startsWith("__")),
  "PL-37: getHistoryForAnalytics не возвращает внутренние задачи"
);

// PL-24: skipped — отдельныйbucket, не real failure.
historyRepo.recordRun("Skipped Task", "skipped", new Date().toISOString(), 0, null);
const totalsWithSkipped = metricsRepo.getTotals();
assert(
  totalsWithSkipped.skipped === 1 &&
    totalsWithSkipped.error === afterRecoveryTotals.error &&
    totalsWithSkipped.interrupted === afterRecoveryTotals.interrupted &&
    totalsWithSkipped.total === afterRecoveryTotals.total + 1,
  "PL-24: skipped учитывается отдельно и не увеличивает error"
);

// --- 5. QA-F.3: running — отдельное состояние, не ошибка ------------------
const qafId = historyRepo.startRun("QA-F3-Test", new Date().toISOString());
const during = await loadHistory("QA-F3-Test", 10);
const qafRecord = during.find((r) => r.taskName === "QA-F3-Test");
assert(
  Boolean(qafRecord) && qafRecord.status === "running",
  "QA-F.3: незавершённый запуск в loadHistory — status running, не error"
);
assert(
  during.every((r) => r.taskName !== "QA-F3-Test" || r.status !== "error"),
  "QA-F.3: запуск в progress не считается ошибкой"
);
assert(
  during.every((r) => r.taskName !== "QA-F3-Test" || r.finishedAt === ""),
  "QA-F.3: у running-записи finishedAt пустой (не фантомное время)"
);
assert(
  during.every((r) => r.taskName !== "QA-F3-Test" || r.durationMs === 0),
  "QA-F.3: у running-записи durationMs = 0"
);
historyRepo.finishRun(qafId, "success", 1200, null, undefined, 10, 0.0003, "m");
const after = await loadHistory("QA-F3-Test", 10);
assert(
  after.some((r) => r.taskName === "QA-F3-Test" && r.status === "success" && r.durationMs === 1200),
  "QA-F.3: после завершения статус success, durationMs сохранён"
);

// --- 5. Миграция старой схемы metrics без partial ----------------------
// Проверяем, что applySchema() добавляет колонку в уже существующую БД,
// а накопленные счётчики при этом не теряются.
const legacyDbPath = path.join(tempRoot, "legacy-metrics.db");
const { DatabaseSync } = await import("node:sqlite");
const legacyDb = new DatabaseSync(legacyDbPath);
legacyDb.exec(`
  CREATE TABLE metrics (
    task_name TEXT PRIMARY KEY,
    total INTEGER DEFAULT 0,
    success INTEGER DEFAULT 0,
    error INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0
  );
`);
legacyDb
  .prepare("INSERT INTO metrics (task_name, total, success, error, total_tokens, total_cost) VALUES (?, ?, ?, ?, ?, ?)")
  .run("Legacy Task", 5, 3, 2, 0, 0);
legacyDb.close();

initDb(legacyDbPath);
const legacyColumns = getDb()
  .prepare("PRAGMA table_info(metrics)")
  .all()
  .map((column) => String(column.name));
assert(legacyColumns.includes("partial"), "старая БД получает колонку metrics.partial");
const legacyMetrics = metricsRepo.getMetrics("Legacy Task");
assert(
  legacyMetrics.total === 5 &&
    legacyMetrics.success === 3 &&
    legacyMetrics.error === 2 &&
    legacyMetrics.partial === 0,
  "миграция старой БД не теряет накопленные метрики"
);
closeDb();
initDb(dbPath);

// --- 6. Откат миграции при битом JSON ----------------------------------
const badDir = path.join(tempRoot, "bad-plugin");
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, "tasks.json"), "{ это не json");
const badDb = path.join(tempRoot, "bad.db");
initDb(badDb);
let migrationFailed = false;
try {
  await migrateJsonToDb(badDir);
} catch {
  migrationFailed = true;
}
assert(migrationFailed, "битый JSON приводит к ошибке миграции");
assert(tasksRepo.countTasks() === 0, "после ошибки БД осталась пустой (ROLLBACK)");
assert(fs.existsSync(path.join(badDir, "tasks.json")), "после ошибки JSON-файл не переименован");
assert(!fs.existsSync(path.join(badDir, "tasks.json.bak")), "после ошибки .bak не создан");

// Возвращаемся к основной БД для проверки дашборда.
initDb(dbPath);
closeDb();
initDb(dbPath);

// --- 7. Экспорт БД и индикатор в дашборде ------------------------------
const { startDashboardServer, closeDashboardServer, getDashboardPort } = await import(
  "./dist/server.js"
);
const started = await startDashboardServer(
  {
    getTasks: async () => [],
    runTask: async () => ({}),
    deleteTask: async () => {},
  },
  { preferred: 0, fallback: 0 }
);
assert(Boolean(started), "дашборд запущен на свободном порту");
const base = "http://127.0.0.1:" + getDashboardPort();

const page = await (await fetch(base + "/")).text();
assert(page.includes("💾 Скачать БД"), "в дашборде есть кнопка «Скачать БД»");
assert(page.includes("БД: ✅ SQLite (WAL)"), "в футере индикатор SQLite (WAL)");

const health = await (await fetch(base + "/api/health")).json();
assert(health.db && health.db.engine === "sqlite", "/api/health сообщает о SQLite");
assert(health.db.journalMode.toLowerCase() === "wal", "journal_mode = WAL");

const exportRes = await fetch(base + "/api/export-db");
assert(exportRes.status === 200, "GET /api/export-db отвечает 200");
assert(
  (exportRes.headers.get("content-disposition") || "").includes(".db"),
  "ответ содержит Content-Disposition с .db"
);
const dbBytes = Buffer.from(await exportRes.arrayBuffer());
assert(
  dbBytes.subarray(0, 16).toString("utf8") === "SQLite format 3\u0000",
  "скачанный файл — настоящая SQLite БД"
);
assert(dbBytes.byteLength > 0, "размер экспортированной БД больше нуля");

// QA-B.3: выборка для бюджетов по учётному моменту завершения (finished_at),
// а не по started_at — иначе запуски, перешедшие через полуночь, теряются.
historyRepo.recordRun(
  "Budget Probe",
  "success",
  "2026-02-01T23:30:00.000Z",
  3600000,
  null,
  null,
  10,
  0.01,
  "test/model",
  "success",
  "success",
  "2026-02-02T00:30:00.000Z"
);
const budgetRows = historyRepo.getHistoryForBudget("2026-02-02T00:00:00.000Z", 100);
assert(
  budgetRows.some((r) => r.taskName === "Budget Probe"),
  "getHistoryForBudget: запуск, завершённый внутри периода, включён"
);
assert(
  !budgetRows.some((r) => r.taskName === "Daily Report" && r.startedAt === "2026-02-01T09:00:00.000Z"),
  "getHistoryForBudget: старые записи до периода исключены"
);

// QA-G.1: аналитика запрашивает всю историю за окно, а не первые 20000 записей.
const analyticsRows = historyRepo.getHistoryForAnalytics(
  1,
  new Date("2026-02-02T00:00:00.000Z")
);
assert(
  analyticsRows.some((r) => r.taskName === "Budget Probe"),
  "getHistoryForAnalytics: запись внутри окна включена"
);
assert(
  !historyRepo
    .getHistoryForAnalytics(1, new Date("2026-02-10T00:00:00.000Z"))
    .some((r) => r.taskName === "Budget Probe"),
  "getHistoryForAnalytics: запись вне окна исключена"
);

// QA-P1.5: прочерк — маркер «нет ошибки», а не текст ошибки.
assert(
  historyRepo.normalizeErrorText("-") === null &&
    historyRepo.normalizeErrorText("") === null &&
    historyRepo.normalizeErrorText("   ") === null,
  "QA-P1.5: '-' и пустая строка нормализуются в null"
);
assert(
  historyRepo.normalizeErrorText("  Сбой  ") === "Сбой",
  "QA-P1.5: настоящий текст ошибки сохраняется (trim)"
);
historyRepo.recordRun(
  "QA-P15 Probe",
  "success",
  new Date().toISOString(),
  10,
  "-",
  null,
  undefined,
  undefined,
  "test/model"
);
assert(
  historyRepo.getHistory("QA-P15 Probe", 1)[0].error === null,
  "QA-P1.5: успешный запуск не пишет '-' в error при записи"
);
getDb().prepare("UPDATE history SET error = '-' WHERE task_name = ?").run("QA-P15 Probe");
assert(
  (await loadHistory("QA-P15 Probe", 10))[0].error === null,
  "QA-P1.5: легаси-прочерк нормализуется при чтении истории"
);
const p15Analytics = buildAnalytics(
  [
    {
      taskName: "QA-P15 Probe",
      status: "error",
      startedAt: new Date().toISOString(),
      durationMs: 10,
      error: "-",
      tokens: 0,
      costUsd: 0,
    },
  ],
  { days: 3650 }
);
assert(
  p15Analytics.errors.length === 1 && p15Analytics.errors[0].message === "(без текста)",
  "QA-P1.5: '-' не попадает в топ ошибок аналитики"
);

await closeDashboardServer();
closeDb();

// Убираем временную директорию.
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть ошибки — см. FAIL выше." : "\nВсе тесты Спринта 12 прошли."
);
