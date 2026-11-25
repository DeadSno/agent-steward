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

/* ------------------------------------------------------------------------- *
 * EV-2.3: capped explore budget + детерминированный bandit local/cloud
 * ------------------------------------------------------------------------- */

/** Настройки бюджета исследования. По умолчанию лимит 3 запуска/20000 токенов. */
export interface ExploreBudgetConfig {
  enabled?: boolean;
  maxRuns?: number;
  windowRuns?: number;
  maxTokens?: number;
  epsilon?: number;
  nearLimitRuns?: number;
}

export interface NormalizedExploreBudget {
  enabled: boolean;
  maxRuns: number;
  windowRuns: number;
  maxTokens: number;
  epsilon: number;
  nearLimitRuns: number;
}

/** Расход explore-бюджета по одному типу задачи в текущем окне. */
export interface ExploreUsage {
  runs: number;
  tokens: number;
  /** ISO-начала окна; пусто, если расхода ещё не было. */
  windowStart: string;
}

export type ExploreBanditTarget = "local" | "cloud" | "review";

/** Решение bandit'а с объяснением и остатком бюджета. */
export interface ExploreBanditDecision {
  taskType: string;
  target: ExploreBanditTarget;
  reason: string;
  /** true, если решение — реальная попытка исследования исполнителем. */
  exploration: boolean;
  localReward: number;
  cloudReward: number;
  remainingRuns: number;
  nearLimit: boolean;
}

export const DEFAULT_EXPLORE_BUDGET: Readonly<NormalizedExploreBudget> = Object.freeze({
  enabled: false,
  maxRuns: 3,
  windowRuns: 10,
  maxTokens: 20000,
  epsilon: 0.25,
  nearLimitRuns: 1,
});

function budgetNumber(
  value: number | undefined,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new Error(`EV-2.3: ${field} должен быть числом от ${min} до ${max}.`);
  }
  return resolved;
}

/** Проверяет и нормализует конфиг бюджета (без обращения к БД). */
export function normalizeExploreBudget(
  config: ExploreBudgetConfig = {},
): NormalizedExploreBudget {
  const maxRuns = budgetNumber(config.maxRuns, DEFAULT_EXPLORE_BUDGET.maxRuns, "maxRuns", 1, 10000);
  const windowRuns = budgetNumber(
    config.windowRuns,
    DEFAULT_EXPLORE_BUDGET.windowRuns,
    "windowRuns",
    1,
    100000,
  );
  const epsilon = budgetNumber(config.epsilon, DEFAULT_EXPLORE_BUDGET.epsilon, "epsilon", 0, 1);
  return {
    enabled: config.enabled === true,
    maxRuns: Math.floor(maxRuns),
    windowRuns: Math.floor(windowRuns),
    maxTokens: budgetNumber(
      config.maxTokens,
      DEFAULT_EXPLORE_BUDGET.maxTokens,
      "maxTokens",
      1,
      1_000_000_000,
    ),
    epsilon,
    nearLimitRuns: budgetNumber(
      config.nearLimitRuns,
      DEFAULT_EXPLORE_BUDGET.nearLimitRuns,
      "nearLimitRuns",
      0,
      Math.floor(maxRuns),
    ),
  };
}

/** Пустой счётчик расхода (для чистых тестов и старта окна). */
export function emptyExploreUsage(): ExploreUsage {
  return { runs: 0, tokens: 0, windowStart: "" };
}

/** Детерминированный FNV-1a в [0, 1) — без Math.random, воспроизводим в тестах. */
export function exploreUnitInterval(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/**
 * EV-2.3: ε-greedy выбор между локальным и внешним исполнителем.
 * Жёсткая граница: лимит запусков/токенов → `review` (circuit-breaker),
 * подход к границе → даунгрейд на локального исполнителя. Ключ seed'а
 * детерминирован: одинаковыйtaskType и расход дают одинаковый выбор.
 */
export function decideExploreBandit(
  taskType: string,
  capability: CapabilityLearningRecord | null,
  usage: ExploreUsage,
  config: ExploreBudgetConfig = {},
): ExploreBanditDecision {
  const key = requireTaskType(taskType);
  const budget = normalizeExploreBudget(config);
  const runs = Math.max(0, Math.floor(Number(usage?.runs) || 0));
  const tokens = Math.max(0, Math.floor(Number(usage?.tokens) || 0));
  const limit = Math.max(1, Math.min(budget.maxRuns, budget.windowRuns));
  const remainingRuns = Math.max(0, limit - runs);
  const reliable = capability?.taskType === key ? capability.effectiveSuccessRate : 0.5;
  const localReward = Math.min(1, Math.max(0, reliable));
  const cloudReward = capability?.taskType === key ? 1 - localReward : 0.5;
  const base = { taskType: key, localReward, cloudReward, remainingRuns };

  if (!budget.enabled) {
    return { ...base, target: "local", reason: "explore-budget-disabled", exploration: false, nearLimit: false };
  }
  if (tokens >= budget.maxTokens) {
    return { ...base, target: "review", reason: "explore-token-budget-exhausted", exploration: false, nearLimit: true };
  }
  if (runs >= limit) {
    return { ...base, target: "review", reason: "explore-budget-exhausted", exploration: false, nearLimit: true };
  }
  if (remainingRuns <= budget.nearLimitRuns) {
    return { ...base, target: "local", reason: "explore-budget-near-limit", exploration: false, nearLimit: true };
  }

  const greedyTarget: ExploreBanditTarget = localReward >= cloudReward ? "local" : "cloud";
  const roll = exploreUnitInterval(`${key}:${runs}`);
  if (roll < budget.epsilon) {
    const sampled: ExploreBanditTarget = greedyTarget === "local" ? "cloud" : "local";
    return { ...base, target: sampled, reason: "explore-bandit-sample", exploration: true, nearLimit: false };
  }
  return { ...base, target: greedyTarget, reason: "explore-bandit-greedy", exploration: true, nearLimit: false };
}
