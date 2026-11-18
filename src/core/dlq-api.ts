/**
 * GUI/RPC-фасад над dead-letter queue (Спринт 36.6).
 *
 * Тонкий слой между `src/db/run-dlq.ts` и RPC: приводит вход от GUI к
 * безопасным значениям (статус, лимит), не даёт панике БД выйти наружу и
 * возвращает единый `{ success, error }`-контракт. Логика очереди (идемпотентный
 * enqueue, retry через reopenRun, discard) остаётся в БД-слое.
 *
 * Retry здесь только готовит шаг к повторному выполнению: переоткрывает запуск,
 * переводит шаг в `running` и закрывает запись DLQ. Сам обработчик шага
 * запускает resume (Спринт 36.7), поэтому фасад не притворяется, что шаг уже
 * выполнен.
 */
import {
  countDeadLetters,
  discardDeadLetter,
  listDeadLetters,
  retryDeadLetter,
  type DlqEntry,
  type DlqStatus,
} from "../db/run-dlq.js";

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

/** Осознанный отказ от повтора: запись закрывается, шаг остаётся failed. */
export function discardDlq(id: string, resolution = "discarded"): DlqActionResult {
  try {
    return { success: true, entry: discardDeadLetter(id, resolution) };
  } catch (err) {
    return { success: false, error: errorText(err) };
  }
}
