import { spawn } from "node:child_process";
import fs from "node:fs";
import type { RegistryEntry } from "./registry.js";
import { shellQuote } from "./posix.js";

/**
 * Fallback для one-shot задач, когда утилита `at` не установлена.
 *
 * Запускает отвязанный (detached) `/bin/bash`, который спит до `runAt` и
 * затем выполняет команду задачи. Это не полноценная замена `atd`:
 * - процесс не переживает перезагрузку машины;
 * - не переживает ручной kill;
 * - не виден в `atq`.
 * Поэтому fallback используется только как последнее средство и пишет
 * предупреждение в лог. Если `at` доступен — вызывается он.
 */

export interface DetachedOneShotSpawn {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  unref(): unknown;
  pid?: number;
}

export type DetachedOneShotSpawnFn = (
  file: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => DetachedOneShotSpawn;

export interface ScheduleAtFallbackDeps {
  spawnFn?: DetachedOneShotSpawnFn;
  now?: () => number;
}

export interface CancelAtFallbackDeps {
  isAlive?: (pid: number, taskName: string) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface PruneAtFallbackDeps {
  now?: () => number;
  isAlive?: (pid: number, taskName: string) => boolean;
  schedule?: (
    entry: RegistryEntry,
    command: string,
    nowMs: number,
  ) => Promise<string>;
  warn?: (message: string) => void;
}

export interface PruneAtFallbackReport {
  kept: number;
  removed: number;
  rescheduled: number;
  missed: number;
  skipped: boolean;
}

/** Минимальный интерфейс реестра — чтобы prune можно было тестировать без FS. */
export interface FallbackRegistry {
  load(): Promise<RegistryEntry[]>;
  save(entries: RegistryEntry[]): Promise<void>;
}

const PID_JOB_PREFIX = "pid:";
const FALLBACK_MARKER_PREFIX = "opencode-scheduler-at-fallback:";

/** Ошибка `spawn("at")`, означающая, что бинарник не найден. */
export function isAtMissingError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /ENOENT|not found|no such file/i.test(message);
}

/** Сколько секунд осталось до `runAt` (0, если момент уже прошёл). */
export function computeDelaySeconds(runAt: string, nowMs: number): number {
  const target = Date.parse(runAt);
  if (!Number.isFinite(target)) {
    throw new Error(`Некорректное время one-shot: «${runAt}».`);
  }
  return Math.max(0, Math.ceil((target - nowMs) / 1000));
}

/**
 * Маркер fallback-процесса конкретной задачи.
 *
 * Лежит в командной строке (`/proc/<pid>/cmdline`), поэтому позволяет
 * проверить, что pid всё ещё принадлежит нашей задаче, а не переиспользован
 * другим процессом после перезагрузки/завершения.
 */
export function fallbackMarker(taskName: string): string {
  return `${FALLBACK_MARKER_PREFIX}${Buffer.from(taskName, "utf8").toString(
    "base64url",
  )}`;
}

/** Скрипт для `/bin/bash -c`: подождать и выполнить команду задачи. */
export function buildDetachedOneShotScript(
  entry: RegistryEntry,
  command: string,
  nowMs: number,
): string {
  if (!entry.runAt) {
    throw new Error(`Задача "${entry.name}": не задано runAt для one-shot.`);
  }
  const delay = computeDelaySeconds(entry.runAt, nowMs);
  // Маркер — обычный shell-комментарий в конце, поэтому на выполнение не влияет.
  return `sleep ${delay}; ${command} # ${fallbackMarker(entry.name)}`;
}

/** Является ли сохранённый id задания pid-ом fallback-процесса. */
export function isPidJobId(jobId: string | undefined): boolean {
  return typeof jobId === "string" && jobId.startsWith(PID_JOB_PREFIX);
}

function pidFromJobId(jobId: string): number {
  return Number.parseInt(jobId.slice(PID_JOB_PREFIX.length), 10);
}

/** Читает командную строку процесса из /proc; null, если процесс недоступен. */
export function readProcessCmdline(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .join(" ")
      .trim();
  } catch {
    return null;
  }
}

/**
 * Живой ли это fallback-процесс именно этой задачи.
 *
 * Без проверки маркера `pid:` из персистентного реестра после перезагрузки
 * может указывать на совершенно другой процесс.
 */
export function isFallbackProcessAlive(pid: number, taskName: string): boolean {
  const cmdline = readProcessCmdline(pid);
  return cmdline?.includes(fallbackMarker(taskName)) ?? false;
}

function hasProcfs(): boolean {
  try {
    return fs.existsSync("/proc/self/cmdline");
  } catch {
    return false;
  }
}

/**
 * Запускает отвязанный one-shot и возвращает `pid:<pid>` для `cancelAt`.
 * Промис резолвится сразу после успешного `spawn`, не дожидаясь выполнения.
 */
export async function scheduleAtFallback(
  entry: RegistryEntry,
  command: string,
  deps: ScheduleAtFallbackDeps = {},
): Promise<string> {
  const spawnFn = deps.spawnFn ?? spawn;
  const now = deps.now ? deps.now() : Date.now();
  const script = buildDetachedOneShotScript(entry, command, now);

  return new Promise<string>((resolve, reject) => {
    const child = spawnFn("/bin/bash", ["-c", script], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(`${PID_JOB_PREFIX}${child.pid ?? 0}`);
    });
  });
}

/**
 * Снимает fallback-процесс.
 *
 * Требует имя задачи и сверяет маркер в `/proc/<pid>/cmdline`: голый pid из
 * реестра после перезагрузки может принадлежать чужому процессу. Убивает
 * группу процессов (fallback запущен detached и является её лидером).
 */
export function cancelAtFallback(
  jobId: string,
  taskName?: string,
  deps: CancelAtFallbackDeps = {},
): boolean {
  if (!isPidJobId(jobId)) return false;
  const pid = pidFromJobId(jobId);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!taskName) return false;

  const isAlive = deps.isAlive ?? isFallbackProcessAlive;
  if (!isAlive(pid, taskName)) return false;

  const kill =
    deps.kill ??
    ((target: number, signal: NodeJS.Signals) => process.kill(target, signal));
  try {
    kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

/** Команда, которую выполняет fallback: обёртка задачи + перенаправление лога. */
function buildFallbackCommand(entry: RegistryEntry): string {
  const log = entry.logFile ? ` >> ${shellQuote(entry.logFile)} 2>&1` : "";
  return `/bin/bash ${shellQuote(entry.command)}${log}`;
}

/**
 * Чистит `pid:`-записи, пережившие перезагрузку.
 *
 * Вызывается один раз при старте плагина. Живые процессы с совпадающим
 * маркером сохраняются; мёртвые — удаляются. Будущие one-shot пересоздаются,
 * прошедшие — помечаются пропущенными с предупреждением.
 */
export async function pruneStaleFallbackEntries(
  registry: FallbackRegistry,
  deps: PruneAtFallbackDeps = {},
): Promise<PruneAtFallbackReport> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const isAlive = deps.isAlive ?? isFallbackProcessAlive;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const schedule =
    deps.schedule ??
    ((entry, command, at) =>
      scheduleAtFallback(entry, command, { now: () => at }));

  // В системах без /proc проверить личность pid нельзя. Без инъекции
  // isAlive ничего не трогаем, чтобы не убить чужой процесс.
  if (!deps.isAlive && !hasProcfs()) {
    return { kept: 0, removed: 0, rescheduled: 0, missed: 0, skipped: true };
  }

  const entries = await registry.load();
  const report: PruneAtFallbackReport = {
    kept: 0,
    removed: 0,
    rescheduled: 0,
    missed: 0,
    skipped: false,
  };

  let changed = false;
  for (const entry of entries) {
    if (!isPidJobId(entry.atJobId)) continue;
    const pid = pidFromJobId(entry.atJobId!);

    if (isAlive(pid, entry.name)) {
      report.kept += 1;
      continue;
    }

    delete entry.atJobId;
    changed = true;
    report.removed += 1;

    if (entry.triggerType !== "once" || entry.paused) continue;

    const target = entry.runAt ? Date.parse(entry.runAt) : Number.NaN;
    if (Number.isFinite(target) && target > nowMs) {
      try {
        entry.atJobId = await schedule(entry, buildFallbackCommand(entry), nowMs);
        report.rescheduled += 1;
      } catch (err: unknown) {
        warn(
          `[scheduler] Не удалось пересоздать fallback для "${entry.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      continue;
    }

    report.missed += 1;
    warn(
      `[scheduler] One-shot "${entry.name}" не будет запущена: fallback-процесс потерян, ` +
        `время запуска уже прошло (${entry.runAt ?? "runAt не задан"}).`,
    );
  }

  if (changed) await registry.save(entries);
  return report;
}
