// Деталь 3.19 / S-3: публичная метрика объективных гейтов и сэкономленных токенов.
//
// Проверяем:
//  - гейты без метки objective не влияют на score;
//  - first-pass rate, разбивка по задачам и детерминизм;
//  - долю сэкономленных токенов и контрфактическую оценку из savings.ts;
//  - порог выборки, confidence и валидацию входных данных;
//  - публичный экспорт из agent-steward/core и CLI `scorecard`.
//
// Запуск: node test-scorecard.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname);
let passed = 0;
let failed = 0;
const assert = (message, cond) => {
  if (cond) {
    passed += 1;
    console.log(`OK   ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL ${message}`);
  }
};

const sc = await import("./dist/core/reliability-scorecard.js");
const {
  buildReliabilityScorecard,
  RELIABILITY_SCORECARD_FORMAT,
  RELIABILITY_SCORECARD_METHODOLOGY_URL,
  RELIABILITY_SCORECARD_VERSION,
  MIN_OBJECTIVE_GATES_FOR_SCORE,
  GATE_WEIGHT,
  TOKEN_WEIGHT,
} = sc;
const core = await import("./dist/core-entry.js");

assert("формат и версия метрики зафиксированы", RELIABILITY_SCORECARD_FORMAT === "agent-steward.reliability-scorecard" && RELIABILITY_SCORECARD_VERSION === "1.0");
assert("порог выборки и веса опубликованы", MIN_OBJECTIVE_GATES_FOR_SCORE === 3 && GATE_WEIGHT === 0.7 && TOKEN_WEIGHT === 0.3);
assert("ссылка на методику рядом с метрикой", RELIABILITY_SCORECARD_METHODOLOGY_URL.includes("docs/RELIABILITY.md#methodology"));
assert("публичный экспорт из agent-steward/core", typeof core.buildReliabilityScorecard === "function" && core.RELIABILITY_SCORECARD_VERSION === RELIABILITY_SCORECARD_VERSION);

const runs = [
  { taskName: "build", status: "success", startedAt: "2026-11-24T10:00:00.000Z", tokens: 1000, costUsd: 0, model: "qwen3:4b" },
  { taskName: "build", status: "error", startedAt: "2026-11-24T09:00:00.000Z", tokens: 2000, model: "qwen3:4b" },
  { taskName: "deploy", status: "success", startedAt: "2026-11-24T08:00:00.000Z", tokens: 500, costUsd: null },
  { taskName: "review", status: "success", startedAt: "2026-11-24T07:00:00.000Z", tokens: 100000, costUsd: 2, model: "gpt-4o" },
  { taskName: "noop", status: "success", startedAt: "2026-11-24T06:00:00.000Z", tokens: 0, costUsd: 0 },
  { taskName: "running", status: "running", startedAt: "2026-11-24T11:00:00.000Z", tokens: 9000, costUsd: 0 },
];
const gates = [
  { taskName: "build", passed: true, objective: true, attempts: 1, source: "test-build.mjs" },
  { taskName: "build", passed: true, objective: true, attempts: 2 },
  { taskName: "test", passed: true, objective: true, attempts: 1 },
  { taskName: "test", passed: false, objective: true, attempts: 3 },
  { taskName: "test", passed: true, objective: false, attempts: 1 },
];
const input = { runs, gates };
const before = structuredClone(input);
const card = buildReliabilityScorecard(input);

assert("kind/version/format методики", card.kind === "scorecard" && card.version === RELIABILITY_SCORECARD_VERSION && card.format === RELIABILITY_SCORECARD_FORMAT);
assert("methodologyUrl выставлен", card.methodologyUrl === RELIABILITY_SCORECARD_METHODOLOGY_URL);
assert("входные данные не мутируются", JSON.stringify(input) === JSON.stringify(before));
assert("детерминированный вывод", JSON.stringify(buildReliabilityScorecard(input)) === JSON.stringify(card));
assert("гейты: всего 5, объективных 4", card.gates.total === 5 && card.gates.objective === 4);
assert("самооценка не попала в objective", card.gates.subjective === 1);
assert("гейты: 3 passed / 1 failed", card.gates.passed === 3 && card.gates.failed === 1);
assert("pass rate 0.75", card.gates.passRate === 0.75);
assert("first-pass rate 0.5", card.gates.firstPassRate === 0.5);
assert("разбивка по задачам детерминирована", card.gates.byTask.length === 2 && card.gates.byTask[0].taskName === "build" && card.gates.byTask[1].taskName === "test");
assert("build: 2/2 objective, first-pass 0.5", card.gates.byTask[0].passed === 2 && card.gates.byTask[0].failed === 0 && card.gates.byTask[0].passRate === 1 && card.gates.byTask[0].firstPassRate === 0.5);
assert("test: 1/2 objective, first-pass 0.5", card.gates.byTask[1].passed === 1 && card.gates.byTask[1].failed === 1 && card.gates.byTask[1].passRate === 0.5 && card.gates.byTask[1].firstPassRate === 0.5);
assert("токены: учтено 103500", card.tokens.counted === 103500);
assert("токены: сэкономлено 3500, оплачено 100000", card.tokens.saved === 3500 && card.tokens.paid === 100000);
assert("доля сэкономленных токенов 0.0338", card.tokens.savedShare === 0.0338);
assert("savings — оценка с методикой", card.savings.kind === "estimate" && card.savings.savedUsd === 0.035 && card.savings.runs === 3 && card.savings.methodologyUrl.includes("docs/SAVINGS.md"));
assert("score = 53.51 (0.7×0.75 + 0.3×0.0338)", card.score === 53.51);
assert("confidence medium при 4 гейтах и 3 запусках", card.confidence === "medium");
assert("sampleSize публикует объём выборки", card.sampleSize.gates === 4 && card.sampleSize.runs === 3 && card.sampleSize.tokens === 103500);

const empty = buildReliabilityScorecard({});
assert("пустой ввод: score=null, confidence low", empty.score === null && empty.confidence === "low");
assert("пустой ввод: нули вместо NaN/Infinity", empty.gates.passRate === 0 && empty.tokens.savedShare === 0 && empty.sampleSize.tokens === 0 && empty.savings.savedUsd === 0);
assert("пустой ввод: methodologyUrl на месте", empty.methodologyUrl === RELIABILITY_SCORECARD_METHODOLOGY_URL);

const small = buildReliabilityScorecard({
  runs,
  gates: gates.slice(0, 2),
});
assert("меньше 3 объективных гейтов — score не публикуется", small.score === null && small.confidence === "low");
const override = buildReliabilityScorecard({ runs, gates: gates.slice(0, 2) }, { minObjectiveGates: 2 });
assert("явный minObjectiveGates=2 разрешает score", override.score !== null && override.confidence === "medium");
const top = buildReliabilityScorecard(input, { topLimit: 1, referenceCostPer1kTokensUsd: 0.02 });
assert("topLimit ограничивает разбивку", top.gates.byTask.length === 1 && top.savings.byTask.length === 1);
assert("своя эталонная цена удваивает оценку", top.savings.savedUsd === 0.07);
const high = buildReliabilityScorecard({
  runs: Array.from({ length: 25 }, (_, i) => ({ taskName: "t", status: "success", startedAt: "2026-11-24T00:00:00.000Z", tokens: 100, costUsd: 0 })),
  gates: Array.from({ length: 25 }, () => ({ taskName: "t", passed: true, objective: true })),
});
assert("confidence high при 25 гейтах и 25 запусках", high.confidence === "high" && high.score === 100);

const throws = [
  ["null вместо ввода", () => buildReliabilityScorecard(null)],
  ["runs не массив", () => buildReliabilityScorecard({ runs: {} })],
  ["gates не массив", () => buildReliabilityScorecard({ gates: "x" })],
  ["пустой taskName", () => buildReliabilityScorecard({ gates: [{ taskName: " ", passed: true, objective: true }] })],
  ["passed не boolean", () => buildReliabilityScorecard({ gates: [{ taskName: "t", passed: "true", objective: true }] })],
  ["objective не boolean", () => buildReliabilityScorecard({ gates: [{ taskName: "t", passed: true, objective: "true" }] })],
  ["attempts = 0", () => buildReliabilityScorecard({ gates: [{ taskName: "t", passed: true, objective: true, attempts: 0 }] })],
];
for (const [label, fn] of throws) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(`валидация: ${label}`, threw);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-scorecard-"));
try {
  const jsonPath = path.join(tempRoot, "scorecard.json");
  fs.writeFileSync(jsonPath, JSON.stringify(input), "utf8");
  const json = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "scorecard", jsonPath, "--json"], {
    encoding: "utf8",
    cwd: root,
  });
  assert("CLI scorecard --json exit 0", json.status === 0, `(${json.stderr.slice(0, 200)})`);
  const fromCli = JSON.parse(json.stdout);
  assert("CLI вернул тот же scorecard", fromCli.score === 53.51 && fromCli.gates.objective === 4 && fromCli.tokens.counted === 103500);
  const human = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "scorecard", jsonPath], {
    encoding: "utf8",
    cwd: root,
  });
  assert("CLI scorecard печатает сводку", human.status === 0 && human.stdout.includes("Score: 53.51/100") && human.stdout.includes("Гейты: 4 объективных"));
  const missing = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "scorecard", path.join(tempRoot, "missing.json")], {
    encoding: "utf8",
    cwd: root,
  });
  assert("несуществующий файл даёт exit 1", missing.status === 1);
  const badPath = path.join(tempRoot, "bad.json");
  fs.writeFileSync(badPath, "[]", "utf8");
  const bad = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "scorecard", badPath], {
    encoding: "utf8",
    cwd: root,
  });
  assert("не объект JSON даёт exit 1", bad.status === 1);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} проверок reliability scorecard пройдены.`);
process.exit(failed > 0 ? 1 : 0);
