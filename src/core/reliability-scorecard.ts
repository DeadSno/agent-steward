/**
 * S-3: публичная метрика объективных гейтов и сэкономленных токенов.
 *
 * Принцип: оценка надёжности строится ТОЛЬКО по проверяемым фактам —
 * исходам гейтов, помеченным `objective: true`, и истории запусков (токены и
 * записанная стоимость). Самооценка модели (`objective: false`) попадает в
 * отчёт, но не в score. Экономия токенов — контрфактическая ОЦЕНКА по методике
 * `docs/SAVINGS.md`, поэтому метрика всегда несёт ссылку на методику и размер
 * выборки. Модуль чистый: без БД, HTTP, ОС и `@opencode-*`.
 */

import { computeSavings, type SavingsRecord, type SavingsReport } from "./savings.js";

/** Версия формата — меняется при изменении формулы или semantics полей. */
export const RELIABILITY_SCORECARD_VERSION = "1.0";

/** Идентификатор формата для Machine-readable отчётов. */
export const RELIABILITY_SCORECARD_FORMAT = "agent-steward.reliability-scorecard";

/** Методика, которую показывают рядом с метрикой. */
export const RELIABILITY_SCORECARD_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/RELIABILITY.md#methodology";

/** Минимум объективных гейтов, при котором score вообще публикуется. */
export const MIN_OBJECTIVE_GATES_FOR_SCORE = 3;

/** Вес объективных гейтов в итоговом score. */
export const GATE_WEIGHT = 0.7;

/** Вес доли сэкономленных токенов в итоговом score. */
export const TOKEN_WEIGHT = 0.3;

/**
 * Исход одного гейта. `objective: true` означает, что решение вынесено кодом
 * (команда/тест/проверка источника), а не текстом модели по её словам.
 */
export interface ReliabilityGateOutcome {
  taskName: string;
  passed: boolean;
  objective?: boolean;
  /** Попытки до успеха; 1 = успех с первой попытки. */
  attempts?: number;
  /** Произвольная метка источника для отладки (не влияет на score). */
  source?: string;
}

/** Входные данные.scorecards: история запусков и исходы гейтов. */
export interface ReliabilityScorecardInput {
  runs?: SavingsRecord[];
  gates?: ReliabilityGateOutcome[];
}

export interface ReliabilityScorecardOptions {
  /** Эталонная цена $/1k токенов; по умолчанию как в savings.ts. */
  referenceCostPer1kTokensUsd?: number;
  /** Сколько строк разбивки по задачам оставить в каждой секции. */
  topLimit?: number;
  /** Порог выборки для publication score. */
  minObjectiveGates?: number;
}

export interface GateTaskRow {
  taskName: string;
  objective: number;
  passed: number;
  failed: number;
  passRate: number;
  firstPassRate: number;
}

export interface GateScorecard {
  total: number;
  objective: number;
  subjective: number;
  passed: number;
  failed: number;
  /** passed / objective; 0, если объективных гейтов нет. */
  passRate: number;
  /** Успехи с первой попытки / objective. */
  firstPassRate: number;
  byTask: GateTaskRow[];
}

export interface TokenScorecard {
  /** Завершённые запуски с токенами (включая оплаченные). */
  counted: number;
  /** Токены в контрфактике (стоимость не записана). */
  saved: number;
  /** Токены запусков с записанной стоимостью. */
  paid: number;
  /** saved / counted; 0 без данных. */
  savedShare: number;
}

export interface ReliabilityScorecard {
  kind: "scorecard";
  version: string;
  format: string;
  methodologyUrl: string;
  gates: GateScorecard;
  tokens: TokenScorecard;
  /** Контрфактическая оценка экономии из savings.ts (kind: "estimate"). */
  savings: SavingsReport;
  /** 0..100 или null, если объективных гейтов меньше порога. */
  score: number | null;
  confidence: "low" | "medium" | "high";
  sampleSize: {
    gates: number;
    runs: number;
    tokens: number;
  };
}

function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function validateGate(gate: ReliabilityGateOutcome, index: number): void {
  if (gate === null || typeof gate !== "object") {
    throw new Error(`S-3: гейт #${index} должен быть объектом.`);
  }
  if (typeof gate.taskName !== "string" || gate.taskName.trim() === "") {
    throw new Error(`S-3: у гейта #${index} пустой taskName.`);
  }
  if (typeof gate.passed !== "boolean") {
    throw new Error(`S-3: у гейта #${index} passed должен быть boolean.`);
  }
  if (gate.objective !== undefined && typeof gate.objective !== "boolean") {
    throw new Error(`S-3: у гейта #${index} objective должен быть boolean.`);
  }
  if (
    gate.attempts !== undefined &&
    (!Number.isInteger(gate.attempts) || gate.attempts < 1)
  ) {
    throw new Error(`S-3: у гейта #${index} attempts должен быть целым ≥ 1.`);
  }
}

/**
 * Собирает публичный scorecard. Возвращает детерминированный JSON-объект:
 * оба входа не мутируются, порядок строк фиксирован сортировкой.
 */
export function buildReliabilityScorecard(
  input: ReliabilityScorecardInput,
  options: ReliabilityScorecardOptions = {},
): ReliabilityScorecard {
  if (input === null || typeof input !== "object") {
    throw new Error("S-3: нужен объект с полями runs и gates.");
  }
  const runs = input.runs ?? [];
  const gates = input.gates ?? [];
  if (!Array.isArray(runs) || !Array.isArray(gates)) {
    throw new Error("S-3: runs и gates должны быть массивами.");
  }
  gates.forEach(validateGate);

  const topLimit = Math.max(1, Math.floor(options.topLimit ?? 10));
  const minObjectiveGates = Number.isInteger(options.minObjectiveGates) &&
    (options.minObjectiveGates!) >= 1
    ? (options.minObjectiveGates!)
    : MIN_OBJECTIVE_GATES_FOR_SCORE;

  const savings = computeSavings(runs, {
    referenceCostPer1kTokensUsd: options.referenceCostPer1kTokensUsd,
    topLimit,
  });

  let counted = 0;
  let paid = 0;
  for (const record of runs) {
    if (String(record?.status ?? "") === "running") continue;
    const tokens = positiveNumber(record?.tokens);
    if (tokens <= 0) continue;
    counted += tokens;
    if (positiveNumber(record?.costUsd) > 0) paid += tokens;
  }
  const saved = savings.tokens;
  const savedShare = counted > 0 ? saved / counted : 0;
  const tokens: TokenScorecard = {
    counted,
    saved,
    paid,
    savedShare: roundRate(savedShare),
  };

  const objective = gates.filter((gate) => gate.objective === true);
  const passed = objective.filter((gate) => gate.passed).length;
  const firstPass = objective.filter(
    (gate) => gate.passed && (gate.attempts === undefined || gate.attempts === 1),
  ).length;
  const passRate = objective.length > 0 ? passed / objective.length : 0;
  const firstPassRate = objective.length > 0 ? firstPass / objective.length : 0;
  const byTask = new Map<string, GateTaskRow>();
  for (const gate of objective) {
    const key = gate.taskName.trim();
    const row = byTask.get(key) ?? {
      taskName: key,
      objective: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      firstPassRate: 0,
    };
    row.objective += 1;
    if (gate.passed) row.passed += 1;
    else row.failed += 1;
    byTask.set(key, row);
  }
  for (const gate of objective) {
    const row = byTask.get(gate.taskName.trim());
    if (!row) continue;
    row.firstPassRate = row.passed > 0
      ? roundRate(
        objective.filter(
          (item) =>
            item.taskName.trim() === row.taskName &&
              item.passed &&
              (item.attempts === undefined || item.attempts === 1),
        ).length / row.objective,
      )
      : 0;
    row.passRate = roundRate(row.passed / row.objective);
  }
  const gateRows = [...byTask.values()]
    .sort((a, b) => b.objective - a.objective || a.taskName.localeCompare(b.taskName))
    .slice(0, topLimit);

  const gatesScorecard: GateScorecard = {
    total: gates.length,
    objective: objective.length,
    subjective: gates.length - objective.length,
    passed,
    failed: objective.length - passed,
    passRate: roundRate(passRate),
    firstPassRate: roundRate(firstPassRate),
    byTask: gateRows,
  };

  const hasSample = objective.length >= minObjectiveGates;
  const score = hasSample
    ? roundScore(100 * (GATE_WEIGHT * passRate + TOKEN_WEIGHT * savedShare))
    : null;
  const confidence: ReliabilityScorecard["confidence"] = !hasSample
    ? "low"
    : objective.length >= 20 && savings.runs >= 20
      ? "high"
      : "medium";

  return {
    kind: "scorecard",
    version: RELIABILITY_SCORECARD_VERSION,
    format: RELIABILITY_SCORECARD_FORMAT,
    methodologyUrl: RELIABILITY_SCORECARD_METHODOLOGY_URL,
    gates: gatesScorecard,
    tokens,
    savings,
    score,
    confidence,
    sampleSize: { gates: objective.length, runs: savings.runs, tokens: counted },
  };
}
