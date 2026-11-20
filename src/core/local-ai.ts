import type {
  TriageFallback,
  TriageMode,
  TriageSettings,
  TriageShadowSettings,
} from "../settings.js";
import { DEFAULT_SHADOW_DAYS, isShadowActive } from "../settings.js";

/**
 * Настройки локального ассистента (Спринт 30.7 `manage_local_ai`).
 *
 * Здесь только чистые функции: слияние патча с текущими настройками
 * триажа, нормализация значений и человекочитаемая сводка. Никаких
 * сетевых вызовов и записи на диск — их делают инструмент и GUI.
 */

export const LOCAL_AI_TIMEOUT_MIN = 1_000;
export const LOCAL_AI_TIMEOUT_MAX = 120_000;
export const LOCAL_AI_SELF_TEST_PROMPT =
  "Тест связи: задача завершилась ошибкой Quality Gate (2 упавших теста).";

/** Патч настроек: любое подмножество полей. */
export interface LocalAiPatch {
  mode?: TriageMode;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fallback?: TriageFallback;
  confidenceThreshold?: number;
  shadow?: Partial<TriageShadowSettings>;
}

/** Сводка настроек для ответа инструмента и GUI. */
export interface LocalAiSummary {
  mode: TriageMode;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fallback: TriageFallback;
  confidenceThreshold: number;
  /** Сколько пользовательских правил задано; null — встроенный набор. */
  rules: number | null;
  shadow: TriageShadowSettings;
  /** Триаж реально спрашивает модель (mode llm/auto и заполнены baseUrl+model). */
  llmReady: boolean;
  /** Идёт shadow-период: решения пишутся в отчёт, но не подавляют. */
  shadowActive: boolean;
  /** Протокол по baseUrl: `.../v1` — OpenAI-совместимый, иначе Ollama. */
  protocol: "openai" | "ollama";
}

/**
 * QA-P2.2: clamp НЕ округляет — confidenceThreshold дробный (0..1).
 * Целочисленные поля (timeoutMs, shadow.days) округляются в местах вызова.
 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** Протокол по базовому URL — то же правило, что в `classifyNotification`. */
export function protocolFor(baseUrl: string): "openai" | "ollama" {
  const trimmed = trimUrl(baseUrl);
  return /\/v1$/i.test(trimmed) ? "openai" : "ollama";
}

/**
 * Сливает патч с текущими настройками. Возвращает новые настройки и
 * список имён изменённых полей (для ответа инструмента и аудита).
 */
export function applyLocalAiPatch(
  current: TriageSettings,
  patch: LocalAiPatch,
): { settings: TriageSettings; changed: string[] } {
  const next: TriageSettings = { ...current, shadow: { ...current.shadow } as TriageShadowSettings };
  const changed: string[] = [];

  if (patch.mode !== undefined && patch.mode !== current.mode) {
    next.mode = patch.mode;
    changed.push("mode");
  }
  if (patch.baseUrl !== undefined) {
    const baseUrl = trimUrl(patch.baseUrl);
    if (baseUrl !== current.baseUrl) {
      next.baseUrl = baseUrl;
      changed.push("baseUrl");
    }
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim().slice(0, 200);
    if (model !== current.model) {
      next.model = model;
      changed.push("model");
    }
  }
  if (patch.timeoutMs !== undefined) {
    const timeoutMs = clamp(
      Math.round(patch.timeoutMs),
      LOCAL_AI_TIMEOUT_MIN,
      LOCAL_AI_TIMEOUT_MAX,
      current.timeoutMs,
    );
    if (timeoutMs !== current.timeoutMs) {
      next.timeoutMs = timeoutMs;
      changed.push("timeoutMs");
    }
  }
  if (patch.fallback !== undefined && patch.fallback !== current.fallback) {
    next.fallback = patch.fallback;
    changed.push("fallback");
  }
  if (patch.confidenceThreshold !== undefined) {
    const threshold = clamp(patch.confidenceThreshold, 0, 1, current.confidenceThreshold);
    if (threshold !== current.confidenceThreshold) {
      next.confidenceThreshold = threshold;
      changed.push("confidenceThreshold");
    }
  }
  const shadow = next.shadow ?? {
    enabled: false,
    days: DEFAULT_SHADOW_DAYS,
    startedAt: null,
  };
  const shadowPatch = patch.shadow;
  if (shadowPatch && typeof shadowPatch === "object") {
    if (shadowPatch.enabled !== undefined && Boolean(shadowPatch.enabled) !== shadow.enabled) {
      shadow.enabled = Boolean(shadowPatch.enabled);
      changed.push("shadow.enabled");
    }
    if (shadowPatch.days !== undefined) {
      const days = clamp(Math.round(shadowPatch.days), 1, 365, shadow.days);
      if (days !== shadow.days) {
        shadow.days = days;
        changed.push("shadow.days");
      }
    }
    if (shadowPatch.startedAt !== undefined && shadowPatch.startedAt !== shadow.startedAt) {
      shadow.startedAt = shadowPatch.startedAt;
      changed.push("shadow.startedAt");
    }
  }
  next.shadow = shadow;

  return { settings: next, changed };
}

/** Компактная сводка настроек для ответа инструмента. */
export function summarizeLocalAi(settings: TriageSettings): LocalAiSummary {
  const shadow = settings.shadow ?? {
    enabled: false,
    days: DEFAULT_SHADOW_DAYS,
    startedAt: null,
  };
  const baseUrl = settings.baseUrl ?? "";
  const model = settings.model ?? "";
  return {
    mode: settings.mode,
    baseUrl,
    model,
    timeoutMs: settings.timeoutMs,
    fallback: settings.fallback,
    confidenceThreshold: settings.confidenceThreshold,
    rules: Array.isArray(settings.rules) ? settings.rules.length : null,
    shadow,
    llmReady:
      settings.mode !== "off" &&
      settings.mode !== "rules" &&
      baseUrl.trim().length > 0 &&
      model.trim().length > 0,
    shadowActive: isShadowActive(shadow),
    protocol: protocolFor(baseUrl),
  };
}
