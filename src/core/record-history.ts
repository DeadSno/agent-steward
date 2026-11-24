import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTaskNow } from "./scheduler/run-now.js";
import { createSchedulerBackend } from "./scheduler/index.js";
import { notifyTaskCompletion } from "../notifications.js";
import {
  finishRun,
  getHistoryForBudget,
  getLatestHistoryByTask,
  isProcessAlive,
  listRunningRecords,
  normalizeErrorText,
  recordRun,
  startRun,
} from "../db/history-repo.js";
import { getDb, withTransaction } from "../db/index.js";
import { markInterruptedRunWithPartialEdits } from "../db/run-journal.js";
import { deleteSetting, decrementCounterSetting } from "../db/settings-repo.js";
import { getTask, listTasks } from "../db/tasks-repo.js";
import { loadSettings } from "../settings.js";
import {
  BUDGET_GATE_SKIP_EXIT_CODE,
  evaluateRunBudgetGate,
  startOfUtcWeek,
} from "./budget.js";
import {
  createRun,
  finishRun as finishDurableRun,
  finishStep,
  findRunByMetadata,
  getStep,
} from "../db/runs-repo.js";
import {
  createRegisteredRunContext,
  triggerKindFor,
  validateRunContext,
  writeGateOutcome,
  type RunContext,
} from "./execution.js";
import { extractLastRunLog } from "./mission.js";
import { rotateSessionIfNeeded } from "./session.js";
import type { TaskDefinition } from "../task-transfer.js";
import type { HistoryRecord } from "../history.js";
import {
  advanceMatrixAfterClone,
  finalizeMatrixIfComplete,
} from "./matrix.js";
import { appendStructuredLog } from "./structured-log.js";
import { collectOpenCodeUsage } from "./opencode-usage.js";
import { catalogPricePerMillion } from "./opencode-models.js";
import { estimateRunUsage } from "./usage-surface.js";

type Status = "success" | "error" | "timeout" | "skipped";

/**
 * Диагностика рекордера пишется в runs.jsonl: цепочки, DAG, повторы и
 * one-shot-очистка иначе не видны в машиночитаемом логе. Human-readable
 * вывод остаётся только в логе задачи; stdout `--start` не трогаем — обёртка
 * читает оттуда runId.
 */
function logRecorderEvent(
  event: string,
  task: string,
  details: {
    runId?: number;
    status?: string;
    error?: string;
    reason?: string;
    nextTask?: string;
  } = {},
): void {
  appendStructuredLog({
    event,
    task,
    runId: details.runId,
    status: details.status,
    error: details.error,
    reason: details.reason,
    nextTask: details.nextTask,
  });
}

/* ------------------------------------------------------------------------- *
 * PL-63: закрытие осиротевших запусков на старте рекордера.
 *
 * Crash recovery плагина (recoverInterruptedRuns) срабатывает при setup() и
 * при выдаче истории, но если плагин перезагрузили, а рекордер уже успел
 * создать --start-запись, она может сутки оставаться `running` (ARCH-7 ~49 ч).
 * Поэтому перед созданием новой записи рекордер сам закрывает просроченные
 * running-записи как interrupted и помечает возможные частичные правки.
 * ------------------------------------------------------------------------- */

/** Порог по умолчанию, если у задачи нет собственного timeoutSeconds. */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 3600;

export interface RecoverStaleRunningOptions {
  /** Текущий момент (для тестов). */
  now?: Date;
  /** Порог для задач без timeoutSeconds. */
  defaultTimeoutSeconds?: number;
  /** Источник определения задачи (для тестов). */
  getDefinition?: (name: string) => TaskDefinition | undefined;
  /** Проверка жив ли владелец запуска (для тестов). */
  isAlive?: (pid: number) => boolean;
  /** Имя хоста, с которым сравнивается owner_host (для тестов). */
  hostname?: string;
}

export interface InterruptedRunningRecord {
  historyRunId: number;
  taskName: string;
  timeoutSeconds: number;
  durableRunId: string | null;
  partialWorktreeEdits: boolean;
  error: string;
  /** Причина закрытия: истёк таймаут или владелец завершён (PL-124). */
  cause: "timeout" | "deadOwner";
}

export interface RecoverStaleRunningResult {
  /** Сколько незавершённых записей проверено. */
  scanned: number;
  /** Сколько закрыто как interrupted. */
  recovered: number;
  /** Сколько оставлено running (порог не истёк). */
  keptAlive: number;
  /** Сколько закрыто по мёртвому владельцу (PL-124). */
  deadOwner: number;
  interrupted: InterruptedRunningRecord[];
}

/**
 * На старте рекордера находит `running`-записи старше timeoutSeconds задачи,
 * закрывает их как `interrupted` и помечает частичные правки в worktree.
 * Повтор не запускается автоматически — нужен явный ре-ран задачи.
 */
export function recoverStaleRunningOnRecorderStart(
  options: RecoverStaleRunningOptions = {},
): RecoverStaleRunningResult {
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const configuredDefault = options.defaultTimeoutSeconds;
  const defaultSeconds =
    typeof configuredDefault === "number" &&
    Number.isFinite(configuredDefault) &&
    configuredDefault > 0
      ? Math.floor(configuredDefault)
      : DEFAULT_RUN_TIMEOUT_SECONDS;
  const definitionOf = options.getDefinition ?? getTask;
  const isAlive = options.isAlive ?? isProcessAlive;
  const hostname = options.hostname ?? os.hostname();
  const running = listRunningRecords();
  const result: RecoverStaleRunningResult = {
    scanned: running.length,
    recovered: 0,
    keptAlive: 0,
    deadOwner: 0,
    interrupted: [],
  };
  if (running.length === 0) return result;

  const close = getDb().prepare(
    `UPDATE history SET status = 'interrupted', error = ?, finished_at = ?,
       duration_ms = ? WHERE id = ? AND finished_at IS NULL`,
  );
  const ownerOf = getDb().prepare(
    "SELECT owner_pid, owner_host FROM history WHERE id = ?",
  );

  withTransaction(() => {
    for (const record of running) {
      const taskTimeout = definitionOf(record.taskName)?.timeoutSeconds;
      const seconds =
        typeof taskTimeout === "number" && Number.isFinite(taskTimeout) && taskTimeout > 0
          ? Math.floor(taskTimeout)
          : defaultSeconds;
      const started = Date.parse(record.startedAt);
      const ageMs = Number.isFinite(started) ? Math.max(0, now.getTime() - started) : 0;

      // PL-124: живой владелец с истёкшим таймаутом закрывается по старой
      // age-логике (PL-63), но мёртвый владелец того же хоста закрывается сразу —
      // иначе запись висит running до следующего запуска рекордера/плагина.
      const owner = ownerOf.get(record.id) as
        | { owner_pid: number | bigint | null; owner_host: string | null }
        | undefined;
      const ownerPid = owner?.owner_pid == null ? null : Number(owner.owner_pid);
      const ownerHost = owner?.owner_host == null ? null : String(owner.owner_host);
      const verifiableOwner =
        ownerPid != null &&
        Number.isFinite(ownerPid) &&
        ownerPid > 0 &&
        ownerHost === hostname;
      if (verifiableOwner && !isAlive(ownerPid)) {
        const error = `PL-124: владелец завершён (pid=${ownerPid}), запуск оставался running; возможны частичные правки в worktree; требуется явный повтор`;
        close.run(error, timestamp, ageMs, record.id);
        const durable = findRunByMetadata("registeredHistoryId", record.id);
        result.recovered += 1;
        result.deadOwner += 1;
        result.interrupted.push({
          historyRunId: record.id,
          taskName: record.taskName,
          timeoutSeconds: seconds,
          durableRunId: durable?.id ?? null,
          partialWorktreeEdits: true,
          error,
          cause: "deadOwner",
        });
        logRecorderEvent("run.interrupted_dead_owner", record.taskName, {
          runId: record.id,
          status: "interrupted",
          reason: `PL-124; pid=${ownerPid}; durableRunId=${durable?.id ?? "none"}; explicitRetryRequired=true`,
        });
        continue;
      }

      if (ageMs < seconds * 1000) {
        result.keptAlive += 1;
        continue;
      }

      const error = `Прервано: запуск старше timeoutSeconds=${seconds}с; возможны частичные правки в worktree; требуется явный повтор`;
      close.run(error, timestamp, ageMs, record.id);
      const durable = findRunByMetadata("registeredHistoryId", record.id);
      result.recovered += 1;
      result.interrupted.push({
        historyRunId: record.id,
        taskName: record.taskName,
        timeoutSeconds: seconds,
        durableRunId: durable?.id ?? null,
        partialWorktreeEdits: true,
        error,
        cause: "timeout",
      });
      logRecorderEvent("run.interrupted_partial", record.taskName, {
        runId: record.id,
        status: "interrupted",
        reason: `timeoutSeconds=${seconds}; durableRunId=${durable?.id ?? "none"}; explicitRetryRequired=true`,
      });
    }
  });

  // Durable-слой закрываем отдельно: сбой журнала не должен откатывать историю.
  for (const item of result.interrupted) {
    if (!item.durableRunId) continue;
    markInterruptedRunWithPartialEdits(item.durableRunId, {
      error: item.error,
      now: timestamp,
      partialWorktreeEdits: item.partialWorktreeEdits,
    });
  }

  return result;
}

/* ------------------------------------------------------------------------- *
 * ARCH-1.1/1.2/1.3: мост «зарегистрированная задача → durable-run путь».
 *
 * Рекордер раньше писал только history-таблицу. Теперь он строит RunContext из
 * определения задачи и проходит через createRun → finishStep → gate_outcomes —
 * тот же путь, что и ad-hoc миссия в core/execution.ts. Все вызовы защищены
 * try/catch: отказ durable-слоя не должен ломать историю/цепочки/уведомления.
 * ------------------------------------------------------------------------- */

export interface RegisteredRunBridge {
  runId: string;
  stepId: string | null;
  verdict: "pass" | "fail" | null;
}

export interface RecordRegisteredRunOptions {
  /** Id history-записи из --start; связывается с durable UUID через metadata. */
  historyRunId?: number | null;
  status: "passed" | "failed" | "skipped";
  error?: string | null;
  /** ARCH-1.3: путь к лог-файлу задачи — provenance записи гейта. */
  evidencePath?: string | null;
  gateType?: string | null;
  executor?: string | null;
}

/** Строит общий RunContext из определения зарегистрированной задачи. */
export function buildRegisteredContext(taskName: string): RunContext | null {
  try {
    const definition = getTask(taskName);
    if (!definition) return null;
    const context = createRegisteredRunContext(definition);
    validateRunContext(context);
    return context;
  } catch (err) {
    logRecorderEvent("durable.context_failed", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * ARCH-1.1: создаёт durable run через тот же createRun, что и ad-hoc путь.
 * Шаг создаётся сразу в `running`: STEP_TRANSITIONS разрешает running → passed,
 * но не pending → passed (иначе finishStep упал бы с InvalidTransitionError).
 */
export function beginRegisteredRun(
  context: RunContext,
  historyRunId?: number | null,
  options: { startedAt?: string } = {},
): string | null {
  try {
    validateRunContext(context);
    const stepName = context.taskName;
    const run = createRun({
      taskName: context.taskName,
      status: "running",
      ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      workspaceId: context.profile.workspaceId ?? null,
      steps: [{ stepName, status: "running" }],
      metadata: {
        origin: "registered",
        trigger: context.trigger,
        triggerKind: triggerKindFor(context),
        registeredHistoryId: historyRunId ?? null,
        ...(context.metadata ?? {}),
      },
    });
    logRecorderEvent("durable.run_started", context.taskName, {
      runId: historyRunId ?? undefined,
      reason: `durableRunId=${run.id}`,
    });
    return run.id;
  } catch (err) {
    logRecorderEvent("durable.run_start_failed", context.taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Завершает durable run, начатый в --start (или создаёт новый для legacy-пути),
 * и пишет вердикт гейта в единый ledger. Возвращает bridge с UUID и verdict.
 */
export function recordRegisteredRun(
  context: RunContext,
  options: RecordRegisteredRunOptions,
): RegisteredRunBridge | null {
  try {
    validateRunContext(context);
    const taskName = context.taskName;
    const existing =
      options.historyRunId != null
        ? findRunByMetadata("registeredHistoryId", options.historyRunId)
        : undefined;
    const runId =
      existing?.id ?? beginRegisteredRun(context, options.historyRunId ?? null);
    if (!runId) return null;

    const stepName = taskName;
    const step = getStep(runId, stepName);
    let verdict: "pass" | "fail" | null = null;
    if (step && options.status !== "skipped") {
      finishStep(
        step.id,
        options.status === "failed" ? "failed" : "passed",
        options.error ? { error: options.error } : {},
      );
      verdict = options.status === "failed" ? "fail" : "pass";
      writeGateOutcome({
        context,
        runId,
        stepId: step.id,
        stepName,
        taskType: context.taskType ?? null,
        executor: options.executor ?? "registered-recorder",
        gateType:
          options.gateType ??
          (typeof context.metadata?.qualityGate === "string"
            ? context.metadata.qualityGate
            : null),
        verdict,
        attempt: step.attempt,
        firstPass: step.attempt === 1 && verdict === "pass",
        evidencePath: options.evidencePath ?? null,
      });
    } else if (step) {
      finishStep(step.id, "skipped", options.error ? { error: options.error } : {});
    }

    const runStatus =
      options.status === "failed"
        ? "failed"
        : options.status === "skipped"
          ? "cancelled"
          : "passed";
    finishDurableRun(runId, runStatus, options.error ? { error: options.error } : {});
    logRecorderEvent("durable.run_finished", taskName, {
      runId: options.historyRunId ?? undefined,
      reason: `durableRunId=${runId}`,
      status: options.status,
      error: options.error ?? undefined,
    });
    return { runId, stepId: step?.id ?? null, verdict };
  } catch (err) {
    logRecorderEvent("durable.run_finish_failed", context.taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Префикс ключа настроек со счётчиком повторов конкретной задачи. */
const RETRY_STATE_PREFIX = "retry_state:";

function retryStateKey(taskName: string): string {
  return `${RETRY_STATE_PREFIX}${taskName.toLowerCase()}`;
}

/** Сколько последних строк лога сканировать при поиске токенов/стоимости. */
const LOG_TAIL_LINES = 500;

/**
 * Читает последние `maxLines` строк текстового файла.
 * Возвращает пустой массив, если файл недоступен.
 */
function readLogTail(filePath: string, maxLines: number): string[] {
  try {
    // Токены/стоимость относятся к завершаемому запуску; старые прогоны
    // в том же файле лога не должны портить оценку (QA-F.1).
    const content = extractLastRunLog(fs.readFileSync(filePath, "utf8"));
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** T-6.2: текст последнего прогона для офлайн-оценки расхода (срез, чтобы не читать гигабайты). */
function readLogTextForEstimate(filePath: string | undefined): string {
  if (!filePath) return "";
  try {
    const content = extractLastRunLog(fs.readFileSync(filePath, "utf8"));
    return content.length > 256_000 ? content.slice(-256_000) : content;
  } catch {
    return "";
  }
}

export interface UsageInfo {
  tokens?: number;
  costUsd?: number;
}

const USAGE_PREFIX = "^\\s*(?:\\[.*?\\]\\s*)?";
const TOKEN_PATTERNS: RegExp[] = [
  new RegExp(USAGE_PREFIX + "(?:tokens?|token\\s+usage|usage)\\s*[:=]\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b", "i"),
  new RegExp(USAGE_PREFIX + "(?:input|output|total)\\s+tokens?\\s*[:=]?\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b", "i"),
];
const COST_PATTERNS: RegExp[] = [
  new RegExp(USAGE_PREFIX + "(?:cost|total\\s+cost)\\s*[:=]?\\s*\\$\\s*([0-9]+(?:[.,][0-9]+)?)", "i"),
  new RegExp(USAGE_PREFIX + "(?:cost|total\\s+cost)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)", "i"),
  // QA-F.1: OpenCode печатает costUsd=0.1 / cost=0.25 без валютного знака —
  // старые шаблоны требовали `$` перед числом или `usd` после, поэтому
  // стоимость терялась и в метриках/аналитике оставалась нулевой.
  new RegExp(USAGE_PREFIX + "(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*\\$?\\s*([0-9]+(?:[.,][0-9]+)?)", "i"),
  new RegExp(USAGE_PREFIX + "(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)", "i"),
];

function parseUsageValue(raw: string, suffix?: string): number | undefined {
  const value = parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(value)) return undefined;
  let mult = 1;
  if (suffix) {
    const s = suffix.toLowerCase();
    if (s === "k") mult = 1000;
    else if (s === "m") mult = 1000000;
  }
  return Math.round(value * mult);
}

/**
 * Извлекает информацию о расходе токенов и стоимости из хвоста лога задачи.
 * Шаблоны «якорные»: метка должна стоять в начале строки (допускается префикс
 * времени лога), чтобы не ловить конфиг-дампы и прочую прозу ИИ.
 * Идёт с конца: OpenCode печатает итог последним.
 */
export function parseUsageFromLog(logFile: string): UsageInfo {
  const result: UsageInfo = {};
  if (!logFile) return result;

  const lines = readLogTail(logFile, LOG_TAIL_LINES);
  if (!lines.length) return result;

  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i];
    if (/opencode\.json|OPENCODE_CONFIG/i.test(text)) continue;

    if (result.tokens === undefined) {
      for (const pattern of TOKEN_PATTERNS) {
        const m = text.match(pattern);
        if (m) {
          const v = parseUsageValue(m[1], m[2]);
          if (v !== undefined) { result.tokens = v; break; }
        }
      }
    }

    if (result.costUsd === undefined) {
      for (const pattern of COST_PATTERNS) {
        const m = text.match(pattern);
        if (m) {
          result.costUsd = parseFloat(m[1].replace(",", "."));
          break;
        }
      }
    }

    if (result.tokens !== undefined && result.costUsd !== undefined) break;
  }

  return result;
}

/**
 * PL-38: если обёртка не передала usage, а логи его не содержат, берём
 * показания из собственной БД OpenCode за окно запуска задачи. Результат
 * консервативный: уже найденные значения не перезаписываются, нули не подменяются.
 */
function resolveUsageFromOpenCodeDb(
  taskName: string,
  startedAtIso: string,
  durationMs: number,
  fallback: UsageInfo,
): UsageInfo {
  if (fallback.tokens !== undefined && fallback.costUsd !== undefined) return fallback;

  const definition = getTask(taskName);
  const end = Date.now();
  const parsedStart = Date.parse(startedAtIso);
  const start = Number.isFinite(parsedStart) ? parsedStart : end - Math.max(0, durationMs);
  // +-2 с покрывают рассинхрон часов обёртки и движка OpenCode.
  const usage = collectOpenCodeUsage({
    since: start - 2000,
    until: end + 2000,
    cwd: definition?.workingDirectory,
  });
  if (!usage || (usage.tokens <= 0 && usage.costUsd <= 0)) return fallback;

  const resolved: UsageInfo = {
    tokens: fallback.tokens ?? (usage.tokens > 0 ? usage.tokens : undefined),
    costUsd: fallback.costUsd ?? (usage.costUsd > 0 ? usage.costUsd : undefined),
  };
  logRecorderEvent("usage.from_opencode_db", taskName, {
    reason: `tokens=${usage.tokens} cost=${usage.costUsd} messages=${usage.messages}`,
  });
  return resolved;
}

/**
 * T-6.2: если ни обёртка, ни лог, ни OpenCode DB не дали ненулевого usage
 * (типично для free-тиров), подставляем детерминированную офлайн-оценку.
 * Уже найденные значения не перезаписываются; цена берётся из каталога моделей.
 */
function resolveUsageWithOfflineFallback(
  taskName: string,
  startedAtIso: string,
  durationMs: number,
  fallback: UsageInfo,
  logFile: string | undefined,
  model: string | undefined,
): UsageInfo {
  const resolved = resolveUsageFromOpenCodeDb(taskName, startedAtIso, durationMs, fallback);
  if (resolved.tokens !== undefined && resolved.costUsd !== undefined) return resolved;

  const definition = getTask(taskName);
  const estimate = estimateRunUsage({
    prompt: definition?.prompt,
    logText: readLogTextForEstimate(logFile),
    pricePerMillion: catalogPricePerMillion(model ?? definition?.model),
  });
  if (estimate.tokens <= 0) return resolved;

  const result: UsageInfo = {
    tokens: resolved.tokens ?? estimate.tokens,
    costUsd: resolved.costUsd ?? estimate.costUsd,
  };
  logRecorderEvent("usage.offline_estimate", taskName, {
    reason: `tokens=${estimate.tokens} input=${estimate.inputTokens} output=${estimate.outputTokens} cost=${estimate.costUsd ?? "unknown"}`,
  });
  return result;
}

/**
 * Ищет настройку повторов задачи в БД.
 * Возвращает 0, если повторы не настроены.
 */
async function loadRetryConfig(taskName: string): Promise<{ count: number; delay: number }> {
  const definition = getTask(taskName);
  const count = Math.max(0, Math.floor(Number(definition?.retryCount) || 0));
  const delay = Math.max(1, Math.floor(Number(definition?.retryDelay) || 60));
  return { count, delay };
}

/**
 * Запускает задачу по имени через бэкенд планировщика текущей ОС
 * (schtasks / crontab / launchd). Используется цепочками задач
 * (nextTaskOnSuccess / nextTaskOnError).
 */
async function triggerTask(taskName: string): Promise<boolean> {
  try {
    await runTaskNow(taskName);
    return true;
  } catch (err: unknown) {
    logRecorderEvent("chain.trigger_failed", taskName, {
      nextTask: taskName,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/*
 * P2-30: раньше счётчики повторов лежали одним JSON-объектом в настройках.
 * Каждое завершение задачи — отдельный процесс record-history, поэтому
 * параллельные завершения перезаписывали map и теряли декременты. Теперь
 * на задачу отдельный ключ и атомарный UPDATE ... RETURNING.
 */

/**
 * Планирует повторный запуск упавшей задачи.
 *
 * Сам процесс record-history вызывается из PowerShell-обёртки синхронно
 * (`& node ... "), поэтому ждать задержку внутри него нельзя: обёртка
 * не завершится и не снимет lock-файл. Вместо этого запускаем отдельный
 * detached-процесс, который спит retryDelay секунд и вызывает schtasks /run.
 */
async function scheduleRetry(taskName: string): Promise<boolean> {
  try {
    const { count, delay } = await loadRetryConfig(taskName);
    if (count <= 0) return false;

    const key = retryStateKey(taskName);
    const remaining = decrementCounterSetting(key, count);

    if (remaining === null) {
      deleteSetting(key);
      logRecorderEvent("retry.exhausted", taskName, { reason: "retries exhausted" });
      return false;
    }

    const script = process.argv[1];
    if (!script) return false;

    // Отвязываем дочерний процесс от текущего: родитель (PowerShell) должен
    // завершиться сразу, а повтор — сработать позже независимо от него.
    const child = spawn(process.execPath, [script, "--retry", taskName, String(delay)], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();

    logRecorderEvent("retry.scheduled", taskName, {
      reason: `delay=${delay}s, remaining=${remaining}`,
    });
    return true;
  } catch (err: unknown) {
    logRecorderEvent("retry.schedule_failed", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Режим `--retry <taskName> <delaySec>`: ждёт задержку и запускает задачу
 * через бэкенд планировщика. Статус исхода запишет уже сама обёртка задачи.
 */
async function runRetry(taskName: string, delaySec: number): Promise<void> {
  if (!taskName) process.exit(1);
  const delay = Math.max(1, Math.floor(Number(delaySec) || 60));
  await new Promise<void>((resolve) => setTimeout(resolve, delay * 1000));

  try {
    await runTaskNow(taskName);
    logRecorderEvent("retry.started", taskName);
  } catch (err: unknown) {
    logRecorderEvent("retry.failed", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Возвращает имена задач из БД, которые пора запустить после успешного
 * завершения `completedTask` (DAG-зависимости).
 *
 * Правила:
 *  - у задачи есть непустой dependsOn, и в нём упомянута completedTask;
 *  - каждая зависимость имеет в истории последнюю запись со статусом success;
 *  - зависимая задача ещё НЕ запускалась после завершения своих зависимостей
 *    (иначе граф зациклится и будет перезапускать её на каждом завершении).
 */
export function selectDependentsToTrigger(
  completedTask: string,
  definitions: TaskDefinition[],
  history: HistoryRecord[],
): string[] {
  const key = (value: string) => value.trim().toLowerCase();

  // История хранится от новых к старым: первая запись задачи — самая свежая.
  const latestByTask = new Map<string, HistoryRecord>();
  for (const record of history) {
    const k = key(record.taskName);
    if (!latestByTask.has(k)) latestByTask.set(k, record);
  }

  const toTrigger: string[] = [];
  const defsByKey = new Map<string, TaskDefinition>();
  for (const definition of definitions) {
    defsByKey.set(key(definition.name), definition);
  }

  for (const definition of definitions) {
    const deps = (Array.isArray(definition.dependsOn) ? definition.dependsOn : [])
      .map((dep) => (typeof dep === "string" ? dep.trim() : ""))
      .filter(Boolean);
    if (deps.length === 0) continue;
    if (key(definition.name) === key(completedTask)) continue;
    if (!deps.some((dep) => key(dep) === key(completedTask))) continue;

    let allSuccess = true;
    let latestDependencyFinished = 0;
    for (const dep of deps) {
      // Matrix (Спринт 15): зависимость-матрица считается выполненной только
      // когда успешны ВСЕ её клоны (у самого родителя истории нет).
      const depDefinition = defsByKey.get(key(dep));
      const clones = depDefinition?.matrix
        ? definitions.filter(
          (item) =>
            item.matrixParentId && key(item.matrixParentId) === key(dep),
        )
        : [];
      const requiredNames = clones.length > 0 ? clones.map((c) => c.name) : [dep];

      for (const requiredName of requiredNames) {
        const record = latestByTask.get(key(requiredName));
        if (record?.status !== "success") {
          allSuccess = false;
          break;
        }
        const finished = new Date(record.finishedAt ?? 0).getTime();
        if (Number.isFinite(finished)) {
          latestDependencyFinished = Math.max(latestDependencyFinished, finished);
        }
      }
      if (!allSuccess) break;
    }
    if (!allSuccess) continue;

    // Защита от повторного запуска: если зависимая задача уже стартовала
    // после успешного завершения последней зависимости — не трогаем её.
    const own = latestByTask.get(key(definition.name));
    if (own) {
      const ownStarted = new Date(own.startedAt).getTime();
      if (Number.isFinite(ownStarted) && ownStarted >= latestDependencyFinished) {
        continue;
      }
    }

    toTrigger.push(definition.name);
  }

  // Приоритеты: при готовности нескольких задач первыми запускаем более важные.
  const priorityByTask = new Map<string, number>();
  for (const definition of definitions) {
    priorityByTask.set(key(definition.name), Number(definition.priority) || 5);
  }
  return toTrigger.sort(
    (a, b) => (priorityByTask.get(key(b)) ?? 5) - (priorityByTask.get(key(a)) ?? 5),
  );
}

/**
 * B-1.1: общая запись пропуска и в историю, и в durable-слой. Используется
 * guard-пропуском (`--skip`) и бюджетным гейтом registered-пути
 * (`--budget-gate`), чтобы причина была видна в get_history в обоих случаях.
 */
async function recordSkippedRun(
  taskName: string,
  reason: string,
  evidencePath?: string,
  durationMs = 0,
): Promise<void> {
  const safeDuration = Math.max(0, durationMs);
  const finishedAt = new Date().toISOString();
  const startedAt = new Date(Date.now() - safeDuration).toISOString();
  const definition = getTask(taskName);
  recordRun(
    taskName,
    "skipped",
    startedAt,
    safeDuration,
    reason,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    finishedAt,
    definition?.workspaceId ?? null,
    definition?.allowedTools ?? null,
    definition?.deniedTools ?? null,
  );
  const skipContext = buildRegisteredContext(taskName);
  if (skipContext) {
    recordRegisteredRun(skipContext, {
      status: "skipped",
      error: reason,
      evidencePath,
    });
  }
  await handleCompletion(taskName, "skipped", null, reason, safeDuration);
}

/** Причину пропуска пишем и в лог задачи, и в историю (см. recordSkippedRun). */
function writeBudgetGateReason(
  taskName: string,
  reason: string,
  logFile?: string,
): void {
  const line = `[agent-steward] B-1.1: budget gate skipped '${taskName}': ${reason}`;
  if (logFile?.trim()) {
    try {
      fs.appendFileSync(logFile.trim(), `${line}\r\n`, "utf8");
      return;
    } catch {
      // Лог недоступен — причина всё равно попадёт в историю запусков.
    }
  }
  console.log(line);
}

async function main() {
  const [
    ,
    ,
    first,
    second,
    third,
    fourth,
    fifth,
    sixth,
    seventh,
    eighth,
    ninth,
    tenth,
    eleventh,
    twelfth,
  ] = process.argv;

  // Режим повтора: node record-history.js --retry "<task>" <delaySec>
  if (first === "--retry") {
    await runRetry(second, Number(third));
    return;
  }

  /**
   * W-4: режим пропуска — node record-history.js --skip "<task>" "<reasonB64>" "<logFile>" [durationMs]
   * Вызывается обёртками при срабатывании guard (код 4). Причина передаётся
   * base64, чтобы не подставлять произвольный текст в командную строку. Пропуск
   * попадает в историю и total-метрику, но не считается ошибкой, не шлёт
   * уведомление, не запускает цепочки/повторы и не запускает DAG.
   */
  if (first === "--skip") {
    const taskName = second;
    if (!taskName) process.exit(1);
    let reason = "guard conditions not met";
    if (third) {
      try {
        const decoded = Buffer.from(third, "base64").toString("utf8").trim();
        if (decoded) reason = decoded;
      } catch {
        // Битая base64 — оставляем причину по умолчанию.
      }
    }
    const durationMs = Math.max(0, Number(fifth) || 0);
    await recordSkippedRun(taskName, reason, fourth, durationMs);
    return;
  }

  /**
   * PL-125/B-1.1: жёсткий бюджетный гейт на registered-пути. Вызывается .cmd-
   * обёрткой ДО PowerShell/opencode run. Код 3 = штатный пропуск (записываем
   * skipped + причину), любые ошибки проверки — fail-open (запуск идёт).
   *
   * node record-history.js --budget-gate "<task>" "<logFile>"
   */
  if (first === "--budget-gate") {
    const taskName = second;
    if (!taskName) process.exit(1);
    try {
      const settings = await loadSettings();
      const now = new Date();
      // Неделя — widest период; тот же источник, что и в index.ts.
      const records = getHistoryForBudget(startOfUtcWeek(now).toISOString());
      const definition = getTask(taskName);
      const decision = evaluateRunBudgetGate(
        records,
        settings.budgets,
        taskName,
        definition?.tokenBudget,
        now,
      );
      if (decision.allowed) return;
      const reason = decision.message || "budget limit exceeded";
      writeBudgetGateReason(taskName, reason, third);
      await recordSkippedRun(taskName, reason, third);
      process.exitCode = BUDGET_GATE_SKIP_EXIT_CODE;
      return;
    } catch (err) {
      // Fail-open: сбой чтения настроек/БД не должен блокировать cron-запуск.
      console.error(
        `[agent-steward] budget gate недоступен, запуск разрешён: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
  }

  const parseOptionalNumber = (value?: string): number | undefined => {
    if (!value || value === "-") return undefined;
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const parseHookStatus = (
    value?: string,
  ): "success" | "error" | "skipped" | undefined => {
    if (!value || value === "-") return undefined;
    if (value === "success" || value === "error" || value === "skipped") return value;
    return undefined;
  };

  /**
   * Режим старта: node record-history.js --start "<task>" "<startedAtIso>"
   * Создаёт незавершённую запись (finished_at = NULL) и печатает её id.
   * Обёртка передаёт id в --finish; если процесс убили, останется NULL и
   * crash recovery при следующем старте плагина пометит запись как error.
   */
  if (first === "--start") {
    const taskName = second;
    if (!taskName) process.exit(1);
    // PL-63: до создания новой записи закрываем осиротевшие running-запуски.
    // Иначе прерванный прогон висит до принудительного recover (~49 ч у ARCH-7).
    const staleRecovery = recoverStaleRunningOnRecorderStart();
    if (staleRecovery.recovered > 0) {
      logRecorderEvent("recorder.start_recovery", taskName, {
        reason: `interrupted=${staleRecovery.recovered}; keptAlive=${staleRecovery.keptAlive}`,
      });
    }
    const startedAt = third ?? new Date().toISOString();
    const definition = getTask(taskName);
    // Владелец — процесс-обёртка, запустивший recorder. Он живёт дольше
    // короткоживущего recorder'а, поэтому именно его PID проверяет recovery.
    const owner = {
      pid: process.ppid && process.ppid > 0 ? process.ppid : null,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
    };
    const runId = startRun(
      taskName,
      startedAt,
      definition?.workspaceId ?? null,
      definition?.allowedTools ?? null,
      definition?.deniedTools ?? null,
      owner,
    );
    // ARCH-1.1: та же задача идёт через durable createRun. stdout не трогаем —
    // обёртка читает оттуда ТОЛЬКО history id.
    const startContext = buildRegisteredContext(taskName);
    if (startContext) beginRegisteredRun(startContext, runId, { startedAt });
    console.log(String(runId));
    return;
  }

  /**
   * Режим завершения: --finish <id> <task> <status> <durationMs> <error>
   * <tokens> <cost> <model> <preFlight> <postFlight>
   */
  if (first === "--finish") {
    const runId = Number(second);
    const taskName = third;
    const status = fourth;
    if (!Number.isFinite(runId) || runId <= 0 || !taskName || !status) {
      process.exit(1);
    }
    const durationMs = Number(fifth) || 0;
    const error = normalizeErrorText(sixth);
    // 12-й аргумент — путь к лог-файлу задачи (добавлен в T-08 / D-08).
    const logFile = twelfth;
    const tokens = parseOptionalNumber(seventh);
    const costUsd = parseOptionalNumber(eighth);
    // Если обёртка не передала токены/стоимость ("-"), пробуем распарсить из лога.
    // Это даёт одинаковое поведение для Windows (ps-wrapper) и POSIX (bash).
    let tokensResolved = tokens;
    let costResolved = costUsd;
    if ((tokensResolved === undefined || costResolved === undefined) && logFile) {
      const usage = parseUsageFromLog(logFile);
      if (tokensResolved === undefined && usage.tokens !== undefined) {
        tokensResolved = usage.tokens;
      }
      if (costResolved === undefined && usage.costUsd !== undefined) {
        costResolved = usage.costUsd;
      }
    }
    const model = ninth && ninth !== "-" ? ninth.trim() || undefined : undefined;
    // --finish не получает startedAt: восстанавливаем окно из длительности.
    if (tokensResolved === undefined || costResolved === undefined) {
      const approximatedStart = new Date(Date.now() - Math.max(0, durationMs)).toISOString();
      const usage = resolveUsageWithOfflineFallback(
        taskName,
        approximatedStart,
        durationMs,
        { tokens: tokensResolved, costUsd: costResolved },
        logFile,
        model,
      );
      tokensResolved = usage.tokens;
      costResolved = usage.costUsd;
    }
    const preFlightStatus = parseHookStatus(tenth);
    const postFlightStatus = parseHookStatus(eleventh);
    const st: Status =
      status === "success" ? "success" : status === "timeout" ? "timeout" : status === "skipped" ? "skipped" : "error";

    const definition = getTask(taskName);
    const chainTarget =
      st === "success"
        ? definition?.nextTaskOnSuccess || null
        : st === "skipped"
          ? null
          : definition?.nextTaskOnError || null;

    const completed = finishRun(
      runId,
      st,
      durationMs,
      error,
      chainTarget,
      tokensResolved,
      costResolved,
      model,
      preFlightStatus,
      postFlightStatus,
    );
    if (!completed) {
      logRecorderEvent("run.finish_skipped", taskName, {
        runId,
        reason: "already finished or not found",
      });
      return;
    }

    // ARCH-1.1/1.2/1.3: связываем history id с durable UUID, закрываем шаг и
    // пишем вердикт гейта с provenance (путь к логу) в общий ledger.
    const finishContext = buildRegisteredContext(taskName);
    if (finishContext) {
      recordRegisteredRun(finishContext, {
        historyRunId: runId,
        status: st === "success" ? "passed" : st === "skipped" ? "skipped" : "failed",
        error,
        evidencePath: logFile,
      });
    }

    await handleCompletion(taskName, st, chainTarget, error, durationMs, tokensResolved, costResolved);
    return;
  }

  // Обратная совместимость: старый режим без --start.
  const taskName = first;
  const status = second;
  if (!taskName || !status) {
    process.exit(1);
  }

  const startedAt = third ?? new Date().toISOString();
  const durationMs = Number(fourth) || 0;
  const error = normalizeErrorText(fifth);

  // Токены и стоимость приходят из PowerShell-обёртки (ps-wrapper.ts).
  // "-" означает «данных нет» (openCode не печатал usage в лог).
  const tokens = parseOptionalNumber(sixth);
  const costUsd = parseOptionalNumber(seventh);
  // B10: 11-й аргумент — лог-файл задачи. Раньше legacy-режим его не читал,
  // поэтому при "-" в токенах/стоимости usage терялся. Парсим лог так же,
  // как режим --finish; отсутствие файла — graceful fallback (parseUsageFromLog
  // возвращает пустой объект и не бросает).
  const logFile = eleventh && eleventh !== "-" ? eleventh : undefined;
  let tokensResolved = tokens;
  let costResolved = costUsd;
  if ((tokensResolved === undefined || costResolved === undefined) && logFile) {
    const usage = parseUsageFromLog(logFile);
    if (tokensResolved === undefined && usage.tokens !== undefined) {
      tokensResolved = usage.tokens;
    }
    if (costResolved === undefined && usage.costUsd !== undefined) {
      costResolved = usage.costUsd;
    }
  }
  // Восьмой аргумент — модель; "-" означает, что модель не задана.
  const model = eighth && eighth !== "-" ? eighth.trim() || undefined : undefined;
  if (tokensResolved === undefined || costResolved === undefined) {
    const usage = resolveUsageWithOfflineFallback(taskName, startedAt, durationMs, {
      tokens: tokensResolved,
      costUsd: costResolved,
    }, logFile, model);
    tokensResolved = usage.tokens;
    costResolved = usage.costUsd;
  }
  // Девятый и десятый — итоги pre/post-flight хуков.
  const preFlightStatus = parseHookStatus(ninth);
  const postFlightStatus = parseHookStatus(tenth);

  const st: Status =
    status === "success" ? "success" : status === "timeout" ? "timeout" : status === "skipped" ? "skipped" : "error";

  const definition = getTask(taskName);
  const chainTarget =
    st === "success"
      ? definition?.nextTaskOnSuccess || null
      : st === "skipped"
        ? null
        : definition?.nextTaskOnError || null;

  recordRun(
    taskName,
    st,
    startedAt,
    durationMs,
    error,
    chainTarget,
    tokensResolved,
    costResolved,
    model,
    preFlightStatus,
    postFlightStatus,
    new Date().toISOString(),
    definition?.workspaceId ?? null,
    definition?.allowedTools ?? null,
    definition?.deniedTools ?? null,
  );

  // Обратная совместимость: legacy-вызов без --start тоже идёт через durable путь.
  const legacyContext = buildRegisteredContext(taskName);
  if (legacyContext) {
    recordRegisteredRun(legacyContext, {
      status: st === "success" ? "passed" : st === "skipped" ? "skipped" : "failed",
      error,
      evidencePath: logFile,
    });
  }

  await handleCompletion(taskName, st, chainTarget, error, durationMs, tokensResolved, costResolved);
}

/** Зависимости для тестируемой очистки one-shot (P2-27). */
export interface OneShotCleanupDeps {
  platform?: NodeJS.Platform;
  getDefinition?: (name: string) => TaskDefinition | undefined;
  deleteTask?: (name: string) => Promise<void>;
}

/**
 * Удаляет отработавшую ONCE-задачу из Планировщика Windows.
 *
 * `schtasks /create ... /z` должен был делать это сам, но на Win10/11
 * возвращает «The task XML is missing a required element ... EndBoundary»
 * и задача вообще не создаётся. Поэтому чистим после запуска вручную.
 * На Linux/macOS очистка не нужна: `at` и launchd убирают one-shot сами.
 */
export async function cleanupWindowsOneShotTask(
  taskName: string,
  deps: OneShotCleanupDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return false;

  const getDefinition = deps.getDefinition ?? getTask;
  const definition = getDefinition(taskName);
  if (definition?.triggerType !== "once") return false;

  const deleteTask =
    deps.deleteTask ??
    ((name: string) => createSchedulerBackend().deleteTask(name));
  try {
    await deleteTask(taskName);
    logRecorderEvent("oneshot.cleaned", taskName);
    return true;
  } catch (err: unknown) {
    logRecorderEvent("oneshot.cleanup_failed", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Общая пост-обработка завершённого запуска: уведомление, цепочки задач,
 * DAG-зависимости и повторы. Используется и legacy-режимом, и --finish.
 */
async function handleCompletion(
  taskName: string,
  st: Status,
  chainTarget: string | null,
  error: string | null,
  durationMs: number,
  tokens?: number | null,
  costUsd?: number | null,
): Promise<void> {
  // Уведомление о завершении (webhook). Ошибки отправки логируются внутри
  // и не влияют на историю, цепочки и повторы. Пропуск guard не уведомляем:
  // для него нет отдельного шаблона, а шум в уведомлениях не нужен.
  if (st !== "skipped") {
    await notifyTaskCompletion(taskName, st, durationMs, error, tokens, costUsd, {
      asyncTriage: true,
    });
  }

  // P2-27: Windows не удаляет ONCE-задачи сам, а флаг schtasks `/z` на
  // практике ломает создание задачи («task XML ... EndBoundary»).
  // Поэтому снимаем отработавшую one-shot задачу из Планировщика здесь.
  await cleanupWindowsOneShotTask(taskName);

  // Matrix (Спринт 15): клон завершился — двигаем sequential-цепочку или
  // очередь concurrency-лимита (Спринт 17), а когда все клоны готовы —
  // фиксируем агрегат и запускаем matrix-complete.
  try {
    await advanceMatrixAfterClone(taskName);
    await finalizeMatrixIfComplete(taskName);
  } catch (err: unknown) {
    logRecorderEvent("matrix.error", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (st === "success") {
    // PL-5.1: один и тот же следующий шаг может прийти и из chainTarget
    // (nextTaskOnSuccess), и из DAG-зависимых (dependsOn). Запускаем каждое
    // имя ровно один раз за завершение: Set по имени, без учёта регистра —
    // именно так сравнивает имена selectDependentsToTrigger.
    const triggered = new Set<string>();
    const nameKey = (name: string): string => name.trim().toLowerCase();

    // Успешный запуск сбрасывает счётчик повторов.
    deleteSetting(retryStateKey(taskName));
    if (chainTarget) {
      const key = nameKey(chainTarget);
      triggered.add(key);
      const started = await triggerTask(chainTarget);
      if (started) {
        logRecorderEvent("chain.triggered", taskName, { nextTask: chainTarget });
      }
    }

    // DAG: после успеха проверяем задачи, у которых эта задача — одна из
    // зависимостей. Запускаем только если ВСЕ зависимости уже успешны и
    // зависимая задача ещё не запускалась после их завершения.
    try {
      // P2-29: по одной последней записи на задачу, а не «последние 200 строк».
      const history = getLatestHistoryByTask() as HistoryRecord[];
      const definitions = listTasks();
      const dependents = selectDependentsToTrigger(taskName, definitions, history);
      for (const dependent of dependents) {
        const key = nameKey(dependent);
        if (triggered.has(key)) {
          // Один шаг попал и в цепочку, и в DAG — второй triggerTask
          // создал бы дублирующий запуск (наблюдалось 09:29:24Z).
          logRecorderEvent("dag.dedup_skipped", taskName, {
            reason: "already triggered via nextTaskOnSuccess",
            nextTask: dependent,
          });
          continue;
        }
        triggered.add(key);
        const started = await triggerTask(dependent);
        if (started) {
          logRecorderEvent("dag.triggered", taskName, { nextTask: dependent });
        }
      }
    } catch (err: unknown) {
      logRecorderEvent("dag.trigger_failed", taskName, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (st !== "skipped") {
    // Сначала пытаемся повторить саму задачу; компенсирующая задача запускается
    // только когда повторы исчерпаны (или не настроены).
    // Пропуск guard — не ошибка: повторы и компенсации не запускаются.
    const retryScheduled = await scheduleRetry(taskName);
    if (!retryScheduled && chainTarget) {
      const started = await triggerTask(chainTarget);
      if (started) {
        logRecorderEvent("compensation.triggered", taskName, { nextTask: chainTarget });
      }
    }
  }

  // Спринт 24: учёт запусков сессии (sessionRunCount) и ротация reuse-сессии
  // при достижении sessionMaxRuns. Не должна ломать завершение запуска.
  try {
    await rotateSessionIfNeeded(taskName);
  } catch (err: unknown) {
    logRecorderEvent("session.rotate_failed", taskName, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Скрипт вызывается и как CLI (node record-history.js ...), и импортируется
 * тестами. main() запускаем только при прямом вызове файла.
 *
 * PL-161: сравниваем РЕАЛЬНЫЕ пути, а не URL. При запуске через junction/symlink
 * (рекомендованный PL-109 способ подключить dist в свежем worktree)
 * process.argv[1] содержит символический путь, а import.meta.url — реальный.
 * Старое сравнение URL молча возвращало false: --start/--finish ничего не
 * делали, обёртки получали пустой stdout, crash recovery не работал.
 * Аналогичный фикс уже есть в core/gate-integrity.ts (PL-131).
 */
function realPathWithFallback(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const cliPath = realPathWithFallback(entry);
  const modulePath = realPathWithFallback(fileURLToPath(import.meta.url));
  return cliPath === modulePath;
}

if (isDirectInvocation()) {
  main().catch((err) => {
    logRecorderEvent("record_history.fatal", "record-history", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
