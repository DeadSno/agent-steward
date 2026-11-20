/**
 * Экономика v2, E-1.1/E-1.2/E-1.3 — budgets: учёт расхода за день/неделю,
 * авто-пауза при превышении лимита и текст алерта.
 * Запуск: node test-budget.mjs (после npm run build).
 *
 * Чистые функции: никаких БД, HTTP или ОС — только история и лимиты.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildBudgetReport,
  defaultBudgetSettings,
  evaluateBudgetGate,
  formatBudgetAlertMessage,
  formatBudgetSkipMessage,
  startOfUtcDay,
  startOfUtcWeek,
} from "./dist/core/budget.js";
import { buildAnalytics, recordCost, ESTIMATED_COST_PER_1K_TOKENS_USD } from "./dist/core/analytics.js";

let passed = 0;
let failed = 0;
function check(name, cond, details = "") {
  if (cond) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` - ${details}` : ""}`);
  }
}

const now = new Date("2026-06-17T12:00:00Z"); // среда
const day = (iso, extra = {}) => ({
  taskName: "t",
  status: "success",
  startedAt: iso,
  ...extra,
});

const records = [
  day("2026-06-17T01:00:00Z", { costUsd: 1 }),
  day("2026-06-17T11:00:00Z", { tokens: 100_000 }), // 0.3 по 0.003/1k
  day("2026-06-16T10:00:00Z", { costUsd: 0.5 }), // только неделя
  day("2026-06-14T10:00:00Z", { costUsd: 5 }), // прошлая неделя
  day("2026-06-17T09:00:00Z", { status: "running", costUsd: 100 }),
  day("2026-06-15T00:00:00Z", { costUsd: 0.2 }), // граница недели (понедельник)
  day("2026-06-18T00:00:00Z", { costUsd: 42 }), // будущее
];

// 1. Границы периодов UTC.
check(
  "startOfUtcDay: обрезает время до полуночи UTC",
  startOfUtcDay(now).toISOString() === "2026-06-17T00:00:00.000Z"
);
check(
  "startOfUtcWeek: неделя с понедельника",
  startOfUtcWeek(now).toISOString() === "2026-06-15T00:00:00.000Z"
);
check(
  "startOfUtcWeek: воскресенье относится к текущей неделе",
  startOfUtcWeek(new Date("2026-06-21T23:00:00Z")).toISOString() ===
    "2026-06-15T00:00:00.000Z"
);
check(
  "startOfUtcWeek: понедельник — сам себе начало",
  startOfUtcWeek(new Date("2026-06-15T00:00:00Z")).toISOString() ===
    "2026-06-15T00:00:00.000Z"
);

// 2. Источник цены — тот же, что и в аналитике.
check(
  "recordCost: явная стоимость имеет приоритет",
  recordCost(day("2026-06-17T01:00:00Z", { costUsd: 1, tokens: 1_000_000 })) === 1
);
check(
  "recordCost: оценка по токенам 0.003 USD/1k",
  Math.abs(
    recordCost(day("2026-06-17T01:00:00Z", { tokens: 1000 })) -
      ESTIMATED_COST_PER_1K_TOKENS_USD
  ) < 1e-9
);

// 3. Fail-open по умолчанию: лимиты выключены, но расход виден.
const defaults = defaultBudgetSettings();
check(
  "defaultBudgetSettings: выключено и без лимитов",
  defaults.enabled === false && defaults.dailyUsd === 0 && defaults.weeklyUsd === 0
);
const off = buildBudgetReport(records, defaults, now);
check(
  "buildBudgetReport: дефолт fail-open (disabled, не exceeded)",
  off.enabled === false &&
    off.day.disabled === true &&
    off.week.disabled === true &&
    off.exceeded === false &&
    off.day.ratio === 0 &&
    off.week.ratio === 0
);
check(
  "buildBudgetReport: учёт работает даже при выключенных лимитах",
  off.day.spentUsd === 1.3 && off.week.spentUsd === 2
);
check(
  "buildBudgetReport: running и будущие записи не попадают в учёт",
  off.day.runs === 2 && off.week.runs === 4
);

// 4. Включённые лимиты: день превышен, неделя — нет.
const on = buildBudgetReport(
  records,
  { enabled: true, dailyUsd: 1, weeklyUsd: 3 },
  now
);
check(
  "buildBudgetReport: дневной лимит превышен",
  on.day.exceeded === true &&
    on.day.spentUsd === 1.3 &&
    on.day.remainingUsd === 0 &&
    Math.abs(on.day.ratio - 1.3) < 1e-9
);
check(
  "buildBudgetReport: недельный лимит в пределах",
  on.week.exceeded === false &&
    on.week.spentUsd === 2 &&
    on.week.remainingUsd === 1 &&
    Math.abs(on.week.ratio - 2 / 3) < 1e-6
);
check("buildBudgetReport: общий флаг exceeded", on.exceeded === true);
check(
  "buildBudgetReport: границы периодов в отчёте",
  on.day.periodStart === "2026-06-17T00:00:00.000Z" &&
    on.week.periodStart === "2026-06-15T00:00:00.000Z" &&
    on.generatedAt === now.toISOString()
);

// 5. Ноль/отрицание/NaN лимита = fail-open для этого периода.
const partial = buildBudgetReport(
  records,
  { enabled: true, dailyUsd: 0, weeklyUsd: -5 },
  now
);
check(
  "buildBudgetReport: нулевой и отрицательный лимит отключают проверку",
  partial.day.disabled === true &&
    partial.week.disabled === true &&
    partial.exceeded === false &&
    partial.day.limitUsd === 0 &&
    partial.week.limitUsd === 0
);

// 6. Пустая история и битые даты.
const empty = buildBudgetReport([], { enabled: true, dailyUsd: 1, weeklyUsd: 1 }, now);
check(
  "buildBudgetReport: пустая история — нулевой расход и не exceeded",
  empty.day.spentUsd === 0 &&
    empty.week.spentUsd === 0 &&
    empty.day.runs === 0 &&
    empty.exceeded === false
);
const broken = buildBudgetReport(
  [day("not-a-date", { costUsd: 999 })],
  { enabled: true, dailyUsd: 1, weeklyUsd: 1 },
  now
);
check(
  "buildBudgetReport: невалидная дата игнорируется",
  broken.day.spentUsd === 0 && broken.week.spentUsd === 0
);

// 7. Ровное достижение лимита считается превышением.
const exact = buildBudgetReport(
  [day("2026-06-17T05:00:00Z", { costUsd: 1.3 })],
  { enabled: true, dailyUsd: 1.3, weeklyUsd: 10 },
  now
);
check(
  "buildBudgetReport: расход == лимит уже exceeded",
  exact.day.exceeded === true && exact.day.remainingUsd === 0
);

// 7a. Граничная атрибуция: расход относится ко времени завершения.
const crossing = buildBudgetReport(
  [
    day("2026-06-16T23:30:00Z", {
      finishedAt: "2026-06-17T00:30:00Z",
      costUsd: 0.7,
    }),
    day("2026-06-14T23:30:00Z", {
      finishedAt: "2026-06-14T23:59:00Z",
      costUsd: 5,
    }),
    day("2026-06-16T23:30:00Z", {
      finishedAt: "2026-06-18T00:30:00Z",
      costUsd: 42,
    }),
  ],
  { enabled: true, dailyUsd: 1, weeklyUsd: 10 },
  now
);
check(
  "buildBudgetReport: запуск, завершённый внутри дня, учтён в этом дне",
  crossing.day.spentUsd === 0.7 && crossing.day.runs === 1
);
check(
  "buildBudgetReport: завершение до начала периода не попадает в день",
  crossing.week.spentUsd === 0.7 && crossing.week.runs === 1
);
check(
  "buildBudgetReport: завершение в будущем не попадает в учёт",
  crossing.exceeded === false
);

// 7b. Гейт запуска не должен зависеть от окна в 20000 записей.
const gateSource = fs.readFileSync("./src/index.ts", "utf8");
const gateBody = gateSource.slice(
  gateSource.indexOf("async function checkBudgetGate"),
  gateSource.indexOf("async function runTaskEntry"),
);
check(
  "checkBudgetGate: использует getHistoryForBudget, а не getHistory(null, 20000)",
  gateBody.includes("getHistoryForBudget(") &&
    !gateBody.includes("getHistory(null, 20000)") &&
    gateBody.includes("startOfUtcWeek(")
);

// 7c. Сквозная проводка tokenBudget из определений задач в аналитику.
// 6 точек в index.ts: get_analytics/self_analysis (MCP + RPC) и report_bug (MCP + RPC).
const analyticsCallers = [
  ["./src/index.ts", "tokenBudget: definition.tokenBudget", 6],
  ["./src/server.ts", "tokenBudget: task.tokenBudget", 1],
];
for (const [file, needle, expected] of analyticsCallers) {
  const source = fs.readFileSync(file, "utf8");
  const actual = source.split(needle).length - 1;
  check(`${file}: tokenBudget передан в buildAnalytics (${expected} точек)`, actual === expected, `найдено ${actual}`);
}

// 7d. Аналитика/self_analysis не должны обрезаться окном в 20000 записей.
check(
  "аналитика: все 5 источников используют getHistoryForAnalytics, а не getHistory(null, 20000)",
  !["src/index.ts", "src/server.ts"].some((file) =>
    fs.readFileSync(file, "utf8").includes("getHistory(null, 20000)")
  ) &&
    fs.readFileSync("./src/index.ts", "utf8").split("getHistoryForAnalytics(windowDays)").length - 1 === 4 &&
    fs.readFileSync("./src/server.ts", "utf8").includes("getHistoryForAnalytics(days)")
);
const analyticsRepoSource = fs.readFileSync("./src/db/history-repo.ts", "utf8");
check(
  "getHistoryForAnalytics: окно days+1 и лимит 100000",
  analyticsRepoSource.includes("(safeDays + 1) * 24 * 60 * 60 * 1000") &&
    analyticsRepoSource.includes("getHistorySince(since.toISOString(), 100000)")
);

// 8. Дефолтная фабрика возвращает независимые объекты.
const copyA = defaultBudgetSettings();
copyA.dailyUsd = 7;
check(
  "defaultBudgetSettings: независимая копия",
  defaultBudgetSettings().dailyUsd === 0
);

// 9. E-1.2: гейт авто-паузы.
const gateOff = evaluateBudgetGate(records, defaults, now);
check(
  "evaluateBudgetGate: fail-open при выключенной группе",
  gateOff.allowed === true &&
    gateOff.reason === "disabled" &&
    formatBudgetSkipMessage(gateOff) === ""
);
const gateWithin = evaluateBudgetGate(
  records,
  { enabled: true, dailyUsd: 10, weeklyUsd: 50 },
  now
);
check(
  "evaluateBudgetGate: запуск разрешён, если лимит не достигнут",
  gateWithin.allowed === true &&
    gateWithin.reason === "within_limit" &&
    gateWithin.report.exceeded === false
);
const gateDay = evaluateBudgetGate(
  records,
  { enabled: true, dailyUsd: 1, weeklyUsd: 3 },
  now
);
check(
  "evaluateBudgetGate: дневной лимит блокирует запуск",
  gateDay.allowed === false &&
    gateDay.reason === "day_exceeded" &&
    gateDay.period === "day"
);
check(
  "formatBudgetSkipMessage: сообщение содержит период и суммы",
  formatBudgetSkipMessage(gateDay).includes("daily") &&
    formatBudgetSkipMessage(gateDay).includes("$1.30")
);
const gateWeek = evaluateBudgetGate(
  records,
  { enabled: true, dailyUsd: 10, weeklyUsd: 1.5 },
  now
);
check(
  "evaluateBudgetGate: недельный лимит блокирует запуск",
  gateWeek.allowed === false &&
    gateWeek.reason === "week_exceeded" &&
    gateWeek.period === "week" &&
    formatBudgetSkipMessage(gateWeek).includes("weekly")
);
const gateBothOff = evaluateBudgetGate(
  records,
  { enabled: true, dailyUsd: 0, weeklyUsd: 0 },
  now
);
check(
  "evaluateBudgetGate: нулевые лимиты не блокируют",
  gateBothOff.allowed === true && gateBothOff.reason === "disabled"
);

// 10. E-1.3: текст алерта о превышении бюджета.
check(
  "formatBudgetAlertMessage: пусто для разрешённого запуска",
  formatBudgetAlertMessage(gateWithin) === ""
);
const alertDay = formatBudgetAlertMessage(gateDay);
const alertWeek = formatBudgetAlertMessage(gateWeek);
check(
  "formatBudgetAlertMessage: дневной алерт содержит суммы и остановку запусков",
  alertDay.includes("Daily spend $1.30 of $1.00") &&
    alertDay.includes("new runs are paused")
);
check(
  "formatBudgetAlertMessage: недельный алерт помечает период",
  alertWeek.includes("Weekly spend") && alertWeek.includes("$1.50")
);

// 11. E-2.1: per-task token budget reflected in analytics.
const analyticsNow = new Date("2026-06-17T12:00:00Z");
const analytics = buildAnalytics(
  [
    day("2026-06-17T01:00:00Z", { taskName: "over", tokens: 1200 }),
    day("2026-06-17T02:00:00Z", { taskName: "over", tokens: 300 }),
    day("2026-06-17T03:00:00Z", { taskName: "under", tokens: 900 }),
    day("2026-06-17T03:30:00Z", { taskName: "under", tokens: 900 }),
    day("2026-06-17T04:00:00Z", { taskName: "no-budget", tokens: 5000 }),
  ],
  {
    now: analyticsNow,
    tasks: [
      { name: "over", tokenBudget: 1000 },
      { name: "under", tokenBudget: 1000 },
    ],
  }
);
const overRow = analytics.tasks.find((row) => row.taskName === "over");
const underRow = analytics.tasks.find((row) => row.taskName === "under");
const noBudgetRow = analytics.tasks.find((row) => row.taskName === "no-budget");
check("analytics: tokenBudgetExceeded выставляется при превышении лимита запуска", overRow?.tokenBudgetExceeded === true && overRow?.tokenBudget === 1000);
check("analytics: tokenBudgetExceeded=false, если лимит не превышен (даже при сумме > лимита)", underRow?.tokenBudgetExceeded === false);
check("analytics: без лимита tokenBudgetExceeded=false", noBudgetRow?.tokenBudgetExceeded === false);

console.log(`\nBudget: ${passed}/${passed + failed} проверок прошли.`);
assert.equal(failed, 0, `${failed} проверок не прошли`);
process.exit(failed > 0 ? 1 : 0);
