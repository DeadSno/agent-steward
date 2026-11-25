/**
 * EV-1.3: CI-гейт «eval не деградировал».
 *
 * Режимы:
 *   --collect  — снять новый снимок из живого ledger gate_outcomes в
 *                reports/acceptance-baseline.json (история запусков тоже из БД);
 *   --check    — воспроизвести метрики из закоммиченного снимка и сравнить их
 *                с сохранёнными метриками baseline. Выход 0 только если все
 *                проверки EV-1.1/EV-1.2/EV-1.3 зелёные.
 *
 * Снимок содержит ТОЛЬКО хэши, пути и нейтральные поля ledger; секреты в
 * empirical-тексте маскируются до записи на диск.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  ACCEPTANCE_FORMAT,
  ACCEPTANCE_HORIZON_DAYS,
  ACCEPTANCE_METRICS_VERSION,
  computeAcceptanceMetrics,
  evaluateAcceptanceGate,
  maskAcceptanceSecrets,
} from "../dist/core/self-analysis.js";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const reportsDir = path.join(root, "reports");
const baselineFile = path.join(reportsDir, "acceptance-baseline.json");
const resultFile = path.join(reportsDir, "acceptance-gate.json");

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

/** Убирает секреты из полей, которые попадают в снимок. */
function sanitizeRow(row) {
  return {
    ...row,
    evidencePath: maskAcceptanceSecrets(row.evidencePath),
    routeReason: maskAcceptanceSecrets(row.routeReason),
    routeSource: maskAcceptanceSecrets(row.routeSource),
    taskType: maskAcceptanceSecrets(row.taskType),
    gateType: maskAcceptanceSecrets(row.gateType),
    executor: maskAcceptanceSecrets(row.executor),
    triggerKind: maskAcceptanceSecrets(row.triggerKind),
  };
}

async function collect() {
  const [{ initDb, closeDb }, runsRepo, historyRepo] = await Promise.all([
    import("../dist/db/index.js"),
    import("../dist/db/runs-repo.js"),
    import("../dist/db/history-repo.js"),
  ]);
  initDb();
  try {
    const now = new Date();
    const rows = runsRepo.listAllGateOutcomes().map(sanitizeRow);
    const history = historyRepo.getHistoryForAnalytics(ACCEPTANCE_HORIZON_DAYS).map((record) => ({
      taskName: maskAcceptanceSecrets(record.taskName),
      status: record.status,
      startedAt: record.startedAt,
      tokens: record.tokens,
      costUsd: record.costUsd,
      model: record.model,
    }));
    const metrics = computeAcceptanceMetrics({
      rows,
      history,
      days: ACCEPTANCE_HORIZON_DAYS,
      now,
      datasetOptions: { maxCases: 10000 },
    });
    const baseline = {
      format: ACCEPTANCE_FORMAT,
      version: ACCEPTANCE_METRICS_VERSION,
      source: "gate_outcomes.ledger",
      generatedAt: now.toISOString(),
      horizonDays: ACCEPTANCE_HORIZON_DAYS,
      metrics,
      rows,
      history,
    };
    writeJson(baselineFile, baseline);
    console.log(
      `collect: rows=${rows.length}, cases=${metrics.criteria.fixedSet.cases}, ` +
        `success=${metrics.criteria.fixedSet.successRate}, ` +
        `first=${metrics.criteria.fixedSet.firstPassRate}, ` +
        `net=${metrics.criteria.honestEconomy.netEconomyUsd}`,
    );
    console.log(`baseline: ${path.relative(root, baselineFile)}`);
  } finally {
    closeDb();
  }
}

function check() {
  const baseline = readJson(baselineFile);
  if (!baseline || baseline.version !== ACCEPTANCE_METRICS_VERSION) {
    console.error(`check: baseline отсутствует или имеет несовместимую версию: ${baselineFile}`);
    writeJson(resultFile, { ok: false, reason: "baseline_missing" });
    process.exit(1);
  }

  // Воспроизводимость: те же строки + тот же момент → те же метрики.
  const replay = computeAcceptanceMetrics({
    rows: baseline.rows,
    history: baseline.history ?? [],
    days: baseline.horizonDays ?? ACCEPTANCE_HORIZON_DAYS,
    now: new Date(baseline.generatedAt),
    datasetOptions: { maxCases: 10000 },
  });
  const baselineMetrics = {
    version: baseline.version,
    generatedAt: baseline.generatedAt,
    successRate: baseline.metrics.criteria.fixedSet.successRate,
    firstPassRate: baseline.metrics.criteria.fixedSet.firstPassRate,
    netEconomyUsd: baseline.metrics.criteria.honestEconomy.netEconomyUsd,
  };
  const gate = evaluateAcceptanceGate(replay, baselineMetrics);
  const result = {
    ok: gate.ok,
    format: ACCEPTANCE_FORMAT,
    version: ACCEPTANCE_METRICS_VERSION,
    baselineGeneratedAt: baseline.generatedAt,
    source: baseline.source,
    replaySampleSize: replay.sampleSize,
    checks: gate.checks,
    current: gate.current,
    rollback: gate.rollback,
  };
  writeJson(resultFile, result);

  for (const item of gate.checks) {
    console.log(`${item.ok ? "OK  " : "FAIL"} ${item.id}: ${item.detail}`);
  }
  console.log(`gate: ${gate.ok ? "PASS" : "FAIL"} (${path.relative(root, resultFile)})`);
  if (!gate.ok) {
    console.error(`Откат: ${gate.rollback}`);
  }
  process.exit(gate.ok ? 0 : 1);
}

const mode = process.argv.includes("--collect") ? "collect" : "check";
if (mode === "collect") {
  collect().catch((err) => {
    console.error(`collect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  check();
}
