/**
 * S-2: чистая математика capability-роутинга и flywheel-обучения.
 *
 * Модуль намеренно не импортирует БД, сеть и OpenCode: те же формулы
 * используются и SQLite-картой (`src/db/capability-repo.ts`), и публичным
 * сабпатом `agent-steward/router`. Это позволяет обучать маршрутизатор в
 * памяти и переносить снимок состояния между процессами без БД.
 */

import { normalizeTaskType } from "./rules.js";

/** Куда исполнять шаг. `review` — данных достаточно, но успех нестабилен. */
export type CapabilityTarget = "local" | "cloud" | "review" | "explore";

/** Порог, выше которого шаг считается надёжным для локали. */
export const LOCAL_SUCCESS_THRESHOLD = 0.85;

/** Порог, ниже которого локальный исполнитель считается безнадёжным. */
export const CLOUD_FAILURE_THRESHOLD = 0.3;

/** Минимум исходов, чтобы карта вообще бралась судить. */
export const MIN_RUNS_FOR_DECISION = 3;

/** Сколько последних исходов хранить (1 — гейт пройден, 0 — провал). */
export const RECENT_RUNS_LIMIT = 10;

/** Полураспад веса исхода в последних прогонах. */
export const SUCCESS_HALF_LIFE_RUNS = 8;

/** Доля затухающего success rate в итоговой надёжности. */
export const DECAY_WEIGHT = 0.7;

/** Доля first-pass rate в итоговой надёжности. */
export const FIRST_PASS_WEIGHT = 0.3;

/** Накопленная статистика исполнителя по одному типу задачи. */
export interface CapabilityLearningRecord {
  taskType: string;
  model: string;
  runsTotal: number;
  runsPassed: number;
  firstPassCount: number;
  /** firstPassCount / runsTotal — доля успехов с первой попытки. */
  firstPassRate: number;
  successRate: number;
  /** Экспоненциально взвешенный success rate последних исходов. */
  decayedSuccessRate: number;
  /** 0.7 * decayed + 0.3 * firstPassRate — вход маршрутизации. */
  effectiveSuccessRate: number;
  /** Последние исходы, старые слева, новые справа. */
  last10Runs: number[];
}

/** Один исход гейта для flywheel-обучения. */
export interface CapabilityLearningOutcome {
  taskType: string;
  model?: string;
  passed: boolean;
  attempts?: number;
  firstPass?: boolean;
}

/** Пороги решения; по умолчанию 0.85 / 0.30 / 3. */
export interface CapabilityRouteThresholds {
  localSuccess?: number;
  cloudFailure?: number;
  minRuns?: number;
}

/** Решение маршрутизатора с объяснением и всеми тремя метриками. */
export interface CapabilityLearningDecision {
  taskType: string;
  target: CapabilityTarget;
  reason: "no-data" | "local-reliable" | "escalate" | "review" | "static-rule";
  successRate: number;
  effectiveSuccessRate: number;
  decayedSuccessRate: number;
  firstPassRate: number;
  runsTotal: number;
  source: "static" | "learned";
}

function requireTaskType(taskType: string): string {
  if (typeof taskType !== "string" || taskType.trim() === "") {
    throw new Error("Пустой тип задачи: Capability Router требует непустой taskType.");
  }
  return normalizeTaskType(taskType);
}

function requireReliability(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Некорректное значение ${field}: ожидалось неотрицательное число, получено ${value}.`);
  }
  return value;
}

/** Экспоненциально взвешенный success rate последних прогонов. */
export function decayedSuccessRate(
  runs: number[],
  halfLife: number = SUCCESS_HALF_LIFE_RUNS,
): number {
  const recent = runs
    .filter((value) => value === 0 || value === 1)
    .slice(-RECENT_RUNS_LIMIT);
  if (recent.length === 0) return 0;
  const hl = Number.isFinite(halfLife) && halfLife > 0 ? halfLife : SUCCESS_HALF_LIFE_RUNS;
  let weighted = 0;
  let weights = 0;
  recent.forEach((value, index) => {
    const age = recent.length - 1 - index;
    const weight = Math.pow(0.5, age / hl);
    weighted += weight * value;
    weights += weight;
  });
  return weights > 0 ? weighted / weights : 0;
}

/** Надёжность для маршрутизации: затухание плюс успех с первой попытки. */
export function effectiveReliability(decayedRate: number, firstPassRate: number): number {
  const decayed = Math.min(1, Math.max(0, decayedRate));
  const firstPass = Math.min(1, Math.max(0, firstPassRate));
  return DECAY_WEIGHT * decayed + FIRST_PASS_WEIGHT * firstPass;
}

/** Создаёт пустую запись для типа задачи. */
export function emptyLearningRecord(taskType: string): CapabilityLearningRecord {
  return {
    taskType: requireTaskType(taskType),
    model: "local",
    runsTotal: 0,
    runsPassed: 0,
    firstPassCount: 0,
    firstPassRate: 0,
    successRate: 0,
    decayedSuccessRate: 0,
    effectiveSuccessRate: 0,
    last10Runs: [],
  };
}

/**
 * Flywheel: один исход гейта обновляет статистику и возвращает НОВУЮ запись.
 * Исходная запись не мутируется — снимок можно хранить и сравнивать.
 */
export function applyLearningOutcome(
  previous: CapabilityLearningRecord | null,
  outcome: CapabilityLearningOutcome,
): CapabilityLearningRecord {
  if (outcome === null || typeof outcome !== "object") {
    throw new Error("S-2: нужен объект исхода гейта.");
  }
  if (typeof outcome.passed !== "boolean") {
    throw new Error("S-2: passed должен быть boolean.");
  }
  if (outcome.attempts !== undefined && (!Number.isInteger(outcome.attempts) || outcome.attempts < 1)) {
    throw new Error("S-2: attempts должен быть целым ≥ 1.");
  }
  if (outcome.firstPass !== undefined && typeof outcome.firstPass !== "boolean") {
    throw new Error("S-2: firstPass должен быть boolean.");
  }
  const key = requireTaskType(outcome.taskType);
  const base = previous ?? emptyLearningRecord(key);
  if (base.taskType !== key) {
    throw new Error(`S-2: исход для ${key} не подходит к записи ${base.taskType}.`);
  }
  const passed = outcome.passed ? 1 : 0;
  const firstPass =
    passed === 1 && (outcome.firstPass ?? (outcome.attempts === undefined || outcome.attempts === 1));
  const runsTotal = base.runsTotal + 1;
  const runsPassed = base.runsPassed + passed;
  const firstPassCount = base.firstPassCount + (firstPass ? 1 : 0);
  const last10Runs = [...base.last10Runs, passed].slice(-RECENT_RUNS_LIMIT);
  const decayed = decayedSuccessRate(last10Runs);
  const firstPassRate = firstPassCount / runsTotal;
  return {
    taskType: key,
    model: (outcome.model ?? base.model ?? "local").trim() || "local",
    runsTotal,
    runsPassed,
    firstPassCount,
    firstPassRate,
    successRate: runsPassed / runsTotal,
    decayedSuccessRate: decayed,
    effectiveSuccessRate: effectiveReliability(decayed, firstPassRate),
    last10Runs,
  };
}

/**
 * Решение слоя 2 по порогам: 0 токенов, без БД.
 * Пороги применяются к effectiveSuccessRate, а не к кумулятивному successRate.
 */
export function decideLearningRoute(
  taskType: string,
  record: CapabilityLearningRecord | null,
  thresholds: CapabilityRouteThresholds = {},
): CapabilityLearningDecision {
  const key = requireTaskType(taskType);
  const localSuccess = thresholds.localSuccess ?? LOCAL_SUCCESS_THRESHOLD;
  const cloudFailure = thresholds.cloudFailure ?? CLOUD_FAILURE_THRESHOLD;
  const minRuns = thresholds.minRuns ?? MIN_RUNS_FOR_DECISION;
  if (localSuccess <= cloudFailure) {
    throw new Error("S-2: localSuccess должен быть больше cloudFailure.");
  }
  if (record && record.taskType !== key) {
    throw new Error(`S-2: запись ${record.taskType} не относится к типу ${key}.`);
  }
  const empty = record ?? emptyLearningRecord(key);
  const metrics = {
    taskType: key,
    successRate: empty.successRate,
    effectiveSuccessRate: empty.effectiveSuccessRate,
    decayedSuccessRate: empty.decayedSuccessRate,
    firstPassRate: empty.firstPassRate,
    runsTotal: empty.runsTotal,
    source: "learned" as const,
  };
  if (!record || record.runsTotal < minRuns) {
    return { ...metrics, target: "explore", reason: "no-data" };
  }
  if (record.effectiveSuccessRate >= localSuccess) {
    return { ...metrics, target: "local", reason: "local-reliable" };
  }
  if (record.effectiveSuccessRate <= cloudFailure) {
    return { ...metrics, target: "cloud", reason: "escalate" };
  }
  return { ...metrics, target: "review", reason: "review" };
}

/** Проверка корректности порогов (для публичного конструктора роутера). */
export function normalizeThresholds(thresholds: CapabilityRouteThresholds = {}): {
  localSuccess: number;
  cloudFailure: number;
  minRuns: number;
} {
  const localSuccess = requireReliability(
    thresholds.localSuccess ?? LOCAL_SUCCESS_THRESHOLD,
    "localSuccess",
  );
  const cloudFailure = requireReliability(
    thresholds.cloudFailure ?? CLOUD_FAILURE_THRESHOLD,
    "cloudFailure",
  );
  const minRuns = thresholds.minRuns ?? MIN_RUNS_FOR_DECISION;
  if (!Number.isInteger(minRuns) || minRuns < 1) {
    throw new Error("S-2: minRuns должен быть целым ≥ 1.");
  }
  if (localSuccess <= cloudFailure) {
    throw new Error("S-2: localSuccess должен быть больше cloudFailure.");
  }
  return { localSuccess, cloudFailure, minRuns };
}
