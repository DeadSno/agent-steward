import { getDb } from "./index.js";
import type { TaskStatus } from "../history.js";

/**
 * Агрегированные метрики по задачам.
 *
 * Помимо обычных задач в таблице могут лежать служебные строки:
 *  - `__global__` — вызовы старого appendMetric() без имени задачи;
 *  - `__legacy__` — «хвост» metrics.json, не попавший в историю (она хранила
 *    только 200 записей).
 * Такие строки не показываются в списке задач, но входят в общие итоги.
 */

export interface TaskMetricsRow {
  taskName: string;
  total: number;
  success: number;
  error: number;
  /** Частичные выполнения: ответ получен, но post-flight/quality gate не прошёл. */
  partial: number;
  tokens: number;
  costUsd: number;
}

export interface MetricsTotals {
  total: number;
  success: number;
  /** Реальные отказы (error/timeout/неизвестный статус) без прерванных и пропусков. */
  error: number;
  /** Пропуски (status=skipped) — не падения. */
  skipped: number;
  /** Прерванные crash recovery (error с текстом «Прервано …»). */
  interrupted: number;
  partial: number;
  tokens: number;
  costUsd: number;
}

const GLOBAL_TASK = "__global__";
export const LEGACY_METRICS_TASK = "__legacy__";

export function isInternalTaskName(taskName: string): boolean {
  return taskName.startsWith("__");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowToMetrics(input: unknown): TaskMetricsRow {
  if (!isRecord(input)) {
    throw new Error("Некорректная строка метрик");
  }
  const row = input;
  return {
    taskName: String(row.task_name),
    total: Number(row.total) || 0,
    success: Number(row.success) || 0,
    error: Number(row.error) || 0,
    partial: Number(row.partial) || 0,
    tokens: Number(row.total_tokens) || 0,
    costUsd: Number(row.total_cost) || 0,
  };
}

/** Инкремент метрик без собственной транзакции (для использования внутри recordRun). */
export function incrementMetricsUnsafe(
  taskName: string,
  status: TaskStatus,
  tokens = 0,
  costUsd = 0,
): void {
  // error — только ошибки и таймауты; partial и skipped хранятся отдельно
  // (skipped увеличивает только total: запуск не расходовал токены и не завершился).
  const success = status === "success" ? 1 : 0;
  const partial = status === "partial" ? 1 : 0;
  const error = status === "error" || status === "timeout" ? 1 : 0;
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  const safeCost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;

  getDb()
    .prepare(
      `INSERT INTO metrics (task_name, total, success, error, partial, total_tokens, total_cost)
       VALUES (?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(task_name) DO UPDATE SET
         total = total + 1,
         success = success + excluded.success,
         error = error + excluded.error,
         partial = partial + excluded.partial,
         total_tokens = total_tokens + excluded.total_tokens,
         total_cost = total_cost + excluded.total_cost`,
    )
    .run(taskName, success, error, partial, safeTokens, safeCost);
}

/** Атомарно увеличивает счётчики задачи: +1 запуск, +1 success/error, токены, стоимость. */
export function incrementMetrics(
  taskName: string,
  status: TaskStatus,
  tokens?: number,
  costUsd?: number,
): void {
  incrementMetricsUnsafe(taskName, status, tokens, costUsd);
}

/** Метрики одной задачи (нули, если задача ещё не запускалась). */
export function getMetrics(taskName: string): TaskMetricsRow {
  const row: unknown = getDb()
    .prepare("SELECT * FROM metrics WHERE lower(task_name) = lower(?) LIMIT 1")
    .get(taskName);
  if (!row) {
    return { taskName, total: 0, success: 0, error: 0, partial: 0, tokens: 0, costUsd: 0 };
  }
  return rowToMetrics(row);
}

/** Метрики всех реальных задач (служебные строки исключены). */
export function getAllMetrics(includeInternal = false): TaskMetricsRow[] {
  const rows: unknown[] = getDb()
    .prepare("SELECT * FROM metrics ORDER BY task_name COLLATE NOCASE ASC")
    .all();
  return rows.map(rowToMetrics).filter((row) => includeInternal || !isInternalTaskName(row.taskName));
}

/**
 * Суммарные метрики по единой выборке истории (QA-P1.1).
 *
 * Раньше итоги брались из таблицы metrics. Но crash recovery помечает
 * незавершённые запуски прямо в history (UPDATE ... status='error') без
 * инкремента metrics, поэтому get_metrics расходился с analytics и
 * self_analysis на число прерванных запусков. Теперь все три источника
 * считают по одной и той же истории: success/partial явные, всё остальное
 * (error/timeout/skipped) — error, running не участвует.
 *
 * Примечание: поточечные метрики	getMetrics()/getAllMetrics() остаются
 * таблицей metrics — там хранится в том числе legacy-хвост без истории.
 */
export function getTotals(includeInternal = false): MetricsTotals {
  // PL-37: служебные задачи (__*), используемые тестами/пробами, не должны
  // попадать в агрегированные метрики — getAllMetrics их уже фильтрует.
  const internalFilter = includeInternal ? "" : "AND task_name NOT LIKE '\\_\\_%' ESCAPE '\\'";
  const row: unknown = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0) AS partial,
         COALESCE(SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped,
          COALESCE(SUM(CASE WHEN status NOT IN ('success', 'partial', 'running', 'skipped')
                             AND COALESCE(error, '') NOT LIKE '%Прервано%' THEN 1 ELSE 0 END), 0) AS error,
          COALESCE(SUM(CASE WHEN status NOT IN ('success', 'partial', 'running', 'skipped')
                             AND COALESCE(error, '') LIKE '%Прервано%' THEN 1 ELSE 0 END), 0) AS interrupted,
         COALESCE(SUM(CASE WHEN tokens > 0 THEN CAST(tokens AS INTEGER) ELSE 0 END), 0) AS tokens,
         COALESCE(SUM(CASE WHEN cost_usd > 0 THEN cost_usd ELSE 0 END), 0) AS cost_usd
       FROM history
       WHERE status <> 'running' ${internalFilter}`,
    )
    .get();
  const totals = isRecord(row) ? row : undefined;
  return {
    total: Number(totals?.total) || 0,
    success: Number(totals?.success) || 0,
    error: Number(totals?.error) || 0,
    skipped: Number(totals?.skipped) || 0,
    interrupted: Number(totals?.interrupted) || 0,
    partial: Number(totals?.partial) || 0,
    tokens: Number(totals?.tokens) || 0,
    costUsd: Number(totals?.cost_usd) || 0,
  };
}

/** Старый appendMetric(status) без имени задачи. */
export function incrementGlobalMetrics(status: TaskStatus): void {
  incrementMetricsUnsafe(GLOBAL_TASK, status);
}

/** Прямая запись строки метрик — используется миграцией. */
export function upsertMetricsRow(row: TaskMetricsRow): void {
  getDb()
    .prepare(
      `INSERT INTO metrics (task_name, total, success, error, partial, total_tokens, total_cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_name) DO UPDATE SET
         total = excluded.total,
         success = excluded.success,
         error = excluded.error,
         partial = excluded.partial,
         total_tokens = excluded.total_tokens,
         total_cost = excluded.total_cost`,
    )
    .run(
      row.taskName,
      Math.max(0, Math.floor(row.total)),
      Math.max(0, Math.floor(row.success)),
      Math.max(0, Math.floor(row.error)),
      Math.max(0, Math.floor(row.partial)),
      Math.max(0, Math.floor(row.tokens)),
      Math.max(0, row.costUsd),
    );
}

/** Количество строк метрик. */
export function countMetrics(): number {
  const row: unknown = getDb().prepare("SELECT COUNT(*) AS count FROM metrics").get();
  return Number(isRecord(row) ? row.count : 0) || 0;
}
