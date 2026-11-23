import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { requestImmediateRun } from "../ps-wrapper.js";
import { getTask } from "../../db/tasks-repo.js";
import { createSchedulerBackend } from "./index.js";
import type { RunTaskResult, SchedulerBackend } from "./types.js";

/**
 * PL-79 / PL-82: достаём ВЕСЬ список SCOPE-путей из промпта задачи.
 *
 * Проверка делается до создания/обновления задачи (pre-flight), чтобы
 * post-flight `git add` не падал после зелёного quality gate из-за несуществующего
 * пути, которого на самом деле никогда не было в репозитории.
 */
export function extractScopePaths(text: string): string[] {
  const line = /(?:^|\n)[^\n]*\bSCOPE\s*:\s*([^\n]*)/i.exec(text);
  if (!line) return [];
  return line[1]
    .split(/[,;]/)
    .map((part) =>
      part
        .trim()
        .replace(/^[`"'\[\]]+|[`"'\[\].]+$/g, "")
        .trim(),
    )
    .filter(Boolean)
    // SCOPE может содержать директории вида src/core/scheduler/*.
    .map((part) => (part.endsWith("/*") || part.endsWith("\\*") ? part.slice(0, -2) : part));
}

/** PL-79 / PL-82: результат проверки SCOPE-путей на существование. */
export interface ScopeCheck {
  ok: boolean;
  /** Нормализованные пути из SCOPE. */
  paths: string[];
  /** Пути, которых нет на диске. */
  missing: string[];
}

/**
 * PL-119: опции pre-flight проверки SCOPE.
 *
 * `filesCreate` — файлы, которые задача создаст в ходе выполнения. Такие пути
 * не считаются missing: требовать их существования на этапе планирования
 * бессмысленно, но после запуска `git add` их уже нужно добавлять в SCOPE.
 * Для обратной совместимости вместо объекта можно передать сразу массив —
 * он трактуется как `filesCreate`.
 */
export interface ScopeCheckOptions {
  filesCreate?: string[];
}

/** PL-119: один и тот же ключ для SCOPE-пути и создаваемого файла. */
function scopePathKey(item: string, root: string): string {
  const resolved = path.isAbsolute(item) ? item : path.resolve(root || process.cwd(), item);
  return path.normalize(resolved).split(path.sep).join("/");
}

export function validateScopePaths(
  paths: string[],
  root: string,
  opts?: ScopeCheckOptions | string[],
): ScopeCheck {
  const filesCreate = Array.isArray(opts) ? opts : opts?.filesCreate;
  const created = new Set((filesCreate ?? []).map((item) => scopePathKey(item, root)));
  const missing = paths.filter((item) => {
    // PL-119: create-intent — файл ещё не существует, но это ожидаемо.
    if (created.has(scopePathKey(item, root))) return false;
    const resolved = path.isAbsolute(item) ? item : path.resolve(root || process.cwd(), item);
    return !fsSync.existsSync(resolved);
  });
  return { ok: missing.length === 0, paths, missing };
}

/** PL-79 / PL-82 / PL-119: pre-flight проверка SCOPE из промпта задачи. */
export function preflightScope(
  prompt: string,
  root: string,
  opts?: ScopeCheckOptions | string[],
): ScopeCheck {
  return validateScopePaths(extractScopePaths(prompt), root, opts);
}

/** PL-77: решение о параллельном запуске и изоляции worktree. */
export interface ParallelPlan {
  allowed: boolean;
  reason: string | null;
  /** true — каждый агент работает в собственном worktree. */
  worktree: boolean;
  /** Стабильный ключ worktree задачи. */
  worktreeKey: string;
}

/**
 * PL-77: не даём нескольким агентам писать в один worktree и держим
 * maxConcurrent. При maxConcurrent !== 1 (параллель возможна) worktree
 * включается принудительно: в general worktree агенты перезаписывают правки
 * друг друга и post-flight видит чужой diff.
 */
export function planParallelExecution(input: {
  maxConcurrent?: number;
  runningCount?: number;
  worktree?: boolean;
  taskName: string;
}): ParallelPlan {
  const max = Number.isFinite(input.maxConcurrent) ? Number(input.maxConcurrent) : undefined;
  const running = Math.max(0, Number(input.runningCount) || 0);
  const worktreeKey =
    input.taskName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9а-яё_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "task";
  const allowed = !(max !== undefined && max > 0 && running >= max);
  const parallel = max === 0 || (max !== undefined && max > 1);
  return {
    allowed,
    worktree: input.worktree === true || parallel,
    worktreeKey,
    reason: allowed
      ? null
      : `maxConcurrent=${max} достигнут: запущено ${running}. Задача пропущена.`,
  };
}

/** PL-106: решение о запуске, когда в одном чек-ауте уже идёт агент. */
export interface RuntimeIsolationPlan {
  allowed: boolean;
  reason: string | null;
  isolated: boolean;
}

/**
 * PL-106: несколько задач, запущенных одновременно без worktree, пишут в
 * один и тот же checkout (реальный случай 23.11.2026 — 4 агента, 585с смерти
 * и loss правок). Creation-time план учитывает только maxConcurrent и не
 * защищает от ручных запусков и кэтч-апа, поэтому проверка повторяется в
 * точке запуска. Задача с worktree: true изолирована и может идти вместе
 * с другими; остальные — только по одной на процесс плагина.
 */
export function planRuntimeIsolation(input: {
  activeNonIsolated: number;
  worktree?: boolean;
  taskName: string;
}): RuntimeIsolationPlan {
  const isolated = input.worktree === true;
  const active = Math.max(0, Number(input.activeNonIsolated) || 0);
  const allowed = isolated || active === 0;
  return {
    allowed,
    isolated,
    reason: allowed
      ? null
      : "PL-106: уже запущена другая задача без worktree в этом чек-ауте. " +
        "Дождитесь её завершения или создайте задачу с worktree: true (" +
        input.taskName + ").",
  };
}

/** PL-99: признак уже закрытой находки. */
export interface StaleVerdict {
  stale: boolean;
  reason: string;
  action: "disable" | "reschedule" | null;
}

/**
 * PL-99: находка считается stale, если её ID есть в CHANGELOG (или в git diff
 * CHANGELOG/ROADMAP) и её больше нет в открытом ROADMAP. Такую задачу нужно
 * отключить/перепланировать до запуска, а не после зелёного гейта.
 */
export function detectStaleTask(input: {
  id: string;
  roadmap?: string;
  changelog?: string;
  gitDiff?: string;
}): StaleVerdict {
  const id = input.id.trim().toUpperCase();
  if (!/^PL-\d+$/.test(id)) {
    return { stale: false, reason: "ID находки не распознан", action: null };
  }
  const roadmap = input.roadmap ?? "";
  const changelog = input.changelog ?? "";
  const gitDiff = input.gitDiff ?? "";
  const inRoadmap = roadmap.includes(id);
  const inChangelog = changelog.includes(id);
  const inDiff = gitDiff.includes(id);
  if (!inRoadmap && (inChangelog || inDiff)) {
    return {
      stale: true,
      reason: `${id} закрыт(а) в CHANGELOG/diff и отсутствует в ROADMAP`,
      action: "disable",
    };
  }
  return { stale: false, reason: "находка всё ещё открыта", action: null };
}

/** PL-99: читает ROADMAP/CHANGELOG и git diff задачи перед запуском. */
async function checkStaleTaskBeforeRun(taskName: string): Promise<StaleVerdict | null> {
  let definition: ReturnType<typeof getTask>;
  try {
    definition = getTask(taskName);
  } catch {
    return null;
  }
  if (!definition) return null;
  const id = [definition.name, definition.prompt]
    .map((text) => /\bPL-\d+\b/i.exec(text ?? "")?.[0])
    .find(Boolean);
  if (!id) return null;
  const root = definition.workingDirectory?.trim() || process.cwd();
  const [roadmap, changelog] = await Promise.all([
    fs.readFile(path.join(root, "ROADMAP.md"), "utf8").catch(() => ""),
    fs.readFile(path.join(root, "CHANGELOG.md"), "utf8").catch(() => ""),
  ]);
  let gitDiff = "";
  try {
    const result = spawnSync("git", ["diff", "--", "ROADMAP.md", "CHANGELOG.md"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    gitDiff = result?.stdout ?? "";
  } catch {
    // git может отсутствовать — достаточно самих файлов.
  }
  return detectStaleTask({ id, roadmap, changelog, gitDiff });
}

/**
 * Немедленный запуск задачи в обход schedule-gate.
 *
 * Зачем: для poll-режима (расширенный cron / чужая IANA-таймзона / окно
 * запуска) обёртка всегда прогоняет schedule-gate, и запуск вне cron-окна
 * молча завершается с exit 3. Это касается не только `run_task_now`, но и
 * цепочек (nextTaskOnSuccess / nextTaskOnError), DAG-зависимостей и retry:
 * они тоже запускают задачу «сейчас», а не «по расписанию».
 *
 * Маркер `requestImmediateRun` снимает проверку расписания внутри обёртки.
 * Если планировщик не принял запуск, маркер удаляется, чтобы он не «разрешил»
 * следующий плановый тик в обход расписания.
 */
export async function runTaskNow(
  taskName: string,
  backend: SchedulerBackend = createSchedulerBackend(),
): Promise<RunTaskResult> {
  // PL-99: до запуска отсекаем задачи по уже закрытым находкам.
  try {
    const stale = await checkStaleTaskBeforeRun(taskName);
    if (stale?.stale) {
      return {
        alreadyRunning: false,
        skipped: true,
        reason: `PL-99: ${stale.reason}. Задача отключена (перепланируйте её).`,
      };
    }
  } catch {
    // Диагностика не должна ломать сам запуск.
  }
  const forceFile = await requestImmediateRun(taskName);
  try {
    return await backend.runTask(taskName);
  } catch (err) {
    await fs.unlink(forceFile).catch(() => {
      /* маркер мог быть уже поглощён gate'ом или удалён по TTL */
    });
    throw err;
  }
}
