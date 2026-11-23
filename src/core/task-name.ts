import { existsSync } from "node:fs";
import path from "node:path";
import {
  PLUGIN_DIR,
  WRAPPER_DIR,
  sanitizeName,
  validateModelId,
} from "../types.js";

/**
 * P1-10: разные имена задач могут сжаться в один sanitized-идентификатор
 * («my task» и «my-task» → «my-task»), после чего делят wrapper, prompt,
 * lock и log. При создании новой задачи такую коллизию нужно отклонить,
 * иначе вторая задача молча перезапишет файлы первой.
 */
export type SanitizedConflict =
  | { kind: "task"; taskName: string }
  | { kind: "file"; file: string };

/**
 * Ищет конфликт sanitized-имени среди существующих задач и их артефактов.
 *
 * @param name          имя создаваемой задачи;
 * @param existingNames имена уже существующих задач (без самой создаваемой);
 * @param artifactExists проверка существования файла — подменяется в тестах.
 */
export function findSanitizedNameConflict(
  name: string,
  existingNames: readonly string[],
  artifactExists: (file: string) => boolean = existsSync,
): SanitizedConflict | null {
  const sanitized = sanitizeName(name);
  const self = name.toLowerCase();

  const dbConflict = existingNames.find(
    (existing) =>
      existing.toLowerCase() !== self && sanitizeName(existing) === sanitized,
  );
  if (dbConflict) {
    return { kind: "task", taskName: dbConflict };
  }

  // Осиротевшие артефакты: в БД задачи уже нет, но файлы остались.
  // Перезапись промпта/обёртки молча сломала бы такую задачу.
  const artifacts = [
    path.join(WRAPPER_DIR, `run-${sanitized}.cmd`),
    path.join(WRAPPER_DIR, `run-${sanitized}.sh`),
    path.join(PLUGIN_DIR, "prompts", `${sanitized}.txt`),
  ];
  const orphan = artifacts.find((file) => artifactExists(file));
  if (orphan) {
    return { kind: "file", file: orphan };
  }
  return null;
}

/**
 * PL-54: проверка текста задачи (имени, промпта, аргументов CLI), который
 * попадает в командную строку Windows. Перевод строки разрывает команду,
 * а NUL обрезает аргумент — оба случая нужно отклонять до запуска, а не
 * допускать молчаливой подмены промпта. Двойные кавычки допустимы: их
 * экранирует `quoteCmdArg()` в `opencode-cli.ts`.
 */
export function validateCmdLineText(
  text: string,
  what = "Аргумент",
): string | null {
  if (/[\r\n]/.test(text)) {
    return `${what} командной строки не может содержать перевод строки`;
  }
  if (text.includes("\0")) {
    return `${what} командной строки не может содержать NUL`;
  }
  return null;
}

/**
 * PL-74/PL-88: примеры моделей для подсказки при неверном формате.
 * `opencode/hy4-flash-free` — рабочая модель текущего окружения; её префикс
 * обязателен: OpenCode отвергает голое `hy4-flash-free` как
 * `Invalid model reference: hy4-flash-free` ещё до запуска агента.
 */
export const MODEL_FORMAT_EXAMPLES = [
  "opencode/hy4-flash-free",
  "anthropic/claude-3-5-sonnet",
  "openai/gpt-4o",
] as const;

/**
 * PL-74/PL-88: общая валидация ссылки на модель — `provider/model` (необязательно
 * с вариантом `provider/model#variant`). Пустая строка означает «модель не
 * задана, использовать модель по умолчанию» и допустима.
 *
 * `validateModelId()` отвечает только за безопасность командной строки; здесь
 * дополнительно требуется непустой префикс провайдера, без которого запуск
 * агента падает. Возвращает понятную ошибку с подсказкой доступных моделей
 * (список можно получить командой `opencode models`).
 */
export function validateModelReference(
  raw: string | null | undefined,
): string | null {
  const model = (raw ?? "").trim();
  if (!model) return null;

  const unsafe = validateModelId(model);
  if (unsafe) return unsafe;

  const withoutVariant = model.split("#", 1)[0] ?? "";
  const slash = withoutVariant.indexOf("/");
  if (slash <= 0 || slash === withoutVariant.length - 1) {
    return (
      `Модель «${raw}» указана без префикса провайдера. ` +
      `Используйте формат "provider/model", например: ${MODEL_FORMAT_EXAMPLES.join(", ")}. ` +
      "Доступные модели смотрите командой `opencode models` (например, " +
      `${MODEL_FORMAT_EXAMPLES[0]}).`
    );
  }
  return null;
}

/** Человекочитаемое объяснение конфликта для ошибки создания задачи. */
export function sanitizedConflictMessage(
  name: string,
  conflict: SanitizedConflict,
): string {
  const sanitized = sanitizeName(name);
  const reason =
    conflict.kind === "task"
      ? `существующая задача «${conflict.taskName}»`
      : `оставшиеся файлы задачи (${conflict.file})`;
  return (
    `Имя задачи «${name}» приводит к тому же имени файла «${sanitized}», ` +
    `что и ${reason}. Выберите другое имя` +
    (conflict.kind === "file" ? " или удалите старые файлы." : ".")
  );
}
