import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "../types.js";
import { redactSecretsInText } from "./secrets.js";
import { safeStringify } from "../text.js";

/**
 * Машиночитаемые логи запусков (Спринт 22).
 *
 * Формат — JSONL: одна строка = один JSON-объект. Файл лежит рядом с
 * человекочитаемыми логами задач: `<PLUGIN_DIR>/logs/runs.jsonl`.
 *
 * Ротация простая: при превышении лимита текущий файл переименовывается
 * в `runs.jsonl.1` (предыдущий `.1` перезаписывается). Этого достаточно,
 * чтобы лог не рос бесконечно, и не требуется внешних зависимостей.
 *
 * BN-5 (BP-D13-1): запись буферизуется и уходит в файл асинхронно (один
 * `appendFile` на порцию вместо `appendFileSync` на каждое событие), чтобы
 * intensive-логирование не блокировало event loop. Гарантия сброса:
 * `flushStructuredLog()` (await), `flushStructuredLogSync()` и хуки
 * `beforeExit`/`exit`; чтение (`readStructuredLogs`) сбрасывает буфер само.
 *
 * Любая ошибка записи логируется в console.warn и **никогда** не ломает
 * запуск задачи: наблюдаемость не должна влиять на планировщик.
 */

/** События структурированного лога. */
// QA-A2.7: литеральные события поглощаются string — оставляем доменный тип.
export type StructuredLogEvent = string;

/** PL-7.2 / QA-D316-6: фазы, для которых обёртка пишет разделённые потоки. */
export type HookPhase = "preFlight" | "postFlight" | "qualityGate";

export interface StructuredLogRecord {
  /** Время записи (ISO). */
  ts: string;
  event: StructuredLogEvent;
  /** QA-D316-6: фаза события hook.output (машиночитаемый discriminator). */
  phase?: HookPhase;
  /** id записи history (для run.*). */
  runId?: number;
  task?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  nextTask?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  workspaceId?: string | null;
  preFlightStatus?: string;
  postFlightStatus?: string;
  /**
   * PL-7.2: реальный код завершения хуков. Диагностика Git уходит в stderr
   * даже при успешном push — без разделения потоков «пуш не состоялся» и
   * «Git пишет в stderr» неразличимы.
   */
  preFlightExitCode?: number | null;
  /** PL-7.2: stdout beforeScript — отдельно от диагностики. */
  preFlightStdout?: string;
  /** PL-7.2: stderr beforeScript. */
  preFlightStderr?: string;
  /** PL-7.2: реальный код завершения afterScript (post-flight). */
  postFlightExitCode?: number | null;
  /** PL-7.2: stdout afterScript — отдельно от диагностики. */
  postFlightStdout?: string;
  /** PL-7.2: stderr afterScript — может содержать diagnostics успешного git push. */
  postFlightStderr?: string;
  /** QA-D316-6: реальный код завершения quality gate. */
  qualityGateExitCode?: number | null;
  /** QA-D316-6: stdout quality gate (в history/get_task_logs). */
  qualityGateStdout?: string;
  /** QA-D316-6: stderr quality gate (в history/get_task_logs). */
  qualityGateStderr?: string;
  /** Источник события: schedule, dashboard, hook, cli, mcp и т.п. */
  source?: string;
  /** HTTP-статус ответа на hook.received. */
  httpStatus?: number;
  /** Адрес отправителя хука (без порта). */
  remote?: string | null;
  /** Размер тела хука в байтах. */
  payloadBytes?: number;
  /** Причина отказа/пропуска. */
  reason?: string;
  /** Родительская задача матрицы (matrixId === task для событий matrix.*). */
  matrixId?: string;
  /** Имя клона матрицы, к которому относится событие. */
  cloneName?: string;
  /** Шаг матричного сценария: started, advanced, cancelled, aggregated и т.п. */
  step?: string;
}

export interface ReadStructuredLogsFilter {
  task?: string;
  status?: string;
  event?: string;
  /** D13/IM-12: только события одного запуска (id из `record-history --start`). */
  runId?: number | string;
  /** ISO-время: записи не раньше. */
  since?: string;
  /** ISO-время: записи не позже. */
  until?: string;
  limit?: number;
}

export interface ReadStructuredLogsResult {
  records: StructuredLogRecord[];
  /** Сколько всего записей подошло под фильтр (до применения limit). */
  total: number;
  /** Сколько строк не удалось разобрать как JSON. */
  malformed: number;
  file: string;
}

/** Текущий файл и его архив после ротации. */
export const STRUCTURED_LOG_FILE = path.join(LOG_DIR, "runs.jsonl");
export const STRUCTURED_LOG_ARCHIVE = `${STRUCTURED_LOG_FILE}.1`;
export const STRUCTURED_LOG_MAX_BYTES = 10 * 1024 * 1024;

function warn(message: string, err: unknown): void {
  try {
    console.warn(
      `[structured-log] ${message}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } catch {
    // console может быть недоступен в урезанном окружении — молча игнорируем.
  }
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Ротирует лог, если он превысил лимит. Вызывается перед append. */
function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(STRUCTURED_LOG_FILE);
    if (stat.size < STRUCTURED_LOG_MAX_BYTES) return;
    try {
      fs.rmSync(STRUCTURED_LOG_ARCHIVE, { force: true });
    } catch {
      // Нет старого архива — не страшно.
    }
    fs.renameSync(STRUCTURED_LOG_FILE, STRUCTURED_LOG_ARCHIVE);
  } catch (err: unknown) {
    // ENOENT — файла ещё нет, это нормально.
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") warn("не удалось ротировать лог", err);
  }
}

/** BN-5: после скольких записей буфер сбрасывается немедленно. */
export const STRUCTURED_LOG_BUFFER_MAX_LINES = 512;

let pendingStructuredLines: string[] = [];
let drainScheduled = false;
let activeDrain: Promise<void> | null = null;

/**
 * BN-5: статус буфера — сколько событий ещё не ушло в файл.
 * Используется телеметрией и регрессионными тестами.
 */
export function getStructuredLogBufferSize(): number {
  return pendingStructuredLines.length;
}

function scheduleStructuredLogDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  const timer = setImmediate(() => {
    drainScheduled = false;
    void flushStructuredLog();
  });
  // Не держим процесс только ради записи лога — сброс есть на beforeExit/exit.
  (timer as { unref?: () => void }).unref?.();
}

/**
 * BN-5: асинхронно сбрасывает накопленные события в JSONL.
 * Безопасен при параллельных вызовах: ждёт текущую запись и перебирает
 * повторно, если за время ожидания пришли новые строки.
 */
export async function flushStructuredLog(): Promise<void> {
  while (pendingStructuredLines.length > 0 || activeDrain) {
    if (activeDrain) {
      await activeDrain;
      continue;
    }
    const lines = pendingStructuredLines;
    pendingStructuredLines = [];
    const drain = (async () => {
      try {
        ensureLogDir();
        rotateIfNeeded();
        await fs.promises.appendFile(STRUCTURED_LOG_FILE, lines.join(""), "utf8");
      } catch (err) {
        // Как и раньше: ошибка логирования не должна ломать запуск задачи.
        warn("не удалось записать событие", err);
      }
    })();
    activeDrain = drain;
    try {
      await drain;
    } finally {
      activeDrain = null;
    }
  }
}

/**
 * BN-5: синхронный сброс для shutdown-хуков и читателей, которым нужен
 * мгновенный консистентный вид лога. Обычный путь записи асинхронный.
 */
export function flushStructuredLogSync(): void {
  if (pendingStructuredLines.length === 0) return;
  const lines = pendingStructuredLines;
  pendingStructuredLines = [];
  try {
    ensureLogDir();
    rotateIfNeeded();
    fs.appendFileSync(STRUCTURED_LOG_FILE, lines.join(""), "utf8");
  } catch (err) {
    warn("не удалось записать событие", err);
  }
}

if (typeof process !== "undefined" && typeof process.on === "function") {
  process.on("beforeExit", flushStructuredLogSync);
  process.on("exit", flushStructuredLogSync);
}

/**
 * Добавляет запись в JSONL-лог. Возвращает true, если событие принято в
 * буфер (реальная запись уходит асинхронно). Не бросает исключений.
 */
export function appendStructuredLog(
  record: Omit<StructuredLogRecord, "ts"> & { ts?: string },
): boolean {
  try {
    const payload: StructuredLogRecord = {
      ...record,
      ts: record.ts ?? new Date().toISOString(),
    };
    // Спринт 26: даже если ошибка пришла из внешнего процесса, известные
    // значения секретов и присваивания TOKEN=/password: вырезаются.
    if (typeof payload.error === "string") {
      payload.error = redactSecretsInText(payload.error);
    }
    if (typeof payload.reason === "string") {
      payload.reason = redactSecretsInText(payload.reason);
    }
    // PL-7.2: потоки хуков тоже могут содержать токены/URL — применяем ту же
    // редакцию, что и к error/reason, до записи в JSONL.
    if (typeof payload.preFlightStdout === "string") {
      payload.preFlightStdout = redactSecretsInText(payload.preFlightStdout);
    }
    if (typeof payload.preFlightStderr === "string") {
      payload.preFlightStderr = redactSecretsInText(payload.preFlightStderr);
    }
    if (typeof payload.postFlightStdout === "string") {
      payload.postFlightStdout = redactSecretsInText(payload.postFlightStdout);
    }
    if (typeof payload.postFlightStderr === "string") {
      payload.postFlightStderr = redactSecretsInText(payload.postFlightStderr);
    }
    // QA-D316-6: вывод гейта может содержать токены из env — та же редакция,
    // что и для остальных потоков, до попадания в JSONL/history.
    if (typeof payload.qualityGateStdout === "string") {
      payload.qualityGateStdout = redactSecretsInText(payload.qualityGateStdout);
    }
    if (typeof payload.qualityGateStderr === "string") {
      payload.qualityGateStderr = redactSecretsInText(payload.qualityGateStderr);
    }
    pendingStructuredLines.push(`${JSON.stringify(payload)}\n`);
    if (pendingStructuredLines.length >= STRUCTURED_LOG_BUFFER_MAX_LINES) {
      void flushStructuredLog();
    } else {
      scheduleStructuredLogDrain();
    }
    return true;
  } catch (err) {
    warn("не удалось записать событие", err);
    return false;
  }
}

/** PL-7.2: данные одного хука (pre/post-flight) для журнала. */
export interface HookOutputDetails {
  /** Реальный код завершения процесса, а не «успех/ошибка» обёртки. */
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

/**
 * PL-7.2: пишет отдельное событие `hook.output` с разделёнными stdout/stderr и
 * реальным exit code. Обёртка вызывает его, когда хочет отличить «команда не
 * выполнилась» от «команда выполнилась, но написала диагностику в stderr»
 * (типичный случай git push под PowerShell $ErrorActionPreference='Stop').
 */
export function appendHookOutputLog(
  phase: HookPhase,
  task: string,
  details: HookOutputDetails,
  runId?: number,
): boolean {
  const base = { event: "hook.output", task, runId, phase } as const;
  if (phase === "qualityGate") {
    return appendStructuredLog({
      ...base,
      qualityGateExitCode: details.exitCode,
      qualityGateStdout: details.stdout ?? "",
      qualityGateStderr: details.stderr ?? "",
    });
  }
  if (phase === "postFlight") {
    return appendStructuredLog({
      ...base,
      postFlightExitCode: details.exitCode,
      postFlightStdout: details.stdout ?? "",
      postFlightStderr: details.stderr ?? "",
    });
  }
  return appendStructuredLog({
    ...base,
    preFlightExitCode: details.exitCode,
    preFlightStdout: details.stdout ?? "",
    preFlightStderr: details.stderr ?? "",
  });
}

function readLines(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") warn(`не удалось прочитать ${file}`, err);
    return [];
  }
}

/**
 * Читает JSONL-лог (текущий + архив), фильтрует и сортирует новые сверху.
 *
 * `limit` по умолчанию 200, максимум 5000 — как у HTTP-эндпоинта.
 * `total` считается до применения limit, чтобы клиент знал полный объём.
 */
export function readStructuredLogs(
  filter: ReadStructuredLogsFilter = {},
): ReadStructuredLogsResult {
  // Читатель всегда видит все ранее принятые события, даже если асинхронный
  // drain ещё не успел дойти до диска (сохраняем read-after-write).
  flushStructuredLogSync();
  const limit = Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 200) || 200));
  const task = filter.task?.trim().toLowerCase();
  const status = filter.status?.trim().toLowerCase();
  const event = filter.event?.trim().toLowerCase();
  const runId =
    filter.runId === undefined || filter.runId === null || filter.runId === ""
      ? undefined
      : String(filter.runId).trim();
  const since = filter.since?.trim();
  const until = filter.until?.trim();

  const records: StructuredLogRecord[] = [];
  let malformed = 0;

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // Архив старше текущего файла; порядок не важен, ниже сортируем по ts.
  for (const file of [STRUCTURED_LOG_ARCHIVE, STRUCTURED_LOG_FILE]) {
    for (const line of readLines(file)) {
      // QA-A2.7: JSONL — внешние данные, сужаем через проверку формы.
      let parsed: Record<string, unknown> | null = null;
      try {
        const value: unknown = JSON.parse(line);
        if (isRecord(value)) parsed = value;
      } catch {
        // malformed считается ниже
      }
      if (parsed === null) {
        malformed += 1;
        continue;
      }
      if (typeof parsed.ts !== "string") parsed.ts = "";
      if (typeof parsed.event !== "string") parsed.event = "";
      if (task && safeStringify(parsed.task ?? "").toLowerCase() !== task) continue;
      if (status && safeStringify(parsed.status ?? "").toLowerCase() !== status) continue;
      if (event && String(parsed.event).toLowerCase() !== event) continue;
      // D13/IM-12: старые записи без runId не попадают в выборку запуска.
      if (runId && String(parsed.runId ?? "") !== runId) continue;
      if (since && String(parsed.ts) < since) continue;
      if (until && String(parsed.ts) > until) continue;
      records.push(parsed as unknown as StructuredLogRecord);
    }
  }

  const total = records.length;
  records.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return {
    records: records.slice(0, limit),
    total,
    malformed,
    file: STRUCTURED_LOG_FILE,
  };
}

/** Удаляет JSONL-логи (для тестов и обслуживания). */
export function clearStructuredLogs(): void {
  pendingStructuredLines = [];
  try {
    fs.rmSync(STRUCTURED_LOG_FILE, { force: true });
    fs.rmSync(STRUCTURED_LOG_ARCHIVE, { force: true });
  } catch (err) {
    warn("не удалось очистить лог", err);
  }
}
