/**
 * Сравнение решений триажа «до/после» (Спринт 31.5).
 *
 * Для одного события уведомления прогоняет цепочку триажа под двумя наборами
 * настроек (текущие «before» и предлагаемые «after») и возвращает_diff_
 * вердиктов, правил и итоговых сообщений. Это позволяет визуализировать
 * эффект изменения правил или порога перед тем, как сохранить новые настройки.
 *
 * Модуль чистый (нет БД и HTTP), легко тестируется на фиксированных данных.
 * `decideTriage` асинхронный, поэтому сама функция тоже асинхронная.
 */
import { decideTriage, type TriageDecision } from "./triage-chain.js";
import type { TriageInput } from "./triage.js";
import type { TriageSettings } from "../settings.js";
import { formatNotificationMessage } from "../notifications.js";

/** Одно решение триажа с итоговым сообщением, которое было бы доставлено. */
export interface ComparedDecision {
  action: TriageDecision["action"];
  source: TriageDecision["source"];
  /** id сработавшего правила, если было. */
  ruleId?: string;
  failure?: TriageDecision["failure"];
  verdict?: {
    category: string;
    severity: string;
    confidence: number;
    reason: string;
  };
  attempts: number;
  latencyMs: number;
  /** Сообщение, которое было бы доставлено (или подавлялось бы). */
  message: string;
  /** Будет ли уведомление подавлено (не доставлено). */
  suppressed: boolean;
}

/** Разница между «before» и «after» для одного поля. */
interface FieldDiff<Value> {
  before: Value | null;
  after: Value | null;
  changed: boolean;
}

/** Итоговое сравнение для GUI-кнопки «Сравнить». */
export interface CompareTriageResult {
  input: TriageInput;
  before: ComparedDecision;
  after: ComparedDecision;
  /** Что изменилось между before и after. */
  diff: {
    action: FieldDiff<TriageDecision["action"]>;
    source: FieldDiff<TriageDecision["source"]>;
    ruleId: FieldDiff<string | undefined>;
    failure: FieldDiff<string | undefined>;
    confidence: FieldDiff<number | undefined>;
    category: FieldDiff<string | undefined>;
    severity: FieldDiff<string | undefined>;
    reason: FieldDiff<string | undefined>;
    suppressed: FieldDiff<boolean>;
    message: FieldDiff<string>;
  };
}

/** Поле изменилось? */
function changed<Value>(before: Value, after: Value): boolean {
  return before !== after;
}

function verdictOf(decision: TriageDecision): ComparedDecision["verdict"] {
  if (!decision.verdict) return undefined;
  return {
    category: decision.verdict.category,
    severity: decision.verdict.severity,
    confidence: decision.verdict.confidence,
    reason: decision.verdict.reason,
  };
}

/** Построить ComparedDecision из решения триажа. */
function toCompared(
  input: TriageInput,
  decision: TriageDecision,
  baseMessage: string,
  dedupCount: number
): ComparedDecision {
  const suppressed = decision.action === "skip";
  const message = suppressed
    ? baseMessage
    : baseMessage + (dedupCount > 1 ? " " + dedupCountSuffix(dedupCount) : "");
  return {
    action: decision.action,
    source: decision.source,
    ruleId: decision.ruleId,
    failure: decision.failure,
    verdict: verdictOf(decision),
    attempts: decision.attempts,
    latencyMs: decision.latencyMs,
    message,
    suppressed,
  };
}

function dedupCountSuffix(count: number): string {
  return `(повтор ${count})`;
}

/**
 * Прогоняет триаж под двумя наборами настроек и считает diff.
 *
 * `dedupCount` — сколько повторов уже есть для этой пары задача+статус
 * (используется только для сообщения).
 */
export async function compareTriage(
  input: TriageInput,
  beforeSettings: TriageSettings | undefined,
  afterSettings: TriageSettings | undefined,
  dedupCount = 1
): Promise<CompareTriageResult> {
  const durationMs =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? input.durationMs
      : 0;
  const baseMessage = formatNotificationMessage(
    {
      taskName: input.taskName,
      status: input.status,
      durationMs,
      error: input.error ?? undefined,
      tokens: input.tokens ?? undefined,
      costUsd: input.costUsd ?? undefined,
    },
    undefined
  );

  const [beforeDecision, afterDecision] = await Promise.all([
    decideTriage(input, beforeSettings),
    decideTriage(input, afterSettings),
  ]);

  const before = toCompared(input, beforeDecision, baseMessage, dedupCount);
  const after = toCompared(input, afterDecision, baseMessage, dedupCount);

  return {
    input,
    before,
    after,
    diff: {
      action: {
        before: before.action,
        after: after.action,
        changed: changed(before.action, after.action),
      },
      source: {
        before: before.source,
        after: after.source,
        changed: changed(before.source, after.source),
      },
      ruleId: {
        before: before.ruleId ?? null,
        after: after.ruleId ?? null,
        changed: changed(before.ruleId ?? null, after.ruleId ?? null),
      },
      failure: {
        before: before.failure ?? null,
        after: after.failure ?? null,
        changed: changed(before.failure ?? null, after.failure ?? null),
      },
      confidence: {
        before: before.verdict?.confidence ?? null,
        after: after.verdict?.confidence ?? null,
        changed: changed(
          before.verdict?.confidence ?? null,
          after.verdict?.confidence ?? null
        ),
      },
      category: {
        before: before.verdict?.category ?? null,
        after: after.verdict?.category ?? null,
        changed: changed(
          before.verdict?.category ?? null,
          after.verdict?.category ?? null
        ),
      },
      severity: {
        before: before.verdict?.severity ?? null,
        after: after.verdict?.severity ?? null,
        changed: changed(
          before.verdict?.severity ?? null,
          after.verdict?.severity ?? null
        ),
      },
      reason: {
        before: before.verdict?.reason ?? null,
        after: after.verdict?.reason ?? null,
        changed: changed(
          before.verdict?.reason ?? null,
          after.verdict?.reason ?? null
        ),
      },
      suppressed: {
        before: before.suppressed,
        after: after.suppressed,
        changed: before.suppressed !== after.suppressed,
      },
      message: {
        before: before.message,
        after: after.message,
        changed: before.message !== after.message,
      },
    },
  };
}
