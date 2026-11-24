/**
 * Деталь 3.19 / S-5: верифицированный чат.
 *
 * Правило simple and strict: ответ пользователю отдаётся ТОЛЬКО если к нему
 * приложено проверяемое доказательство — объективный гейт (команда/тест),
 * ссылка на источник с цитатой или уже верифицированный gate-passed рецепт.
 * Самооценка модели, пустая ссылка и непройденный гейт ответ не открывают.
 *
 * Модуль чистый: не читает БД, диск, сеть, не запускает команды и не импортирует
 * `@opencode-*`. Проверка рецепта переиспользует `verifyRecipe()` из S-4.
 * Важное ограничение честно описано в docs/VERIFIED-CHAT.md: источник проверяется
 * по структуре (есть путь/якорь и цитата), а не перечитывается заново — реальное
 * совпадение цитаты с текстом источника остаётся ответственностью вызывающей
 * стороны. Объективный гейт — более сильное доказательство.
 */
import { getRecipe, verifyRecipe } from "./recipes.js";

/** Версия формата решения чата. Меняется при изменении политики доказательств. */
export const VERIFIED_CHAT_VERSION = "1.0";

/** Машинный идентификатор формата. */
export const VERIFIED_CHAT_FORMAT = "agent-steward.verified-chat";

/** Методика, которую CLI печатает рядом с решением. */
export const VERIFIED_CHAT_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/VERIFIED-CHAT.md#methodology";

/** Объективный гейт: решение вынесено кодом, а не текстом модели. */
export interface ChatGateEvidence {
  kind: "gate";
  /** Идентификатор проверки (обычно имя test-*.mjs). */
  source: string;
  /** Команда, которая была реально выполнена. */
  command: string;
  passed: true;
  objective: true;
  /** ISO-8601 дата зафиксированного прогона. */
  recordedAt: string;
  /** Коммит, в котором гейт пройден (необязательно). */
  commit?: string;
}

/** Ссылка на источник: путь/якорь и цитата, на которой основан ответ. */
export interface ChatSourceEvidence {
  kind: "source";
  /** Файл или URL источника. */
  source: string;
  /** Секция, строка или якорь внутри источника. */
  locator: string;
  /** Дословная цитата, которую использует ответ. */
  quote: string;
  /** ISO-8601 дата проверки/source reading. */
  checkedAt: string;
}

export type VerifiedChatEvidence = ChatGateEvidence | ChatSourceEvidence;

/** Вход чата: текст ответа и доказательства, которые его открывают. */
export interface VerifiedChatInput {
  answer: string;
  evidence: VerifiedChatEvidence[];
  /** id рецепта из S-4, гейты которого уже проверены `verifyRecipe()`. */
  recipeId?: string;
}

export interface VerifiedChatOptions {
  /** Сколько принятых доказательств нужно для выдачи ответа (по умолчанию 1). */
  minEvidence?: number;
}

/** Решение верификатора: ответ или мотивированный отказ. */
export interface VerifiedChatDecision {
  kind: "verified-chat";
  version: string;
  format: string;
  methodologyUrl: string;
  /** true только когда ответ можно показать пользователю. */
  delivered: boolean;
  /** Ответ или null при отказе. */
  answer: string | null;
  /** Причина отказа или null при выдаче. */
  refusal: string | null;
  accepted: {
    gates: number;
    sources: number;
    recipes: number;
  };
  evidenceCount: number;
  /** Почему доказательства приняты/отвергнуты; пусто при успешной выдаче. */
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDate(value: unknown): value is string {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Проверяет доказательства и решает, можно ли отдать ответ.
 * Любое невалидное доказательство или рецепт означает отказ — политика
 * "ответ только с проверкой" не допускает частичной веры непроверенному.
 */
export function verifyChatAnswer(
  input: VerifiedChatInput,
  options?: VerifiedChatOptions,
): VerifiedChatDecision {
  if (!isRecord(input)) {
    throw new Error("S-5: вход должен быть объектом с полями answer и evidence.");
  }
  if (!nonEmpty(input.answer)) {
    throw new Error("S-5: answer должен быть непустой строкой.");
  }
  if (!Array.isArray(input.evidence)) {
    throw new Error("S-5: evidence должен быть массивом доказательств.");
  }

  const minEvidence = options?.minEvidence ?? 1;
  if (!Number.isInteger(minEvidence) || minEvidence < 1) {
    throw new Error("S-5: minEvidence должен быть положительным целым числом.");
  }

  const reasons: string[] = [];
  const accepted = { gates: 0, sources: 0, recipes: 0 };

  for (const [index, item] of input.evidence.entries()) {
    const label = `Доказательство #${index}`;
    if (!isRecord(item) || (item.kind !== "gate" && item.kind !== "source")) {
      reasons.push(`${label}: неизвестный вид доказательства.`);
      continue;
    }

    if (item.kind === "gate") {
      const gate = item as ChatGateEvidence;
      const commitOk = gate.commit === undefined || /^[0-9a-f]{7,40}$/i.test(gate.commit);
      if (
        gate.passed === true &&
        gate.objective === true &&
        nonEmpty(gate.source) &&
        nonEmpty(gate.command) &&
        isIsoDate(gate.recordedAt) &&
        commitOk
      ) {
        accepted.gates += 1;
      } else {
        reasons.push(
          `${label}: гейт должен быть objective/passed с источником, командой и ISO-датой.`,
        );
      }
      continue;
    }

    const source = item as ChatSourceEvidence;
    if (
      nonEmpty(source.source) &&
      nonEmpty(source.locator) &&
      nonEmpty(source.quote) &&
      isIsoDate(source.checkedAt)
    ) {
      accepted.sources += 1;
    } else {
      reasons.push(
        `${label}: источник должен содержать путь, якорь, цитату и ISO-дату проверки.`,
      );
    }
  }

  if (input.recipeId !== undefined) {
    if (!nonEmpty(input.recipeId)) {
      reasons.push("Указан пустой recipeId.");
    } else {
      const recipe = getRecipe(input.recipeId);
      if (!recipe) {
        reasons.push(`Рецепт «${input.recipeId}» не найден в библиотеке gate-passed рецептов.`);
      } else {
        const verification = verifyRecipe(recipe);
        if (!verification.ok) {
          for (const reason of verification.reasons) {
            reasons.push(`Рецепт «${input.recipeId}»: ${reason}`);
          }
        } else {
          accepted.recipes += 1;
        }
      }
    }
  }

  const totalAccepted = accepted.gates + accepted.sources + accepted.recipes;
  if (reasons.length === 0 && totalAccepted < minEvidence) {
    reasons.push(
      `Недостаточно проверенных доказательств: ${totalAccepted} из ${minEvidence}.`,
    );
  }

  const delivered = reasons.length === 0;
  return {
    kind: "verified-chat",
    version: VERIFIED_CHAT_VERSION,
    format: VERIFIED_CHAT_FORMAT,
    methodologyUrl: VERIFIED_CHAT_METHODOLOGY_URL,
    delivered,
    answer: delivered ? input.answer : null,
    refusal: delivered ? null : (reasons[0] ?? "Ответ не подтверждён доказательствами."),
    accepted,
    evidenceCount: input.evidence.length,
    reasons,
  };
}
