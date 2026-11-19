/**
 * W-3 (0.0.6): guard-условия задачи.
 *
 * Guard — опциональный набор предварительных проверок перед запуском агента.
 * Если проверка не проходит, прогон пропускается без запуска opencode:
 *  - semantic: файлы/ветка/изменённые пути в git-worktree;
 *  - command: произвольная shell-команда (exit 0 = можно запускать).
 *
 * Модуль не бросает исключения наружу: ошибка проверки трактуется как
 * fail-closed (прогон пропускается).
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { matchesAnyGlob, matchesGlob } from "./glob.js";

const execFileAsync = promisify(execFile);

/** Код выхода CLI-помощника: guard не пройден, прогон нужно пропустить. */
export const GUARD_SKIP_EXIT_CODE = 4;
/** Таймаут shell-guard по умолчанию. */
export const DEFAULT_GUARD_TIMEOUT_SECONDS = 60;
const MAX_COMMAND_LENGTH = 4000;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_LIST_ITEMS = 200;
const MAX_CAPTURED_OUTPUT = 16 * 1024;

export interface SemanticGuardConfig {
  /** Все пути должны существовать (относительно рабочей директории). */
  filesExist?: string[];
  /** Ни один из путей не должен существовать. */
  filesMissing?: string[];
  /** Glob-шаблон текущей git-ветки, например `feature/*`. */
  branch?: string;
  /** Glob-шаблоны изменённых путей; достаточно совпадения хотя бы с одним. */
  changedPaths?: string[];
  /** Git-ref для сравнения изменений. По умолчанию `HEAD~1`. */
  changedSince?: string;
}

export interface TaskGuards {
  /** Shell-команда: exit 0 — запускать, любой другой код — пропустить. */
  command?: string;
  /** Таймаут shell-guard в секундах (1..3600, по умолчанию 60). */
  timeoutSeconds?: number;
  /** Семантические проверки рабочей директории. */
  semantic?: SemanticGuardConfig;
}

export interface GuardEvaluation {
  /** true — все проверки пройдены, задачу можно запускать. */
  passed: boolean;
  /** Причины пропуска (человекочитаемые). */
  reasons: string[];
  /** Выполненные проверки (для лога). */
  checks: string[];
}

export type NormalizeGuardsResult =
  | { ok: true; guards?: TaskGuards }
  | { ok: false; error: string };

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRelativePath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.includes("\0")) return null;
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("/")) {
    return null;
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    return null;
  }
  return trimmed;
}

function readStringList(
  raw: unknown,
  label: string,
  errors: string[],
): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${label} должен быть массивом строк.`);
    return undefined;
  }
  if (raw.length > MAX_LIST_ITEMS) {
    errors.push(`${label}: не больше ${MAX_LIST_ITEMS} элементов.`);
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      errors.push(`${label} должен содержать только строки.`);
      return undefined;
    }
    const normalized = normalizeRelativePath(item);
    if (!normalized) {
      errors.push(
        `${label}: путь «${item}» должен быть относительным и не содержать «.» или «..».`,
      );
      return undefined;
    }
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.length > 0 ? result : undefined;
}

function normalizeSemantic(
  raw: unknown,
  errors: string[],
): SemanticGuardConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    errors.push("guards.semantic должен быть объектом.");
    return undefined;
  }
  const allowed = new Set(["filesExist", "filesMissing", "branch", "changedPaths", "changedSince"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push(`guards.semantic: неизвестное поле «${key}».`);
  }

  const filesExist = readStringList(raw.filesExist, "guards.semantic.filesExist", errors);
  const filesMissing = readStringList(raw.filesMissing, "guards.semantic.filesMissing", errors);
  const changedPaths = readStringList(raw.changedPaths, "guards.semantic.changedPaths", errors);

  let branch: string | undefined;
  if (raw.branch !== undefined && raw.branch !== null) {
    if (typeof raw.branch !== "string" || !raw.branch.trim()) {
      errors.push("guards.semantic.branch должен быть непустой строкой.");
    } else if (raw.branch.length > 200 || /[\u0000-\u001f\u007f]/.test(raw.branch)) {
      errors.push("guards.semantic.branch слишком длинный или содержит управляющие символы.");
    } else {
      branch = raw.branch.trim();
    }
  }

  let changedSince: string | undefined;
  if (raw.changedSince !== undefined && raw.changedSince !== null) {
    if (
      typeof raw.changedSince !== "string" ||
      !/^[A-Za-z0-9._/@{}~^-]+$/.test(raw.changedSince) ||
      raw.changedSince.startsWith("-")
    ) {
      errors.push(
        "guards.semantic.changedSince должен быть git-ref (буквы, цифры, . _ / @ { } ~ ^ -).",
      );
    } else {
      changedSince = raw.changedSince;
    }
  }

  if (!filesExist && !filesMissing && !branch && !changedPaths && !changedSince) {
    return undefined;
  }
  return {
    ...(filesExist ? { filesExist } : {}),
    ...(filesMissing ? { filesMissing } : {}),
    ...(branch ? { branch } : {}),
    ...(changedPaths ? { changedPaths } : {}),
    ...(changedSince ? { changedSince } : {}),
  };
}

/**
 * Валидирует guard-конфигурацию из JSON/инструмента/импорта.
 * Возвращает нормализованный объект либо ошибку; никогда не бросает.
 */
export function normalizeTaskGuards(input: unknown): NormalizeGuardsResult {
  if (input === undefined || input === null) return { ok: true };
  if (!isPlainObject(input)) return { ok: false, error: "guards должен быть объектом." };

  const errors: string[] = [];
  const allowed = new Set(["command", "timeoutSeconds", "semantic"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`guards: неизвестное поле «${key}».`);
  }

  let command: string | undefined;
  if (input.command !== undefined && input.command !== null) {
    if (typeof input.command !== "string") {
      errors.push("guards.command должен быть строкой.");
    } else {
      const trimmed = input.command.trim();
      if (!trimmed) {
        errors.push("guards.command не должен быть пустым.");
      } else if (trimmed.length > MAX_COMMAND_LENGTH) {
        errors.push(`guards.command длиннее ${MAX_COMMAND_LENGTH} символов.`);
      } else if (trimmed.includes("\0")) {
        errors.push("guards.command содержит NUL-символ.");
      } else {
        command = trimmed;
      }
    }
  }

  let timeoutSeconds: number | undefined;
  if (input.timeoutSeconds !== undefined && input.timeoutSeconds !== null) {
    if (
      typeof input.timeoutSeconds !== "number" ||
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      errors.push(`guards.timeoutSeconds должен быть целым числом 1..${MAX_TIMEOUT_SECONDS}.`);
    } else {
      timeoutSeconds = input.timeoutSeconds;
    }
  }

  const semantic = normalizeSemantic(input.semantic, errors);
  if (errors.length > 0) return { ok: false, error: errors.join(" ") };

  if (!command && !semantic) return { ok: true };
  return {
    ok: true,
    guards: {
      ...(command ? { command } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {}),
      ...(semantic ? { semantic } : {}),
    },
  };
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      ok: false,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
      stderr:
        typeof err.stderr === "string"
          ? err.stderr
          : typeof err.message === "string"
            ? err.message
            : String(error),
    };
  }
}

function resolveInside(cwd: string, relative: string): string | null {
  const base = path.resolve(cwd);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function lastOutputLine(command: string, cwd: string, timeoutSeconds: number): Promise<{
  code: number | null;
  timedOut: boolean;
  output: string;
}> {
  return await new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENT_STEWARD_GUARD: "1" },
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut, output });
    };

    const append = (chunk: Buffer | string) => {
      if (output.length >= MAX_CAPTURED_OUTPUT) return;
      output += chunk.toString().slice(0, MAX_CAPTURED_OUTPUT - output.length);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutSeconds * 1000);
    timer.unref?.();

    child.on("error", (error) => {
      output += String(error);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Выполняет guard-проверки в указанной рабочей директории.
 * Никогда не бросает: любая ошибка означает «пропустить».
 */
export async function evaluateGuards(
  guards: TaskGuards,
  options: { cwd: string },
): Promise<GuardEvaluation> {
  const checks: string[] = [];
  const reasons: string[] = [];
  const cwd = path.resolve(options.cwd);

  const fail = (reason: string): GuardEvaluation => {
    reasons.push(reason);
    return { passed: false, reasons, checks };
  };

  try {
    const semantic = guards.semantic;
    if (semantic) {
      if (semantic.filesExist) {
        for (const relative of semantic.filesExist) {
          const target = resolveInside(cwd, relative);
          if (!target) return fail(`файл вне рабочей директории: ${relative}`);
          try {
            await fs.access(target);
            checks.push(`filesExist: ${relative}`);
          } catch {
            return fail(`нет файла: ${relative}`);
          }
        }
      }

      if (semantic.filesMissing) {
        for (const relative of semantic.filesMissing) {
          const target = resolveInside(cwd, relative);
          if (!target) return fail(`файл вне рабочей директории: ${relative}`);
          try {
            await fs.access(target);
            return fail(`файл не должен существовать: ${relative}`);
          } catch {
            checks.push(`filesMissing: ${relative}`);
          }
        }
      }

      if (semantic.branch) {
        const result = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (!result.ok) return fail(`не удалось определить git-ветку: ${result.stderr.trim()}`);
        const branch = result.stdout.trim();
        if (!branch || branch === "HEAD") return fail("git-ветка не определена (detached HEAD)");
        if (!matchesGlob(branch, semantic.branch)) {
          return fail(`ветка «${branch}» не соответствует «${semantic.branch}»`);
        }
        checks.push(`branch: ${branch}`);
      }

      if (semantic.changedPaths) {
        const base = semantic.changedSince ?? "HEAD~1";
        let diff = await git(cwd, ["diff", "--name-only", `${base}..HEAD`]);
        if (!diff.ok) {
          // Корневой коммит: у HEAD~1 нет родителя.
          diff = await git(cwd, ["show", "--name-only", "--format=", "HEAD"]);
        }
        if (!diff.ok) {
          return fail(`не удалось получить изменённые пути: ${diff.stderr.trim()}`);
        }
        const changed = diff.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => line.replace(/\\/g, "/"));
        const matched = changed.find((file) => matchesAnyGlob(file, semantic.changedPaths));
        if (!matched) {
          return fail(
            `нет изменённых путей по шаблонам «${semantic.changedPaths.join(", ")}» (${base})`,
          );
        }
        checks.push(`changedPaths: ${matched}`);
      }
    }

    if (guards.command) {
      const timeout = guards.timeoutSeconds ?? DEFAULT_GUARD_TIMEOUT_SECONDS;
      const result = await lastOutputLine(guards.command, cwd, timeout);
      const lastLine =
        result.output
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .pop()
          ?.slice(0, 300) ?? "";
      if (result.timedOut) {
        return fail(`shell guard превысил таймаут ${timeout} с`);
      }
      if (result.code !== 0) {
        const suffix = lastLine ? `: ${lastLine}` : "";
        return fail(
          result.code === null
            ? `shell guard не выполнился${suffix}`
            : `shell guard завершился с кодом ${result.code}${suffix}`,
        );
      }
      checks.push("command: exit 0");
    }
  } catch (error) {
    return fail(`ошибка проверки guard: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { passed: reasons.length === 0, reasons, checks };
}
