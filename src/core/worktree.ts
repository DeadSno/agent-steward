/**
 * W-1 (0.0.6): одноразовый git worktree на запуск.
 *
 * Задача с `worktree: true` выполняется не в основном дереве репозитория, а в
 * отдельной рабочей копии на собственной ветке. Это даёт безопасный fan-out
 * (матрица, параллельные миссии) без Docker: агент может менять файлы, не
 * задевая основное дерево и другие запуски.
 *
 * Модуль чистый: не бросает исключений, возвращает структурированный результат.
 * Создание worktree — единственная операция, меняющая состояние; политика
 * очистки появится в W-2.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PLUGIN_DIR, sanitizeName } from "../types.js";

const execFileAsync = promisify(execFile);

/** Каталог одноразовых worktree. Лежит рядом с prompts/logs и вне репозитория. */
export const WORKTREE_ROOT_DIR = path.join(PLUGIN_DIR, "worktrees");

/** Таймаут git-операций: зависший git не должен держать обёртку. */
const GIT_TIMEOUT_MS = 30_000;

/** Описание созданного worktree. */
export interface RunWorktree {
  /** Абсолютный путь рабочей копии. */
  path: string;
  /** Ветка, созданная под запуск. */
  branch: string;
  /** Корень основного репозитория. */
  repoRoot: string;
  /** Коммит, от которого создан worktree. */
  baseCommit: string;
  /** Время создания (ISO-8601). */
  createdAt: string;
}

export type CreateWorktreeResult =
  | { ok: true; worktree: RunWorktree }
  | { ok: false; error: string };

export interface CreateWorktreeOptions {
  /** Рабочая директория задачи: репозиторий (или его подкаталог). */
  repoDir: string;
  /** Имя задачи — основа для пути и ветки. */
  taskName: string;
  /** Куда создавать worktree. По умолчанию PLUGIN_DIR/worktrees. */
  rootDir?: string;
  /** Базовая ссылка (ветка/коммит). По умолчанию HEAD. */
  baseRef?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: String(stderr).trim() };
  } catch (err: unknown) {
    const source = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof source.stdout === "string" ? source.stdout.trim() : "",
      stderr:
        (typeof source.stderr === "string" ? source.stderr.trim() : "") ||
        (typeof source.message === "string" ? source.message : String(err)),
    };
  }
}

/**
 * Возвращает корень git-репозитория для `dir` или null, если это не репозиторий.
 * Работает и для подкаталога, и для уже связанного worktree.
 */
export async function isGitRepository(dir: string): Promise<string | null> {
  if (!dir || !dir.trim()) return null;
  const result = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout) return null;
  return result.stdout;
}

/** Уникальный суффикс: время + случайные байты, чтобы параллельные запуски не совпали. */
function uniqueSuffix(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Создаёт одноразовый worktree под запуск задачи.
 *
 * Никогда не бросает: ошибки git и файловой системы возвращаются как
 * `{ok:false, error}` — обёртка должна упасть fail-closed с понятным сообщением.
 */
export async function createRunWorktree(
  options: CreateWorktreeOptions,
): Promise<CreateWorktreeResult> {
  const repoDir = options.repoDir?.trim();
  const taskName = options.taskName?.trim();
  if (!repoDir) {
    return { ok: false, error: "Не задана рабочая директория задачи." };
  }
  if (!taskName) {
    return { ok: false, error: "Не задано имя задачи." };
  }

  const repoRoot = await isGitRepository(repoDir);
  if (!repoRoot) {
    return {
      ok: false,
      error: `Рабочая директория «${repoDir}» не является git-репозиторием.`,
    };
  }

  const rootDir = options.rootDir?.trim() || WORKTREE_ROOT_DIR;
  const baseRef = options.baseRef?.trim() || "HEAD";
  const segment = sanitizeName(taskName).slice(0, 48) || "task";
  const suffix = uniqueSuffix();
  const branch = `agent-steward/${segment}-${suffix}`;
  const worktreePath = path.join(rootDir, `${segment}-${suffix}`);

  try {
    await fs.mkdir(rootDir, { recursive: true });
  } catch (err: unknown) {
    return {
      ok: false,
      error: `Не удалось создать каталог worktree «${rootDir}»: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // -b создаёт ветку, чтобы каждый запуск был независим. Путь и ветка
  // уникальны, поэтому гонка двух параллельных запусков не блокирует друг друга.
  const add = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
  if (!add.ok) {
    return {
      ok: false,
      error: `git worktree add завершился ошибкой: ${add.stderr || "неизвестная ошибка"}`,
    };
  }

  const head = await git(worktreePath, ["rev-parse", "HEAD"]);
  if (!head.ok || !head.stdout) {
    // Worktree уже создан — не оставляем мусор, но не маскируем ошибку.
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    return {
      ok: false,
      error: `Не удалось определить базовый коммит worktree: ${head.stderr || "неизвестная ошибка"}`,
    };
  }

  const worktree: RunWorktree = {
    path: worktreePath,
    branch,
    repoRoot,
    baseCommit: head.stdout,
    createdAt: new Date().toISOString(),
  };

  // Sidecar для будущей очистки (W-2): путь, ветка, репозиторий и время.
  // Лежит рядом с worktree каталогом, а не внутри рабочей копии.
  try {
    await fs.writeFile(
      `${worktreePath}.json`,
      JSON.stringify({ ...worktree, taskName }, null, 2),
      "utf8",
    );
  } catch {
    // Метаданные не критичны для запуска: worktree уже готов.
  }

  return { ok: true, worktree };
}
