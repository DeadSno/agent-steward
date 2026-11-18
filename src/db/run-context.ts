import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "./index.js";
import { redactSecretsInText } from "../core/secrets.js";
import { pauseRunRecord, type RunRecord, type RunStepRecord } from "./runs-repo.js";
import { listRunSteps } from "./runs-repo.js";
import { requireRun } from "./run-journal.js";

/**
 * Пауза с инъекцией контекста (Спринт 36.7).
 *
 * На паузе пользователь может оставить комментарий, файл или
 * структурированный артефакт. Запись адресуется конкретному шагу — первому
 * незавершённому на момент паузы либо указанному явно — и передаётся его
 * обработчику при resume ровно один раз. Секреты маскируются при записи,
 * поэтому история контекста безопасна для показа в GUI.
 */

/** Вид вложенного контекста. */
export type InjectionKind = "comment" | "file" | "artifact";

/** Сохранённая инъекция контекста. */
export interface RunInjection {
  id: string;
  runId: string;
  /** Шаг, который получит вставку при resume. */
  stepName: string;
  kind: InjectionKind;
  /** Текст комментария, содержимое файла или JSON артефакта (маскировано). */
  content: string;
  /** Кто оставил вставку. */
  author: string;
  /** Дополнительные данные: путь файла, имя артефакта и т.п. */
  metadata: unknown;
  createdAt: string;
  /** Момент передачи шагу; null — вставка ещё ждёт resume. */
  consumedAt: string | null;
  consumedByStep: string | null;
  consumedAttempt: number | null;
}

/** Файл, приложенный к паузе. */
export interface PauseFileInput {
  /** Путь к файлу (обязателен; маскируется как текст). */
  path: string;
  /** Содержимое файла. Без него шаг получает только путь. */
  content?: string;
  /** Человекочитаемое название для истории. */
  title?: string;
}

/** Структурированный артефакт, приложенный к паузе. */
export interface PauseArtifactInput {
  /** Имя артефакта для истории. */
  name?: string;
  /** Любое JSON-сериализуемое значение. */
  content: unknown;
}

/** Данные паузы. Все поля необязательны: можно просто приостановить запуск. */
export interface PauseRunInput {
  /** Явный шаг-получатель. По умолчанию — первый незавершённый. */
  stepName?: string;
  /** Комментарий пользователя. */
  comment?: string;
  /** Приложенный файл. */
  file?: PauseFileInput;
  /** Структурированный артефакт. */
  artifact?: PauseArtifactInput;
  /** Автор вставки; по умолчанию `local-user`. */
  author?: string;
}

/** Результат паузы. */
export interface PauseRunResult {
  run: RunRecord;
  /** Шаг, который получит контекст при resume. */
  stepName: string;
  /** Созданные вставки (может быть пусто при паузе без контекста). */
  injections: RunInjection[];
}

/** Контекст, который получает обработчик шага при resume. */
export interface StepContext {
  /** Непотреблённые вставки, адресованные этому шагу. */
  injections: RunInjection[];
}

/** Максимальная длина одной вставки — защита БД и логов от гигантских файлов. */
export const MAX_INJECTION_CONTENT = 100_000;

const DEFAULT_AUTHOR = "local-user";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return String(value);
  }
}

function isStepDone(status: RunStepRecord["status"]): boolean {
  return status === "passed" || status === "skipped";
}

function rowToInjection(row: any): RunInjection {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stepName: String(row.step_name),
    kind: String(row.kind) as InjectionKind,
    content: String(row.content ?? ""),
    author: String(row.author ?? DEFAULT_AUTHOR),
    metadata: parseJson(row.metadata_json),
    createdAt: String(row.created_at),
    consumedAt: row.consumed_at == null ? null : String(row.consumed_at),
    consumedByStep: row.consumed_by_step == null ? null : String(row.consumed_by_step),
    consumedAttempt:
      row.consumed_attempt == null ? null : Number(row.consumed_attempt),
  };
}

/** Ключ JSON-объекта, значение которого нужно скрыть целиком. */
const SENSITIVE_KEY_RE =
  /(?:^|_|[a-z0-9])(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|AUTH)(?:$|_|[A-Z0-9])/i;

/** Рекурсивно маскирует строки в JSON-значении (для артефактов и metadata). */
function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (depth >= 20) return "[truncated]";
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] =
        item != null && SENSITIVE_KEY_RE.test(key) ? "***" : redactValue(item, depth + 1, seen);
    }
    return result;
  }
  return String(value);
}

function maskText(value: string): string {
  return redactSecretsInText(value);
}

function checkLength(kind: InjectionKind, content: string): string {
  if (content.length > MAX_INJECTION_CONTENT) {
    throw new Error(
      `Контекст паузы (${kind}) слишком длинный: ${content.length} > ${MAX_INJECTION_CONTENT}`,
    );
  }
  return content;
}

interface InjectionRow {
  stepName: string;
  kind: InjectionKind;
  content: string;
  author: string;
  metadata: unknown;
}

/** Собирает строки вставок из входных данных, маскируя секреты. */
function buildInjectionRows(input: PauseRunInput, stepName: string): InjectionRow[] {
  const author = maskText(String(input.author ?? DEFAULT_AUTHOR)).trim() || DEFAULT_AUTHOR;
  const rows: InjectionRow[] = [];

  if (input.comment != null && String(input.comment).length > 0) {
    const content = checkLength("comment", maskText(String(input.comment)));
    rows.push({ stepName, kind: "comment", content, author, metadata: null });
  }

  if (input.file) {
    const filePath = maskText(String(input.file.path ?? "")).trim();
    if (!filePath) throw new Error("Путь файла не может быть пустым");
    const content = checkLength("file", maskText(String(input.file.content ?? "")));
    const metadata = redactValue({
      path: filePath,
      ...(input.file.title ? { title: maskText(String(input.file.title)) } : {}),
      ...(input.file.content != null ? { size: String(input.file.content).length } : {}),
    });
    rows.push({ stepName, kind: "file", content, author, metadata });
  }

  if (input.artifact) {
    if (input.artifact.content === undefined) {
      throw new Error("У артефакта отсутствует content");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(redactValue(input.artifact.content));
    } catch {
      throw new Error("Артефакт не сериализуется в JSON");
    }
    const content = checkLength("artifact", serialized);
    const metadata = redactValue(
      input.artifact.name ? { name: maskText(String(input.artifact.name)) } : null,
    );
    rows.push({ stepName, kind: "artifact", content, author, metadata });
  }

  return rows;
}

function insertInjection(runId: string, row: InjectionRow, createdAt: string): RunInjection {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO run_injections (
         id, run_id, step_name, kind, content, author, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      runId,
      row.stepName,
      row.kind,
      row.content,
      row.author,
      row.metadata == null ? null : JSON.stringify(row.metadata),
      createdAt,
    );
  return requireInjection(id);
}

function requireInjection(id: string): RunInjection {
  const row = getDb().prepare("SELECT * FROM run_injections WHERE id = ?").get(id);
  if (!row) throw new Error(`Вставка контекста не найдена: ${id}`);
  return rowToInjection(row);
}

/** Все вставки запуска в хронологическом порядке (история контекста). */
export function listRunInjections(
  runId: string,
  options: { pendingOnly?: boolean } = {},
): RunInjection[] {
  const sql = options.pendingOnly
    ? `SELECT * FROM run_injections WHERE run_id = ? AND consumed_at IS NULL
       ORDER BY created_at ASC, rowid ASC`
    : `SELECT * FROM run_injections WHERE run_id = ?
       ORDER BY created_at ASC, rowid ASC`;
  return getDb().prepare(sql).all(runId).map(rowToInjection);
}

/** Непотреблённые вставки, адресованные шагу. */
export function pendingInjectionsForStep(runId: string, stepName: string): RunInjection[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM run_injections
          WHERE run_id = ? AND step_name = ? AND consumed_at IS NULL
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(runId, stepName)
  ).map(rowToInjection);
}

/** Одна вставка по id (для GUI/диагностики). */
export function getRunInjection(id: string): RunInjection | undefined {
  const row = getDb().prepare("SELECT * FROM run_injections WHERE id = ?").get(id);
  return row ? rowToInjection(row) : undefined;
}

/**
 * Помечает вставки переданными шагу. Повторный вызов безопасен: уже
 * потреблённые записи не меняются.
 */
export function consumeInjections(
  ids: string[],
  stepName: string,
  attempt: number,
  consumedAt = nowIso(),
): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(", ");
  return withTransaction(() => {
    const result = getDb()
      .prepare(
        `UPDATE run_injections
            SET consumed_at = ?, consumed_by_step = ?, consumed_attempt = ?
          WHERE consumed_at IS NULL AND id IN (${placeholders})`,
      )
      .run(consumedAt, stepName, attempt, ...ids) as { changes?: number };
    return Number(result.changes ?? 0);
  });
}

/**
 * Ставит запуск на паузу и сохраняет контекст.
 *
 * Пауза возможна только между шагами: если какой-то шаг уже выполняется,
 * бросается ошибка — вызывающий код должен дождаться его завершения
 * (в GUI об этом предупреждает 36.8). Контекст адресуется первому
 * незавершённому шагу либо явно указанному `stepName`.
 */
export function pauseRun(runId: string, input: PauseRunInput = {}): PauseRunResult {
  const run = requireRun(runId);
  if (run.status !== "pending" && run.status !== "running" && run.status !== "paused") {
    throw new Error(`Запуск в статусе ${run.status} нельзя поставить на паузу: ${runId}`);
  }

  const steps = listRunSteps(runId);
  const running = steps.find((step) => step.status === "running");
  if (running) {
    throw new Error(
      `Шаг ${running.stepName} уже выполняется — пауза возможна после его завершения`,
    );
  }

  let target: RunStepRecord | undefined;
  if (input.stepName != null) {
    target = steps.find((step) => step.stepName === input.stepName);
    if (!target) throw new Error(`Шаг не найден: ${runId}/${input.stepName}`);
    if (isStepDone(target.status)) {
      throw new Error(`Шаг ${target.stepName} уже завершён — контекст некуда передать`);
    }
  } else {
    target = steps.find((step) => !isStepDone(step.status));
    if (!target) throw new Error(`В запуске нет незавершённых шагов: ${runId}`);
  }

  const rows = buildInjectionRows(input, target.stepName);
  const createdAt = nowIso();

  return withTransaction(() => {
    const injections = rows.map((row) => insertInjection(runId, row, createdAt));
    if (run.status !== "paused") pauseRunRecord(runId);
    return { run: requireRun(runId), stepName: target.stepName, injections };
  });
}

/**
 * Помечает вставки завершённых шагов потреблёнными. Вызывается при финале
 * resume, чтобы «зависшая» вставка не выглядела ожидающей в истории.
 */
export function consumeOrphanInjections(runId: string): number {
  const steps = listRunSteps(runId);
  const done = new Set(
    steps.filter((step) => isStepDone(step.status)).map((step) => step.stepName),
  );
  const pending = listRunInjections(runId, { pendingOnly: true });
  let consumed = 0;
  for (const injection of pending) {
    if (!done.has(injection.stepName)) continue;
    const step = steps.find((item) => item.stepName === injection.stepName);
    consumed += consumeInjections(
      [injection.id],
      injection.stepName,
      step?.attempt ?? 1,
      injection.createdAt,
    );
  }
  return consumed;
}
