import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "./index.js";
import {
  getRun,
  getStep,
  reopenRun,
  retryStep,
  startRun,
  type RunRecord,
  type RunStepRecord,
} from "./runs-repo.js";

/**
 * Dead-letter queue для durable DAG (Спринт 36.4).
 *
 * DLQ — это не «ещё одна таблица истории», а рабочая очередь: сюда попадают
 * шаги, которые упали не случайно, а исчерпали попытки (по умолчанию три).
 * Дальше человек либо повторяет шаг вручную, либо осознанно отказывается от
 * него — в обоих случаях запись закрывается и больше не висит в очереди.
 *
 * Запись создаётся идемпотентно: на один шаг может быть только одна открытая
 * запись (`idx_run_dlq_open_unique`), поэтому повторный скан не плодит дубли,
 * а ручной retry не оставляет «фантомную» открытую запись.
 */

/** Статусы записи DLQ: open → retried/discarded. */
export type DlqStatus = "open" | "retried" | "discarded";

/** Почему шаг попал в DLQ. */
export type DlqReason = "attempts-exhausted" | "manual";

/** Сколько попыток считается детерминированным падением по умолчанию. */
export const DEFAULT_DLQ_MIN_ATTEMPTS = 3;

export interface DlqEntry {
  id: string;
  runId: string;
  stepName: string;
  status: DlqStatus;
  reason: DlqReason | string | null;
  error: string | null;
  /** Номер попытки на момент постановки в очередь. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Что сделали с записью: manual-retry, discarded и т.п. */
  resolution: string | null;
}

export interface EnqueueResult {
  entry: DlqEntry;
  /** false, если открытая запись на этот шаг уже была. */
  created: boolean;
}

export interface ScanOptions {
  /** Ограничить скан одним запуском. */
  runId?: string | null;
  /** Порог попыток; по умолчанию {@link DEFAULT_DLQ_MIN_ATTEMPTS}. */
  minAttempts?: number;
  /** Максимум шагов за один скан. */
  limit?: number;
}

export interface ListDlqOptions {
  /** open (по умолчанию), конкретный статус или все записи. */
  status?: DlqStatus | "all";
  limit?: number;
}

export interface RetryDeadLetterResult {
  entry: DlqEntry;
  step: RunStepRecord;
  run: RunRecord;
  /** true, если запуск был в failed и его пришлось переоткрыть. */
  runReopened: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  const value = Math.floor(limit ?? fallback);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(10000, value);
}

function dlqRowToEntry(row: Record<string, unknown>): DlqEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepName: String(row.step_name),
    status: String(row.status) as DlqStatus,
    reason: row.reason == null ? null : String(row.reason),
    error: row.error == null ? null : String(row.error),
    attempts: Number(row.attempts) || 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolution: row.resolution == null ? null : String(row.resolution),
  };
}

/** Шаг исчерпал попытки и больше не будет повторён автоматически? */
export function isDeadLetterStep(
  step: Pick<RunStepRecord, "status" | "attempt">,
  minAttempts = DEFAULT_DLQ_MIN_ATTEMPTS,
): boolean {
  const threshold = Math.max(1, Math.floor(minAttempts) || DEFAULT_DLQ_MIN_ATTEMPTS);
  return step.status === "failed" && step.attempt >= threshold;
}

/** Открытая запись DLQ на конкретный шаг (или undefined). */
export function findOpenDeadLetter(runId: string, stepName: string): DlqEntry | undefined {
  const row = getDb()
    .prepare("SELECT * FROM run_dlq WHERE run_id = ? AND step_name = ? AND status = 'open' LIMIT 1")
    .get(runId, stepName);
  return row ? dlqRowToEntry(row) : undefined;
}

/**
 * Ставит шаг в DLQ. Идемпотентно: если открытая запись уже есть, возвращает её
 * с `created: false`. Ошибка шага сохраняется как снимок на момент постановки.
 */
export function enqueueDeadLetter(
  runId: string,
  stepName: string,
  options: { reason?: DlqReason; error?: string | null; attempts?: number } = {},
): EnqueueResult {
  return withTransaction(() => {
    const existing = findOpenDeadLetter(runId, stepName);
    if (existing) return { entry: existing, created: false };

    const step = getStep(runId, stepName);
    if (!step) {
      throw new Error(`Шаг не найден: ${runId}/${stepName}`);
    }

    const id = `dlq_${randomUUID()}`;
    const timestamp = nowIso();
    getDb()
      .prepare(
        `INSERT INTO run_dlq
           (id, run_id, step_name, status, reason, error, attempts, created_at, updated_at,
            resolved_at, resolution)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        runId,
        stepName,
        options.reason ?? "attempts-exhausted",
        options.error ?? step.error ?? null,
        Math.max(1, Math.floor(options.attempts ?? step.attempt) || 1),
        timestamp,
        timestamp,
      );

    return { entry: getDeadLetter(id)!, created: true };
  });
}

/**
 * Ищет детерминированно упавшие шаги и ставит их в очередь.
 *
 * Детерминированность здесь прагматичная: шаг в `failed` и `attempt` достиг
 * порога. Автоматические повторы уже не помогут — нужен человек.
 * Возвращает только новые записи, поэтому скан можно вызывать по расписанию.
 */
export function scanDeadLetters(options: ScanOptions = {}): DlqEntry[] {
  const minAttempts = Math.max(
    1,
    Math.floor(options.minAttempts ?? DEFAULT_DLQ_MIN_ATTEMPTS) || DEFAULT_DLQ_MIN_ATTEMPTS,
  );
  const limit = normalizeLimit(options.limit, 100);

  const params: unknown[] = [minAttempts];
  let where = "status = 'failed' AND attempt >= ?";
  if (options.runId) {
    where += " AND run_id = ?";
    params.push(options.runId);
  }
  params.push(limit);

  const rows = getDb()
    .prepare(
      `SELECT run_id, step_name FROM run_steps WHERE ${where}
       ORDER BY updated_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...params) as { run_id?: unknown; step_name?: unknown }[];

  const created: DlqEntry[] = [];
  for (const row of rows) {
    const result = enqueueDeadLetter(String(row.run_id), String(row.step_name));
    if (result.created) created.push(result.entry);
  }
  return created;
}

export function getDeadLetter(id: string): DlqEntry | undefined {
  const row = getDb().prepare("SELECT * FROM run_dlq WHERE id = ?").get(id);
  return row ? dlqRowToEntry(row) : undefined;
}

/** Записи очереди, новые сверху. По умолчанию — только открытые. */
export function listDeadLetters(options: ListDlqOptions = {}): DlqEntry[] {
  const limit = normalizeLimit(options.limit, 100);
  const status = options.status ?? "open";
  if (status === "all") {
    return getDb()
      .prepare("SELECT * FROM run_dlq ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map((row) => dlqRowToEntry(row));
  }
  return getDb()
    .prepare("SELECT * FROM run_dlq WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(status, limit)
    .map((row) => dlqRowToEntry(row));
}

/** Сколько записей в статусе (по умолчанию открытых). */
export function countDeadLetters(status: DlqStatus = "open"): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM run_dlq WHERE status = ?").get(status);
  return Number(row?.count) || 0;
}

/**
 * Ручной retry из DLQ.
 *
 * Готовит шаг к повторному выполнению: переоткрывает упавший запуск, переводит
 * шаг в `running` с `attempt + 1` и закрывает запись DLQ как `retried`.
 * Сам обработчик не вызывается — дальше шаг подхватывает `resumeRun`.
 */
export function retryDeadLetter(
  id: string,
  options: { startedAt?: string } = {},
): RetryDeadLetterResult {
  return withTransaction(() => {
    const entry = getDeadLetter(id);
    if (!entry) throw new Error(`Запись DLQ не найдена: ${id}`);
    if (entry.status !== "open") {
      throw new Error(`Запись DLQ уже обработана: ${entry.status}`);
    }

    const run = getRun(entry.runId);
    if (!run) throw new Error(`Запуск не найден: ${entry.runId}`);

    const step = getStep(entry.runId, entry.stepName);
    if (!step) throw new Error(`Шаг не найден: ${entry.runId}/${entry.stepName}`);
    if (step.status !== "failed") {
      throw new Error(`Шаг ${entry.stepName} в статусе ${step.status}, повтор невозможен`);
    }

    let runReopened = false;
    if (run.status === "failed") {
      reopenRun(run.id, options.startedAt);
      runReopened = true;
    } else if (run.status === "pending") {
      startRun(run.id, options.startedAt);
    } else if (run.status !== "running") {
      throw new Error(`Запуск ${run.id} в статусе ${run.status}, повтор невозможен`);
    }

    retryStep(step.id, options.startedAt);

    const timestamp = nowIso();
    getDb()
      .prepare(
        `UPDATE run_dlq SET status = 'retried', resolved_at = ?, resolution = 'manual-retry',
           updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, timestamp, id);

    return {
      entry: getDeadLetter(id)!,
      step: getStep(entry.runId, entry.stepName)!,
      run: getRun(run.id)!,
      runReopened,
    };
  });
}

/** Осознанный отказ: запись закрывается, шаг остаётся failed. */
export function discardDeadLetter(id: string, resolution = "discarded"): DlqEntry {
  return withTransaction(() => {
    const entry = getDeadLetter(id);
    if (!entry) throw new Error(`Запись DLQ не найдена: ${id}`);
    if (entry.status !== "open") {
      throw new Error(`Запись DLQ уже обработана: ${entry.status}`);
    }
    const timestamp = nowIso();
    getDb()
      .prepare(
        `UPDATE run_dlq SET status = 'discarded', resolved_at = ?, resolution = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(timestamp, resolution, timestamp, id);
    return getDeadLetter(id)!;
  });
}

/** Готова ли схема к работе с DLQ (таблица из миграции v5). */
export function isDlqReady(): boolean {
  const row = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_dlq'")
    .get();
  return Boolean(row);
}
