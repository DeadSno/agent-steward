import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "./index.js";

/**
 * Репозиторий durable-состояния запуска (Спринт 36.1).
 *
 * `runs` — единица выполнения, `run_steps` — её шаги. Строки создаются до
 * старта работы и обновляются на каждом переходе, поэтому после сбоя процесса
 * можно понять, где именно остановился запуск (основа resume в 36.2).
 *
 * Переходы статусов проверяются здесь, а не в SQL: CHECK-ограничения в SQLite
 * пришлось бы переписывать при каждом новом статусе (например, DLQ в 36.4).
 */

/** Статусы запуска: pending → running → passed/failed; paused — пауза с контекстом (36.7). */
export type RunStatus = "pending" | "running" | "paused" | "passed" | "failed" | "cancelled";

/** Статусы шага: pending → running → passed/failed; skipped — осознанный пропуск. */
export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped";

/** Финальные статусы шага — из них нет переходов, кроме явного retry. */
const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  "passed",
  "failed",
  "skipped",
]);

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  // Из pending можно как стартовать, так и сразу поставить на паузу (36.7).
  pending: ["running", "paused", "cancelled"],
  // paused → running — явное возобновление; paused → passed — пауза после
  // последнего шага, когда продолжать уже нечего.
  running: ["paused", "passed", "failed", "cancelled"],
  paused: ["running", "passed", "cancelled"],
  passed: [],
  // failed → running — явное возобновление после краха (36.2), только через reopenRun.
  failed: ["running"],
  cancelled: [],
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["running", "failed", "skipped"],
  running: ["passed", "failed"],
  passed: [],
  failed: [],
  skipped: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly entity: "run" | "step",
    readonly from: string,
    readonly to: string,
  ) {
    super(`Недопустимый переход ${entity}: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export interface RunRecord {
  id: string;
  taskName: string;
  status: RunStatus;
  parentRunId: string | null;
  workspaceId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface RunStepRecord {
  id: string;
  runId: string;
  stepName: string;
  /** Порядок шага в линейной цепочке (0, 1, 2...). */
  position: number;
  status: StepStatus;
  attempt: number;
  /** Ключ идемпотентности (36.3); уникален в пределах запуска. */
  idempotencyKey: string | null;
  /** B12: идентификатор процесса-владельца шага (`host:pid:startedAt`). */
  ownerId: string | null;
  /** B12: момент, до которого владелец обязан продлить lease (ISO). */
  leaseUntil: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  output: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunOptions {
  /** Имя задачи; для ручного/DAG-запуска может быть синтетическим. */
  taskName: string;
  parentRunId?: string | null;
  workspaceId?: string | null;
  metadata?: unknown;
  /** Начальный статус; по умолчанию pending. */
  status?: Extract<RunStatus, "pending" | "running">;
  /** Момент старта; по умолчанию now, если статус running. */
  startedAt?: string;
  /** Шаги создаются в той же транзакции, что и запуск. */
  steps?: CreateStepOptions[];
}

export interface CreateStepOptions {
  stepName: string;
  idempotencyKey?: string | null;
  status?: StepStatus;
  /** Полезная нагрузка (JSON-сериализуемая). */
  output?: unknown;
}

export interface FinishOptions {
  error?: string | null;
  output?: unknown;
}

/** B12: владелец шага и срок его lease. */
export interface StepLease {
  ownerId: string;
  leaseUntil: string;
}

/**
 * QA-A2-T4: граница `node:sqlite`. Драйвер через `SqliteStatement.get()/all()`
 * возвращает `any`; в колонках runs/run_steps реально лежат только TEXT
 * (string), INTEGER (number|bigint) и SQL NULL. Сужаем `any` до `unknown`, затем
 * type guard-ом до `SqliteRow` — так каскад no-unsafe-* не расползается по файлу.
 */
type SqliteCell = string | number | bigint | null;
type SqliteRow = Record<string, SqliteCell>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSqliteRow(value: unknown): value is SqliteRow {
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (cell) =>
      cell === null ||
      typeof cell === "string" ||
      typeof cell === "number" ||
      typeof cell === "bigint",
  );
}

/** Строковое представление ячейки — то же, что давал `String(row.col)` раньше. */
function asText(cell: SqliteCell): string {
  if (cell === null) return "null";
  return typeof cell === "string" ? cell : String(cell);
}

/** Nullable TEXT-колонка: SQL NULL → null, иначе строковое представление. */
function nullableText(cell: SqliteCell): string | null {
  return cell === null ? null : asText(cell);
}

/** Одна строка результата или undefined (SELECT ... WHERE id = ?). */
function queryRow(sql: string, ...params: unknown[]): SqliteRow | undefined {
  const raw: unknown = getDb().prepare(sql).get(...params);
  return isSqliteRow(raw) ? raw : undefined;
}

/** Все строки результата (SELECT ... с several строками). */
function queryRows(sql: string, ...params: unknown[]): SqliteRow[] {
  const raw: unknown = getDb().prepare(sql).all(...params);
  return Array.isArray(raw) ? raw.filter(isSqliteRow) : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

/** JSON-колонка хранит текст (результат serializeJson) или SQL NULL. */
function parseJson(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function serializeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function runRowToRecord(row: SqliteRow): RunRecord {
  return {
    id: asText(row.id),
    taskName: asText(row.task_name),
    // Доменное приведение: значения приходят из CHECK-ограниченых наших же записей.
    status: asText(row.status) as RunStatus,
    parentRunId: nullableText(row.parent_run_id),
    workspaceId: nullableText(row.workspace_id),
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    error: nullableText(row.error),
    metadata: parseJson(nullableText(row.metadata_json)),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

function stepRowToRecord(row: SqliteRow): RunStepRecord {
  return {
    id: asText(row.id),
    runId: asText(row.run_id),
    stepName: asText(row.step_name),
    position: Number(row.position) || 0,
    // Доменное приведение: см. комментарий в runRowToRecord.
    status: asText(row.status) as StepStatus,
    attempt: Number(row.attempt) || 1,
    idempotencyKey: nullableText(row.idempotency_key),
    ownerId: nullableText(row.owner_id),
    leaseUntil: nullableText(row.lease_until),
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    error: nullableText(row.error),
    output: parseJson(nullableText(row.output_json)),
    createdAt: asText(row.created_at),
    updatedAt: asText(row.updated_at),
  };
}

function assertTransition(
  entity: "run" | "step",
  from: string,
  to: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(to)) throw new InvalidTransitionError(entity, from, to);
}

const INSERT_RUN_SQL = `INSERT INTO runs (
  id, task_name, status, parent_run_id, workspace_id,
  started_at, finished_at, error, metadata_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`;

const INSERT_STEP_SQL = `INSERT INTO run_steps (
  id, run_id, step_name, position, status, attempt, idempotency_key,
  started_at, finished_at, error, output_json, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`;

/** Создаёт запуск и (опционально) его шаги одной транзакцией. */
export function createRun(options: CreateRunOptions): RunRecord {
  const id = randomUUID();
  const timestamp = nowIso();
  const status: RunStatus = options.status ?? "pending";
  const startedAt =
    options.startedAt ?? (status === "running" ? timestamp : null);

  withTransaction(() => {
    getDb()
      .prepare(INSERT_RUN_SQL)
      .run(
        id,
        options.taskName,
        status,
        options.parentRunId ?? null,
        options.workspaceId ?? null,
        startedAt,
        serializeJson(options.metadata),
        timestamp,
        timestamp,
      );

    let position = 0;
    for (const step of options.steps ?? []) {
      insertStepUnsafe(id, step, timestamp, position);
      position += 1;
    }
  });

  const created = getRun(id);
  if (!created) throw new Error("Запуск не найден сразу после создания");
  return created;
}

function insertStepUnsafe(
  runId: string,
  options: CreateStepOptions,
  timestamp: string,
  position: number,
): string {
  const id = randomUUID();
  const status: StepStatus = options.status ?? "pending";
  const startedAt = status === "running" ? timestamp : null;
  getDb()
    .prepare(INSERT_STEP_SQL)
    .run(
      id,
      runId,
      options.stepName,
      position,
      status,
      1,
      options.idempotencyKey ?? null,
      startedAt,
      serializeJson(options.output),
      timestamp,
      timestamp,
    );
  return id;
}

/** Следующая позиция шага в цепочке запуска. */
function nextStepPosition(runId: string): number {
  const row = queryRow(
    "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM run_steps WHERE run_id = ?",
    runId,
  );
  return Number(row?.next) || 0;
}

/** Добавляет шаг в существующий запуск. Имя шага уникально внутри запуска. */
export function createStep(runId: string, options: CreateStepOptions): RunStepRecord {
  const id = withTransaction(() => insertStepUnsafe(runId, options, nowIso(), nextStepPosition(runId)));
  const step = getStepById(id);
  if (!step) throw new Error("Шаг не найден сразу после создания");
  return step;
}

/** Создаёт все шаги запуска в одной транзакции (для DAG-описания). */
export function createSteps(runId: string, steps: CreateStepOptions[]): RunStepRecord[] {
  const timestamp = nowIso();
  withTransaction(() => {
    let position = nextStepPosition(runId);
    for (const step of steps) {
      insertStepUnsafe(runId, step, timestamp, position);
      position += 1;
    }
  });
  return listRunSteps(runId);
}

export function getRun(id: string): RunRecord | undefined {
  const row = queryRow("SELECT * FROM runs WHERE id = ?", id);
  return row ? runRowToRecord(row) : undefined;
}

/** Список запусков (новые сверху). Без taskName — по всем задачам. */
export function listRuns(taskName?: string | null, limit = 100): RunRecord[] {
  const safeLimit = Math.max(1, Math.min(10000, Math.floor(limit) || 1));
  if (taskName) {
    return queryRows(
      `SELECT * FROM runs WHERE lower(task_name) = lower(?)
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      taskName,
      safeLimit,
    ).map(runRowToRecord);
  }
  return queryRows(
    "SELECT * FROM runs ORDER BY created_at DESC, id DESC LIMIT ?",
    safeLimit,
  ).map(runRowToRecord);
}

/** pending → running. Возвращает false, если запуск не найден. */
export function startRun(id: string, startedAt = nowIso()): boolean {
  return withTransaction(() => {
    const run = getRun(id);
    if (!run) return false;
    assertTransition("run", run.status, "running", RUN_TRANSITIONS[run.status]);
    getDb()
      .prepare(
        "UPDATE runs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(startedAt, nowIso(), id);
    return true;
  });
}

/**
 * pending/running → paused (Спринт 36.7).
 *
 * Пауза ставится только между шагами: если шаг уже выполняется, вызывающий
 * код должен дождаться его завершения. `finished_at` не заполняется — запуск
 * не завершён, а приостановлен.
 */
export function pauseRunRecord(id: string, pausedAt = nowIso()): boolean {
  return withTransaction(() => {
    const run = getRun(id);
    if (!run) return false;
    assertTransition("run", run.status, "paused", RUN_TRANSITIONS[run.status]);
    getDb()
      .prepare("UPDATE runs SET status = 'paused', updated_at = ? WHERE id = ?")
      .run(pausedAt, id);
    return true;
  });
}

/** Завершает запуск (passed/failed/cancelled) и фиксирует finished_at. */
export function finishRun(
  id: string,
  status: Extract<RunStatus, "passed" | "failed" | "cancelled">,
  options: FinishOptions = {},
): boolean {
  return withTransaction(() => {
    const run = getRun(id);
    if (!run) return false;
    assertTransition("run", run.status, status, RUN_TRANSITIONS[run.status]);
    const timestamp = nowIso();
    getDb()
      .prepare("UPDATE runs SET status = ?, finished_at = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(status, timestamp, options.error ?? null, timestamp, id);
    return true;
  });
}

/**
 * failed/paused → running: возобновление прогона после краха или паузы (36.2, 36.7).
 *
 * Не сбрасывает номера попыток шагов — они растут через `retryStep` при
 * повторе конкретного шага.
 */
export function reopenRun(id: string, startedAt = nowIso()): boolean {
  return withTransaction(() => {
    const run = getRun(id);
    if (!run) return false;
    assertTransition("run", run.status, "running", RUN_TRANSITIONS[run.status]);
    getDb()
      .prepare(
        `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?),
           finished_at = NULL, error = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(startedAt, nowIso(), id);
    return true;
  });
}

export function getStepById(id: string): RunStepRecord | undefined {
  const row = queryRow("SELECT * FROM run_steps WHERE id = ?", id);
  return row ? stepRowToRecord(row) : undefined;
}

/** Шаг по имени внутри запуска (имя уникально). */
export function getStep(runId: string, stepName: string): RunStepRecord | undefined {
  const row = queryRow(
    "SELECT * FROM run_steps WHERE run_id = ? AND step_name = ?",
    runId,
    stepName,
  );
  return row ? stepRowToRecord(row) : undefined;
}

/** Все шаги запуска в порядке создания. */
export function listRunSteps(runId: string): RunStepRecord[] {
  return queryRows(
    "SELECT * FROM run_steps WHERE run_id = ? ORDER BY position ASC, rowid ASC",
    runId,
  ).map(stepRowToRecord);
}

/** Поиск шага по ключу идемпотентности (36.3) в пределах запуска. */
export function findStepByIdempotencyKey(
  runId: string,
  idempotencyKey: string,
): RunStepRecord | undefined {
  const row = queryRow(
    "SELECT * FROM run_steps WHERE run_id = ? AND idempotency_key = ? LIMIT 1",
    runId,
    idempotencyKey,
  );
  return row ? stepRowToRecord(row) : undefined;
}

/** pending → running. Возвращает false, если шаг не найден. */
export function startStep(id: string, startedAt = nowIso(), lease?: StepLease): boolean {
  return withTransaction(() => {
    const step = getStepById(id);
    if (!step) return false;
    assertTransition("step", step.status, "running", STEP_TRANSITIONS[step.status]);
    getDb()
      .prepare(
        `UPDATE run_steps SET status = 'running', started_at = ?, finished_at = NULL,
           error = NULL, owner_id = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(startedAt, lease?.ownerId ?? null, lease?.leaseUntil ?? null, nowIso(), id);
    return true;
  });
}

/** running → passed/failed; pending → skipped допустим. */
export function finishStep(
  id: string,
  status: Extract<StepStatus, "passed" | "failed" | "skipped">,
  options: FinishOptions = {},
): boolean {
  return withTransaction(() => {
    const step = getStepById(id);
    if (!step) return false;
    assertTransition("step", step.status, status, STEP_TRANSITIONS[step.status]);
    const timestamp = nowIso();
    getDb()
      .prepare(
        `UPDATE run_steps SET status = ?, finished_at = ?, error = ?, output_json = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        status,
        timestamp,
        options.error ?? null,
        options.output === undefined ? null : serializeJson(options.output),
        timestamp,
        id,
      );
    return true;
  });
}

/**
 * Повтор упавшего шага: failed → running, attempt + 1.
 *
 * Это единственный переход из финального статуса шага. Предыдущая попытка
 * остаётся видимой в счётчике attempt; для 36.4 (DLQ) здесь появится лимит.
 */
export function retryStep(id: string, startedAt = nowIso(), lease?: StepLease): boolean {
  return withTransaction(() => {
    const step = getStepById(id);
    if (!step) return false;
    if (step.status !== "failed") {
      throw new InvalidTransitionError("step", step.status, "running");
    }
    getDb()
      .prepare(
        `UPDATE run_steps SET status = 'running', attempt = attempt + 1,
           started_at = ?, finished_at = NULL, error = NULL,
           owner_id = ?, lease_until = ?, updated_at = ? WHERE id = ?`,
      )
      .run(startedAt, lease?.ownerId ?? null, lease?.leaseUntil ?? null, nowIso(), id);
    return true;
  });
}

/**
 * B12: продлевает lease выполняющегося шага.
 *
 * Возвращает false, если шаг уже не `running` (например, recovery успел
 * финализировать его после истечения lease): продлевать нечего.
 */
export function renewStepLease(id: string, lease: StepLease): boolean {
  const result = getDb()
    .prepare(
      `UPDATE run_steps SET owner_id = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(lease.ownerId, lease.leaseUntil, nowIso(), id);
  return Number(result.changes) > 0;
}

/** Количество шагов запуска (для health/отчётов). */
export function countRunSteps(runId: string): number {
  const row = queryRow("SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ?", runId);
  return Number(row?.count) || 0;
}

/** Удаляет запуск; шаги удаляются каскадом (ON DELETE CASCADE). */
export function deleteRun(id: string): boolean {
  const result = getDb().prepare("DELETE FROM runs WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}

/** Готова ли схема к работе с durable DAG (runs + run_steps). */
export function isRunStateReady(): boolean {
  const rows = queryRows(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('runs', 'run_steps')",
  );
  return rows.length === 2;
}

/** Терминальный ли статус шага (для resume/cleanup в следующих подзадачах). */
export function isTerminalStepStatus(status: StepStatus): boolean {
  return TERMINAL_STEP_STATUSES.has(status);
}
