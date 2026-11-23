import { existsSync } from "node:fs";
import path from "node:path";
import { PLUGIN_DIR, WRAPPER_DIR, sanitizeName } from "../types.js";

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
  if (/\0/.test(text)) {
    return `${what} командной строки не может содержать NUL`;
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
