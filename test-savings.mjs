/**
 * Тесты 31.6: счётчик «сэкономлено $» на фиксированных данных.
 * Запуск: node test-savings.mjs (после npm run build).
 * Чистые функции — БД, сервер и модель не нужны.
 */
import {
  CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD,
  SAVINGS_METHODOLOGY_URL,
  computeSavings,
} from "./dist/core/savings.js";
import {
  buildAnalytics,
  GRAFANA_METRIC_NAMES,
  buildGrafanaDashboard,
  splitLocalCloud,
} from "./dist/core/analytics.js";
import { tokenEfficiencyScore, forecastSpend } from "./dist/core/budget.js";

const results = [];
let passed = 0;
let failed = 0;
function check(name, cond) {
  const ok = !!cond;
  results.push({ name, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

// --- 1. Пустая история -------------------------------------------------------
const empty = computeSavings([]);
check("empty: нулевая экономия", empty.savedUsd === 0 && empty.runs === 0 && empty.tokens === 0);
check("empty: помечена как оценка", empty.kind === "estimate");
check(
  "empty: есть ссылка на методику",
  empty.methodologyUrl === SAVINGS_METHODOLOGY_URL &&
    empty.methodologyUrl.includes("docs/SAVINGS.md")
);
check(
  "empty: эталонная цена по умолчанию",
  empty.referenceCostPer1kTokensUsd === CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD
);

// --- 2. Контрфактика на фиксированных данных --------------------------------
const now = new Date("2026-11-16T12:00:00.000Z");
const at = (iso) => iso;
const records = [
  // Локальные запуски: токены есть, стоимость не записана.
  { taskName: "build", status: "success", startedAt: at("2026-11-16T10:00:00.000Z"), tokens: 1000, costUsd: 0, model: "qwen3:4b" },
  { taskName: "build", status: "error", startedAt: at("2026-11-16T09:00:00.000Z"), tokens: 2000, model: "qwen3:4b" },
  { taskName: "deploy", status: "success", startedAt: at("2026-11-15T09:00:00.000Z"), tokens: 500, costUsd: null },
  // Облачный запуск: стоимость записана — экономии нет.
  { taskName: "review", status: "success", startedAt: at("2026-11-15T08:00:00.000Z"), tokens: 100000, costUsd: 2, model: "gpt-4o" },
  // Нулевые токены и незавершённый запуск не оцениваются.
  { taskName: "noop", status: "success", startedAt: at("2026-11-14T08:00:00.000Z"), tokens: 0, costUsd: 0 },
  { taskName: "running", status: "running", startedAt: at("2026-11-16T11:00:00.000Z"), tokens: 9000, costUsd: 0 },
];

const savings = computeSavings(records);
// 3500 токенов / 1000 * 0.01 = 0.035
check(
  "fixed: экономия 3500 токенов = $0.035",
  savings.runs === 3 && savings.tokens === 3500 && savings.savedUsd === 0.035
);
check(
  "fixed: оплаченный запуск не считается экономией",
  savings.actualCostUsd === 0 && savings.totalCostUsd === 2
);
check(
  "fixed: разбивка по задачам агрегирует повторы",
  savings.byTask[0].taskName === "build" &&
    savings.byTask[0].runs === 2 &&
    savings.byTask[0].tokens === 3000 &&
    savings.byTask[0].savedUsd === 0.03
);
check(
  "fixed: порядок разбивки — по экономии",
  savings.byTask.length === 2 && savings.byTask[1].taskName === "deploy"
);
check(
  "fixed: запуск running не попал в оценку",
  !savings.byTask.some((row) => row.taskName === "running")
);

// --- 3. Своя эталонная цена и лимит строк -----------------------------------
const doubled = computeSavings(records, {
  referenceCostPer1kTokensUsd: 0.02,
  topLimit: 1,
});
check("custom: цена 0.02 удваивает экономию", doubled.savedUsd === 0.07);
check("custom: topLimit ограничивает разбивку", doubled.byTask.length === 1);

// --- 4. Интеграция с buildAnalytics ----------------------------------------
const report = buildAnalytics(records, { days: 14, now, topLimit: 10 });
check(
  "analytics: отчёт содержит savings",
  !!report.savings && report.savings.savedUsd === 0.035 && report.savings.runs === 3
);
check(
  "analytics: running не считается нигде",
  report.totals.total === 5 && report.savings.runs === 3
);

// --- 5. Окно анализа --------------------------------------------------------
const withOld = [
  ...records,
  { taskName: "old", status: "success", startedAt: "2026-10-01T00:00:00.000Z", tokens: 10000 },
];
const windowed = buildAnalytics(withOld, { days: 7, now });
check(
  "analytics: записи вне окна не попадают в экономию",
  windowed.savings.savedUsd === 0.035 && windowed.savings.runs === 3
);

// --- 6. Экономика v2: E-3.1, E-4.1, E-4.2, E-5.1 ---------------------------
const eff = tokenEfficiencyScore(records);
check(
  "E-3.1: токены error идут в wasted, success — в useful",
  eff.runs === 5 &&
    eff.usefulRuns === 4 &&
    eff.totalTokens === 103500 &&
    eff.wastedTokens === 2000 &&
    eff.score === 98.07
);
check(
  "E-3.1: пустая история и детерминизм (fail-open)",
  tokenEfficiencyScore([]).score === 0 &&
    JSON.stringify(tokenEfficiencyScore(records)) ===
      JSON.stringify(tokenEfficiencyScore(records))
);

const fc = forecastSpend(records, 7, now);
check(
  "E-4.1: прогноз по окну без NaN/Infinity",
  fc.basedOnRuns === 5 &&
    Number.isFinite(fc.projectedUsd) &&
    Number.isFinite(fc.dailyRateUsd) &&
    fc.projectedUsd >= 0 &&
    forecastSpend([], 7, now).projectedUsd === 0 &&
    forecastSpend([], 7, now).confidence === "low"
);

const dash = buildGrafanaDashboard({ windowDays: 7 });
check(
  "E-4.2: детерминированный JSON с refs на три метрики",
  dash.panels.length === 3 &&
    [GRAFANA_METRIC_NAMES.spendUsd, GRAFANA_METRIC_NAMES.tokens, GRAFANA_METRIC_NAMES.efficiency].every(
      (metric) => JSON.stringify(dash).includes(metric)
    ) &&
    JSON.stringify(dash) === JSON.stringify(buildGrafanaDashboard({ windowDays: 7 }))
);

const split = splitLocalCloud(records);
check(
  "E-5.1: локальные модели отделены от облачных, running не учитывается",
  split.local.runs === 2 &&
    split.cloud.runs === 3 &&
    split.local.tokens === 3000 &&
    split.cloud.tokens === 100500 &&
    splitLocalCloud([]).local.runs === 0
);
check(
  "E-5.1: детерминизм разбивки",
  JSON.stringify(splitLocalCloud(records)) === JSON.stringify(splitLocalCloud(records))
);

console.log(`\n${passed}/${results.length} проверок счётчика экономии пройдены.`);
process.exit(failed > 0 ? 1 : 0);
