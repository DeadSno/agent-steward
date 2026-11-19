import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadTaskDefinitions, type TaskDefinition } from "../task-transfer.js";
import { getGitState, setGitState, deleteGitState } from "../db/git-state-repo.js";
import { filterPaths } from "./glob.js";
import { getWorkspace } from "../workspaces.js";
import { t } from "../i18n.js";

/**
 * Git-триггеры (Спринт 27).
 *
 * Задача с `triggerType: "git"` запускается, когда в её рабочей директории
 * появился новый коммит, затронувший подходящие файлы. Состояние — последний
 * обработанный `HEAD` — хранится в SQLite (`git_state`), поэтому перезапуск
 * плагина не приводит к повторным запускам.
 *
 * Первый опрос только запоминает текущий `HEAD` (baseline) и ничего не запускает.
 */

export const GIT_TRIGGER_DEFAULT_POLL_SECONDS = 60;
export const GIT_TRIGGER_MIN_POLL_SECONDS = 5;
export const GIT_COMMAND_TIMEOUT_MS = 10_000;

export interface GitProbe {
  head: string;
  branch: string | null;
}

export interface GitTriggerTask {
  name: string;
  cwd: string;
  /** Разрешённые ветки (glob). Пусто — любая ветка. */
  branch?: string;
  /** Пути/glob-маски, изменение которых запускает задачу. Пусто — любой файл. */
  paths?: string[];
  /** Исключения (glob): изменения только в этих путях игнорируются. */
  ignore?: string[];
  pollSeconds?: number;
}

export type GitCheckStatus =
  | "no-repo"
  | "baseline"
  | "no-changes"
  | "branch-mismatch"
  | "ignored"
  | "changed"
  | "error";

export interface GitCheckResult {
  status: GitCheckStatus;
  head?: string;
  branch?: string | null;
  from?: string | null;
  files: string[];
  matched: string[];
  message: string;
}

export type GitTriggerHandler = (taskName: string, info: GitCheckResult & { cwd: string }) => void | Promise<void>;

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

/**
 * W-1 (0.0.6): опрос репозитория — служебная операция, а не пользовательская.
 * Игнорируем пользовательские хуки и запрещаем интерактивный ввод пароля,
 * чтобы длинная цепочка хуков или запрос credentials не блокировали опрос.
 */
const GIT_SAFE_ARGS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];
const GIT_SAFE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const defaultRunner: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...GIT_SAFE_ARGS, ...args],
      {
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: GIT_SAFE_ENV,
      },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });

/** true, если директория существует (иначе git всё равно ответит ошибкой). */
function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Текущий HEAD и ветка; null, если это не git-репозиторий. */
export async function probeGit(cwd: string, run: GitRunner = defaultRunner): Promise<GitProbe | null> {
  if (!cwd || !directoryExists(cwd)) return null;
  try {
    const head = (await run(cwd, ["rev-parse", "HEAD"])).trim();
    if (!head) return null;
    let branch: string | null = null;
    try {
      const raw = (await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      branch = raw && raw !== "HEAD" ? raw : null;
    } catch {
      branch = null;
    }
    return { head, branch };
  } catch {
    return null;
  }
}

/** Файлы, изменённые между коммитами (или в самом коммите, если from пуст).
 * Ошибка git НЕ превращается в пустой список: иначе state продвигается и
 * коммиты молча теряются. Вызывающий код обязан обработать исключение. */
export async function gitChangedFiles(
  cwd: string,
  from: string | null,
  to: string,
  run: GitRunner = defaultRunner,
): Promise<string[]> {
  const args = from
    ? ["diff", "--name-only", `${from}..${to}`]
    : ["diff-tree", "--no-commit-id", "--name-only", "-r", to];
  const out = await run(cwd, args);
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function branchMatches(branch: string | null, pattern?: string): boolean {
  if (!pattern?.trim()) return true;
  if (!branch) return false;
  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const target = normalize(branch);
  const patterns = pattern
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  return patterns.some((item) => {
    // Экранируем все regex-метасимволы, включая [ и ] (раньше они ломали
    // шаблон ветки), затем превращаем glob-символы * и ? в regex.
    const escaped = normalize(item).replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${source}$`).test(target);
  });
}

/**
 * Проверяет задачу без побочных эффектов (кроме baseline-записи).
 * Используется и менеджером, и dry-run.
 */
export async function checkGitTrigger(
  task: GitTriggerTask,
  options: { run?: GitRunner; persist?: boolean } = {},
): Promise<GitCheckResult> {
  const run = options.run ?? defaultRunner;
  const persist = options.persist !== false;
  const probe = await probeGit(task.cwd, run);
  if (!probe) {
    return {
      status: "no-repo",
      files: [],
      matched: [],
      message: t("gitTrigger.noRepo", { cwd: task.cwd }),
    };
  }

  const state = getGitState(task.name);
  if (!state) {
    if (persist) setGitState(task.name, probe.head, probe.branch);
    return {
      status: "baseline",
      head: probe.head,
      branch: probe.branch,
      files: [],
      matched: [],
      message: t("gitTrigger.baseline", { commit: probe.head.slice(0, 7) }),
    };
  }

  if (!branchMatches(probe.branch, task.branch)) {
    return {
      status: "branch-mismatch",
      head: probe.head,
      branch: probe.branch,
      from: state.commitSha,
      files: [],
      matched: [],
      message: t("gitTrigger.branchMismatch", {
        branch: probe.branch ?? "(detached)",
        pattern: task.branch,
      }),
    };
  }

  if (probe.head === state.commitSha) {
    return {
      status: "no-changes",
      head: probe.head,
      branch: probe.branch,
      from: state.commitSha,
      files: [],
      matched: [],
      message: t("gitTrigger.noChanges"),
    };
  }

  let files: string[];
  try {
    files = await gitChangedFiles(task.cwd, state.commitSha, probe.head, run);
  } catch (err: unknown) {
    // Не двигаем state: следующий опрос повторит сравнение с тем же коммитом,
    // и пропущенные изменения не потеряются.
    return {
      status: "error",
      head: probe.head,
      branch: probe.branch,
      from: state.commitSha,
      files: [],
      matched: [],
      message: t("gitTrigger.diffFailed", {
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
  const matched = filterPaths(files, task.paths, task.ignore);

  if (matched.length === 0) {
    if (persist) setGitState(task.name, probe.head, probe.branch);
    return {
      status: files.length === 0 ? "no-changes" : "ignored",
      head: probe.head,
      branch: probe.branch,
      from: state.commitSha,
      files,
      matched: [],
      message:
        files.length === 0
          ? t("gitTrigger.noChanges")
          : t("gitTrigger.ignored", { count: files.length }),
    };
  }

  if (persist) setGitState(task.name, probe.head, probe.branch);
  return {
    status: "changed",
    head: probe.head,
    branch: probe.branch,
    from: state.commitSha,
    files,
    matched,
    message: t("gitTrigger.changed", {
      commit: probe.head.slice(0, 7),
      count: matched.length,
      files: `${matched.slice(0, 3).join(", ")}${matched.length > 3 ? ", …" : ""}`,
    }),
  };
}

function cwdOf(def: TaskDefinition): string {
  const workspacePath = def.workspaceId ? getWorkspace(def.workspaceId)?.path : undefined;
  return workspacePath || def.workingDirectory || def.workdir || "";
}

function pollSecondsOf(def: TaskDefinition): number {
  const raw = Number(def.gitPollSeconds ?? GIT_TRIGGER_DEFAULT_POLL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return GIT_TRIGGER_DEFAULT_POLL_SECONDS;
  return Math.max(GIT_TRIGGER_MIN_POLL_SECONDS, Math.floor(raw));
}

interface ManagedGit {
  def: TaskDefinition;
  timer: NodeJS.Timeout;
  busy: boolean;
}

export class GitTriggerManager {
  private readonly tasks = new Map<string, ManagedGit>();
  private readonly handler: GitTriggerHandler;
  private readonly run?: GitRunner;

  constructor(handler: GitTriggerHandler, options: { run?: GitRunner } = {}) {
    this.handler = handler;
    this.run = options.run;
  }

  get size(): number {
    return this.tasks.size;
  }

  /** Перечитывает задачи и пересобирает таймеры. Возвращает число задач. */
  async refresh(): Promise<number> {
    const wanted = new Map<string, TaskDefinition>();
    for (const def of await loadTaskDefinitions()) {
      if (def.triggerType !== "git") continue;
      if (!cwdOf(def)) continue;
      wanted.set(def.name.toLowerCase(), def);
    }

    for (const [key, managed] of [...this.tasks]) {
      const next = wanted.get(key);
      if (!next || pollSecondsOf(next) !== pollSecondsOf(managed.def)) {
        clearInterval(managed.timer);
        this.tasks.delete(key);
      }
    }

    for (const [key, def] of wanted) {
      const existing = this.tasks.get(key);
      if (existing) {
        existing.def = def;
        continue;
      }
      const timer = setInterval(() => void this.poll(key), pollSecondsOf(def) * 1000);
      timer.unref?.();
      this.tasks.set(key, { def, timer, busy: false });
      // Первый опрос — сразу: он запоминает baseline, не запуская задачу.
      void this.poll(key);
    }

    return this.tasks.size;
  }

  /** Ручная проверка одной задачи (dry-run, тесты). */
  async check(taskName: string): Promise<GitCheckResult | null> {
    const managed = this.tasks.get(taskName.toLowerCase());
    if (managed) {
      return checkGitTrigger(this.taskSpec(managed.def), { run: this.run });
    }
    const def = (await loadTaskDefinitions()).find(
      (d) => d.triggerType === "git" && d.name.toLowerCase() === taskName.toLowerCase(),
    );
    if (!def) return null;
    return checkGitTrigger(this.taskSpec(def), { run: this.run });
  }

  private taskSpec(def: TaskDefinition): GitTriggerTask {
    return {
      name: def.name,
      cwd: cwdOf(def),
      branch: def.gitBranch,
      paths: def.gitPaths,
      ignore: def.gitIgnore,
      pollSeconds: pollSecondsOf(def),
    };
  }

  private async poll(key: string): Promise<void> {
    const managed = this.tasks.get(key);
    if (!managed || managed.busy) return;
    managed.busy = true;
    try {
      const result = await checkGitTrigger(this.taskSpec(managed.def), { run: this.run });
      if (result.status === "changed") {
        await this.handler(managed.def.name, { ...result, cwd: cwdOf(managed.def) });
      } else if (result.status === "error") {
        console.error(`[agent-steward] git-триггер «${managed.def.name}»: ${result.message}`);
      }
    } catch (err: unknown) {
      console.error(
        `[agent-steward] git-триггер «${managed.def.name}»: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      managed.busy = false;
    }
  }

  async stop(): Promise<void> {
    for (const managed of this.tasks.values()) clearInterval(managed.timer);
    this.tasks.clear();
  }

  /** Забывает состояние (при удалении/пересоздании задачи). */
  forget(taskName: string): void {
    deleteGitState(taskName);
  }
}

/** Задачи с git-триггером (для dry-run и вида задач). */
export async function gitTriggerTasks(): Promise<{ name: string; cwd: string }[]> {
  return (await loadTaskDefinitions())
    .filter((def) => def.triggerType === "git" && cwdOf(def))
    .map((def) => ({ name: def.name, cwd: cwdOf(def) }));
}

/** Нормализует путь рабочей директории (для сравнения в тестах). */
export function normalizeGitCwd(cwd: string): string {
  return path.resolve(cwd);
}
