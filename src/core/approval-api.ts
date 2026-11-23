/**
 * PL-95: фасад очереди одобрений для RPC и GUI.
 *
 * Очередь живёт в журнале аудита (ARCH-7.1), отдельной таблицы нет.
 * Фасад не меняет семантику `audit.ts`: он только ограничивает размер
 * выборки, проверяет ввод и возвращает предсказуемые ошибки вместо
 * исключений на границе RPC.
 */
import {
  decideApproval,
  getApproval,
  listApprovals,
  type ApprovalDecision,
  type ApprovalRecord,
} from "./audit.js";

export type ApprovalPanelRecord = ApprovalRecord;

export interface ApprovalPanelResult {
  success: boolean;
  approvals: ApprovalPanelRecord[];
  error?: string;
}

export interface ApprovalDecisionResult {
  success: boolean;
  approval?: ApprovalPanelRecord;
  error?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

/** Список запросов одобрения для панели (новые сверху, с ограничением). */
export function listApprovalPanel(options: { limit?: unknown } = {}): ApprovalPanelResult {
  try {
    return { success: true, approvals: listApprovals(clampLimit(options.limit)) };
  } catch (err) {
    return {
      success: false,
      approvals: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Принятие решения по запросу. Повторное решение не перезаписывает первое. */
export function decideApprovalPanel(
  requestId: unknown,
  decision: unknown,
  decidedBy?: unknown,
): ApprovalDecisionResult {
  if (typeof requestId !== "string" || requestId.trim() === "") {
    return { success: false, error: "requestId is required" };
  }
  if (decision !== "approve" && decision !== "reject") {
    return { success: false, error: "decision must be approve or reject" };
  }
  const id = requestId.trim();
  try {
    if (!getApproval(id)) {
      return { success: false, error: "approval request not found" };
    }
    const approval = decideApproval(id, decision as ApprovalDecision, {
      actor: typeof decidedBy === "string" && decidedBy.trim() ? decidedBy.trim() : "gui",
      source: "approval-panel",
    });
    if (!approval) {
      return { success: false, error: "approval request not found" };
    }
    return { success: true, approval };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
