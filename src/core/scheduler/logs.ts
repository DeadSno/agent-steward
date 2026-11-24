import fs from "node:fs/promises";
import path from "node:path";
import { LOG_DIR, sanitizeName } from "../../types.js";
import { listTasks } from "../../db/tasks-repo.js";
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
 * PL-67: нормализует имя для сравнения «короткое имя / полное имя».
 * `sanitizeName` уже приводит к нижнему регистру, транслитерирует кириллицу
 * и сводит пробелы/дефисы/спецсимволы к одному «-» — этого достаточно, чтобы
 * «ARCH-7», «arch-7» и «ARCH-7 - Approval queue» сравнивать одинаково.
 */
function logNameSlug(name: string): string {
  return sanitizeName(name);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * PL-67: резолвит путь к логу по короткому/префиксному имени задачи.
 *
 * Приоритет выбора (первый сработавший):
 *   1) прямой файл `<slug>.log` — сохранение текущего поведения полных имён;
 *   2) запись задачи в реестре, полное имя которой даёт существующий `<slug>.log`
 *      (короткое имя «ARCH-7» → «ARCH-7 - Approval queue» → arch-7-approval-queue.log);
 *   3) единственный файл по шаблону `<slug>*.log` в LOG_DIR (fallback, если
 *      реестр недоступен или задача в нём не записана);
 *   4) несколько файлов — самый короткий slug (ближе к запросу), затем по алфавиту.
 */
export async function resolveTaskLogPath(name: string): Promise<string> {
  const slug = logNameSlug(name);
  const directPath = path.join(LOG_DIR, `${slug}.log`);
  if (await fileExists(directPath)) return directPath;

  // 2) реестр задач. node:sqlite может отсутствовать/БД быть недоступна —
  // в этом случае тихо переходим к поиску по файлам логов.
  let fullNames: string[] = [];
  try {
    fullNames = listTasks()
      .map((task) => task.name)
      .filter((taskName) => typeof taskName === "string" && !!taskName.trim())
      .filter((taskName) => {
        const taskSlug = logNameSlug(taskName);
        return taskSlug === slug || taskSlug.startsWith(`${slug}-`);
      });
  } catch {
    fullNames = [];
  }

  let logBases: string[] = [];
  try {
    const entries = await fs.readdir(LOG_DIR, { withFileTypes: true });
    logBases = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => entry.name.slice(0, -4));
  } catch {
    return directPath;
  }

  for (const fullName of fullNames) {
    const base = logNameSlug(fullName);
    if (logBases.includes(base)) {
      return path.join(LOG_DIR, `${base}.log`);
    }
  }

  const matches = logBases.filter(
    (base) => base === slug || base.startsWith(`${slug}-`),
  );
  if (matches.length > 0) {
    matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
    return path.join(LOG_DIR, `${matches[0]}.log`);
  }

  return directPath;
}

/**
 * Читает файл лога задачи и возвращает последние 50 строк.
 *
 * Лог пишут обёртки (PowerShell на Windows, bash на POSIX) в
 * ${LOG_DIR}/<sanitizedName>.log — тот же путь, что передаётся при создании.
 * PL-67: если прямой файл отсутствует, путь резолвится по реестру задач
 * либо по шаблону `<slug>*.log` (короткое/префиксное имя).
 */
export async function getTaskLogs(
  name: string,
  limit = 50,
): Promise<{ logs: string; error?: string }> {
  const logPath = await resolveTaskLogPath(name);
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
