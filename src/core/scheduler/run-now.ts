import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { requestImmediateRun } from "../ps-wrapper.js";
import { isProcessAlive, parseLockToken } from "../lock.js";
import { LOCK_DIR, STALE_LOCK_MAX_AGE_MS } from "../../types.js";
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
  // PL-120 / PL-144: путь — это ведущая последовательность path-подобных
  // символов (буквы/цифры/_, @, ., +, /, \, -, плюс * для glob). Кириллица
  // НЕ входит в алфавит пути: русская проза («только TEST-PLAN.md») не должна
  // трактоваться как путь и ломать pre-flight. Всё, что идёт после первого
  // иного символа (пробел, тире, кириллица), — не путь. Отсекаем хвост вида
  // "docs/FEATURES.md. Файл src/core/agents.ts — заглушка" и прекращаем разбор:
  // дальше в SCOPE путей уже нет.
  const pathRun = /^[A-Za-z0-9_@.+\/\-\\*]+/;
  // QA-PORT-17: «голые» слова в SCOPE — это проза («tp-audit-dev, branch dev.»),
  // а не пути. Путь должен содержать разделитель (/ или \) либо расширение
  // файла; иначе префлайт PL-79/PL-82 ошибочно объявляет прозу missing.
  const looksLikePath = (value: string): boolean =>
    value.includes("/") || value.includes("\\") || /\.[A-Za-z0-9]{1,8}$/.test(value);
  const result: string[] = [];
  for (const raw of line[1].split(/[,;]/)) {
    const value = raw
      .trim()
      .replace(/^[`"'\[\]]+|[`"'\[\].]+$/g, "")
      .trim();
    const lead = pathRun.exec(value);
    if (!lead) continue;
    const candidate = lead[0].replace(/[`"'\[\].]+$/g, "").trim();
    if (candidate && looksLikePath(candidate)) {
      // SCOPE может содержать директории вида src/core/scheduler/*.
      result.push(
        candidate.endsWith("/*") || candidate.endsWith("\\*")
          ? candidate.slice(0, -2)
          : candidate,
      );
    }
    if (lead[0] !== value) break;
  }
  return result;
}

/** PL-79 / PL-82: результат проверки SCOPE-путей на существование. */
export interface ScopeCheck {
  ok: boolean;
  /** Нормализованные пути из SCOPE. */
  paths: string[];
  /** Пути, которых нет на диске. */
  missing: string[];
  /** QA-D316-3: абсолютные пути, по которым проверялись `missing` (параллельно `missing`). */
  resolved: string[];
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
  /**
   * QA-PORT-2: явный флаг «все SCOPE-пути могут быть созданы задачей».
   * Полезен, когда намерение создания выражено не текстом промпта.
   */
  allowCreate?: boolean;
  /**
   * QA-PORT-2: распознавать в промпте фразы «создай файл X» / «new file X»
   * и считать такой SCOPE-путь ожидаемо создаваемым. По умолчанию включено;
   * `false` возвращает строгое поведение PL-79/PL-82.
   */
  recognizeCreateIntent?: boolean;
}

/**
 * QA-PORT-2: цель создания файла, прямо выраженная в промпте.
 *
 * Разбираем только предложения с явным глаголом создания; пути берём из того
 * же предложения, чтобы «создай docs/new.md» работало, а случайное упоминание
 * SCOPE без глагола — нет. Отрицания («не создавай», "do not create") не
 * считаются намерением создать файл.
 */
export function extractCreateIntentPaths(prompt: string): string[] {
  const createVerb =
    /(?:созда(?:й|ть|ём|ете|л|ли|в)?|нов(?:ый|ая|ое)\s+файл|добав(?:ь|ить)\s+файл|create|new\s+file)(?=\s|$|[.,:;!?])/iu;
  const negation = /(?:^|\s)(?:не|not|never|dont|don't)\s+(?:созда|добав|create|add)/iu;
  const pathLike = /[A-Za-z0-9_@.+\/\\-]+/g;
  const result: string[] = [];
  // Точку НЕ используем как разделитель: она часть расширения файла (foo.md).
  for (const segment of prompt.split(/[\r\n]+|[!?;]+/)) {
    if (!createVerb.test(segment) || negation.test(segment)) continue;
    for (const match of segment.matchAll(pathLike)) {
      const token = match[0].replace(/^[.]+|[.]+$/g, "");
      // Путь должен быть похож на файл: разделитель каталогов или расширение.
      if (!/[/\\]|\.[A-Za-z0-9]{1,8}$/.test(token)) continue;
      if (!result.includes(token)) result.push(token);
    }
  }
  return result;
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
  // QA-PORT-2: явный флаг разрешает любые отсутствующие SCOPE-пути (например,
  // намерение создания expressed не текстом промпта).
  if (!Array.isArray(opts) && opts?.allowCreate === true) {
    return { ok: true, paths, missing: [], resolved: [] };
  }
  const filesCreate = Array.isArray(opts) ? opts : opts?.filesCreate;
  const created = new Set((filesCreate ?? []).map((item) => scopePathKey(item, root)));
  // QA-D316-3: тот же резолв, что и при проверке существования, чтобы `resolved`
  // показывал именно тот абсолютный путь, по которому файл искался.
  const resolvePath = (item: string): string =>
    path.isAbsolute(item) ? item : path.resolve(root || process.cwd(), item);
  const missing = paths.filter((item) => {
    // PL-119: create-intent — файл ещё не существует, но это ожидаемо.
    if (created.has(scopePathKey(item, root))) return false;
    return !fsSync.existsSync(resolvePath(item));
  });
  return { ok: missing.length === 0, paths, missing, resolved: missing.map(resolvePath) };
}

/** PL-79 / PL-82 / PL-119: pre-flight проверка SCOPE из промпта задачи. */
export function preflightScope(
  prompt: string,
  root: string,
  opts?: ScopeCheckOptions | string[],
): ScopeCheck {
  const options: ScopeCheckOptions = Array.isArray(opts)
    ? { filesCreate: opts }
    : (opts ?? {});
  // QA-PORT-2: «создай новый файл X» + «SCOPE: X» — X ещё не существует, но
  // это ожидаемо. Объединяем с явным filesCreate; strict-режим можно вернуть
  // через recognizeCreateIntent: false.
  const inferred = options.recognizeCreateIntent === false
    ? []
    : extractCreateIntentPaths(prompt);
  return validateScopePaths(extractScopePaths(prompt), root, {
    ...options,
    filesCreate: [...(options.filesCreate ?? []), ...inferred],
  });
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
 * с другими; остальные — только по одной на чек-аут (каталог задачи).
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
  // QW-8: includes("PL-1") матчился внутри PL-10/PL-100, из-за чего закрытая
  // находка считалась открытой. Ищем ID только по границам слова.
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idPattern = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`);
  const inRoadmap = idPattern.test(roadmap);
  const inChangelog = idPattern.test(changelog);
  const inDiff = idPattern.test(gitDiff);
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
async function checkStaleTaskBeforeRun(
  taskName: string,
  checkoutRoot?: string,
): Promise<StaleVerdict | null> {
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
  const root = checkoutRoot || definition.workingDirectory?.trim() || process.cwd();
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
 * QA-D316-18: путь checkout-lock'а, который PowerShell-обёртка создаёт перед
 * запуском агента. Ключ — первые 16 hex-символов SHA256 от корня чек-аута
 * (точная формула из `ps-wrapper.ts`), иначе Node не сможет увидеть пропуск.
 */
export function checkoutLockPath(checkoutRoot: string): string {
  const key = createHash("sha256").update(checkoutRoot, "utf8").digest("hex").slice(0, 16);
  return path.join(LOCK_DIR, `checkout-${key}.lock`);
}

/** QA-D316-18: активный checkout-lock и причина пропуска. */
export interface CheckoutLockVerdict {
  path: string;
  reason: string;
}

/**
 * QA-D316-18: определяет, удерживается ли checkout-lock другой задачей.
 *
 * Логика повторяет ps-wrapper: живой PID-владелец означает активный запуск;
 * мёртвый PID (или age > STALE_LOCK_MAX_AGE_MS без PID) — осиротевший lock,
 * который обёртка всё равно вытеснит, поэтому пропускать запуск не нужно.
 * Ошибки чтения трактуем fail-open: обёртка остаётся последней защитой.
 */
export async function activeCheckoutLock(
  checkoutRoot: string,
): Promise<CheckoutLockVerdict | null> {
  const lockPath = checkoutLockPath(checkoutRoot);
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return null;
  }
  if (!stat.isFile() && !stat.isDirectory()) return null;
  let content = "";
  try {
    content = await fs.readFile(
      stat.isDirectory() ? path.join(lockPath, "pid") : lockPath,
      "utf8",
    );
  } catch {
    // Нет токена — решение принимаем по времени изменения файла.
  }
  const token = parseLockToken(content);
  const reason = `PL-121: в чек-ауте ${checkoutRoot} уже идёт другая задача — запуск пропущен`;
  if (token.pid !== null) {
    return isProcessAlive(token.pid) ? { path: lockPath, reason } : null;
  }
  const fromToken = token.createdAt ? Date.parse(token.createdAt) : NaN;
  const age = Number.isFinite(fromToken) ? Date.now() - fromToken : Date.now() - stat.mtimeMs;
  return age <= STALE_LOCK_MAX_AGE_MS ? { path: lockPath, reason } : null;
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
  // QA-D316-18: корень чек-аута совпадает с рабочим каталогом задачи — именно
  // его хеширует обёртка. Для worktree-задач это тоже репозиторий (обёртка
  // выставляет AGENT_STEWARD_WORKTREE_REPO = effectiveWorkdir).
  let checkoutRoot = process.cwd();
  try {
    checkoutRoot = getTask(taskName)?.workingDirectory?.trim() || checkoutRoot;
  } catch {
    // Диагностика не должна ломать сам запуск.
  }

  // PL-99: до запуска отсекаем задачи по уже закрытым находкам.
  try {
    const stale = await checkStaleTaskBeforeRun(taskName, checkoutRoot);
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

  // QA-D316-18: обёртка могла пропустить запуск из-за чужого checkout-lock и
  // вернуть exit 0 — бэкенд ОС при этом доложил об успехе. Проверяем lock в
  // Node-слое ДО `/run`, чтобы skipped/reason дошли до run_task_now.
  try {
    const locked = await activeCheckoutLock(checkoutRoot);
    if (locked) {
      return { alreadyRunning: false, skipped: true, reason: locked.reason };
    }
  } catch {
    // Fail-open: последняя защита остаётся в PowerShell-обёртке.
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
