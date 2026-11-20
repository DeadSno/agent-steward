/**
 * Тесты системы самоанализа (Спринт 32).
 * Запуск: node test-self-analysis.mjs (после npm run build).
 * Чистые функции — БД, сервер и модель не нужны.
 */
import { readFileSync } from "node:fs";
import {
  calculateHealthScore,
  detectAnomalies,
  analyzeTrends,
  generateRecommendations,
  generateSelfAnalysisReport,
} from "./dist/core/self-analysis.js";
import { buildAnalytics } from "./dist/core/analytics.js";

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

// --- Вспомогательные функции -------------------------------------------------

function createRecord(overrides = {}) {
  return {
    taskName: "test-task",
    status: "success",
    startedAt: "2026-11-16T10:00:00.000Z",
    finishedAt: "2026-11-16T10:01:00.000Z",
    durationMs: 60000,
    tokens: 1000,
    costUsd: 0.003,
    model: "test-model",
    ...overrides,
  };
}

function createRecords(count, overrides = {}) {
  return Array.from({ length: count }, (_, i) =>
    createRecord({
      startedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    })
  );
}

// --- 1. Health Score ---------------------------------------------------------

console.log("\n=== Health Score ===");

{
  const records = createRecords(10, { status: "success" });
  const report = buildAnalytics(records, { days: 14 });
  const health = calculateHealthScore(report);

  check("excellent: высокий балл", health.score >= 90);
  check("excellent: уровень excellent", health.level === "excellent");
}

{
  const records = createRecords(10, { status: "error" });
  const report = buildAnalytics(records, { days: 14 });
  const health = calculateHealthScore(report);

  check("poor: низкий балл", health.score < 60);
  check("poor: уровень poor/critical", ["poor", "critical"].includes(health.level));
  check("poor: есть рекомендации", health.recommendations.length > 0);
}

{
  const records = createRecords(10, { status: "success" });
  const report = buildAnalytics(records, { days: 14 });
  const health = calculateHealthScore(report);

  check("components: successRate >= 90", health.components.successRate >= 90);
  check("components: errorRate >= 90", health.components.errorRate >= 90);
}

// roadmap-qa-01: реальные метрики должны быть реальными, а не score 0..100.
{
  const records = [
    createRecord({ durationMs: 120000, status: "success" }),
    createRecord({ durationMs: 180000, status: "success" }),
  ];
  const report = buildAnalytics(records, { days: 14 });
  const health = calculateHealthScore(report);

  check(
    "components: avgDurationMs — реальные мс (150000)",
    health.components.avgDurationMs === report.totals.avgDurationMs &&
      health.components.avgDurationMs > 1000,
  );
  check(
    "components: avgDurationMs не score (<=100)",
    health.components.avgDurationMs > 100,
  );
  check(
    "components: timeoutRate — доля 0..1",
    health.components.timeoutRate >= 0 && health.components.timeoutRate <= 1,
  );
  check(
    "components: crashRecoveryRate — доля 0..1",
    health.components.crashRecoveryRate >= 0 && health.components.crashRecoveryRate <= 1,
  );
  check(
    "components: сохранены нормализованные баллы",
    typeof health.components.avgDurationScore === "number" &&
      typeof health.components.timeoutScore === "number" &&
      typeof health.components.crashRecoveryScore === "number",
  );
}

// --- 2. Anomaly Detection ----------------------------------------------------

console.log("\n=== Anomaly Detection ===");

{
  const records = [
    ...createRecords(5, { status: "error" }),
    ...createRecords(5, { status: "success" }),
  ];
  const anomalies = detectAnomalies(records, { days: 14 });

  const errorSpike = anomalies.find((a) => a.type === "error_spike");
  check("error_spike: обнаружен", !!errorSpike);
  check("error_spike: severity > 0", errorSpike?.severity > 0);
}

{
  const records = [
    createRecord({ durationMs: 300000, status: "success" }),
    ...createRecords(5, { durationMs: 60000, status: "success" }),
  ];
  const anomalies = detectAnomalies(records, { days: 14 });

  const durationSpike = anomalies.find((a) => a.type === "duration_spike");
  check("duration_spike: обнаружен", !!durationSpike);
}

{
  const records = [
    createRecord({ status: "error", error: "timeout exceeded" }),
    createRecord({ status: "error", error: "timeout exceeded" }),
    createRecord({ status: "error", error: "timeout exceeded" }),
    ...createRecords(7, { status: "success" }),
  ];
  const anomalies = detectAnomalies(records, { days: 14 });

  const timeoutSpike = anomalies.find((a) => a.type === "timeout_spike");
  check("timeout_spike: обнаружен", !!timeoutSpike);
}

{
  const records = [
    createRecord({ costUsd: 0.1, status: "success" }),
    ...createRecords(5, { costUsd: 0.003, status: "success" }),
  ];
  const anomalies = detectAnomalies(records, { days: 14 });

  const costSpike = anomalies.find((a) => a.type === "cost_spike");
  check("cost_spike: обнаружен", !!costSpike);
}

{
  const records = [
    createRecord({ status: "running", startedAt: "2026-11-16T10:00:00.000Z" }),
    ...createRecords(5, { status: "success" }),
  ];
  const anomalies = detectAnomalies(records, {
    days: 14,
    now: new Date("2026-11-16T13:00:00.000Z"),
  });

  const stalledRun = anomalies.find((a) => a.type === "stalled_run");
  check("stalled_run: обнаружен", !!stalledRun);
  check("stalled_run: severity > 0", stalledRun?.severity > 0);
}

{
  const records = createRecords(10, {
    status: "success",
    durationMs: 60000,
    costUsd: 0.003,
  });
  const anomalies = detectAnomalies(records, { days: 14 });

  check("clean: нет аномалий", anomalies.length === 0);
}

// --- 3. Trend Analysis -------------------------------------------------------

console.log("\n=== Trend Analysis ===");

{
  const records = [
    ...createRecords(5, { status: "success" }),
    ...createRecords(5, { status: "error" }),
  ];
  const trends = analyzeTrends(records, { days: 14 });

  const successTrend = trends.find((t) => t.metric === "success_rate");
  check("improving: обнаружен тренд", !!successTrend);
  check("improving: направление improving", successTrend?.direction === "improving");
  check("improving: changePercent > 0", successTrend?.changePercent > 0);
}

{
  const records = [
    ...createRecords(5, { status: "error" }),
    ...createRecords(5, { status: "success" }),
  ];
  const trends = analyzeTrends(records, { days: 14 });

  const successTrend = trends.find((t) => t.metric === "success_rate");
  check("degrading: обнаружен тренд", !!successTrend);
  check("degrading: направление degrading", successTrend?.direction === "degrading");
  check("degrading: changePercent < 0", successTrend?.changePercent < 0);
}

{
  const records = [
    ...createRecords(5, { status: "success" }),
    ...createRecords(5, { status: "success" }),
  ];
  const trends = analyzeTrends(records, { days: 14 });

  const successTrend = trends.find((t) => t.metric === "success_rate");
  check("stable: обнаружен тренд", !!successTrend);
  check("stable: направление stable", successTrend?.direction === "stable");
}

{
  const records = createRecords(3, { status: "success" });
  const trends = analyzeTrends(records, { days: 14 });

  check("insufficient: нет трендов", trends.length === 0);
}

// --- 4. Recommendations ------------------------------------------------------

console.log("\n=== Recommendations ===");

{
  const records = createRecords(10, { status: "error" });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  check("poor success: есть рекомендации", report.recommendations.length > 0);
  const successRec = report.recommendations.find((r) =>
    r.title.includes("успешность")
  );
  check("poor success: рекомендация по успешности", !!successRec);
  check("poor success: priority >= 7", successRec?.priority >= 7);
}

{
  const records = createRecords(10, { status: "success", costUsd: 20 });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  const costRec = report.recommendations.find((r) => r.category === "cost");
  check("high cost: рекомендация по стоимости", !!costRec);
  check("high cost: priority >= 6", costRec?.priority >= 6);
}

{
  const records = createRecords(10, { status: "success", durationMs: 400000 });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  const durationRec = report.recommendations.find((r) =>
    r.title.includes("длительность")
  );
  check("long duration: рекомендация по длительности", !!durationRec);
}

{
  const records = createRecords(10, {
    status: "error",
    costUsd: 20,
    durationMs: 400000,
  });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  let sorted = true;
  for (let i = 1; i < report.recommendations.length; i++) {
    if (report.recommendations[i - 1].priority < report.recommendations[i].priority) {
      sorted = false;
      break;
    }
  }
  check("sorted: рекомендации отсортированы по priority", sorted);
}

// --- 5. Self Analysis Report -------------------------------------------------

console.log("\n=== Self Analysis Report ===");

{
  const records = createRecords(20, { status: "success" });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  check("complete: generatedAt есть", !!report.generatedAt);
  check("complete: windowDays = 14", report.windowDays === 14);
  check("complete: health есть", !!report.health);
  check("complete: anomalies есть", Array.isArray(report.anomalies));
  check("complete: trends есть", Array.isArray(report.trends));
  check("complete: recommendations есть", Array.isArray(report.recommendations));
  check("complete: summary есть", !!report.summary);
  check("complete: sources есть", !!report.sources);
}

{
  const records = createRecords(20, { status: "success" });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  check("sources: historyRecords = 20", report.sources.historyRecords === 20);
  check("sources: recordsInWindow > 0", report.sources.recordsInWindow > 0);
  check("sources: tasksAnalyzed > 0", report.sources.tasksAnalyzed > 0);
}

{
  const records = createRecords(20, { status: "success" });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  check("summary: непустой", report.summary.length > 0);
  check("summary: содержит 'Здоровье системы'", report.summary.includes("Здоровье системы"));
}

{
  const report = generateSelfAnalysisReport([], { days: 14 });

  check("empty: health.score >= 0", report.health.score >= 0);
  check("empty: нет аномалий", report.anomalies.length === 0);
  check("empty: нет трендов", report.trends.length === 0);
  check("empty: нет рекомендаций", report.recommendations.length === 0);
}

// --- Итоги -------------------------------------------------------------------

// QA-D.1: в комментариях не должно остаться китайских/смешанных артефактов.
{
  const source = readFileSync("./src/core/self-analysis.ts", "utf8");
  check(
    "self-analysis: комментарии без китайских иероглифов",
    !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source)
  );
  check(
    "self-analysis: комментарии без смешанных русско-английских слов",
    !/[А-Яа-яЁё][A-Za-z]|[A-Za-z][А-Яа-яЁё]/.test(source)
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
