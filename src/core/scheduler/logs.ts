import fs from "node:fs/promises";
import path from "node:path";
import { LOG_DIR, sanitizeName } from "../../types.js";
import { extractLastRunLog } from "../mission.js";

/** Codes returned by Windows/PowerShell while a log file is still held by the writer. */
export function isRetriableLogReadError(code: unknown): boolean {
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/** Retry fs.readFile while the writer still holds the log (emit_event / immediate get_task_logs race). */
export async function readLogWithRetry(
  logPath: string,
  attempts = 6,
  delayMs = 50,
): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fs.readFile(logPath, "utf8");
    } catch (err: unknown) {
      lastErr = err;
      if (
        !isRetriableLogReadError((err as NodeJS.ErrnoException).code) ||
        i === attempts - 1
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Читает файл лога задачи и возвращает последние 50 строк.
 *
 * Лог пишут обёртки (PowerShell на Windows, bash на POSIX) в
 * ${LOG_DIR}/<sanitizedName>.log — тот же путь, что передаётся при создании.
 */
export async function getTaskLogs(
  name: string,
  limit = 50,
): Promise<{ logs: string; error?: string }> {
  const logPath = path.join(LOG_DIR, `${sanitizeName(name)}.log`);
  try {
    // PowerShell 5.1 пишет UTF-8 с BOM — убираем его, чтобы GUI не показывал мусор.
    // Лог дописывается между запусками: показываем только последний прогон.
    const content = extractLastRunLog(await readLogWithRetry(logPath));
    const lines = content.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) {
      return {
        logs: "",
        error: `Лог задачи "${name}" пуст. Задача ещё не писала вывод — запустите её и повторите.`,
      };
    }
    const last = lines.slice(-Math.max(1, Math.min(limit, 1000)));
    return { logs: last.join("\n") };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        logs: "",
        error: `Лог задачи "${name}" не найден по пути ${logPath} (задача ещё не запускалась).`,
      };
    }
    return { logs: "", error: err instanceof Error ? err.message : String(err) };
  }
}
