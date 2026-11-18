import {
  finishRun,
  getRun,
  listRunSteps,
  reopenRun,
  startRun,
  type RunRecord,
  type RunStepRecord,
} from "./runs-repo.js";
import {
  listRunningSteps,
  recoverInterruptedSteps,
  requireRun,
  runStepStatefully,
  runStepStatefullyAsync,
} from "./run-journal.js";
import {
  consumeInjections,
  consumeOrphanInjections,
  pendingInjectionsForStep,
  type StepContext,
} from "./run-context.js";

/**
 * Resume с середины (Sprint 36.2).
 *
 * Линейная цепочка шагов хранится в `run_steps` в порядке создания. Возобновление
 * находит первый незавершённый шаг (не `passed`/`skipped`), помечает зависшие
 * `running` как прерванные и выполняет остаток цепочки через журнал 36.1.b.
 * Уже успешные шаги повторно не запускаются, а `attempt` упавших растёт.
 */

/** Обработчик тела шага. Получает актуальную запись шага и контекст паузы. */
export type StepHandler = (step: RunStepRecord, context: StepContext) => unknown;

/** Опции возобновления. */
export interface ResumeOptions {
  /** Тела шагов по имени. Отсутствие обработчика — ошибка до запуска цепочки. */
  handlers: Record<string, StepHandler>;
  /** Восстанавливать зависшие `running`-шаги перед продолжением (по умолчанию true). */
  recover?: boolean;
  /**
   * B12: момент для проверки lease при восстановлении. По умолчанию now.
   * Передавайте будущее время, чтобы считать lease зависшего шага истёкшим.
   */
  recoverNow?: string | Date;
  /** Останавливаться на первой ошибке (по умолчанию true). */
  stopOnError?: boolean;
}

/** Результат возобновления прогона. */
export interface ResumeResult {
  /** Состояние запуска после возобновления. */
  run: RunRecord;
  /** С какого шага продолжили (`null`, если продолжать нечего). */
  resumedFrom: string | null;
  /** Номер попытки, с которым выполнялся первый возобновлённый шаг. */
  resumedFromAttempt: number | null;
  /** Шаги, выполненные в этот раз. */
  executed: string[];
  /** Шаги, пропущенные как уже завершённые. */
  skipped: string[];
  /** Идентификаторы вставок контекста, переданных шагам в этот раз. */
  injected: string[];
  /** Первый упавший шаг, если цепочка остановилась. */
  failedStep: string | null;
  /** Текст ошибки упавшего шага. */
  error: string | null;
}

/** Завершён ли шаг успешно (повторять не нужно). */
function isStepDone(status: RunStepRecord["status"]): boolean {
  return status === "passed" || status === "skipped";
}

/** Первый незавершённый шаг цепочки либо null. Без восстановления состояния. */
export function findResumeStep(runId: string): RunStepRecord | null {
  const steps = listRunSteps(runId);
  return steps.find((step) => !isStepDone(step.status)) ?? null;
}

interface ResumePlan {
  steps: RunStepRecord[];
  startIndex: number;
}

function prepareResume(runId: string, options: ResumeOptions): ResumePlan {
  const run = requireRun(runId);
  if (run.status === "cancelled") {
    throw new Error(`Запуск отменён, возобновление невозможно: ${runId}`);
  }

  if (options.recover !== false) recoverInterruptedSteps(runId, { now: options.recoverNow });

  // B12: шаг с живым lease принадлежит работающему процессу. Возобновлять его
  // здесь нельзя — иначе два исполнителя возьмут один шаг.
  const active = listRunningSteps(runId);
  if (active.length > 0) {
    const step = active[0];
    throw new Error(
      `Шаг ${step.stepName} выполняется другим процессом (lease до ${step.leaseUntil ?? "неизвестно"}); возобновление отложено.`,
    );
  }

  const steps = listRunSteps(runId);
  const startIndex = steps.findIndex((step) => !isStepDone(step.status));

  if (startIndex >= 0) {
    for (const step of steps.slice(startIndex)) {
      if (isStepDone(step.status)) continue;
      if (typeof options.handlers[step.stepName] !== "function") {
        throw new Error(`Нет обработчика шага: ${step.stepName}`);
      }
    }
    // Упавший запуск открываем заново: шаги можно перезапускать, attempt не сбрасывается.
    // Паузу снимаем тем же переходом paused → running (36.7).
    const current = requireRun(runId);
    if (current.status === "failed" || current.status === "paused") reopenRun(runId);
  }

  return { steps, startIndex };
}

/**
 * Возобновляет линейную цепочку шагов синхронно.
 *
 * Все проверки (наличие обработчиков) выполняются до первого побочного эффекта.
 */
export function resumeRunSync(runId: string, options: ResumeOptions): ResumeResult {
  const { steps, startIndex } = prepareResume(runId, options);
  if (startIndex === -1) {
    return finalize(runId, null, null, [], steps.map((step) => step.stepName), []);
  }

  const resumedFrom = steps[startIndex].stepName;
  const executed: string[] = [];
  const skipped: string[] = steps
    .slice(0, startIndex)
    .filter((step) => isStepDone(step.status))
    .map((step) => step.stepName);
  const injected: string[] = [];
  let resumedFromAttempt: number | null = null;

  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (isStepDone(step.status)) {
      skipped.push(step.stepName);
      continue;
    }

    executed.push(step.stepName);
    const context = pendingInjectionsForStep(runId, step.stepName);
    try {
      const execution = runStepStatefully(runId, step.stepName, () =>
        options.handlers[step.stepName](step, { injections: context }),
      );
      if (resumedFromAttempt === null) resumedFromAttempt = execution.attempt;
      if (context.length > 0) {
        consumeInjections(
          context.map((injection) => injection.id),
          step.stepName,
          execution.attempt,
        );
        injected.push(...context.map((injection) => injection.id));
      }
    } catch {
      if (options.stopOnError === false) continue;
      return finalize(runId, resumedFrom, resumedFromAttempt, executed, skipped, injected);
    }
  }

  return finalize(runId, resumedFrom, resumedFromAttempt, executed, skipped, injected);
}

/** Асинхронный вариант `resumeRunSync` для шагов с I/O. */
export async function resumeRun(
  runId: string,
  options: ResumeOptions,
): Promise<ResumeResult> {
  const { steps, startIndex } = prepareResume(runId, options);
  if (startIndex === -1) {
    return finalize(runId, null, null, [], steps.map((step) => step.stepName), []);
  }

  const resumedFrom = steps[startIndex].stepName;
  const executed: string[] = [];
  const skipped: string[] = steps
    .slice(0, startIndex)
    .filter((step) => isStepDone(step.status))
    .map((step) => step.stepName);
  const injected: string[] = [];
  let resumedFromAttempt: number | null = null;

  for (let index = startIndex; index < steps.length; index += 1) {
    const step = steps[index];
    if (isStepDone(step.status)) {
      skipped.push(step.stepName);
      continue;
    }

    executed.push(step.stepName);
    const context = pendingInjectionsForStep(runId, step.stepName);
    try {
      const execution = await runStepStatefullyAsync(runId, step.stepName, () =>
        options.handlers[step.stepName](step, { injections: context }),
      );
      if (resumedFromAttempt === null) resumedFromAttempt = execution.attempt;
      if (context.length > 0) {
        consumeInjections(
          context.map((injection) => injection.id),
          step.stepName,
          execution.attempt,
        );
        injected.push(...context.map((injection) => injection.id));
      }
    } catch {
      if (options.stopOnError === false) continue;
      return finalize(runId, resumedFrom, resumedFromAttempt, executed, skipped, injected);
    }
  }

  return finalize(runId, resumedFrom, resumedFromAttempt, executed, skipped, injected);
}

/** Закрывает прогон по фактическому состоянию шагов и собирает результат. */
function finalize(
  runId: string,
  resumedFrom: string | null,
  resumedFromAttempt: number | null,
  executed: string[],
  skipped: string[],
  injected: string[],
): ResumeResult {
  // Вставки, адресованные уже завершённым шагам, не должны висеть в истории.
  consumeOrphanInjections(runId);

  let steps = listRunSteps(runId);
  const failed = steps.find((step) => step.status === "failed") ?? null;
  const unfinished = steps.some(
    (step) => step.status === "pending" || step.status === "running",
  );
  let run = requireRun(runId);

  if (!failed && !unfinished) {
    if (run.status === "pending") {
      startRun(runId);
      run = requireRun(runId);
    }
    // Пауза после последнего шага: продолжать нечего, запуск успешен.
    if (run.status === "running" || run.status === "paused") {
      finishRun(runId, "passed");
      run = requireRun(runId);
    }
  } else if (failed && run.status === "running") {
    finishRun(runId, "failed", {
      error: failed.error ?? `Шаг ${failed.stepName} завершился ошибкой`,
    });
    run = requireRun(runId);
  }

  steps = listRunSteps(runId);
  return {
    run,
    resumedFrom,
    resumedFromAttempt,
    executed,
    skipped,
    injected,
    failedStep: failed?.stepName ?? null,
    error: failed?.error ?? null,
  };
}
