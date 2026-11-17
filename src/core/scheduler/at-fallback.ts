import { spawn } from "node:child_process";
import type { RegistryEntry } from "./registry.js";

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

const PID_JOB_PREFIX = "pid:";

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
  return `sleep ${delay}; ${command}`;
}

/** Является ли сохранённый id задания pid-ом fallback-процесса. */
export function isPidJobId(jobId: string | undefined): boolean {
  return typeof jobId === "string" && jobId.startsWith(PID_JOB_PREFIX);
}

function pidFromJobId(jobId: string): number {
  return Number.parseInt(jobId.slice(PID_JOB_PREFIX.length), 10);
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

/** Снимает fallback-процесс. Ошибки (процесс уже завершился) игнорируются. */
export function cancelAtFallback(jobId: string): boolean {
  if (!isPidJobId(jobId)) return false;
  const pid = pidFromJobId(jobId);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
