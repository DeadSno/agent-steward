import type { TriageDecision } from "./triage-chain.js";
import type { TriageInput } from "./triage.js";
import type { TriageShadowSettings } from "../settings.js";
import { isShadowActive } from "../settings.js";
import { readAuditLog, recordAudit } from "./audit.js";
import { getDb } from "../db/index.js";

/**
 * Аудит решений триажа (Спринт 31.8).
 *
 * Раньше решения хранились в памяти процесса `record-history`, который
 * завершается сразу после запуска, поэтому shadow-отчёт в реальной
 * эксплуатации всегда был пуст. Теперь каждое решение пишется в persistent
 * журнал `audit_log` (action = `triage.decision`), а shadow-отчёт читает его.
 *
 * Запись никогда не бросает исключение и не мешает доставке уведомления.
 */

export const TRIAGE_AUDIT_ACTION = "triage.decision";

/** Одно сохранённое решение триажа. */
export interface ShadowDecisionRecord {
  id: number;
  taskName: string;
  status: string;
  action: "notify" | "skip";
  source: TriageDecision["source"];
  ruleId?: string;
  failure?: TriageDecision["failure"];
  confidence?: number;
  latencyMs: number;
  attempts: number;
  /** Решение принято в shadow-периоде и не применялось к доставке. */
  shadow: boolean;
  /** Уведомление было реально подавлено (action === "skip" вне shadow). */
  suppressed: boolean;
  category?: string;
  severity?: string;
  reason?: string;
  /** Решение принято фоновым процессом уже после доставки (31.7). */
  async?: boolean;
  ts: string;
}

export interface TriageOutcomeOptions {
  /** Shadow-период активен: решение только фиксируется, но не применяется. */
  shadowActive?: boolean;
  /** Уведомление было подавлено по этому решению. */
  suppressed?: boolean;
  /** Решение принято фоновым процессом уже после доставки (31.7). */
  async?: boolean;
}

const ERROR_TEXT_LIMIT = 1000;

function truncate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value);
  return text.length > ERROR_TEXT_LIMIT
    ? `${text.slice(0, ERROR_TEXT_LIMIT)}…`
    : text;
}

function detailsOf(record: { details: unknown }): Record<string, any> {
  return record.details && typeof record.details === "object"
    ? (record.details as Record<string, any>)
    : {};
}

/**
 * Записывает решение триажа в persistent-аудит.
 *
 * Вызывать для режимов `rules`, `llm` и `auto`; для `off` решения нет.
 * Возвращает id записи или null, если журнал недоступен.
 */
export function recordTriageOutcome(
  input: TriageInput,
  decision: TriageDecision,
  options: TriageOutcomeOptions = {}
): number | null {
  const shadow = Boolean(options.shadowActive);
  const suppressed = Boolean(options.suppressed);
  return recordAudit({
    action: TRIAGE_AUDIT_ACTION,
    targetType: "task",
    target: input.taskName ?? "",
    actor: "system",
    source: "triage",
    details: {
      status: input.status ?? "",
      action: decision.action,
      source: decision.source,
      ruleId: decision.ruleId ?? null,
      failure: decision.failure ?? null,
      confidence: decision.verdict?.confidence ?? null,
      category: decision.verdict?.category ?? null,
      severity: decision.verdict?.severity ?? null,
      reason: decision.verdict?.reason ?? null,
      latencyMs: decision.latencyMs,
      attempts: decision.attempts,
      shadow,
      suppressed,
      async: Boolean(options.async),
      error: truncate(input.error),
      durationMs: input.durationMs ?? null,
      tokens: input.tokens ?? null,
      costUsd: input.costUsd ?? null,
    },
  });
}

/** Обратная совместимость: запись shadow-решения без деталей доставки. */
export function recordShadowDecision(
  input: TriageInput,
  decision: TriageDecision
): void {
  recordTriageOutcome(input, decision, { shadowActive: true });
}

/**
 * Читает решения триажа из аудита (новые сверху).
 *
 * `shadow` не фильтруется здесь: отчёт и тесты сами решают, нужны им только
 * shadow-записи или все решения.
 */
export function readTriageDecisions(
  filter: { since?: string; until?: string; taskName?: string; limit?: number } = {}
): ShadowDecisionRecord[] {
  const result = readAuditLog({
    action: TRIAGE_AUDIT_ACTION,
    target: filter.taskName,
    since: filter.since,
    until: filter.until,
    limit: filter.limit ?? 5000,
  });
  return result.records.map((record) => {
    const details = detailsOf(record);
    return {
      id: record.id,
      taskName: record.target ?? "",
      status: String(details.status ?? ""),
      action: details.action === "skip" ? "skip" : "notify",
      source: (details.source ?? "off") as TriageDecision["source"],
      ruleId: details.ruleId ?? undefined,
      failure: details.failure ?? undefined,
      confidence:
        typeof details.confidence === "number" ? details.confidence : undefined,
      latencyMs: Number(details.latencyMs) || 0,
      attempts: Number(details.attempts) || 0,
      shadow: details.shadow === true,
      suppressed: details.suppressed === true,
      category: details.category ?? undefined,
      severity: details.severity ?? undefined,
      reason: details.reason ?? undefined,
      async: details.async === true,
      ts: record.ts,
    };
  });
}

/** Сколько раз триаж хотел подавить уведомление в shadow-периоде. */
export function shadowSkipCount(): number {
  return readTriageDecisions().filter((d) => d.shadow && d.action === "skip")
    .length;
}

/** Сколько уведомлений всего прошло через shadow-фильтр. */
export function shadowTotalCount(): number {
  return readTriageDecisions().filter((d) => d.shadow).length;
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
  /** Записей больше лимита чтения — статистика неполная. */
  truncated: boolean;
}

/** Сформировать отчёт по persistent-журналу за текущий/прошлый период. */
export function shadowReport(
  shadow: TriageShadowSettings | undefined
): ShadowReport {
  const startedAt = shadow?.startedAt ?? null;
  const days = shadow?.days ?? 0;
  const until =
    startedAt && days > 0
      ? new Date(
          new Date(startedAt).getTime() + days * 24 * 60 * 60 * 1000
        ).toISOString()
      : undefined;

  const records = readTriageDecisions({
    since: startedAt ?? undefined,
    until,
    limit: 5000,
  }).filter((d) => d.shadow);

  const bySource: Record<string, number> = {};
  for (const d of records) {
    bySource[d.source] = (bySource[d.source] ?? 0) + 1;
  }
  const skips = records.filter((d) => d.action === "skip").length;

  return {
    active: isShadowActive(shadow),
    startedAt,
    days,
    total: records.length,
    skips,
    wouldSuppress: skips,
    bySource,
    decisions: records,
    truncated: records.length >= 5000,
  };
}

/**
 * Очищает только shadow-записи триажа. Обычный аудит решений (не shadow)
 * остаётся, чтобы сброс отчёта не уничтожал историю эксплуатации.
 */
export function resetShadowDecisions(): void {
  try {
    getDb()
      .prepare(
        `DELETE FROM audit_log
          WHERE action = ?
            AND json_extract(details_json, '$.shadow') = 1`
      )
      .run(TRIAGE_AUDIT_ACTION);
  } catch {
    // JSON1 недоступен или журнал ещё не создан — сбрасывать нечего.
  }
}
