import { Plugin } from "@opencode/plugin";
import type {
  Hooks as V1Hooks,
  PluginInput as V1PluginInput,
  PluginModule as V1PluginModule,
} from "@opencode-ai/plugin";
// V1 `tool()` — тривиальная identity-функция (`input => input`). Инлайним её,
// чтобы точка входа V2 не импортировала devDependency @opencode-ai/plugin:
// у пользователя OpenCode 2 этот пакет не установлен, и статический импорт
// ломал загрузку плагина целиком (ERR_MODULE_NOT_FOUND).
const v1Tool = <T>(input: T): T => input;
import { z } from "zod";
import type { Tool } from "@opencode/schema/tool";
import type { Skill } from "@opencode/schema/skill";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
// QA-A2.7: безопасное приведение unknown к строке без no-base-to-string.
import { safeStringify } from "./text.js";
import { applyModelRecommendation } from "./core/dry-run.js";
import { LockManager } from "./core/lock.js";
import {
  LOCK_DIR,
  LOG_DIR,
  PLUGIN_DIR,
  STALE_LOCK_MAX_AGE_MS,
  WRAPPER_DIR,
  sanitizeName,
  validateTaskName,
} from "./types.js";
import { parseCron, buildScheduleGate, isValidIanaTimeZone, validateLaunchWindow, prevRun, nextRun as cronNextRun, normalizeActiveDays, activeWindowState, nextWindowOpenDelayMs, assessCronWindowFeasibility, windowFeasibilityReasonText } from "./core/schedule-v2.js";
import {
  buildLaunchdOneShotCleanup,
  normalizeOneShotRunAt,
} from "./core/one-shot.js";
import {
  generateSessionId,
  normalizeSessionMode,
  preservedSessionRunCount,
  sessionStatePath,
  writeSessionStateFile,
} from "./core/session.js";
import { ensureWrapper, writePromptFile, writeWrapperCmd, lockFilePath, requestImmediateRun, gateAllowPathsFromScope } from "./core/ps-wrapper.js";
import { getSchedulerBackend, LinuxScheduler } from "./core/scheduler/index.js";
import { SCHEDULER_SKILL_ID, loadSchedulerSkill } from "./skill.js";
import { getTaskLogs, resolveTaskLogPath } from "./core/scheduler/logs.js";
import {
  planParallelExecution,
  planRuntimeIsolation,
  preflightScope,
} from "./core/scheduler/run-now.js";
import {
  findSanitizedNameConflict,
  sanitizedConflictMessage,
  validateModelReference,
} from "./core/task-name.js";
import { modelAvailabilityWarning } from "./core/opencode-cli.js";
import { listAvailableModels } from "./core/opencode-models.js";
import { writeBashWrapper } from "./core/wrappers/bash.js";
import { normalizeTaskGuards, type TaskGuards } from "./core/guard.js";
import {
  simulatePipeline,
  workingDirectoryDriftWarning,
  type DryRunReport,
} from "./core/dry-run.js";
import {
  aggregateMatrixResults,
  cancelPendingMatrixClones,
  expandMatrixTask,
  findOrphanedMatrixTasks,
  getMatrixDeletionGuard,
  isKnownMatrix,
  matrixCompleteName,
  planMatrixFamilyDelete,
  removeMatrixChildren,
  runMatrix,
  syncMatrixFamily,
} from "./core/matrix.js";
import { normalizeWatchPath, validateWatchGlobs } from "./core/watch-paths.js";
import { createShutdownGate, type ShutdownGateState } from "./core/shutdown.js";
import { CHILD_RUN_ENV, isChildRunMode } from "./core/run-mode.js";
import { SchedulerRpc } from "./rpc.js";
import {
  loadPipelineFile,
  parsePipelineYaml,
  type PipelineParseResult,
} from "./core/pipeline-io.js";
import { planPipelineApply } from "./core/pipeline-apply.js";
import {
  pipelineExportLookupError,
  tasksToPipelineSpec,
} from "./core/pipeline-map.js";
import { stringify as yamlStringify } from "yaml";
import { latestHistoryByTask, loadHistory, loadMetrics } from "./history.js";
import {
  defaultNotifications,
  loadSettings,
  saveSettings,
  type FeedbackSettings,
} from "./settings.js";
import { resolveLocale, setLocale, t, type Locale, type LocaleMode } from "./i18n.js";
import type {
  AuditSettings,
  HistorySettings,
  IntegrationSettings,
  NotificationSettings,
  PermissionSettings,
  TriageSettings,
} from "./settings.js";
import { formatLogRunMarker, runMission, type MissionSpec } from "./core/mission.js";
import {
  DEFAULT_PERMISSION_POLICY,
  buildOpencodeConfig,
  resolvePermissions,
} from "./core/permissions.js";
import { runHistoryRetention, maybeRunHistoryRetention } from "./core/retention.js";
import { buildAnalytics } from "./core/analytics.js";
import {
  buildBudgetReport,
  evaluateRunBudgetGate,
  formatBudgetSkipMessage,
  tokenEfficiencyScore,
  startOfUtcWeek,
  type BudgetGateDecision,
  type BudgetSettings,
  type RunBudgetGateDecision,
} from "./core/budget.js";
import { generateSelfAnalysisReport } from "./core/self-analysis.js";
import {
  finishRun,
  getHistoryForAnalytics,
  getHistoryForBudget,
  listRunningRecords,
  recordRun,
} from "./db/history-repo.js";
import { appendStructuredLog } from "./core/structured-log.js";
import { getAllMetrics } from "./db/metrics-repo.js";
import { discardDlq, listDlq, retryDlqExecution } from "./core/dlq-api.js";
import {
  listRunPanel,
  pauseRunPanel,
  resumeDurableRunExecution,
} from "./core/run-panel-api.js";
import { decideApprovalPanel, listApprovalPanel } from "./core/approval-api.js";
import {
  findStuckMatrixClones,
  maybeSendDigest,
  notifyBudgetExceeded,
  notifyStuckMatrix,
  sendBugReport,
  sendDigestNow,
  sendTestNotification,
} from "./notifications.js";
import {
  FEEDBACK_LIMITS,
  flushOutbox,
  redactText,
  reportFeedback,
} from "./core/feedback.js";
import {
  shadowReport,
  resetShadowDecisions,
} from "./core/triage-shadow.js";
import { compareTriage } from "./core/triage-compare.js";
import { applyLocalAiPatch, summarizeLocalAi, type LocalAiPatch } from "./core/local-ai.js";
import { classifyNotification, type TriageInput } from "./core/triage.js";
import {
  loadTaskDefinitions,
  saveTaskDefinition,
  removeTaskDefinition,
  buildExportJson,
  parseImportJson,
  normalizePriority,
} from "./task-transfer.js";
import type {
  FileWatchManager} from "./core/file-watcher.js";
import {
  FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,
} from "./core/file-watcher.js";
import type { GitTriggerManager } from "./core/git-trigger.js";
import type {
  McpEventTrigger,
  MatrixConfig,
  MatrixWorkspaceOverride,
  TaskDefinition,
} from "./task-transfer.js";
import { loadTemplates, saveTemplate, deleteTemplate } from "./templates.js";
import type { TaskTemplate } from "./templates.js";
import {
  startDashboardServer,
  closeDashboardServer,
  getDashboardPort,
  probeDashboardOn,
  discoverDashboardPort,
} from "./server.js";
import {
  DEFAULT_PROFILE,
  createProfile,
  deleteProfile,
  getProfileDir,
  getProfileName,
  isProfilePinnedByEnv,
  listProfiles,
  sanitizeProfileName,
  setActiveProfile,
} from "./profiles.js";
import { closeDb, initDb } from "./db/index.js";
import { migrateJsonToDb } from "./db/migrate.js";
import { checkJsonBackups, recoverInterruptedRuns } from "./db/recovery.js";
import { getTask, listMatrixClones, listTasks as listTaskDefinitions, saveTask } from "./db/tasks-repo.js";
import {
  addWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
  validateWorkspacePath,
  readGitBranch,
  writeWorkspaceEnvFile,
  maskEnvForLog,
} from "./workspaces.js";
import {
  deleteSecret,
  collectSecretNames,
  getSecret,
  hasSecret,
  listSecrets,
  setSecret,
} from "./core/secrets.js";
import {
  auditDateFilterError,
  readAuditLog,
  recordAudit,
  recordTaskToolBlocks,
  verifyGateLedgerIntegrity,
} from "./core/audit.js";
import type { AuditEntryInput } from "./core/audit.js";
// P-1.1: ядро запуска и построитель спецификаций вынесены в модули без @opencode/*.
// Entrypoint остаётся единственным адаптером платформы (V1/V2).
import {
  createRuntimeCore,
  type RuntimeDeps,
  type RuntimeContextLike,
  type SchedulerRuntime,
} from "./runtime.js";
import { buildToolSpecs, type ToolSpec as ToolSpecLike } from "./tool-specs.js";
export type { RuntimeContextLike, SchedulerRuntime } from "./runtime.js";
export type { ToolSpec, ToolSpecExecute, ToolSpecAudit, ToolResultLike } from "./tool-specs.js";

// Путь к вспомогательному node-скрипту записи истории/метрик (dist/core/record-history.js).
const require = createRequire(import.meta.url);
const resolvedRecorder = require.resolve("./core/record-history.js");

// Д6: ворота выгрузки. После dispose новые in-process запуски отклоняются,
// а начатые — получают время завершить запись в БД.
const shutdownGate = createShutdownGate();
const SHUTDOWN_WAIT_MS = 15_000;

/**
 * Плагин может загружаться как из dist, так и напрямую из src (tsx/транспиляция).
 * Node не умеет исполнять .ts, поэтому для фоновых задач всегда берём
 * скомпилированный dist/core/record-history.js.
 */
const recorderPath = (() => {
  if (!resolvedRecorder.endsWith(".ts")) return resolvedRecorder;
  const distPath = resolvedRecorder
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[agent-steward] Не найден собранный record-history.js: " +
      `${distPath}. История/метрики не будут записываться. Выполните npm run build.`,
  );
  return distPath;
})();

/**
 * Путь к гейту расписания (dist/core/schedule-gate.js). Обёртка запускает его
 * перед opencode и выходит, если cron не сработал или запуск перенесён.
 */
const gatePath = (() => {
  const resolved = require.resolve("./core/schedule-gate.js");
  if (!resolved.endsWith(".ts")) return resolved;
  const distPath = resolved
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[agent-steward] Не найден собранный schedule-gate.js: " +
      `${distPath}. Гейт расписания не будет проверяться. Выполните npm run build.`,
  );
  return distPath;
})();

/**
 * W-1: путь к помощнику создания одноразового git worktree
 * (dist/core/worktree-run.js). Обёртка вызывает его перед opencode.
 */
const worktreeHelperPath = (() => {
  const resolved = require.resolve("./core/worktree-run.js");
  if (!resolved.endsWith(".ts")) return resolved;
  const distPath = resolved
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[agent-steward] Не найден собранный worktree-run.js: " +
      `${distPath}. Изоляция в git worktree не будет работать. Выполните npm run build.`,
  );
  return distPath;
})();

/**
 * W-3: путь к CLI-помощнику guard-условий (dist/core/guard-run.js).
 */
const guardHelperPath = (() => {
  const resolved = require.resolve("./core/guard-run.js");
  if (!resolved.endsWith(".ts")) return resolved;
  const distPath = resolved
    .replace(/([\\/])src([\\/])/, "$1dist$2")
    .replace(/\.ts$/, ".js");
  if (existsSync(distPath)) return distPath;
  console.warn(
    "[agent-steward] Не найден собранный guard-run.js: " +
      `${distPath}. Guard-условия не будут проверяться. Выполните npm run build.`,
  );
  return distPath;
})();

/** Бэкенд планировщика текущей ОС (schtasks / crontab / launchd). */
const scheduler = getSchedulerBackend();

/** Per-workspace overrides for matrix clones (Sprint 17). */
export const matrixOverrideSchema = z.object({
  prompt: z.string().optional(),
  model: z.string().optional(),
  qualityGate: z.string().optional(),
  beforeScript: z.string().optional(),
  afterScript: z.string().optional(),
});

/** Matrix (fan-out) configuration. */
export const matrixSchema = z.object({
  workspaceIds: z
    .array(z.string())
    .describe("Workspace ids to fan out to. Cannot be combined with workspaceId."),
  strategy: z
    .enum(["parallel", "sequential"])
    .optional()
    .describe(
      "parallel (default) starts all clones at once; sequential starts the next clone only after the previous one finishes.",
    ),
  failureMode: z
    .enum(["continue", "stop"])
    .optional()
    .describe(
      "continue (default) keeps running the remaining clones after a failure; stop aborts the rest.",
    ),
  aggregation: z
    .enum(["summary", "per-task"])
    .optional()
    .describe(
      "summary (default) writes one aggregate record for the parent; per-task keeps per-clone records.",
    ),
  createAggregator: z
    .boolean()
    .optional()
    .describe(
      "Also create the <parent>-matrix-complete task depending on every clone.",
    ),
  concurrency: z
    .number()
    .optional()
    .describe(
      "Maximum number of clones running at the same time (>= 1). Ignored for sequential (always 1) and capped by the global maxConcurrent setting.",
    ),
  overrides: z
    .record(z.string(), matrixOverrideSchema)
    .optional()
    .describe(
      "Per-workspace overrides keyed by workspace id. Keys must be present in workspaceIds.",
    ),
});

/** W-3: guard-условия задачи. */
export const guardsSchema = z.object({
  command: z
    .string()
    .max(4000)
    .optional()
    .describe("Shell command evaluated before the run. Exit 0 runs the task; any other code skips it."),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(3600)
    .optional()
    .describe("Shell guard timeout in seconds (default 60)."),
  semantic: z
    .object({
      filesExist: z.array(z.string()).max(200).optional().describe("Paths that must exist."),
      filesMissing: z.array(z.string()).max(200).optional().describe("Paths that must not exist."),
      branch: z.string().max(200).optional().describe("Glob for the current git branch, e.g. feature/*."),
      changedPaths: z
        .array(z.string())
        .max(200)
        .optional()
        .describe("Globs of changed paths; at least one must match."),
      changedSince: z
        .string()
        .max(100)
        .optional()
        .describe("Git ref to diff against (default HEAD~1)."),
    })
    .optional()
    .describe("Semantic pre-run checks inside the working directory."),
}).describe("W-3: guard conditions. If a check fails, the run is skipped before opencode starts.");

/**
 * QA-P2.1: маска glob не может быть пустой или содержать пробелы.
 * Пробел в `** /*.md` молча сужает совпадение до файлов с пробелом в имени.
 */
const globMaskSchema = z.string().min(1).refine((mask) => !/\s/.test(mask), {
  message: "Glob mask must be non-empty and contain no whitespace.",
});

/**
 * QA-P2.1: единая проверка диапазонов для MCP и RPC.
 * Zod-схемы защищают только MCP-путь; RPC (create_task/update_task) принимает
 * сырой JSON и вызывает эту функцию явно, до normalizePriority(), который
 * молча обрезает priority до 0..10.
 * Возвращает текст ошибки или null.
 */
export function validateTaskInputRanges(input: {
  prompt?: string;
  timeoutSeconds?: number;
  priority?: number;
  retryCount?: number;
  retryDelay?: number;
  watchPath?: string;
  triggerType?: string;
  watchGlobs?: string[];
  watchIgnore?: string[];
  gitPaths?: string[];
  gitIgnore?: string[];
}): string | null {
  if (input.prompt !== undefined && !input.prompt.trim()) {
    return "prompt must be a non-empty string.";
  }
  if (
    input.timeoutSeconds !== undefined &&
    (!Number.isInteger(input.timeoutSeconds) || input.timeoutSeconds <= 0)
  ) {
    return "timeoutSeconds must be a positive integer.";
  }
  if (
    input.priority !== undefined &&
    (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 10)
  ) {
    return "priority must be an integer between 0 and 10.";
  }
  if (
    input.retryCount !== undefined &&
    (!Number.isInteger(input.retryCount) || input.retryCount < 0)
  ) {
    return "retryCount must be a non-negative integer.";
  }
  if (
    input.retryDelay !== undefined &&
    (!Number.isInteger(input.retryDelay) || input.retryDelay < 0)
  ) {
    return "retryDelay must be a non-negative integer.";
  }
  const globFields: [string, string[] | undefined][] = [
    ["watchGlobs", input.watchGlobs],
    ["watchIgnore", input.watchIgnore],
    ["gitPaths", input.gitPaths],
    ["gitIgnore", input.gitIgnore],
  ];
  for (const [field, masks] of globFields) {
    if (!Array.isArray(masks)) continue;
    for (const mask of masks) {
      if (typeof mask !== "string" || !mask.trim() || /\s/.test(mask)) {
        return `${field} masks must be non-empty strings without whitespace.`;
      }
    }
  }
  if (
    input.triggerType === "file" &&
    input.watchPath !== undefined &&
    !input.watchPath.trim()
  ) {
    return "watchPath must be a non-empty path when triggerType is file.";
  }
  return null;
}

/** Zod-схема аргументов schedule_task */
export const scheduleTaskSchema = z.object({
  name: z
    .string()
    .describe(
      "Unique task name (the plugin prefix is applied automatically). Allowed: letters (including Cyrillic), digits, space, dot, underscore and ASCII hyphen '-'. Do NOT use the em dash '—' or round brackets '()': validation rejects them and the original title will be lost. Use ASCII '-' and plain words instead, e.g. 'QA-A2 - Full plugin typing epic'.",
    ),
  schedule: z
    .string()
    .optional()
    .describe(
      "Cron expression (5 fields: minute hour day-of-month month day-of-week). Required for triggerType=cron; ignored for file/mcp-event. Supports ranges, lists, */N steps, month/weekday names, @every 15m|2h|1d, L (last day of month) and FRI#3 (third Friday). Expressions schtasks cannot express are checked every minute inside the wrapper.",
    ),
  runAt: z
    .string()
    .optional()
    .describe(
      "Absolute one-shot start time in ISO-8601 (e.g. 2026-12-01T09:00:00Z). Requires triggerType=once; mutually exclusive with delaySeconds (runAt wins).",
    ),
  delaySeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "One-shot delay in seconds from now. Requires triggerType=once. Convenient alternative to runAt.",
    ),
  session: z
    .enum(["new", "reuse", "last"])
    .optional()
    .describe(
      "OpenCode session mode for the task: new (default, fresh session per run), reuse (keep a persistent session stored on the task — sessionId is auto-generated), last (continue the latest session via --continue).",
    ),
  sessionMaxRuns: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe(
      "Only for session=reuse: how many runs the reused session survives before it is deleted and a fresh one is created. Unset/0 — no limit.",
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone of the schedule, e.g. Europe/Moscow. Defaults to the system timezone. A zone different from the system one is evaluated by the wrapper (poll mode).",
    ),
  notBefore: z
    .string()
    .optional()
    .describe(
      "Launch window start in HH:MM (24h). Together with notAfter: a run outside the window is postponed to the next window opening, not skipped.",
    ),
  notAfter: z
    .string()
    .optional()
    .describe("Launch window end in HH:MM (24h). May be earlier than notBefore (window crosses midnight)."),
  prompt: z
    .string()
    .min(1, "prompt must be a non-empty string.")
    .refine((value) => value.trim().length > 0, "prompt must be a non-empty string.")
    .describe("Prompt passed to the agent on every run."),
  /**
   * PL-119: файлы, которые задача создаст при выполнении (например,
   * `src/core/environment.ts`, `locales/tr.json`). Их SCOPE-пути освобождаются
   * от pre-flight проверки существования. Без параметра поведение прежнее.
   */
  filesCreate: z
    .array(z.string())
    .optional()
    .describe(
      "Files the task will create during the run (e.g. src/core/environment.ts, locales/tr.json). These SCOPE paths skip the pre-flight existence check; omit to require all SCOPE paths to exist.",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Run timeout in seconds (default 3600)."),
  model: z
    .string()
    .optional()
    .refine((value) => validateModelReference(value) === null, {
      message:
        'Модель должна быть в формате "provider/model" (например, opencode/hy4-flash-free, anthropic/claude-3-5-sonnet, openai/gpt-4o). Модель без префикса провайдера отклоняется; доступные модели: `opencode models`.',
    })
    .describe(
      "LLM model in OpenCode format provider/model, e.g. opencode/hy4-flash-free or anthropic/claude-3-5-sonnet. A model without a provider/ prefix is rejected. Empty value uses the OpenCode default model.",
    ),
  autoSelectModel: z
    .boolean()
    .optional()
    .describe(
      "B-2.1: when true and no explicit model is set, automatically pick the recommended model (free for routine tasks, paid for complex ones). An explicitly provided model is never overridden.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Task priority 0..10 (10 is the highest). Default 5 (normal)."),
  beforeScript: z
    .string()
    .optional()
    .describe(
      "Pre-flight shell command executed before the run (e.g. git pull). A non-zero exit code cancels the run.",
    ),
  afterScript: z
    .string()
    .optional()
    .describe(
      "Post-flight shell command executed after the run (e.g. git push). Runs even when the task fails.",
    ),
  qualityGate: z
    .string()
    .optional()
    .describe(
      "Shell command executed after a successful AI response (e.g. npm test). A non-zero exit code marks the run as a Quality Gate failure.",
    ),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe(
      "DAG dependencies: tasks that must finish successfully before this task starts.",
    ),
  retryCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("How many times to retry a failed run (default 0)."),
  retryDelay: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Delay between retries in seconds (default 60)."),
  nextTaskOnSuccess: z
    .string()
    .optional()
    .describe("Task started after a successful run."),
  nextTaskOnError: z
    .string()
    .optional()
    .describe("Compensation/rollback task started after a failed run."),
  triggerType: z
    .enum(["cron", "file", "git", "mcp-event", "once"])
    .optional()
    .describe(
      "Trigger type: cron (default), file, git (new commits in the task working directory), mcp-event or once (single run at runAt/delaySeconds).",
    ),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      eventName: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      filter: z.string().optional(),
    })
    .optional()
    .describe(
      "MCP event trigger: server, event (or its alias eventName) and an optional filter (key=value or regex). At least one of event/eventName is required for triggerType=mcp-event.",
    ),
  watchPath: z
    .string()
    .optional()
    .describe(
      "File or directory to watch when triggerType is \"file\". Can be set here or later via update_task.",
    ),
  watchGlobs: z
    .array(globMaskSchema)
    .optional()
    .describe(
      "Glob masks that limit a file trigger, e.g. [\"**/*.md\", \"src/**\"]. Empty means any change under watchPath.",
    ),
  watchIgnore: z
    .array(globMaskSchema)
    .optional()
    .describe(
      "Glob masks excluded from a file trigger, e.g. [\"node_modules/**\", \"*.log\"]. Supports leading ! to re-include.",
    ),
  gitBranch: z
    .string()
    .optional()
    .describe(
      "Only for triggerType=git: branch name or glob (main, release/*, comma-separated). Empty means any branch.",
    ),
  gitPaths: z
    .array(globMaskSchema)
    .optional()
    .describe(
      "Only for triggerType=git: glob masks of changed files that must match to start the task (git diff --name-only).",
    ),
  gitIgnore: z
    .array(globMaskSchema)
    .optional()
    .describe("Only for triggerType=git: glob masks of changed files to ignore."),
  gitPollSeconds: z
    .number()
    .int()
    .min(5)
    .optional()
    .describe("Only for triggerType=git: polling interval in seconds (default 60, minimum 5)."),
  activeDays: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe(
      "Allowed weekdays 0=Sunday..6=Saturday for cron and event triggers. Empty or all seven means every day.",
    ),
  windowPolicy: z
    .enum(["skip", "postpone", "run"])
    .optional()
    .describe(
      "Behaviour outside the launch window / active days: postpone (default, wait for the next opening), skip or run anyway.",
    ),
  workingDirectory: z
    .string()
    .optional()
    .describe(
      "Working directory of the task. Defaults to the current project folder so opencode run picks up the project's opencode.json with MCP servers.",
    ),
  workspaceId: z
    .string()
    .optional()
    .describe(
      "Multi-repo workspace binding. When set, cwd = workspace path and workingDirectory is ignored.",
    ),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe(
      "Role-scoped tool allow-list, enforced through OPENCODE_CONFIG_CONTENT. A non-empty list also allows actions that the default policy denies (for example shell). An empty array is rejected.",
    ),
  deniedTools: z
    .array(z.string())
    .optional()
    .describe(
      "Role-scoped tool deny-list (takes precedence over allowedTools and over the default policy). Enforced through OPENCODE_CONFIG_CONTENT.",
    ),
  legacyShell: z
    .boolean()
    .optional()
    .describe(
      "Transitional flag (release 1.6): under the hybrid policy, re-enable shell for this task. Prefer listing shell in allowedTools. Ignored by secure/legacy policy.",
    ),
  runWhenLoggedOff: z
    .boolean()
    .optional()
    .describe(
      "Windows only: run the task even when no user is logged on (/ru SYSTEM). The task runs in session 0 without the user's profile, mapped drives or saved credentials, so tasks that need the user's environment may fail. Creating such a task usually requires an elevated shell. Default false: interactive only — the task runs only while the user is logged on.",
    ),
  worktree: z
    .boolean()
    .optional()
    .describe(
      "W-1: run each tick in a one-off git worktree created from HEAD of workingDirectory. Keeps fan-out runs isolated from each other and from the main checkout. Requires a git repository; creation failure fails the run closed. Default false.",
    ),
  guards: guardsSchema
    .optional()
    .describe(
      "W-3: pre-run guard conditions. If a semantic check or shell command fails, the run is skipped (no opencode, no side effects). Combined with worktree: checks run inside the fresh worktree.",
    ),
  tokenBudget: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe(
      "Economics v2 (E-2): per-run token budget. 0 or omitted = no task limit (fail-open). Exceeded runs are flagged in analytics; stopping is E-2.2.",
    ),
  matrix: matrixSchema
    .optional()
    .describe(
      "Matrix fan-out: the task becomes a template that is expanded into clones, one per workspace. The parent never runs itself. Cannot be combined with workspaceId.",
    ),
  harness: z
    .enum(["opencode", "dsh-headless", "acp", "cursor-cli"])
    .optional()
    .describe(
      "P-3.4: agent invoker for the task. Defaults to opencode CLI; unknown values are not accepted by the schema (import degrades to opencode for compatibility).",
    ),
}).superRefine((value, ctx) => {
  const trigger = value.triggerType ?? "cron";
  if (trigger === "cron" && !value.schedule?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["schedule"],
      message: t("tool.error.cronSchedule"),
    });
  }
  if (
    trigger === "once" &&
    !value.runAt &&
    value.delaySeconds === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: t("tool.error.onceSchedule"),
    });
  }
  if (trigger === "once" && value.matrix) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matrix"],
      message: t("tool.error.onceMatrixSchema"),
    });
  }
  if (trigger !== "once" && (value.runAt || value.delaySeconds !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: t("tool.error.onceFields"),
    });
  }
  // QA-P2.1: явная пустая строка watchPath при file-триггере бессмысленна.
  if (trigger === "file" && value.watchPath !== undefined && !value.watchPath.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["watchPath"],
      message: "watchPath must be a non-empty path when triggerType is file.",
    });
  }
});

const listTasksSchema = z.object({});

/** PL-43: структурированный ответ list_tasks для Code Mode (V2). */
const listTasksOutputSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  tasks: z.array(z.unknown()),
  osAvailable: z.boolean(),
  osError: z.string().optional(),
});

const deleteTaskSchema = z.object({
  name: z.string().describe("Task name to delete."),
});

const runTaskNowSchema = z.object({
  name: z
    .string()
    .describe(
      "Task name to run immediately. While the plugin unloads the tool returns a structured PLUGIN_SHUTTING_DOWN error (message + retry hint).",
    ),
});

export const updateTaskSchema = z.object({
  name: z.string().describe("Name of the task to update."),
  schedule: z
    .string()
    .optional()
    .describe("New cron expression. Keeps the current value when omitted."),
  runAt: z
    .string()
    .optional()
    .describe(
      "New one-shot time in ISO-8601. Requires triggerType=once. Empty string clears it.",
    ),
  delaySeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "New one-shot delay in seconds from now. Requires triggerType=once.",
    ),
  session: z
    .enum(["new", "reuse", "last"])
    .optional()
    .describe(
      "OpenCode session mode for the task: new (fresh session per run), reuse (keep a persistent session stored on the task — sessionId is auto-generated), last (continue the latest session via --continue).",
    ),
  sessionMaxRuns: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe(
      "Only for session=reuse: how many runs the reused session survives before it is deleted and a fresh one is created. Unset/0 — no limit.",
    ),
  timezone: z
    .string()
    .optional()
    .describe("New IANA timezone. Empty string clears it (system timezone)."),
  notBefore: z
    .string()
    .optional()
    .describe("New launch window start HH:MM. Empty string clears the window."),
  notAfter: z
    .string()
    .optional()
    .describe("New launch window end HH:MM. Empty string clears the window."),
  activeDays: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe(
      "New allowed weekdays 0=Sunday..6=Saturday. Empty array clears the restriction.",
    ),
  windowPolicy: z
    .enum(["skip", "postpone", "run"])
    .optional()
    .describe("New behaviour outside the window: postpone (default), skip or run."),
  runWhenLoggedOff: z
    .boolean()
    .optional()
    .describe(
      "Windows only: true runs the task without a logged-on user (/ru SYSTEM, session 0 without the user profile, mapped drives or saved credentials; usually requires an elevated shell). false/omitted keeps the task interactive-only.",
    ),
  watchGlobs: z
    .array(globMaskSchema)
    .optional()
    .describe("New glob masks for a file trigger. Empty array clears them."),
  watchIgnore: z
    .array(globMaskSchema)
    .optional()
    .describe("New ignore masks for a file trigger. Empty array clears them."),
  gitBranch: z
    .string()
    .optional()
    .describe("New git branch filter (glob, comma-separated). Empty string clears it."),
  gitPaths: z
    .array(globMaskSchema)
    .optional()
    .describe("New changed-file masks for a git trigger. Empty array clears them."),
  gitIgnore: z
    .array(globMaskSchema)
    .optional()
    .describe("New ignored changed-file masks for a git trigger. Empty array clears them."),
  gitPollSeconds: z
    .number()
    .int()
    .min(5)
    .optional()
    .describe("New git polling interval in seconds."),
  prompt: z
    .string()
    .refine((value) => value.trim().length > 0, "prompt must be a non-empty string.")
    .optional()
    .describe("New prompt. Keeps the current value when omitted."),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("New run timeout in seconds."),
  model: z
    .string()
    .optional()
    .refine((value) => validateModelReference(value) === null, {
      message:
        'Модель должна быть в формате "provider/model" (например, opencode/hy4-flash-free, anthropic/claude-3-5-sonnet, openai/gpt-4o). Модель без префикса провайдера отклоняется; доступные модели: `opencode models`.',
    })
    .describe(
      "New model in OpenCode format provider/model (e.g. opencode/hy4-flash-free). Empty string clears it (default model).",
    ),
  autoSelectModel: z
    .boolean()
    .optional()
    .describe(
      "B-2.1: enable or disable automatic model selection when no explicit model is set. false disables, true re-picks the model for the new prompt. An explicitly provided model always wins.",
    ),
  priority: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("New priority 0..10."),
  beforeScript: z
    .string()
    .optional()
    .describe("New pre-flight command. Empty string clears it."),
  afterScript: z
    .string()
    .optional()
    .describe("New post-flight command. Empty string clears it."),
  qualityGate: z
    .string()
    .optional()
    .describe("New Quality Gate command. Empty string clears it."),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe("New DAG dependencies. Empty array clears them."),
  retryCount: z.number().int().nonnegative().optional().describe("New retry count."),
  retryDelay: z.number().int().nonnegative().optional().describe("New retry delay in seconds."),
  nextTaskOnSuccess: z
    .string()
    .optional()
    .describe("New success-chain task. Empty string clears it."),
  nextTaskOnError: z
    .string()
    .optional()
    .describe("New error-chain task. Empty string clears it."),
  triggerType: z
    .enum(["cron", "file", "git", "mcp-event", "once"])
    .optional()
    .describe("New trigger type."),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      eventName: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      filter: z.string().optional(),
    })
    .optional()
    .describe(
      "New MCP event trigger: event (or its alias eventName); at least one of them is required for triggerType=mcp-event.",
    ),
  watchPath: z
    .string()
    .optional()
    .describe("New file-trigger path. Empty string clears it."),
  workingDirectory: z
    .string()
    .optional()
    .describe("New working directory. Empty string clears it."),
  workspaceId: z
    .string()
    .optional()
    .describe("New workspace binding. Empty string clears it."),
  allowedTools: z
    .array(z.string())
    .optional()
    .describe("New tool allow-list. Empty array clears it."),
  deniedTools: z
    .array(z.string())
    .optional()
    .describe("New tool deny-list. Empty array clears it."),
  legacyShell: z
    .boolean()
    .optional()
    .describe(
      "Transitional flag (release 1.6): re-enable shell under the hybrid policy for this task.",
    ),
  worktree: z
    .boolean()
    .optional()
    .describe(
      "W-1: run each tick in a one-off git worktree created from HEAD of workingDirectory. Default false.",
    ),
  guards: guardsSchema
    .optional()
    .describe("W-3: pre-run guard conditions; a failed check skips the run."),
  tokenBudget: z
    .number()
    .int()
    .min(0)
    .max(10_000_000)
    .optional()
    .describe(
      "Economics v2 (E-2): per-run token budget. 0 or omitted = no task limit (fail-open). Pass 0 to clear a previous limit.",
    ),
  matrix: matrixSchema
    .nullable()
    .optional()
    .describe(
      "New matrix configuration. Pass null to turn the matrix off (clones and aggregator are removed).",
    ),
  harness: z
    .enum(["opencode", "dsh-headless", "acp", "cursor-cli"])
    .optional()
    .describe("P-3.4: agent invoker for the task; omitted keeps the current harness."),
}).superRefine((value, ctx) => {
  if (
    value.triggerType !== undefined &&
    value.triggerType !== "once" &&
    (value.runAt || value.delaySeconds !== undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runAt"],
      message: t("tool.error.onceFields"),
    });
  }
  if (value.triggerType === "once" && value.matrix) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["matrix"],
      message: t("tool.error.onceMatrixUpdate"),
    });
  }
  // QA-P2.1: пустой watchPath допустим только для очистки не-file триггера.
  if (
    value.triggerType === "file" &&
    value.watchPath !== undefined &&
    !value.watchPath.trim()
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["watchPath"],
      message: "watchPath must be a non-empty path when triggerType is file.",
    });
  }
});

/**
 * T-2: «толстые» поля живут в full-схемах `schedule_advanced`/`update_advanced`.
 * Дешёвый профиль получает те же checking-правила, но без matrix/DAG/retry/
 * notification/триггерных блоков — экономия ~4.5k токенов на запрос.
 */
const ADVANCED_SCHEMA_KEYS = [
  "matrix",
  "guards",
  "dependsOn",
  "retryCount",
  "retryDelay",
  "nextTaskOnSuccess",
  "nextTaskOnError",
  "mcpEvent",
  "watchGlobs",
  "watchIgnore",
  "gitPaths",
  "gitIgnore",
  "gitPollSeconds",
  "activeDays",
  "windowPolicy",
  "runWhenLoggedOff",
  "sessionMaxRuns",
  "workspaceId",
] as const;

/**
 * Деталь 3.11: краткие описания полей для дефолтного `core`-профиля.
 * Возможности и валидация не меняются — полные подсказки остаются в
 * `schedule_advanced`/`update_advanced`. Цель — снизить цену схемы на каждый
 * запрос главного агента, не теряя качество управления задачами.
 */
const CORE_FIELD_DESCRIPTIONS: Record<string, string> = {
  name: "Task name (unique). Letters/digits/space/./_/- only; no em dash or ().",
  schedule: "5-field cron. Required for triggerType=cron.",
  runAt: "One-shot ISO-8601 start time (triggerType=once).",
  delaySeconds: "One-shot delay in seconds from now (triggerType=once).",
  session: "new | reuse | last (default new).",
  timezone: "IANA zone, e.g. Europe/Moscow. Default: system.",
  notBefore: "Launch window start HH:MM; outside runs are postponed.",
  notAfter: "Launch window end HH:MM; may cross midnight.",
  prompt: "Prompt passed to the agent on every run.",
  filesCreate: "Files the task will create; these SCOPE paths skip the existence check.",
  timeoutSeconds: "Run timeout in seconds (default 3600).",
  model: "provider/model, e.g. opencode/hy4-flash-free. Empty = OpenCode default.",
  autoSelectModel: "true: auto-pick a model when none is set. Explicit model always wins.",
  priority: "0..10 (10 highest). Default 5.",
  beforeScript: "Shell command before the run; non-zero exit cancels it.",
  afterScript: "Shell command after the run; runs even on failure.",
  qualityGate: "Shell command after success; non-zero exit = gate failure.",
  workingDirectory: "Task working directory.",
  workdir: "Alias of workingDirectory.",
  worktree: "Run in an isolated git worktree.",
  tokenBudget: "Maximum tokens per run.",
  harness: "Agent invoker: opencode (default) | dsh-headless | acp | cursor-cli.",
  allowedTools: "Tools the agent may use.",
  deniedTools: "Tools the agent must not use.",
  triggerType: "cron | once | file | mcp-event | git (default cron).",
  watchPath: "Path to watch for triggerType=file.",
  gitBranch: "Branch to watch for triggerType=git.",
};

function slimTaskSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {
    ...(schema.shape as unknown as Record<string, z.ZodTypeAny>),
  };
  for (const key of ADVANCED_SCHEMA_KEYS) {
    delete shape[key];
  }
  for (const [key, description] of Object.entries(CORE_FIELD_DESCRIPTIONS)) {
    if (shape[key]) shape[key] = shape[key].describe(description);
  }
  const slim = z.object(shape);
  const checks = (schema.def as { checks?: Parameters<typeof slim.check> }).checks;
  return checks?.length ? slim.check(...checks) : slim;
}

export const coreScheduleTaskSchema = slimTaskSchema(scheduleTaskSchema);
export const coreUpdateTaskSchema = slimTaskSchema(updateTaskSchema);

const pauseTaskSchema = z.object({
  name: z.string().describe("Task name to pause."),
  until: z
    .string()
    .optional()
    .describe(
      "Optional ISO date/time to resume automatically (e.g. 2026-12-01T09:00:00Z). The plugin re-enables the task at that moment.",
    ),
});

const resumeTaskSchema = z.object({
  name: z.string().describe("Task name to resume."),
});

const getHistorySchema = z.object({
  taskName: z
    .string()
    .optional()
    .describe("Only return runs of this task (case-insensitive)."),
  status: z
    .enum(["running", "success", "error", "timeout", "partial", "needs-resolution"])
    .optional()
    .describe("Only return runs with this status."),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of records to return (default 20, max 200)."),
  compact: z
    .boolean()
    .optional()
    .describe("Trim long error texts to save tokens (default false; full text kept otherwise)."),
});

export const getTaskLogsSchema = z.object({
  name: z.string().optional().describe("Task name to read logs for (alias: taskName)."),
  taskName: z.string().optional().describe("Alias for name; both spellings are accepted."),
  lines: z
    .number()
    .optional()
    .describe("Return only the last N log lines (default 200)."),
});

const dryRunSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "Task name to simulate. When omitted, every task is simulated (pipeline dry run, nothing is executed).",
    ),
});

/** pipeline_validate — проверить опencode.pipeline.yaml (путь или исходник). */
export const pipelineValidateSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Путь к файлу opencode.pipeline.yaml (относительный резолвится против cwd) или source."),
  source: z.string().optional().describe("Исходное содержимое YAML (альтернатива path)."),
  workingDirectory: z
    .string()
    .optional()
    .describe("База для относительного path (по умолчанию cwd процесса, затем подсказки окружения)."),
  dryRun: z
    .boolean()
    .optional()
    .default(true)
    .describe("Если true — только валидация без применения (по умолчанию true)."),
});

/** pipeline_apply — применить opencode.pipeline.yaml к текущему набору задач. */
export const pipelineApplySchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Путь к файлу opencode.pipeline.yaml (относительный резолвится против cwd) или source."),
  source: z.string().optional().describe("Исходное содержимое YAML (альтернатива path)."),
  workingDirectory: z
    .string()
    .optional()
    .describe("База для относительного path (по умолчанию cwd процесса, затем подсказки окружения)."),
  dryRun: z
    .boolean()
    .optional()
    .default(false)
    .describe("Если true — прогон diff'а без применения изменений (по умолчанию false)."),
});

/** pipeline_export — выгрузить задачи конвейера как opencode.pipeline.yaml. */
export const pipelineExportSchema = z
  .object({
    pipeline: z.string().optional().describe("Имя конвейера (pipelineName)."),
    pipelineName: z.string().optional().describe("Алиас параметра pipeline — имя конвейера."),
  })
  .superRefine((value, ctx) => {
    // QA-P3.2: разные имена в двух полях — ошибка, а не молчаливый приоритет pipeline.
    const explicit = value.pipeline?.trim();
    const alias = value.pipelineName?.trim();
    if (explicit && alias && explicit.toLowerCase() !== alias.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pipelineName"],
        message: "Конфликт параметров: pipeline и pipelineName задают разные имена конвейера.",
      });
    }
  });

const manageWorkspacesSchema = z.object({
  action: z
    .enum(["list", "add", "update", "delete"])
    .describe("Workspace operation to perform."),
  id: z.string().optional().describe("Workspace id (update/delete)."),
  name: z.string().optional().describe("Workspace display name (add/update)."),
  path: z.string().optional().describe("Absolute workspace path (add/update)."),
  color: z.string().optional().describe("Marker color, e.g. #4f8cff (add/update)."),
  env: z
    .record(z.string(), z.string())
    .nullable()
    .optional()
    .describe(
      "Workspace environment variables (key → value). Override envFile values; secrets are masked in logs (add/update).",
    ),
  envFile: z
    .string()
    .nullable()
    .optional()
    .describe("Path to the workspace .env file (add/update, null clears it)."),
});

export const matrixControlSchema = z.object({
  action: z
    .enum(["results", "cancel", "cleanup", "preview"])
    .describe(
      "results — aggregate status of a matrix; cancel — cancel pending clones; cleanup — delete orphaned clones and aggregators; preview — dry-expand a matrix config into clone names without creating anything.",
    ),
  name: z
    .string()
    .optional()
    .describe("Matrix parent name (required for results and cancel; used as clone prefix for preview)."),
  workspaceIds: z
    .array(z.string())
    .optional()
    .describe("Preview only: workspace ids to fan out to (omit for every workspace)."),
  strategy: z
    .enum(["parallel", "sequential"])
    .optional()
    .describe("Preview only: clone execution strategy."),
  failureMode: z
    .enum(["continue", "stop"])
    .optional()
    .describe("Preview only: what to do when one clone fails."),
  aggregation: z
    .enum(["summary", "per-task"])
    .optional()
    .describe("Preview only: how clone results are aggregated."),
});

/** get_metrics — общая статистика запусков. */
export const getMetricsSchema = z.object({});

/** get_analytics — аналитика за период. */
export const getAnalyticsSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Analysis window in days (default 14)."),
  topLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many top tasks to include (default 10)."),
});

/** self_analysis — система самоанализа: здоровье, аномалии, тренды, рекомендации. */
export const selfAnalysisSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe("Analysis window in days (default 14)."),
  topLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("How many top tasks to include (default 10)."),
  includeAnomalies: z
    .boolean()
    .optional()
    .describe("Include anomaly detection (default true)."),
  includeTrends: z
    .boolean()
    .optional()
    .describe("Include trend analysis (default true)."),
  includeRecommendations: z
    .boolean()
    .optional()
    .describe("Include recommendations (default true)."),
});

/** manage_settings — глобальные настройки планировщика. */
export const manageSettingsSchema = z.object({
  action: z
    .enum(["get", "list", "update"])
    .describe("get - current settings; list - same as get (agent-friendly alias); update - merge the provided fields and save."),
  maxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(16)
    .optional()
    .describe("How many task runs may execute at the same time."),
  locale: z
    .enum(["auto", "ru", "en", "zh"])
    .optional()
    .describe(
      "Interface language: auto (default, follows OpenCode), ru, en or zh. Applies without restart.",
    ),
  winterMode: z
    .boolean()
    .optional()
    .describe("Winter mode: gentler scheduling of deferred runs."),
  notifications: z
    .any()
    .optional()
    .describe("Notification settings patch (enabled, onlyOnError, webhook, telegram, native, quietHours, templates, filters, matrix, digest, dedup)."),
  history: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).optional(),
      maxRecords: z.number().int().min(100).max(1000000).optional(),
    })
    .optional()
    .describe("History retention policy."),
  integrations: z
    .any()
    .optional()
    .describe(
      "Integration settings patch (hooks: enabled, token, secret, requireSignature, maxBodyBytes, timestampToleranceSeconds).",
    ),
  audit: z
    .any()
    .optional()
    .describe("Audit log settings patch (enabled, retentionDays, maxRecords)."),
  permissions: z
    .object({
      defaultPolicy: z.enum(["hybrid", "secure", "legacy"]).optional(),
    })
    .optional()
    .describe(
      "Tool permission policy for background tasks: hybrid (default; shell/question denied), secure (read-only), legacy (allow everything, 1.5.x behaviour).",
    ),
  budgets: z
    .object({
      enabled: z.boolean().optional(),
      dailyUsd: z.number().min(0).max(1_000_000).optional(),
      weeklyUsd: z.number().min(0).max(1_000_000).optional(),
    })
    .optional()
    .describe(
      "Daily/weekly USD budgets (0 = no limit). Accounting is exposed by get_analytics as report.budgets.",
    ),
  feedback: z
    .object({
      enabled: z.boolean().optional(),
      endpoint: z.string().max(2048).optional(),
      includeLogs: z.boolean().optional(),
      contactEmail: z.string().max(254).optional(),
      maxPerHour: z.number().int().min(1).max(100).optional(),
    })
    .optional()
    .describe(
      "Author feedback (bug reports → GitHub Issues). disabled by default; endpoint must be https (http only for localhost).",
    ),
});

/** manage_local_ai — настройки локального ассистента и триажа (Спринт 30.7). */
export const manageLocalAiSchema = z.object({
  action: z
    .enum(["get", "update", "test"])
    .describe(
      "get — current triage settings and shadow state; update — merge fields and save; test — one classification request against the configured model.",
    ),
  mode: z
    .enum(["off", "rules", "llm", "auto"])
    .optional()
    .describe(
      "off — no triage; rules — built-in rules only; llm — model only; auto — model, then rules (default).",
    ),
  baseUrl: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Ollama or OpenAI-compatible base URL, for example http://127.0.0.1:11434. A URL ending with /v1 switches to the OpenAI protocol.",
    ),
  model: z
    .string()
    .max(200)
    .optional()
    .describe("Model id, for example qwen3:4b."),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(120000)
    .optional()
    .describe("Request timeout in milliseconds (1000..120000)."),
  fallback: z
    .enum(["rules", "notify", "skip"])
    .optional()
    .describe(
      "When the model fails or is unsure: rules - apply rules (fail-open, default); notify - skip the rules step and deliver the notification; skip - legacy alias for notify.",
    ),
  confidenceThreshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum model confidence (0..1); below it the fallback applies."),
  shadow: z
    .object({
      enabled: z.boolean().optional().describe("Log decisions without suppressing notifications."),
      days: z.number().int().min(1).max(365).optional().describe("Shadow period length in days."),
      startedAt: z
        .string()
        .nullable()
        .optional()
        .describe("ISO start of the shadow period; null restarts it on the next save."),
    })
    .optional()
    .describe("Shadow mode patch."),
});

/** manage_templates — пользовательские шаблоны задач. */
export const manageTemplatesSchema = z.object({
  action: z
    .enum(["list", "save", "delete"])
    .describe("list — all templates; save — create or update (id omitted = create); delete — remove by id or name."),
  id: z.string().optional().describe("Template id for update; for delete an id or a template name is accepted."),
  name: z.string().optional().describe("Template name."),
  prompt: z.string().optional().describe("Prompt text stored in the template."),
  schedule: z.string().optional().describe("Cron expression."),
  timeoutSeconds: z.number().int().positive().optional(),
  model: z.string().optional(),
  priority: z.number().int().min(0).max(10).optional(),
  retryCount: z.number().int().min(0).optional(),
  retryDelay: z.number().int().min(0).optional(),
  qualityGate: z.string().optional(),
  beforeScript: z.string().optional(),
  afterScript: z.string().optional(),
  nextTaskOnSuccess: z.string().optional(),
  nextTaskOnError: z.string().optional(),
  dependsOn: z.array(z.string()).optional(),
  triggerType: z.enum(["cron", "file", "mcp-event"]).optional(),
  mcpEvent: z
    .object({
      server: z.string(),
      event: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      eventName: z
        .string()
        .optional()
        .describe(
          "event or eventName (alias); eventName is accepted for emit_event compatibility",
        ),
      filter: z.string().optional(),
    })
    .optional()
    .describe(
      "MCP event trigger: event (or its alias eventName); at least one of them is required for triggerType=mcp-event.",
    ),
  watchPath: z.string().optional(),
  workingDirectory: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
});

/** manage_profiles — изолированные профили планировщика. */
export const manageProfilesSchema = z.object({
  action: z
    .enum(["list", "create", "switch", "delete"])
    .describe("list — profiles; create — new profile; switch — make active (restart required); delete — remove profile data."),
  name: z.string().optional().describe("Profile name (required for create/switch/delete)."),
  port: z.number().int().min(1).max(65535).optional().describe("Dashboard port for a new profile."),
});

/** transfer_tasks — экспорт и импорт задач. */
export const transferTasksSchema = z.object({
  action: z.enum(["export", "import"]).describe("export — JSON snapshot; import — recreate tasks from a snapshot."),
  data: z.string().optional().describe("JSON produced by export (required for import)."),
});

/** send_notification — проверка уведомлений и дайджест. */
export const sendNotificationSchema = z.object({
  action: z
    .enum(["test", "digest"])
    .describe("test — send a test message through the configured channel; digest — send the digest now."),
  channel: z
    .enum(["all", "webhook", "telegram", "native"])
    .optional()
    .describe("For action=test: which channel to check (default all enabled)."),
});

/** report_bug — отчёт о баге; по умолчанию уходит автору через приёмник F-2 (Деталь 3.8). */
export const reportBugSchema = z.object({
  description: z.string().min(1).max(FEEDBACK_LIMITS.description).describe("Описание бага от пользователя (обязательно)."),
  taskName: z.string().max(FEEDBACK_LIMITS.taskName).optional().describe("Имя задачи, к которой относится баг (для прикрепления логов)."),
  /** Приватность: по умолчанию логи НЕ прикладываются (F-1.3). */
  includeLogs: z.boolean().optional().default(false).describe("Включить логи задачи (по умолчанию false)."),
  includeAnalytics: z.boolean().optional().default(true).describe("Включить метрики и аналитику за последние 7 дней."),
  /** Канал локальных уведомлений (для destination local/both). */
  channel: z.enum(["all", "webhook", "telegram", "native"]).optional().describe("Канал локального уведомления."),
  /** Направление: автор (по умолчанию), локальные каналы или оба (F-1.5). */
  destination: z.enum(["author", "local", "both"]).optional().default("author").describe("Куда отправить отчёт."),
  contactEmail: z.string().max(FEEDBACK_LIMITS.contactEmail).optional().describe("Обратный адрес (опционально)."),
  /** Показать точный payload без отправки (F-3.1). */
  dryRun: z.boolean().optional().default(false).describe("Предпросмотр без отправки."),
});

/** get_dashboard_info — сведения о панели управления. */
export const getDashboardInfoSchema = z.object({});

/** cleanup_history — удаление старой истории. */
export const cleanupHistorySchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional().describe("Override the retention window."),
  maxRecords: z.number().int().min(100).max(1000000).optional().describe("Override the record cap."),
});

/** emit_event — запуск задач по MCP-событию. */
export const emitEventSchema = z.object({
  eventName: z.string().min(1).describe("Event name, for example 'deploy.finished'."),
  payload: z.any().optional().describe("Event payload passed to trigger filters."),
  server: z
    .string()
    .optional()
    .describe("Optional MCP source/server name (e.g. 'github'). When set, only tasks with the same mcpEvent.server are triggered."),
});

/** manage_secrets — зашифрованное хранилище секретов (Спринт 26). */
export const manageSecretsSchema = z.object({
  action: z
    .enum(["list", "set", "delete"])
    .describe("list — secret names and previews; set — create or replace; delete — remove by name."),
  name: z
    .string()
    .optional()
    .describe("Secret name ([A-Za-z0-9_.-], max 64 chars). Required for set/delete."),
  value: z.string().optional().describe("Secret value (required for set). Never returned by list."),
});

/** get_audit_log — журнал мутаций задач и настроек (Спринт 26). */
export const getAuditLogSchema = z.object({
  action: z.string().optional().describe("Filter by action, for example task.create."),
  target: z.string().optional().describe("Filter by target name or id."),
  actor: z
    .string()
    .optional()
    .describe("Filter by actor: mcp (agent), gui (dashboard), http (webhook/API)."),
  since: z.string().optional().describe("ISO timestamp lower bound."),
  until: z.string().optional().describe("ISO timestamp upper bound."),
  limit: z.number().int().min(1).max(5000).optional().describe("Max records (default 200)."),
});

type ScheduleArgs = z.infer<typeof scheduleTaskSchema>;
type ListArgs = z.infer<typeof listTasksSchema>;
type DeleteArgs = z.infer<typeof deleteTaskSchema>;
type RunNowArgs = z.infer<typeof runTaskNowSchema>;
type UpdateArgs = z.infer<typeof updateTaskSchema>;
type PauseArgs = z.infer<typeof pauseTaskSchema>;
type ResumeArgs = z.infer<typeof resumeTaskSchema>;
type HistoryArgs = z.infer<typeof getHistorySchema>;
type TaskLogsArgs = z.infer<typeof getTaskLogsSchema>;
type DryRunArgs = z.infer<typeof dryRunSchema>;
type WorkspacesArgs = z.infer<typeof manageWorkspacesSchema>;
type MatrixControlArgs = z.infer<typeof matrixControlSchema>;
type MetricsArgs = z.infer<typeof getMetricsSchema>;
type AnalyticsArgs = z.infer<typeof getAnalyticsSchema>;

/** self_analysis — аргументы системы самоанализа. */
type SelfAnalysisArgs = z.infer<typeof selfAnalysisSchema>;
type SettingsArgs = z.infer<typeof manageSettingsSchema>;
type LocalAiArgs = z.infer<typeof manageLocalAiSchema>;
type TemplatesArgs = z.infer<typeof manageTemplatesSchema>;
type ProfilesArgs = z.infer<typeof manageProfilesSchema>;
type TransferArgs = z.infer<typeof transferTasksSchema>;
type NotificationArgs = z.infer<typeof sendNotificationSchema>;
type ReportBugArgs = z.infer<typeof reportBugSchema>;
type DashboardInfoArgs = z.infer<typeof getDashboardInfoSchema>;
type CleanupHistoryArgs = z.infer<typeof cleanupHistorySchema>;
type EmitEventArgs = z.infer<typeof emitEventSchema>;
type SecretsArgs = z.infer<typeof manageSecretsSchema>;
type AuditLogArgs = z.infer<typeof getAuditLogSchema>;
type PipelineValidateArgs = z.infer<typeof pipelineValidateSchema>;
type PipelineApplyArgs = z.infer<typeof pipelineApplySchema>;
type PipelineExportArgs = z.infer<typeof pipelineExportSchema>;

/**
 * Директория проекта, в которой запущен OpenCode. Используется как рабочая
 * директория задачи по умолчанию, чтобы `opencode run` подхватил opencode.json
 * с MCP-серверами проекта. Заполняется в setup из ctx.location.directory.
 */
let projectDirectory: string | undefined;

/**
 * Общий контекст execute-обработчиков. Обработчики не читают поля контекста,
 * а контексты V1 и V2 устроены по-разному, поэтому на границе адаптеров он
 * сводится к `unknown`. Это позволяет не тащить `Tool.Context` из
 * @opencode/schema/tool в общий контракт инструментов.
 */
type ToolExecuteContext = unknown;

/**
 * Обёртка execute-функции: ловит ошибки и возвращает Tool.Result с content.
 */
function wrapExecute<Args>(
  fn: (args: Args, ctx: ToolExecuteContext) => Promise<Tool.Result>,
): (input: Args, context: ToolExecuteContext) => Promise<Tool.Result> {
  return async (input, context) => {
    try {
      return await fn(input, context);
    } catch (err) {
      const shutdown =
        err instanceof PluginShutdownError
          ? {
            code: err.code,
            hint: err.hint,
            retryable: err.retryable,
            shutdownState: err.state,
          }
          : {};
      // PL-43: тот же payload отдаём и структурированным output, и строкой
      // content — V1-адаптер по-прежнему читает content.
      const output = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        ...shutdown,
      };
      return {
        output,
        content: JSON.stringify(output),
      };
    }
  };
}

/**
 * Спринт 27.5.2: ближайший запуск по определению задачи, без чтения ОС.
 *
 * - `once` → `runAt` (запланированный момент);
 * - пауза (`paused` или будущий `pausedUntil`) → null;
 * - `cron` → ближайшее совпадение cron с учётом окна и дней недели:
 *     * `run` — окно игнорируется;
 *     * `skip` — ищем следующее совпадение внутри окна;
 *     * `postpone` (по умолчанию) — перенос на открытие окна, как в schedule-gate;
 * - `file`/`git`/`mcp-event` → null (расписания нет).
 */
function computeTaskNextRun(
  def:
    | Pick<
        TaskDefinition,
        | "schedule"
        | "triggerType"
        | "runAt"
        | "timezone"
        | "notBefore"
        | "notAfter"
        | "activeDays"
        | "windowPolicy"
        | "pausedUntil"
      >
    | undefined,
  options: { paused?: boolean; now?: Date } = {},
): string | null {
  if (!def) return null;
  if (options.paused) return null;

  const now = options.now ?? new Date();
  if (def.pausedUntil) {
    const until = Date.parse(def.pausedUntil);
    if (Number.isFinite(until) && until > now.getTime()) return null;
  }

  const type = def.triggerType ?? "cron";
  if (type === "once") {
    if (!def.runAt) return null;
    const at = Date.parse(def.runAt);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  if (type !== "cron") return null;

  const schedule = (def.schedule || "").trim();
  if (!schedule) return null;

  const timeZone = def.timezone?.trim() || undefined;
  const policy =
    def.windowPolicy === "skip" || def.windowPolicy === "run"
      ? def.windowPolicy
      : "postpone";
  const windowOptions = {
    notBefore: def.notBefore,
    notAfter: def.notAfter,
    days: Array.isArray(def.activeDays) ? def.activeDays : undefined,
    timeZone,
  };

  let tick: Date | null;
  try {
    tick = cronNextRun(schedule, now, timeZone);
  } catch {
    // Некорректное выражение не должно ломать ответ инструмента.
    return null;
  }

  // skip-политика может пропустить сколько угодно тиков вне окна;
  // ограничение защищает от бесконечного перебора (5-летнее окно cron).
  for (let guard = 0; tick && guard < 600; guard += 1) {
    if (policy === "run") return tick.toISOString();
    const state = activeWindowState(tick, windowOptions);
    if (state.active) return tick.toISOString();
    if (policy === "skip") {
      tick = cronNextRun(schedule, tick, timeZone);
      continue;
    }
    // postpone: gate ждёт открытия окна и запускает задачу тогда же.
    return state.nextOpenAt ? state.nextOpenAt.toISOString() : null;
  }
  return null;
}

/** schedule_task — создаёт задачу в schtasks через общий schedulerCreateTask. */
const scheduleTaskExecute = wrapExecute<ScheduleArgs>(async (args) => {
  // QA-P2.1: RPC-путь не проходит Zod — проверяем диапазоны явно.
  const rangeError = validateTaskInputRanges(args);
  if (rangeError) throw new Error(rangeError);
  const {
    name,
    schedule,
    runAt,
    delaySeconds,
    prompt,
    filesCreate,
    timeoutSeconds,
    model,
    autoSelectModel,
    priority,
    beforeScript,
    afterScript,
    qualityGate,
    dependsOn,
    retryCount,
    retryDelay,
    nextTaskOnSuccess,
    nextTaskOnError,
    triggerType,
    mcpEvent,
    watchPath,
    workingDirectory,
    workspaceId,
    allowedTools,
    deniedTools,
    matrix,
    timezone,
    notBefore,
    notAfter,
    session,
    sessionMaxRuns,
    activeDays,
    windowPolicy,
    watchGlobs,
    watchIgnore,
    gitBranch,
    gitPaths,
    gitIgnore,
    gitPollSeconds,
    runWhenLoggedOff,
    legacyShell,
    worktree,
    guards,
    tokenBudget,
  } = args;

  // B-2: модель рекомендуется на write-пути, но явная модель всегда побеждает.
  const modelChoice = applyModelRecommendation(prompt, model ?? null, autoSelectModel === true);
  const effectiveModel = modelChoice.model ?? undefined;

  let effectiveRunAt: string | undefined;
  if ((triggerType ?? "cron") === "once") {
    const normalized = normalizeOneShotRunAt({ runAt, delaySeconds });
    if (!normalized.ok) {
      return {
        content: JSON.stringify({ success: false, error: normalized.error }),
      };
    }
    effectiveRunAt = normalized.runAt;
  }

  // Спринт 24: режим сессии. По умолчанию "new" (старое поведение).
  // sessionId пользователя никогда не принимаем — он создаётся автоматически.
  const effectiveSession: "new" | "reuse" | "last" =
    normalizeSessionMode(session) ?? "new";
  const effectiveSessionId =
    effectiveSession === "reuse" ? generateSessionId() : undefined;

  try {
    await schedulerCreateTask(
      name,
      schedule ?? "",
      prompt,
      timeoutSeconds,
      workingDirectory,
      retryCount,
      retryDelay,
      qualityGate,
      nextTaskOnSuccess,
      nextTaskOnError,
      triggerType,
      watchPath,
      dependsOn,
      effectiveModel,
      priority,
      beforeScript,
      afterScript,
      mcpEvent,
      workspaceId,
      allowedTools,
      deniedTools,
      matrix,
      undefined,
      "create",
      timezone,
      notBefore,
      notAfter,
      undefined,
      effectiveRunAt,
      effectiveSession,
      effectiveSessionId,
      sessionMaxRuns,
      {
        activeDays,
        windowPolicy,
        watchGlobs,
        watchIgnore,
        gitBranch,
        gitPaths,
        gitIgnore,
        gitPollSeconds,
      },
      // Спринт 27.5.4: Windows — работать без входа (/ru SYSTEM).
      runWhenLoggedOff === true,
      undefined,
      legacyShell === true,
      worktree === true,
      guards,
      tokenBudget,
      undefined, // avoidCatchUp — только при пересоздании cron-задачи
      filesCreate,
      autoSelectModel === true,
      modelChoice.autoSelected,
    );
  } catch (err) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  // Новый файловый триггер должен начать работать сразу, без перезапуска
  // OpenCode: пересобираем набор watcher-ов после создания задачи.
  await refreshTriggers();

  const workspace = workspaceId ? getWorkspace(workspaceId) : undefined;
  const effectiveWorkdir =
    workspace?.path || workingDirectory?.trim() || projectDirectory || process.cwd();
  // Спринт 27.5.2: отдаём ближайший запуск сразу, не дожидаясь обновления
  // списка задач планировщика ОС (schtasks иногда отдаёт nextRunTime с задержкой).
  const nextRun = computeTaskNextRun({
    schedule: schedule ?? "",
    triggerType: triggerType ?? "cron",
    runAt: effectiveRunAt,
    timezone,
    notBefore,
    notAfter,
    activeDays,
    windowPolicy,
  });
  return {
    content: JSON.stringify({
      success: true,
      paused: false,
      nextRun,
      runWhenLoggedOff: runWhenLoggedOff === true,
      message: t("tool.task.created", { name }),
      // B-2.1: предупреждение о неявной модели попадает в результат инструмента.
      warnings: modelChoice.warning ? [modelChoice.warning] : [],
      model: effectiveModel ?? null,
      autoSelected: modelChoice.autoSelected,
      task: {
        name,
        schedule,
        nextRun,
        paused: false,
        runWhenLoggedOff: runWhenLoggedOff === true,
        timeoutSeconds: timeoutSeconds ?? 3600,
        model: effectiveModel ?? null,
        priority: priority ?? 5,
        beforeScript: beforeScript?.trim() || null,
        afterScript: afterScript?.trim() || null,
        qualityGate: qualityGate?.trim() || null,
        dependsOn: dependsOn ?? [],
        retryCount: retryCount ?? 0,
        retryDelay: retryDelay ?? null,
        nextTaskOnSuccess: nextTaskOnSuccess?.trim() || null,
        nextTaskOnError: nextTaskOnError?.trim() || null,
        triggerType: triggerType ?? "cron",
        runAt: effectiveRunAt ?? null,
        session: effectiveSession,
        sessionId: effectiveSessionId ?? null,
        sessionMaxRuns: sessionMaxRuns ?? null,
        timezone: timezone?.trim() || null,
        notBefore: notBefore?.trim() || null,
        notAfter: notAfter?.trim() || null,
        mcpEvent: mcpEvent ?? null,
        workingDirectory: effectiveWorkdir,
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.name ?? null,
        matrix: matrix ?? null,
        worktree: worktree === true,
        guards: guards ?? null,
      },
    }),
  };
});

/** list_tasks — список задач плагина (та же логика, что и у get_tasks). */
const listTasksExecute = wrapExecute<ListArgs>(async () => {
  const { tasks, osAvailable, osError } = await collectTasksView();

  if (tasks.length === 0) {
    const output = {
      success: true,
      message: osAvailable
        ? t("tool.task.listEmpty")
        : t("tool.task.listOsUnavailable"),
      tasks: [],
      osAvailable,
      ...(osError ? { osError } : {}),
    };
    return { output, content: JSON.stringify(output) };
  }

  const output = {
    success: true,
    message: osAvailable
      ? t("tool.task.found", { count: tasks.length })
      : t("tool.task.foundOsUnavailable", { count: tasks.length }),
    tasks,
    osAvailable,
    ...(osError ? { osError } : {}),
  };
  return { output, content: JSON.stringify(output) };
});

/**
 * Отмена выполняющейся матрицы: незавершённые клоны помечаются отменой
 * в истории, а реально запущенные — останавливаются (удаление задачи в
 * планировщике ОС завершает процесс) и пересоздаются как placeholder,
 * чтобы матрицу можно было запустить повторно.
 */
async function cancelMatrixRun(
  name: string,
): Promise<{ cancelled: string[]; running: string[]; message: string; warnings: string[] }> {
  const definition = (await loadTaskDefinitions()).find(
    (def) => def.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!definition?.matrix) {
    throw new Error(t("tool.error.matrixNotMatrix", { name }));
  }

  const result = await cancelPendingMatrixClones(definition.name);
  const warnings: string[] = [];

  for (const cloneName of result.running) {
    const clone = (await loadTaskDefinitions()).find(
      (def) => def.name.toLowerCase() === cloneName.toLowerCase(),
    );
    if (!clone) continue;

    // Удаление запущенной задачи планировщика останавливает её процесс.
    try {
      await scheduler.deleteTask(clone.name);
    } catch (err) {
      warnings.push(
        t("tool.matrix.stopFailed", {
          clone: clone.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }

    // Возвращаем placeholder-задачу, чтобы следующая fan-out-волна работала.
    try {
      await schedulerCreateTask(
        clone.name,
        clone.schedule,
        clone.prompt,
        clone.timeoutSeconds,
        undefined,
        clone.retryCount,
        clone.retryDelay,
        clone.qualityGate,
        undefined,
        undefined,
        "file",
        undefined,
        undefined,
        clone.model,
        clone.priority,
        clone.beforeScript,
        clone.afterScript,
        undefined,
        clone.workspaceId,
        clone.allowedTools,
        clone.deniedTools,
        undefined,
        definition.name,
        "create",
        clone.timezone,
        clone.notBefore,
        clone.notAfter,
        clone.pausedUntil,
        clone.runAt,
        clone.session,
        clone.sessionId,
        clone.sessionMaxRuns,
        undefined,
        clone.runWhenLoggedOff,
        clone.paused,
        clone.legacyShell,
        clone.worktree,
        clone.guards,
        // QA-P0.1 (E-2.1): клон матрицы наследует tokenBudget родителя.
        clone.tokenBudget,
      );
    } catch (err) {
      warnings.push(
        t("tool.matrix.recreateFailed", {
          clone: clone.name,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const parts = [
    t("tool.matrix.cancelSummary", {
      matrix: definition.name,
      cancelled: result.cancelled.length,
      total: result.aggregate.totalCount,
    }),
  ];
  if (result.running.length > 0) {
    parts.push(t("tool.matrix.cancelRunning", { count: result.running.length }));
  }
  if (result.alreadyFinished.length > 0) {
    parts.push(t("tool.matrix.cancelFinished", { count: result.alreadyFinished.length }));
  }
  if (warnings.length > 0) {
    parts.push(t("tool.matrix.cancelWarnings", { warnings: warnings.join("; ") }));
  }

  return {
    cancelled: result.cancelled,
    running: result.running,
    message: parts.join(" "),
    warnings,
  };
}

/** Вычищает клоны и агрегаторы, чьи матрицы уже удалены. */
async function cleanupOrphanedMatrixTasks(): Promise<string[]> {
  const orphans = findOrphanedMatrixTasks();
  const removed: string[] = [];

  for (const orphan of orphans) {
    try {
      await scheduler.deleteTask(orphan);
    } catch {
      // Записи могло уже не быть в планировщике.
    }
    try {
      await removeTaskDefinition(orphan);
    } catch {
      // Не критично.
    }
    removed.push(orphan);
  }

  if (removed.length > 0) {
    console.log(
      `[matrix] Очищены осиротевшие задачи матриц: ${removed.join(", ")}`,
    );
  }
  return removed;
}

/**
 * Удаляет задачу из планировщика ОС и из БД.
 *
 * Lifecycle матриц (Спринт 16):
 *  - удаление родителя-матрицы каскадно удаляет клоны и агрегатор;
 *  - удаление клона поодиночке запрещено (защита от «сирот» и вечного running).
 */
/**
 * Удаляет файлы-артефакты задачи (wrapper, prompt, log, lock, env).
 * Отсутствующие файлы игнорируются — операция идемпотентна.
 */
async function removeTaskArtifacts(name: string): Promise<void> {
  const sanitized = sanitizeName(name);
  const candidates = [
    path.join(WRAPPER_DIR, `run-${sanitized}.cmd`),
    path.join(WRAPPER_DIR, `run-${sanitized}.sh`),
    path.join(PLUGIN_DIR, "prompts", `${sanitized}.txt`),
    path.join(LOG_DIR, `${sanitized}.log`),
    path.join(PLUGIN_DIR, "env", `${sanitized}.env`),
    path.join(LOCK_DIR, `${sanitized}.lock`),
    path.join(LOCK_DIR, `${sanitized}.lock.defer`),
    path.join(LOCK_DIR, `${sanitized}.lock.force`),
  ];
  await Promise.all(candidates.map((file) => fs.unlink(file).catch(() => undefined)));
}

/**
 * Сборщик мусора по wrapper-ам при старте: удаляет файлы задач, которых
 * больше нет ни в БД, ни в планировщике ОС. Активные (свежий lock) не трогает.
 */
async function garbageCollectTaskArtifacts(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(WRAPPER_DIR);
  } catch {
    return;
  }
  const wrappers = entries.filter((file) => /^run-.+\.(cmd|sh)$/.test(file));
  if (wrappers.length === 0) return;

  const known = new Set<string>();
  try {
    for (const task of listTaskDefinitions()) known.add(sanitizeName(task.name));
  } catch {
    // БД может быть ещё не готова — тогда опираемся на ОС.
  }
  try {
    for (const task of await scheduler.listTasks()) {
      known.add(sanitizeName(task.taskName || ""));
    }
  } catch {
    // Планировщик недоступен — не удаляем ничего, чтобы не потерять данные.
    return;
  }

  let cleaned = 0;
  for (const file of wrappers) {
    const stem = file.replace(/^run-/, "").replace(/\.(cmd|sh)$/, "");
    const lockPath = path.join(LOCK_DIR, `${stem}.lock`);
    if (known.has(stem)) continue;
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs < STALE_LOCK_MAX_AGE_MS) continue;
    } catch {
      // lock-файла нет — можно удалять.
    }
    const candidates = [
      path.join(WRAPPER_DIR, `run-${stem}.cmd`),
      path.join(WRAPPER_DIR, `run-${stem}.sh`),
      path.join(PLUGIN_DIR, "prompts", `${stem}.txt`),
      path.join(LOG_DIR, `${stem}.log`),
      path.join(PLUGIN_DIR, "env", `${stem}.env`),
      path.join(LOCK_DIR, `${stem}.lock`),
      path.join(LOCK_DIR, `${stem}.lock.defer`),
      path.join(LOCK_DIR, `${stem}.lock.force`),
    ];
    await Promise.all(candidates.map((pathToFile) => fs.unlink(pathToFile).catch(() => undefined)));
    cleaned += 1;
  }
  if (cleaned > 0) {
    console.log(`[gc] Вычищено мусорных файлов задач: ${cleaned}`);
  }
}

async function deleteTaskWithFamily(
  name: string,
): Promise<{ removed: string[]; existed: boolean }> {
  const trimmed = name.trim();
  const guard = getMatrixDeletionGuard(trimmed);
  if (guard) throw new Error(guard);

  const plan = planMatrixFamilyDelete(trimmed);
  const removed: string[] = [];

  // Отличаем реальное удаление от «удаления пустоты»: раньше инструмент
  // отвечал success даже на имя, которого никогда не существовало.
  let existed = Boolean(getTask(trimmed));
  if (!existed) {
    try {
      const osTasks = await scheduler.listTasks();
      existed = osTasks.some(
        (task) => task.taskName.toLowerCase() === trimmed.toLowerCase(),
      );
    } catch {
      // ОС-планировщик недоступен — довольствуемся данными БД.
    }
  }
  if (plan && plan.children.length > 0) existed = true;

  if (plan) {
    for (const child of plan.children) {
      try {
        await scheduler.deleteTask(child);
      } catch {
        // Клона могло уже не быть в планировщике.
      }
      try {
        await removeTaskDefinition(child);
      } catch {
        // Не критично.
      }
      // QA-A2.7: умышленно fire-and-forget, ошибки подавлены внутри функции.
      void removeTaskArtifacts(child);

      removed.push(child);
    }
  }

  await scheduler.deleteTask(trimmed);
  try {
    await removeTaskDefinition(trimmed);
  } catch {
    // Определения могло уже не быть — задача всё равно удалена из ОС.
  }
  // QA-A2.7: умышленно fire-and-forget, ошибки подавлены внутри функции.
  void removeTaskArtifacts(trimmed);

  return { removed, existed };
}

/** delete_task — удаление задачи по имени (/f) */
const deleteTaskExecute = wrapExecute<DeleteArgs>(async (args) => {
  const { name } = args;

  try {
    const { removed, existed } = await deleteTaskWithFamily(name);
    // Убираем watcher удалённой задачи, не дожидаясь перезапуска плагина.
    await refreshTriggers();
    if (!existed && removed.length === 0) {
      return {
        content: JSON.stringify({
          success: true,
          message: t("tool.task.alreadyAbsent", { name }),
        }),
      };
    }
    return {
      content: JSON.stringify({
        success: true,
        message:
          removed.length > 0
            ? t("tool.task.matrixDeletedList", { name, list: removed.join(", ") })
            : t("tool.task.deleted", { name }),
      }),
    };
  } catch (err) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
});

/** run_task_now — немедленный запуск задачи */
const runTaskNowExecute = wrapExecute<RunNowArgs>(async (args) => {
  const { name } = args;

  // PL-8.1: тот же дрейф HEAD, что и в dry_run, показываем при ручном старте.
  const definition = getTask(name);
  const warning =
    definition?.workingDirectory && definition.createdAt
      ? workingDirectoryDriftWarning(definition, definition.workingDirectory)
      : null;

  let alreadyRunning = false;
  try {
    const result = await runTaskEntry(name);
    alreadyRunning = result.alreadyRunning;
  } catch (err) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }

  return {
    content: JSON.stringify({
      success: true,
      message: alreadyRunning
        ? t("tool.task.alreadyRunning", { name })
        : t("tool.task.started", { name }),
      ...(warning ? { warning } : {}),
    }),
  };
});

/**
 * Хелперы частичного обновления задачи: undefined — «не трогать»,
 * пустая строка/массив — «очистить».
 */
function clearableString(
  next: string | undefined,
  current: string | undefined,
): string | undefined {
  if (next === undefined) return current;
  const trimmed = next.trim();
  return trimmed ? trimmed : undefined;
}

function clearableList(
  next: string[] | undefined,
  current: string[] | undefined,
): string[] | undefined {
  if (next === undefined) return current;
  const cleaned = next.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Удаляет клонов и агрегатор матрицы из планировщика ОС и из БД. */
async function removeMatrixChildrenFromScheduler(name: string): Promise<string[]> {
  const removed: string[] = [];
  for (const child of removeMatrixChildren(name)) {
    try {
      await scheduler.deleteTask(child);
    } catch {
      // ОС-задачи могло уже не быть.
    }
    try {
      await removeTaskDefinition(child);
    } catch {
      // Не критично.
    }
    removed.push(child);
  }
  return removed;
}

/**
 * Обновляет задачу, сохраняя все поля, которые не были переданы.
 * Используется инструментом update_task и RPC-методом update_task.
 */
async function updateTaskFromInput(
  input: UpdateArgs & { newSchedule?: string; newPrompt?: string },
): Promise<{
  success: boolean;
  message: string;
  /** Спринт 27.5.2: состояние и ближайший запуск после обновления. */
  paused?: boolean;
  nextRun?: string | null;
  /**
   * Спринт 27.5.6: при ошибке обновления — удалось ли сохранить прежнюю
   * версию задачи в планировщике (true — старая версия на месте).
   */
  restored?: boolean;
  /** B-2.1: предупреждения о неявной модели. */
  warnings?: string[];
  /** Эффективная модель задачи (null — OpenCode default). */
  model?: string | null;
  /** B-2.2: true — модель выбрана эвристикой по autoSelectModel. */
  autoSelected?: boolean;
}> {
  const name = input.name?.trim();
  if (!name) {
    return { success: false, message: t("tool.error.taskNameMissing") };
  }

  // QA-P2.1: RPC не проходит Zod — проверяем диапазоны явно.
  const rangeError = validateTaskInputRanges(input);
  if (rangeError) {
    return { success: false, message: rangeError };
  }

  const previous = getTask(name);
  if (!previous) {
    return { success: false, message: t("tool.error.taskNotFound", { name }) };
  }

  const schedule = clearableString(input.schedule ?? input.newSchedule, previous.schedule);
  const prompt = clearableString(input.prompt ?? input.newPrompt, previous.prompt);
  const triggerType = input.triggerType ?? previous.triggerType ?? "cron";
  const timezone = clearableString(input.timezone, previous.timezone);
  const notBefore = clearableString(input.notBefore, previous.notBefore);
  const notAfter = clearableString(input.notAfter, previous.notAfter);

  if (triggerType === "cron" && !schedule) {
    return {
      success: false,
      message: t("tool.error.updateCron", { name }),
    };
  }
  if (!prompt) {
    return {
      success: false,
      message: t("tool.error.updatePrompt", { name }),
    };
  }

  // One-shot: без нового runAt/delaySeconds сохраняем прежнее время.
  // При смене триггера на once время обязательно, иначе задача не запустится.
  let runAt: string | undefined;
  if (triggerType === "once") {
    const candidateRunAt =
      input.runAt !== undefined
        ? input.runAt
        : input.delaySeconds !== undefined
          ? undefined
          : previous.runAt;
    const normalized = normalizeOneShotRunAt({
      runAt: candidateRunAt,
      delaySeconds: input.delaySeconds,
    });
    if (!normalized.ok) {
      return {
        success: false,
        message: t("tool.error.taskReason", { name, error: normalized.error }),
      };
    }
    runAt = normalized.runAt;
  }

  // Спринт 24: режим сессии. Без новых session/sessionMaxRuns сохраняем прежние.
  // sessionId пользователя не принимаем — генерируем сами при переходе на reuse.
  let session: "new" | "reuse" | "last" = "new";
  if (input.session !== undefined) {
    const normalizedSession = normalizeSessionMode(input.session);
    if (!normalizedSession) {
      return {
        success: false,
        message: t("tool.error.sessionUnknown", { name, session: String(input.session) }),
      };
    }
    session = normalizedSession;
  } else if (previous.session) {
    session = previous.session;
  }
  const sessionMaxRuns =
    input.sessionMaxRuns !== undefined ? input.sessionMaxRuns : previous.sessionMaxRuns;
  if (
    sessionMaxRuns !== undefined &&
    (!Number.isInteger(sessionMaxRuns) || sessionMaxRuns < 0)
  ) {
    return {
      success: false,
      message: t("tool.error.sessionMaxRuns", { name }),
    };
  }
  let sessionId = previous.sessionId;
  if (session === "reuse" && !sessionId) {
    sessionId = generateSessionId();
  }
  if (session !== "reuse") {
    sessionId = undefined;
  }

  const matrixWas = previous.matrix;
  const matrixNext =
    input.matrix === undefined ? matrixWas : input.matrix ?? undefined;
  if (triggerType === "once" && matrixNext) {
    return {
      success: false,
      message: t("tool.error.oneShotMatrix", { name }),
    };
  }

  // Спринт 27: параметры триггеров сохраняются, если поле не передано.
  const mergeStringList = (
    next: string[] | undefined,
    prev: string[] | undefined,
  ): string[] | undefined => {
    if (next === undefined) return prev;
    const cleaned = next
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const triggerExtras: TriggerExtras = {
    activeDays:
      input.activeDays === undefined
        ? previous.activeDays
        : input.activeDays.length > 0
          ? input.activeDays
          : undefined,
    windowPolicy: input.windowPolicy ?? previous.windowPolicy,
    watchGlobs: mergeStringList(input.watchGlobs, previous.watchGlobs),
    watchIgnore: mergeStringList(input.watchIgnore, previous.watchIgnore),
    gitBranch: clearableString(input.gitBranch, previous.gitBranch),
    gitPaths: mergeStringList(input.gitPaths, previous.gitPaths),
    gitIgnore: mergeStringList(input.gitIgnore, previous.gitIgnore),
    gitPollSeconds: input.gitPollSeconds ?? previous.gitPollSeconds,
  };

  // Спринт 27.5.8: update = пересоздание задачи, поэтому паузу нужно вернуть
  // после create — иначе задача молча начинает выполняться по расписанию.
  const wasPaused = Boolean(
    previous.paused === true ||
      (previous.pausedUntil && Date.parse(previous.pausedUntil) > Date.now()),
  );

  // B-2: флаг наследуется от задачи, если явно не передан в обновлении.
  const autoSelectModel = input.autoSelectModel ?? (previous.autoSelectModel === true);
  let nextModel = clearableString(input.model, previous.model);
  // Ранее автоподобранную модель пересчитываем под новый промпт, но только
  // если пользователь не задал model явно в этом обновлении (B-2.2).
  if (
    autoSelectModel === true &&
    input.model === undefined &&
    previous.autoSelectedModel === true
  ) {
    nextModel = undefined;
  }
  const modelChoice = applyModelRecommendation(prompt, nextModel ?? null, autoSelectModel === true);
  const effectiveModel = modelChoice.model ?? undefined;
  if (effectiveModel) {
    const modelError = validateModelReference(effectiveModel);
    if (modelError) {
      return {
        success: false,
        message: t("tool.error.modelInvalid", {
          model: effectiveModel,
          error: modelError,
        }),
      };
    }
  }

  let previousDeleted = false;
  try {
    // Обновление = пересоздание в планировщике с сохранением старых значений.
    await scheduler.deleteTask(name);
    previousDeleted = true;
    await schedulerCreateTask(
      name,
      schedule ?? "",
      prompt,
      input.timeoutSeconds ?? previous.timeoutSeconds,
      clearableString(input.workingDirectory, previous.workingDirectory),
      input.retryCount ?? previous.retryCount,
      input.retryDelay ?? previous.retryDelay,
      clearableString(input.qualityGate, previous.qualityGate),
      clearableString(input.nextTaskOnSuccess, previous.nextTaskOnSuccess),
      clearableString(input.nextTaskOnError, previous.nextTaskOnError),
      triggerType,
      clearableString(input.watchPath, previous.watchPath),
      clearableList(input.dependsOn, previous.dependsOn),
      effectiveModel,
      input.priority ?? previous.priority,
      clearableString(input.beforeScript, previous.beforeScript),
      clearableString(input.afterScript, previous.afterScript),
      input.mcpEvent ?? previous.mcpEvent,
      clearableString(input.workspaceId, previous.workspaceId),
      clearableList(input.allowedTools, previous.allowedTools),
      clearableList(input.deniedTools, previous.deniedTools),
      matrixNext,
      undefined,
      // Если задача была матрицей — синхронизируем клонов, а не
      // пересоздаём их с нуля (Спринт 17).
      matrixWas && matrixNext ? "sync" : "create",
      timezone,
      notBefore,
      notAfter,
      previous.pausedUntil,
      runAt,
      session,
      sessionId,
      sessionMaxRuns,
      triggerExtras,
      input.runWhenLoggedOff ?? previous.runWhenLoggedOff,
      wasPaused,
      input.legacyShell ?? previous.legacyShell,
      input.worktree ?? previous.worktree,
      input.guards ?? previous.guards,
      // QA-P0.1 (E-2.1): budget переживает пересоздание задачи. 0 очищает лимит.
      input.tokenBudget ?? previous.tokenBudget,
      // PL-75: cron-задача при update пересоздаётся с будущей /sd, чтобы
      // прошедшая start boundary не вызывала catch-up.
      triggerType === "cron",
      undefined, // filesCreate — в update не меняется
      autoSelectModel === true,
      modelChoice.autoSelected,
    );

    // Матрица отключена при обновлении — убираем клонов и агрегатор.
    if (matrixWas && !matrixNext) {
      await removeMatrixChildrenFromScheduler(name);
    }

    // Пересоздание могло изменить triggerType/watchPath — сразу
    // пересобираем набор файловых watcher-ов.
    await refreshTriggers();

    // Спринт 27.5: при смене регистра имени (MyTask -> mytask) обновляем
    // ссылки в других задачах, иначе DAG и цепочки продолжат указывать на
    // старое написание.
    if (previous.name !== name) {
      const previousLower = previous.name.toLowerCase();
      for (const task of listTaskDefinitions()) {
        if (task.name.toLowerCase() === name.toLowerCase()) continue;
        let changed = false;
        const renameRef = (value: string): string => {
          if (value.toLowerCase() === previousLower) {
            changed = true;
            return name;
          }
          return value;
        };
        const dependsOn = task.dependsOn?.map(renameRef);
        const nextTaskOnSuccess = task.nextTaskOnSuccess
          ? renameRef(task.nextTaskOnSuccess)
          : task.nextTaskOnSuccess;
        const nextTaskOnError = task.nextTaskOnError
          ? renameRef(task.nextTaskOnError)
          : task.nextTaskOnError;
        if (!changed) continue;
        saveTask({
          ...task,
          ...(dependsOn ? { dependsOn } : {}),
          nextTaskOnSuccess,
          nextTaskOnError,
        });
      }
    }

    // Спринт 27.5.2: после пересоздания задачи сообщаем ближайший запуск,
    // рассчитанный из нового определения, не дожидаясь ОС.
    const updated = getTask(name);
    const paused = wasPaused;
    return {
      success: true,
      paused,
      nextRun: computeTaskNextRun(updated, { paused }),
      message: t("tool.task.updated", { name }),
      // B-2.1: предупреждение о неявной модели приходит и при обновлении.
      warnings: modelChoice.warning ? [modelChoice.warning] : [],
      model: effectiveModel ?? null,
      autoSelected: modelChoice.autoSelected,
    };
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);

    // Спринт 27.5.6: задача удалена из ОС, но новую версию создать не удалось.
    if (!previousDeleted) {
      return {
        success: false,
        restored: true,
        message: t("tool.task.rollbackKept", { cause }),
      };
    }

    // Убираем возможный частичный результат новой попытки: обёртка могла
    // успеть зарегистрироваться, хотя create вернул ошибку.
    try {
      await scheduler.deleteTask(name);
    } catch {
      // Задачи могло не быть — это ожидаемо.
    }

    // Определение в БД ещё не перезаписано, поэтому восстанавливаем ровно
    // прежнюю версию: расписание, промпт, обёртку и паузу.
    try {
      await recreateTaskFromDefinition(previous);
      await refreshTriggers().catch(() => undefined);
      return {
        success: false,
        restored: true,
        message: t("tool.task.rollbackRestored", { cause }),
      };
    } catch (restoreErr) {
      const restoreMessage =
        restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      return {
        success: false,
        restored: false,
        message: t("tool.task.rollbackFailed", {
          cause,
          restore: restoreMessage,
          name,
        }),
      };
    }
  }
}

/** update_task — частичное обновление существующей задачи. */
const updateTaskExecute = wrapExecute<UpdateArgs>(async (args) => {
  const result = await updateTaskFromInput(args);
  return { content: JSON.stringify(result) };
});

/**
 * Пауза/возобновление задачи. Для матрицы операция применяется ко всем
 * клонам: сам родитель никогда не выполняется.
 */
async function pauseOrResumeTask(
  name: string,
  paused: boolean,
  until?: string,
): Promise<{
  success: boolean;
  message: string;
  affected: string[];
  warnings: string[];
  /** Спринт 27.5.2: состояние и ближайший запуск после мутации. */
  paused: boolean;
  nextRun: string | null;
  pausedUntil: string | null;
}> {
  const trimmed = name.trim();
  const definition = getTask(trimmed);
  if (!definition) {
    return {
      success: false,
      message: t("tool.error.taskNotFound", { name: trimmed }),
      affected: [],
      warnings: [],
      // QA-P3.8: в ошибке `paused` должен отражать реальное состояние,
      // а не запрошенное действие (иначе resume про несуществующей задаче
      // сообщает paused:false, а pause — paused:true).
      paused: false,
      nextRun: null,
      pausedUntil: null,
    };
  }

  // Пауза до даты (Спринт 19): проверяем ISO-момент до каких-либо изменений.
  let pausedUntil: string | undefined;
  if (paused && until?.trim()) {
    const parsed = Date.parse(until.trim());
    if (Number.isNaN(parsed)) {
      return {
        success: false,
        message: t("tool.error.pauseDateInvalid", { name: trimmed, until }),
        affected: [],
        warnings: [],
        paused: definition.paused ?? false,
        nextRun: null,
        pausedUntil: definition.pausedUntil ?? null,
      };
    }
    if (parsed <= Date.now()) {
      return {
        success: false,
        message: t("tool.error.pauseDatePast", { name: trimmed }),
        affected: [],
        warnings: [],
        paused: definition.paused ?? false,
        nextRun: null,
        pausedUntil: definition.pausedUntil ?? null,
      };
    }
    pausedUntil = new Date(parsed).toISOString();
  }

  const targets = definition.matrix
    ? listMatrixClones(trimmed).map((clone) => clone.name)
    : [trimmed];
  if (targets.length === 0 && definition.matrix) {
    return {
      success: false,
      message: t("tool.error.matrixNoClones", { name: trimmed }),
      affected: [],
      warnings: [],
      paused: definition.paused ?? false,
      nextRun: null,
      pausedUntil: definition.pausedUntil ?? null,
    };
  }

  const affected: string[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    try {
      if (paused) {
        await scheduler.pauseTask(target);
      } else {
        await scheduler.resumeTask(target);
      }
      affected.push(target);
    } catch (err) {
      warnings.push(
        `${target}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Фиксируем (или снимаем) паузу в определении задачи. У матрицы
  // родитель хранит pausedUntil за всех клонов — их включает авто-resume.
  // Спринт 27.5.8: бессрочная пауза тоже сохраняется в определении, иначе
  // update_task пересоздаёт задачу включённой и пауза теряется.
  const definitionUpdates: Partial<TaskDefinition> | undefined = paused
    ? { paused: true, ...(pausedUntil ? { pausedUntil } : {}) }
    : definition.paused || definition.pausedUntil
      ? { paused: false, pausedUntil: undefined }
      : undefined;
  if (definitionUpdates && affected.length > 0) {
    try {
      saveTask({ ...definition, ...definitionUpdates });
    } catch (err) {
      warnings.push(
        t("tool.task.autosave", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  const untilText = pausedUntil
    ? t("tool.task.until", { date: new Date(pausedUntil).toLocaleString() })
    : "";
  const verb = paused ? t("tool.task.paused") : t("tool.task.resumed");
  const message = definition.matrix
    ? t("tool.task.matrixPaused", {
      name: trimmed,
      verb,
      until: untilText,
      affected: affected.length,
      total: targets.length,
    }) +
      (warnings.length > 0
        ? t("tool.task.matrixPauseErrors", { warnings: warnings.join("; ") })
        : "")
    : t("tool.task.pausedText", {
      name: trimmed,
      verb,
      until: untilText,
    }) +
      (warnings.length > 0
        ? t("tool.task.pauseError", { warnings: warnings.join("; ") })
        : "");

  // Спринт 27.5.2: состояние и ближайший запуск считаем из определения —
  // schtasks после /change (особенно /enable) отдаёт nextRunTime с задержкой.
  const effectivePausedUntil = paused
    ? pausedUntil ?? definition.pausedUntil ?? null
    : null;
  const after = definitionUpdates
    ? { ...definition, ...definitionUpdates }
    : { ...definition, paused: false, pausedUntil: undefined };
  const nextRun = paused ? null : computeTaskNextRun(after);

  return {
    success: warnings.length === 0,
    message,
    affected,
    warnings,
    paused,
    nextRun,
    pausedUntil: effectivePausedUntil,
  };
}

const pauseTaskExecute = wrapExecute<PauseArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, true, args.until);
  return { content: JSON.stringify(result) };
});

const resumeTaskExecute = wrapExecute<ResumeArgs>(async (args) => {
  const result = await pauseOrResumeTask(args.name, false);
  return { content: JSON.stringify(result) };
});

const POSIX_MAX_PROMPT_BYTES = 131072; // 128 KiB: MAX_ARG_STRLEN на одном аргументе в Linux; запас под обёртку.

/**
 * Спринт 19: автопродолжение задач, поставленных на паузу до даты.
 * Включает задачу в планировщике ОС и снимает `pausedUntil` из определения.
 * Клоны матрицы не обрабатываются отдельно — за них отвечает родитель.
 */
async function resumeExpiredPauses(): Promise<void> {
  const now = Date.now();
  const definitions = await loadTaskDefinitions();
  for (const definition of definitions) {
    if (!definition.pausedUntil) continue;
    if (definition.matrixParentId) continue;
    const untilMs = Date.parse(definition.pausedUntil);
    if (!Number.isFinite(untilMs) || untilMs > now) continue;

    try {
      const targets = definition.matrix
        ? listMatrixClones(definition.name).map((clone) => clone.name)
        : [definition.name];
      for (const target of targets) {
        await scheduler.resumeTask(target);
      }
      await saveTaskDefinition({
        ...definition,
        pausedUntil: undefined,
        paused: false,
      });
      console.log(
        `[agent-steward] Автопродолжение: задача "${definition.name}" включена (пауза истекла).`,
      );
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось автопродолжить задачу "${definition.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Уже отправленные уведомления о зависших клонах (id записи истории). */
const notifiedStuckRecords = new Set<number>();

/**
 * Детектор зависших матриц (Спринт 20): клоны, которые выполняются дольше
 * `notifications.matrix.stuckAfterMinutes`. Каждый запуск уведомляется один раз.
 */
async function checkStuckMatrices(): Promise<void> {
  const settings = await loadSettings();
  const config = settings.notifications;
  if (!config?.enabled) return;
  const matrix = config.matrix;
  if (!matrix?.enabled) return;
  const threshold = matrix.stuckAfterMinutes;
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  const running = listRunningRecords();
  if (running.length === 0) {
    notifiedStuckRecords.clear();
    return;
  }
  // Снимаем отметки с завершившихся записей, чтобы Set не рос бесконечно.
  const runningIds = new Set(running.map((record) => record.id));
  for (const id of notifiedStuckRecords) {
    if (!runningIds.has(id)) notifiedStuckRecords.delete(id);
  }

  const parentByClone = new Map<string, string>();
  for (const definition of await loadTaskDefinitions()) {
    if (definition.matrixParentId) {
      parentByClone.set(definition.name.toLowerCase(), definition.matrixParentId);
    }
  }

  const stuck = findStuckMatrixClones(running, parentByClone, new Date(), threshold);
  for (const item of stuck) {
    if (notifiedStuckRecords.has(item.id)) continue;
    notifiedStuckRecords.add(item.id);
    await notifyStuckMatrix(item);
  }
}

/** get_history — история запусков с фильтрами по задаче и статусу. */
/**
 * Деталь 3.11: компактный режим истории — длинные `error`-тексты урезаются,
 * чтобы не раздувать контекст главного агента. Полные данные остаются
 * доступны без флага `compact` и через `get_task_logs`. Ничего не удаляется
 * из БД — только представление в ответе инструмента.
 */
export function compactHistoryRecords<T extends { error?: unknown }>(
  records: readonly T[],
  maxErrorChars = 300,
): T[] {
  return records.map((record) => {
    const error = record?.error;
    if (typeof error !== "string" || error.length <= maxErrorChars) return record;
    return { ...record, error: `${error.slice(0, maxErrorChars)}…[truncated]` };
  });
}

const getHistoryExecute = wrapExecute<HistoryArgs>(async (args) => {
  const limit = Math.max(1, Math.min(args.limit ?? 20, 200));
  // PL-46: зависшие записи (schtasks /End) должны закрываться не только при
  // setup, но и при наблюдении истории — иначе остаются running навсегда.
  recoverInterruptedRuns();
  const records = await loadHistory(args.taskName, limit, args.status);
  const output = args.compact ? compactHistoryRecords(records) : records;

  return {
    content: JSON.stringify({
      success: true,
      count: output.length,
      records: output,
    }),
  };
});

/** get_task_logs — последние строки лога задачи. */
const getTaskLogsExecute = wrapExecute<TaskLogsArgs>(async (args) => {
  // PL-19: MCP-клиенты передают и name, и taskName — принимаем оба написания.
  const taskName = args.name?.trim() || args.taskName?.trim();
  if (!taskName) {
    return {
      content: JSON.stringify({ success: false, logs: "", error: "Укажите name или taskName задачи" }),
    };
  }
  const result = await getTaskLogs(taskName, args.lines ?? 200);
  if (result.error) {
    return {
      content: JSON.stringify({ success: false, logs: "", error: result.error }),
    };
  }
  return {
    content: JSON.stringify({ success: true, logs: result.logs }),
  };
});

/** dry_run — симуляция пайплайна без выполнения. */
/**
 * PL-76: список доступных моделей для проверки в `dry_run`.
 * `OPENCODE_SCHEDULER_AVAILABLE_MODELS` — явный список через запятую (тесты/CI,
 * чтобы не дёргать CLI); иначе `opencode models` с кэшем в opencode-models.ts.
 */
async function availableModelsForDryRun(definitions: Awaited<ReturnType<typeof loadTaskDefinitions>>): Promise<string[]> {
  if (!definitions.some((definition) => definition.model?.trim())) return [];
  const override = (process.env.OPENCODE_SCHEDULER_AVAILABLE_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (override.length > 0) return override;
  try {
    return await listAvailableModels();
  } catch {
    return [];
  }
}

/** PL-74/PL-76/PL-88: проверить формат и доступность модели каждой задачи отчёта. */
function annotateDryRunModelWarnings(
  report: DryRunReport & { error?: string },
  definitions: Awaited<ReturnType<typeof loadTaskDefinitions>>,
  available: readonly string[],
): void {
  const byName = new Map(
    definitions.map((definition) => [definition.name.toLowerCase(), definition]),
  );
  for (const item of report.tasks) {
    const definition = byName.get(item.name.toLowerCase());
    const model = definition?.model?.trim();
    if (!model) continue;
    const warning = modelAvailabilityWarning(model, available, item.qualityGate ?? definition?.qualityGate);
    if (!warning || report.warnings.some((existing) => existing.includes(warning))) continue;
    report.warnings.push(`[${item.name}] ${warning}`);
  }
}

const dryRunExecute = wrapExecute<DryRunArgs>(async (args) => {
  const name = args.name?.trim();
  const definitions = await loadTaskDefinitions();
  const available = await availableModelsForDryRun(definitions);

  if (name) {
    const report = await simulatePipeline(name);
    annotateDryRunModelWarnings(report, definitions, available);
    return { content: JSON.stringify(report) };
  }

  const reports: (DryRunReport & { error?: string })[] = [];
  for (const definition of definitions) {
    try {
      const report = await simulatePipeline(definition.name);
      annotateDryRunModelWarnings(report, definitions, available);
      reports.push(report);
    } catch (err) {
      reports.push({
        success: false,
        taskName: definition.name,
        tasks: [],
        totals: {
          estimatedDurationSec: null,
          estimatedCostUsd: null,
          estimatedTokens: null,
        },
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    content: JSON.stringify({
      success: reports.every((report) => report.success !== false),
      count: reports.length,
      reports,
    }),
  };
});

/** pipeline_validate — проверить opencode.pipeline.yaml (путь или исходник). */
const pipelineValidateExecute = wrapExecute<PipelineValidateArgs>(async (args) => {
  if (args.path === undefined && args.source === undefined) {
    return {
      content: JSON.stringify({
        success: false,
        pipeline: null,
        errors: ["Укажите path к файлу или source с содержимым YAML"],
        warnings: [],
      }),
    };
  }
  const parsed =
    args.source !== undefined
      ? validatePipelineSpecFromSource(args.source)
      : await loadPipelineFile(args.path!, args.workingDirectory);
  if (!parsed.ok) {
    return {
      content: JSON.stringify({
        success: false,
        pipeline: null,
        errors: parsed.errors,
        warnings: parsed.warnings,
      }),
    };
  }
  const spec = parsed.spec!;
  return {
    content: JSON.stringify({
      success: true,
      pipeline: spec.name,
      steps: spec.steps.length,
      errors: [],
      warnings: parsed.warnings,
    }),
  };
});

function validatePipelineSpecFromSource(source: string): PipelineParseResult {
  const parsed = parsePipelineYaml(source);
  return parsed;
}

/** pipeline_apply — применить opencode.pipeline.yaml к текущему набору задач. */
const pipelineApplyExecute = wrapExecute<PipelineApplyArgs>(async (args) => {
  const dryRun = args.dryRun !== false;
  if (args.path === undefined && args.source === undefined) {
    return {
      content: JSON.stringify({
        success: false,
        pipeline: null,
        errors: ["Укажите path к файлу или source с содержимым YAML"],
        warnings: [],
      }),
    };
  }
  const parsed =
    args.source !== undefined
      ? validatePipelineSpecFromSource(args.source)
      : await loadPipelineFile(args.path!, args.workingDirectory);
  if (!parsed.ok) {
    return {
      content: JSON.stringify({
        success: false,
        pipeline: null,
        errors: parsed.errors,
        warnings: parsed.warnings,
      }),
    };
  }

  const spec = parsed.spec!;
  const existing = listTaskDefinitions();
  const plan = planPipelineApply(spec, existing, {
    resolveWorkspaceId: (nameOrId: string) => {
      const ws = getWorkspace(nameOrId);
      return ws ? ws.id : undefined;
    },
  });

  let created = 0;
  let updated = 0;
  const errors: string[] = [];

  if (!dryRun) {
    for (const task of plan.creates) {
      try {
        await schedulerCreateTask(
          task.name,
          task.schedule,
          task.prompt,
          task.timeoutSeconds,
          task.workingDirectory ?? task.workdir ?? undefined,
          task.retryCount,
          task.retryDelay,
          task.qualityGate,
          task.nextTaskOnSuccess,
          task.nextTaskOnError,
          task.triggerType ?? "cron",
          task.watchPath,
          task.dependsOn,
          task.model,
          task.priority,
          task.beforeScript,
          task.afterScript,
          task.mcpEvent,
          task.workspaceId,
          task.allowedTools,
          task.deniedTools,
          task.matrix,
          task.matrixParentId,
          "create",
          task.timezone,
          task.notBefore,
          task.notAfter,
          task.pausedUntil,
          task.runAt,
          task.session,
          task.sessionId,
          task.sessionMaxRuns,
          {
            activeDays: task.activeDays,
            windowPolicy: task.windowPolicy,
            watchGlobs: task.watchGlobs ?? [],
            watchIgnore: task.watchIgnore ?? [],
            gitBranch: task.gitBranch,
            gitPaths: task.gitPaths,
            gitIgnore: task.gitIgnore,
            gitPollSeconds: task.gitPollSeconds,
          },
          task.runWhenLoggedOff ?? false,
          task.paused ?? false,
          task.legacyShell ?? false,
          task.worktree ?? false,
          task.guards,
        );
        await saveTaskDefinition(task);
        created++;
      } catch (err) {
        errors.push(`create ${task.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const item of plan.updates) {
      try {
        await schedulerCreateTask(
          item.task.name,
          item.task.schedule,
          item.task.prompt,
          item.task.timeoutSeconds,
          item.task.workingDirectory ?? item.task.workdir ?? undefined,
          item.task.retryCount,
          item.task.retryDelay,
          item.task.qualityGate,
          item.task.nextTaskOnSuccess,
          item.task.nextTaskOnError,
          item.task.triggerType ?? "cron",
          item.task.watchPath,
          item.task.dependsOn,
          item.task.model,
          item.task.priority,
          item.task.beforeScript,
          item.task.afterScript,
          item.task.mcpEvent,
          item.task.workspaceId,
          item.task.allowedTools,
          item.task.deniedTools,
          item.task.matrix,
          item.task.matrixParentId,
          "sync",
          item.task.timezone,
          item.task.notBefore,
          item.task.notAfter,
          item.task.pausedUntil,
          item.task.runAt,
          item.task.session,
          item.task.sessionId,
          item.task.sessionMaxRuns,
          {
            activeDays: item.task.activeDays,
            windowPolicy: item.task.windowPolicy,
            watchGlobs: item.task.watchGlobs ?? [],
            watchIgnore: item.task.watchIgnore ?? [],
            gitBranch: item.task.gitBranch,
            gitPaths: item.task.gitPaths,
            gitIgnore: item.task.gitIgnore,
            gitPollSeconds: item.task.gitPollSeconds,
          },
          item.task.runWhenLoggedOff ?? false,
          item.task.paused ?? false,
          item.task.legacyShell ?? false,
          item.task.worktree ?? false,
          item.task.guards,
        );
        await saveTaskDefinition(item.task);
        updated++;
      } catch (err) {
        errors.push(`update ${item.task.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // QA-A2.7: умышленно fire-and-forget, ошибки подавляются внутри refreshTriggers.
    void refreshTriggers();
  }

  return {
    content: JSON.stringify({
      success: errors.length === 0,
      pipeline: spec.name,
      dryRun,
      created,
      updated,
      unchanged: plan.unchanged.length,
      stale: plan.stale.length,
      warnings: [...plan.warnings, ...errors],
      errors,
    }),
  };
});

/** pipeline_export — выгрузить задачи конвейера как opencode.pipeline.yaml. */
const pipelineExportExecute = wrapExecute<PipelineExportArgs>(async (args) => {
  const allTasks = listTaskDefinitions();
  // QA-P3.2: два имени — это ошибка, а не молчаливый выбор первого.
  const explicit = args.pipeline?.trim();
  const alias = args.pipelineName?.trim();
  if (explicit && alias && explicit.toLowerCase() !== alias.toLowerCase()) {
    return {
      content: JSON.stringify({
        success: false,
        error: "Конфликт параметров: pipeline и pipelineName задают разные имена конвейера.",
      }),
    };
  }
  const pipelineName = explicit || alias;
  if (!pipelineName) {
    return {
      content: JSON.stringify({
        success: false,
        error: "Не задано имя конвейера: укажите pipeline или pipelineName.",
      }),
    };
  }
  const result = tasksToPipelineSpec(allTasks, pipelineName);
  // QA-P3.2: spec всегда создаётся, поэтому «не найден» проверяем по шагам.
  const lookupError = pipelineExportLookupError(allTasks, pipelineName);
  if (!result.spec || lookupError) {
    return {
      content: JSON.stringify({
        success: false,
        error: lookupError ?? `Конвейер "${pipelineName}" не найден.`,
        warnings: result.warnings,
      }),
    };
  }
  const yamlText = yamlStringify(result.spec, { lineWidth: 0 });
  return {
    content: JSON.stringify({
      success: true,
      pipeline: pipelineName,
      steps: result.spec.steps.length,
      yaml: yamlText,
      warnings: result.warnings,
    }),
  };
});

/**
 * Перегенерирует env-файлы всех задач, привязанных к workspace (Спринт 21).
 * Обёртки читают env-файл при запуске, поэтому перезапуск задач не нужен.
 */
async function refreshWorkspaceEnvFiles(workspaceId: string): Promise<number> {
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return 0;
  let refreshed = 0;
  for (const task of await loadTaskDefinitions()) {
    if (task.workspaceId !== workspaceId) continue;
    try {
      writeWorkspaceEnvFile(workspace, PLUGIN_DIR, sanitizeName(task.name));
      refreshed += 1;
    } catch (err) {
      // P2-21: не разрешаем задаче работать с литералом ${secret:...}.
      console.error(
        `[workspace] Задача "${task.name}": env-файл не обновлён — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return refreshed;
}

/** manage_workspaces — CRUD multi-repo workspace-ов. */
const manageWorkspacesExecute = wrapExecute<WorkspacesArgs>(async (args) => {
  try {
    switch (args.action) {
      case "list": {
        const workspaces = listWorkspaces().map((workspace) => ({
          ...workspace,
          env: maskEnvForLog(workspace.env),
          gitBranch: readGitBranch(workspace.path) ?? null,
        }));
        return {
          content: JSON.stringify({
            success: true,
            count: workspaces.length,
            workspaces,
          }),
        };
      }
      case "add": {
        if (!args.path?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: t("tool.workspace.needPath"),
            }),
          };
        }
        const workspace = addWorkspace({
          name: args.name,
          path: args.path,
          color: args.color,
          env: args.env,
          envFile: args.envFile,
        });
        return {
          content: JSON.stringify({
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          }),
        };
      }
      case "update": {
        if (!args.id?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: t("tool.workspace.needUpdateId"),
            }),
          };
        }
        const workspace = updateWorkspace(args.id, {
          name: args.name,
          path: args.path,
          color: args.color,
          env: args.env,
          envFile: args.envFile,
        });
        if (!workspace) {
          return {
            content: JSON.stringify({
              success: false,
              error: t("tool.workspace.notFound"),
            }),
          };
        }
        // Env-файлы уже созданных задач перегенерируются сразу: обёртки читают
        // файл при запуске, поэтому ждать обновления задачи не нужно.
        const refreshedTasks = await refreshWorkspaceEnvFiles(workspace.id);
        return {
          content: JSON.stringify({
            success: true,
            refreshedTasks,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          }),
        };
      }
      case "delete": {
        if (!args.id?.trim()) {
          return {
            content: JSON.stringify({
              success: false,
              error: t("tool.workspace.needDeleteId"),
            }),
          };
        }
        const deleted = deleteWorkspace(args.id);
        return {
          content: JSON.stringify({
            success: deleted,
            message: deleted
              ? t("tool.workspace.deleted")
              : t("tool.workspace.notFound"),
          }),
        };
      }
    }
  } catch (err) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
});

/** matrix_control — результаты, отмена, очистка и предпросмотр матриц. */
const matrixControlExecute = wrapExecute<MatrixControlArgs>(async (args) => {
  if (args.action === "preview") {
    const clones = expandMatrixTask({
      name: (args.name ?? "").trim() || "task",
      schedule: "* * * * *",
      prompt: "preview",
      matrix: {
        workspaceIds: Array.isArray(args.workspaceIds) ? args.workspaceIds : [],
        strategy: args.strategy,
        failureMode: args.failureMode,
        aggregation: args.aggregation,
      },
    });
    return {
      content: JSON.stringify({
        success: true,
        clones: clones.map((clone) => ({
          name: clone.name,
          workspaceId: clone.workspaceId ?? "",
          workspaceName: clone.workspaceId ? getWorkspace(clone.workspaceId)?.name ?? null : null,
        })),
      }),
    };
  }

  if (args.action === "cleanup") {
    const removed = await cleanupOrphanedMatrixTasks();
    return {
      content: JSON.stringify({
        success: true,
        message:
          removed.length > 0
            ? t("tool.matrix.orphansRemoved", { count: removed.length })
            : t("tool.matrix.orphansNone"),
        removed,
      }),
    };
  }

  const name = args.name?.trim();
  if (!name) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.matrix.actionName", { action: args.action }),
      }),
    };
  }

  if (args.action === "cancel") {
    try {
      const result = await cancelMatrixRun(name);
      return {
        content: JSON.stringify({
          success: true,
          message: result.message,
          cancelled: result.cancelled,
        }),
      };
    } catch (err) {
      return {
        content: JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      };
    }
  }

  // QA-P3.7: `results` должен так же проверять тип задачи, как `cancel`.
  // Иначе неизвестное имя даёт success:true с пустым отчётом вместо
  // внятной ошибки «задача не является матрицей».
  if (!isKnownMatrix(name)) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.error.matrixNotMatrix", { name }),
      }),
    };
  }

  try {
    const report = aggregateMatrixResults(name);
    return { content: JSON.stringify({ success: true, report }) };
  } catch (err) {
    return {
      content: JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
});

/**
 * T-7.3: KPI токен-эффективности в general metrics (MCP и RPC).
 * Считаем по тому же 14-дневному окну, что и tool.blocked; fail-open:
 * пустая история даёт нули и score=0, без NaN/Infinity.
 */
function withTokenEfficiency<T extends Record<string, unknown>>(metrics: T): T & {
  tokenEfficiency: ReturnType<typeof tokenEfficiencyScore>;
} {
  const efficiency = tokenEfficiencyScore(getHistoryForAnalytics(14));
  return { ...metrics, tokenEfficiency: efficiency };
}

/** get_metrics — суммарная статистика запусков. */
const getMetricsExecute = wrapExecute<MetricsArgs>(async () => {
  const metrics = await loadMetrics();
  // PL-4.1: блокировки инструментов — показатель корректности hybrid-политики.
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const toolBlocked = readAuditLog({ action: "tool.blocked", since, limit: 1 }).total;
  return {
    content: JSON.stringify({
      success: true,
      metrics: withTokenEfficiency({ ...metrics, toolBlocked }),
    }),
  };
});

/** get_analytics — аналитика запусков и стоимости за период. */
const getAnalyticsExecute = wrapExecute<AnalyticsArgs>(async (args) => {
  const windowDays = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 14)));
  const records = getHistoryForAnalytics(windowDays);
  const definitions = await loadTaskDefinitions();
  const report = buildAnalytics(records, {
    days: windowDays,
    topLimit: Math.max(1, Math.floor(Number(args.topLimit) || 10)),
    tasks: definitions.filter((d) => !d.name.startsWith("__")).map((definition) => ({
      name: definition.name,
      matrixParentId: definition.matrixParentId,
      tokenBudget: definition.tokenBudget,
    })),
  });
  // Экономика v2 (E-1.1): учёт расхода за день/неделю рядом с аналитикой.
  const settings = await loadSettings();
  const budgets = buildBudgetReport(records, settings.budgets, new Date());
  // PL-4.1: tool.blocked — метрика корректности прав политики, а не ошибка
  // запуска. Считаем за то же окно, что и аналитику; readAuditLog отдаёт total
  // независимо от limit, поэтому одной строки выборки достаточно для счётчика.
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const toolBlocked = readAuditLog({ action: "tool.blocked", since, limit: 1 }).total;
  return {
    content: JSON.stringify({
      success: true,
      report: { ...report, budgets, toolBlocked },
    }),
  };
});

/** self_analysis — система самоанализа: здоровье, аномалии, тренды, рекомендации. */
const selfAnalysisExecute = wrapExecute<SelfAnalysisArgs>(async (args) => {
  const windowDays = Math.min(365, Math.max(1, Math.floor(Number(args.days) || 14)));
  const records = getHistoryForAnalytics(windowDays);
  const definitions = await loadTaskDefinitions();
  
  const report = generateSelfAnalysisReport(records, {
    days: windowDays,
    topLimit: Math.max(1, Math.floor(Number(args.topLimit) || 10)),
    tasks: definitions.filter((d) => !d.name.startsWith("__")).map((definition) => ({
      name: definition.name,
      matrixParentId: definition.matrixParentId,
      tokenBudget: definition.tokenBudget,
    })),
  });

  // Фильтруем секции если нужно
  const result: Partial<typeof report> = {
    generatedAt: report.generatedAt,
    windowDays: report.windowDays,
    health: report.health,
    summary: report.summary,
    sources: report.sources,
    // PL-98: свежая проверка цепочки — отчёт всегда показывает текущее состояние.
    gateLedger: verifyGateLedgerIntegrity("self-analysis:tool"),
  };

  if (args.includeAnomalies !== false) {
    result.anomalies = report.anomalies;
  }
  if (args.includeTrends !== false) {
    result.trends = report.trends;
  }
  if (args.includeRecommendations !== false) {
    result.recommendations = report.recommendations;
  }

  return { content: JSON.stringify({ success: true, report: result }) };
});

/** manage_settings — чтение и изменение глобальных настроек. */
const manageSettingsExecute = wrapExecute<SettingsArgs>(async (args) => {
  const current = await loadSettings();
  if (args.action === "get" || args.action === "list") {
    return { content: JSON.stringify({ success: true, settings: current }) };
  }

  if (
    args.maxConcurrent === undefined &&
    args.locale === undefined &&
    args.winterMode === undefined &&
    args.notifications === undefined &&
    args.history === undefined &&
    args.integrations === undefined &&
    args.audit === undefined &&
    args.permissions === undefined &&
    args.budgets === undefined &&
    args.feedback === undefined
  ) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.settings.updateFields"),
        settings: current,
      }),
    };
  }

  const settings = await saveSettings({
    maxConcurrent: args.maxConcurrent,
    locale: args.locale,
    winterMode: args.winterMode,
    notifications: args.notifications as NotificationSettings | undefined,
    history: args.history as HistorySettings | undefined,
    integrations: args.integrations as IntegrationSettings | undefined,
    audit: args.audit as AuditSettings | undefined,
    permissions: args.permissions as PermissionSettings | undefined,
    budgets: args.budgets as BudgetSettings | undefined,
    feedback: args.feedback as FeedbackSettings | undefined,
  });
  // Локаль процесса меняется сразу — перезапуск плагина не нужен.
  setLocale(resolveLocale(settings.locale, settings.uiLocale));
  return { content: JSON.stringify({ success: true, settings }) };
});

/** Настройки триажа: сохранённые или дефолт для незаполненного конфига. */
function triageOrDefault(settings: Awaited<ReturnType<typeof loadSettings>>): TriageSettings {
  const saved = settings.notifications.triage;
  if (saved) return saved;
  const fallback = defaultNotifications().triage;
  return (
    fallback ?? {
      mode: "off",
      baseUrl: "http://127.0.0.1:11434",
      model: "",
      timeoutMs: 60_000,
      fallback: "rules",
      confidenceThreshold: 0.6,
    }
  );
}

/** Синтетическое уведомление для проверки связи с моделью. */
const LOCAL_AI_SELF_TEST: TriageInput = {
  taskName: "scheduler-self-test",
  status: "error",
  error: "Quality Gate failed: 2 tests broke the build",
  durationMs: 12_000,
};

/** Один классификационный запрос — общий путь для инструмента и GUI. */
export async function runLocalAiTest(patch: LocalAiPatch = {}) {
  const settings = await loadSettings();
  const { settings: candidate } = applyLocalAiPatch(triageOrDefault(settings), patch);
  const result = await classifyNotification(LOCAL_AI_SELF_TEST, candidate, { retries: 0 });
  return {
    success: result.ok,
    localAi: summarizeLocalAi(candidate),
    result: {
      ok: result.ok,
      failure: result.failure ?? null,
      error: result.error ?? null,
      latencyMs: result.latencyMs,
      attempts: result.attempts,
      model: result.model,
      protocol: result.protocol,
      verdict: result.verdict ?? null,
    },
  };
}

/** manage_local_ai — настройки триажа и проверка связи с моделью. */
const manageLocalAiExecute = wrapExecute<LocalAiArgs>(async (args) => {
  const settings = await loadSettings();
  const current = triageOrDefault(settings);

  if (args.action === "get") {
    return {
      content: JSON.stringify({ success: true, localAi: summarizeLocalAi(current) }),
    };
  }

  const patch: LocalAiPatch = {
    mode: args.mode,
    baseUrl: args.baseUrl,
    model: args.model,
    timeoutMs: args.timeoutMs,
    fallback: args.fallback,
    confidenceThreshold: args.confidenceThreshold,
    shadow: args.shadow,
  };

  if (args.action === "test") {
    // Проверка не меняет конфиг: патч применяется только в памяти.
    return { content: JSON.stringify(await runLocalAiTest(patch)) };
  }

  if (!Object.values(patch).some((value) => value !== undefined)) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.localAi.updateFields"),
        localAi: summarizeLocalAi(current),
      }),
    };
  }

  const { settings: merged, changed } = applyLocalAiPatch(current, patch);
  const saved = await saveSettings({
    notifications: { ...settings.notifications, triage: merged },
  });
  const localAi = summarizeLocalAi(triageOrDefault(saved));
  return {
    content: JSON.stringify({
      success: true,
      changed,
      message:
        changed.length > 0
          ? t("tool.localAi.updated", { fields: changed.join(", ") })
          : t("tool.localAi.unchanged"),
      localAi,
    }),
  };
});

/** manage_templates — список, сохранение и удаление шаблонов задач. */
const manageTemplatesExecute = wrapExecute<TemplatesArgs>(async (args) => {
  if (args.action === "list") {
    return { content: JSON.stringify({ success: true, templates: await loadTemplates() }) };
  }

  if (args.action === "delete") {
    // PL-17/PL-28/PL-32: name — такой же алиас id, как и в репозитории.
    const id = args.id?.trim() || args.name?.trim();
    if (!id) {
      return { content: JSON.stringify({ success: false, error: t("tool.template.needDeleteId") }) };
    }
    const before = await loadTemplates();
    // QA-P3.3: name является алиасом id при удалении.
    const existed = before.some((template) => template.id === id || template.name === id);
    await deleteTemplate(id);
    return {
      content: JSON.stringify({
        success: existed,
        message: existed
          ? t("tool.template.deleted", { id })
          : t("tool.template.notFound", { id }),
      }),
    };
  }

  const { action, ...fields } = args;
  // QA-A2.7: action уже обработан ветками выше, в поля шаблона он не входит.
  void action;
  if (!fields.name?.trim() || !fields.prompt?.trim()) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.template.saveRequired"),
      }),
    };
  }
  const template = await saveTemplate(fields as Omit<TaskTemplate, "id"> & { id?: string });
  return { content: JSON.stringify({ success: true, template }) };
});

/** manage_profiles — список, создание, переключение и удаление профилей. */
const manageProfilesExecute = wrapExecute<ProfilesArgs>(async (args) => {
  if (args.action === "list") {
    return {
      content: JSON.stringify({
        success: true,
        current: getProfileName(),
        pinnedByEnv: isProfilePinnedByEnv(),
        profiles: listProfiles(),
      }),
    };
  }

  const name = args.name?.trim();
  if (!name) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.profile.nameRequired", { action: args.action }),
      }),
    };
  }

  if (args.action === "create") {
    const meta = createProfile(name, args.port);
    const profile = listProfiles().find((item) => item.name === meta.name);
    return {
      content: JSON.stringify({
        success: true,
        message: t("tool.profile.created", { name: meta.name, port: meta.port }),
        profile: profile ?? {
          name: meta.name,
          dir: getProfileDir(meta.name),
          port: meta.port,
          isDefault: meta.name === DEFAULT_PROFILE,
          active: meta.name === getProfileName(),
        },
      }),
    };
  }

  if (args.action === "switch") {
    setActiveProfile(name);
    const current = getProfileName();
    return {
      content: JSON.stringify({
        success: true,
        current,
        restartRequired: true,
        message: isProfilePinnedByEnv()
          ? t("tool.profile.envVar", { name: current })
          : t("tool.profile.active", { name: sanitizeProfileName(name) }),
      }),
    };
  }

  const removed = await deleteProfile(name);
  return {
    content: JSON.stringify({
      success: removed,
      message: removed
        ? t("tool.profile.deleted", { name: sanitizeProfileName(name) })
        : t("tool.profile.notFound"),
    }),
  };
});

/** transfer_tasks — экспорт и импорт задач. */
const transferTasksExecute = wrapExecute<TransferArgs>(async (args) => {
  if (args.action === "export") {
    const tasks = await scheduler.listTasks();
    const { data, count } = await buildExportJson(
      tasks.map((task) => ({ ...task, name: task.taskName || "" })),
    );
    return { content: JSON.stringify({ success: true, data, count }) };
  }

  if (!args.data) {
    return { content: JSON.stringify({ success: false, error: t("tool.transfer.importData") }) };
  }
  const parsed = parseImportJson(args.data);
  if (parsed.tasks.length === 0) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.transfer.noTasks"),
        errors: parsed.errors,
      }),
    };
  }

  const imported: string[] = [];
  const errors: string[] = [...parsed.errors];
  for (const def of parsed.tasks) {
    try {
      await schedulerCreateTask(
        def.name,
        def.schedule,
        def.prompt,
        def.timeoutSeconds,
        def.workingDirectory ?? def.workdir,
        def.retryCount,
        def.retryDelay,
        def.qualityGate,
        def.nextTaskOnSuccess,
        def.nextTaskOnError,
        def.triggerType,
        def.watchPath,
        def.dependsOn,
        def.model,
        def.priority,
        def.beforeScript,
        def.afterScript,
        def.mcpEvent,
        def.workspaceId,
        def.allowedTools,
        def.deniedTools,
        def.matrix,
        def.matrixParentId,
        "create",
        def.timezone,
        def.notBefore,
        def.notAfter,
        def.pausedUntil,
        def.runAt,
        def.session,
        def.sessionId,
        def.sessionMaxRuns,
        {
          activeDays: def.activeDays,
          windowPolicy: def.windowPolicy,
          watchGlobs: def.watchGlobs,
          watchIgnore: def.watchIgnore,
          gitBranch: def.gitBranch,
          gitPaths: def.gitPaths,
          gitIgnore: def.gitIgnore,
          gitPollSeconds: def.gitPollSeconds,
        },
        def.runWhenLoggedOff,
        def.paused,
        def.legacyShell,
        def.worktree,
        def.guards,
        // QA-P0.1 (E-2.1): импорт через transfer_tasks сохраняет tokenBudget.
        def.tokenBudget,
      );
      await saveTaskDefinition(def);
      imported.push(def.name);
    } catch (err) {
      errors.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await refreshTriggers();
  return {
    content: JSON.stringify({ success: errors.length === 0, imported, errors }),
  };
});

/** send_notification — тестовое уведомление или дайджест. */
const sendNotificationExecute = wrapExecute<NotificationArgs>(async (args) => {
  const result =
    args.action === "test"
      ? await sendTestNotification(args.channel ?? "all")
      : await sendDigestNow({ updateLastSentAt: false });
  return { content: JSON.stringify(result) };
});

/**
 * Общий сборщик текста баг-репорта (устраняет дублирование между MCP-тулом
 * и RPC-хендлером — QA-находка 3.8). Возвращает также сырые логи и метрики
 * для структурированного payload (F-1.1).
 */
async function buildBugReportText(input: {
  description: string;
  taskName?: string;
  includeLogs?: boolean;
  includeAnalytics?: boolean;
}): Promise<{ text: string; logs?: string; metrics?: Record<string, number> }> {
  const lines: string[] = [];
  lines.push("🐛 *Bug report — agent-steward plugin*");
  lines.push(`Время: ${new Date().toISOString()}`);
  lines.push(`Описание: ${input.description}`);
  let logs: string | undefined;
  if (input.taskName) {
    lines.push(`Задача: ${input.taskName}`);
    if (input.includeLogs) {
      try {
        const taskLogs = await getTaskLogs(input.taskName);
        if (taskLogs.logs) {
          logs = String(taskLogs.logs).slice(0, 2000);
          lines.push(`\n--- Логи задачи ${input.taskName} ---`);
          lines.push(logs);
        }
      } catch (err) {
        lines.push(`\n--- Логи задачи ${input.taskName}: ошибка чтения ---`);
        lines.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  let metrics: Record<string, number> | undefined;
  if (input.includeAnalytics !== false) {
    try {
      const raw = await loadMetrics();
      metrics = {
        total: raw.total,
        success: raw.success,
        error: raw.error,
        partial: raw.partial ?? 0,
      };
      lines.push("\n--- Метрики ---");
      lines.push(`Всего запусков: ${metrics.total}`);
      lines.push(`Успех: ${metrics.success}`);
      lines.push(`Ошибок: ${metrics.error}`);
      if (metrics.partial) lines.push(`Частично: ${metrics.partial}`);
    } catch (err) {
      lines.push(`\n--- Метрики: ошибка чтения: ${err instanceof Error ? err.message : String(err)} ---`);
    }
    try {
      const records = getHistoryForAnalytics(7);
      const definitions = await loadTaskDefinitions();
      const report = buildAnalytics(records, {
        days: 7,
        topLimit: 10,
        tasks: definitions.filter((d) => !d.name.startsWith("__")).map((definition) => ({
          name: definition.name,
          matrixParentId: definition.matrixParentId,
          tokenBudget: definition.tokenBudget,
        })),
      });
      lines.push("\n--- Аналитика (7 дней) ---");
      lines.push(`Всего запусков: ${report.totals.total}`);
      lines.push(`Успех: ${report.totals.success}`);
      lines.push(`Ошибок: ${report.totals.error}`);
      if (report.totals.partial) lines.push(`Частично: ${report.totals.partial}`);
      const errorTasks = report.tasks.filter((task) => task.error > 0).slice(0, 5);
      if (errorTasks.length > 0) {
        lines.push(
          `Задачи с ошибками: ${errorTasks.map((task) => `${task.taskName} (${task.error})`).join(", ")}`,
        );
      }
    } catch (err) {
      lines.push(`\n--- Аналитика: ошибка чтения: ${err instanceof Error ? err.message : String(err)} ---`);
    }
  }
  return { text: lines.join("\n"), logs, metrics };
}

/**
 * Значения всех секретов из manage_secrets — используются только для
 * редактирования текста (F-1.4). Ни одно значение не попадает в payload.
 */
function collectSecretValues(): string[] {
  const values: string[] = [];
  for (const item of listSecrets()) {
    const value = getSecret(item.name);
    if (value && value.length >= 4) values.push(value);
  }
  return values;
}

/** report_bug — отчёт о баге; по умолчанию уходит автору через приёмник F-2. */
const reportBugExecute = wrapExecute<ReportBugArgs>(async (args) => {
  const settings = await loadSettings();
  const includeLogs = args.includeLogs ?? settings.feedback.includeLogs;
  const built = await buildBugReportText({
    description: args.description,
    taskName: args.taskName,
    includeLogs,
    includeAnalytics: args.includeAnalytics,
  });
  const secretValues = collectSecretValues();
  const localText = redactText(built.text, { secrets: secretValues, redactEmails: false });

  const result = await reportFeedback({
    settings: settings.feedback,
    destination: args.destination ?? "author",
    dryRun: args.dryRun,
    description: args.description,
    taskName: args.taskName,
    contactEmail: args.contactEmail ?? settings.feedback.contactEmail,
    redactedLogs: includeLogs ? built.logs : undefined,
    metrics: built.metrics,
    locale: settings.locale,
    secrets: secretValues,
    sendLocal: (text) => sendBugReport(text, args.channel),
    localText,
  });
  return {
    content: JSON.stringify({
      ...result,
      message:
        result.mode === "dryRun"
          ? t("feedback.dryRun")
          : result.mode === "sent"
            ? t("feedback.sent")
            : result.mode === "outbox"
              ? t("feedback.outbox")
              : result.mode === "duplicate"
                ? t("feedback.duplicate")
                : t("feedback.local"),
    }),
  };
});

/** get_dashboard_info — порт дашборда, платформа и активный профиль. */
const getDashboardInfoExecute = wrapExecute<DashboardInfoArgs>(async () => {
  // QA-P3.5: порт из профиля/env может быть «бумажным» (4782), а живой
  // дашборд слушает 3782. Проверяем маркер и при необходимости находим порт
  // зондированием стандартных кандидатов, чтобы отчёт совпадал с реальностью.
  let port = getDashboardPort();
  let probe = port ? await probeDashboardOn(port) : null;
  if (!probe?.dashboard) {
    const discovered = await discoverDashboardPort();
    if (discovered) {
      port = discovered;
      probe = await probeDashboardOn(port);
    }
  }
  return {
    content: JSON.stringify({
      success: true,
      port,
      url: port ? `http://127.0.0.1:${port}` : null,
      platform: scheduler.platform,
      title: scheduler.title,
      profile: getProfileName(),
      reachable: probe?.dashboard ?? false,
    }),
  };
});

/** cleanup_history — удаление старых записей истории. */
const cleanupHistoryExecute = wrapExecute<CleanupHistoryArgs>(async (args) => {
  const report = await runHistoryRetention({
    retentionDays: args.retentionDays,
    maxRecords: args.maxRecords,
  });
  return {
    content: JSON.stringify({
      success: true,
      message: report.skipped
        ? report.skipped
        : t("tool.history.cleaned", {
          deleted: report.deleted,
          byAge: report.deletedByAge,
          byCount: report.deletedByCount,
          kept: report.kept,
        }),
      report,
    }),
  };
});

/** PL-35: единый обработчик события для агентского инструмента и RPC/GUI. */
type EmitEventCode = "no_subscribers" | "start_failed" | "ok";
interface EmitEventResult {
  success: boolean;
  code: EmitEventCode;
  event: string;
  matched: string[];
  triggered: string[];
  failed: { name: string; error: string }[];
  message: string;
}

const DEFAULT_EVENT_PRIORITY = 5;

/**
 * QV-3: проверка, что задача подписана на MCP-событие. Источник `server`
 * сравнивается только когда он передан вызывающим — это сохраняет обратную
 * совместимость со старыми вызовами emit_event без указания источника.
 */
export function matchesMcpEventSubscription(
  def: TaskDefinition,
  event: string,
  server?: string,
  payload?: unknown,
): boolean {
  if ((def.triggerType ?? "cron") !== "mcp-event") return false;
  // PL-48: definition может хранить алиас `eventName` (PL-42), поэтому матчер
  // читает нормализованное событие, а не только каноническое поле `event`.
  const subscription = normalizeMcpEventTrigger(def.mcpEvent);
  if (subscription?.event.toLowerCase() !== event.toLowerCase()) return false;
  const expectedServer = server?.trim();
  if (
    expectedServer &&
    subscription.server.toLowerCase() !== expectedServer.toLowerCase()
  ) {
    return false;
  }
  return matchesEventFilter(subscription.filter, payload);
}

export async function emitEventCore(
  rawEventName: string | undefined,
  payload: unknown,
  server?: string,
): Promise<EmitEventResult> {
  const event = rawEventName?.trim() ?? "";
  if (!event) {
    return {
      success: false,
      code: "no_subscribers",
      event,
      matched: [],
      triggered: [],
      failed: [],
      message: t("tool.event.nameRequiredShort"),
    };
  }

  const definitions = await loadTaskDefinitions();
  const matched = definitions
    .filter((def) => matchesMcpEventSubscription(def, event, server, payload))
    .sort(
      (a, b) =>
        (normalizePriority(b.priority) ?? DEFAULT_EVENT_PRIORITY) -
        (normalizePriority(a.priority) ?? DEFAULT_EVENT_PRIORITY),
    );

  const triggered: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const def of matched) {
    try {
      await runTaskEntry(def.name);
      triggered.push(def.name);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ name: def.name, error });
      console.error(`[agent-steward] emit_event: не удалось запустить ${def.name}: ${error}`);
    }
  }

  const code: EmitEventCode =
    matched.length === 0 ? "no_subscribers" : failed.length > 0 ? "start_failed" : "ok";
  const message =
    code === "no_subscribers"
      ? t("tool.event.none", { event })
      : code === "start_failed"
        ? t("tool.event.startFailed", { count: failed.length })
        : t("tool.event.triggered", { count: triggered.length });
  return {
    success: true,
    code,
    event,
    matched: matched.map((def) => def.name),
    triggered,
    failed,
    message,
  };
}

/** emit_event — запуск задач, подписанных на MCP-событие. */
const emitEventExecute = wrapExecute<EmitEventArgs>(async (args) => {
  const result = await emitEventCore(args.eventName, args.payload ?? {}, args.server);
  if (!result.success) {
    return { content: JSON.stringify({ ...result, error: result.message }) };
  }
  return { content: JSON.stringify(result) };
});

/** manage_secrets — зашифрованное хранилище секретов. */
const manageSecretsExecute = wrapExecute<SecretsArgs>(async (args) => {
  if (args.action === "list") {
    return { content: JSON.stringify({ success: true, secrets: listSecrets() }) };
  }

  const name = (args.name ?? "").trim();
  if (!name) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.secret.nameRequired"),
      }),
    };
  }

  if (args.action === "delete") {
    const existed = hasSecret(name);
    deleteSecret(name);
    return {
      content: JSON.stringify({
        success: existed,
        message: existed
          ? t("tool.secret.deleted", { name })
          : t("tool.secret.notFound", { name }),
      }),
    };
  }

  const value = args.value;
  if (typeof value !== "string" || value.length === 0) {
    return {
      content: JSON.stringify({
        success: false,
        error: t("tool.secret.valueRequired"),
      }),
    };
  }

  const item = setSecret(name, value);
  return {
    content: JSON.stringify({
      success: true,
      message: t("tool.secret.saved", { name: item.name }),
      secret: item,
    }),
  };
});

/** get_audit_log — чтение журнала мутаций. */
const getAuditLogExecute = wrapExecute<AuditLogArgs>(async (args) => {
  const result = readAuditLog({
    action: args.action,
    target: args.target,
    actor: args.actor,
    since: args.since,
    until: args.until,
    limit: args.limit,
  });
  return { content: JSON.stringify({ success: true, ...result }) };
});

/**
 * Оборачивает execute инструмента, записывая успешную мутацию в audit log.
 * Аудит не должен ломать сам инструмент, поэтому ошибки проглатываются.
 */
function withAudit<A>(
  toolName: string,
  describe: (args: A) => Omit<AuditEntryInput, "actor"> | null,
  execute: (args: A, context: ToolExecuteContext) => Promise<Tool.Result>,
): (args: A, context: ToolExecuteContext) => Promise<Tool.Result> {
  return async (args: A, context: ToolExecuteContext) => {
    const result = await execute(args, context);
    try {
      const content = result.content;
      const raw = typeof content === "string" ? content : "";
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "success" in parsed &&
        parsed.success === false
      ) {
        return result;
      }
      const entry = describe(args);
      if (entry) {
        recordAudit({ ...entry, actor: "mcp", source: toolName });
      }
    } catch {
      // Аудит — вспомогательная функция: не мешает основной операции.
    }
    return result;
  };
}

/** Поля payload-а GUI-RPC, которые читают правила аудита. */
interface RpcAuditInput {
  name?: string;
  path?: string;
  id?: string;
  runId?: string;
  eventName?: string;
  taskName?: string;
}

/** Тип обработчика GUI-RPC: конкретные аргументы известны только вызывающей стороне. */
type RpcHandler = (...args: never[]) => unknown;

/** Правила аудита для RPC-методов GUI (Спринт 26). */
const RPC_AUDIT_RULES: Record<
  string,
  {
    action: string;
    targetType: string;
    target: (input: RpcAuditInput) => string;
  }
> = {
  create_task: { action: "task.create", targetType: "task", target: (i) => i.name ?? "" },
  update_task: { action: "task.update", targetType: "task", target: (i) => i.name ?? "" },
  delete_task: { action: "task.delete", targetType: "task", target: (i) => i.name ?? "" },
  run_task: { action: "task.run", targetType: "task", target: (i) => i.name ?? "" },
  run_mission: {
    action: "mission.run",
    targetType: "mission",
    target: (i) => i.taskName ?? "ad-hoc",
  },
  pause_task: { action: "task.pause", targetType: "task", target: (i) => i.name ?? "" },
  resume_task: { action: "task.resume", targetType: "task", target: (i) => i.name ?? "" },
  cancel_matrix: { action: "matrix.cancel", targetType: "matrix", target: (i) => i.name ?? "" },
  cleanup_matrix_orphans: {
    action: "matrix.cleanup",
    targetType: "matrix",
    target: () => "orphans",
  },
  cleanup_history: {
    action: "history.cleanup",
    targetType: "history",
    target: () => "runs",
  },
  retry_dlq: { action: "dlq.retry", targetType: "dlq", target: (i) => i.id ?? "" },
  discard_dlq: { action: "dlq.discard", targetType: "dlq", target: (i) => i.id ?? "" },
  pause_durable_run: {
    action: "run.pause",
    targetType: "run",
    target: (i) => i.runId ?? "",
  },
  resume_durable_run: {
    action: "run.resume",
    targetType: "run",
    target: (i) => i.runId ?? "",
  },
  emit_event: { action: "event.emit", targetType: "event", target: (i) => i.eventName ?? "" },
  add_workspace: {
    action: "workspace.add",
    targetType: "workspace",
    target: (i) => i.name ?? i.path ?? "",
  },
  update_workspace: {
    action: "workspace.update",
    targetType: "workspace",
    target: (i) => i.id ?? "",
  },
  delete_workspace: {
    action: "workspace.delete",
    targetType: "workspace",
    target: (i) => i.id ?? "",
  },
  set_profile: { action: "profile.switch", targetType: "profile", target: (i) => i.name ?? "" },
  create_profile: {
    action: "profile.create",
    targetType: "profile",
    target: (i) => i.name ?? "",
  },
  delete_profile: {
    action: "profile.delete",
    targetType: "profile",
    target: (i) => i.name ?? "",
  },
  import_tasks: { action: "tasks.import", targetType: "tasks", target: () => "snapshot" },
  save_settings: { action: "settings.update", targetType: "settings", target: () => "global" },
  save_template: {
    action: "template.save",
    targetType: "template",
    target: (i) => i.id ?? i.name ?? "",
  },
  delete_template: {
    action: "template.delete",
    targetType: "template",
    target: (i) => i.id ?? "",
  },
  save_secret: { action: "secret.set", targetType: "secret", target: (i) => i.name ?? "" },
  delete_secret: { action: "secret.delete", targetType: "secret", target: (i) => i.name ?? "" },
};

/**
 * Оборачивает RPC-обработчики GUI: успешные мутации попадают в audit log
 * с actor=gui. Ошибки аудита не влияют на ответ GUI.
 */
function withRpcAudit<T extends Record<string, RpcHandler>>(handlers: T): T {
  const wrapped: Record<string, RpcHandler> = {};
  const entries: [string, RpcHandler][] = Object.entries(handlers);
  for (const [name, handler] of entries) {
    const rule = RPC_AUDIT_RULES[name];
    if (!rule || typeof handler !== "function") {
      wrapped[name] = handler;
      continue;
    }
    wrapped[name] = async (...args: never[]) => {
      const input = (args[0] ?? {}) as RpcAuditInput;
      const result = await handler(...args);
      try {
        const failed =
          typeof result === "object" &&
          result !== null &&
          "success" in result &&
          result.success === false;
        if (!failed) {
          recordAudit({
            action: rule.action,
            targetType: rule.targetType,
            target: rule.target(input),
            actor: "gui",
            source: name,
          });
        }
      } catch {
        // Журнал не должен ломать GUI-операцию.
      }
      return result;
    };
  }
  return wrapped as T;
}

/**
 * Менеджер файловых триггеров живёт на уровне модуля, чтобы его можно было
 * обновлять после создания/изменения/удаления задачи. Раньше refresh()
 * вызывался только при старте плагина, из-за чего новые watchPath начинали
 * работать лишь после перезапуска OpenCode.
 */
let fileWatcherManager: FileWatchManager | null = null;

/**
 * Спринт 27: менеджер git-триггеров. Опрашивает HEAD задач с
 * triggerType === "git" и запускает их при новых подходящих коммитах.
 */
let gitTriggerManager: GitTriggerManager | null = null;

/**
 * Приводит в актуальное состояние все событийные триггеры (файлы и git).
 * Вызывается после создания, изменения и удаления задачи.
 */
async function refreshTriggers(): Promise<void> {
  if (fileWatcherManager) {
    try {
      await fileWatcherManager.refresh();
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось обновить файловые триггеры: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (gitTriggerManager) {
    try {
      await gitTriggerManager.refresh();
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось обновить git-триггеры: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Максимальная задержка переноса событийного запуска (12 часов). */
const EVENT_POSTPONE_MAX_MS = 12 * 60 * 60 * 1000;

/**
 * Спринт 27: запуск задачи по событию (файл, git, MCP) с учётом окна запуска
 * и разрешённых дней недели. Вне окна: skip — пишем причину и выходим,
 * postpone — таймер до ближайшего открытия, run — запускаем сразу.
 */
async function scheduleEventRun(taskName: string, reason: string): Promise<void> {
  const definition = getTask(taskName);
  if (!definition) return;

  const policy = definition.windowPolicy ?? "postpone";
  const options = {
    notBefore: definition.notBefore,
    notAfter: definition.notAfter,
    days: definition.activeDays,
    timeZone: definition.timezone,
  };
  const now = new Date();
  const state = activeWindowState(now, options);

  if (state.active || policy === "run") {
    const startedAt = now.toISOString();
    try {
      await runTaskEntry(taskName);
    } catch (err) {
      // PL-53: отказ старта по событийному триггеру раньше уходил только
      // в console.error хоста и не оставлял следа в истории/журнале.
      const message = err instanceof Error ? err.message : String(err);
      const runId = recordRun(taskName, "error", startedAt, 0, message);
      appendStructuredLog({
        event: "trigger.start_failed",
        runId,
        task: taskName,
        status: "error",
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        error: message,
        reason,
      });
      throw err;
    }
    console.log(
      `[agent-steward] Запуск задачи "${taskName}" (${reason}).`,
    );
    return;
  }

  if (policy === "skip") {
    console.log(
      `[agent-steward] Задача "${taskName}" не запущена (${reason}): ${
        state.reason ?? "вне окна"
      } — политика skip.`,
    );
    return;
  }

  const delay = nextWindowOpenDelayMs(now, options);
  if (delay <= 0 || delay > EVENT_POSTPONE_MAX_MS) {
    console.log(
      `[agent-steward] Задача "${taskName}" не запущена (${reason}): ${
        state.reason ?? "вне окна"
      } — до открытия окна больше 12 ч.`,
    );
    return;
  }

  console.log(
    `[agent-steward] Задача "${taskName}" (${reason}) отложена на ~${Math.round(
      delay / 60000,
    )} мин: ${state.reason ?? "вне окна"}.`,
  );
  const timer = setTimeout(() => {
    void scheduleEventRun(taskName, reason).catch((err) => {
      console.error(
        `[agent-steward] Не удалось запустить отложенную задачу "${taskName}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, delay);
  timer.unref?.();
}

/**
 * P-1.1: адаптер запуска. Реализация ядра живёт в src/runtime.ts и не знает
/*; здесь связываем её с состоянием entrypoint'а.
 */
const RUNTIME_DEPS: RuntimeDeps = {
  scheduler: scheduler,
  setProjectDirectory: (directory) => {
    projectDirectory = directory;
  },
  setFileWatcherManager: (manager) => {
    fileWatcherManager = manager;
  },
  getFileWatcherManager: () => fileWatcherManager,
  setGitTriggerManager: (manager) => {
    gitTriggerManager = manager;
  },
  getGitTriggerManager: () => gitTriggerManager,
  garbageCollectTaskArtifacts,
  resumeExpiredPauses,
  maybeSendDigest,
  checkStuckMatrices,
  refreshTriggers,
  scheduleEventRun,
  runTaskEntry,
};

export async function createRuntime(ctxLike: RuntimeContextLike): Promise<SchedulerRuntime> {
  return createRuntimeCore(ctxLike, RUNTIME_DEPS);
}
/**
 * Реестр execute-обработчиков всех инструментов плагина.
 *
 * Ключи совпадают с именами инструментов. Оба entrypoint'а (V2 `setup` и
 * будущий V1 `server`) берут обработчики отсюда, поэтому поведение инструментов
 * не зависит от версии OpenCode.
 */
export interface ToolHandlers {
  schedule_task: typeof scheduleTaskExecute;
  schedule_advanced: typeof scheduleTaskExecute;
  list_tasks: typeof listTasksExecute;
  update_task: typeof updateTaskExecute;
  update_advanced: typeof updateTaskExecute;
  delete_task: typeof deleteTaskExecute;
  run_task_now: typeof runTaskNowExecute;
  pause_task: typeof pauseTaskExecute;
  resume_task: typeof resumeTaskExecute;
  get_history: typeof getHistoryExecute;
  get_task_logs: typeof getTaskLogsExecute;
  dry_run: typeof dryRunExecute;
  pipeline_validate: typeof pipelineValidateExecute;
  pipeline_apply: typeof pipelineApplyExecute;
  pipeline_export: typeof pipelineExportExecute;
  manage_workspaces: typeof manageWorkspacesExecute;
  matrix_control: typeof matrixControlExecute;
  get_metrics: typeof getMetricsExecute;
  get_analytics: typeof getAnalyticsExecute;
  self_analysis: typeof selfAnalysisExecute;
  manage_settings: typeof manageSettingsExecute;
  manage_local_ai: typeof manageLocalAiExecute;
  manage_templates: typeof manageTemplatesExecute;
  manage_profiles: typeof manageProfilesExecute;
  transfer_tasks: typeof transferTasksExecute;
  send_notification: typeof sendNotificationExecute;
  report_bug: typeof reportBugExecute;
  get_dashboard_info: typeof getDashboardInfoExecute;
  cleanup_history: typeof cleanupHistoryExecute;
  emit_event: typeof emitEventExecute;
  manage_secrets: typeof manageSecretsExecute;
  get_audit_log: typeof getAuditLogExecute;
}

/**
 * Создаёт реестр обработчиков для конкретного экземпляра ядра.
 *
 * `runtime` пока не используется: обработчики опираются на общие помощники
 * модуля. Параметр оставлен, чтобы при переносе состояния в runtime сигнатуры
 * инструментов не менялись.
 */
export function createToolHandlers(_runtime: SchedulerRuntime): ToolHandlers {
  return {
    schedule_task: scheduleTaskExecute,
    schedule_advanced: scheduleTaskExecute,
    list_tasks: listTasksExecute,
    update_task: updateTaskExecute,
    update_advanced: updateTaskExecute,
    delete_task: deleteTaskExecute,
    run_task_now: runTaskNowExecute,
    pause_task: pauseTaskExecute,
    resume_task: resumeTaskExecute,
    get_history: getHistoryExecute,
    get_task_logs: getTaskLogsExecute,
    dry_run: dryRunExecute,
    pipeline_validate: pipelineValidateExecute,
    pipeline_apply: pipelineApplyExecute,
    pipeline_export: pipelineExportExecute,
    manage_workspaces: manageWorkspacesExecute,
    matrix_control: matrixControlExecute,
    get_metrics: getMetricsExecute,
    get_analytics: getAnalyticsExecute,
    self_analysis: selfAnalysisExecute,
    manage_settings: manageSettingsExecute,
    manage_local_ai: manageLocalAiExecute,
    manage_templates: manageTemplatesExecute,
    manage_profiles: manageProfilesExecute,
    transfer_tasks: transferTasksExecute,
    send_notification: sendNotificationExecute,
    report_bug: reportBugExecute,
    get_dashboard_info: getDashboardInfoExecute,
    cleanup_history: cleanupHistoryExecute,
    emit_event: emitEventExecute,
    manage_secrets: manageSecretsExecute,
    get_audit_log: getAuditLogExecute,
  };
}

/**
 * П2.4.1: единый сценарий выгрузки для V1 и V2.
 *
 * Порядок важен: сначала закрываем приём новых запусков, освобождаем
 * регистрации и runtime, затем гасим dashboard и только после ожидания
 * активных in-process операций закрываем SQLite. Ошибка отдельной
 * регистрации не должна мешать закрыть БД, поэтому шаги изолированы.
 */
export interface ShutdownResource {
  dispose: () => void | Promise<void>;
}

export function createShutdownHandler(
  runtime: SchedulerRuntime,
  registrations: ShutdownResource[] = [],
  options: { waitMs?: number } = {},
): () => Promise<void> {
  const waitMs = options.waitMs ?? SHUTDOWN_WAIT_MS;

  return async () => {
    shutdownGate.begin();

    for (const registration of registrations) {
      try {
        await registration.dispose();
      } catch (err) {
        console.warn(
          `[agent-steward] Выгрузка: ошибка освобождения регистрации — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    runtime.dispose();

    // Сначала перестаём принимать новые запросы, затем ждём уже начатые
    // in-process операции, чтобы не закрыть SQLite под активной записью.
    await closeDashboardServer();
    const wait = await shutdownGate.waitForIdle(waitMs);
    if (wait.timedOut) {
      console.warn(
        `[agent-steward] Выгрузка: ${wait.remaining} запуск(ов) не завершились за ${waitMs} мс — закрываем БД.`,
      );
    }
    // Чекпойнт WAL выполняется в closeDb.
    closeDb();
    // QA/PL-10: выгрузка действительно завершена — запрещаем автосброс ворот.
    shutdownGate.complete();
  };
}

/**
 * Декларативное описание инструмента: всё, что нужно любому entrypoint'у,
 * чтобы зарегистрировать его в своей версии API.
 */
/**
 * P-1.1: типы реестра переехали в src/tool-specs.ts. Локальный псевдоним
 * сохраняет читаемость объявлений ниже и публичный контракт dist/index.js.
 */
type ToolSpec = ToolSpecLike;

/**
 * PL-70: единый контракт для всех manage_* инструментов. Агент теряет вызовы,
 * когда guessing действие `get` там, где схема объявляет только `list`.
 * Каждое описание обязано явно называть допустимые действия и read-действие.
 */
export const MANAGE_CONTRACT_HINT =
  " Only listed actions; read via the listed read action (list/get), never guess get when absent — schema rejects unknown actions.";

/**
 * PL-71: OpenCode /help показывает не более 12 инструментов, хотя плагин
 * регистрирует больше. Пометка в описаниях убирает расхождение со справкой.
 */
export const PLUGIN_HELP_VISIBLE_TOOL_LIMIT = 12;
export const PLUGIN_HELP_NOTE =
  ` OpenCode /help displays at most ${PLUGIN_HELP_VISIBLE_TOOL_LIMIT} tool entries; this plugin registers more tools than that — every registered tool stays callable by name.`;

/**
 * Собирает полный список инструментов для конкретного ядра.
 *
 * V2-адаптер (`ctx.tool.transform`) и V1-адаптер (`createV1Tools`) получают
 * одинаковые имена, схемы, описания и обработчики. Аудит навешивается здесь
 * один раз, чтобы обе линии вели журнал одинаково.
 */
export function createToolSpecs(
  runtime: SchedulerRuntime,
  env: NodeJS.ProcessEnv = process.env,
): ToolSpec[] {
  // Объявления инструментов остаются в адаптере: это публичный контракт
  // surfaces для V1/V2 и контрактных тестов. Общие правила (QV-8, профили)
  // применяет buildToolSpecs из src/tool-specs.ts.
  const handlers = createToolHandlers(runtime);
  const specs: ToolSpec[] = [
    {
      name: "schedule_task",
      input: coreScheduleTaskSchema,
      description:
        `Creates a task in the OS scheduler (${scheduler.title}) with a cron schedule and an optional Quality Gate. ` +
        "Every run goes through a timeout + lock-file wrapper, so overlapping runs are skipped. " +
        "For matrix/DAG/retry/window policies use schedule_advanced in the admin profile. " +
        "Without workingDirectory the task runs in the current project folder, where opencode run picks up the project's opencode.json and MCP servers.",
      audit: (args: ScheduleArgs) => ({ action: "task.create", targetType: "task", target: args.name }),
      execute: handlers.schedule_task,
    },
    {
      name: "list_tasks",
      input: listTasksSchema,
      output: listTasksOutputSchema,
      description:
        `Lists plugin tasks from the scheduler (${scheduler.title}) with schedule, status, next chained task and working directory. ` +
        "Matrix parents include a per-clone summary. Returns structured output in Code Mode; content remains a JSON string for V1 compatibility." +
        PLUGIN_HELP_NOTE,
      execute: handlers.list_tasks,
    },
    {
      name: "update_task",
      input: coreUpdateTaskSchema,
      description:
        "Partially updates an existing task: omitted fields keep their current values, empty strings/arrays clear them. " +
        "For matrix/DAG/retry/window changes use update_advanced in the admin profile.",
      audit: (args: UpdateArgs) => ({ action: "task.update", targetType: "task", target: args.name }),
      execute: handlers.update_task,
    },
    {
      name: "schedule_advanced",
      input: scheduleTaskSchema,
      description:
        "Full schedule_task schema for the admin profile: matrix fan-out, DAG dependencies, retry policy, chained tasks, launch windows and all trigger types. Same handler as schedule_task.",
      audit: (args: ScheduleArgs) => ({ action: "task.create.advanced", targetType: "task", target: args.name }),
      execute: handlers.schedule_advanced,
    },
    {
      name: "update_advanced",
      input: updateTaskSchema,
      description:
        "Full update_task schema for the admin profile: matrix, DAG, retry, chained tasks, launch windows and all trigger types. Same handler as update_task.",
      audit: (args: UpdateArgs) => ({ action: "task.update.advanced", targetType: "task", target: args.name }),
      execute: handlers.update_advanced,
    },
    {
      name: "delete_task",
      input: deleteTaskSchema,
      description:
        `Deletes a task from the scheduler (${scheduler.title}) by name. ` +
        "Deleting a matrix parent also deletes its clones and aggregator; deleting a single clone is refused (delete the whole matrix instead).",
      audit: (args: DeleteArgs) => ({ action: "task.delete", targetType: "task", target: args.name }),
      execute: handlers.delete_task,
    },
    {
      name: "run_task_now",
      input: runTaskNowSchema,
      description:
        `Runs a task immediately in the scheduler (${scheduler.title}) for testing. ` +
        "Runs through the timeout + lock wrapper. For a matrix parent this starts the fan-out instead of the parent itself.",
      audit: (args: RunNowArgs) => ({ action: "task.run", targetType: "task", target: args.name }),
      execute: handlers.run_task_now,
    },
    {
      name: "pause_task",
      input: pauseTaskSchema,
      description:
        "Pauses a task in the OS scheduler. For a matrix parent every clone is paused (the parent itself never runs).",
      audit: (args: PauseArgs) => ({ action: "task.pause", targetType: "task", target: args.name }),
      execute: handlers.pause_task,
    },
    {
      name: "resume_task",
      input: resumeTaskSchema,
      description:
        "Resumes a previously paused task. For a matrix parent every clone is resumed.",
      audit: (args: ResumeArgs) => ({ action: "task.resume", targetType: "task", target: args.name }),
      execute: handlers.resume_task,
    },
    {
      name: "get_history",
      input: getHistorySchema,
      description:
        "Returns recent run history (status, duration, tokens, cost, model, Quality Gate and pre/post-flight results). " +
        "Filter by taskName and/or status; newest first.",
      execute: handlers.get_history,
    },
    {
      name: "get_task_logs",
      input: getTaskLogsSchema,
      description:
        "Returns the tail of a task's log file written by the run wrapper. Use it to diagnose failed runs.",
      execute: handlers.get_task_logs,
    },
    {
      name: "dry_run",
      input: dryRunSchema,
      description:
        "Simulates a task pipeline (or every task when name is omitted): execution order, DAG dependencies, matrix fan-out, estimated duration/cost and warnings. Nothing is executed.",
      execute: handlers.dry_run,
    },
    {
      name: "manage_workspaces",
      input: manageWorkspacesSchema,
      description:
        "Multi-repo workspaces. Actions: list (read), add, update, delete; no get — use list. " +
        "Tasks target a workspace by id (cwd) or fan out via matrix.workspaceIds." +
        MANAGE_CONTRACT_HINT,
      audit: (args: WorkspacesArgs) =>
        args.action === "list"
          ? null
          : {
            action: `workspace.${args.action}`,
            targetType: "workspace",
            target: args.id || args.name || "",
          },
      execute: handlers.manage_workspaces,
    },
    {
      name: "matrix_control",
      input: matrixControlSchema,
      description:
        "Matrix lifecycle: results (aggregate status/counters of a matrix), cancel (cancel pending clones, stop running ones), cleanup (delete orphaned clones and aggregators whose parent is gone) or preview (expand a matrix config into clone names without creating anything).",
      audit: (args: MatrixControlArgs) =>
        args.action === "cancel" || args.action === "cleanup"
          ? {
            action: `matrix.${args.action}`,
            targetType: "matrix",
            target: args.name || "",
          }
          : null,
      execute: handlers.matrix_control,
    },
    {
      name: "get_metrics",
      input: getMetricsSchema,
      description:
        "Returns aggregate run metrics: total runs, successes and failures across all tasks.",
      execute: handlers.get_metrics,
    },
    {
      name: "get_analytics",
      input: getAnalyticsSchema,
      description:
        "Returns an analytics report for a period: run counts, success rate, duration, tokens and cost, plus top tasks.",
      execute: handlers.get_analytics,
    },
    {
      name: "self_analysis",
      input: selfAnalysisSchema,
      description:
        "Generates a self-analysis report: system health score, anomaly detection, trend analysis and optimization recommendations. " +
        "Helps identify performance issues, cost spikes and reliability problems. " +
        "In health.components, successRate and errorRate are normalized 0..100 scores (higher is better): " +
        "errorRate = 100 - 100 * error / total, so it is NOT the raw error percentage.",
      execute: handlers.self_analysis,
    },
    {
      name: "manage_settings",
      input: manageSettingsSchema,
      description:
        "Global scheduler settings. Actions: get (read), list (alias of get), update; no delete. " +
        "Fields: maxConcurrent, winterMode, notifications, history retention; updates merge into current settings." +
        MANAGE_CONTRACT_HINT,
      audit: (args: SettingsArgs) =>
        args.action === "update"
          ? { action: "settings.update", targetType: "settings", target: "global" }
          : null,
      execute: handlers.manage_settings,
    },
    {
      name: "manage_local_ai",
      input: manageLocalAiSchema,
      description:
        "Local assistant for notification triage. Actions: get (read), update, test; no list or delete. " +
        "Fields: mode (off/rules/llm/auto), baseUrl, model, timeout, fallback, confidence, shadow. " +
        "test sends a synthetic notification (latency/verdict, nothing saved); without a model the scheduler still triages by rules." +
        MANAGE_CONTRACT_HINT,
      audit: (args: LocalAiArgs) =>
        args.action === "update"
          ? { action: "localAi.update", targetType: "settings", target: "triage" }
          : null,
      execute: handlers.manage_local_ai,
    },
    {
      name: "manage_templates",
      input: manageTemplatesSchema,
      description:
        "Reusable task templates. Actions: list (read), save, delete; no get — use list. " +
        "Templates store prompt, schedule and task options." +
        MANAGE_CONTRACT_HINT,
      audit: (args: TemplatesArgs) =>
        args.action === "list"
          ? null
          : {
            action: `template.${args.action}`,
            targetType: "template",
            target: args.id || args.name || "",
          },
      execute: handlers.manage_templates,
    },
    {
      name: "manage_profiles",
      input: manageProfilesSchema,
      description:
        "Isolated scheduler profiles. Actions: list (read), create, switch, delete; no get — use list. " +
        "Each has its own DB, settings and port; switching needs an OpenCode restart." +
        MANAGE_CONTRACT_HINT,
      audit: (args: ProfilesArgs) =>
        args.action === "list"
          ? null
          : {
            action: `profile.${args.action}`,
            targetType: "profile",
            target: args.name || "",
          },
      execute: handlers.manage_profiles,
    },
    {
      name: "transfer_tasks",
      input: transferTasksSchema,
      description:
        "Exports all tasks as a portable JSON snapshot or imports tasks from such a snapshot, recreating them in the OS scheduler.",
      audit: (args: TransferArgs) =>
        args.action === "import"
          ? { action: "tasks.import", targetType: "tasks", target: "snapshot" }
          : null,
      execute: handlers.transfer_tasks,
    },
    {
      name: "send_notification",
      input: sendNotificationSchema,
      description:
        "Sends a test notification through the configured channel or sends the digest immediately.",
      execute: handlers.send_notification,
    },
    {
      name: "report_bug",
      input: reportBugSchema,
      description:
        "Sends a bug report from the plugin user to the developer via configured notification channels (Telegram/webhook/native). Includes optional task logs and recent analytics.",
      execute: handlers.report_bug,
    },
    {
      name: "get_dashboard_info",
      input: getDashboardInfoSchema,
      description:
        "Returns dashboard port and URL, OS platform, scheduler title and the active profile." +
        PLUGIN_HELP_NOTE,
      execute: handlers.get_dashboard_info,
    },
    {
      name: "cleanup_history",
      input: cleanupHistorySchema,
      description:
        "Deletes old run history by age and/or record cap, using the stored retention policy unless overridden.",
      audit: () => ({ action: "history.cleanup", targetType: "history", target: "runs" }),
      execute: handlers.cleanup_history,
    },
    {
      name: "manage_secrets",
      input: manageSecretsSchema,
      description:
        "Encrypted secret store. Actions: list (read — names and masked previews), set (create or replace), delete; no get — use list. " +
        "AES-256-GCM at rest, referenced from workspace env as ${secret:NAME}; " +
        "values never returned by list and redacted from logs/audit." +
        MANAGE_CONTRACT_HINT,
      audit: (args: SecretsArgs) =>
        args.action === "list"
          ? null
          : {
            action: `secret.${args.action}`,
            targetType: "secret",
            target: (args.name ?? "").trim(),
          },
      execute: handlers.manage_secrets,
    },
    {
      name: "get_audit_log",
      input: getAuditLogSchema,
      description:
        "Returns the audit journal of task and settings mutations: who changed what, when and through which interface (mcp, gui, http). " +
        "Filter by action, target, actor, time range and limit. Secret values are redacted.",
      execute: handlers.get_audit_log,
    },
    {
      name: "pipeline_validate",
      input: pipelineValidateSchema,
      description:
        "Проверяет opencode.pipeline.yaml (путь к файлу или исходник): валидирует version, шаги, зависимости, циклы, cron-расписание, matrix, модель, окна запуска и другие инварианты конвейера. Не применяет изменения.",
      execute: handlers.pipeline_validate,
    },
    {
      name: "pipeline_apply",
      input: pipelineApplySchema,
      description:
        "Применяет opencode.pipeline.yaml к текущему набору задач: создаёт новые, обновляет изменённые, пропускает без изменений (идемпотентно). Задачи без маркера pipelineName не трогаются. В режиме dryRun только отчитывает diff.",
      audit: (args: PipelineApplyArgs) => ({
        action: "pipeline.apply",
        targetType: "pipeline",
        target: args.source ?? args.path ?? "",
      }),
      execute: handlers.pipeline_apply,
    },
    {
      name: "pipeline_export",
      input: pipelineExportSchema,
      description:
        "Выгружает задачи указанного конвейера (pipelineName) как opencode.pipeline.yaml: шаги, зависимости, matrix, кастомные настройки шага.",
      execute: handlers.pipeline_export,
    },
    {
      name: "emit_event",
      input: emitEventSchema,
      description:
        "Emits an MCP event: every task with triggerType 'mcp-event' matching the event name (and filter) is started in priority order.",
      execute: handlers.emit_event,
    },
  ];
  // T-1/T-3: фильтрация по профилю и запрет инструментов в дочернем прогоне
  // применяются общим построителем из src/tool-specs.ts.
  return buildToolSpecs(runtime, env, specs);
}

/**
 * Запускает локальный веб-дашборд. Общий шаг для V2-setup и V1-server:
 * повторный вызов безопасен, защита от второго сервера внутри startDashboardServer.
 */
async function startSchedulerDashboard(): Promise<void> {
  const dashboard = await startDashboardServer({
    getTasks: async () => (await collectTasksView()).tasks,
    runTask: (name) => runTaskEntry(name),
    deleteTask: async (name) => {
      await deleteTaskWithFamily(name);
    },
    cancelMatrix: (name) => cancelMatrixRun(name),
    cleanupMatrixOrphans: () => cleanupOrphanedMatrixTasks(),
  });
  if (dashboard) {
    console.log(
      `[agent-steward] Открыть дашборд в браузере: http://localhost:${dashboard.port}`,
    );
  }
}

const v2Plugin = Plugin.define({
  id: "opencode-windows-scheduler",
  setup: async (ctx) => {
    if (isChildRunMode()) {
      console.log(`[qv8] ${CHILD_RUN_ENV}: дочерний прогон, пропускаю регистрацию плагина`);
      return async () => undefined;
    }
    // PL-45: hot-reload/Code Mode может заново вызвать setup после того, как
    // хост закрыл и «завершил» ворота, не выгрузив модуль. Открываем их,
    // иначе все in-process запуски навсегда получают PLUGIN_SHUTTING_DOWN.
    shutdownGate.reset();
    const runtime = await createRuntime(ctx);
    const registration = await ctx.tool.transform((editor) => {
      // editor.add регистрирует новые инструменты плагина с codemode: true,
      // чтобы они были видны в Code Mode. Встроенные schedule_* отключены
      // через "experimental": { "schedules": false } в opencode.jsonc.
      for (const spec of createToolSpecs(runtime)) {
        // Аудит навешивается здесь, чтобы V1 и V2 писали журнал одинаково.
        const execute = spec.audit
          ? withAudit(spec.name, spec.audit, spec.execute)
          : spec.execute;
        editor.add({
          name: spec.name,
          input: spec.input,
          output: spec.output,
          description: spec.description,
          options: { codemode: true },
          execute,
        });
      }
    });

    // Нативный скилл плагина: агент видит краткое описание в списке доступных
    // скиллов и подгружает инструкцию только когда задача действительно про
    // автоматизацию по расписанию. Файлы скилла лежат в пакете (`skills/...`),
    // поэтому ручная установка в `.opencode/skills` не нужна.
    let skillRegistration: { dispose: () => Promise<void> } | undefined;
    try {
      const skill = loadSchedulerSkill();
      if (skill && ctx.skill?.transform) {
        skillRegistration = await ctx.skill.transform((editor) => {
          // QA-A2.1: V2 skill API ожидает Effect-брендированные строки
          // (Skill.ID / Skill.Name / AbsolutePath). Значения приходят из
          // собственного skill.ts, бренд живёт только на уровне типов —
          // приведение на границе внешнего API не меняет поведение.
          editor.add({
            id: skill.id as Skill.Info["id"],
            name: skill.name as Skill.Info["name"],
            description: skill.description,
            path: skill.path as Skill.Info["path"],
            content: skill.content,
          });
        });
      }
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось зарегистрировать скилл "${SCHEDULER_SKILL_ID}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Регистрируем RPC-методы, вызываемые из GUI-панели.
    // Общая логика создания задачи вынесена в schedulerCreateTask, чтобы
    // schedule_task и create_task использовали один и тот же путь.
    const rpcHandlers = {
      get_tasks: async () => {
        const view = await collectTasksView();
        return {
          tasks: view.tasks,
          osAvailable: view.osAvailable,
          ...(view.osError ? { osError: view.osError } : {}),
        };
      },
      create_task: async (input: unknown) => {
        // QW-14.2: раньше здесь логировался весь input с промптом — убираем,
        // чтобы секреты и содержимое задач не попадали в stdout.
        // QA-P2.1: RPC обходит MCP/Zod — проверяем диапазоны явно.
        const rangeError = validateTaskInputRanges(input as {
          prompt?: string;
          timeoutSeconds?: number;
          priority?: number;
          retryCount?: number;
          retryDelay?: number;
          watchPath?: string;
          triggerType?: string;
          watchGlobs?: string[];
          watchIgnore?: string[];
          gitPaths?: string[];
          gitIgnore?: string[];
        });
        if (rangeError) {
          return { success: false, message: rangeError };
        }
        const {
          name,
          schedule,
          prompt,
          retryCount,
          retryDelay,
          qualityGate,
          nextTaskOnSuccess,
          nextTaskOnError,
          dependsOn,
          triggerType,
          watchPath,
          workingDirectory,
          model,
          priority,
          beforeScript,
          afterScript,
          mcpEvent,
          workspaceId,
          allowedTools,
          deniedTools,
          matrix,
          timezone,
          notBefore,
          notAfter,
          runAt,
          delaySeconds,
          session,
          sessionMaxRuns,
          runWhenLoggedOff,
          legacyShell,
          worktree,
          guards,
          tokenBudget,
        } = input as {
          name: string;
          schedule?: string;
          prompt: string;
          retryCount?: number;
          retryDelay?: number;
          qualityGate?: string;
          nextTaskOnSuccess?: string;
          nextTaskOnError?: string;
          dependsOn?: string[];
          triggerType?: "cron" | "file" | "git" | "mcp-event" | "once";
          watchPath?: string;
          workingDirectory?: string;
          model?: string;
          priority?: number;
          beforeScript?: string;
          afterScript?: string;
          mcpEvent?: McpEventInput;
          workspaceId?: string;
          allowedTools?: string[];
          deniedTools?: string[];
          matrix?: MatrixConfig;
          timezone?: string;
          notBefore?: string;
          notAfter?: string;
          runAt?: string;
          delaySeconds?: number;
          session?: "new" | "reuse" | "last";
          sessionMaxRuns?: number;
          runWhenLoggedOff?: boolean;
          legacyShell?: boolean;
          worktree?: boolean;
          guards?: TaskGuards;
          tokenBudget?: number;
        };
        let effectiveRunAt: string | undefined;
        if (triggerType === "once") {
          const normalized = normalizeOneShotRunAt({ runAt, delaySeconds });
          if (!normalized.ok) {
            return { success: false, message: t("tool.error.taskReason", { name, error: normalized.error }) };
          }
          effectiveRunAt = normalized.runAt;
        }
        let effectiveSession: "new" | "reuse" | "last" = "new";
        if (session !== undefined) {
          const normalizedSession = normalizeSessionMode(session);
          if (!normalizedSession) {
            return { success: false, message: t("tool.error.sessionUnknown", { name, session: String(session) }) };
          }
          effectiveSession = normalizedSession;
        }
        if (
          sessionMaxRuns !== undefined &&
          (!Number.isInteger(sessionMaxRuns) || sessionMaxRuns < 0)
        ) {
          return { success: false, message: t("tool.error.sessionMaxRuns", { name }) };
        }
        const effectiveSessionId =
          effectiveSession === "reuse" ? generateSessionId() : undefined;
        try {
          await schedulerCreateTask(
            name,
            schedule ?? "",
            prompt,
            undefined,
            workingDirectory,
            retryCount,
            retryDelay,
            qualityGate,
            nextTaskOnSuccess,
            nextTaskOnError,
            triggerType,
            watchPath,
            dependsOn,
            model,
            priority,
            beforeScript,
            afterScript,
            mcpEvent,
            workspaceId,
            allowedTools,
            deniedTools,
            matrix,
            undefined,
            "create",
            timezone,
            notBefore,
            notAfter,
            undefined,
            effectiveRunAt,
            effectiveSession,
            effectiveSessionId,
            sessionMaxRuns,
            undefined,
            runWhenLoggedOff === true,
            undefined,
            legacyShell === true,
            worktree === true,
            guards,
            // QA-P0.1 (E-2.1): создание через дашборд/RPC сохраняет tokenBudget.
            tokenBudget,
          );
          const nextRun = computeTaskNextRun({
            schedule: schedule ?? "",
            triggerType: triggerType ?? "cron",
            runAt: effectiveRunAt,
            timezone,
            notBefore,
            notAfter,
          });
          return {
            success: true,
            paused: false,
            nextRun,
            message: t("tool.task.created", { name }),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { success: false, message };
        }
      },
      delete_task: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const { removed } = await deleteTaskWithFamily(name);
          return {
            success: true,
            message:
              removed.length > 0
                ? t("tool.task.matrixDeletedCount", {
                  name,
                  count: removed.length,
                })
                : t("tool.task.deleted", { name }),
          };
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      cancel_matrix: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const result = await cancelMatrixRun(name);
          return {
            success: true,
            message: result.message,
            cancelled: result.cancelled,
          };
        } catch (err) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
            cancelled: [],
          };
        }
      },
      cleanup_matrix_orphans: async () => {
        try {
          const removed = await cleanupOrphanedMatrixTasks();
          return {
            success: true,
            message:
              removed.length > 0
                ? t("tool.matrix.orphansRemoved", { count: removed.length })
                : t("tool.matrix.orphansNone"),
            removed,
          };
        } catch (err) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
            removed: [],
          };
        }
      },
      run_task: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          // B-1.1: один общий гейт (глобальный бюджет + tokenBudget задачи),
          // тот же самый, что проверяет registered-путь ОС-планировщика.
          const definition = (await loadTaskDefinitions()).find(
            (def) => def.name.toLowerCase() === name.trim().toLowerCase(),
          );
          const budgetGate = await checkRunBudgetGate(name, definition?.tokenBudget);
          if (!budgetGate.allowed) {
            return {
              success: false,
              message: budgetGate.message,
            };
          }
          // Matrix-родитель не выполняется сам: запускаем его клоны (fan-out).
          if (definition?.matrix) {
            const matrixResult = await runMatrix(definition);
            const total = definition.matrix.workspaceIds.length;
            const message =
              t("tool.matrix.started", {
                name,
                started: matrixResult.started.length,
                total,
              }) +
              (matrixResult.skipped.length
                ? t("tool.matrix.startedSkipped", {
                  count: matrixResult.skipped.length,
                })
                : "") +
              (matrixResult.errors.length
                ? t("tool.matrix.startedErrors", {
                  errors: matrixResult.errors.join("; "),
                })
                : ".");
            return { success: matrixResult.success, message };
          }
          // Контроль параллелизма: не позволяем запускать новую задачу,
          // если уже running столько же (или больше), сколько maxConcurrent.
          const settings = await loadSettings();
          if (settings.maxConcurrent > 0) {
            const allTasks = await scheduler.listTasks();
            const runningCount = allTasks.filter((t) =>
              /running|выполняется/i.test(t.status ?? ""),
            ).length;
            if (runningCount >= settings.maxConcurrent) {
              return {
                success: false,
                message:
                  t("tool.matrix.limit"),
              };
            }
          }

          const result = await scheduler.runTask(name);
          // История и метрики пишутся PowerShell-обёрткой (ps-wrapper.ts) при любом запуске,
          // в том числе инициированном из GUI, — дублировать запись здесь не нужно.
          if (result.alreadyRunning) {
            // Мягкое предупреждение: задача уже идёт, это не ошибка запуска.
            return { success: true, message: t("tool.task.alreadyRunning", { name }) };
          }
          return { success: true, message: t("tool.task.started", { name }) };
        } catch (err) {
          return { success: false, message: `schtasks error: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
      run_mission: async (input: unknown) => {
        try {
          const budgetGate = await checkBudgetGate();
          if (!budgetGate.allowed) {
            return {
              success: false,
              dryRun: false,
              runId: "",
              status: "failed",
              description: "",
              error: formatBudgetSkipMessage(budgetGate),
              steps: [],
            };
          }
          const mission = await runMission(input as MissionSpec);
          return {
            success: mission.success,
            dryRun: mission.dryRun,
            runId: mission.runId ?? "",
            status: mission.status,
            description: mission.description,
            ...(mission.error ? { error: mission.error } : {}),
            steps: mission.steps.map((step) => ({
              stepName: step.stepName,
              taskType: step.taskType,
              target: step.target,
              status: step.status,
              attempt: step.attempt,
              ...(step.error ? { error: step.error } : {}),
            })),
          };
        } catch (err) {
          return {
            success: false,
            dryRun: false,
            runId: "",
            status: "failed",
            description: "",
            error: err instanceof Error ? err.message : String(err),
            steps: [],
          };
        }
      },
      emit_event: async (input: unknown) => {
        const { eventName, payload, server } = input as {
          eventName?: string;
          payload?: unknown;
          server?: string;
        };
        return await emitEventCore(eventName, payload, server);
      },
      pause_task: async (input: unknown) => {
        const { name, until } = input as { name: string; until?: string };
        const result = await pauseOrResumeTask(name, true, until);
        return result;
      },
      resume_task: async (input: unknown) => {
        const { name } = input as { name: string };
        const result = await pauseOrResumeTask(name, false);
        return result;
      },
      update_task: async (input: unknown) => {
        return await updateTaskFromInput(input as UpdateArgs);
      },
      get_task_logs: async (input: unknown) => {
        const { name, taskName } = input as { name?: string; taskName?: string };
        const resolved = name?.trim() || taskName?.trim();
        if (!resolved) {
          return { success: false, logs: "", error: "Укажите name или taskName задачи" };
        }
        const result = await getTaskLogs(resolved);
        if (result.error) {
          return { success: false, logs: "", error: result.error };
        }
        return { success: true, logs: result.logs };
      },
      get_history: async (input: unknown) => {
        // Контракт совпадает с агентским инструментом get_history:
        // limit по умолчанию 20 (максимум 200), фильтры taskName и status.
        const { limit, taskName, status } = input as {
          limit?: number;
          taskName?: string;
          status?: string;
        };
        const filter = taskName?.trim().toLowerCase();
        const statusFilter = status?.trim().toLowerCase();
        const max = Math.max(1, Math.min(Math.floor(limit ?? 20), 200));
        const records = await loadHistory(filter, max, statusFilter);
        return { records };
      },
      get_metrics: async () => {
        const metrics = await loadMetrics();
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
        const toolBlocked = readAuditLog({ action: "tool.blocked", since, limit: 1 }).total;
        return withTokenEfficiency({ ...metrics, toolBlocked });
      },
      cleanup_history: async (input: unknown) => {
        const { retentionDays, maxRecords } = input as {
          retentionDays?: number;
          maxRecords?: number;
        };
        try {
          const report = await runHistoryRetention({ retentionDays, maxRecords });
          const message = report.skipped
            ? report.skipped
            : t("tool.history.cleaned", {
              deleted: report.deleted,
              byAge: report.deletedByAge,
              byCount: report.deletedByCount,
              kept: report.kept,
            });
          return {
            success: true,
            message,
            deleted: report.deleted,
            deletedByAge: report.deletedByAge,
            deletedByCount: report.deletedByCount,
            kept: report.kept,
            retentionDays: report.retentionDays,
            maxRecords: report.maxRecords,
            vacuumed: report.vacuumed,
          };
        } catch (err) {
          return {
            success: false,
            message: t("tool.history.cleanFailed", {
              error: err instanceof Error ? err.message : String(err),
            }),
            deleted: 0,
            deletedByAge: 0,
            deletedByCount: 0,
            kept: 0,
            retentionDays: 0,
            maxRecords: 0,
            vacuumed: false,
          };
        }
      },
      get_analytics: async (input: unknown) => {
        const { days, topLimit } = input as { days?: number; topLimit?: number };
        try {
          const windowDays = Math.min(
            365,
            Math.max(1, Math.floor(Number(days) || 14)),
          );
          const records = getHistoryForAnalytics(windowDays);
          const definitions = await loadTaskDefinitions();
          const report = buildAnalytics(records, {
            days: windowDays,
            topLimit: Math.max(1, Math.floor(Number(topLimit) || 10)),
            tasks: definitions.filter((d) => !d.name.startsWith("__")).map((definition) => ({
              name: definition.name,
              matrixParentId: definition.matrixParentId,
              tokenBudget: definition.tokenBudget,
            })),
          });
          // Экономика v2 (E-1.1): тот же учёт, что и в агент-инструменте.
          const settings = await loadSettings();
          const budgets = buildBudgetReport(records, settings.budgets, new Date());
          // PL-4.1: та же метрика корректности прав, что и в MCP get_analytics.
          const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
          const toolBlocked = readAuditLog({ action: "tool.blocked", since, limit: 1 }).total;
          return { success: true, report: { ...report, budgets, toolBlocked } };
        } catch (err) {
          return {
            success: false,
            report: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      self_analysis: async (input: unknown) => {
        const { days, topLimit, includeAnomalies, includeTrends, includeRecommendations } = input as {
          days?: number;
          topLimit?: number;
          includeAnomalies?: boolean;
          includeTrends?: boolean;
          includeRecommendations?: boolean;
        };
        try {
          const windowDays = Math.min(
            365,
            Math.max(1, Math.floor(Number(days) || 14)),
          );
          const records = getHistoryForAnalytics(windowDays);
          const definitions = await loadTaskDefinitions();
          const report = generateSelfAnalysisReport(records, {
            days: windowDays,
            topLimit: Math.max(1, Math.floor(Number(topLimit) || 10)),
            tasks: definitions.filter((d) => !d.name.startsWith("__")).map((definition) => ({
              name: definition.name,
              matrixParentId: definition.matrixParentId,
              tokenBudget: definition.tokenBudget,
            })),
          });

          // Фильтруем секции если нужно
          const result: Partial<typeof report> = {
            generatedAt: report.generatedAt,
            windowDays: report.windowDays,
            health: report.health,
            summary: report.summary,
            sources: report.sources,
            // PL-98: свежая проверка цепочки по RPC-пути самоанализа.
            gateLedger: verifyGateLedgerIntegrity("self-analysis:rpc"),
          };

          if (includeAnomalies !== false) {
            result.anomalies = report.anomalies;
          }
          if (includeTrends !== false) {
            result.trends = report.trends;
          }
          if (includeRecommendations !== false) {
            result.recommendations = report.recommendations;
          }

          return { success: true, report: result };
        } catch (err) {
          return {
            success: false,
            report: null,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      report_bug: async (input: unknown) => {
        const {
          description,
          taskName,
          includeLogs,
          includeAnalytics,
          channel,
          destination,
          contactEmail,
          dryRun,
        } = input as {
          description?: string;
          taskName?: string;
          includeLogs?: boolean;
          includeAnalytics?: boolean;
          channel?: "all" | "webhook" | "telegram" | "native";
          destination?: "author" | "local" | "both";
          contactEmail?: string;
          dryRun?: boolean;
        };
        try {
          if (!description?.trim()) {
            return { success: false, error: "description is required" };
          }
          const settings = await loadSettings();
          const logsAllowed = includeLogs ?? settings.feedback.includeLogs;
          const built = await buildBugReportText({
            description,
            taskName,
            includeLogs: logsAllowed,
            includeAnalytics,
          });
          const secretValues = collectSecretValues();
          const localText = redactText(built.text, {
            secrets: secretValues,
            redactEmails: false,
          });
          const result = await reportFeedback({
            settings: settings.feedback,
            destination: destination ?? "author",
            dryRun,
            description,
            taskName,
            contactEmail: contactEmail ?? settings.feedback.contactEmail,
            redactedLogs: logsAllowed ? built.logs : undefined,
            metrics: built.metrics,
            locale: settings.locale,
            secrets: secretValues,
            sendLocal: (text) => sendBugReport(text, channel),
            localText,
          });
          return {
            success: result.success,
            reportId: result.reportId,
            mode: result.mode,
            preview: result.preview,
            error: result.error,
            author: result.author,
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      get_dashboard_port: async () => {
        return { port: getDashboardPort() };
      },
      get_platform: async () => {
        return { platform: scheduler.platform, title: scheduler.title };
      },
      dry_run: async (input: unknown) => {
        const { taskName } = input as { taskName: string };
        try {
          const report = await simulatePipeline(taskName);
          return { ...report };
        } catch (err) {
          return {
            success: false,
            taskName,
            tasks: [],
            totals: { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null },
            warnings: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      dry_run_all: async () => {
        const tasks = await loadTaskDefinitions();
        const reports: (DryRunReport & { error?: string })[] = [];
        let allSuccess = true;
        for (const task of tasks) {
          try {
            reports.push(await simulatePipeline(task.name));
          } catch (err) {
            allSuccess = false;
            reports.push({
              success: false,
              taskName: task.name,
              tasks: [],
              totals: { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null },
              warnings: [],
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return { success: allSuccess, reports };
      },
      pipeline_validate: async (input: unknown) => {
        const { path, source, dryRun } = input as {
          path?: string;
          source?: string;
          dryRun?: boolean;
        };
        const result = await pipelineValidateExecute({ path, source, dryRun } as PipelineValidateArgs, {});
        const parsed: unknown = JSON.parse(result.content as string);
        return parsed;
      },
      pipeline_apply: async (input: unknown) => {
        const { path, source, dryRun } = input as {
          path?: string;
          source?: string;
          dryRun?: boolean;
        };
        const result = await pipelineApplyExecute({ path, source, dryRun } as PipelineApplyArgs, {});
        const parsed: unknown = JSON.parse(result.content as string);
        return parsed;
      },
      pipeline_export: async (input: unknown) => {
        const { pipeline, pipelineName } = input as { pipeline?: string; pipelineName?: string };
        const result = await pipelineExportExecute(
          { pipeline: pipeline ?? pipelineName },
          {},
        );
        const parsed: unknown = JSON.parse(result.content as string);
        return parsed;
      },
      get_matrix_results: async (input: unknown) => {
        const { parentId } = input as { parentId?: string; name?: string };
        const target = (parentId ?? "").trim();
        if (!target) {
          return { success: false, error: t("tool.matrix.parentMissing") };
        }
        try {
          const report = aggregateMatrixResults(target);
          return { success: true, report };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      expand_matrix_preview: async (input: unknown) => {
        const { name, workspaceIds, strategy, failureMode, aggregation } = input as {
          name?: string;
          workspaceIds?: string[];
          strategy?: "parallel" | "sequential";
          failureMode?: "continue" | "stop";
          aggregation?: "summary" | "per-task";
        };
        try {
          const clones = expandMatrixTask({
            name: (name ?? "").trim() || "task",
            schedule: "* * * * *",
            prompt: "preview",
            matrix: {
              workspaceIds: Array.isArray(workspaceIds) ? workspaceIds : [],
              strategy,
              failureMode,
              aggregation,
            },
          });
          return {
            success: true,
            clones: clones.map((clone) => ({
              name: clone.name,
              workspaceId: clone.workspaceId ?? "",
              workspaceName: clone.workspaceId
                ? getWorkspace(clone.workspaceId)?.name ?? null
                : null,
            })),
          };
        } catch (err) {
          return {
            success: false,
            clones: [],
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      get_workspaces: async () => {
        return {
          workspaces: listWorkspaces().map((workspace) => ({
            ...workspace,
            env: maskEnvForLog(workspace.env),
            gitBranch: readGitBranch(workspace.path) ?? null,
          })),
        };
      },
      add_workspace: async (input: unknown) => {
        try {
          const { name, path: workspacePath, color, env, envFile } = input as {
            name?: string;
            path: string;
            color?: string;
            env?: Record<string, string> | null;
            envFile?: string | null;
          };
          const workspace = addWorkspace({ name, path: workspacePath, color, env, envFile });
          return {
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      update_workspace: async (input: unknown) => {
        try {
          const { id, name, path: workspacePath, color, env, envFile } = input as {
            id: string;
            name?: string;
            path?: string;
            color?: string;
            env?: Record<string, string> | null;
            envFile?: string | null;
          };
          const workspace = updateWorkspace(id, { name, path: workspacePath, color, env, envFile });
          if (!workspace) {
            return { success: false, error: t("tool.workspace.notFound") };
          }
          // env-файлы существующих задач перегенерируются сразу (Спринт 21).
          await refreshWorkspaceEnvFiles(workspace.id);
          return {
            success: true,
            workspace: {
              ...workspace,
              env: maskEnvForLog(workspace.env),
              gitBranch: readGitBranch(workspace.path) ?? null,
            },
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      delete_workspace: async (input: unknown) => {
        try {
          const { id } = input as { id: string };
          const deleted = deleteWorkspace(id);
          return {
            success: deleted,
            message: deleted
              ? t("tool.workspace.deleted")
              : t("tool.workspace.notFound"),
          };
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      get_profiles: async () => {
        return {
          current: getProfileName(),
          pinnedByEnv: isProfilePinnedByEnv(),
          profiles: listProfiles(),
        };
      },
      set_profile: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          setActiveProfile(name);
          const current = getProfileName();
          return {
            success: true,
            current,
            restartRequired: true,
            message: isProfilePinnedByEnv()
              ? t("tool.profile.envVarLong", { name: current })
              : t("tool.profile.active", { name: sanitizeProfileName(name) }),
          };
        } catch (err) {
          return {
            success: false,
            current: getProfileName(),
            restartRequired: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
      create_profile: async (input: unknown) => {
        const { name, port } = input as { name: string; port?: number };
        try {
          const meta = createProfile(name, port);
          const profile = listProfiles().find((item) => item.name === meta.name);
          return {
            success: true,
            message: t("tool.profile.created", { name: meta.name, port: meta.port }),
            profile: profile ?? {
              name: meta.name,
              dir: getProfileDir(meta.name),
              port: meta.port,
              isDefault: meta.name === DEFAULT_PROFILE,
              active: meta.name === getProfileName(),
            },
          };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      delete_profile: async (input: unknown) => {
        const { name } = input as { name: string };
        try {
          const removed = await deleteProfile(name);
          return {
            success: removed,
            message: removed
              ? t("tool.profile.deleted", { name: sanitizeProfileName(name) })
              : t("tool.profile.notFound"),
          };
        } catch (err) {
          return { success: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
      get_settings: async () => {
        return await loadSettings();
      },
      save_settings: async (input: unknown) => {
        const { maxConcurrent, locale, uiLocale, winterMode, notifications, history, integrations, audit, permissions, budgets, feedback } = input as {
          maxConcurrent?: number;
          locale?: LocaleMode;
          uiLocale?: Locale;
          winterMode?: boolean;
          notifications?: NotificationSettings;
          history?: HistorySettings;
          integrations?: IntegrationSettings;
          audit?: AuditSettings;
          permissions?: PermissionSettings;
          budgets?: BudgetSettings;
          feedback?: FeedbackSettings;
        };
        const current = await loadSettings();
        if (
          maxConcurrent === undefined &&
          locale === undefined &&
          uiLocale === undefined &&
          winterMode === undefined &&
          notifications === undefined &&
          history === undefined &&
          integrations === undefined &&
          audit === undefined &&
          permissions === undefined &&
          budgets === undefined &&
          feedback === undefined
        ) {
          return {
            success: false,
            maxConcurrent: current.maxConcurrent,
            locale: current.locale,
            uiLocale: current.uiLocale,
            winterMode: current.winterMode,
            notifications: current.notifications,
            history: current.history,
            integrations: current.integrations,
            audit: current.audit,
            permissions: current.permissions,
            budgets: current.budgets,
            feedback: current.feedback,
          };
        }
        const settings = await saveSettings({
          maxConcurrent,
          locale,
          uiLocale,
          winterMode,
          notifications,
          history,
          integrations,
          audit,
          permissions,
          budgets,
          feedback,
        });
        // Локаль процесса меняется сразу — перезапуск не нужен.
        setLocale(resolveLocale(settings.locale, settings.uiLocale));
        return {
          success: true,
          maxConcurrent: settings.maxConcurrent,
          locale: settings.locale,
          uiLocale: settings.uiLocale,
          winterMode: settings.winterMode,
          notifications: settings.notifications,
          history: settings.history,
          integrations: settings.integrations,
          audit: settings.audit,
          permissions: settings.permissions,
          budgets: settings.budgets,
          feedback: settings.feedback,
        };
      },
      test_notification: async () => {
        return await sendTestNotification();
      },
      send_digest: async () => {
        // Ручная отправка не сдвигает плановое расписание дайджеста.
        return await sendDigestNow({ updateLastSentAt: false });
      },

      // --- Спринт 30.6: shadow-режим триажа ---------------------------------
      get_shadow_report: async () => {
        const settings = await loadSettings();
        const shadow = shadowReport(settings.notifications.triage?.shadow);
        return {
          success: true,
          active: shadow.active,
          startedAt: shadow.startedAt,
          days: shadow.days,
          total: shadow.total,
          skips: shadow.skips,
          wouldSuppress: shadow.wouldSuppress,
          bySource: shadow.bySource,
          // 31.8: persistent decisions from audit_log (action = triage.decision).
          persisted: true,
          truncated: shadow.truncated,
          decisions: shadow.decisions.slice(0, 50),
        };
      },
      reset_shadow_report: async () => {
        resetShadowDecisions();
        return { success: true };
      },
      test_local_ai: async (input: unknown) => {
        // Проверка связи: патч применяется только в памяти, конфиг не меняется.
        const patch = (input ?? {}) as LocalAiPatch;
        return await runLocalAiTest({
          mode: patch.mode,
          baseUrl: patch.baseUrl,
          model: patch.model,
          timeoutMs: patch.timeoutMs,
          fallback: patch.fallback,
          confidenceThreshold: patch.confidenceThreshold,
        });
      },

      // --- Спринт 31.5: сравнение триажа «до/после» --------------------------
      compare_triage: async (input: unknown) => {
        const args = (input ?? {}) as {
          taskName?: string;
          status?: string;
          error?: string | null;
          durationMs?: number | null;
          tokens?: number | null;
          costUsd?: number | null;
          before?: TriageSettings | null;
          after?: TriageSettings | null;
          dedupCount?: number;
        };
        const triageInput: TriageInput = {
          taskName: String(args.taskName ?? "task"),
          status: String(args.status ?? "success"),
          ...(args.error ? { error: args.error } : {}),
          ...(typeof args.durationMs === "number" ? { durationMs: args.durationMs } : {}),
          ...(typeof args.tokens === "number" ? { tokens: args.tokens } : {}),
          ...(typeof args.costUsd === "number" ? { costUsd: args.costUsd } : {}),
        };
        const before = args.before ?? undefined;
        const after = args.after ?? undefined;
        const result = await compareTriage(triageInput, before, after, args.dedupCount ?? 1);
        return { success: true, result };
      },

      // --- Спринт 26: секреты и аудит -------------------------------------
      list_secrets: async () => {
        return { success: true, secrets: listSecrets() };
      },
      save_secret: async (input: unknown) => {
        try {
          const source = (input ?? {}) as { name?: string; value?: string };
          const name = (source.name ?? "").trim();
          if (!name) {
            return { success: false, message: t("tool.secret.needName") };
          }
          if (typeof source.value !== "string" || source.value.length === 0) {
            return { success: false, message: t("tool.secret.needValue") };
          }
          const secret = setSecret(name, source.value);
          return {
            success: true,
            message: t("tool.secret.saved", { name: secret.name }),
            secret,
          };
        } catch (err) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
      delete_secret: async (input: unknown) => {
        try {
          const name = (((input ?? {}) as { name?: string }).name ?? "").trim();
          if (!name) {
            return { success: false, message: t("tool.secret.needName") };
          }
          const existed = hasSecret(name);
          deleteSecret(name);
          return {
            success: existed,
            message: existed
              ? t("tool.secret.deleted", { name })
              : t("tool.secret.notFound", { name }),
          };
        } catch (err) {
          return {
            success: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
      get_audit: async (input: unknown) => {
        const source = (input ?? {}) as {
          action?: string;
          target?: string;
          actor?: string;
          since?: string;
          until?: string;
          limit?: number;
        };
        const dateError =
          auditDateFilterError(source.since, "since") ??
          auditDateFilterError(source.until, "until");
        if (dateError) return { success: false, message: dateError };
        const result = readAuditLog({
          action: source.action,
          target: source.target,
          actor: source.actor,
          since: source.since,
          until: source.until,
          limit: source.limit,
        });
        return { success: true, ...result };
      },
      list_dlq: async (input: unknown) => {
        const source = (input ?? {}) as { status?: string; limit?: number };
        return listDlq({ status: source.status, limit: source.limit });
      },
      retry_dlq: async (input: unknown) => {
        const source = (input ?? {}) as { id?: string };
        if (!source.id) return { success: false, error: "id is required" };
        return retryDlqExecution(source.id);
      },
      discard_dlq: async (input: unknown) => {
        const source = (input ?? {}) as { id?: string; resolution?: string };
        if (!source.id) return { success: false, error: "id is required" };
        return discardDlq(source.id, source.resolution);
      },
      list_durable_runs: async (input: unknown) => {
        const source = (input ?? {}) as { filter?: string; limit?: number };
        return listRunPanel({ filter: source.filter, limit: source.limit });
      },
      pause_durable_run: async (input: unknown) => {
        const source = (input ?? {}) as {
          runId?: string;
          stepName?: string;
          comment?: string;
          author?: string;
        };
        if (!source.runId) return { success: false, error: "runId is required" };
        return pauseRunPanel(source.runId, {
          stepName: source.stepName,
          comment: source.comment,
          author: source.author,
        });
      },
      resume_durable_run: async (input: unknown) => {
        const source = (input ?? {}) as { runId?: string };
        if (!source.runId) return { success: false, error: "runId is required" };
        return resumeDurableRunExecution(source.runId);
      },
      list_approvals: async (input: unknown) => {
        const source = (input ?? {}) as { limit?: unknown };
        return listApprovalPanel({ limit: source.limit });
      },
      decide_approval: async (input: unknown) => {
        const source = (input ?? {}) as {
          requestId?: string;
          decision?: string;
          decidedBy?: string;
        };
        return decideApprovalPanel(source.requestId, source.decision, source.decidedBy);
      },
      get_templates: async () => {
        try {
          return { templates: await loadTemplates() };
        } catch (err) {
          console.error("[agent-steward] get_templates error:", err);
          return { templates: [] };
        }
      },
      save_template: async (input: unknown) => {
        try {
          const source = input as Partial<TaskTemplate> & {
            name?: string;
            prompt?: string;
          };
          if (!source?.name?.trim() || !source?.prompt?.trim()) {
            return {
              success: false,
              error: t("tool.template.namePromptRequired"),
            };
          }
          const template = await saveTemplate({
            ...source,
            name: source.name,
            prompt: source.prompt,
            triggerType:
              source.triggerType === "file"
                ? "file"
                : source.triggerType === "mcp-event"
                  ? "mcp-event"
                  : source.triggerType
                    ? "cron"
                    : undefined,
          });
          return { success: true, template };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      delete_template: async (input: unknown) => {
        const { id } = input as { id?: string };
        if (!id) {
          return { success: false, error: t("tool.template.needId") };
        }
        try {
          // QA-P3.3: принимаем и id, и имя шаблона; отсутствие — явная ошибка.
          const templates = await loadTemplates();
          const existed = templates.some((template) => template.id === id || template.name === id);
          if (!existed) {
            return { success: false, error: t("tool.template.notFound", { id }) };
          }
          await deleteTemplate(id);
          return { success: true };
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
      export_tasks: async (_input: unknown) => {
        try {
          const tasks = await scheduler.listTasks();
          const exportTasks = tasks.map((t) => ({
            ...t,
            name: t.taskName || "",
          }));
          const { data, count } = await buildExportJson(exportTasks);
          return { success: true, data, count };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
      import_tasks: async (input: unknown) => {
        const { data } = input as { data?: string };
        if (!data) {
          return { success: false, error: t("tool.transfer.noData") };
        }
        try {
          const parsed = parseImportJson(data);
          if (parsed.tasks.length === 0) {
            return {
              success: false,
              error: t("tool.transfer.noTasksInFile"),
              errors: parsed.errors,
            };
          }

          const imported: string[] = [];
          const errors: string[] = [...parsed.errors];

          for (const def of parsed.tasks) {
            try {
              await schedulerCreateTask(
                def.name,
                def.schedule,
                def.prompt,
                def.timeoutSeconds,
                def.workingDirectory ?? def.workdir,
                def.retryCount,
                def.retryDelay,
                def.qualityGate,
                def.nextTaskOnSuccess,
                def.nextTaskOnError,
                def.triggerType,
                def.watchPath,
                def.dependsOn,
                def.model,
                def.priority,
                def.beforeScript,
                def.afterScript,
                def.mcpEvent,
                def.workspaceId,
                def.allowedTools,
                def.deniedTools,
                def.matrix,
                def.matrixParentId,
                "create",
                def.timezone,
                def.notBefore,
                def.notAfter,
                def.pausedUntil,
                def.runAt,
                def.session ?? "new",
                def.sessionId,
                def.sessionMaxRuns,
                {
                  activeDays: def.activeDays,
                  windowPolicy: def.windowPolicy,
                  watchGlobs: def.watchGlobs,
                  watchIgnore: def.watchIgnore,
                  gitBranch: def.gitBranch,
                  gitPaths: def.gitPaths,
                  gitIgnore: def.gitIgnore,
                  gitPollSeconds: def.gitPollSeconds,
                },
                def.runWhenLoggedOff === true,
                def.paused === true,
                def.legacyShell === true,
                def.worktree === true,
                def.guards,
                // QA-P0.1 (E-2.1): импорт через RPC сохраняет tokenBudget.
                def.tokenBudget,
              );
              await saveTaskDefinition(def);
              imported.push(def.name);
            } catch (err) {
              errors.push(`${def.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          return {
            success: imported.length > 0,
            imported: imported.length,
            errors: errors.length ? errors : undefined,
          };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    };

    const rpcRegistration = await ctx.rpc.register(
      SchedulerRpc,
      withRpcAudit(rpcHandlers),
    );

    // Lifecycle матриц (Спринт 16): при старте вычищаем клоны/агрегаторы,
    // чьи родители были удалены в прошлых сессиях.
    void cleanupOrphanedMatrixTasks().catch((err) => {
      console.log(
        `[matrix] Не удалось очистить осиротевшие задачи: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    await startSchedulerDashboard();

    return createShutdownHandler(runtime, [
      rpcRegistration,
      registration,
      ...(skillRegistration ? [skillRegistration] : []),
    ]);
  },
});

/**
 * Приводит результат V2-обработчика (`Tool.Result`) к формату V1 (`ToolResult`).
 * V1 ждёт строку или `{ output, metadata }`; V2 отдаёт `{ content }`.
 */
type V1ToolResult = string | { output: string; metadata?: Tool.Result["metadata"] };

/** Сужает элемент content до текстового блока (остальные типы V2 не нас интересуют). */
function isTextContent(part: unknown): part is { type: "text"; text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string"
  );
}

export function toV1ToolResult(result: Tool.Result | string): V1ToolResult {
  if (typeof result === "string") return result;
  const metadata = result.metadata;
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content.filter(isTextContent).map((part) => part.text).join("\n");
    return { output: text, metadata };
  }
  if (typeof content === "string") {
    return { output: content, metadata };
  }
  if (typeof result.output === "string") {
    return { output: result.output, metadata };
  }
  return { output: JSON.stringify(result), metadata };
}

/**
 * V1 `tool()` принимает `z.ZodRawShape`, а спецификации хранят `z.object(...)`.
 * Возвращаем именно shape, чтобы V1 не получил готовый объект схемы.
 */
export function toV1ToolArgs(spec: ToolSpec): z.ZodRawShape {
  const shape = (spec.input as { shape?: unknown } | undefined)?.shape;
  if (!shape || typeof shape !== "object") {
    throw new Error(
      `V1-адаптер: схема инструмента "${spec.name}" должна быть z.object(...)`,
    );
  }
  return shape as z.ZodRawShape;
}

/**
 * V1-реестр инструментов: те же имена, описания, схемы и обработчики, что в
 * V2, плюс тот же аудит. Отличие одно — у V1 `tool()` нет `codemode`, поэтому
 * флаг не передаётся (см. docs/COMPATIBILITY.md).
 */
/**
 * Локальное описание V1-реестра. V1-плагин тянет свою копию zod (4.1.8),
 * поэтому его `ToolDefinition` структурно несовместим с нашим zod (4.6.7).
 * Приведение типов делается один раз на границе `createV1Hooks`.
 */
interface V1ToolDefinition {
  description: string;
  args: z.ZodRawShape;
  execute(args: unknown, context: unknown): Promise<V1ToolResult>;
}
type V1ToolRegistry = Record<string, V1ToolDefinition>;

export function createV1Tools(runtime: SchedulerRuntime): V1ToolRegistry {
  const tools: V1ToolRegistry = {};
  for (const spec of createToolSpecs(runtime)) {
    const execute = spec.audit
      ? withAudit(spec.name, spec.audit, spec.execute)
      : spec.execute;
    tools[spec.name] = v1Tool({
      description: spec.description,
      args: toV1ToolArgs(spec),
      execute: async (args, context) => toV1ToolResult(await execute(args, context)),
    });
  }
  return tools;
}

/**
 * V1-entrypoint (OpenCode 1.x): module contract `{ id?, server }`.
 *
 * Возвращает те же инструменты, что V2-setup, но через `tool()` и строковые
 * ключи `Hooks`. Ядро и аудит общие: `createRuntime`, `createToolSpecs`,
 * `createShutdownHandler`. GUI/RPC/скиллы — только V2, здесь их нет.
 */
export async function createV1Hooks(
  input: Pick<V1PluginInput, "directory"> = { directory: process.cwd() },
  options: { startDashboard?: boolean } = {},
): Promise<V1Hooks> {
  if (isChildRunMode()) {
    console.log(`[qv8] ${CHILD_RUN_ENV}: дочерний прогон, пропускаю регистрацию плагина`);
    return { tool: {}, dispose: async () => undefined };
  }
  // PL-45: см. V2 setup — повторная регистрация должна открывать ворота.
  shutdownGate.reset();
  const runtime = await createRuntime({ location: { directory: input.directory } });
  const tools = createV1Tools(runtime);
  if (options.startDashboard !== false) {
    await startSchedulerDashboard();
  }
  return {
    // QA-A2.1: граница внешнего V1 API — у плагина отдельная копия zod,
    // типы несовместимы структурно. Значения и поведение не меняются.
    tool: tools as unknown as V1Hooks["tool"],
    dispose: createShutdownHandler(runtime),
  };
}

const v1Plugin: V1PluginModule = {
  id: "opencode-windows-scheduler",
  server: async (input) => createV1Hooks({ directory: input.directory }),
};

/**
 * Двойной экспорт: V2 читает `id`/`setup`, V1 — `server`. Каждая линия
 * игнорирует поле другой; общее ядро одно.
 */
export default { ...v2Plugin, ...v1Plugin };

/**
 * Дополнительные настройки матрицы (Спринт 17): matrix.concurrency и
 * matrix.overrides. Валидирует и нормализует, бросая понятные ошибки.
 */
function resolveMatrixExtraConfig(
  name: string,
  matrix: MatrixConfig,
  ids: string[],
): { concurrency?: number; overrides?: Record<string, MatrixWorkspaceOverride> } {
  const extra: {
    concurrency?: number;
    overrides?: Record<string, MatrixWorkspaceOverride>;
  } = {};

  if (matrix.concurrency !== undefined && matrix.concurrency !== null) {
    if (
      typeof matrix.concurrency !== "number" ||
      !Number.isFinite(matrix.concurrency) ||
      matrix.concurrency < 1
    ) {
      throw new Error(
        t("tool.error.matrixConcurrency", { task: name }),
      );
    }
    extra.concurrency = Math.floor(matrix.concurrency);
  }

  if (matrix.overrides) {
    const allowed = new Set(ids);
    const overrides: Record<string, MatrixWorkspaceOverride> = {};
    for (const [key, value] of Object.entries(matrix.overrides)) {
      const workspaceKey = key.trim();
      if (!allowed.has(workspaceKey)) {
        throw new Error(
          t("tool.error.matrixOverride", {
            task: name,
            workspace: workspaceKey,
          }),
        );
      }
      if (!value || typeof value !== "object") continue;
      const override: MatrixWorkspaceOverride = {};
      for (const field of [
        "prompt",
        "model",
        "qualityGate",
        "beforeScript",
        "afterScript",
      ] as const) {
        const raw = (value as Record<string, unknown>)[field];
        if (typeof raw === "string" && raw.trim()) {
          const trimmed = raw.trim();
          if (field === "model") {
            const modelError = validateModelReference(trimmed);
            if (modelError) {
              throw new Error(
                t("tool.error.modelInvalid", {
                  model: trimmed,
                  error: modelError,
                }),
              );
            }
          }
          override[field] = trimmed;
        }
      }
      if (Object.keys(override).length > 0) overrides[workspaceKey] = override;
    }
    if (Object.keys(overrides).length > 0) extra.overrides = overrides;
  }

  return extra;
}

/**
 * Общая логика создания задачи: используется и schedule_task (инструмент),
 * и create_task (RPC-метод для GUI).
 */
/**
 * Спринт 27: дополнительные параметры триггеров (дни недели, политика окна,
 * glob-фильтры файловых триггеров и git-триггеры).
 */
export interface TriggerExtras {
  activeDays?: number[];
  windowPolicy?: "skip" | "postpone" | "run";
  watchGlobs?: string[];
  watchIgnore?: string[];
  gitBranch?: string;
  gitPaths?: string[];
  gitIgnore?: string[];
  gitPollSeconds?: number;
}

/**
 * PL-42: вход нормализации mcpEvent. `eventName` — алиас `event`, который
 * присылает `emit_event`; оба поля необязательны, но хотя бы одно нужно
 * для triggerType=mcp-event (проверяется после нормализации).
 */
interface McpEventInput {
  server?: string;
  /** Каноническое имя события. Приоритетнее алиаса. */
  event?: string;
  /** Алиас emit_event; используется, только если event пуст. */
  eventName?: string;
  filter?: string;
}

/**
 * PL-42: приводит mcpEvent к каноническому виду `{ server, event, filter? }`.
 * `event` имеет приоритет: если заданы оба поля и они различаются, alias
 * `eventName` игнорируется — так поведение старых задач не меняется.
 */
export function normalizeMcpEventTrigger(
  mcpEvent?: McpEventInput,
): McpEventTrigger | undefined {
  const rawEvent = mcpEvent?.event?.trim() || mcpEvent?.eventName?.trim();
  if (!rawEvent) return undefined;
  return {
    server: mcpEvent?.server?.trim() || "",
    event: rawEvent,
    ...(mcpEvent?.filter?.trim() ? { filter: mcpEvent.filter.trim() } : {}),
  };
}

export async function schedulerCreateTask(
  name: string,
  schedule: string,
  prompt: string,
  timeoutSeconds?: number,
  workingDirectory?: string,
  retryCount?: number,
  retryDelay?: number,
  qualityGate?: string,
  nextTaskOnSuccess?: string,
  nextTaskOnError?: string,
  triggerType?: "cron" | "file" | "git" | "mcp-event" | "once",
  watchPath?: string,
  dependsOn?: string[],
  model?: string,
  priority?: number,
  beforeScript?: string,
  afterScript?: string,
  mcpEvent?: McpEventInput,
  workspaceId?: string,
  allowedTools?: string[],
  deniedTools?: string[],
  matrix?: MatrixConfig,
  matrixParentId?: string,
  /** create — пересоздать клонов с нуля; sync — только diff (Спринт 17). */
  matrixMode: "create" | "sync" = "create",
  /** IANA-зона задачи (Спринт 19). Не системная зона → poll-режим шлюза. */
  timezone?: string,
  /** Окно запуска: начало "HH:MM" (вне окна запуск переносится). */
  notBefore?: string,
  /** Окончание окна "HH:MM"; может быть меньше notBefore (через полночь). */
  notAfter?: string,
  /** Пауза до момента ISO; после него задача возобновляется автоматически. */
  pausedUntil?: string,
  /** Абсолютное время однократного запуска (ISO, только triggerType=once). */
  runAt?: string,
  /** Режим сессии OpenCode (Спринт 24): new (по умолчанию), reuse, last. */
  session?: "new" | "reuse" | "last",
  /** ID сессии для reuse (генерируется автоматически; пользователь не задаёт). */
  sessionId?: string,
  /** Сколько запусков переживает reuse-сессия до ротации (0/undefined — без ограничения). */
  sessionMaxRuns?: number,
  /** Спринт 27: дни недели, политика окна, glob- и git-фильтры. */
  triggerExtras?: TriggerExtras,
  /** Спринт 27.5.4: Windows — запускать без входа пользователя (/ru SYSTEM). */
  runWhenLoggedOff?: boolean,
  /**
   * Спринт 27.5.8: пересоздать задачу сразу отключённой (пауза переживает
   * update). Для матрицы пауза применяется к клонам.
   */
  paused?: boolean,
  /**
   * Спринт 32 / релиз 1.6: переходный флаг для гибридной политики.
   * true возвращает shell задаче, созданной до обновления поведения.
   */
  legacyShell?: boolean,
  /** W-1: одноразовый git worktree на каждый запуск. */
  worktree?: boolean,
  /** W-3: guard-условия перед запуском opencode. */
  guards?: TaskGuards,
  /** Economics v2 (E-2): per-run token budget. 0/omitted = no limit (fail-open). */
  tokenBudget?: number,
  /** PL-75: при пересоздании cron-задачи добавить будущую /sd (без catch-up). */
  avoidCatchUp?: boolean,
  /** PL-119: создаваемые задачей файлы — их SCOPE-пути не требуют существования. */
  filesCreate?: string[],
  /** B-2.1: явно включённый автоподбор модели (сохраняется в definition). */
  autoSelectModel?: boolean,
  /** B-2.2: модель выбрана эвристикой, а не задана пользователем. */
  autoSelectedModel?: boolean,
): Promise<void> {
  // Спринт 27.5 (hotfix 1.5.1): проверяем имя до создания wrapper/prompt и записи
  // в БД. Недопустимые символы отклоняются с понятным сообщением, а не ошибкой
  // schtasks; имя нормализуется (trim) для всех путей: MCP, RPC и импорт.
  const normalizedName = name.trim();
  const nameError = validateTaskName(normalizedName);
  if (nameError) {
    throw new Error(nameError);
  }
  name = normalizedName;
  // Обе платформы передают промпт через argv. Windows (CreateProcess) даёт
  // ~32767 символов на командную строку, POSIX — MAX_ARG_STRLEN (128 КиБ на
  // один аргумент в Linux; macOS ограничивает суммарный ARG_MAX). Проверяем до
  // записи файлов, чтобы не оставить полусозданную задачу и дать понятную
  // ошибку вместо сбоя schtasks/cron.
  if (process.platform === "win32") {
    if (prompt.length > 30000) {
      throw new Error(
        `Промпт задачи "${normalizedName}" слишком длинный для командной строки Windows: ${prompt.length} символов (максимум 30000). Сократите промпт или вынесите инструкции в файл.`,
      );
    }
  } else {
    const promptBytes = Buffer.byteLength(prompt, "utf8");
    if (promptBytes > POSIX_MAX_PROMPT_BYTES) {
      throw new Error(
        `Промпт задачи "${normalizedName}" слишком длинный для командной строки POSIX: ${promptBytes} байт (максимум ${POSIX_MAX_PROMPT_BYTES}). Сократите промпт или вынесите инструкции в файл.`,
      );
    }
  }
  // Для отката файлов: при обновлении существующей задачи файлы переиспользуются,
  // удалять их при сбое нельзя — в БД остаётся прежнее определение.
  const definitionExisted = Boolean(getTask(normalizedName));
  // P1-10: при создании проверяем, что sanitized-имя не занято другой задачей
  // или её оставшимися файлами. Иначе «my task» и «my-task» делят
  // wrapper/prompt/lock/log, а вторая задача перезаписывает первую.
  if (!definitionExisted) {
    const conflict = findSanitizedNameConflict(
      normalizedName,
      listTaskDefinitions().map((def) => def.name),
    );
    if (conflict) {
      throw new Error(sanitizedConflictMessage(normalizedName, conflict));
    }
  }

  const normalizedModel = model?.trim() || undefined;
  if (normalizedModel) {
    const modelError = validateModelReference(normalizedModel);
    if (modelError) {
      throw new Error(
        t("tool.error.modelInvalid", { model: normalizedModel, error: modelError }),
      );
    }
  }
  const normalizedPriority = normalizePriority(priority);
  const normalizedBefore = beforeScript?.trim() || undefined;
  const normalizedAfter = afterScript?.trim() || undefined;
  const normalizedTz = timezone?.trim() || undefined;
  const normalizedNotBefore = notBefore?.trim() || undefined;
  const normalizedNotAfter = notAfter?.trim() || undefined;
  const normalizedPausedUntil = pausedUntil?.trim() || undefined;
  // Спринт 27.5.4: true → задача работает без входа (Windows /ru SYSTEM).
  const normalizedRunWhenLoggedOff = runWhenLoggedOff === true ? true : undefined;
  // Спринт 27.5.8: пауза сохраняется при пересоздании задачи.
  const normalizedPaused = paused === true ? true : undefined;
  // PL-77: при параллельном выполнении агенты не должны делить worktree.
  // maxConcurrent !== 1 означает, что параллель возможна — включаем
  // уникальный worktree на задачу принудительно.
  let maxConcurrentSetting: number | undefined;
  try {
    maxConcurrentSetting = (await loadSettings()).maxConcurrent;
  } catch {
    // Настройки могут быть ещё не инициализированы — не ломаем создание.
  }
  const parallelPlan = planParallelExecution({
    maxConcurrent: maxConcurrentSetting,
    taskName: normalizedName,
    worktree: worktree === true,
  });
  if (!parallelPlan.allowed) {
    throw new Error(parallelPlan.reason ?? "PL-77: превышен maxConcurrent.");
  }
  const normalizedWorktree = parallelPlan.worktree ? true : undefined;
  // W-3: guard-условия. Ошибка нормализации — явная ошибка создания задачи,
  // чтобы опечатка в конфигурации не превратилась в молчаливый пропуск.
  const guardsResult = normalizeTaskGuards(guards);
  if (!guardsResult.ok) throw new Error(guardsResult.error);
  const normalizedGuards = guardsResult.guards;
  // Economics v2 (E-2): нормализация бюджета токенов. 0/отрицание/NaN = без лимита.
  const normalizedTokenBudget =
    Number.isFinite(tokenBudget) && (tokenBudget ?? 0) > 0
      ? Math.floor(tokenBudget!)
      : undefined;
  // Спринт 27: дни недели, политика окна и glob/git-фильтры.
  const normalizeGlobList = (raw?: string[]): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const cleaned = Array.from(
      new Set(
        raw
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    );
    return cleaned.length > 0 ? cleaned : undefined;
  };
  const normalizedActiveDays = normalizeActiveDays(triggerExtras?.activeDays);
  const normalizedWindowPolicy =
    triggerExtras?.windowPolicy === "skip" || triggerExtras?.windowPolicy === "run"
      ? triggerExtras.windowPolicy
      : undefined;
  const normalizedWatchGlobs = normalizeGlobList(triggerExtras?.watchGlobs);
  const normalizedWatchIgnore = normalizeGlobList(triggerExtras?.watchIgnore);
  const normalizedGitBranch = triggerExtras?.gitBranch?.trim() || undefined;
  const normalizedGitPaths = normalizeGlobList(triggerExtras?.gitPaths);
  const normalizedGitIgnore = normalizeGlobList(triggerExtras?.gitIgnore);
  const normalizedGitPollSeconds =
    typeof triggerExtras?.gitPollSeconds === "number" &&
    Number.isFinite(triggerExtras.gitPollSeconds) &&
    triggerExtras.gitPollSeconds >= 5
      ? Math.floor(triggerExtras.gitPollSeconds)
      : undefined;
  // PL-42: mcpEvent принимает event и его алиас eventName (emit_event).
  // event приоритетнее: если оба заданы и различаются, побеждает event.
  const normalizedMcpEvent = normalizeMcpEventTrigger(mcpEvent);
  let effectiveTriggerType = triggerType ?? "cron";
  // One-shot: нормализуем время до создания файлов и задачи в ОС.
  // Для остальных триггеров runAt не имеет смысла и отбрасывается.
  let effectiveRunAt: string | undefined;
  if (effectiveTriggerType === "once") {
    const normalized = normalizeOneShotRunAt({ runAt });
    if (!normalized.ok) {
      throw new Error(t("tool.error.taskReason", { name, error: normalized.error }));
    }
    effectiveRunAt = normalized.runAt;
  }
  // Спринт 24: режим сессии. sessionId генерируется автоматически для reuse;
  // значение пользователя никогда не принимаем.
  let effectiveSession: "new" | "reuse" | "last" = "new";
  let effectiveSessionId: string | undefined;
  if (session !== undefined) {
    const normalizedSession = normalizeSessionMode(session);
    if (!normalizedSession) {
      throw new Error(
        t("tool.error.sessionUnknown", {
          name,
          session: String(session),
        }),
      );
    }
    effectiveSession = normalizedSession;
  }
  if (effectiveSession === "reuse") {
    effectiveSessionId = sessionId?.trim() || generateSessionId();
  }
  // Role-scoped: нормализуем списки инструментов (trim, дедуп без регистра).
  // Пустой allowedTools — осознанная блокировка: «белый список из нуля
  // инструментов» это почти наверняка ошибка конфигурации.
  const normalizeToolList = (raw?: string[]): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const cleaned = Array.from(
      new Map(
        raw
          .filter((t): t is string => typeof t === "string")
          .map((t) => t.trim())
          .filter(Boolean)
          .map((t) => [t.toLowerCase(), t] as const),
      ).values(),
    );
    return cleaned.length > 0 ? cleaned : undefined;
  };
  if (Array.isArray(allowedTools) && allowedTools.filter((t) => typeof t === "string" && t.trim()).length === 0) {
    throw new Error(
      t("tool.error.allowedToolsEmpty", { task: name }),
    );
  }
  const normalizedAllowedTools = normalizeToolList(allowedTools);
  const normalizedDeniedTools = normalizeToolList(deniedTools);
  // Спринт 32 / релиз 1.6: единая политика прав. Вычисляем здесь, чтобы
  // PowerShell- и bash-обёртки получили одинаковый OPENCODE_CONFIG_CONTENT.
  const globalPolicy =
    (await loadSettings()).permissions?.defaultPolicy ?? DEFAULT_PERMISSION_POLICY;
  const effectivePermissions = resolvePermissions({
    policy: globalPolicy,
    legacyShell: legacyShell === true,
    allowedTools: normalizedAllowedTools,
    deniedTools: normalizedDeniedTools,
  });
  const permissionsConfig = buildOpencodeConfig({
    policy: globalPolicy,
    legacyShell: legacyShell === true,
    allowedTools: normalizedAllowedTools,
    deniedTools: normalizedDeniedTools,
  });
  const policyMeta = {
    policy: effectivePermissions.policy,
    legacyShell: effectivePermissions.legacyShell,
    denied: effectivePermissions.deniedByPolicy,
  };

  // Matrix (fan-out, Спринт 15): валидируем до создания файлов, чтобы не
  // оставить «полу-созданную» задачу. Родитель сам не выполняется — он шаблон.
  let normalizedMatrix: MatrixConfig | undefined;
  if (matrix) {
    if (workspaceId?.trim()) {
      throw new Error(
        t("tool.error.workspaceIdConflict", { task: name }),
      );
    }
    const ids = Array.from(
      new Set(
        (Array.isArray(matrix.workspaceIds) ? matrix.workspaceIds : [])
          .filter((id): id is string => typeof id === "string")
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    );
    if (ids.length === 0) {
      throw new Error(
        t("tool.error.workspaceIdsEmpty", { task: name }),
      );
    }
    for (const id of ids) {
      const ws = getWorkspace(id);
      if (!ws) {
        throw new Error(
          t("tool.error.workspaceMissing", { task: name, id }),
        );
      }
      try {
        validateWorkspacePath(ws.path);
      } catch {
        throw new Error(
          t("tool.error.workspaceUnavailable", {
            task: name,
            workspace: ws.name,
            path: ws.path,
          }),
        );
      }
    }
    normalizedMatrix = {
      workspaceIds: ids,
      strategy: matrix.strategy === "sequential" ? "sequential" : "parallel",
      failureMode: matrix.failureMode === "stop" ? "stop" : "continue",
      aggregation: matrix.aggregation === "per-task" ? "per-task" : "summary",
      ...(matrix.createAggregator ? { createAggregator: true } : {}),
      ...resolveMatrixExtraConfig(name, matrix, ids),
    };
  }

  // Matrix-родитель и её клоны регистрируются как ручные задачи (ONCE 2099):
  // клоны стартует только runMatrix(), иначе cron запускал бы их независимо.
  if (normalizedMatrix || matrixParentId) {
    effectiveTriggerType = "file";
  }

  // MCP-триггер без имени события бессмыслен — валидируем до создания файлов.
  if (effectiveTriggerType === "mcp-event" && !normalizedMcpEvent) {
    throw new Error(t("tool.error.mcpEventRequired"));
  }
  // Спринт 27: git-триггеру нужен git-репозиторий в рабочей директории.
  if (effectiveTriggerType === "git") {
    const gitCwd = workspaceId?.trim()
      ? getWorkspace(workspaceId.trim())?.path
      : workingDirectory?.trim() || projectDirectory || process.cwd();
    if (!gitCwd) {
      throw new Error(
        t("tool.error.gitCwdRequired", { task: name }),
      );
    }
    if (!readGitBranch(gitCwd)) {
      throw new Error(
        t("tool.error.gitNoRepo", { task: name, path: gitCwd }),
      );
    }
  }
  // Валидируем cron-выражение до создания файлов. Для file/mcp-event
  // расписание не используется вовсе.
  if (effectiveTriggerType === "cron") {
    try {
      // Расширенная грамматика (Спринт 19): диапазоны, списки, шаги,
      // имена месяцев/дней, @every, L и FRI#3.
      parseCron(schedule);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
    if (normalizedTz && !isValidIanaTimeZone(normalizedTz)) {
      throw new Error(
        t("tool.error.timezone", {
          task: name,
          timezone: normalizedTz,
        }),
      );
    }
    const windowError = validateLaunchWindow(
      normalizedNotBefore,
      normalizedNotAfter,
    );
    if (windowError) {
      throw new Error(t("tool.error.window", { task: name, error: windowError }));
    }
    // P2-24: cron может быть валидным, но никогда не попадать в окно запуска
    // (например, daily 09:00 при окне 22:00–06:00). Предупреждаем сразу при
    // создании: иначе задача молча не выполняется из-за лимита переноса 12 ч.
    if (normalizedNotBefore || normalizedNotAfter || normalizedActiveDays) {
      const feasibility = assessCronWindowFeasibility(
        schedule,
        {
          notBefore: normalizedNotBefore,
          notAfter: normalizedNotAfter,
          days: normalizedActiveDays,
          timeZone: normalizedTz || undefined,
        },
        normalizedWindowPolicy,
      );
      if (!feasibility.feasible) {
        console.warn(
          `[scheduler] Задача "${name}": ${t("dryRun.window.unreachable", {
            cron: schedule,
            reason: windowFeasibilityReasonText(feasibility.reason),
          })}`,
        );
      }
    }
  }
  // Спринт 27: окно и дни недели применимы и к событийным триггерам
  // (file/git/mcp-event/once) — проверяем корректность до создания задачи.
  if (effectiveTriggerType !== "cron") {
    const windowError = validateLaunchWindow(normalizedNotBefore, normalizedNotAfter);
    if (windowError) {
      throw new Error(t("tool.error.window", { task: name, error: windowError }));
    }
  }

  const sanitized = sanitizeName(name);
  const lockFile = lockFilePath(sanitized);
  const logFile = path.join(LOG_DIR, `${sanitized}.log`);
  // Шлюз расписания (Спринт 19): нужен только для cron в poll-режиме
  // (нестандартный cron или чужая IANA-зона) либо при окне запуска.
  const gate =
    effectiveTriggerType === "cron"
      ? buildScheduleGate(
        schedule,
        normalizedTz,
        normalizedNotBefore,
        normalizedNotAfter,
        normalizedActiveDays,
        normalizedWindowPolicy,
        process.platform,
      )
      : undefined;
  const wrapperGate = gate
    ? {
      ...gate,
      gateFile: gatePath,
      deferFile: `${lockFile}.defer`,
      forceFile: `${lockFile}.force`,
      // BN-1: догон cron-тиков, пропущенных между минутными опросами ОС.
      catchupFile: `${lockFile}.catchup`,
    }
    : undefined;
  // Workspace имеет приоритет над workingDirectory: одна задача = один repo
  // = один cwd. Мы не угадываем, куда мержить, и не смешиваем контексты.
  const normalizedWorkspaceId = workspaceId?.trim() || undefined;
  const workspace = normalizedWorkspaceId ? getWorkspace(normalizedWorkspaceId) : undefined;
  if (normalizedWorkspaceId && !workspace) {
    throw new Error(
      t("tool.error.workspaceIdMissing", {
        id: normalizedWorkspaceId,
      }),
    );
  }
  if (workspace) {
    try {
      validateWorkspacePath(workspace.path);
    } catch {
      throw new Error(
        t("tool.error.workspacePathMissing", {
          name: workspace.name,
          path: workspace.path,
        }),
      );
    }
    if (workingDirectory?.trim() && workingDirectory.trim() !== workspace.path) {
      console.warn(
        `[workspace] Задача "${name}": workingDirectory "${workingDirectory.trim()}" ` +
          `игнорируется, cwd = workspace "${workspace.name}" (${workspace.path}).`,
      );
    }
  }
  const effectiveWorkingDirectory =
    workspace?.path || workingDirectory?.trim() || projectDirectory || process.cwd();

  // PL-79 / PL-82 / PL-119: pre-flight проверяем ВЕСЬ список SCOPE-путей до записи
  // обёртки и регистрации в ОС. Иначе post-flight `git add` падает уже после
  // зелёного quality gate из-за пути, которого никогда не было на диске.
  // PL-119: пути из filesCreate — ожидаемые создаваемые файлы, их пропускаем.
  const scopeCheck = preflightScope(prompt, effectiveWorkingDirectory, { filesCreate });
  if (!scopeCheck.ok) {
    throw new Error(
      `PL-79/PL-82: SCOPE задачи "${normalizedName}" содержит несуществующие пути: ` +
        `${scopeCheck.missing.join(", ")}. Исправьте список путей до создания задачи.`,
    );
  }

  // Файловые триггеры: относительный watchPath не должен выходить за рабочую
  // директорию задачи, а glob-маски — за пределы watchPath (path traversal).
  let effectiveWatchPath = watchPath?.trim() || undefined;
  if (effectiveWatchPath) {
    try {
      effectiveWatchPath = normalizeWatchPath(effectiveWatchPath, effectiveWorkingDirectory);
    } catch (err) {
      throw new Error(
        t("tool.error.taskReason", { name, error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }
  try {
    validateWatchGlobs(normalizedWatchGlobs);
    validateWatchGlobs(normalizedWatchIgnore);
  } catch (err) {
    throw new Error(
      t("tool.error.taskReason", { name, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  // Спринт 21: env-переменные workspace → отдельный файл, который читает обёртка.
  // Спринт 29.3: инжектит в env только реально используемые секреты (scoped-инъекция).
  const usedSecretNames = collectSecretNames(
    prompt,
    beforeScript,
    afterScript,
    qualityGate,
  );
  const taskEnvFile = writeWorkspaceEnvFile(
    workspace,
    PLUGIN_DIR,
    sanitized,
    usedSecretNames,
  );
  if (taskEnvFile) {
    console.log(`[workspace] Задача "${name}": env-переменные workspace подключены.`);
  }

  let promptFile: string;
  try {
    promptFile = await writePromptFile(sanitized, prompt);
    await fs.mkdir(LOG_DIR, { recursive: true });
    // Не обнуляем лог: при падении до запуска обёртки (или при отказе модели)
    // предыдущий диагностический вывод оставался бы единственным, а новый
    // прогон выглядел бы как «лог пуст». Дописываем маркер ПОДГОТОВКИ —
    // задача создана, но ещё не запускалась (не путать с реальным Run started,
    // который пишется обёрткой только при фактическом запуске; QA #8).
    await fs.appendFile(logFile, formatLogRunMarker("prepare", name), "utf8");
  } catch (err) {
    throw new Error(
      t("tool.error.prepareFiles", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // Обёртка зависит от платформы:
  //  - Windows: .cmd → PowerShell-скрипт (lock, таймаут, метрики);
  //  - Linux/macOS: .sh с тем же набором гарантий.
  // Спринт 24: id сессии читается обёрткой из sidecar-файла в рантайме,
  // поэтому ротация подхватывается без пересоздания задачи.
  const sessionFile =
    effectiveSession === "reuse" ? sessionStatePath(name) : undefined;
  let wrapperPath: string;
  try {
    if (scheduler.platform === "win32") {
      await ensureWrapper();
      wrapperPath = await writeWrapperCmd(
        sanitized,
        name,
        promptFile,
        timeoutSeconds ?? 3600,
        lockFile,
        effectiveWorkingDirectory,
        logFile,
        recorderPath,
        qualityGate,
        normalizedModel,
        normalizedBefore,
        normalizedAfter,
        workspace?.name,
        normalizedAllowedTools,
        normalizedDeniedTools,
        wrapperGate,
        taskEnvFile,
        effectiveSession,
        effectiveSessionId,
        undefined,
        permissionsConfig,
        policyMeta,
        sessionFile,
        normalizedWorktree,
        worktreeHelperPath,
        normalizedGuards,
        guardHelperPath,
        gateAllowPathsFromScope(scopeCheck.paths, filesCreate, normalizedAfter),
      );
    } else {
      wrapperPath = await writeBashWrapper({
        sanitizedName: sanitized,
        taskName: name,
        promptFile,
        timeoutSeconds: timeoutSeconds ?? 3600,
        lockFile,
        workdir: effectiveWorkingDirectory,
        logFile,
        recorderFile: recorderPath,
        qualityGate,
        model: normalizedModel,
        beforeScript: normalizedBefore,
        afterScript: normalizedAfter,
        workspaceName: workspace?.name,
        allowedTools: normalizedAllowedTools,
        deniedTools: normalizedDeniedTools,
        policy: globalPolicy,
        legacyShell: legacyShell === true,
        scheduleGate: wrapperGate,
        envFile: taskEnvFile,
        sessionMode: effectiveSession,
        sessionId: effectiveSessionId,
        sessionFile,
        worktree: normalizedWorktree,
        worktreeHelper: worktreeHelperPath,
        guards: normalizedGuards,
        guardHelper: guardHelperPath,
        gateAllowPaths: gateAllowPathsFromScope(scopeCheck.paths, filesCreate, normalizedAfter),
        ...(effectiveTriggerType === "once" && scheduler.platform === "darwin"
          ? { oneShotCleanupCommand: buildLaunchdOneShotCleanup(sanitized, getProfileName()) }
          : {}),
      });
    }
  } catch (err) {
    throw new Error(
      t("tool.error.wrapper", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  // 27.5.5.3: при сбое создания новой задачи убираем подготовленные файлы.
  // При обновлении файлы переиспользуются существующей задачей — не удаляем.
  const rollbackArtifacts = async (): Promise<void> => {
    if (definitionExisted) return;
    await Promise.all(
      [wrapperPath, promptFile, logFile, taskEnvFile].map((file) =>
        file ? fs.unlink(file).catch(() => undefined) : Promise.resolve(),
      ),
    );
  };

  try {
    // Бэкенд сам преобразует cron в родное расписание ОС.
    await scheduler.createTask({
      name,
      command: wrapperPath,
      schedule,
      timeoutSeconds: timeoutSeconds ?? 3600,
      triggerType: effectiveTriggerType,
      ...(effectiveRunAt ? { runAt: effectiveRunAt } : {}),
      workingDirectory: effectiveWorkingDirectory,
      logFile,
      model: normalizedModel,
      priority: normalizedPriority,
      timezone: normalizedTz,
      notBefore: normalizedNotBefore,
      notAfter: normalizedNotAfter,
      runWhenLoggedOff: normalizedRunWhenLoggedOff,
      avoidCatchUp,
    });
  } catch (err) {
    await rollbackArtifacts();
    throw new Error(err instanceof Error ? err.message : String(err));
  }

  // Проверяем фактическое наличие задачи в планировщике: до 3 попыток с паузой
  // 200 мс. Это ловит случай, когда ОС/обёртка вернула код 0, но задачи нет.
  const isListed = (tasks: Awaited<ReturnType<typeof scheduler.listTasks>>): boolean =>
    tasks.some(
      (task) => (task.taskName || "").trim().toLowerCase() === name.toLowerCase(),
    );
  let listedTasks: Awaited<ReturnType<typeof scheduler.listTasks>> | undefined;
  let verifyQueryError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      listedTasks = await scheduler.listTasks();
      if (isListed(listedTasks)) break;
    } catch (err) {
      verifyQueryError = err;
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (listedTasks && !isListed(listedTasks)) {
    await rollbackArtifacts();
    throw new Error(
      t("tool.error.schedulerNotConfirmed", {
        task: name,
        scheduler: scheduler.title,
      }) +
        " " +
        (definitionExisted
          ? t("tool.error.schedulerKeptFiles")
          : t("tool.error.schedulerRemovedFiles")),
    );
  }
  if (!listedTasks && verifyQueryError) {
    // Список получить не удалось — не удаляем возможно созданную задачу,
    // но явно предупреждаем: проверка наличия не выполнена.
    console.warn(
      `[agent-steward] Задача "${name}" создана, но проверить её в планировщике не удалось: ${
        verifyQueryError instanceof Error ? verifyQueryError.message : safeStringify(verifyQueryError)
      }`,
    );
  }

  // Сохраняем определение задачи для последующего экспорта/импорта.
  // Определение до перезаписи: нужно и для очереди матрицы, и для счётчика сессии.
  const previousDefinition = getTask(name);
  const existingQueue =
    matrixMode === "sync" ? previousDefinition?.matrixQueue : undefined;
  const taskDefinition: TaskDefinition = {
    name,
    schedule,
    prompt,
    timeoutSeconds,
    model: normalizedModel,
    ...(autoSelectModel === true ? { autoSelectModel: true } : {}),
    ...(autoSelectedModel === true ? { autoSelectedModel: true } : {}),
    priority: normalizedPriority,
    beforeScript: normalizedBefore,
    afterScript: normalizedAfter,
    mcpEvent: normalizedMcpEvent,
    workingDirectory: workspace ? undefined : workingDirectory?.trim() || undefined,
    workspaceId: workspace?.id,
    retryCount,
    retryDelay,
    qualityGate,
    nextTaskOnSuccess,
    nextTaskOnError,
    triggerType: effectiveTriggerType,
    runAt: effectiveRunAt,
    // Спринт 24: сессия. sessionRunCount не экспортируется (internal).
    session: effectiveSession,
    sessionId: effectiveSessionId,
    sessionMaxRuns,
    // Раньше редактирование всегда сбрасывало счётчик в 0, из-за чего лимит
    // sessionMaxRuns обходился правкой любого поля задачи. Сохраняем счётчик,
    // только если сессия и её id не изменились.
    sessionRunCount: preservedSessionRunCount(
      previousDefinition,
      effectiveSession,
      effectiveSessionId,
    ),
    watchPath: normalizedMatrix ? undefined : effectiveWatchPath,
    timezone: normalizedTz,
    notBefore: normalizedNotBefore,
    notAfter: normalizedNotAfter,
    // Спринт 27.5.4: режим входа (Windows: /ru SYSTEM при true).
    runWhenLoggedOff: normalizedRunWhenLoggedOff,
    // Спринт 27.5.8: бессрочная пауза переживает пересоздание.
    paused: normalizedPaused,
    // Спринт 27: дни недели, политика окна, glob- и git-фильтры.
    activeDays: normalizedActiveDays,
    windowPolicy: normalizedWindowPolicy,
    watchGlobs: normalizedWatchGlobs,
    watchIgnore: normalizedWatchIgnore,
    gitBranch: normalizedGitBranch,
    gitPaths: normalizedGitPaths,
    gitIgnore: normalizedGitIgnore,
    gitPollSeconds: normalizedGitPollSeconds,
    pausedUntil: normalizedPausedUntil,
    allowedTools: normalizedAllowedTools,
    deniedTools: normalizedDeniedTools,
    legacyShell: legacyShell === true ? true : undefined,
    worktree: normalizedWorktree,
    guards: normalizedGuards,
    tokenBudget: normalizedTokenBudget,
    matrix: normalizedMatrix,
    isMatrixParent: normalizedMatrix ? true : undefined,
    matrixParentId,
    // Очередь concurrency-лимита переживает обновление определения.
    ...(existingQueue && existingQueue.length > 0
      ? { matrixQueue: existingQueue }
      : {}),
    dependsOn:
      Array.isArray(dependsOn) && dependsOn.length > 0
        ? Array.from(
          new Set(
            dependsOn
              .filter((dep): dep is string => typeof dep === "string")
              .map((dep) => dep.trim())
              .filter(Boolean),
          ),
        )
        : undefined,
  };
  try {
    await saveTaskDefinition(taskDefinition);
    // Аудит политики прав: фиксируем, какие инструменты задача блокирует.
    recordTaskToolBlocks(
      name,
      normalizedAllowedTools,
      normalizedDeniedTools,
      "system",
      "policy",
      globalPolicy,
      legacyShell === true,
    );
  } catch {
    // Не критично — основная задача уже создана.
  }

  // Спринт 24: sidecar с актуальным id сессии — обёртка читает его перед
  // каждым запуском, поэтому ротация не требует пересоздания задачи.
  await writeSessionStateFile(name, effectiveSessionId);

  // Matrix (fan-out): создаём клоны по workspace и, при необходимости,
  // виртуальную задачу matrix-complete, которая запускается DAG-движком.
  // Спринт 17: при обновлении (matrixMode === "sync") клоны не пересоздаются
  // с нуля, а синхронизируются с новым определением; выполняющиеся — не трогаем.
  if (normalizedMatrix) {
    const createClone = async (clone: TaskDefinition): Promise<void> => {
      await schedulerCreateTask(
        clone.name,
        clone.schedule,
        clone.prompt,
        clone.timeoutSeconds,
        undefined,
        clone.retryCount,
        clone.retryDelay,
        clone.qualityGate,
        undefined,
        undefined,
        "file",
        undefined,
        undefined,
        clone.model,
        clone.priority,
        clone.beforeScript,
        clone.afterScript,
        undefined,
        clone.workspaceId,
        clone.allowedTools,
        clone.deniedTools,
        undefined,
        name,
        "create",
        clone.timezone,
        clone.notBefore,
        clone.notAfter,
        clone.pausedUntil,
        clone.runAt,
        clone.session,
        clone.sessionId,
        clone.sessionMaxRuns,
        undefined,
        clone.runWhenLoggedOff,
        clone.paused,
        clone.legacyShell,
        clone.worktree,
        clone.guards,
        // QA-P0.1 (E-2.1): клон матрицы наследует tokenBudget родителя.
        clone.tokenBudget,
      );
    };

    const removeChild = async (child: string): Promise<void> => {
      try {
        await scheduler.deleteTask(child);
      } catch {
        // Старого клона могло уже не быть в планировщике.
      }
      try {
        await removeTaskDefinition(child);
      } catch {
        // Не критично.
      }
      // Спринт 27.5.7: при откате прогона не оставляем и файлы клона.
      await removeTaskArtifacts(child);
    };

    // Создаёт/обновляет/удаляет matrix-complete по текущему определению.
    const syncAggregator = async (): Promise<string | undefined> => {
      const aggregatorName = matrixCompleteName(name);
      if (!normalizedMatrix.createAggregator) {
        if (getTask(aggregatorName)) await removeChild(aggregatorName);
        return undefined;
      }
      const cloneNames = listMatrixClones(name).map((clone) => clone.name);
      if (cloneNames.length === 0) return undefined;
      await schedulerCreateTask(
        aggregatorName,
        schedule,
        t("tool.matrix.completed", {
          name,
          clones: cloneNames.join(", "),
        }),
        timeoutSeconds,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "file",
        undefined,
        cloneNames,
        normalizedModel,
        normalizedPriority,
      );
      return aggregatorName;
    };

    if (matrixMode === "sync") {
      const syncResult = await syncMatrixFamily(taskDefinition, {
        removeChild,
        createChild: createClone,
        updateChild: createClone,
        syncAggregator,
      });
      if (syncResult.warnings.length > 0) {
        console.log(`[matrix] ${name}: ${syncResult.warnings.join(" ")}`);
      }
      if (
        syncResult.created.length > 0 ||
        syncResult.updated.length > 0 ||
        syncResult.removed.length > 0
      ) {
        console.log(
          `[matrix] ${name}: синхронизация — создано ${syncResult.created.length}, ` +
            `обновлено ${syncResult.updated.length}, удалено ${syncResult.removed.length}, ` +
            `занято ${syncResult.running.length}`,
        );
      }
    } else {
      for (const child of removeMatrixChildren(name)) {
        await removeChild(child);
      }
      // Спринт 27.5.7: если клон не создался, откатываем весь прогон. Иначе
      // остаётся родитель с половиной клонов — он выглядит рабочим, но часть
      // workspace никогда не запускается. Ошибку expandMatrixTask (неизвестный
      // workspace) обрабатываем там же: родитель уже записан в БД.
      const createdInRun: string[] = [];
      try {
        const clones = expandMatrixTask(taskDefinition);
        for (const clone of clones) {
          try {
            await createClone(clone);
            createdInRun.push(clone.name);
          } catch (err) {
            const workspaceLabel = clone.workspaceId
              ? getWorkspace(clone.workspaceId)?.name ?? clone.workspaceId
              : "без workspace";
            throw new Error(
              t("tool.error.matrixCloneFailed", {
                clone: clone.name,
                workspace: workspaceLabel,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        }
        await syncAggregator();
      } catch (err) {
        for (const child of [...createdInRun].reverse()) {
          await removeChild(child);
        }
        const aggregatorName = matrixCompleteName(name);
        if (getTask(aggregatorName)) {
          await removeChild(aggregatorName);
        }
        // Новая матрица: без клонов родитель бесполезен — убираем и его,
        // вместе с подготовленными файлами обёртки.
        if (!definitionExisted) {
          try {
            await scheduler.deleteTask(name);
          } catch {
            // Задачи могло не быть: бэкенд уже вернул ошибку.
          }
          try {
            await removeTaskDefinition(name);
          } catch {
            // Не критично: запись могла не сохраниться.
          }
          await rollbackArtifacts();
        }
        throw new Error(
          t("tool.error.matrixExpandRuntime", {
            name,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  // Спринт 27.5.8: пересозданная задача должна остаться на паузе. У матрицы
  // пауза применяется к клонам — родитель сам никогда не выполняется.
  if (normalizedPaused) {
    const pauseTargets = normalizedMatrix
      ? listMatrixClones(name).map((clone) => clone.name)
      : [name];
    for (const target of pauseTargets) {
      try {
        await scheduler.pauseTask(target);
      } catch (err) {
        console.warn(
          `[agent-steward] Задача "${target}": пауза не восстановлена после пересоздания: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}

/**
 * Спринт 27.5.6: восстановление задачи из определения в БД.
 *
 * update_task пересоздаёт задачу в планировщике (delete + create). Раньше при
 * сбое create после успешного delete старая версия терялась навсегда: в ОС её
 * уже нет, а в БД лежит новое (не применённое) определение. Здесь мы заново
 * создаём задачу из прежнего определения — обёртка, промпт, расписание и
 * пауза восстанавливаются тем же путём, что и при обычном create.
 */
async function recreateTaskFromDefinition(definition: TaskDefinition): Promise<void> {
  const paused = Boolean(
    definition.paused === true ||
      (definition.pausedUntil && Date.parse(definition.pausedUntil) > Date.now()),
  );
  await schedulerCreateTask(
    definition.name,
    definition.schedule ?? "",
    definition.prompt,
    definition.timeoutSeconds,
    definition.workingDirectory,
    definition.retryCount,
    definition.retryDelay,
    definition.qualityGate,
    definition.nextTaskOnSuccess,
    definition.nextTaskOnError,
    definition.triggerType ?? "cron",
    definition.watchPath,
    Array.isArray(definition.dependsOn) ? definition.dependsOn : undefined,
    definition.model,
    definition.priority,
    definition.beforeScript,
    definition.afterScript,
    definition.mcpEvent,
    definition.workspaceId,
    definition.allowedTools,
    definition.deniedTools,
    definition.matrix,
    definition.matrixParentId,
    "create",
    definition.timezone,
    definition.notBefore,
    definition.notAfter,
    definition.pausedUntil,
    definition.runAt,
    definition.session ?? "new",
    definition.sessionId,
    definition.sessionMaxRuns,
    {
      activeDays: definition.activeDays,
      windowPolicy: definition.windowPolicy,
      watchGlobs: definition.watchGlobs,
      watchIgnore: definition.watchIgnore,
      gitBranch: definition.gitBranch,
      gitPaths: definition.gitPaths,
      gitIgnore: definition.gitIgnore,
      gitPollSeconds: definition.gitPollSeconds,
    },
    definition.runWhenLoggedOff,
    paused,
    definition.legacyShell,
    definition.worktree,
    definition.guards,
    // QA-P0.1 (E-2.1): откат update не теряет tokenBudget.
    definition.tokenBudget,
  );
}

/**
 * Запуск задачи «как есть», но с учётом матрицы: родитель раскладывается
 * на клоны, а не выполняет свой промпт.
 */
/**
 * B-1.1/PL-125: единая проверка обоих бюджетных гейтов для всех входов.
 *
 * Использует ту же чистую функцию `evaluateRunBudgetGate`, что и registered-
 * путь рекордера (`--budget-gate`), поэтому ручные/MCP/RPC-запуски и запуски
 * ОС-планировщика не могут разойтись в решении. Fail-open сохраняется.
 */
async function checkRunBudgetGate(
  taskName: string,
  tokenBudget: number | undefined,
  now: Date = new Date(),
): Promise<RunBudgetGateDecision> {
  const settings = await loadSettings();
  // Неделя — widest период бюджетов. Выбираем записи по моменту завершения
  // (см. getHistoryForBudget), чтобы не зависеть от окна в 20000 запусков.
  const records = getHistoryForBudget(startOfUtcWeek(now).toISOString());
  const decision = evaluateRunBudgetGate(
    records,
    settings.budgets,
    taskName,
    tokenBudget,
    now,
  );
  if (!decision.allowed) {
    // E-1.3: алерт не должен задерживать или ломать запуск.
    void notifyBudgetExceeded(decision.global).catch((err: unknown) => {
      console.error(
        `[agent-steward] Ошибка бюджетного алерта: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }
  return decision;
}

/** E-1.2: общий гейт бюджета (для входов без задачи, например run_mission). */
async function checkBudgetGate(now: Date = new Date()): Promise<BudgetGateDecision> {
  return (await checkRunBudgetGate("", undefined, now)).global;
}

/**
 * PL-1.1: структурированная ошибка отказа запуска во время выгрузки плагина.
 * Текст `message` сохранён дословно для совместимости с существующими
 * вызывающими; `code` и `hint` дают кнопке повтора/оператору понятный путь.
 */
export class PluginShutdownError extends Error {
  readonly code = "PLUGIN_SHUTTING_DOWN";
  readonly hint: string;
  /** PL-10/QV-2: наблюдаемое состояние ворот в момент отказа. */
  readonly state: ShutdownGateState;
  /** PL-45: повтор возможен после перерегистрации плагина. */
  readonly retryable = true;

  constructor(message: string, hint: string, state: ShutdownGateState) {
    super(message);
    this.name = "PluginShutdownError";
    this.hint = hint;
    this.state = state;
  }
}

/** PL-106: счётчик активных запусков без изоляции в этом процессе плагина. */
let activeNonIsolatedRuns = 0;

/**
 * PL-138: подметает осиротевшие running-записи перед новым запуском.
 *
 * Принудительное завершение дочернего opencode оставляет живую обёртку и
 * историю `running`; следующий запуск упирается в кросс-процессный лок PL-121.
 * Осиротевшим считается запуск, чей лог не обновлялся дольше порога
 * (AGENT_STEWARD_STALE_RUN_LOG_SEC, по умолчанию 180 с). Для владельца на этом
 * хосте best-effort проверяем/завершаем процесс, затем финализируем запись
 * как error с требованием явного повтора и снимаем счётчик PL-106: предыдущий
 * runTaskEntry не дошёл до своего finally.
 */
async function reapStaleRuns(): Promise<number> {
  const configuredSec = Number(process.env.AGENT_STEWARD_STALE_RUN_LOG_SEC);
  const staleSec =
    Number.isFinite(configuredSec) && configuredSec > 0 ? configuredSec : 180;
  const hostname = os.hostname();
  let reaped = 0;

  for (const rec of listRunningRecords()) {
    let mtimeMs: number;
    try {
      const stat = await fs.stat(await resolveTaskLogPath(rec.taskName));
      mtimeMs = stat.mtimeMs;
    } catch {
      // Нет лога или путь недоступен — не считаем запуск осиротевшим.
      continue;
    }
    if (Date.now() - mtimeMs < staleSec * 1000) continue;

    if (rec.ownerPid != null && rec.ownerPid > 0 && rec.ownerHost === hostname) {
      try {
        process.kill(rec.ownerPid, 0);
      } catch {
        // Процесса уже нет — дальше всё равно финализируем запись.
      }
      if (process.platform === "win32") {
        try {
          spawnSync("taskkill", ["/F", "/T", "/PID", String(rec.ownerPid)], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Best-effort: обёртка могла уже умереть.
        }
      }
    }

    const reason = `PL-138: осиротевший запуск (агент/обёртка не отвечают, лог не обновлялся ${staleSec} с); требуется явный повтор`;
    const durationMs = Date.now() - Date.parse(rec.startedAt);
    if (finishRun(rec.id, "error", durationMs, reason, null, 0, 0, undefined, "skipped", "skipped")) {
      console.error(`[agent-steward] ${reason} Задача: ${rec.taskName}, run #${rec.id}.`);
      activeNonIsolatedRuns = Math.max(0, activeNonIsolatedRuns - 1);
      reaped += 1;
    }
  }
  return reaped;
}

async function runTaskEntry(name: string): Promise<{ alreadyRunning: boolean }> {
  if (shutdownGate.isShuttingDown()) {
    throw new PluginShutdownError(
      "Плагин выгружается: новые запуски не принимаются. Повторите после перезапуска.",
      "Повторите запуск после перезапуска плагина. Для once/cron-задач используйте force-маркер locks/<slug>.lock.force + Start-ScheduledTask (schtasks /run) либо отложенный запуск после перезапуска.",
      shutdownGate.state(),
    );
  }

  // PL-138: до гейта изоляции (PL-106) убираем записи от прошлых убитых обёрток,
  // иначе следующий запуск блокируется локом PL-121 и счётчиком активных ран.
  await reapStaleRuns();

  const trimmed = name.trim();
  const definition = (await loadTaskDefinitions()).find(
    (def) => def.name.toLowerCase() === trimmed.toLowerCase(),
  );

  // B-1.1/PL-125: тот же общий гейт, что и у ОС-планировщика: глобальный
  // бюджет + персональный tokenBudget задачи. Fail-open сохраняется.
  const budgetGate = await checkRunBudgetGate(trimmed, definition?.tokenBudget);
  if (!budgetGate.allowed) {
    throw new Error(budgetGate.message);
  }

  const run = (async () => {
    if (definition?.matrix) {
      await runMatrix(definition);
      return { alreadyRunning: false };
    }

    // PL-106: защита в точке запуска — cron/mcp-event/файл/run_task_now
    // приходят сюда одинаково. Вторая неизолированная задача в том же
    // чек-ауте перезаписывают правки и ломает qualityGate, поэтому отказываем
    // сразу, а не после 585 секунд взаимных перезаписей.
    const isolation = planRuntimeIsolation({
      activeNonIsolated: activeNonIsolatedRuns,
      worktree: definition?.worktree,
      taskName: trimmed,
    });
    if (!isolation.allowed) {
      throw new Error(isolation.reason ?? "PL-106: параллельный запуск без worktree запрещён.");
    }
    if (!isolation.isolated) activeNonIsolatedRuns++;

    // QA-P3.6: если задачи нет ни в определениях, ни в планировщике ОС,
    // не дёргаем schtasks /run — он возвращает сырую ошибку ОС. Возвращаем
    // структурированное «задача не найдена», как и остальные инструменты.
    // Legacy-задачи, живущие только в ОС (без definition), остаются запускаемыми.
    if (!definition) {
      const osTasks = await scheduler.listTasks().catch(() => []);
      const osExists = osTasks.some(
        (task) => (task.taskName ?? "").toLowerCase() === trimmed.toLowerCase(),
      );
      if (!osExists) {
        throw new Error(t("tool.error.taskNotFound", { name: trimmed }));
      }
    }

    // Любой запуск через этот вход — «сейчас», а не «по расписанию»:
    // run_task_now, RPC GUI, файловый триггер, MCP-событие и catch-up.
    // Маркер снимает проверку cron/окна внутри обёртки (poll-режим), иначе
    // запуск молча отменялся бы schedule-gate с кодом 3.
    const forceFile = await requestImmediateRun(name);
    try {
      return await scheduler.runTask(name);
    } catch (err) {
      // Планировщик не принял запуск — маркер не нужен, иначе он мог бы
      // «разрешить» следующий плановый тик в обход расписания.
      await fs.unlink(forceFile).catch(() => {
        /* не критично */
      });
      throw err;
    } finally {
      if (!isolation.isolated) activeNonIsolatedRuns = Math.max(0, activeNonIsolatedRuns - 1);
    }
  })();

  return shutdownGate.track(run);
}

/**
 * Спринт 27.5.3: чтение задач ОС с одним повтором.
 *
 * Сразу после мутации (create/delete/pause/resume) `schtasks /query` иногда
 * отдаёт пустой список, хотя в БД задачи уже есть, или падает. Один короткий
 * retry убирает ложный «задач нет»; если ОС так и не ответила осмысленно —
 * возвращаем `osAvailable: false`, и вызывающий код показывает состояние БД.
 */
async function readOsTasksWithRetry(
  expectNonEmpty: boolean,
  delayMs = 300,
): Promise<{
  tasks: Awaited<ReturnType<typeof scheduler.listTasks>>;
  osAvailable: boolean;
  osError?: string;
}> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      const tasks = await scheduler.listTasks();
      if (tasks.length > 0 || !expectNonEmpty) {
        return { tasks, osAvailable: true };
      }
      lastError = "планировщик ОС вернул пустой список, хотя в БД есть задачи";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { tasks: [], osAvailable: false, osError: lastError };
}

/**
 * Собирает задачи плагина в формате, который отдают оба потребителя:
 * RPC get_tasks (GUI) и инструмент list_tasks (агент).
 *
 * Спринт 27.5.3: возвращает также состояние чтения ОС. Если ОС недоступна,
 * `tasks` — состояние из БД (задачи помечены `orphaned: true`), а не пустой
 * массив: иначе GUI и агент решали бы, что задач нет.
 */
async function collectTasksView() {
  const defs = await loadTaskDefinitions();
  const osRead = await readOsTasksWithRetry(defs.length > 0);
  const tasks = osRead.tasks;

  // Читаем историю один раз, чтобы определить финальный статус по последней записи.
  const history = await loadHistory();
  // loadHistory() отдаёт записи от новых к старым; helper оставляет самую свежую.
  const lastByTask = latestHistoryByTask(history);

  // Определения задач читаются один раз заранее (см. выше) — расписание,
  // повторы, цепочки, директория.
  const workspaces = listWorkspaces();
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));

  // Счётчики запусков по задачам. Основной источник — таблица metrics
  // (накопительные итоги, не зависят от retention истории). Для задач, у
  // которых метрик ещё нет, считаем по загруженной истории.
  const metricsByName = new Map(
    getAllMetrics(true).map((row) => [row.taskName.toLowerCase(), row]),
  );
  const historyCounts = new Map<
    string,
    { total: number; success: number; error: number; partial: number }
  >();
  for (const record of history) {
    const key = record.taskName.toLowerCase();
    const counts = historyCounts.get(key) ?? {
      total: 0,
      success: 0,
      error: 0,
      partial: 0,
    };
    counts.total += 1;
    if (record.status === "success") counts.success += 1;
    else if (record.status === "partial") counts.partial += 1;
    else counts.error += 1;
    historyCounts.set(key, counts);
  }

  // ОС-планировщик — источник истины о запуске, но определения в БД могут
  // существовать без задачи в ОС (сбой удаления, миграция, ручная чистка).
  // Показываем и их, помечая orphaned: раньше такие задачи были невидимы
  // для list_tasks, хотя dry_run/история их видели.
  const osNames = new Set(tasks.map((t) => (t.taskName || "").toLowerCase()));
  const orphanNames = defs
    .filter((def) => !osNames.has(def.name.toLowerCase()))
    .map((def) => def.name);
  const sources: { task: (typeof tasks)[number]; orphaned: boolean }[] = [
    ...tasks.map((task) => ({ task, orphaned: false })),
    ...orphanNames.map((name) => ({
      task: { taskName: name },
      orphaned: true,
    })),
  ];

  const view = sources.map(({ task: t, orphaned }) => {
    // Все бэкенды возвращают короткие имена (без папки планировщика).
    const name = t.taskName || "";

    // Приоритет 1: статус, который сообщает планировщик ОС.
    let status = mapStatus(t.status);

    // Приоритет 2: если последняя запись в истории — error/timeout, перебиваем на error.
    const last = lastByTask.get(name.toLowerCase());
    if (last) {
      if (last.status === "error" || last.status === "timeout") status = "error";
      else if (last.status === "success") status = "success";
      // partial раньше терялся: задача после частичного запуска выглядела
      // как «готова»/«не запускалась», хотя запуск был неуспешным.
      else if (last.status === "partial") status = "partial";
    }

    const def = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    const workspace = def?.workspaceId ? workspaceById.get(def.workspaceId) : undefined;

    // Matrix-родитель: статус = агрегат по клонам (success/error/partial/running).
    const matrixAggregate = def?.matrix ? aggregateMatrixResults(name) : null;
    if (matrixAggregate && matrixAggregate.status !== "empty") {
      status = matrixAggregate.status === "running" ? "running" : matrixAggregate.status;
    }

    // Счётчики именно этой задачи (раньше GUI показывал на каждой карточке
    // общие итоги по всем задачам — отсюда одинаковые 201/130/71).
    const metricsRow = metricsByName.get(name.toLowerCase());
    const counts = metricsRow
      ? {
        total: metricsRow.total,
        success: metricsRow.success,
        error: metricsRow.error,
        partial: metricsRow.partial,
      }
      : historyCounts.get(name.toLowerCase()) ?? {
        total: 0,
        success: 0,
        error: 0,
        partial: 0,
      };

    // Спринт 27.5.2: пауза учитывает и флаг ОС, и активный pausedUntil.
    // nextRun считаем из определения — schtasks после мутации отдаёт
    // nextRunTime с задержкой, из-за чего API показывал null после resume.
    const pausedUntil = def?.pausedUntil ?? null;
    const paused =
      Boolean(t.paused) ||
      def?.paused === true ||
      Boolean(pausedUntil && Date.parse(pausedUntil) > Date.now());

    return {
      name,
      schedule: def?.schedule ?? "",
      /** Hotfix 1.5.3.1: лимит времени задачи (раньше не был виден агенту). */
      timeoutSeconds: def?.timeoutSeconds ?? null,
      status,
      orphaned,
      // Спринт 24 (фикс): явный признак паузы. Раньше GUI пытался вывести его
      // из текстового статуса, но mapStatus() превращает "disabled" в "unknown",
      // поэтому кнопка «возобновить» была недоступна.
      paused,
      runsTotal: counts.total,
      runsSuccess: counts.success,
      runsError: counts.error,
      runsPartial: counts.partial,
      nextRun: paused
        ? null
        : computeTaskNextRun(def) ??
          (t.nextRunTime ? String(t.nextRunTime) : null),
      runAt: def?.runAt ?? null,
      session: def?.session ?? "new",
      sessionId: def?.sessionId ?? null,
      sessionMaxRuns: def?.sessionMaxRuns ?? null,
      sessionRunCount: def?.sessionRunCount ?? 0,
      model: def?.model ?? null,
      priority: def?.priority ?? 5,
      beforeScript: def?.beforeScript ?? null,
      afterScript: def?.afterScript ?? null,
      mcpEvent: def?.mcpEvent ?? null,
      retryCount: def?.retryCount ?? 0,
      retryDelay: def?.retryDelay ?? 0,
      qualityGate: def?.qualityGate ?? null,
      nextTaskOnSuccess: def?.nextTaskOnSuccess ?? null,
      nextTaskOnError: def?.nextTaskOnError ?? null,
      dependsOn: Array.isArray(def?.dependsOn) ? def.dependsOn : [],
      triggerType: def?.triggerType ?? "cron",
      watchPath: def?.watchPath ?? null,
      timezone: def?.timezone ?? null,
      notBefore: def?.notBefore ?? null,
      notAfter: def?.notAfter ?? null,
      pausedUntil: def?.pausedUntil ?? null,
      // Спринт 27.5.4: режим входа — из ОС (Interactive/Background) и из
      // определения (запуск без входа через /ru SYSTEM).
      logonMode: t.logonMode ?? null,
      runWhenLoggedOff: Boolean(def?.runWhenLoggedOff),
      workingDirectory: workspace?.path ?? def?.workingDirectory ?? def?.workdir ?? null,
      workspaceId: workspace?.id ?? def?.workspaceId ?? null,
      workspaceName: workspace?.name ?? null,
      workspaceColor: workspace?.color ?? null,
      allowedTools: Array.isArray(def?.allowedTools) ? def.allowedTools : null,
      deniedTools: Array.isArray(def?.deniedTools) ? def.deniedTools : null,
      matrix: def?.matrix ?? null,
      matrixParentId: def?.matrixParentId ?? null,
      /** Экономика v2 (E-2): лимит токенов на запуск для аналитики дашборда. */
      tokenBudget: def?.tokenBudget ?? null,
      isMatrixParent: Boolean(def?.matrix),
      matrixSummary: matrixAggregate
        ? {
          totalCount: matrixAggregate.totalCount,
          successCount: matrixAggregate.successCount,
          errorCount: matrixAggregate.errorCount,
          pendingCount: matrixAggregate.pendingCount,
          status: matrixAggregate.status,
          message: matrixAggregate.message,
        }
        : null,
      prompt: def?.prompt ?? "",
    };
  });

  return { tasks: view, osAvailable: osRead.osAvailable, osError: osRead.osError };
}

/**
 * Проверяет фильтр MCP-события.
 *
 * Поддерживаются два формата:
 *  - `key=value` — сравнивается с верхнеуровневым полем payload (регистр значения важен);
 *  - regex/подстрока — проверяется по сериализованному payload (без учёта регистра).
 * Пустой фильтр пропускает любое событие.
 */
function matchesEventFilter(filter: string | undefined, payload: unknown): boolean {
  const raw = (filter ?? "").trim();
  if (!raw) return true;

  let text: string;
  try {
    text = JSON.stringify(payload ?? {});
  } catch {
    text = safeStringify(payload ?? "");
  }

  const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(raw);
  if (pair && payload !== null && typeof payload === "object") {
    const fieldValue = (payload as Record<string, unknown>)[pair[1]];
    const expected = pair[2].trim().replace(/^["']|["']$/g, "");
    return safeStringify(fieldValue ?? "") === expected;
  }

  try {
    return new RegExp(raw, "i").test(text);
  } catch {
    return text.toLowerCase().includes(raw.toLowerCase());
  }
}

/** Превращает текстовый статус планировщика в короткий статус для GUI. */
function mapStatus(status?: string): string {
  if (!status) return "unknown";
  const s = status.toLowerCase();
  if (s.includes("running") || s.includes("выполняется")) return "running";
  // "Ready" в планировщике Windows означает лишь «готова к запуску», а не
  // успешное выполнение. Раньше такие задачи показывались зелёными, хотя
  // могли ни разу не запускаться.
  if (s.includes("ready") || s.includes("готов")) return "idle";
  if (s.includes("disabled")) return "unknown";
  return "unknown";
}
