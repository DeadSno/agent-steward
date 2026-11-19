/**
 * W-1 (0.0.6): одноразовый git worktree на запуск.
 *
 * Задача с `worktree: true` выполняется не в основном дереве репозитория, а в
 * отдельной рабочей копии на собственной ветке. Это даёт безопасный fan-out
 * (матрица, параллельные миссии) без Docker: агент может менять файлы, не
 * задевая основное дерево и другие запуски.
 *
 * Модуль чистый: не бросает исключений, возвращает структурированный результат.
 * W-2 добавляет удаление после прогона и уборку осиротевших worktree.
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

/**
 * W-1 (0.0.6): служебные git-вызовы не должны наследовать пользовательские
 * хуки — падающий `post-checkout` блокировал бы `git worktree add`, а
 * интерактивный запрос пароля мог бы повесить вызов. `/dev/null` (Windows:
 * `NUL`) — не каталог, поэтому git не находит ни одного хука.
 */
const GIT_SAFE_ARGS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];
const GIT_SAFE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

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
  /** Корень, в котором создан worktree (для безопасной очистки). */
  rootDir: string;
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
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...GIT_SAFE_ARGS, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      env: GIT_SAFE_ENV,
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
 * git worktree add обновляет общие метаданные репозитория (refs, worktrees/).
 * На Windows параллельные вызовы в одном процессе иногда сталкиваются на
 * lock-файлах, поэтому сериализуем только создание каталога/ветки. сами
 * задачи продолжают выполняться параллельно — блокируется лишь операция git.
 */
let worktreeCreateTail: Promise<void> = Promise.resolve();
function serializeWorktreeCreate<T>(work: () => Promise<T>): Promise<T> {
  const result = worktreeCreateTail.then(work, work);
  worktreeCreateTail = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Ошибки, которые стоит перепробовать: гонки lock-файлов и ANTIVIRUS/FS.
 *
 * W-2: общий `No such file` убран из списка. Он маскировал отсутствующий
 * `baseRef` и повреждённый репозиторий под транзиентную гонку: `addWorktree`
 * делал 3 попытки с задержками 50 + 100 мс, а затем возвращал ту же ошибку.
 * Гонки lock-файлов по-прежнему распознаются по `index.lock`, `cannot lock ref`
 * и `Unable to create` — `No such file` может встречаться внутри их текста,
 * но сам по себе больше не является признаком транзиентности.
 */
export function isTransientGitError(message: string): boolean {
  return /index\.lock|cannot lock ref|Unable to create|lock|File exists|already (exists|registered)|resource busy|EPERM|EBUSY/i.test(
    message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AddWorktreeResult =
  | { ok: true; branch: string; worktreePath: string }
  | { ok: false; error: string };

/** Создаёт каталог и ветку worktree с повторами на transient-ошибки git. */
async function addWorktree(
  rootDir: string,
  repoRoot: string,
  baseRef: string,
  segment: string,
): Promise<AddWorktreeResult> {
  return serializeWorktreeCreate(async () => {
    let lastError = "неизвестная ошибка";
    for (let attempt = 0; attempt < 3; attempt++) {
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

      // -b создаёт ветку, чтобы каждый запуск был независим.
      const add = await git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
      if (add.ok) return { ok: true, branch, worktreePath };

      lastError = add.stderr || "неизвестная ошибка";
      if (attempt < 2 && isTransientGitError(lastError)) {
        await delay(50 * (attempt + 1));
        continue;
      }
      break;
    }
    return { ok: false, error: `git worktree add завершился ошибкой: ${lastError}` };
  });
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

  // Сериализуем только git-операцию: параллельный fan-out не должен биться
  // об общие lock-файлы .git/refs и .git/worktrees на Windows.
  const added = await addWorktree(rootDir, repoRoot, baseRef, segment);
  if (!added.ok) return { ok: false, error: added.error };
  const { branch, worktreePath } = added;

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
    rootDir,
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

// ---------------------------------------------------------------------------
// W-2: очистка после прогона и уборка осиротевших worktree.

/** Результат удаления одного worktree. */
export type RemoveWorktreeResult = { ok: true } | { ok: false; error: string };

export interface RemoveWorktreeOptions {
  /** Абсолютный путь рабочей копии. */
  path: string;
  /** Корень основного репозитория (иначе берётся из sidecar). */
  repoRoot?: string;
  /** Ветка запуска (иначе берётся из sidecar). */
  branch?: string;
  /** Корень worktree (иначе берётся из sidecar или WORKTREE_ROOT_DIR). */
  rootDir?: string;
  /** Удалять ли ветку запуска. По умолчанию true. */
  deleteBranch?: boolean;
}

interface SidecarData extends Partial<RunWorktree> {
  taskName?: string;
}

/** Ветки, созданные плагином, — единственные, которые разрешено удалять. */
const BRANCH_PREFIX = "agent-steward/";

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** realpath может отсутствовать для уже удалённого пути — тогда берём resolve. */
async function realPathOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * git возвращает канонический путь: на macOS /var/... превращается в
 * /private/var/..., на Windows может измениться регистр или короткое имя.
 * Сравниваем и нормализованные, и реальные пути.
 */
async function samePath(left: string, right: string): Promise<boolean> {
  const a = path.resolve(left);
  const b = path.resolve(right);
  const equal = (x: string, y: string): boolean =>
    process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  if (equal(a, b)) return true;
  const [realA, realB] = await Promise.all([realPathOrResolved(a), realPathOrResolved(b)]);
  return equal(realA, realB);
}

function isSidecarData(value: unknown): value is SidecarData {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readSidecar(worktreePath: string): Promise<SidecarData | null> {
  try {
    const raw = await fs.readFile(`${worktreePath}.json`, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isSidecarData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function removeSidecar(worktreePath: string): Promise<void> {
  try {
    await fs.rm(`${worktreePath}.json`, { force: true });
  } catch {
    // Sidecar не критичен: каталог worktree уже удалён.
  }
}

/**
 * Удаляет созданный плагином worktree и его ветку.
 *
 * Защита W-2.2: удаляется только путь внутри каталога worktree, только
 * зарегистрированный в git (или оставшийся каталог со sidecar) и только
 * ветка с префиксом `agent-steward/`. Повторный вызов идемпотентен.
 */
export async function removeRunWorktree(
  options: RemoveWorktreeOptions,
): Promise<RemoveWorktreeResult> {
  const requested = options.path?.trim();
  if (!requested) {
    return { ok: false, error: "Не задан путь worktree." };
  }

  const target = path.resolve(requested);
  const sidecar = await readSidecar(target);
  const rootDir = options.rootDir?.trim() || sidecar?.rootDir || WORKTREE_ROOT_DIR;
  if (!isInside(rootDir, target)) {
    return {
      ok: false,
      error: `Путь «${target}» находится вне каталога worktree «${rootDir}» — удаление отменено.`,
    };
  }

  // Идемпотентность: каталога уже нет — удалять нечего (sidecar мог остаться).
  // Registration в git мог остаться после прошлого падения — снимаем его тоже.
  if (!(await pathExists(target))) {
    const knownRepo = options.repoRoot?.trim() || sidecar?.repoRoot;
    if (knownRepo) await git(knownRepo, ["worktree", "prune", "--expire=now"]);
    await removeSidecar(target);
    return { ok: true };
  }

  const repoRoot = options.repoRoot?.trim() || sidecar?.repoRoot;
  if (!repoRoot) {
    return { ok: false, error: "Не известен репозиторий worktree — удаление отменено." };
  }
  const branch = options.branch?.trim() || sidecar?.branch;
  if (branch && !branch.startsWith(BRANCH_PREFIX)) {
    return {
      ok: false,
      error: `Ветка «${branch}» создана не плагином — удаление отменено.`,
    };
  }

  const list = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  let registered = false;
  if (list.ok) {
    for (const line of list.stdout.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      if (await samePath(line.slice("worktree ".length).trim(), target)) {
        registered = true;
        break;
      }
    }
  }

  if (!registered && !sidecar) {
    return {
      ok: false,
      error: "Worktree не зарегистрирован в git и не имеет sidecar — удаление отменено.",
    };
  }

  if (registered) {
    const removed = await git(repoRoot, ["worktree", "remove", "--force", target]);
    if (!removed.ok) {
      // Осиротевший каталог (например, git потерял запись) убираем вручную и
      // чистим служебные ссылки. Это безопасно: путь проверен выше.
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch (err: unknown) {
        return {
          ok: false,
          error: `Не удалось удалить worktree «${target}»: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }
  } else {
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Не удалось удалить каталог worktree «${target}»: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  // Канонический путь git может не совпадать с запрошенным (macOS /var ->
  // /private/var, Windows-регистр). Тогда ветка \"remove\" не срабатывала и
  // registration оставался в .git/worktrees — из-за этого `git branch -D`
  // падала даже после успешного удаления каталога. prune --expire=now снимает
  // registration в любом случае; для живых worktree он безвреден.
  await git(repoRoot, ["worktree", "prune", "--expire=now"]);

  // Ветка одноразовая: после удаления рабочей копии она больше не нужна.
  if (options.deleteBranch !== false && branch && branch.startsWith(BRANCH_PREFIX)) {
    await git(repoRoot, ["branch", "-D", branch]);
  }

  await removeSidecar(target);
  return { ok: true };
}

/** Сколько живёт lock уборки, прежде чем считать его осиротевшим. */
export const CLEANUP_LOCK_STALE_MS = 10 * 60 * 1000;

/** По умолчанию осиротевшим считается worktree старше суток. */
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface StaleCleanupOptions {
  rootDir?: string;
  /** Возраст, после которого worktree считается остатком. */
  maxAgeMs?: number;
  /** Текущее время (для тестов). */
  now?: number;
}

export interface StaleCleanupResult {
  /** Удалённые рабочие копии. */
  removed: string[];
  /** Свежие worktree, которые трогать нельзя. */
  skipped: string[];
  /** Sidecar без рабочей копии — убраны. */
  pruned: string[];
  errors: string[];
  /** Уборку уже выполняет другой процесс. */
  locked: boolean;
}

async function acquireCleanupLock(rootDir: string): Promise<boolean> {
  const lockDir = path.join(rootDir, ".cleanup-lock");
  try {
    await fs.mkdir(rootDir, { recursive: true });
    await fs.mkdir(lockDir);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
    try {
      const stat = await fs.stat(lockDir);
      if (Date.now() - stat.mtimeMs > CLEANUP_LOCK_STALE_MS) {
        await fs.rm(lockDir, { recursive: true, force: true });
        await fs.mkdir(lockDir);
        return true;
      }
    } catch {
      // Гонка с другим уборщиком: уступаем ему.
    }
    return false;
  }
}

async function releaseCleanupLock(rootDir: string): Promise<void> {
  try {
    await fs.rm(path.join(rootDir, ".cleanup-lock"), { recursive: true, force: true });
  } catch {
    // Lock истечёт сам; ошибка не должна ломать запуск.
  }
}

/**
 * Убирает осиротевшие worktree старше `maxAgeMs` и sidecar без рабочей копии.
 *
 * Гонки W-2.2: уборка сериализуется каталогом `.cleanup-lock`; свежие worktree
 * (моложе порога) не трогаются, поэтому активный запуск не будет удалён.
 * Каталоги без sidecar не удаляются — это чужие данные.
 */
export async function cleanupStaleWorktrees(
  options: StaleCleanupOptions = {},
): Promise<StaleCleanupResult> {
  const rootDir = options.rootDir?.trim() || WORKTREE_ROOT_DIR;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now();
  const result: StaleCleanupResult = { removed: [], skipped: [], pruned: [], errors: [], locked: false };

  if (!(await pathExists(rootDir))) return result;
  if (!(await acquireCleanupLock(rootDir))) {
    return { ...result, locked: true };
  }

  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const sidecarPath = path.join(rootDir, entry.name);
      let sidecar: SidecarData;
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(sidecarPath, "utf8"));
        if (!isSidecarData(parsed)) {
          throw new Error("sidecar не является объектом");
        }
        sidecar = parsed;
      } catch (err: unknown) {
        result.errors.push(
          `Повреждённый sidecar «${entry.name}»: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const target = sidecar.path?.trim();
      if (!target) {
        result.errors.push(`Sidecar «${entry.name}» без пути worktree.`);
        continue;
      }

      if (!(await pathExists(target))) {
        await removeSidecar(target);
        result.pruned.push(target);
        continue;
      }

      let ageMs = typeof sidecar.createdAt === "string" ? now - Date.parse(sidecar.createdAt) : NaN;
      if (!Number.isFinite(ageMs)) {
        try {
          const stat = await fs.stat(target);
          ageMs = now - stat.mtimeMs;
        } catch {
          ageMs = 0;
        }
      }
      if (ageMs < maxAgeMs) {
        result.skipped.push(target);
        continue;
      }

      const removed = await removeRunWorktree({
        path: target,
        repoRoot: sidecar.repoRoot,
        branch: sidecar.branch,
        rootDir,
        deleteBranch: true,
      });
      if (removed.ok) result.removed.push(target);
      else result.errors.push(removed.error);
    }
  } catch (err: unknown) {
    result.errors.push(
      `Не удалось прочитать каталог worktree «${rootDir}»: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await releaseCleanupLock(rootDir);
  }

  return result;
}
