import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decideTriage, type TriageDecision } from "./triage-chain.js";
import { recordTriageOutcome } from "./triage-shadow.js";
import { isShadowActive, type TriageSettings } from "../settings.js";
import { redactSecretsInText } from "./secrets.js";
import { closeDb } from "../db/index.js";
import type { TriageInput } from "./triage.js";

/**
 * Асинхронный триаж (Спринт 31.7).
 *
 * `record-history` — короткоживущий процесс: ждать в нём локальную модель
 * 20–45 секунд нельзя, это задерживает уведомление, цепочки и снятие блокировки.
 * Поэтому для режимов `llm`/`auto` уведомление доставляется сразу, а вердикт
 * считается отдельным detached-процессом и пишется в persistent-аудит.
 *
 * В режиме `rules` триаж остаётся синхронным: правила должны успеть подавить
 * уведомление до доставки.
 */

export const TRIAGE_WORKER_FLAG = "--triage";

const JOB_PREFIX = "opencode-scheduler-triage-";
const ERROR_TEXT_LIMIT = 4000;
/** Сколько триаж-процессов может работать одновременно (защита Ollama). */
const MAX_CONCURRENT_WORKERS = 2;
/** Задание/слот старше этого возраста считается мусором. */
const STALE_TRIAGE_MS = 60 * 60 * 1000;
/** Сколько чужих заданий один воркер разбирает за запуск (дренаж очереди). */
const MAX_JOBS_PER_WORKER = 20;

/** Удаляет старые файлы заданий и зависшие слоты из временного каталога. */
export function pruneTriageArtifacts(dir: string, now = Date.now()): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(JOB_PREFIX)) continue;
    if (!/\.(json|lock)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > STALE_TRIAGE_MS) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // Файл уже удалён другим процессом.
    }
  }
  return removed;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Пытается занять один из слотов воркера. Слот — файл с PID; слот мёртвого
 * процесса переиспользуется. Возвращает путь к слоту или null.
 */
function acquireWorkerSlot(dir: string): string | null {
  for (let i = 0; i < MAX_CONCURRENT_WORKERS; i += 1) {
    const slot = path.join(dir, `${JOB_PREFIX}slot-${i}.lock`);
    try {
      const fd = fs.openSync(slot, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return slot;
    } catch (err: any) {
      if (err?.code !== "EEXIST") continue;
      let holder = 0;
      try {
        holder = parseInt(fs.readFileSync(slot, "utf8").trim(), 10);
      } catch {
        holder = 0;
      }
      if (!processAlive(holder)) {
        try {
          fs.rmSync(slot, { force: true });
          const fd = fs.openSync(slot, "wx", 0o600);
          fs.writeFileSync(fd, String(process.pid));
          fs.closeSync(fd);
          return slot;
        } catch {
          // Слот перехвачен другим процессом — пробуем следующий.
        }
      }
    }
  }
  return null;
}

function releaseWorkerSlot(slot: string | null): void {
  if (!slot) return;
  try {
    fs.rmSync(slot, { force: true });
  } catch {
    // Слот уже удалён.
  }
}

/** Следующий файл задания в каталоге (для дренажа очереди). */
function nextPendingJob(dir: string, exclude: string): string | undefined {
  try {
    const candidates = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(JOB_PREFIX) && entry.endsWith(".json"))
      .map((entry) => path.join(dir, entry))
      .filter((file) => file !== exclude)
      .map((file) => {
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { file: string; mtime: number } => item !== null)
      .sort((a, b) => a.mtime - b.mtime);
    return candidates[0]?.file;
  } catch {
    return undefined;
  }
}

/** Снимок данных, который передаётся фоновому процессу. */
export interface TriageJobPayload {
  version: 1;
  createdAt: string;
  input: TriageInput;
  triage: TriageSettings;
  shadowActive: boolean;
}

function sanitizeInput(input: TriageInput): TriageInput {
  const error = input.error ? redactSecretsInText(input.error) : input.error;
  return {
    ...input,
    error:
      typeof error === "string" && error.length > ERROR_TEXT_LIMIT
        ? `${error.slice(0, ERROR_TEXT_LIMIT)}…`
        : error,
  };
}

function safeUnlink(file: string | undefined): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // Файл уже удалён или недоступен — это не ошибка фонового триажа.
  }
}

/** Записывает задание для фонового процесса и возвращает путь к файлу. */
export function writeTriageJob(
  input: TriageInput,
  triage: TriageSettings,
  options: { tmpDir?: string } = {}
): string {
  const payload: TriageJobPayload = {
    version: 1,
    createdAt: new Date().toISOString(),
    input: sanitizeInput(input),
    triage,
    shadowActive: isShadowActive(triage.shadow),
  };
  const dir = options.tmpDir ?? os.tmpdir();
  const file = path.join(dir, `${JOB_PREFIX}${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  return file;
}

/** Читает и валидирует задание. Бросает исключение только при битом файле. */
export function readTriageJob(file: string): TriageJobPayload {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TriageJobPayload>;
  if (raw.version !== 1) throw new Error("unsupported triage job version");
  if (!raw.input || typeof raw.input.taskName !== "string") {
    throw new Error("invalid triage job input");
  }
  if (!raw.triage || typeof raw.triage.mode !== "string") {
    throw new Error("invalid triage job settings");
  }
  return {
    version: 1,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    input: raw.input,
    triage: raw.triage,
    shadowActive: raw.shadowActive === true,
  };
}

/**
 * Выполняет задание: классифицирует событие и пишет решение в аудит.
 *
 * Возвращает `null`, если триаж выключен или задание не требует решения.
 * Файл задания удаляет вызывающая сторона (CLI делает это в `finally`).
 */
export async function runTriageJob(file: string): Promise<TriageDecision | null> {
  const job = readTriageJob(file);
  if (job.triage.mode === "off") return null;

  const decision = await decideTriage(job.input, job.triage);
  recordTriageOutcome(job.input, decision, {
    shadowActive: job.shadowActive,
    suppressed: false,
    async: true,
  });
  return decision;
}

export interface ScheduleTriageOptions {
  tmpDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Для тестов: подменить spawn и не запускать реальный процесс. */
  spawnFn?: typeof spawn;
}

/**
 * Запускает detached-процесс триажа. Никогда не бросает исключение:
 * уведомление уже доставлено, и сбой фонового аудита не должен его ломать.
 */
export function scheduleTriageJob(
  input: TriageInput,
  triage: TriageSettings,
  options: ScheduleTriageOptions = {}
): { scheduled: boolean; file?: string; error?: string } {
  let file: string | undefined;
  try {
    const dir = options.tmpDir ?? os.tmpdir();
    pruneTriageArtifacts(dir);
    file = writeTriageJob(input, triage, { tmpDir: dir });
  } catch (err: any) {
    return {
      scheduled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const child = (options.spawnFn ?? spawn)(
      process.execPath,
      [fileURLToPath(import.meta.url), TRIAGE_WORKER_FLAG, file],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: options.env ?? process.env,
      }
    );
    child.unref();
    // Если процесс не стартовал, файл задания останется сиротой — убираем.
    child.on?.("error", () => safeUnlink(file));
    return { scheduled: true, file };
  } catch (err: any) {
    safeUnlink(file);
    return {
      scheduled: false,
      file,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const index = process.argv.indexOf(TRIAGE_WORKER_FLAG);
  const file = index >= 0 ? process.argv[index + 1] : undefined;
  if (!file) {
    console.error("[windows-scheduler] triage worker: не указан файл задания");
    process.exitCode = 1;
    return;
  }

  const dir = path.dirname(file);
  // Ограничиваем параллелизм: залп матрицы не должен поднимать N процессов
  // и N запросов к Ollama. Не занявший слот воркер оставляет задание в
  // очереди — его подберёт воркер, который освободится (см. drainQueue).
  const slot = acquireWorkerSlot(dir);
  if (!slot) {
    return;
  }

  try {
    await drainQueue(file);
  } finally {
    releaseWorkerSlot(slot);
    try {
      closeDb();
    } catch {
      // Процесс завершается — закрывать нечего.
    }
  }
}

/** Обрабатывает своё задание и до MAX_JOBS_PER_WORKER чужих из очереди. */
async function drainQueue(first: string): Promise<void> {
  let current: string | undefined = first;
  const dir = path.dirname(first);
  for (let processed = 0; current && processed < MAX_JOBS_PER_WORKER; processed += 1) {
    const file: string = current;
    try {
      await runTriageJob(file);
    } catch (err: any) {
      console.error(
        `[windows-scheduler] triage worker: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      process.exitCode = 1;
    } finally {
      safeUnlink(file);
    }
    current = nextPendingJob(dir, file);
  }
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href.toLowerCase() === import.meta.url.toLowerCase();
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  void main();
}
