/**
 * GUI/RPC-фасад над durable-запусками (Спринт 36.8).
 *
 * Тонкий слой между `runs-repo`/`run-context`/`run-resume` и RPC: приводит
 * фильтр и лимит к безопасным значениям, отдаёт панели компактное описание
 * запуска (текущий шаг, прогресс, история контекста) и не выпускает панику
 * БД наружу.
 *
 * Resume здесь, как и retry в DLQ (36.6), только готовит запуск: снимает
 * паузу/переоткрывает failed и возвращает первый незавершённый шаг.
 * PL-92 добавляет `resumeDurableRunExecution`: если в `runs.metadata_json`
 * сохранён дескриптор исполнения, фасад восстанавливает исполнителя и реально
 * доигрывает шаги через `resumeRun`. Без дескриптора (старые/registered run)
 * он честно возвращает ошибку вместо бутафорского «успеха».
 */
import {
  getRun,
  listRuns,
  listRunSteps,
  reopenRun,
  type RunRecord,
  type RunStatus,
  type RunStepRecord,
} from "../db/runs-repo.js";
import {
  listRunInjections,
  pauseRun,
  type RunInjection,
  type PauseRunInput,
} from "../db/run-context.js";
import {
  findResumeStep,
  resumeRun,
  type StepHandler,
} from "../db/run-resume.js";
import {
  createOpenCodeExecutor,
  writeGateOutcome,
  type DurableExecutionDescriptor,
  type ExecutionPlan,
  type OpenCodeInvocation,
  type StepExecutor,
  type StepExecutorDescriptor,
} from "./execution.js";
import { createMissionWrapperExecutor } from "./mission.js";
import { runOpencode } from "./opencode-cli.js";
import { buildSessionArgs, type SessionMode } from "./session.js";

/** Фильтр панели: конкретный статус, все записи или активные. */
export type RunPanelFilter = RunStatus | "all" | "active";

/** Компактная вставка контекста для истории панели. */
export interface RunPanelInjection {
  id: string;
  kind: string;
  /** Обрезанный до 500 символов текст (секреты уже замаскированы в БД). */
  content: string;
  contentLength: number;
  author: string;
  createdAt: string;
  consumedAt: string | null;
  consumedByStep: string | null;
}

/** Шаг запуска для панели. */
export interface RunPanelStep {
  stepName: string;
  position: number;
  status: string;
  attempt: number;
  error: string | null;
  /** Якорь для ссылки «текущий шаг». */
  anchor: string;
}

/** Описание одного durable-запуска. */
export interface RunPanelRun {
  id: string;
  taskName: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  steps: RunPanelStep[];
  /** Первый незавершённый шаг или null, если все шаги закрыты. */
  currentStep: RunPanelStep | null;
  /** Сколько шагов уже passed/skipped. */
  doneSteps: number;
  totalSteps: number;
  injections: RunPanelInjection[];
  pendingInjections: number;
}

export interface RunPanelListResult {
  success: boolean;
  runs: RunPanelRun[];
  /** Сколько активных запусков (pending/running/paused/failed) для бейджа. */
  active: number;
  error?: string;
}

export interface RunPanelActionResult {
  success: boolean;
  error?: string;
  run?: RunPanelRun;
  /** Шаг, который получит контекст паузы или продолжит работу. */
  stepName?: string | null;
  /** true, если resume только переоткрыл запуск и подготовил шаг. */
  prepared?: boolean;
}

const MAX_CONTENT_PREVIEW = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ACTIVE_STATUSES: RunStatus[] = ["pending", "running", "paused", "failed"];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Неизвестный фильтр трактуем как `active` — безопасный дефолт панели. */
export function normalizeRunPanelFilter(value: unknown): RunPanelFilter {
  if (value === "all" || value === "active") return value;
  if (
    value === "pending" ||
    value === "running" ||
    value === "paused" ||
    value === "passed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return "active";
}

function normalizeLimit(value: unknown, fallback = DEFAULT_LIMIT): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.min(num, MAX_LIMIT);
}

function stepAnchor(runId: string, stepName: string): string {
  return `run-step-${runId}-${stepName.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

function toPanelStep(runId: string, step: RunStepRecord): RunPanelStep {
  return {
    stepName: step.stepName,
    position: step.position,
    status: step.status,
    attempt: step.attempt,
    error: step.error,
    anchor: stepAnchor(runId, step.stepName),
  };
}

function toPanelInjection(injection: RunInjection): RunPanelInjection {
  return {
    id: injection.id,
    kind: injection.kind,
    content:
      injection.content.length > MAX_CONTENT_PREVIEW
        ? `${injection.content.slice(0, MAX_CONTENT_PREVIEW)}…`
        : injection.content,
    contentLength: injection.content.length,
    author: injection.author,
    createdAt: injection.createdAt,
    consumedAt: injection.consumedAt,
    consumedByStep: injection.consumedByStep,
  };
}

function isDone(step: RunStepRecord): boolean {
  return step.status === "passed" || step.status === "skipped";
}

/** Собирает компактное описание запуска. */
export function getRunPanelRun(runId: string): RunPanelRun | undefined {
  const run = getRun(runId);
  if (!run) return undefined;
  return toPanelRun(run);
}

function toPanelRun(run: RunRecord): RunPanelRun {
  const steps = listRunSteps(run.id);
  const panelSteps = steps.map((step) => toPanelStep(run.id, step));
  const current = steps.find((step) => !isDone(step));
  const allInjections = listRunInjections(run.id);
  const injections = allInjections.slice(-20).map(toPanelInjection);
  return {
    id: run.id,
    taskName: run.taskName,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    steps: panelSteps,
    currentStep: current ? toPanelStep(run.id, current) : null,
    doneSteps: steps.filter(isDone).length,
    totalSteps: steps.length,
    injections,
    pendingInjections: allInjections.filter((item) => item.consumedAt === null).length,
  };
}

/** Список запусков для панели и счётчик активных. */
export function listRunPanel(
  options: { filter?: unknown; limit?: unknown } = {},
): RunPanelListResult {
  try {
    const filter = normalizeRunPanelFilter(options.filter);
    const limit = normalizeLimit(options.limit);
    const all = listRuns(undefined, MAX_LIMIT);
    const matching = all.filter((run) =>
      filter === "all"
        ? true
        : filter === "active"
          ? ACTIVE_STATUSES.includes(run.status)
          : run.status === filter,
    );
    return {
      success: true,
      runs: matching.slice(0, limit).map(toPanelRun),
      active: all.filter((run) => ACTIVE_STATUSES.includes(run.status)).length,
    };
  } catch (err) {
    return { success: false, runs: [], active: 0, error: errorText(err) };
  }
}

/**
 * Пауза с комментарием. Ошибки (running-шаг, терминальный запуск, нет
 * незавершённых шагов) возвращаются как `{ success: false }`, чтобы GUI
 * показал их рядом с кнопкой.
 */
export function pauseRunPanel(
  runId: string,
  input: Omit<PauseRunInput, "file" | "artifact"> = {},
): RunPanelActionResult {
  try {
    const result = pauseRun(runId, input);
    return {
      success: true,
      run: toPanelRun(result.run),
      stepName: result.stepName,
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/**
 * Resume только готовит запуск: paused/failed → running, шаг остаётся
 * незавершённым. Дальше его выполняет `resumeRun`/внешний исполнитель DAG.
 */
export function resumeRunPanel(runId: string): RunPanelActionResult {
  try {
    const run = getRun(runId);
    if (!run) return { success: false, error: `Запуск не найден: ${runId}` };
    if (run.status !== "paused" && run.status !== "failed") {
      return {
        success: false,
        error: `Запуск в статусе ${run.status} нельзя возобновить: ${runId}`,
      };
    }
    reopenRun(runId);
    const next = findResumeStep(runId);
    return {
      success: true,
      run: toPanelRun(getRun(runId)!),
      stepName: next?.stepName ?? null,
      prepared: true,
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/* ------------------------------------------------------------------------- *
 * PL-92: настоящее выполнение при resume.
 *
 * `resumeRun` уже умеет доигрывать шаги с инъекциями и leases, но ему нужны
 * тела шагов. Раньше их не было ни в RPC, ни в GUI — resume только менял
 * статус. Теперь `executeExecutionPlan` сохраняет в `runs.metadata_json`
 * дескриптор (план + транспорт), а здесь мы поднимаем исполнитель заново.
 * ------------------------------------------------------------------------- */

export interface ResumeDurableExecutionOptions {
  /** Исполнители, переданные вызывающим; имеют приоритет над дескриптором. */
  executors?: StepExecutor[];
  /** Вход OpenCode для дескриптора `{ kind: "opencode" }`. */
  invokeOpenCode?: (input: OpenCodeInvocation) => unknown;
}

export interface ResumeExecutionResult extends RunPanelActionResult {
  /** С какого шага продолжили. */
  resumedFrom?: string | null;
  /** Шаги, реально выполненные в этот раз. */
  executed?: string[];
  /** Уже завершённые шаги. */
  skipped?: string[];
  /** Идентификаторы потреблённых инъекций. */
  injected?: string[];
  /** Первый упавший шаг. */
  failedStep?: string | null;
}

/** Достаём дескриптор из metadata старых и новых запусков без броска. */
function durableExecutionFromRun(run: RunRecord): DurableExecutionDescriptor | null {
  const metadata = run.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).durableExecution;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DurableExecutionDescriptor>;
  const plan = candidate.plan as ExecutionPlan | undefined;
  if (
    candidate.schema !== 1 ||
    !candidate.executor ||
    !plan ||
    !plan.context ||
    !Array.isArray(plan.steps)
  ) {
    return null;
  }
  return candidate as DurableExecutionDescriptor;
}

/**
 * PL-97: транспорт OpenCode по умолчанию для возобновлённых/DLQ-шагов.
 *
 * Раньше `resumeDurableRunExecution` требовал `invokeOpenCode` от вызывающего,
 * поэтому RPC/GUI-путь не мог доиграть opencode-шаг. Теперь дескриптор
 * `{ kind: "opencode" }` исполняется через реальный CLI с сохранёнными cwd,
 * моделью и режимом сессии; явный `invokeOpenCode` всё ещё имеет приоритет
 * (используется тестами и альтернативными транспортами).
 */
export async function invokeOpenCodeCli(input: OpenCodeInvocation): Promise<string> {
  const args = [
    "run",
    ...buildSessionArgs(input.session as SessionMode, input.sessionId ?? undefined),
  ];
  if (input.model) args.push("--model", input.model);
  args.push("--", input.prompt);
  const result = await runOpencode(args, 120_000, input.cwd);
  if (!result.ok) {
    throw new Error(result.error || result.stderr || "OpenCode завершился ошибкой");
  }
  return result.stdout;
}

/** Есть ли у запуска дескриптор исполнения (для префлайта DLQ-retry). */
export function hasDurableExecution(runId: string): boolean {
  const run = getRun(runId);
  return Boolean(run && durableExecutionFromRun(run));
}

/** Восстанавливаем исполнителя по сохранённому дескриптору. */
function executorForDescriptor(
  descriptor: StepExecutorDescriptor,
  options: ResumeDurableExecutionOptions,
): StepExecutor {
  const explicit = options.executors?.find(
    (executor) => executor.descriptor?.kind === descriptor.kind,
  );
  if (explicit) return explicit;

  if (descriptor.kind === "opencode") {
    return createOpenCodeExecutor(options.invokeOpenCode ?? invokeOpenCodeCli);
  }
  if (descriptor.kind === "mission-wrapper") {
    return createMissionWrapperExecutor(descriptor.wrapperPath, {
      cwd: descriptor.cwd,
      timeoutSeconds: descriptor.timeoutSeconds,
    });
  }
  throw new Error(
    `Неизвестный дескриптор исполнителя: ${String((descriptor as { kind?: unknown }).kind)}`,
  );
}

/**
 * Возобновляет durable-запуск и ДОИГРЫВАЕТ его шаги.
 *
 * Для старых/registered-запусков без `metadata.durableExecution` возвращает
 * `{ success: false }`: подготовка доступна через `resumeRunPanel`, но выполнять
 * нечего — честный отказ лучше ложного «успеха».
 */
export async function resumeDurableRunExecution(
  runId: string,
  options: ResumeDurableExecutionOptions = {},
): Promise<ResumeExecutionResult> {
  try {
    const run = getRun(runId);
    if (!run) return { success: false, error: `Запуск не найден: ${runId}` };
    const descriptor = durableExecutionFromRun(run);
    if (!descriptor) {
      return {
        success: false,
        error: `Запуск ${runId} не содержит metadata.durableExecution: автоматическое выполнение невозможно. Доступна только подготовка через resumeRunPanel.`,
      };
    }

    const executor = executorForDescriptor(descriptor.executor, options);
    const { plan } = descriptor;
    const planned = new Map(plan.steps.map((step) => [step.stepName, step]));
    const handlers: Record<string, StepHandler> = {};
    for (const step of plan.steps) {
      handlers[step.stepName] = async (record) => {
        const target = planned.get(record.stepName);
        if (!target) {
          throw new Error(`Шаг ${record.stepName} отсутствует в сохранённом плане`);
        }
        if (target.route.executor === null) {
          throw new Error(`Маршрут ${target.route.target} не исполняется автоматически`);
        }
        if (!executor.supports(target.route)) {
          throw new Error(
            `Исполнитель ${executor.id} не поддерживает маршрут ${String(target.route.executor)}`,
          );
        }
        const result = await executor.execute({
          step: target,
          context: plan.context,
          plan,
          compiledContext: target.compiledContext,
        });
        if (result.error) throw new Error(result.error);
        return result.output;
      };
    }

    const resumed = await resumeRun(runId, { handlers, stopOnError: true });

    // PL-92: вердикт возобновлённого шага должен попасть в ту же хеш-цепочку.
    const byName = new Map(listRunSteps(runId).map((step) => [step.stepName, step]));
    for (const stepName of resumed.executed) {
      const record = byName.get(stepName);
      const target = planned.get(stepName);
      if (!record || !target) continue;
      writeGateOutcome({
        context: plan.context,
        runId,
        stepId: record.id,
        stepName,
        taskType: target.route.taskType,
        executor: executor.id,
        routeSource: target.route.source,
        routeReason: target.route.reason,
        gateType:
          typeof plan.context.metadata?.qualityGate === "string"
            ? plan.context.metadata.qualityGate
            : null,
        verdict: record.status === "passed" ? "pass" : "fail",
        attempt: record.attempt,
        firstPass: record.attempt === 1,
        evidencePath: descriptor.evidencePath,
      });
    }

    const finalRun = getRun(runId)!;
    return {
      success: resumed.failedStep === null,
      ...(resumed.failedStep
        ? { error: resumed.error ?? `Шаг ${resumed.failedStep} завершился ошибкой` }
        : {}),
      run: toPanelRun(finalRun),
      stepName: resumed.resumedFrom,
      resumedFrom: resumed.resumedFrom,
      executed: resumed.executed,
      skipped: resumed.skipped,
      injected: resumed.injected,
      failedStep: resumed.failedStep,
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
