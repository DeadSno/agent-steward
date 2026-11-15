import type { TriageDecision } from "./triage-chain.js";
import type { TriageInput } from "./triage.js";
import type { TriageShadowSettings } from "../settings.js";
import { isShadowActive } from "../settings.js";

/**
 * Shadow-режим триажа (Спринт 30.6).
 *
 * Решения триажа фиксируются в памяти, но уведомления не подавляются.
 * Ведётся счётчик «false-skip» — сколько раз триаж хотел бы подавить
 * уведомление (action === "skip"), и сколько уведомлений в сумме
 * прошли бы через shadow-фильтр.
 */

/** Одно зафиксированное shadow-решение. */
export interface ShadowDecisionRecord {
  taskName: string;
  status: string;
  action: "notify" | "skip";
  source: TriageDecision["source"];
  ruleId?: string;
  failure?: TriageDecision["failure"];
  confidence?: number;
  latencyMs: number;
  ts: string;
}

/** Накопленные shadow-решения (в памяти, сбрасываются при перезапуске процесса). */
const shadowDecisions: ShadowDecisionRecord[] = [];

/**
 * Записывает shadow-решение. Не выбрасывает исключений.
 */
export function recordShadowDecision(
  input: TriageInput,
  decision: TriageDecision
): void {
  shadowDecisions.push({
    taskName: input.taskName ?? "",
    status: input.status ?? "",
    action: decision.action,
    source: decision.source,
    ruleId: decision.ruleId,
    failure: decision.failure,
    confidence: decision.verdict?.confidence,
    latencyMs: decision.latencyMs,
    ts: new Date().toISOString(),
  });
}

/** Сколько раз триаж хотел подавить уведомление (action === "skip"). */
export function shadowSkipCount(): number {
  return shadowDecisions.filter((d) => d.action === "skip").length;
}

/** Сколько уведомлений всего прошло через shadow-фильтр. */
export function shadowTotalCount(): number {
  return shadowDecisions.length;
}

/** Полный отчёт по shadow-режиму. */
export interface ShadowReport {
  active: boolean;
  startedAt: string | null;
  days: number;
  total: number;
  skips: number;
  wouldSuppress: number; // === skips (потенциально подавленные уведомления)
  bySource: Record<string, number>;
  decisions: ShadowDecisionRecord[];
}

/** Сформировать отчёт. */
export function shadowReport(
  shadow: TriageShadowSettings | undefined
): ShadowReport {
  const bySource: Record<string, number> = {};
  for (const d of shadowDecisions) {
    bySource[d.source] = (bySource[d.source] ?? 0) + 1;
  }
  return {
    active: isShadowActive(shadow),
    startedAt: shadow?.startedAt ?? null,
    days: shadow?.days ?? 0,
    total: shadowTotalCount(),
    skips: shadowSkipCount(),
    wouldSuppress: shadowSkipCount(),
    bySource,
    decisions: [...shadowDecisions],
  };
}

/** Очистить накопленные shadow-решения (для тестов и сброса отчёта). */
export function resetShadowDecisions(): void {
  shadowDecisions.length = 0;
}
