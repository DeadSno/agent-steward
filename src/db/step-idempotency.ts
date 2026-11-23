import {
  createStep,
  findStepByIdempotencyKey,
  type RunStepRecord,
} from "./runs-repo.js";
import {
  beginStepAttempt,
  recordStepFailure,
  recordStepSuccess,
} from "./run-journal.js";

/**
 * Идемпотентное выполнение шага (Sprint 36.3).
 *
 * Ключ идемпотентности уникален в пределах запуска (частичный UNIQUE-индекс
 * `idx_run_steps_key_unique`). Повторный вызов с тем же ключом не выполняет
 * тело шага второй раз: возвращается сохранённый `output_json` с
 * `replayed: true`. Это защищает от дублей побочных эффектов при ретраях,
 * resume и параллельных вызовах.
 */

/** Ключ уже занят другим шагом запуска. */
export class IdempotencyConflictError extends Error {
  constructor(runId: string, key: string, stepName?: string) {
    super(
      stepName
        ? `Ключ идемпотентности "${key}" в запуске ${runId} уже принадлежит шагу "${stepName}".`
        : `Ключ идемпотентности "${key}" в запуске ${runId} уже используется.`,
    );
    this.name = "IdempotencyConflictError";
  }
}

/** Шаг с этим ключом выполняется прямо сейчас (параллельный дубль). */
export class StepInFlightError extends Error {
  constructor(runId: string, key: string) {
    super(`Шаг с ключом идемпотентности "${key}" уже выполняется в запуске ${runId}.`);
    this.name = "StepInFlightError";
  }
}

/** Опции идемпотентного шага. */
export interface StepOnceOptions {
  /** Обязательный ключ; уникален в пределах запуска. */
  idempotencyKey: string;
  /** Начать запуск, если он pending (по умолчанию true). */
  startRun?: boolean;
}

/** Результат `runStepOnce`. */
export interface StepOnceExecution<T> {
  /** Актуальное состояние шага. */
  step: RunStepRecord;
  /** Результат тела либо сохранённый output при повторе. */
  result: T | null;
  /** true — тело не вызывалось, результат взят из БД. */
  replayed: boolean;
  /** true — тело шага действительно выполнялось. */
  executed: boolean;
  /** Номер попытки, с которым шаг выполнен (или был выполнен раньше). */
  attempt: number;
}

/** Ключи, выполняющиеся в этом процессе: `runId\u0000key`. */
const inFlight = new Set<string>();

function normalizeKey(key: string): string {
  const value = String(key ?? "").trim();
  if (!value) throw new Error("idempotencyKey обязателен для идемпотентного шага.");
  return value;
}

function flightKey(runId: string, key: string): string {
  return `${runId}\u0000${key}`;
}

/**
 * Выполняет шаг ровно один раз на ключ.
 *
 * - новый ключ → шаг создаётся и выполняется;
 * - шаг уже `passed`/`skipped` → тело не вызывается, возвращается кэш;
 * - шаг `failed` → повтор с `attempt + 1` (осознанный ретрай);
 * - шаг `running` или параллельный вызов в этом процессе → `StepInFlightError`;
 * - ключ принадлежит другому шагу → `IdempotencyConflictError`.
 */
export function runStepOnce<T>(
  runId: string,
  stepName: string,
  options: StepOnceOptions,
  body: () => T,
): StepOnceExecution<T> {
  const key = normalizeKey(options.idempotencyKey);
  const flight = flightKey(runId, key);
  if (inFlight.has(flight)) throw new StepInFlightError(runId, key);
  inFlight.add(flight);

  try {
    const existing = findStepByIdempotencyKey(runId, key);
    if (existing && existing.stepName !== stepName) {
      throw new IdempotencyConflictError(runId, key, existing.stepName);
    }
    if (existing && (existing.status === "passed" || existing.status === "skipped")) {
      return {
        step: existing,
        result: (existing.output as T | null) ?? null,
        replayed: true,
        executed: false,
        attempt: existing.attempt,
      };
    }
    if (existing?.status === "running") {
      throw new StepInFlightError(runId, key);
    }
    if (!existing) {
      createStep(runId, { stepName, idempotencyKey: key });
    }

    const attempt = beginStepAttempt(runId, stepName, {
      startRun: options.startRun,
    }).attempt;

    let result: T;
    try {
      result = body();
    } catch (err) {
      recordStepFailure(runId, stepName, err);
      throw err;
    }
    const step = recordStepSuccess(runId, stepName, result);
    return { step, result, replayed: false, executed: true, attempt };
  } finally {
    inFlight.delete(flight);
  }
}

/** Асинхронный вариант `runStepOnce` для шагов с I/O. */
export async function runStepOnceAsync<T>(
  runId: string,
  stepName: string,
  options: StepOnceOptions,
  body: () => Promise<T> | T,
): Promise<StepOnceExecution<T>> {
  const key = normalizeKey(options.idempotencyKey);
  const flight = flightKey(runId, key);
  if (inFlight.has(flight)) throw new StepInFlightError(runId, key);
  inFlight.add(flight);

  try {
    const existing = findStepByIdempotencyKey(runId, key);
    if (existing && existing.stepName !== stepName) {
      throw new IdempotencyConflictError(runId, key, existing.stepName);
    }
    if (existing && (existing.status === "passed" || existing.status === "skipped")) {
      return {
        step: existing,
        result: (existing.output as T | null) ?? null,
        replayed: true,
        executed: false,
        attempt: existing.attempt,
      };
    }
    if (existing?.status === "running") {
      throw new StepInFlightError(runId, key);
    }
    if (!existing) {
      createStep(runId, { stepName, idempotencyKey: key });
    }

    const attempt = beginStepAttempt(runId, stepName, {
      startRun: options.startRun,
    }).attempt;

    let result: T;
    try {
      result = await body();
    } catch (err) {
      recordStepFailure(runId, stepName, err);
      throw err;
    }
    const step = recordStepSuccess(runId, stepName, result);
    return { step, result, replayed: false, executed: true, attempt };
  } finally {
    inFlight.delete(flight);
  }
}
