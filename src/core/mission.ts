/**
 * AB-8: ad-hoc миссия (`run_mission`) — полоса B execution model.
 *
 * Миссия проходит тот же путь, что и зарегистрированная задача:
 * `createRun → план → маршрут → исполнение → GATE → ledger`. Отличие только
 * в источнике входа: задача не создаётся и не регистрируется в планировщике
 * ОС. Исполнение идёт через обёртку (lock, таймаут, политика прав, Quality
 * Gate, запись истории), но без `schtasks`/`crontab`/`launchd`.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { LOG_DIR, sanitizeName } from "../types.js";
import {
  buildExecutionPlan,
  createAdHocRunContext,
  describeExecutionPlan,
  executeExecutionPlan,
  type ExecutionPlan,
  type ExecutionResult,
  type RunContext,
  type RunPermissionPolicy,
  type StepExecutor,
} from "./execution.js";
import { buildOpencodeConfig } from "./permissions.js";
import {
  ensureWrapper,
  lockFilePath,
  writePromptFile,
  writeWrapperCmd,
} from "./ps-wrapper.js";
import {
  generateSessionId,
  normalizeSessionMode,
  sessionStatePath,
  writeSessionStateFile,
  type SessionMode,
} from "./session.js";
import { writeBashWrapper } from "./wrappers/bash.js";

/**
 * Маркер начала прогона в логе задачи/миссии.
 *
 * Лог НЕ очищается перед запуском: при падении до первого вывода обёртки он
 * остался бы пустым и диагностировать причину было бы невозможно. Маркер
 * разделяет прогоны в общем файле и подтверждает, что запуск действительно
 * дошёл до подготовки обёртки.
 */
export function formatLogRunMarker(
  kind: "run" | "mission" | "prepare",
  taskName: string,
  now: Date = new Date(),
): string {
  // "prepare" — задача только что создана/подготовлена, но ещё НЕ запускалась.
  // ВАЖНО: не называть этот маркер "Run started", иначе в логе задачи
  // появляется ложная запись о запуске при create/update/dry-run, хотя
  // реального прогона не было (finding QA #8).
  if (kind === "prepare") {
    return `[agent-steward] === Task prepared ${now.toISOString()} (${taskName}) ===\n`;
  }
  const label = kind === "run" ? "Run" : "Mission";
  return `[agent-steward] === ${label} started ${now.toISOString()} (${taskName}) ===\n`;
}

/** AB-8.1: спецификация ad-hoc миссии (цель + safety-контракт). */
export interface MissionSpec {
  /** Цель миссии — тот же промпт, что получил бы OpenCode. */
  prompt: string;
  /** Рабочая директория; по умолчанию — cwd процесса. */
  cwd?: string;
  /** Имя запуска в ledger; по умолчанию генерируется `ad-hoc-*`. */
  taskName?: string;
  /** Тип задачи для маршрутизатора; по умолчанию `mission` (local/direct). */
  taskType?: string;
  /** Модель OpenCode (пусто — модель по умолчанию). */
  model?: string;
  /** Режим сессии OpenCode. */
  session?: SessionMode;
  /** Идентификатор сессии для `session=reuse`. */
  sessionId?: string;
  /** Таймаут исполнения в секундах (по умолчанию 3600). */
  timeoutSeconds?: number;
  /** Quality Gate: команда, ненулевой код которой проваливает миссию. */
  gate?: string;
  /** Таймаут Quality Gate в секундах (по умолчанию 300). */
  gateTimeoutSeconds?: number;
  /** Политика прав: hybrid (по умолчанию), secure, legacy. */
  policy?: RunPermissionPolicy;
  /** Allowlist инструментов; непустой список блокирует остальные. */
  allowedTools?: string[];
  /** Denylist инструментов; выигрывает у allowlist. */
  deniedTools?: string[];
  /** Только построить план и показать трассировку, не исполняя. */
  dryRun?: boolean;
}

/** Результат ad-hoc миссии. */
export interface MissionResult {
  success: boolean;
  dryRun: boolean;
  runId: string | null;
  status: ExecutionResult["status"] | "planned";
  plan: ExecutionPlan;
  description: string;
  steps: ExecutionResult["steps"];
  error: string | null;
  logFile: string | null;
}

/** Зависимости для тестов: позволяют подменить исполнение без OpenCode. */
export interface MissionDependencies {
  executor?: StepExecutor;
  /** Хук после подготовки: тест может проверить отсутствие задач в ОС. */
  onPrepared?: (info: { taskName: string; cwd: string }) => void;
}

const DEFAULT_TIMEOUT_SECONDS = 3600;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Активные ad-hoc миссии по workspace — защита от двух миссий в одном репо. */
const activeWorkspaces = new Map<string, string>();

const requireFromCore = createRequire(import.meta.url);

/** Путь к скомпилированному record-history.js (как в index.ts). */
function recorderPath(): string {
  const resolved = requireFromCore.resolve("./record-history.js");
  if (!resolved.endsWith(".ts")) return resolved;
  return resolved
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
}

function assertNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Пустое поле миссии: ${label}.`);
  }
  return value.trim();
}

function positiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Поле миссии "${label}" должно быть целым положительным числом.`);
  }
  return Math.min(value, MAX_TIMEOUT_SECONDS);
}

function normalizeTools(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Поле миссии "${label}" должно быть массивом строк.`);
  }
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function newMissionName(): string {
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString("hex");
  return `ad-hoc-${stamp}-${random}`;
}

/**
 * AB-8.1: валидирует и нормализует вход. Возвращает безопасную копию спеки,
 * чтобы CLI/RPC/GUI не могли передать нестроковые поля в обёртку.
 */
export function normalizeMissionSpec(input: MissionSpec): MissionSpec {
  if (!input || typeof input !== "object") {
    throw new Error("Спецификация миссии должна быть объектом.");
  }
  const prompt = assertNonEmpty(input.prompt, "prompt");
  const cwd = input.cwd?.trim() ? path.resolve(input.cwd.trim()) : process.cwd();
  const taskName = input.taskName?.trim() ? input.taskName.trim() : undefined;
  if (taskName && taskName.length > 200) {
    throw new Error("Имя миссии длиннее 200 символов.");
  }
  const session = normalizeSessionMode(input.session);
  if (!session) {
    throw new Error('Поле "session" должно быть new, reuse или last.');
  }
  if (session === "reuse" && input.sessionId !== undefined && !/^ses_[A-Za-z0-9]{10,64}$/.test(input.sessionId)) {
    throw new Error('Поле "sessionId" должно иметь формат ses_<id>.');
  }
  const policy = input.policy ?? "hybrid";
  if (policy !== "hybrid" && policy !== "secure" && policy !== "legacy") {
    throw new Error('Поле "policy" должно быть hybrid, secure или legacy.');
  }
  const allowedTools = normalizeTools(input.allowedTools, "allowedTools");
  const deniedTools = normalizeTools(input.deniedTools, "deniedTools");
  const denied = new Set((deniedTools ?? []).map((tool) => tool.toLowerCase()));
  const conflict = (allowedTools ?? []).find((tool) => denied.has(tool.toLowerCase()));
  if (conflict) {
    throw new Error(`Инструмент "${conflict}" одновременно разрешён и запрещён.`);
  }
  return {
    prompt,
    cwd,
    taskName,
    taskType: input.taskType?.trim() || undefined,
    model: input.model?.trim() || undefined,
    session,
    sessionId: input.sessionId?.trim() || undefined,
    timeoutSeconds: positiveInt(
      input.timeoutSeconds,
      "timeoutSeconds",
      DEFAULT_TIMEOUT_SECONDS,
    ),
    gate: input.gate?.trim() || undefined,
    gateTimeoutSeconds:
      input.gateTimeoutSeconds === undefined
        ? undefined
        : positiveInt(input.gateTimeoutSeconds, "gateTimeoutSeconds", 300),
    policy,
    allowedTools,
    deniedTools,
    dryRun: input.dryRun === true,
  };
}

/** Создаёт RunContext ad-hoc миссии (без task definition). */
export function createMissionContext(spec: MissionSpec): RunContext {
  return createAdHocRunContext(spec.prompt, {
    cwd: spec.cwd,
    taskName: spec.taskName,
    taskType: spec.taskType ?? "mission",
    policy: spec.policy ?? "hybrid",
    profile: {
      model: spec.model,
      session: spec.session ?? "new",
      sessionId: spec.sessionId,
    },
    safety: {
      policy: spec.policy ?? "hybrid",
      allowedTools: spec.allowedTools,
      deniedTools: spec.deniedTools,
    },
    metadata: {
      mission: true,
      gate: spec.gate ?? null,
      timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    },
  });
}

interface WrapperPlan {
  wrapperPath: string;
  logFile: string;
}

/** Готовит обёртку с lock/таймаутом/политикой/Quality Gate, но без ОС. */
async function prepareWrapper(
  spec: MissionSpec,
  context: RunContext,
  taskName: string,
): Promise<WrapperPlan> {
  const sanitized = sanitizeName(taskName);
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);
  const promptFile = await writePromptFile(taskName, spec.prompt);
  await fs.mkdir(LOG_DIR, { recursive: true });
  try {
    // Не очищаем лог: при раннем падении до вывода обёртки он остался бы пустым.
    // Дописываем маркер начала прогона — он же разделяет запуски в общем файле.
    await fs.appendFile(logFile, formatLogRunMarker("mission", taskName), "utf8");
  } catch (error) {
    // Обёртки пишут лог через >> и создают файл сами: маркер нужен только для
    // диагностики. Не срываем миссию из-за прав доступа к каталогу логов.
    console.warn(
      `[agent-steward] Не удалось записать маркер в лог миссии (${logFile}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const lockFile = lockFilePath(taskName);
  const sessionMode = spec.session ?? "new";
  let sessionId = spec.sessionId;
  if (sessionMode === "reuse" && !sessionId) {
    sessionId = generateSessionId();
  }
  if (sessionMode === "reuse") {
    await writeSessionStateFile(taskName, sessionId);
  }
  const sessionFile = sessionMode === "reuse" ? sessionStatePath(taskName) : undefined;
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  if (process.platform === "win32") {
    const permissionsConfig = buildOpencodeConfig({
      policy: context.safety.policy,
      allowedTools: spec.allowedTools,
      deniedTools: spec.deniedTools,
    });
    await ensureWrapper();
    const wrapperPath = await writeWrapperCmd(
      sanitized,
      taskName,
      promptFile,
      timeoutSeconds,
      lockFile,
      context.cwd,
      logFile,
      recorderPath(),
      spec.gate,
      spec.model,
      undefined,
      undefined,
      undefined,
      spec.allowedTools,
      spec.deniedTools,
      undefined,
      undefined,
      sessionMode,
      sessionId,
      spec.gateTimeoutSeconds,
      permissionsConfig,
      { policy: context.safety.policy, legacyShell: false },
      sessionFile,
    );
    return { wrapperPath, logFile };
  }

  const wrapperPath = await writeBashWrapper({
    sanitizedName: sanitized,
    taskName,
    promptFile,
    timeoutSeconds,
    lockFile,
    workdir: context.cwd,
    logFile,
    recorderFile: recorderPath(),
    qualityGate: spec.gate,
    model: spec.model,
    policy: context.safety.policy,
    allowedTools: spec.allowedTools,
    deniedTools: spec.deniedTools,
    sessionMode,
    sessionId,
    sessionFile,
    gateTimeoutSeconds: spec.gateTimeoutSeconds,
  });
  return { wrapperPath, logFile };
}

/** Прямой запуск обёртки: ОС-задача не создаётся, процесс ждём здесь. */
async function runWrapperProcess(
  wrapperPath: string,
  cwd: string,
  timeoutSeconds: number,
): Promise<{ output: string; error: string | null }> {
  const timeoutMs = (timeoutSeconds + 120) * 1000;
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${wrapperPath}"`], {
          cwd,
          windowsHide: true,
          env: process.env,
        })
        : spawn("bash", [wrapperPath], {
          cwd,
          windowsHide: true,
          env: process.env,
        });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (target: "out" | "err", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (target === "out") stdout = (stdout + text).slice(-200_000);
      else stderr = (stderr + text).slice(-200_000);
    };
    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        output: stdout,
        error: `Миссия превысила внешний таймаут ${timeoutSeconds + 120} с.`,
      });
    }, timeoutMs);
    timer.unref?.();

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"), error });
    };

    child.on("error", (error) => finish(error.message));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }
      finish(
        `Обёртка миссии завершилась с кодом ${code ?? "null"}${
          signal ? ` (сигнал ${signal})` : ""
        }.`,
      );
    });
  });
}

function createWrapperExecutor(
  wrapperPath: string,
  spec: MissionSpec,
): StepExecutor {
  return {
    id: "mission-wrapper",
    supports: (route) => route.executor !== null,
    async execute() {
      const { output, error } = await runWrapperProcess(
        wrapperPath,
        spec.cwd ?? process.cwd(),
        spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      );
      return error ? { output, error } : { output };
    },
  };
}

/**
 * AB-8: единая точка входа ad-hoc миссии для CLI, RPC и GUI.
 *
 * Инварианты EXECUTION-LOOP §2.1: нет записи в планировщике ОС, работают
 * GATE, политика прав, ledger (`runs`/`run_steps`) и аудит; параллельные
 * обычные миссии в одном workspace не допускаются.
 *
 * W-3 (контракт dryRun): `dryRun: true` строит план и описание, но не захватывает
 * `activeWorkspaces` и не пишет ledger (`runs`/`run_steps`) — это контракт, а не
 * утечка контекста. Поэтому несколько dry-run в одном `cwd` проходят параллельно.
 */
export async function runMission(
  input: MissionSpec,
  dependencies: MissionDependencies = {},
): Promise<MissionResult> {
  const spec = normalizeMissionSpec(input);
  const taskName = spec.taskName ?? newMissionName();
  spec.taskName = taskName;
  const context = createMissionContext(spec);
  const plan = await buildExecutionPlan(context);
  const description = describeExecutionPlan(plan);

  if (spec.dryRun) {
    dependencies.onPrepared?.({ taskName, cwd: context.cwd });
    return {
      success: true,
      dryRun: true,
      runId: null,
      status: "planned",
      plan,
      description,
      steps: [],
      error: null,
      logFile: null,
    };
  }

  const workspaceKey = path.resolve(context.cwd);
  const running = activeWorkspaces.get(workspaceKey);
  if (running) {
    throw new Error(
      `В workspace ${workspaceKey} уже выполняется миссия "${running}". Дождитесь её завершения.`,
    );
  }
  activeWorkspaces.set(workspaceKey, taskName);

  try {
    let executor = dependencies.executor;
    let logFile: string | null = null;
    if (!executor) {
      const prepared = await prepareWrapper(spec, context, taskName);
      logFile = prepared.logFile;
      executor = createWrapperExecutor(prepared.wrapperPath, spec);
    }
    dependencies.onPrepared?.({ taskName, cwd: context.cwd });

    const result = await executeExecutionPlan(plan, {
      executors: [executor],
      stopOnError: true,
      metadata: {
        adHoc: true,
        gate: spec.gate ?? null,
        timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      },
    });

    return {
      success: result.status === "passed",
      dryRun: false,
      runId: result.runId,
      status: result.status,
      plan,
      description,
      steps: result.steps,
      error: result.error,
      logFile,
    };
  } finally {
    activeWorkspaces.delete(workspaceKey);
  }
}
