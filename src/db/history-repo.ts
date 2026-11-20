import { getDb, withTransaction } from "./index.js";
import { incrementMetricsUnsafe } from "./metrics-repo.js";
import { appendStructuredLog } from "../core/structured-log.js";
import os from "node:os";
import type { TaskStatus } from "../history.js";

/**
 * История запусков.
 *
 * completed-запись пишется одной транзакцией вместе с инкрементом метрик.
 * Незавершённые запуски (finished_at IS NULL) при старте помечаются как error
 * в crash recovery.
 */

export type HistoryStatus = TaskStatus | "running";

/**
 * QA-P1.5: прочерк и пустая строка — не текст ошибки, а маркер «нет данных».
 * PowerShell-обёртка исторически передавала "-" для успешных запусков, и он
 * попадал в history и структурированные логи как сообщение об ошибке.
 * Нормализуем и при записи, и при чтении (легаси-записи уже есть в БД).
 */
export function normalizeErrorText(error: string | null | undefined): string | null {
  if (error == null) return null;
  const trimmed = String(error).trim();
  return !trimmed || trimmed === "-" ? null : trimmed;
}

export interface StoredHistoryRecord {
  id?: number;
  taskName: string;
  status: HistoryStatus;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  preFlightStatus?: "success" | "error" | "skipped";
  postFlightStatus?: "success" | "error" | "skipped";
  workspaceId?: string | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  /** Владелец незавершённого запуска (схема v8). */
  ownerPid?: number | null;
  ownerHost?: string | null;
  ownerStartedAt?: string | null;
}

/** Поля, которые пишутся в history при завершении запуска. */
export interface RunResult {
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  durationMs: number;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  preFlightStatus?: "success" | "error" | "skipped";
  postFlightStatus?: "success" | "error" | "skipped";
  finishedAt?: string;
}

function rowToRecord(row: any): StoredHistoryRecord {
  const status = String(row.status) as HistoryStatus;
  return {
    id: Number(row.id),
    taskName: String(row.task_name),
    status,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: normalizeErrorText(row.error == null ? null : String(row.error)),
    nextTask: row.next_task == null ? null : String(row.next_task),
    tokens: row.tokens == null ? undefined : Number(row.tokens),
    costUsd: row.cost_usd == null ? undefined : Number(row.cost_usd),
    model: row.model == null ? undefined : String(row.model),
    preFlightStatus:
      row.pre_flight_status == null
        ? undefined
        : (String(row.pre_flight_status) as "success" | "error" | "skipped"),
    postFlightStatus:
      row.post_flight_status == null
        ? undefined
        : (String(row.post_flight_status) as "success" | "error" | "skipped"),
    workspaceId: row.workspace_id == null ? null : String(row.workspace_id),
    allowedTools: row.allowed_tools == null ? null : JSON.parse(String(row.allowed_tools)),
    deniedTools: row.denied_tools == null ? null : JSON.parse(String(row.denied_tools)),
    ownerPid: row.owner_pid == null ? null : Number(row.owner_pid),
    ownerHost: row.owner_host == null ? null : String(row.owner_host),
    ownerStartedAt: row.owner_started_at == null ? null : String(row.owner_started_at),
  };
}

const INSERT_SQL = `INSERT INTO history (
  task_name, status, started_at, finished_at, duration_ms, error,
  tokens, cost_usd, model, pre_flight_status, post_flight_status, next_task,
  workspace_id, allowed_tools, denied_tools, owner_pid, owner_host, owner_started_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function lastId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid) || 0;
}

/** Вставляет запись истории без инкремента метрик (совместимость с appendHistory). */
export function insertHistory(record: StoredHistoryRecord): number {
  const result = getDb()
    .prepare(INSERT_SQL)
    .run(
      record.taskName,
      record.status,
      record.startedAt,
      record.finishedAt ?? null,
      record.durationMs ?? null,
      normalizeErrorText(record.error),
      record.tokens ?? null,
      record.costUsd ?? null,
      record.model ?? null,
      record.preFlightStatus ?? null,
      record.postFlightStatus ?? null,
      record.nextTask ?? null,
      record.workspaceId ?? null,
      record.allowedTools == null ? null : JSON.stringify(record.allowedTools),
      record.deniedTools == null ? null : JSON.stringify(record.deniedTools),
      record.ownerPid ?? null,
      record.ownerHost ?? null,
      record.ownerStartedAt ?? null,
    );
  return lastId(result);
}

/** Начало запуска: строка с finished_at = NULL (переживёт сбой процесса). */
export function startRun(
  taskName: string,
  startedAt = new Date().toISOString(),
  workspaceId?: string | null,
  allowedTools?: string[] | null,
  deniedTools?: string[] | null,
  owner?: { pid?: number | null; host?: string | null; startedAt?: string | null },
): number {
  const id = insertHistory({
    taskName,
    status: "running",
    startedAt,
    finishedAt: null,
    workspaceId,
    allowedTools,
    deniedTools,
    ownerPid: owner?.pid ?? null,
    ownerHost: owner?.host ?? null,
    ownerStartedAt: owner?.startedAt ?? null,
  });
  appendStructuredLog({
    event: "run.started",
    runId: id,
    task: taskName,
    status: "running",
    startedAt,
    workspaceId: workspaceId ?? null,
    source: "startRun",
  });
  return id;
}

/**
 * Завершает ранее начатый запуск и инкрементирует метрики.
 * Возвращает false, если запись уже завершена/не найдена (защита от двойного учёта).
 */
export function finishRun(
  id: number,
  status: TaskStatus,
  durationMs: number,
  error?: string | null,
  nextTask?: string | null,
  tokens?: number,
  costUsd?: number,
  model?: string,
  preFlightStatus?: "success" | "error" | "skipped",
  postFlightStatus?: "success" | "error" | "skipped",
): boolean {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs)) : 0;
  const finishedAt = new Date().toISOString();
  const cleanError = normalizeErrorText(error);
  let completed: { taskName: string; startedAt: string } | null = null;

  const ok = withTransaction(() => {
    const instance = getDb();
    const row = instance
      .prepare("SELECT finished_at FROM history WHERE id = ?")
      .get(id);
    if (!row || row.finished_at != null) return false;

    instance
      .prepare(
        `UPDATE history SET
           status = ?, finished_at = ?, duration_ms = ?, error = ?, next_task = ?,
           tokens = ?, cost_usd = ?, model = ?,
           pre_flight_status = ?, post_flight_status = ?
         WHERE id = ?`,
      )
      .run(
        status,
        finishedAt,
        safeDuration,
        cleanError,
        nextTask ?? null,
        tokens ?? null,
        costUsd ?? null,
        model ?? null,
        preFlightStatus ?? null,
        postFlightStatus ?? null,
        id,
      );

    const taskRow = instance
      .prepare("SELECT task_name, started_at FROM history WHERE id = ?")
      .get(id);
    incrementMetricsUnsafe(String(taskRow.task_name), status, tokens, costUsd);
    completed = {
      taskName: String(taskRow.task_name),
      startedAt: String(taskRow.started_at),
    };
    return true;
  });

  if (ok && completed) {
    const done = completed as { taskName: string; startedAt: string };
    appendStructuredLog({
      event: "run.finished",
      runId: id,
      task: done.taskName,
      status,
      startedAt: done.startedAt,
      finishedAt,
      durationMs: safeDuration,
      error: cleanError,
      nextTask: nextTask ?? null,
      tokens,
      costUsd,
      model,
      preFlightStatus,
      postFlightStatus,
    });
  }
  return ok;
}

/**
 * Записывает завершённый запуск: history + metrics в одной транзакции.
 * Заменяет старый recordTaskRun/recordRun.
 */
export function recordRun(
  taskName: string,
  status: TaskStatus,
  startedAt: string,
  durationMs: number,
  error?: string | null,
  nextTask?: string | null,
  tokens?: number,
  costUsd?: number,
  model?: string,
  preFlightStatus?: "success" | "error" | "skipped",
  postFlightStatus?: "success" | "error" | "skipped",
  finishedAt = new Date().toISOString(),
  workspaceId?: string | null,
  allowedTools?: string[] | null,
  deniedTools?: string[] | null,
): number {
  const safeDuration = Math.max(0, Math.floor(Number(durationMs) || 0));
  const cleanError = normalizeErrorText(error);
  const id = withTransaction(() => {
    const result = getDb()
      .prepare(INSERT_SQL)
      .run(
        taskName,
        status,
        startedAt,
        finishedAt,
        safeDuration,
        cleanError,
        tokens ?? null,
        costUsd ?? null,
        model ?? null,
        preFlightStatus ?? null,
        postFlightStatus ?? null,
        nextTask ?? null,
        workspaceId ?? null,
        allowedTools == null ? null : JSON.stringify(allowedTools),
        deniedTools == null ? null : JSON.stringify(deniedTools),
        // owner-колонки относятся только к незавершённым запускам (startRun).
        null,
        null,
        null,
      );
    incrementMetricsUnsafe(taskName, status, tokens, costUsd);
    return lastId(result);
  });

  appendStructuredLog({
    event: "run.finished",
    runId: id,
    task: taskName,
    status,
    startedAt,
    finishedAt,
    durationMs: safeDuration,
    error: cleanError,
    nextTask: nextTask ?? null,
    tokens,
    costUsd,
    model,
    workspaceId: workspaceId ?? null,
    preFlightStatus,
    postFlightStatus,
  });
  return id;
}

/** История запусков (новые сверху). Без taskName — по всем задачам. */
export function getHistory(
  taskName?: string | null,
  limit = 200,
  status?: string | null,
): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const clauses: string[] = [];
  const params: any[] = [];
  if (taskName) {
    clauses.push("lower(task_name) = lower(?)");
    params.push(taskName);
  }
  if (status) {
    const normalizedStatus = status.trim().toLowerCase();
    // loadHistory() отдаёт незавершённые записи (running) как error — сохраняем
    // это поведение и при фильтрации на уровне SQLite.
    if (normalizedStatus === "running") {
      return [];
    }
    if (normalizedStatus === "error") {
      clauses.push("lower(status) IN ('error', 'running')");
    } else {
      clauses.push("lower(status) = lower(?)");
      params.push(normalizedStatus);
    }
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  params.push(safeLimit);
  const rows = getDb()
    .prepare(
      `SELECT * FROM history${where}
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...params);
  return rows.map(rowToRecord);
}

/**
 * История для проверки бюджетов: записи, учётный момент которых
 * (`finished_at`, при отсутствии `started_at`) не раньше `periodStart`.
 *
 * В отличие от `getHistorySince()` учитывает запуски, начатые в предыдущем
 * периоде, но завершённые в текущем — именно по ним считается расход в
 * `src/core/budget.ts`. Лимит 100000 совпадает с максимумом `getHistory`.
 */
export function getHistoryForBudget(
  periodStart: string,
  limit = 100000,
): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const rows = getDb()
    .prepare(
      `SELECT * FROM history
       WHERE COALESCE(finished_at, started_at) >= ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(periodStart, safeLimit);
  return rows.map(rowToRecord);
}

/**
 * Последняя запись по каждой задаче (P2-29).
 *
 * DAG-зависимости нельзя проверять по «последним N записям»: на частой задаче
 * успех зависимости вымывается из окна, и зависимая задача не стартует.
 * Здесь SQL сам выбирает по одной самой свежей записи на задачу.
 */
export function getLatestHistoryByTask(limit = 5000): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const rows = getDb()
    .prepare(
      `SELECT * FROM history
       WHERE id IN (
         SELECT MAX(id) FROM history GROUP BY lower(task_name)
       )
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(safeLimit);
  return rows.map(rowToRecord);
}

/**
 * История для аналитики за окно `days` дней: все запуски, которые могут
 * попасть в период по времени начала. Окно на один день шире запрашиваемого,
 * чтобы полностью покрыть самый ранний UTC-день (buildAnalytics всё равно
 * отфильтрует лишнее по дате). Лимит 100000 снимает потолок в 20000 записей,
 * из-за которого отчёты за 365 дней молча недосчитывали запуски и расход.
 */
export function getHistoryForAnalytics(
  days: number,
  now: Date = new Date(),
): StoredHistoryRecord[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days) || 1));
  const since = new Date(now.getTime() - (safeDays + 1) * 24 * 60 * 60 * 1000);
  return getHistorySince(since.toISOString(), 100000);
}

/** История запусков, начатых не раньше timestamp (ISO-строка). */
export function getHistorySince(
  timestamp: string,
  limit = 5000,
): StoredHistoryRecord[] {
  const safeLimit = Math.max(1, Math.min(100000, Math.floor(limit) || 1));
  const rows = getDb()
    .prepare(
      `SELECT * FROM history
       WHERE started_at >= ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(timestamp, safeLimit);
  return rows.map(rowToRecord);
}

/**
 * Crash recovery для истории.
 *
 * Незавершённая запись (finished_at IS NULL) финализируется как error, только
 * если её владелец больше не может её завершить:
 *  - владелец известен, жив и на этом же хосте → запись оставляем (B1);
 *  - владелец известен и мёртв → финализируем сразу;
 *  - владелец неизвестен (legacy-строка или другой хост) → финализируем,
 *    только когда запись старше `maxUnverifiableAgeMs`.
 */

/** Возраст, после которого запись с непроверяемым владельцем считается осиротевшей. */
export const UNVERIFIABLE_OWNER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RecoverInterruptedResult {
  /** Сколько записей финализировано как error. */
  recovered: number;
  /** Сколько записей оставлено живым владельцам. */
  keptAlive: number;
}

export interface RecoverInterruptedOptions {
  /** Текущий момент (для тестов). */
  now?: Date;
  /** Порог возраста для записей с непроверяемым владельцем. */
  maxUnverifiableAgeMs?: number;
  /** Имя текущего хоста (для тестов). */
  hostname?: string;
  /** Проверка живости PID (для тестов). */
  isAlive?: (pid: number) => boolean;
}

/** Проверяет существование процесса: signal 0 не убивает, только пробует. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM — процесс существует, но сигнал запрещён; ESRCH — процесса нет.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function recoverInterrupted(
  options: RecoverInterruptedOptions = {},
): RecoverInterruptedResult {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const maxAge =
    typeof options.maxUnverifiableAgeMs === "number" &&
    Number.isFinite(options.maxUnverifiableAgeMs)
      ? Math.max(0, options.maxUnverifiableAgeMs)
      : UNVERIFIABLE_OWNER_MAX_AGE_MS;
  const hostname = options.hostname ?? os.hostname();
  const isAlive = options.isAlive ?? isProcessAlive;
  const db = getDb();
  interface InterruptedHistoryRow {
    id: number;
    started_at: string | null;
    owner_pid: number | null;
    owner_host: string | null;
    owner_started_at: string | null;
  }
  const rows = db
    .prepare(
      `SELECT id, started_at, owner_pid, owner_host, owner_started_at
       FROM history WHERE finished_at IS NULL`,
    )
    .all() as unknown as InterruptedHistoryRow[];
  const update = db.prepare(
    `UPDATE history SET
       status = 'error',
       error = CASE
         WHEN error IS NULL OR error = '' THEN 'Прервано (сбой/перезагрузка)'
         ELSE error
       END,
       finished_at = COALESCE(finished_at, ?),
       duration_ms = COALESCE(
         duration_ms,
         CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)
       )
     WHERE id = ? AND finished_at IS NULL`,
  );

  let recovered = 0;
  let keptAlive = 0;
  withTransaction(() => {
    for (const row of rows) {
      const ownerPid = row.owner_pid == null ? null : Number(row.owner_pid);
      const ownerHost = row.owner_host == null ? null : String(row.owner_host);
      const verifiable =
        ownerPid != null && ownerPid > 0 && ownerHost != null && ownerHost === hostname;

      if (verifiable && ownerPid != null && isAlive(ownerPid)) {
        keptAlive += 1;
        continue;
      }
      if (!verifiable) {
        const since = Date.parse(String(row.owner_started_at ?? row.started_at ?? ""));
        const age = Number.isFinite(since) ? now.getTime() - since : Infinity;
        if (age < maxAge) {
          keptAlive += 1;
          continue;
        }
      }

      const result = update.run(nowIso, nowIso, row.id);
      if (Number(result.changes) > 0) recovered += 1;
    }
  });
  return { recovered, keptAlive };
}

/** Количество записей истории (для миграции и тестов). */
export function countHistory(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS count FROM history").get();
  return Number(row?.count) || 0;
}

/** Число активных (незавершённых) запусков: глубина очереди для /api/health. */
export function countRunningRecords(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS count FROM history WHERE finished_at IS NULL")
    .get();
  return Number(row?.count) || 0;
}

/** Запись о незавершённом запуске — для детектора зависших матриц (Спринт 20). */
export interface RunningHistoryRecord {
  id: number;
  taskName: string;
  startedAt: string;
}

/** Список активных запусков (finished_at IS NULL), самые старые сверху. */
export function listRunningRecords(): RunningHistoryRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, task_name, started_at FROM history
       WHERE finished_at IS NULL
       ORDER BY started_at ASC, id ASC`,
    )
    .all();
  return rows.map((row) => ({
    id: Number(row.id) || 0,
    taskName: String(row.task_name ?? ""),
    startedAt: String(row.started_at ?? ""),
  }));
}

/** Параметры очистки истории (Спринт 18). 0 — ограничение выключено. */
export interface PruneHistoryOptions {
  /** Удалять завершённые записи старше N дней. */
  retentionDays?: number;
  /** Оставить не более N последних записей. */
  maxRecords?: number;
  /** Опорный момент времени (для тестов). */
  now?: Date;
}

export interface PruneHistoryResult {
  deletedByAge: number;
  deletedByCount: number;
  deleted: number;
  kept: number;
  /** Граница по возрасту (ISO) или null, если возраст не ограничивали. */
  cutoff: string | null;
}

/**
 * Чистит сырую историю: по возрасту и/или по количеству записей.
 *
 * Незавершённые запуски (`finished_at IS NULL`) не удаляются никогда — их
 * обрабатывает crash recovery. Агрегаты в таблице metrics не трогаются:
 * ретеншн чистит детали, а не статистику.
 */
export function pruneHistory(options: PruneHistoryOptions = {}): PruneHistoryResult {
  const instance = getDb();
  const now = options.now ?? new Date();
  let deletedByAge = 0;
  let deletedByCount = 0;
  let cutoff: string | null = null;

  const days = Number(options.retentionDays ?? 0);
  if (Number.isFinite(days) && days > 0) {
    cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = instance
      .prepare(
        `DELETE FROM history
         WHERE finished_at IS NOT NULL AND finished_at < ?`,
      )
      .run(cutoff);
    deletedByAge = Number(result.changes) || 0;
  }

  const maxRecords = Number(options.maxRecords ?? 0);
  if (Number.isFinite(maxRecords) && maxRecords > 0) {
    const result = instance
      .prepare(
        `DELETE FROM history
         WHERE finished_at IS NOT NULL
           AND id NOT IN (
             SELECT id FROM history
             WHERE finished_at IS NOT NULL
             ORDER BY started_at DESC, id DESC
             LIMIT ?
           )`,
      )
      .run(Math.max(0, Math.floor(maxRecords)));
    deletedByCount = Number(result.changes) || 0;
  }

  return {
    deletedByAge,
    deletedByCount,
    deleted: deletedByAge + deletedByCount,
    kept: countHistory(),
    cutoff,
  };
}

/**
 * Освобождает место после массового удаления. `PRAGMA incremental_vacuum`
 * работает только при auto_vacuum = INCREMENTAL; иначе это no-op, поэтому
 * вызов безопасен и не требует проверки режима.
 */
export function vacuumHistory(): boolean {
  try {
    getDb().exec("PRAGMA incremental_vacuum");
    return true;
  } catch {
    return false;
  }
}
