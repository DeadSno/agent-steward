import { getDb, withTransaction } from "./index.js";
import {
  finishStep,
  getRun,
  getStep,
  retryStep,
  startRun,
  startStep,
  type FinishOptions,
  type RunRecord,
  type RunStepRecord,
} from "./runs-repo.js";

/**
 * Журнал выполнения шагов (Sprint 36.1.b).
 *
 * Каждый переход шага пишется отдельной транзакцией и фиксируется в WAL
 * **до** запуска тела шага и **после** него. Если процесс убьют посреди шага,
 * в БД останется строка `running` с номером попытки `attempt`: её помечает
 * `recoverInterruptedSteps()`, а повтор идёт через `retryStep()` с `attempt + 1`.
 */

/** Текст ошибки, которым помечается шаг, прерванный падением процесса. */
export const STEP_INTERRUPTED_ERROR = "Прервано падением процесса";

/** Опции начала попытки. */
export interface BeginStepOptions {
  /** Начать запуск, если он ещё в статусе pending (по умолчанию true). */
  startRun?: boolean;
}

/** Результат выполнения шага через `runStepStatefully`. */
export interface StepExecution<T> {
  /** Состояние шага после завершения. */
  step: RunStepRecord;
  /** Значение, которое вернуло тело шага. */
  result: T;
  /** Номер попытки, с которым выполнялся шаг. */
  attempt: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Открывает попытку шага: run pending → running (если нужно), шаг pending → running.
 *
 * Запись коммитится до возврата управления, поэтому вызывающий код может
 * безопасно запускать побочные эффекты: факт старта уже на диске.
 *
 * Если шаг остался `failed` после падения — выполняется `retryStep`, и номер
 * попытки увеличивается, а не начинается заново.
 */
export function beginStepAttempt(
  runId: string,
  stepName: string,
  options: BeginStepOptions = {},
): RunStepRecord {
  if (options.startRun !== false) {
    const run = requireRun(runId);
    if (run.status === "pending") startRun(runId);
  }

  const step = requireStep(runId, stepName);
  if (step.status === "failed") {
    retryStep(step.id);
  } else {
    startStep(step.id);
  }

  return requireStep(runId, stepName);
}

/** Закрывает попытку успехом: running → passed, сохраняет output. */
export function recordStepSuccess(
  runId: string,
  stepName: string,
  output?: unknown,
): RunStepRecord {
  completeStep(runId, stepName, "passed", { output });
  return requireStep(runId, stepName);
}

/** Закрывает попытку ошибкой: running → failed, сохраняет текст ошибки. */
export function recordStepFailure(
  runId: string,
  stepName: string,
  error: unknown,
): RunStepRecord {
  completeStep(runId, stepName, "failed", { error: errorMessage(error) });
  return requireStep(runId, stepName);
}

/**
 * Выполняет шаг с журналированием: состояние `running` фиксируется до вызова
 * `body`, результат (`passed`/`failed`) — после. Ошибка тела не теряется:
 * шаг помечается failed, исключение пробрасывается дальше.
 */
export function runStepStatefully<T>(
  runId: string,
  stepName: string,
  body: () => T,
  options: BeginStepOptions = {},
): StepExecution<T> {
  const attempt = beginStepAttempt(runId, stepName, options).attempt;
  let result: T;
  try {
    result = body();
  } catch (err) {
    recordStepFailure(runId, stepName, err);
    throw err;
  }
  const step = recordStepSuccess(runId, stepName, result);
  return { step, result, attempt };
}

/** Асинхронный вариант `runStepStatefully` для шагов с I/O. */
export async function runStepStatefullyAsync<T>(
  runId: string,
  stepName: string,
  body: () => Promise<T> | T,
  options: BeginStepOptions = {},
): Promise<StepExecution<T>> {
  const attempt = beginStepAttempt(runId, stepName, options).attempt;
  let result: T;
  try {
    result = await body();
  } catch (err) {
    recordStepFailure(runId, stepName, err);
    throw err;
  }
  const step = recordStepSuccess(runId, stepName, result);
  return { step, result, attempt };
}

/**
 * Помечает все зависшие `running`-шаги как failed, сохраняя `attempt`.
 *
 * Возвращает обновлённые записи. `attempt` не сбрасывается — следующая попытка
 * получит `attempt + 1` через `retryStep`, поэтому номер попытки переживает
 * падение процесса и восстановление.
 */
export function recoverInterruptedSteps(runId?: string): RunStepRecord[] {
  const running = listRunningSteps(runId);
  if (running.length === 0) return [];

  return withTransaction(() => {
    const timestamp = nowIso();
    const update = getDb().prepare(
      `UPDATE run_steps SET status = 'failed', error = ?, finished_at = ?,
         updated_at = ? WHERE id = ? AND status = 'running'`,
    );
    for (const step of running) {
      update.run(STEP_INTERRUPTED_ERROR, timestamp, timestamp, step.id);
    }
    return running.map((step) => requireStep(step.runId, step.stepName));
  });
}

/** Список шагов в статусе running (для диагностики и восстановления). */
export function listRunningSteps(runId?: string): RunStepRecord[] {
  const sql = runId
    ? "SELECT run_id, step_name FROM run_steps WHERE status = 'running' AND run_id = ? ORDER BY created_at"
    : "SELECT run_id, step_name FROM run_steps WHERE status = 'running' ORDER BY created_at";
  const statement = getDb().prepare(sql);
  const rows = (runId ? statement.all(runId) : statement.all()) as {
    run_id: string;
    step_name: string;
  }[];

  const steps: RunStepRecord[] = [];
  for (const row of rows) {
    const step = getStep(String(row.run_id), String(row.step_name));
    if (step && step.status === "running") steps.push(step);
  }
  return steps;
}

/** Запуск по id либо ошибка (удобно для журнала и тестов). */
export function requireRun(runId: string): RunRecord {
  const run = getRun(runId);
  if (!run) throw new Error(`Запуск не найден: ${runId}`);
  return run;
}

function requireStep(runId: string, stepName: string): RunStepRecord {
  const step = getStep(runId, stepName);
  if (!step) throw new Error(`Шаг не найден: ${runId}/${stepName}`);
  return step;
}

function completeStep(
  runId: string,
  stepName: string,
  status: "passed" | "failed",
  options: FinishOptions,
): void {
  const step = requireStep(runId, stepName);
  if (step.status !== "running") {
    // Повторная запись результата — ошибка вызывающего кода, а не «тихий» пропуск.
    throw new Error(
      `Шаг ${runId}/${stepName} не выполняется (статус ${step.status}), запись ${status} невозможна.`,
    );
  }
  finishStep(step.id, status, options);
}
