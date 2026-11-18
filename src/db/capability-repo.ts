import { normalizeTaskType } from "../core/router/rules.js";
import { getDb, withTransaction } from "./index.js";

/**
 * Capability Map — слой 2 роутера (Спринт 36.5.b).
 *
 * Таблица `capability_map` хранит, как исполнитель справлялся с типом задачи:
 * сколько запусков было, сколько прошло гейт, среднюю стоимость и время, а
 * также последние 10 исходов. Роутер читает карту и выбирает маршрут
 * (local / cloud / review) по порогам — без вызова модели, то есть 0 токенов
 * на само решение.
 *
 * Карта обучается на исходах гейта: каждый прогон шага вызывает
 * {@link recordCapabilityOutcome}, статистика обновляется скользящим средним.
 * Данных мало — карта честно говорит «не знаю» и отдаёт решение слою 3
 * (Explore-режим).
 */

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

export interface CapabilityRecord {
  taskType: string;
  /** Исполнитель, который последним обрабатывал тип задачи. */
  model: string;
  runsTotal: number;
  runsPassed: number;
  successRate: number;
  avgCostUsd: number;
  avgTimeMs: number;
  /** Последние исходы, старые слева, новые справа, максимум 10. */
  last10Runs: number[];
  createdAt: string;
  updatedAt: string;
}

/** Один исход гейта: пройден/провален + необязательные стоимость и время. */
export interface CapabilityOutcome {
  taskType: string;
  model?: string;
  passed: boolean;
  costUsd?: number;
  timeMs?: number;
}

export interface CapabilityThresholds {
  localSuccess?: number;
  cloudFailure?: number;
  minRuns?: number;
}

export interface CapabilityDecision {
  taskType: string;
  target: CapabilityTarget;
  /** Машиночитаемая причина: no-data | local-reliable | escalate | review. */
  reason: "no-data" | "local-reliable" | "escalate" | "review";
  successRate: number;
  runsTotal: number;
  capability: CapabilityRecord | null;
}

const DEFAULT_MODEL = "local";

function nowIso(): string {
  return new Date().toISOString();
}

function requireTaskType(taskType: string): string {
  if (typeof taskType !== "string" || taskType.trim() === "") {
    throw new Error("Пустой тип задачи: Capability Map требует непустой taskType.");
  }
  return normalizeTaskType(taskType);
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Некорректное значение ${field}: ожидалось неотрицательное число, получено ${value}.`);
  }
  return value;
}

function parseRecentRuns(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => value === 0 || value === 1)
      .slice(-RECENT_RUNS_LIMIT);
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): CapabilityRecord {
  const runsTotal = Number(row.runs_total) || 0;
  const runsPassed = Number(row.runs_passed) || 0;
  return {
    taskType: String(row.task_type),
    model: String(row.model ?? DEFAULT_MODEL),
    runsTotal,
    runsPassed,
    successRate: Number(row.success_rate) || (runsTotal > 0 ? runsPassed / runsTotal : 0),
    avgCostUsd: Number(row.avg_cost_usd) || 0,
    avgTimeMs: Number(row.avg_time_ms) || 0,
    last10Runs: parseRecentRuns(row.last_10_runs),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Читает статистику по типу задачи или `null`, если данных ещё нет. */
export function getCapability(taskType: string): CapabilityRecord | null {
  const key = requireTaskType(taskType);
  const row = getDb()
    .prepare("SELECT * FROM capability_map WHERE task_type = ?")
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/** Все известные типы задач, сначала самые надёжные. */
export function listCapabilities(limit = 100): CapabilityRecord[] {
  const capped = Math.max(1, Math.floor(limit));
  const rows = getDb()
    .prepare("SELECT * FROM capability_map ORDER BY success_rate DESC, runs_total DESC, task_type ASC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Записывает исход гейта и обновляет статистику скользящим средним.
 *
 * Возвращает актуальную запись карты — её же удобно логировать вместе с
 * решением роутера, чтобы видеть, на каких данных он остановился.
 */
export function recordCapabilityOutcome(outcome: CapabilityOutcome): CapabilityRecord {
  const key = requireTaskType(outcome.taskType);
  if (typeof outcome.passed !== "boolean") {
    throw new Error("Исход гейта должен быть boolean (passed).");
  }
  const cost = outcome.costUsd === undefined ? 0 : requireNonNegative(outcome.costUsd, "costUsd");
  const time = outcome.timeMs === undefined ? 0 : requireNonNegative(outcome.timeMs, "timeMs");
  const model = (outcome.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const passed = outcome.passed ? 1 : 0;

  return withTransaction(() => {
    const db = getDb();
    const timestamp = nowIso();
    const existing = getCapability(key);
    if (!existing) {
      db.prepare(
        `INSERT INTO capability_map (
           task_type, model, runs_total, runs_passed, success_rate,
           avg_cost_usd, avg_time_ms, last_10_runs, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key,
        model,
        passed,
        passed,
        cost,
        time,
        JSON.stringify([passed]),
        timestamp,
        timestamp,
      );
    } else {
      const runsTotal = existing.runsTotal + 1;
      const runsPassed = existing.runsPassed + passed;
      const avgCost = (existing.avgCostUsd * existing.runsTotal + cost) / runsTotal;
      const avgTime = (existing.avgTimeMs * existing.runsTotal + time) / runsTotal;
      const recent = [...existing.last10Runs, passed].slice(-RECENT_RUNS_LIMIT);
      db.prepare(
        `UPDATE capability_map
            SET model = ?, runs_total = ?, runs_passed = ?, success_rate = ?,
                avg_cost_usd = ?, avg_time_ms = ?, last_10_runs = ?, updated_at = ?
          WHERE task_type = ?`,
      ).run(
        model,
        runsTotal,
        runsPassed,
        runsPassed / runsTotal,
        avgCost,
        avgTime,
        JSON.stringify(recent),
        timestamp,
        key,
      );
    }
    const record = getCapability(key);
    if (!record) {
      throw new Error(`Capability Map: запись для ${key} не сохранилась.`);
    }
    return record;
  });
}

/**
 * Решение слоя 2 по порогам (0 токенов).
 *
 * - данных меньше `minRuns` → `explore` (решает слой 3);
 * - `success_rate ≥ 0.85` → `local`;
 * - `success_rate ≤ 0.30` → `cloud` (эскалация);
 * - между порогами → `review` (нужен человек или облачный ревьюер).
 */
export function decideCapabilityRoute(
  taskType: string,
  thresholds: CapabilityThresholds = {},
): CapabilityDecision {
  const key = requireTaskType(taskType);
  const localSuccess = thresholds.localSuccess ?? LOCAL_SUCCESS_THRESHOLD;
  const cloudFailure = thresholds.cloudFailure ?? CLOUD_FAILURE_THRESHOLD;
  const minRuns = thresholds.minRuns ?? MIN_RUNS_FOR_DECISION;
  if (localSuccess <= cloudFailure) {
    throw new Error("Порог localSuccess должен быть больше cloudFailure.");
  }

  const capability = getCapability(key);
  if (!capability || capability.runsTotal < minRuns) {
    return {
      taskType: key,
      target: "explore",
      reason: "no-data",
      successRate: capability?.successRate ?? 0,
      runsTotal: capability?.runsTotal ?? 0,
      capability,
    };
  }

  if (capability.successRate >= localSuccess) {
    return {
      taskType: key,
      target: "local",
      reason: "local-reliable",
      successRate: capability.successRate,
      runsTotal: capability.runsTotal,
      capability,
    };
  }

  if (capability.successRate <= cloudFailure) {
    return {
      taskType: key,
      target: "cloud",
      reason: "escalate",
      successRate: capability.successRate,
      runsTotal: capability.runsTotal,
      capability,
    };
  }

  return {
    taskType: key,
    target: "review",
    reason: "review",
    successRate: capability.successRate,
    runsTotal: capability.runsTotal,
    capability,
  };
}

/** Готова ли таблица карты (для диагностики и тестов миграции). */
export function isCapabilityMapReady(): boolean {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_map'")
    .all() as { name?: string }[];
  return rows.length > 0;
}
