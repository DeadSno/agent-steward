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
 * Выполнение шагов запускает исполнитель DAG через `resumeRun`, поэтому
 * фасад не притворяется, что работа уже сделана.
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
import { findResumeStep } from "../db/run-resume.js";

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
