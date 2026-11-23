/**
 * GUI/RPC-фасад над dead-letter queue (Спринт 36.6).
 *
 * Тонкий слой между `src/db/run-dlq.ts` и RPC: приводит вход от GUI к
 * безопасным значениям (статус, лимит), не даёт панике БД выйти наружу и
 * возвращает единый `{ success, error }`-контракт. Логика очереди (идемпотентный
 * enqueue, retry через reopenRun, discard) остаётся в БД-слое.
 *
 * `retryDlq` (легаси) только готовит шаг к повторному выполнению: переоткрывает
 * запуск, переводит шаг в `running` и закрывает запись DLQ. PL-97 добавляет
 * `retryDlqExecution`: он закрывает запись, не трогая шаг, и сразу передаёт
 * запуск в `resumeDurableRunExecution`, который доигрывает шаг по сохранённому
 * дескриптору. Без дескриптора возвращается явная диагностика, а запись
 * остаётся открытой — подготовка по-прежнему доступна через `retryDlq`.
 */
import {
  countDeadLetters,
  discardDeadLetter,
  getDeadLetter,
  listDeadLetters,
  retryDeadLetter,
  type DlqEntry,
  type DlqStatus,
} from "../db/run-dlq.js";
import {
  hasDurableExecution,
  resumeDurableRunExecution,
  type ResumeDurableExecutionOptions,
} from "./run-panel-api.js";

/** Фильтр списка: конкретный статус или все записи. */
export type DlqFilter = DlqStatus | "all";

export interface DlqListResult {
  success: boolean;
  entries: DlqEntry[];
  /** Сколько записей открыто (для бейджа в заголовке панели). */
  open: number;
  error?: string;
}

export interface DlqActionResult {
  success: boolean;
  error?: string;
  entry?: DlqEntry;
  runId?: string;
  stepName?: string;
  /** true, если retry переоткрыл упавший запуск. */
  runReopened?: boolean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Неизвестный статус трактуем как `open`: безопасный дефолт очереди. */
export function normalizeDlqFilter(value: unknown): DlqFilter {
  return value === "all" || value === "retried" || value === "discarded" || value === "open"
    ? value
    : "open";
}

function normalizeLimit(value: unknown, fallback = 100): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num < 1) return fallback;
  return Math.min(num, 500);
}

/** Список записей DLQ и счётчик открытых. */
export function listDlq(options: { status?: unknown; limit?: unknown } = {}): DlqListResult {
  try {
    const status = normalizeDlqFilter(options.status);
    return {
      success: true,
      entries: listDeadLetters({ status, limit: normalizeLimit(options.limit) }),
      open: countDeadLetters("open"),
    };
  } catch (err) {
    return { success: false, entries: [], open: 0, error: errorText(err) };
  }
}

/** Ручной retry: готовит шаг к выполнению и закрывает запись DLQ. */
export function retryDlq(id: string): DlqActionResult {
  try {
    const result = retryDeadLetter(id);
    return {
      success: true,
      entry: result.entry,
      runId: result.run.id,
      stepName: result.step.stepName,
      runReopened: result.runReopened,
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

export interface DlqExecutionResult extends DlqActionResult {
  /** Шаг, с которого resume продолжил цепочку. */
  resumedFrom?: string | null;
  /** Реально выполненные шаги. */
  executed?: string[];
  /** Первый упавший шаг, если доигрывание остановилось. */
  failedStep?: string | null;
}

/**
 * PL-97: retry из DLQ с немедленным выполнением шага.
 *
 * Дескриптор исполнения проверяется до мутаций: если его нет, запись остаётся
 * открытой и вызывающий получает понятную причину вместо «успешного» retry,
 * который ничего не 실행ит. При наличии дескриптора запись закрывается как
 * `retried`, шаг остаётся `failed` ровно до `beginStepAttempt`, чтобы attempt
 * увеличился один раз за повтор.
 */
export async function retryDlqExecution(
  id: string,
  options: ResumeDurableExecutionOptions = {},
): Promise<DlqExecutionResult> {
  try {
    const entry = getDeadLetter(id);
    if (!entry) return { success: false, error: `Запись DLQ не найдена: ${id}` };
    if (entry.status !== "open") {
      return { success: false, error: `Запись DLQ уже обработана: ${entry.status}` };
    }
    if (!hasDurableExecution(entry.runId)) {
      return {
        success: false,
        error: `У запуска ${entry.runId} нет metadata.durableExecution: автоматическое выполнение невозможно. Доступна подготовка через retryDlq.`,
      };
    }

    const prepared = retryDeadLetter(id, { deferStepStart: true });
    const resumed = await resumeDurableRunExecution(prepared.run.id, options);
    return {
      success: resumed.success,
      ...(resumed.error ? { error: resumed.error } : {}),
      entry: prepared.entry,
      runId: prepared.run.id,
      stepName: prepared.step.stepName,
      runReopened: prepared.runReopened,
      resumedFrom: resumed.resumedFrom,
      executed: resumed.executed,
      failedStep: resumed.failedStep,
    };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}

/** Осознанный отказ от повтора: запись закрывается, шаг остаётся failed. */
export function discardDlq(id: string, resolution = "discarded"): DlqActionResult {
  try {
    return { success: true, entry: discardDeadLetter(id, resolution) };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
