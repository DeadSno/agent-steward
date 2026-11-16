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
    file = writeTriageJob(input, triage, { tmpDir: options.tmpDir });
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
    try {
      closeDb();
    } catch {
      // Процесс завершается — закрывать нечего.
    }
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
