// Ручной тест веб-дашборда (Спринт 5): запускает сервер со стабами и проверяет эндпоинты.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

// QA-P0.3: тест НЕ должен писать аудит (actor="http") в рабочую БД профиля.
// Запоминаем состояние live-аудита до подмены HOME.
const liveRoot = process.env.APPDATA ?? "";
const liveDbCandidates = [
  path.join(liveRoot, "opencode", "agent-steward", "scheduler.db"),
  path.join(liveRoot, "opencode", "windows-scheduler", "scheduler.db"),
];
const AUDIT_TARGETS = ["test-task", "running-task", "задача-тест", "boom"];
function countLiveAuditHits() {
  let total = 0;
  for (const file of liveDbCandidates) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const placeholders = AUDIT_TARGETS.map(() => "?").join(", ");
      const rows = db
        .prepare(`SELECT target FROM audit_log WHERE target IN (${placeholders})`)
        .all(...AUDIT_TARGETS);
      total += rows.length;
    } catch {
      // Таблица аудита может ещё не существовать — считаем 0 попаданий.
    } finally {
      db.close();
    }
  }
  return total;
}
const liveAuditBefore = countLiveAuditHits();

// Изолируем HOME ДО динамических импортов: иначе server.ts/db инициализируются
// с путём live-профиля и записывают тестовые действия в рабочую БД.
const { root: tempRoot } = createTestHomeSync("ws-scheduler-dashboard-");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { startDashboardServer, closeDashboardServer, isDashboardRunning, getDashboardPort } =
  await import("./dist/server.js");
const {
  startDashboardServer: start2,
  dashboardPortCandidates,
  discoverDashboardPort,
  probeDashboardOn,
} = await import("./dist/server.js");
const { getSchedulerTitle } = await import("./dist/core/scheduler/index.js");
const { closeDb } = await import("./dist/db/index.js");

const deps = {
  getTasks: async () => [
    { name: "test-task", schedule: "* * * * *", status: "success", nextRun: "12.11.2026 10:00", triggerType: "cron", watchPath: null },
    { name: "test-task-2", schedule: "0 9 * * *", status: "error", nextRun: null, triggerType: "cron", watchPath: null },
  ],
  runTask: async (name) => {
    if (name === "boom") throw new Error("schtasks error: имитация сбоя запуска");
    return { alreadyRunning: name === "running-task" };
  },
  deleteTask: async (name) => {
    if (name === "boom") throw new Error("schtasks error: имитация сбоя удаления");
  },
};

const assert = (cond, msg) => {
  if (!cond) { console.error("FAIL: " + msg); process.exitCode = 1; }
  else console.log("OK: " + msg);
};

const root = path.dirname(fileURLToPath(import.meta.url));
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
assert(
  indexSrc.includes("discoverDashboardPort") &&
    indexSrc.includes("probeDashboardOn(port)") &&
    indexSrc.includes("reachable:"),
  "QA-P3.5: get_dashboard_info зондирует порт и сообщает reachable",
);

const started = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(started && started.port === 4310, "сервер стартовал на порту 4310 (тестовые порты)");
assert(isDashboardRunning(), "isDashboardRunning() = true");

// Двойной запуск: должен вернуть тот же порт, второй сервер не создаётся.
const again = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(again && again.port === 4310, "повторный startDashboardServer() вернул тот же порт (защита от дубля)");

// Запуск с другими зависимостями на занятый нами порт: переиспользование по маркер-заголовку.
const reuse = await startDashboardServer(
  { ...deps, getTasks: async () => [{ name: "other", schedule: "", status: "unknown", nextRun: null }] },
  { preferred: 4310, fallback: 4311 }
);
assert(reuse && reuse.port === 4310, "запуск на порт с уже слушающим нашим дашбордом -> переиспользование");

// QA-P3.5: после переиспользования и при зондировании отчётный порт должен
// совпадать с реально слушающим, а не быть null/«бумажным» из профиля.
assert(getDashboardPort() === 4310, "QA-P3.5: после переиспользования getDashboardPort() = 4310");
assert(dashboardPortCandidates().includes(4310), "QA-P3.5: dashboardPortCandidates содержит порт 4310");
assert((await probeDashboardOn(4310)).dashboard === true, "QA-P3.5: probeDashboardOn(4310) видит наш дашборд");
assert((await discoverDashboardPort()) === 4310, "QA-P3.5: discoverDashboardPort() нашёл порт 4310");
const serverSrc = fs.readFileSync(path.join(root, "src", "server.ts"), "utf8");
assert(
  serverSrc.includes("running?.port ?? observedPort ?? null") &&
    serverSrc.includes("rememberDashboardPort(port);") &&
    serverSrc.includes("export async function discoverDashboardPort"),
  "QA-P3.5: сервер запоминает найденный порт и умеет его обнаруживать",
);

const base = "http://127.0.0.1:" + getDashboardPort();

// GET / — HTML. Заголовок платформозависимый (Windows / launchd / cron),
// поэтому сверяем его с фактическим значением для текущей ОС, а не с константой.
const html = await fetch(base + "/").then(r => r.text());
assert(html.includes("<!DOCTYPE html>") && html.includes(getSchedulerTitle()), "GET / отдаёт HTML-страницу");
assert(html.includes("/api/tasks"), "страница использует fetch к /api/tasks");

// GET /api/tasks — задачи + метрики из history.json.
const tasksRes = await fetch(base + "/api/tasks").then(r => r.json());
assert(Array.isArray(tasksRes.tasks) && tasksRes.tasks.length === 2, "GET /api/tasks вернул 2 задачи");
assert(tasksRes.tasks[0].metrics && typeof tasksRes.tasks[0].metrics.total === "number", "метрики по задаче присутствуют");

// GET /api/history.
const hist = await fetch(base + "/api/history").then(r => r.json());
assert(Array.isArray(hist.records), "GET /api/history вернул массив записей");

// GET /api/metrics.
const metrics = await fetch(base + "/api/metrics").then(r => r.json());
assert("total" in metrics && "success" in metrics && "error" in metrics, "GET /api/metrics вернул total/success/error");

// GET /api/models-analysis — What-If теперь берёт модели и цены из OpenCode,
// поэтому проверяем форму ответа и допустимый источник, а не конкретный список.
const analysis = await fetch(base + "/api/models-analysis").then(r => r.json());
assert(
  Array.isArray(analysis.whatIf) && analysis.whatIf.length > 0,
  "GET /api/models-analysis вернул непустой whatIf",
);
assert(
  ["env", "history", "opencode", "default"].includes(analysis.whatIfSource),
  "whatIfSource — одно из env/history/opencode/default (факт: " + analysis.whatIfSource + ")",
);
assert(
  analysis.whatIf.every(
    (w) =>
      typeof w.model === "string" &&
      typeof w.pricePerMillion === "number" &&
      typeof w.cost === "number",
  ),
  "каждый whatIf содержит model/pricePerMillion/cost числами",
);

// POST /api/run/:name.
const run = await fetch(base + "/api/run/" + encodeURIComponent("test-task"), { method: "POST" }).then(r => r.json());
assert(run.success === true, "POST /api/run успешен");
const runBusy = await fetch(base + "/api/run/" + encodeURIComponent("running-task"), { method: "POST" }).then(r => r.json());
assert(runBusy.success === true && runBusy.message.includes("уже выполняется"), "POST /api/run: alreadyRunning -> мягкое сообщение");
const runErr = await fetch(base + "/api/run/" + encodeURIComponent("boom"), { method: "POST" }).then(r => r.json());
assert(runErr.success === false && runErr.error.includes("сбоя"), "POST /api/run: ошибка задачи -> success:false + error");

// POST /api/delete/:name.
const del = await fetch(base + "/api/delete/" + encodeURIComponent("test-task"), { method: "POST" }).then(r => r.json());
assert(del.success === true, "POST /api/delete успешен");
const delErr = await fetch(base + "/api/delete/" + encodeURIComponent("boom"), { method: "POST" }).then(r => r.json());
assert(delErr.success === false, "POST /api/delete: ошибка -> success:false");

// 404 на неизвестный маршрут.
const nf = await fetch(base + "/api/nope");
assert(nf.status === 404, "неизвестный маршрут -> 404");

// Кириллица в имени задачи.
const cyr = await fetch(base + "/api/run/" + encodeURIComponent("задача-тест"), { method: "POST" }).then(r => r.json());
assert(cyr.success === true, "POST /api/run с кириллицей в имени работает");

// Закрытие сервера.
const closed = await closeDashboardServer();
assert(closed === true, "closeDashboardServer() закрыл сервер");
assert(isDashboardRunning() === false && getDashboardPort() === null, "после закрытия состояние сброшено");
const closedAgain = await closeDashboardServer();
assert(closedAgain === false, "повторное closeDashboardServer() -> false (нет активного сервера)");

// Перезапуск после закрытия работает.
const restarted = await startDashboardServer(deps, { preferred: 4310, fallback: 4311 });
assert(restarted && restarted.port === 4310, "перезапуск после закрытия работает");
await closeDashboardServer();

// QA-P0.3: тестовые HTTP-вызовы не должны оставить след в live-аудит-логе.
closeDb();
const liveAuditAfter = countLiveAuditHits();
assert(
  liveAuditAfter === liveAuditBefore,
  `тест не записал аудит в live-БД (было ${liveAuditBefore}, стало ${liveAuditAfter})`,
);
removeTestHomeSync(tempRoot);

console.log(process.exitCode ? "\nЕсть падения теста." : "\nВсе проверки пройдены.");
