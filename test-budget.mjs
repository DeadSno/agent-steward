/**
 * Экономика v2, E-1.1/E-1.2/E-1.3 — budgets: учёт расхода за день/неделю,
 * авто-пауза при превышении лимита и текст алерта.
 * Запуск: node test-budget.mjs (после npm run build).
 *
 * Чистые функции: никаких БД, HTTP или ОС — только история и лимиты.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUDGET_GATE_SKIP_EXIT_CODE,
  buildBudgetReport,
  defaultBudgetSettings,
  evaluateBudgetGate,
  evaluateRunBudgetGate,
  evaluateTaskTokenBudgetGate,
  formatBudgetAlertMessage,
  formatBudgetSkipMessage,
  formatTaskTokenBudgetSkipMessage,
  startOfUtcDay,
  startOfUtcWeek,
  tokenEfficiencyScore,
  forecastSpend,
} from "./dist/core/budget.js";
import {
  buildAnalytics,
  recordCost,
  ESTIMATED_COST_PER_1K_TOKENS_USD,
  GRAFANA_METRIC_NAMES,
  buildGrafanaDashboard,
  splitLocalCloud,
} from "./dist/core/analytics.js";
import {
  VERIFICATION_COST_PER_CHECK_USD,
  computeVerificationBudget,
  computeSavings,
  recomputeVerificationBudget,
  recomputeSavingsFromReceipts,
  verificationCheckKey,
} from "./dist/core/savings.js";

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
// B-1.1: источник теперь общий для всех входов — checkRunBudgetGate.
const gateSource = fs.readFileSync("./src/index.ts", "utf8");
const gateBody = gateSource.slice(
  gateSource.indexOf("async function checkRunBudgetGate"),
  gateSource.indexOf("async function runTaskEntry"),
);
check(
  "checkRunBudgetGate: использует getHistoryForBudget, а не getHistory(null, 20000)",
  gateBody.includes("getHistoryForBudget(") &&
    !gateBody.includes("getHistory(null, 20000)") &&
    gateBody.includes("startOfUtcWeek(")
);

// 7c. Сквозная проводка tokenBudget из определений задач в аналитику.
// 5 точек в index.ts: get_analytics/self_analysis (MCP + RPC) и общий
// buildBugReportText для report_bug (MCP и RPC после рефакторинга F-3.8
// используют один helper вместо двух инлайновых вызовов).
const analyticsCallers = [
  ["./src/index.ts", "tokenBudget: definition.tokenBudget", 5],
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

// 11b. SC-1.1: стоимость проверок в ANALYTICS и кэш повторных входов.
const verifyInput = { gate: "qualityGate", prompt: "prompt-A", inputs: { file: "a.ts" } };
const verifySame = { gate: "qualityGate", prompt: "prompt-A", inputs: { file: "a.ts" } };
const verifyDifferent = { gate: "qualityGate", prompt: "prompt-A", inputs: { file: "b.ts" } };
check(
  "SC-1.1: ключ проверки = SHA-256(gate+prompt+inputs), детерминирован",
  verificationCheckKey(verifyInput) === verificationCheckKey(verifySame) &&
    verificationCheckKey(verifyInput) !== verificationCheckKey(verifyDifferent) &&
    /^[0-9a-f]{64}$/.test(verificationCheckKey(verifyInput))
);
const verifyBudget = computeVerificationBudget([verifyInput, verifySame, verifyDifferent]);
check(
  "SC-1.1: одинаковые проверки платятся один раз, разные — отдельно",
  verifyBudget.checks === 3 &&
    verifyBudget.hits === 1 &&
    verifyBudget.misses === 2 &&
    verifyBudget.costUsd === 2 * VERIFICATION_COST_PER_CHECK_USD
);
const analyticsWithVerification = buildAnalytics(
  [day("2026-06-17T01:00:00Z", { costUsd: 1 })],
  { now: analyticsNow, verificationChecks: [verifyInput, verifySame, verifyDifferent] },
);
check(
  "SC-1.1: ANALYTICS отдаёт verificationCostUsd и статистику кэша",
  analyticsWithVerification.savings.verificationCostUsd === verifyBudget.costUsd &&
    analyticsWithVerification.savings.verificationCache.hits === 1 &&
    analyticsWithVerification.savings.verificationCache.unique === 2
);
const indexSource = fs.readFileSync("./src/index.ts", "utf8");
check(
  "SC-1.1: ANALYTICS (MCP + RPC) передаёт проверки в buildAnalytics",
  indexSource.split("verificationChecks,").length - 1 >= 2 &&
    indexSource.includes("function verificationChecksForWindow")
);

// 11c. DEEP-1.1: аудируемые чеки каждой проверки.
const receiptBudget = computeVerificationBudget([verifyInput, verifySame, verifyDifferent], {
  costPerCheckUsd: 0.01,
  maxEntries: 2,
});
check(
  "DEEP-1.1: чек эмитируется для каждой проверки с индексом и стабильным ключом",
  receiptBudget.receipts.length === 3 &&
    receiptBudget.receipts.every((receipt, index) =>
      receipt.index === index && /^[0-9a-f]{64}$/.test(receipt.key)) &&
    receiptBudget.receipts[0].key === verificationCheckKey(verifyInput) &&
    receiptBudget.receipts[1].key === receiptBudget.receipts[0].key
);
check(
  "DEEP-1.1: решение hit/miss и списанная стоимость фиксируются в чеке",
  receiptBudget.receipts[0].decision === "miss" &&
    receiptBudget.receipts[0].costUsd === 0.01 &&
    receiptBudget.receipts[1].decision === "hit" &&
    receiptBudget.receipts[1].costUsd === 0 &&
    receiptBudget.receipts[2].decision === "miss"
);
check(
  "DEEP-1.1: параметры пересчёта сохранены в агрегате",
  receiptBudget.costPerCheckUsd === 0.01 && receiptBudget.maxEntries === 2
);

// 11d. DEEP-1.2: пересчёт агрегатов и net-экономии из чеков (golden-тест).
const deepCheck = (prompt) => ({ gate: "qualityGate", prompt, inputs: { file: "deep.ts" } });
const checkA = deepCheck("A");
const checkASame = deepCheck("A");
const checkB = deepCheck("B");
const checkC = deepCheck("C");
const deepOptions = { verificationCostPerCheckUsd: 0.01, verificationCacheMaxEntries: 2, referenceCostPer1kTokensUsd: 0.01 };
const deepChecks = [checkA, checkASame, checkB, checkC, checkB];
const deepReport = computeSavings(
  [
    day("2026-06-17T01:00:00Z", { taskName: "deep", tokens: 100000, costUsd: 0 }),
    day("2026-06-17T02:00:00Z", { taskName: "deep", tokens: 10000, costUsd: 0.5 }),
  ],
  { ...deepOptions, verificationChecks: deepChecks },
);
const deepCache = deepReport.verificationCache;
check(
  "DEEP-1.2: golden — 5 проверок, 2 hit, 3 miss, 1 evicted, unique=2, cost=0.03",
  deepCache.checks === 5 &&
    deepCache.hits === 2 &&
    deepCache.misses === 3 &&
    deepCache.evicted === 1 &&
    deepCache.unique === 2 &&
    deepCache.costUsd === 0.03
);
check(
  "DEEP-1.2: чек вытеснения содержит ключ вытесненной записи",
  deepCache.receipts[3].decision === "evicted" &&
    deepCache.receipts[3].evictedKey === verificationCheckKey(checkA) &&
    deepCache.receipts[4].decision === "hit"
);
check(
  "DEEP-1.2: savedUsd=1, totalCostUsd=0.5, netEconomyUsd=0.47",
  deepReport.savedUsd === 1 &&
    deepReport.totalCostUsd === 0.5 &&
    deepReport.netEconomyUsd === 0.47
);
const recomputeOptions = { costPerCheckUsd: 0.01, maxEntries: 2 };
assert.deepStrictEqual(
  recomputeVerificationBudget(deepCache.receipts, recomputeOptions),
  deepCache,
);
assert.deepStrictEqual(
  recomputeSavingsFromReceipts(deepCache.receipts, deepReport, recomputeOptions),
  {
    verificationCostUsd: deepReport.verificationCostUsd,
    verificationCache: deepCache,
    netEconomyUsd: deepReport.netEconomyUsd,
  },
);
check("DEEP-1.2: инвариант recompute(receipts) === report.savings выполняется", true);
const tamperedReceipts = deepCache.receipts.map((receipt) => ({ ...receipt }));
tamperedReceipts[1].key = verificationCheckKey(deepCheck("tampered"));
assert.notDeepStrictEqual(
  recomputeVerificationBudget(tamperedReceipts, recomputeOptions),
  deepCache,
);
check("DEEP-1.2: подмена чека ломает инвариант (аудируемость)", true);

// 12. E-2.2: гейт персонального токен-бюджета задачи (остановка при превышении).
const gateNow = new Date("2026-06-17T12:00:00Z"); // среда
const gateRecords = [
  day("2026-06-17T01:00:00Z", { taskName: "limited", tokens: 1200 }),
  day("2026-06-16T10:00:00Z", { taskName: "limited", tokens: 900 }),
  day("2026-06-10T10:00:00Z", { taskName: "limited", tokens: 5000 }), // прошлая неделя
  day("2026-06-17T11:00:00Z", { taskName: "limited", status: "running", tokens: 99999 }), // игнорируется
  day("2026-06-17T02:00:00Z", { taskName: "other", tokens: 99999 }),
  day("2026-06-16T09:00:00Z", { taskName: "weekonly", tokens: 1500 }),
  day("2026-06-17T03:00:00Z", { taskName: "weekonly", tokens: 500 }),
  day("2026-06-17T04:00:00Z", { taskName: "clean", tokens: 500 }),
  day("2026-06-17T05:00:00Z", { taskName: "under", tokens: 900 }),
  day("2026-06-17T05:30:00Z", { taskName: "under", tokens: 900 }),
];
const noBudgetGate = evaluateTaskTokenBudgetGate(gateRecords, "limited", undefined, gateNow);
check("E-2.2: без лимита гейт fail-open (no_budget)", noBudgetGate.allowed && noBudgetGate.reason === "no_budget");
const withinGate = evaluateTaskTokenBudgetGate(gateRecords, "limited", 2000, gateNow);
check("E-2.2: в пределах лимита запуск разрешён (история прошлой недели игнорируется)", withinGate.allowed && withinGate.reason === "within_limit");
const dayGate = evaluateTaskTokenBudgetGate(gateRecords, "limited", 1000, gateNow);
check("E-2.2: дневное превышение блокирует запуск", !dayGate.allowed && dayGate.reason === "day_exceeded" && dayGate.period === "day");
check("E-2.2: статус running не учитывается при поиске максимума", dayGate.maxRunTokens === 1200);
const weekGate = evaluateTaskTokenBudgetGate(gateRecords, "weekonly", 1000, gateNow);
check("E-2.2: недельное превышение (не сегодня) блокирует запуск", !weekGate.allowed && weekGate.reason === "week_exceeded" && weekGate.period === "week");
const cleanGate = evaluateTaskTokenBudgetGate(gateRecords, "clean", 1000, gateNow);
check("E-2.2: чужие расходы не блокируют задачу (изоляция по имени)", cleanGate.allowed);
const underGate = evaluateTaskTokenBudgetGate(gateRecords, "under", 1000, gateNow);
check("E-2.2: сумма двух прогонов ниже лимита не блокирует (сравнение по одному прогону)", underGate.allowed);
check("E-2.2: сообщение о пропуске содержит имя задачи и 'run skipped'", formatTaskTokenBudgetSkipMessage(dayGate).includes("limited") && formatTaskTokenBudgetSkipMessage(dayGate).includes("run skipped"));
check("E-2.2: для разрешённого запуска сообщение пустое", formatTaskTokenBudgetSkipMessage(withinGate) === "");

// E-2.2/B-1.1: все ручные/MCP/RPC-входы идут через общий гейт, тот же самый,
// что использует registered-путь рекордера.
const pluginSource = fs.readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
check("E-2.2: index.ts подключает общий гейт в runTaskEntry и run_task", (pluginSource.match(/checkRunBudgetGate\(/g) ?? []).length >= 3 && pluginSource.includes("evaluateRunBudgetGate") && !pluginSource.includes("checkTaskTokenBudgetGate"));

// --- 13. E-3.1: token efficiency score -------------------------------------
const efficiencyRecords = [
  day("2026-06-17T01:00:00Z", { tokens: 800, model: "gpt-4o" }),
  day("2026-06-17T02:00:00Z", { status: "error", tokens: 200, model: "gpt-4o" }),
  day("2026-06-17T03:00:00Z", { tokens: 1000, model: "qwen3:4b" }),
  day("2026-06-17T04:00:00Z", { status: "aborted", tokens: 500, model: "qwen3:4b" }),
  day("2026-06-17T05:00:00Z", { status: "running", tokens: 99999, model: "gpt-4o" }),
];
const efficiency = tokenEfficiencyScore(efficiencyRecords);
check(
  "E-3.1: итоговая эффективность 72% (2500 токенов, 700 впустую)",
  efficiency.runs === 4 &&
    efficiency.usefulRuns === 2 &&
    efficiency.totalTokens === 2500 &&
    efficiency.wastedTokens === 700 &&
    efficiency.score === 72
);
check(
  "E-3.1: разбивка по моделям и детерминированный порядок ключей",
  Object.keys(efficiency.scoreByModel).join(",") === "gpt-4o,qwen3:4b" &&
    efficiency.scoreByModel["gpt-4o"].score === 80 &&
    efficiency.scoreByModel["qwen3:4b"].score === 66.67
);
check(
  "E-3.1: fail-open на пустой истории",
  JSON.stringify(tokenEfficiencyScore([])) ===
    JSON.stringify({
      score: 0,
      runs: 0,
      usefulRuns: 0,
      totalTokens: 0,
      wastedTokens: 0,
      scoreByModel: {},
    })
);
check(
  "E-3.1: только running/без токенов — нули, без NaN",
  (() => {
    const r = tokenEfficiencyScore([
      day("2026-06-17T01:00:00Z", { status: "running", tokens: 100 }),
      day("2026-06-17T02:00:00Z", { tokens: undefined }),
    ]);
    return r.score === 0 && r.runs === 1 && Number.isFinite(r.score);
  })()
);
check(
  "E-3.1: границы — все success = 100%, все error = 0%",
  tokenEfficiencyScore([day("2026-06-17T01:00:00Z", { tokens: 10 })]).score === 100 &&
    tokenEfficiencyScore([day("2026-06-17T01:00:00Z", { status: "error", tokens: 10 })]).score === 0
);
check(
  "E-3.1: детерминизм",
  JSON.stringify(tokenEfficiencyScore(efficiencyRecords)) ===
    JSON.stringify(tokenEfficiencyScore(efficiencyRecords))
);

// --- 14. E-4.1: forecast spend ---------------------------------------------
const forecastNow = new Date("2026-06-17T12:00:00Z");
const forecastRecords = [
  day("2026-06-17T01:00:00Z", { costUsd: 3 }),
  day("2026-06-16T10:00:00Z", { costUsd: 4 }),
  day("2026-06-10T11:00:00Z", { costUsd: 4 }), // до начала окна (12:00)
  day("2026-06-05T10:00:00Z", { costUsd: 1000 }), // вне окна
  day("2026-06-17T09:00:00Z", { status: "running", costUsd: 999 }),
  day("2026-06-18T00:00:00Z", { costUsd: 50 }), // будущее
];
const forecast = forecastSpend(forecastRecords, 7, forecastNow);
check(
  "E-4.1: окно 7 дней, только завершённые запуски",
  forecast.basedOnRuns === 2 &&
    forecast.dailyRateUsd === 1 &&
    forecast.projectedUsd === 7 &&
    forecast.confidence === "low"
);
check(
  "E-4.1: пустая история — нули и low, без NaN/Infinity",
  (() => {
    const f = forecastSpend([], 7, forecastNow);
    return (
      f.projectedUsd === 0 &&
      f.dailyRateUsd === 0 &&
      f.basedOnRuns === 0 &&
      f.confidence === "low" &&
      [f.projectedUsd, f.dailyRateUsd].every(Number.isFinite)
    );
  })()
);
check(
  "E-4.1: все running — fail-open",
  forecastSpend([day("2026-06-17T01:00:00Z", { status: "running", costUsd: 999 })], 7, forecastNow)
    .projectedUsd === 0
);
check(
  "E-4.1: days=0/NaN не дают деления на ноль",
  forecastSpend(forecastRecords, 0, forecastNow).dailyRateUsd === 1 &&
    forecastSpend(forecastRecords, NaN, forecastNow).dailyRateUsd === 1
);
check(
  "E-4.1: детерминизм при одинаковом now",
  JSON.stringify(forecastSpend(forecastRecords, 7, forecastNow)) ===
    JSON.stringify(forecastSpend(forecastRecords, 7, forecastNow))
);
check(
  "E-4.1: больше данных повышает уверенность",
  forecastSpend(
    Array.from({ length: 14 }, (_, i) =>
      day(`2026-06-${String(10 + (i % 7)).padStart(2, "0")}T13:00:00Z`, { costUsd: 0.5 })
    ),
    7,
    forecastNow
  ).confidence === "high"
);

// --- 15. E-4.2: Grafana dashboard JSON -------------------------------------
const dashboard = buildGrafanaDashboard({ windowDays: 14, generatedAt: "ignored" });
check(
  "E-4.2: три панели с target'ами на метрики расхода/токенов/эффективности",
  dashboard.panels.length === 3 &&
    dashboard.panels[0].targets[0].expr === GRAFANA_METRIC_NAMES.spendUsd &&
    dashboard.panels[1].targets[0].expr === GRAFANA_METRIC_NAMES.tokens &&
    dashboard.panels[2].targets[0].expr === GRAFANA_METRIC_NAMES.efficiency &&
    dashboard.panels.every((p) => p.targets[0].refId === "A")
);
check(
  "E-4.2: детерминизм (generatedAt не влияет на JSON)",
  JSON.stringify(dashboard) ===
    JSON.stringify(buildGrafanaDashboard({ windowDays: 14, generatedAt: "other" })) &&
    JSON.stringify(buildGrafanaDashboard()) === JSON.stringify(buildGrafanaDashboard())
);
check(
  "E-4.2: JSON.stringify round-trip без потерь",
  JSON.stringify(JSON.parse(JSON.stringify(dashboard))) === JSON.stringify(dashboard)
);
check(
  "E-4.2: windowDays задаёт окно, невалидное значение — fail-open на 14",
  dashboard.time.from === "now-14d" &&
    buildGrafanaDashboard({ windowDays: Number.NaN }).time.from === "now-14d" &&
    buildGrafanaDashboard({ title: "Custom" }).title === "Custom"
);

// --- 16. E-5.1: local vs cloud ---------------------------------------------
const splitRecords = [
  day("2026-06-17T01:00:00Z", { tokens: 1000, costUsd: 1, model: "gpt-4o" }),
  day("2026-06-17T02:00:00Z", { status: "error", tokens: 2000, costUsd: 2, model: "qwen3:4b" }),
  day("2026-06-17T03:00:00Z", { tokens: 500, model: "ollama/llama3" }), // оценка 0.0015
  day("2026-06-17T04:00:00Z", { tokens: 100, costUsd: 0.5, model: "" }), // неизвестная модель → cloud
  day("2026-06-17T05:00:00Z", { status: "running", tokens: 9999, costUsd: 99, model: "gpt-4o" }),
];
const split = splitLocalCloud(splitRecords);
check(
  "E-5.1: эвристика по префиксу модели, running игнорируется",
  split.local.runs === 2 &&
    split.local.tokens === 2500 &&
    split.local.spentUsd === 2.0015 &&
    split.cloud.runs === 2 &&
    split.cloud.tokens === 1100 &&
    split.cloud.spentUsd === 1.5
);
check(
  "E-5.1: явное поле записи имеет приоритет над моделью",
  (() => {
    const s = splitLocalCloud([
      day("2026-06-17T01:00:00Z", { tokens: 10, costUsd: 0.1, model: "gpt-4o", executionPlace: "local" }),
    ]);
    return s.local.runs === 1 && s.cloud.runs === 0;
  })()
);
check(
  "E-5.1: пустая история и детерминизм",
  (() => {
    const emptySplit = splitLocalCloud([]);
    return (
      emptySplit.local.runs === 0 &&
      emptySplit.cloud.spentUsd === 0 &&
      JSON.stringify(splitLocalCloud(splitRecords)) === JSON.stringify(splitLocalCloud(splitRecords))
    );
  })()
);

// --- PL-125 / B-1.1 / B-1.2: registered-путь cron/once ---------------------
// Гейт ОС-планировщика обязан проверять те же два лимита, что и ручной вход,
// до старта opencode, и оставлять видимый пропуск (skipped + причина).
const registeredNow = new Date("2026-06-17T12:00:00Z");
const spentToday = day("2026-06-17T09:00:00Z", {
  taskName: "cron-task",
  costUsd: 2,
  tokens: 300,
});
const tokenOver = day("2026-06-17T10:00:00Z", {
  taskName: "limited-task",
  tokens: 1200,
});

const overDay = evaluateRunBudgetGate(
  [spentToday],
  { enabled: true, dailyUsd: 1, weeklyUsd: 0 },
  "cron-task",
  undefined,
  registeredNow,
);
check(
  "B-1.1(a): дневной USD-лимит блокирует общий гейт с причиной",
  !overDay.allowed && overDay.reason === "day_exceeded" && overDay.message.includes("run skipped"),
);
const overWeek = evaluateRunBudgetGate(
  [spentToday],
  { enabled: true, dailyUsd: 0, weeklyUsd: 1 },
  "cron-task",
  undefined,
  registeredNow,
);
check(
  "B-1.1(a): недельный USD-лимит блокирует общий гейт",
  !overWeek.allowed && overWeek.reason === "week_exceeded" && overWeek.message.includes("weekly spend"),
);
const overTaskGate = evaluateRunBudgetGate(
  [tokenOver],
  { enabled: false, dailyUsd: 0, weeklyUsd: 0 },
  "limited-task",
  1000,
  registeredNow,
);
check(
  "B-1.1(b): tokenBudget задачи блокирует даже при выключенном USD-бюджете",
  !overTaskGate.allowed &&
    overTaskGate.reason === "task_day_exceeded" &&
    overTaskGate.message.includes("limited-task"),
);
const disabledGate = evaluateRunBudgetGate(
  [spentToday, tokenOver],
  { enabled: false, dailyUsd: 5, weeklyUsd: 5 },
  "limited-task",
  undefined,
  registeredNow,
);
check(
  "B-1.1(c): fail-open, когда бюджет отключён и лимит токенов не задан",
  disabledGate.allowed && disabledGate.message === "",
);
const zeroGate = evaluateRunBudgetGate(
  [spentToday, tokenOver],
  { enabled: true, dailyUsd: 0, weeklyUsd: 0 },
  "limited-task",
  0,
  registeredNow,
);
check("B-1.1(c): fail-open при нулевых лимитах USD и токенов", zeroGate.allowed);
check("B-1.1: exit-код пропуска зафиксирован в контракте", BUDGET_GATE_SKIP_EXIT_CODE === 3);

check(
  "B-1.1(d): ручные/MCP/RPC-входы идут через тот же общий гейт",
  pluginSource.includes("const budgetGate = await checkRunBudgetGate(name, definition?.tokenBudget)") &&
    pluginSource.includes("const budgetGate = await checkRunBudgetGate(trimmed, definition?.tokenBudget)") &&
    pluginSource.includes("async function checkBudgetGate") &&
    pluginSource.includes("formatBudgetSkipMessage"),
);

// Реальная .cmd-обёртка и реальный recorder в изолированном окружении.
const gateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "budget-gate-test-"));
process.env.APPDATA = gateRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(gateRoot, "opencode", "windows-scheduler");
const pluginDir = path.join(gateRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });
const recorder = path.resolve("dist/core/record-history.js");
const logFile = path.join(pluginDir, "gate.log");
const settingsFile = path.join(pluginDir, "settings.json");
const writeGateSettings = (budgets) =>
  fs.writeFileSync(settingsFile, JSON.stringify({ budgets }), "utf8");
const runGate = (task) =>
  spawnSync(process.execPath, [recorder, "--budget-gate", task, logFile], {
    encoding: "utf8",
    env: { ...process.env },
    timeout: 30000,
  });

const { writeWrapperCmd } = await import("./dist/core/ps-wrapper.js");
const cmdPath = await writeWrapperCmd(
  "cron-task",
  "cron-task",
  path.join(gateRoot, "prompt.txt"),
  60,
  path.join(gateRoot, "cron-task.lock"),
  gateRoot,
  logFile,
  recorder,
);
const cmd = fs.readFileSync(cmdPath, "utf8");
const gateAt = cmd.indexOf("--budget-gate");
check(
  "B-1.1(a): .cmd проверяет бюджет ДО powershell/opencode run",
  gateAt !== -1 &&
    cmd.indexOf("run-task.ps1") > gateAt &&
    cmd.includes('if "%errorlevel%"=="3" exit /b 0'),
);
check(
  "B-1.1(a): гейт вызывается тем же recorder'ом, что пишет историю",
  cmd.includes(`node "${recorder}" --budget-gate "cron-task"`),
);

const { initDb, closeDb } = await import("./dist/db/index.js");
const { getHistory, recordRun } = await import("./dist/db/history-repo.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
initDb();
saveTask({ name: "cron-task", schedule: "* * * * *", prompt: "cron" });
saveTask({ name: "limited-task", schedule: "* * * * *", prompt: "limited", tokenBudget: 1000 });

// Fail-open: выключенный бюджет не должен ни блокировать, ни писать skip.
writeGateSettings({ enabled: false, dailyUsd: 0, weeklyUsd: 0 });
let gateResult = runGate("cron-task");
check(
  "B-1.1(c): recorder не блокирует при выключенном бюджете",
  gateResult.status === 0,
  `status=${gateResult.status} ${gateResult.stderr}`,
);
check(
  "B-1.1(c): fail-open не оставляет записей skipped",
  !getHistory("cron-task", 50).some((r) => r.status === "skipped"),
);

// (a) исчерпанный дневной бюджет на cron-пути.
writeGateSettings({ enabled: true, dailyUsd: 1, weeklyUsd: 0 });
recordRun("cron-task", "success", new Date().toISOString(), 1000, null, null, 100, 2);
gateResult = runGate("cron-task");
check(
  "B-1.1(a): recorder возвращает код 3 при исчерпанном дневном бюджете",
  gateResult.status === BUDGET_GATE_SKIP_EXIT_CODE,
  `status=${gateResult.status} ${gateResult.stderr}`,
);
const skippedUsd = getHistory("cron-task", 50).find((r) => r.status === "skipped");
check(
  "B-1.1(a): пропуск виден в истории со статусом skipped и причиной",
  Boolean(skippedUsd) && /Budget limit exceeded/.test(skippedUsd?.error ?? ""),
  JSON.stringify(skippedUsd?.error),
);
check(
  "B-1.1(a): причина пропуска записана в лог задачи",
  fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("budget gate skipped"),
);

// (b) персональный tokenBudget задачи на cron-пути.
writeGateSettings({ enabled: false, dailyUsd: 0, weeklyUsd: 0 });
recordRun("limited-task", "success", new Date().toISOString(), 1000, null, null, 1200, 0);
gateResult = runGate("limited-task");
check(
  "B-1.1(b): recorder возвращает код 3 при превышении tokenBudget задачи",
  gateResult.status === BUDGET_GATE_SKIP_EXIT_CODE,
  `status=${gateResult.status} ${gateResult.stderr}`,
);
const skippedTokens = getHistory("limited-task", 50).find((r) => r.status === "skipped");
check(
  "B-1.1(b): причина токен-бюджета сохранена в истории",
  Boolean(skippedTokens) && /Task token budget exceeded/.test(skippedTokens?.error ?? ""),
  JSON.stringify(skippedTokens?.error),
);
closeDb();
fs.rmSync(gateRoot, { recursive: true, force: true });

console.log(`\nBudget: ${passed}/${passed + failed} проверок прошли.`);
assert.equal(failed, 0, `${failed} проверок не прошли`);
process.exit(failed > 0 ? 1 : 0);
