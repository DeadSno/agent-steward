import {
  classifyNotification,
  type TriageFailure,
  type TriageInput,
  type TriageOptions,
  type TriageVerdict,
} from "./triage.js";
import { evaluateTriageRules } from "./triage-rules.js";
import { recordTriageOutcome } from "./triage-shadow.js";
import { isShadowActive, type TriageSettings } from "../settings.js";

/** Что делать с уведомлением после триажа. */
export type TriageAction = "notify" | "skip";

/** Откуда взято решение — для shadow-режима и диагностики. */
export type TriageSource = "off" | "llm" | "rules" | "fallback";

/** Итог цепочки LLM → правила → fail-open. */
export interface TriageDecision {
  action: TriageAction;
  source: TriageSource;
  verdict?: TriageVerdict;
  /** Причина, по которой LLM не дал пригодного вердикта. */
  failure?: TriageFailure | "low-confidence";
  attempts: number;
  latencyMs: number;
  /** id сработавшего правила, если решение приняли правила. */
  ruleId?: string;
}

const NOTIFY: TriageAction = "notify";

function ruleDecision(
  input: TriageInput,
  settings: TriageSettings,
  source: TriageSource
): TriageDecision {
  const result = evaluateTriageRules(input, settings.rules);
  return {
    action: result.action,
    source,
    verdict: result.verdict,
    attempts: 0,
    latencyMs: 0,
    ruleId: result.ruleId,
  };
}

/**
 * Применяет цепочку деградации к одному уведомлению.
 *
 * - `off` — триаж выключен, уведомление отправляется.
 * - `rules` — решают только правила; нет совпадения = отправить.
 * - `llm`/`auto` — LLM классифицирует, но сам ничего не подавляет; при
 *   ошибке, таймауте или низкой уверенности управление переходит к правилам
 *   (если `fallback: "rules"`) либо уведомление отправляется без правил
 *   (`fallback: "notify"`; устаревшее имя — `"skip"`).
 *
 * Функция никогда не бросает исключение и по умолчанию возвращает `notify`:
 * недоступный классификатор не должен терять уведомление.
 */
export async function decideTriage(
  input: TriageInput,
  settings: TriageSettings | undefined,
  options: TriageOptions = {}
): Promise<TriageDecision> {
  if (!settings || settings.mode === "off") {
    return { action: NOTIFY, source: "off", attempts: 0, latencyMs: 0 };
  }

  if (settings.mode === "rules") {
    return ruleDecision(input, settings, "rules");
  }

  const llm = await classifyNotification(input, settings, options);
  if (llm.ok && llm.verdict && llm.verdict.confidence >= settings.confidenceThreshold) {
    return {
      action: NOTIFY,
      source: "llm",
      verdict: llm.verdict,
      attempts: llm.attempts,
      latencyMs: llm.latencyMs,
    };
  }

  const failure: TriageFailure | "low-confidence" = llm.ok
    ? "low-confidence"
    : llm.failure ?? "invalid-response";

  if (settings.fallback === "notify" || settings.fallback === "skip") {
    return {
      action: NOTIFY,
      source: "fallback",
      failure,
      attempts: llm.attempts,
      latencyMs: llm.latencyMs,
    };
  }

  const byRules = ruleDecision(input, settings, "fallback");
  return {
    ...byRules,
    failure,
    attempts: llm.attempts,
    latencyMs: llm.latencyMs,
  };
}

/**
 * Записывает решение в shadow-журнал, если shadow-режим активен.
 *
 * Оставлено для обратной совместимости; `notifyTaskCompletion` пишет все
 * решения через `recordTriageOutcome` (31.8).
 */
export function recordShadow(
  input: TriageInput,
  decision: TriageDecision,
  shadow: TriageSettings["shadow"] | undefined
): void {
  if (!shadow || !shadow.enabled) return;
  recordTriageOutcome(input, decision, {
    shadowActive: isShadowActive(shadow),
    suppressed: false,
  });
}
