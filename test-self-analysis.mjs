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
  ACCEPTANCE_METRICS_VERSION,
  buildAcceptanceDataset,
  computeAcceptanceMetrics,
  evaluateAcceptanceGate,
  maskAcceptanceSecrets,
  LORA_DATASET_VERSION,
  LORA_FORMAT,
  LORA_ONLINE_LEARNING,
  LORA_CRITERIA,
  buildLoraDataset,
  validateLoraDataset,
  LORA_ADAPTER_VERSION,
  LORA_ADAPTER_FORMAT,
  LORA_TRAINING_MODE,
  LORA_PROMOTION,
  loraDatasetHash,
  buildLoraAdapterCandidate,
  evaluateLoraAdapter,
  promoteLoraAdapter,
  LORA_ROLLOUT_FORMAT,
  LORA_SHADOW_TRAFFIC_SHARE,
  LORA_CANARY_TRAFFIC_SHARE,
  activateLoraShadow,
  compareLoraShadow,
  promoteShadowToCanary,
  rollbackLoraAdapter,
} from "./dist/core/self-analysis.js";
import { buildAnalytics } from "./dist/core/analytics.js";
import { t } from "./dist/i18n.js";
import { buildInstallationWarning } from "./dist/shared/installation-warning.js";

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

// QA-P1.4: errorRate — инвертированный балл 0..100, а не доля ошибок.
{
  const recent = (count, overrides) =>
    Array.from({ length: count }, (_, i) =>
      createRecord({
        ...overrides,
        startedAt: new Date(Date.now() - i - 1).toISOString(),
      }),
    );
  const records = [
    ...recent(322, { status: "success" }),
    ...recent(250, { status: "error", error: "boom" }),
    ...recent(1, { status: "partial", error: "part" }),
  ];
  const report = buildAnalytics(records, { days: 14 });
  const health = calculateHealthScore(report);
  const total = report.totals.total;
  const rawErrorPercent = (report.totals.error / Math.max(1, total)) * 100;

  check(
    "QA-P1.4: successRate совпадает с округлённой долей успехов",
    health.components.successRate === report.totals.successRate &&
      Math.abs(report.totals.successRate - (report.totals.success / total) * 100) < 0.051,
  );
  check(
    "QA-P1.4: errorRate = 100 - доля ошибок (балл, не процент)",
    Math.abs(health.components.errorRate - (100 - rawErrorPercent)) < 0.001,
  );
  check(
    "QA-P1.4: errorRate + доля ошибок = 100",
    Math.abs(health.components.errorRate + rawErrorPercent - 100) < 0.001,
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
  // PL-13/PL-29/PL-31: счётчик задач = definition, а не имена из истории.
  const records = createRecords(20, { status: "success", taskName: "history-only-task" });
  const report = generateSelfAnalysisReport(records, {
    days: 14,
    tasks: [{ name: "A" }, { name: "B" }, { name: "C" }],
  });
  check("sources: tasksAnalyzed = числу definition", report.sources.tasksAnalyzed === 3);
  check("sources: taskDefinitions = 3", report.sources.taskDefinitions === 3);
}

{
  const records = createRecords(20, { status: "success" });
  const report = generateSelfAnalysisReport(records, { days: 14 });

  check("summary: непустой", report.summary.length > 0);
  // QA-CI-4: сводка локализована, поэтому ожидаемую строку берём из того же
  // каталога — тест должен проходить и при OPENCODE_SCHEDULER_LOCALE=en/zh.
  const expectedHealth = t("selfAnalysis.health", {
    level: t(`selfAnalysis.level.${report.health.level}`),
    score: report.health.score,
  });
  check("summary: содержит локализованное здоровье", report.summary.includes(expectedHealth));
}

{
  const report = generateSelfAnalysisReport([], { days: 14 });

  check("empty: health.score >= 0", report.health.score >= 0);
  check("empty: нет аномалий", report.anomalies.length === 0);
  check("empty: нет трендов", report.trends.length === 0);
  check("empty: нет рекомендаций", report.recommendations.length === 0);
}

// --- EV-1: воспроизводимая приёмка §11 ---------------------------------------

const acceptanceNow = new Date("2026-11-25T12:00:00.000Z");

function makeGateRow(overrides = {}, hoursAgo = 1) {
  return {
    outcomeKey: `row-${Math.random().toString(36).slice(2)}`,
    missionId: null,
    runId: null,
    stepId: null,
    stepName: null,
    taskType: "task-a",
    triggerKind: "adhoc",
    executor: "local",
    routeSource: "capability-map",
    routeReason: "reuse example",
    gateType: "quality-gate",
    verdict: "pass",
    attemptsToPass: 1,
    firstPass: 1,
    evidencePath: "reports/evidence.json?token=sk-abcdefgh1234",
    gateHash: "gate-a",
    policyHash: "policy-a",
    promptHash: "prompt-a",
    modelVersion: "model-a",
    createdAt: new Date(acceptanceNow.getTime() - hoursAgo * 3_600_000).toISOString(),
    prevHash: "0".repeat(64),
    ...overrides,
  };
}

console.log("\n=== EV-1: приёмка §11 ===");

{
  const rows = [
    makeGateRow({}, 5),
    makeGateRow({ outcomeKey: "stable-pass-2" }, 4),
    makeGateRow({ outcomeKey: "stable-pass-3" }, 3),
    makeGateRow({ gateHash: "gate-b", verdict: "fail", firstPass: 0 }, 2),
    makeGateRow({ gateHash: "gate-b", verdict: "fail", firstPass: 0 }, 1),
    makeGateRow({ gateHash: "gate-c", verdict: "fail", firstPass: 0 }, 1),
    makeGateRow({ gateHash: "gate-c" }, 1),
    makeGateRow({ verdict: "flake" }, 1),
    makeGateRow({ gateHash: null }, 1),
  ];
  const dataset = buildAcceptanceDataset(rows, { now: acceptanceNow });
  const stablePassCases = dataset.cases.filter((c) => c.label === "stable_pass");
  const stableFailCases = dataset.cases.filter((c) => c.label === "stable_fail");
  const unstableCases = dataset.cases.filter((c) => c.label === "unstable");

  check("EV-1.1: источник — ledger", dataset.source === "gate_outcomes.ledger");
  check("EV-1.1: версия фикс-набора", dataset.version === "1.0");
  check("EV-1.1: стабильный pass", stablePassCases.length === 1);
  check("EV-1.1: стабильный fail", stableFailCases.length === 1);
  check("EV-1.1: нестабильная группа помечена", unstableCases.length === 1);
  check("EV-1.1: flake и субъективные строки отклонены", dataset.excluded === 2);
  check(
    "EV-1.1: секреты в доказательствах замаскированы",
    dataset.cases.every((c) => !/sk-abcdefgh1234/.test(c.evidencePath ?? "")),
  );

  const again = buildAcceptanceDataset(rows, { now: acceptanceNow });
  check(
    "EV-1.1: сборка детерминирована",
    JSON.stringify(again.cases) === JSON.stringify(dataset.cases),
  );
}

{
  const rows = [
    makeGateRow({}, 10),
    makeGateRow({ gateHash: "gate-b", verdict: "fail", firstPass: 0 }, 9),
    makeGateRow({ gateHash: "gate-b", verdict: "fail", firstPass: 0 }, 8),
    makeGateRow({ gateHash: "gate-c", triggerKind: "registered" }, 7),
    makeGateRow({ gateHash: "gate-c", triggerKind: "registered" }, 6),
    makeGateRow({ gateHash: "gate-c", executor: "cloud", routeReason: "escalation" }, 5),
    makeGateRow({ gateHash: "gate-c", verdict: "infra_fail" }, 4),
  ];
  const history = [
    {
      taskName: "task-a",
      status: "success",
      startedAt: acceptanceNow.toISOString(),
      tokens: 10000,
      costUsd: 0,
    },
  ];
  const metrics = computeAcceptanceMetrics({
    rows,
    history,
    days: 28,
    now: acceptanceNow,
  });
  const c = metrics.criteria;

  check("EV-1.2: формат метрик", metrics.format === "agent-steward.acceptance");
  check("EV-1.2: владелец и горизонт зафиксированы", !!metrics.owner && metrics.windowDays === 28);
  check("EV-1.2: критерий 1 — ad-hoc гейт", c.adhocGateSafety.observed && c.adhocGateSafety.objectiveWithEvidence > 0);
  check("EV-1.2: критерий 2 — local-first доля", c.localFirstRouting.localShare > 0 && c.localFirstRouting.localShare <= 1);
  check("EV-1.2: критерий 3 — объективный гейт", c.objectiveGate.objective > 0 && c.objectiveGate.escalations > 0);
  check("EV-1.2: критерий 4 — net-экономия и escalation rate", c.honestEconomy.netEconomyUsd > 0 && c.honestEconomy.escalationRate > 0);
  check("EV-1.2: критерий 5 — переиспользование примера", c.learningLoopReuse.reused > 0);
  check("EV-1.2: критерий 6 — паритет", c.parity.pairs > 0 && c.parity.mismatches === 0);
  check("EV-1.2: критерий 7 — недели фикс-набора", c.fixedSet.weeks === 4 && c.fixedSet.cases === 3);
  check("EV-1.2: first_pass_rate в диапазоне 0..1", c.fixedSet.firstPassRate >= 0 && c.fixedSet.firstPassRate <= 1);
  check("EV-1.2: источник метрик — ledger", metrics.source === "gate_outcomes.ledger");
  check(
    "EV-1.2: строки вне окна отброшены",
    (() => {
      const stale = computeAcceptanceMetrics({
        rows: [makeGateRow({}, 24 * 30)],
        days: 28,
        now: acceptanceNow,
      });
      return stale.sampleSize === 0;
    })(),
  );

  const goodRows = [
    ...Array.from({ length: 10 }, (_, i) => makeGateRow({}, 10 - i)),
    makeGateRow({ gateHash: "gate-b", verdict: "fail", firstPass: 0 }, 1),
    makeGateRow({ gateHash: "gate-c" }, 1),
    makeGateRow({ gateHash: "gate-c" }, 1),
  ];
  const good = computeAcceptanceMetrics({
    rows: goodRows,
    history,
    days: 28,
    now: acceptanceNow,
  });
  const baseline = {
    version: ACCEPTANCE_METRICS_VERSION,
    successRate: 0.9,
    firstPassRate: 0.9,
    netEconomyUsd: 0.1,
  };
  const gate = evaluateAcceptanceGate(good, baseline);
  check("EV-1.3: гейт проходит на здоровом наборе", gate.ok);
  check("EV-1.3: все проверки гейта зелёные", gate.checks.every((check) => check.ok));
  check("EV-1.3: инструкция отката присутствует", gate.rollback.includes("git checkout HEAD"));

  const degradedBaseline = {
    version: ACCEPTANCE_METRICS_VERSION,
    successRate: 0.99,
    firstPassRate: 0.99,
    netEconomyUsd: 500,
  };
  const degradedGate = evaluateAcceptanceGate(good, degradedBaseline);
  check("EV-1.3: деградация относительно baseline ломает гейт", !degradedGate.ok);
  check(
    "EV-1.3: провалена проверка eval_not_degraded",
    degradedGate.checks.some((check) => check.id === "eval_not_degraded" && !check.ok),
  );
  check(
    "EV-1.3: без метрик гейт не проходит",
    !evaluateAcceptanceGate(metrics, null).ok,
  );
}

{
  check(
    "EV-1.1: маскировка Bearer и password",
    maskAcceptanceSecrets("Bearer abcdefgh1234 password=hunter2") ===
      "[MASKED] [MASKED]",
  );
  check("EV-1.1: null остаётся null", maskAcceptanceSecrets(null) === null);
}

// --- LP-1.1: критерии датасета staged LoRA -----------------------------------

{
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const first = makeGateRow({
      gateHash: `lora-gate-${i}`,
      taskType: i === 0 ? "task-sk-abcdefgh1234" : `task-${i}`,
      evidencePath: i === 0 ? "reports/e?token=sk-abcdefgh1234" : `reports/e-${i}.json`,
      executor: i === 0 ? "Bearer abcdefgh1234" : "local",
    });
    rows.push(first, { ...first, outcomeKey: `${first.outcomeKey}-dup` });
  }
  const flake = makeGateRow({ gateHash: "lora-flake" });
  rows.push(flake, { ...flake, outcomeKey: `${flake.outcomeKey}-fail`, verdict: "fail" });
  rows.push(makeGateRow({ gateHash: null, verdict: "pass" }));

  const dataset = buildLoraDataset(rows, { now: acceptanceNow });
  const validation = validateLoraDataset(dataset);

  check("LP-1.1: формат и версия датасета", dataset.format === LORA_FORMAT && dataset.version === LORA_DATASET_VERSION);
  check("LP-1.1: источник только ledger", dataset.source === "gate_outcomes.ledger");
  check("LP-1.1: онлайн-обучение запрещено в формате", dataset.onlineLearning === LORA_ONLINE_LEARNING && dataset.criteria.onlineLearning === false);
  check("LP-1.1: criteria фиксируют пороги", LORA_CRITERIA.minCases === 20 && LORA_CRITERIA.minStableShare === 0.8 && LORA_CRITERIA.minSamples === 2);
  check("LP-1.1: стабильные кейсы отобраны", dataset.cases.length === 24);
  check("LP-1.1: flake и subjective исключены", dataset.cases.every((item) => ["stable_pass", "stable_fail"].includes(item.label)) && dataset.excluded >= 1);
  check("LP-1.1: доля стабильных >= 0.8", dataset.stableShare >= 0.8);
  check("LP-1.1: секреты маскируются повторно", dataset.cases.every((item) => ![item.taskType, item.gateType, item.executor ?? "", item.routeSource ?? "", item.evidencePath ?? ""].some((value) => /sk-[A-Za-z0-9_-]{8,}|Bearer\s+\w{8,}/.test(value))));
  check("LP-1.1: валидация датасета проходит", validation.ok && validation.checks.every((item) => item.ok));

  const mutate = (patch) => validateLoraDataset({ ...dataset, ...patch });
  const failed = (result, id) => result.checks.some((item) => item.id === id && !item.ok);

  check("LP-1.1: неверная версия ломает валидацию", failed(mutate({ version: "0.9" }), "dataset_version"));
  check("LP-1.1: чужой источник ломает валидацию", failed(mutate({ source: "manual" }), "source_ledger"));
  check("LP-1.1: малый объём ломает валидацию", failed(mutate({ cases: dataset.cases.slice(0, 5) }), "volume"));
  check("LP-1.1: низкая доля стабильных ломает валидацию", failed(mutate({ stableShare: 0.5 }), "stable_share"));
  check("LP-1.1: дубликат caseId ломает валидацию", failed(mutate({ cases: [...dataset.cases, dataset.cases[0]] }), "dedup"));
  check("LP-1.1: не маскированный секрет ломает валидацию", failed(mutate({ cases: [{ ...dataset.cases[0], evidencePath: "reports/e?token=sk-abcdefgh1234" }, ...dataset.cases.slice(1)] }), "secrets_masked"));
  check("LP-1.1: онлайн-режим ломает валидацию", failed(mutate({ onlineLearning: "allowed" }), "online_learning_forbidden"));
  check("LP-1.1: пустой датасет не проходит валидацию", !validateLoraDataset(buildLoraDataset([], { now: acceptanceNow })).ok);
}

// --- LP-1.2: офлайн-адаптер с обязательным eval -------------------------------

{
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const first = makeGateRow({ gateHash: `lora2-gate-${i}` });
    rows.push(first, { ...first, outcomeKey: `${first.outcomeKey}-dup` });
  }
  const dataset = buildLoraDataset(rows, { now: acceptanceNow });
  const candidate = buildLoraAdapterCandidate(dataset, { now: acceptanceNow, baseModelRef: "local:3-4B" });
  const baseline = { successRate: 0.4, firstPassRate: 0.5, netEconomyUsd: 10, cases: dataset.cases.length };

  check("LP-1.2: формат и версия кандидата", candidate.format === LORA_ADAPTER_FORMAT && candidate.version === LORA_ADAPTER_VERSION);
  check("LP-1.2: режим только офлайн", candidate.trainingMode === LORA_TRAINING_MODE && candidate.promoted === false && candidate.eval === null);
  check("LP-1.2: ссылка на внешние весы без онлайн-обучения", candidate.weightsRef.startsWith("offline://adapter/") && LORA_PROMOTION.onlineLearning === false);
  check("LP-1.2: отпечаток датасета детерминирован", loraDatasetHash(dataset) === loraDatasetHash(buildLoraDataset(rows, { now: acceptanceNow })));
  check(
    "LP-1.2: идентификатор адаптера детерминирован",
    candidate.adapterId === buildLoraAdapterCandidate(dataset, { now: acceptanceNow, baseModelRef: "local:3-4B" }).adapterId,
  );
  check(
    "LP-1.2: другая модель даёт другой идентификатор",
    candidate.adapterId !== buildLoraAdapterCandidate(dataset, { now: acceptanceNow, baseModelRef: "local:8B" }).adapterId,
  );

  const evalResult = evaluateLoraAdapter(candidate, dataset, baseline, { ...baseline }, { now: acceptanceNow });
  check("LP-1.2: eval на уровне эталона проходит", evalResult.verdict === "pass" && evalResult.checks.every((item) => item.ok));
  check("LP-1.2: eval не мутирует кандидата", candidate.eval === null && evalResult.metrics !== baseline);
  const promotion = promoteLoraAdapter(candidate, evalResult);
  check("LP-1.2: включение разрешено только после eval", promotion.ok && promotion.checks.every((item) => item.ok));
  check("LP-1.2: команда отката присутствует", promotion.rollback.includes("git checkout HEAD"));

  const failed = (result, id) => result.checks.some((item) => item.id === id && !item.ok);
  const degraded = evaluateLoraAdapter(candidate, dataset, baseline, { ...baseline, successRate: baseline.successRate - 0.03 });
  check("LP-1.2: деградация метрик ломает eval", degraded.verdict === "fail" && failed(degraded, "no_degradation"));
  check("LP-1.2: проваленный eval запрещает включение", !promoteLoraAdapter(candidate, degraded).ok);
  check(
    "LP-1.2: подмена датасета ломает eval",
    failed(evaluateLoraAdapter({ ...candidate, datasetHash: "podmena" }, dataset, baseline, { ...baseline }), "dataset_match"),
  );
  check(
    "LP-1.2: онлайн-режим ломает eval и включение",
    (() => {
      const online = { ...candidate, trainingMode: "online" };
      const evaluated = evaluateLoraAdapter(online, dataset, baseline, { ...baseline });
      return failed(evaluated, "offline_only") && !promoteLoraAdapter(online, evaluated).ok;
    })(),
  );
  check(
    "LP-1.2: повторное включение запрещено",
    !promoteLoraAdapter({ ...candidate, promoted: true }, evalResult).ok,
  );
  check(
    "LP-1.2: отсутствующий eval ломает включение",
    failed(promoteLoraAdapter(candidate, { ...evalResult, kind: "other" }), "eval_present"),
  );
  check(
    "LP-1.2: метрики ниже порогов ломают eval",
    failed(
      evaluateLoraAdapter(candidate, dataset, baseline, { ...baseline, firstPassRate: 0.1 }),
      "thresholds",
    ),
  );
  check(
    "LP-1.2: невалидный датасет отклоняется до весов",
    (() => {
      try {
        buildLoraAdapterCandidate(buildLoraDataset([], { now: acceptanceNow }));
        return false;
      } catch (error) {
        return String(error.message).startsWith("LORA_DATASET_INVALID");
      }
    })(),
  );
}

// --- LP-1.3: теневой режим, канареечный выход и откат ---------------------------

{
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const first = makeGateRow({ gateHash: `lora3-gate-${i}` });
    rows.push(first, { ...first, outcomeKey: `${first.outcomeKey}-dup` });
  }
  const dataset = buildLoraDataset(rows, { now: acceptanceNow });
  const candidate = buildLoraAdapterCandidate(dataset, { now: acceptanceNow });
  const baseline = { successRate: 0.4, firstPassRate: 0.5, netEconomyUsd: 10, cases: dataset.cases.length };
  const decision = promoteLoraAdapter(
    candidate,
    evaluateLoraAdapter(candidate, dataset, baseline, { ...baseline }, { now: acceptanceNow }),
  );
  const shadow = activateLoraShadow(decision, { now: acceptanceNow });

  check("LP-1.3: формат записи о включении", shadow.format === LORA_ROLLOUT_FORMAT && shadow.adapterId === candidate.adapterId);
  check("LP-1.3: теневой режим с нулевой долей трафика", shadow.mode === "shadow" && shadow.trafficShare === LORA_SHADOW_TRAFFIC_SHARE && shadow.canaryShare === 0);
  check("LP-1.3: включение зафиксировано с командой отката", shadow.decisionOk === true && shadow.rollbackCommand.includes("git checkout HEAD"));
  check(
    "LP-1.3: без положительного решения включение невозможно",
    (() => {
      try {
        activateLoraShadow({ ...decision, ok: false }, { now: acceptanceNow });
        return false;
      } catch (error) {
        return String(error.message).startsWith("LORA_PROMOTION_REQUIRED");
      }
    })(),
  );

  const comparison = compareLoraShadow(shadow, { metrics: { ...baseline }, baseline });
  check("LP-1.3: сравнение на уровне эталона разрешает canary", comparison.ok && comparison.next === "canary");
  check("LP-1.3: канареечная доля мала", comparison.canaryShare === LORA_CANARY_TRAFFIC_SHARE && LORA_CANARY_TRAFFIC_SHARE < 0.1);
  const canary = promoteShadowToCanary(shadow, comparison, { now: acceptanceNow });
  check("LP-1.3: переход в canary зафиксирован", canary.mode === "canary" && canary.trafficShare === LORA_CANARY_TRAFFIC_SHARE);
  check(
    "LP-1.3: полный трафик недостижим без отдельного решения",
    canary.trafficShare < 1 && canary.canaryShare < 1,
  );
  check(
    "LP-1.3: запрет перехода в canary без успешного сравнения",
    (() => {
      try {
        promoteShadowToCanary(shadow, { ...comparison, next: "blocked", ok: false }, { now: acceptanceNow });
        return false;
      } catch (error) {
        return String(error.message).startsWith("LORA_SHADOW_GATE_FAILED");
      }
    })(),
  );

  const degraded = compareLoraShadow(shadow, { metrics: { ...baseline, successRate: baseline.successRate - 0.05 }, baseline });
  check("LP-1.3: деградация блокирует выход из тени", degraded.next === "blocked" && !degraded.ok);
  const held = compareLoraShadow(shadow, { metrics: { ...baseline, cases: 0 }, baseline });
  check("LP-1.3: нет данных — удержание в тени", held.next === "hold" && held.canaryShare === 0);

  const rollback = rollbackLoraAdapter(canary, "деградация метрик", { now: acceptanceNow });
  check("LP-1.3: откат обнуляет обе доли трафика", rollback.trafficShare === 0 && rollback.canaryShare === 0);
  check("LP-1.3: откат сохраняет причину и команду возврата", rollback.reason === "деградация метрик" && rollback.command.includes("git checkout HEAD"));
  check("LP-1.3: откат привязан к адаптеру", rollback.adapterId === candidate.adapterId);
  check("LP-1.3: откат из тени тоже обнуляет трафик", rollbackLoraAdapter(shadow, "останов", { now: acceptanceNow }).trafficShare === 0);
}

// --- DEEP-3.1: предупреждение о рассинхроне установки -------------------------

{
  const diagnostics = {
    version: "0.0.7",
    modulePath: "C:\\plugins\\agent-steward\\dist\\version.js",
    workspaceVersion: "0.0.8",
    workspaceRoot: "C:\\work\\checkout",
    staleInstallation: true,
    reason: "identity-mismatch",
  };
  const warning = buildInstallationWarning(diagnostics);
  check("DEEP-3.1: identity-mismatch даёт предупреждение", warning?.reason === "identity-mismatch");
  check(
    "DEEP-3.1: предупреждение несёт обе версии и пути",
    warning?.loadedVersion === "0.0.7" &&
      warning?.workspaceVersion === "0.0.8" &&
      warning?.loadedFrom === diagnostics.modulePath &&
      warning?.workspaceRoot === diagnostics.workspaceRoot,
  );
  check(
    "DEEP-3.1: сообщение объясняет действие",
    typeof warning?.message === "string" && warning.message.includes("restart OpenCode"),
  );
  check(
    "DEEP-3.1: stale без identity даёт stale-installation",
    buildInstallationWarning({ ...diagnostics, reason: "ok" })?.reason === "stale-installation",
  );
  check(
    "DEEP-3.1: ok/no-workspace-manifest/отсутствие диагностики — без предупреждения",
    buildInstallationWarning({ ...diagnostics, staleInstallation: false, reason: "ok" }) === null &&
      buildInstallationWarning({ ...diagnostics, staleInstallation: false, reason: "no-workspace-manifest" }) === null &&
      buildInstallationWarning(null) === null,
  );
  check(
    "QA-DEEP4-1: stale без манифеста workspace всё равно даёт предупреждение",
    buildInstallationWarning({
      ...diagnostics,
      workspaceVersion: null,
      staleInstallation: true,
      reason: "identity-mismatch",
    })?.reason === "identity-mismatch",
  );

  const withWarning = generateSelfAnalysisReport([], { installationWarning: warning });
  check("DEEP-3.1: отчёт несёт предупреждение", withWarning.installationWarning === warning);
  check(
    "DEEP-3.1: предупреждение поднято в рекомендации высокого приоритета",
    withWarning.recommendations.some(
      (item) => item.priority === 9 && item.category === "monitoring" && item.title === warning.message,
    ),
  );
  const clean = generateSelfAnalysisReport([]);
  check("DEEP-3.1: без рассинхрона поле null", clean.installationWarning === null);
  check(
    "DEEP-3.1: без рассинхрона нет лишней рекомендации",
    !clean.recommendations.some((item) => item.title === warning.message),
  );
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
