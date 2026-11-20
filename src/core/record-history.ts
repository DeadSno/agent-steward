import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { runTaskNow } from "./scheduler/run-now.js";
import { createSchedulerBackend } from "./scheduler/index.js";
import { notifyTaskCompletion } from "../notifications.js";
import { finishRun, getLatestHistoryByTask, recordRun, startRun } from "../db/history-repo.js";
import { deleteSetting, decrementCounterSetting } from "../db/settings-repo.js";
import { getTask, listTasks } from "../db/tasks-repo.js";
import { extractLastRunLog } from "./mission.js";
import { rotateSessionIfNeeded } from "./session.js";
import type { TaskDefinition } from "../task-transfer.js";
import type { HistoryRecord } from "../history.js";
import {
  advanceMatrixAfterClone,
  finalizeMatrixIfComplete,
} from "./matrix.js";
import { appendStructuredLog } from "./structured-log.js";

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
        if (!record || record.status !== "success") {
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
    const finishedAt = new Date().toISOString();
    const startedAt = new Date(Date.now() - durationMs).toISOString();
    const definition = getTask(taskName);
    recordRun(
      taskName,
      "skipped",
      startedAt,
      durationMs,
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
    await handleCompletion(taskName, "skipped", null, reason, durationMs);
    return;
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
    const error = sixth !== undefined ? sixth : null;
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
  const error = fifth !== undefined ? fifth : null;

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
  if (!definition || definition.triggerType !== "once") return false;

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
    // Успешный запуск сбрасывает счётчик повторов.
    await deleteSetting(retryStateKey(taskName));
    if (chainTarget) {
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
 */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase()
    );
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((err) => {
    logRecorderEvent("record_history.fatal", "record-history", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
