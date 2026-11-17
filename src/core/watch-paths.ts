import { isAbsolute, normalize, relative, resolve } from "node:path";

/**
 * Правила безопасности для файловых триггеров.
 *
 * `watchPath` может быть абсолютным — это осознанный выбор пользователя
 * (например, наблюдать за логом вне репозитория). Относительный путь
 * резолвится от рабочей директории задачи и не должен выходить за её пределы.
 *
 * `watchGlobs` / `watchIgnore` — маски относительно `watchPath`, поэтому
 * абсолютные пути и сегменты `..` в них запрещены.
 */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function hasPathControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

/** Проверяет и нормализует watchPath; возвращает абсолютный путь. */
export function normalizeWatchPath(watchPath: string, baseDir: string): string {
  const trimmed = (watchPath ?? "").trim();
  if (!trimmed) {
    throw new Error("Путь наблюдения не может быть пустым.");
  }
  if (hasPathControlChars(trimmed)) {
    throw new Error("Путь наблюдения не должен содержать управляющих символов и переводов строк.");
  }

  // Абсолютный путь — явное намерение пользователя, оставляем как есть.
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return normalize(trimmed);
  }

  const resolved = resolve(baseDir, trimmed);
  const rel = relative(baseDir, resolved);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(
      `Путь наблюдения выходит за пределы рабочей директории задачи: "${trimmed}".`
    );
  }
  return resolved;
}

/** Проверяет glob-маски файлового триггера. Возвращает исходный список. */
export function validateWatchGlobs(globs?: string[]): string[] | undefined {
  if (!Array.isArray(globs)) return undefined;
  for (const glob of globs) {
    if (typeof glob !== "string") continue;
    const value = glob.trim();
    if (!value) continue;
    if (hasPathControlChars(value)) {
      throw new Error("Glob-маска не должна содержать управляющих символов и переводов строк.");
    }
    const unified = value.replace(/\\/g, "/");
    if (unified.startsWith("/") || /^[A-Za-z]:\//.test(unified)) {
      throw new Error(`Glob-маска должна быть относительной: "${value}".`);
    }
    if (unified.split("/").includes("..")) {
      throw new Error(`Glob-маска не должна выходить за пределы watchPath: "${value}".`);
    }
  }
  return globs;
}
