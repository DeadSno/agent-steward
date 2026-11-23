import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDb, withTransaction } from "./index.js";
import { redactSecretsInText } from "../core/secrets.js";
import { normalizeTaskType } from "../core/router/rules.js";
import {
  listRunSteps,
  pauseRunRecord,
  readGateOutcomeLedger,
  type RunRecord,
  type RunStepRecord,
} from "./runs-repo.js";
import { requireRun } from "./run-journal.js";
import { safeStringify } from "../text.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    return JSON.parse(safeStringify(value));
  } catch {
    return safeStringify(value);
  }
}

function isStepDone(status: RunStepRecord["status"]): boolean {
  return status === "passed" || status === "skipped";
}

function rowToInjection(row: unknown): RunInjection {
  if (!isRecord(row)) {
    throw new Error("Некорректная строка вставки контекста");
  }
  return {
    id: safeStringify(row.id),
    runId: safeStringify(row.run_id),
    stepName: safeStringify(row.step_name),
    kind: safeStringify(row.kind) as InjectionKind,
    content: safeStringify(row.content ?? ""),
    author: safeStringify(row.author ?? DEFAULT_AUTHOR),
    metadata: parseJson(row.metadata_json),
    createdAt: safeStringify(row.created_at),
    consumedAt: row.consumed_at == null ? null : safeStringify(row.consumed_at),
    consumedByStep:
      row.consumed_by_step == null ? null : safeStringify(row.consumed_by_step),
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
  return safeStringify(value);
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
  const row: unknown = getDb().prepare("SELECT * FROM run_injections WHERE id = ?").get(id);
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
  const row: unknown = getDb().prepare("SELECT * FROM run_injections WHERE id = ?").get(id);
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

/* ------------------------------------------------------------------------- *
 * ARCH-5: context compilation (Спринт 41)
 * ------------------------------------------------------------------------- */

/**
 * Краткая карта репозитория. Статична и упорядочена намеренно: один и тот же
 * ledger и одна и та же карта дают побайтово одинаковый контекст. `critical`
 * отмечает файлы, которые нельзя терять при усечении под бюджет токенов.
 */
export interface RepoMapEntry {
  path: string;
  description: string;
  /** Нормализованные типы задач; `*` — релевантно для любого шага. */
  taskTypes: readonly string[];
  critical?: boolean;
}

/** Карта ключевых модулей. Порядок объявления — порядок в собранном контексте. */
export const REPO_MAP: readonly RepoMapEntry[] = Object.freeze([
  {
    path: "src/core/router/rules.ts",
    description: "слой 1 роутера: таблица типов задач и транспорта",
    taskTypes: ["*", "read_file", "write_file", "run_tests", "apply_diff"],
    critical: true,
  },
  {
    path: "src/core/router/dispatch.ts",
    description: "сборка маршрута и пересборка контекста при эскалации",
    taskTypes: ["*"],
    critical: true,
  },
  {
    path: "src/core/router/escalation.ts",
    description: "вердикты гейта и переходы local → cloud → review",
    taskTypes: ["*"],
  },
  {
    path: "src/db/run-context.ts",
    description: "инъекции паузы и компилятор контекста",
    taskTypes: ["*"],
  },
  {
    path: "src/db/runs-repo.ts",
    description: "ledger gate_outcomes и read-путь для примеров",
    taskTypes: ["*"],
    critical: true,
  },
  {
    path: "src/db/capability-repo.ts",
    description: "слой 2 роутера: reliability по исходам гейтов",
    taskTypes: ["run_tests", "mission"],
  },
  {
    path: "src/core/execution.ts",
    description: "выполнение плана шагов и запись вердиктов",
    taskTypes: ["run_tests", "mission"],
  },
  {
    path: "src/core/secrets.ts",
    description: "маскировка секретов (redactSecretsInText)",
    taskTypes: ["*"],
  },
  {
    path: "src/core/gate-integrity.ts",
    description: "отложенные эффекты и целостность гейта",
    taskTypes: ["run_tests", "apply_diff"],
  },
  {
    path: "src/core/permissions.ts",
    description: "политика прав и класс риска миссии",
    taskTypes: ["mission", "github_create_pr", "jira_update_task"],
  },
  {
    path: "src/db/schema.ts",
    description: "схема БД и аддитивные миграции",
    taskTypes: ["run_tests", "write_file"],
  },
  {
    path: "test-router-dispatch.mjs",
    description: "тесты маршрутизации и пересборки контекста",
    taskTypes: ["run_tests"],
  },
]);

/** Снимок карты в порядке объявления (детерминированный). */
export function buildRepoMap(): RepoMapEntry[] {
  return REPO_MAP.map((entry) => ({ ...entry, taskTypes: [...entry.taskTypes] }));
}

/** Отбор файлов по нормализованному типу задачи (без чтения содержимого). */
export function selectRepoFiles(taskType: string): RepoMapEntry[] {
  const key = normalizeTaskType(String(taskType ?? ""));
  return buildRepoMap().filter(
    (entry) =>
      entry.taskTypes.includes("*") ||
      (key !== "" && entry.taskTypes.some((tag) => normalizeTaskType(tag) === key)),
  );
}

/** Окна контекста моделей в токенах (детерминированная таблица, без сети). */
export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  "local-3b": 4_096,
  "local-7b": 8_192,
  "local-14b": 16_384,
  "cloud-large": 128_000,
});

export const DEFAULT_CONTEXT_MODEL = "local-7b";
/** Часть окна, отводимая под вход: остаток — резерв ответа модели. */
export const DEFAULT_BUDGET_RATIO = 0.75;
export const DEFAULT_MAX_FILES = 12;
export const DEFAULT_MAX_FILE_BYTES = 16_000;
export const DEFAULT_MAX_EXAMPLES = 5;
export const DEFAULT_MAX_EVIDENCE_BYTES = 8_000;

/** Возвращает окно модели; неизвестная модель получает базовое окно. */
export function contextWindowForModel(model: string): number {
  const key = String(model ?? "").trim() || DEFAULT_CONTEXT_MODEL;
  return MODEL_CONTEXT_WINDOWS[key] ?? MODEL_CONTEXT_WINDOWS[DEFAULT_CONTEXT_MODEL];
}

/** Детерминированная оценка токенов: ~4 символа на токен. */
export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? "").length / 4);
}

/** Файл, вошедший в контекст. */
export interface ContextFile {
  path: string;
  description: string;
  content: string;
  critical: boolean;
  bytes: number;
}

/** Few-shot пример из gate-passed строки ledger-а. */
export interface ContextExample {
  outcomeKey: string;
  taskType: string;
  evidencePath: string | null;
  content: string;
  createdAt: string;
}

/** Собранный контекст шага: полностью выводим из ledger и карты. */
export interface CompiledContext {
  taskType: string;
  model: string;
  contextWindow: number;
  tokenBudget: number;
  estimatedTokens: number;
  repoMap: { path: string; description: string }[];
  files: ContextFile[];
  examples: ContextExample[];
  /** Пути/ключи, отброшенные дедупликацией. */
  deduplicated: string[];
  /** Файлы, не попавшие в контекст из-за лимитов или бюджета. */
  droppedFiles: string[];
  /** Было ли усечение (по лимиту или бюджету). */
  truncated: boolean;
  /** SHA-256 канонического представления — воспроизводимость сборки. */
  contextHash: string;
  compiledFrom: "ledger";
}

/** Параметры сборки контекста. */
export interface CompileContextOptions {
  taskType: string;
  model?: string;
  /** Явное окно в токенах; приоритетнее таблицы моделей. */
  contextWindow?: number;
  /** Явный бюджет в токенах; приоритетнее `contextWindow * 0.75`. */
  tokenBudget?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxExamples?: number;
  maxEvidenceBytes?: number;
  /** База для чтения файлов карты и proof-файлов ledger-а. */
  rootDir?: string;
  /** Подмена содержимого по пути — для тестов и встроенных файлов. */
  files?: Readonly<Record<string, string>>;
}

function readSourceFile(
  filePath: string,
  options: CompileContextOptions,
): string {
  const override = options.files?.[filePath];
  if (override !== undefined) return String(override);
  if (!options.rootDir) return "";
  try {
    return fs.readFileSync(path.join(options.rootDir, filePath), "utf8");
  } catch {
    return "";
  }
}

function clampInt(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.floor(value));
}

/**
 * Собирает контекст шага детерминированно: карта → отбор по типу задачи →
 * дедупликация → лимиты → scrub → gate-passed примеры из ledger → бюджет.
 * Никаких меток времени «сейчас» и случайностей: повторный вызов на том же
 * состоянии ledger даёт тот же `contextHash`.
 */
export function compileRunContext(options: CompileContextOptions): CompiledContext {
  const taskType = normalizeTaskType(String(options.taskType ?? ""));
  if (taskType === "") {
    throw new Error("Пустой тип задачи: компиляция контекста невозможна.");
  }
  const model = String(options.model ?? DEFAULT_CONTEXT_MODEL).trim() || DEFAULT_CONTEXT_MODEL;
  const contextWindow = clampInt(options.contextWindow, contextWindowForModel(model), 1);
  const tokenBudget = clampInt(
    options.tokenBudget,
    Math.max(1, Math.floor(contextWindow * DEFAULT_BUDGET_RATIO)),
    1,
  );
  const maxFiles = clampInt(options.maxFiles, DEFAULT_MAX_FILES, 0);
  const maxFileBytes = clampInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1);
  const maxExamples = clampInt(options.maxExamples, DEFAULT_MAX_EXAMPLES, 0);
  const maxEvidenceBytes = clampInt(options.maxEvidenceBytes, DEFAULT_MAX_EVIDENCE_BYTES, 1);

  const repoMap = buildRepoMap().map((entry) => ({
    path: entry.path,
    description: entry.description,
  }));

  // --- Файлы: отбор, дедуп по пути и содержимому, лимиты, scrub ---------------
  const seenPaths = new Set<string>();
  const seenContent = new Set<string>();
  const deduplicated: string[] = [];
  const candidates: ContextFile[] = [];
  const droppedFiles: string[] = [];
  let truncated = false;
  for (const entry of selectRepoFiles(taskType)) {
    if (seenPaths.has(entry.path)) {
      deduplicated.push(entry.path);
      continue;
    }
    seenPaths.add(entry.path);
    if (candidates.length >= maxFiles) {
      droppedFiles.push(entry.path);
      truncated = true;
      continue;
    }
    const raw = readSourceFile(entry.path, options);
    if (raw === "" && !entry.critical) continue;
    const scrubbed = redactSecretsInText(raw);
    if (scrubbed.length > maxFileBytes) truncated = true;
    const content = scrubbed.slice(0, maxFileBytes);
    if (seenContent.has(content)) {
      deduplicated.push(entry.path);
      continue;
    }
    seenContent.add(content);
    candidates.push({
      path: entry.path,
      description: entry.description,
      content,
      critical: Boolean(entry.critical),
      bytes: content.length,
    });
  }

  // --- Примеры: только gate-passed строки ledger с совпавшим типом -----------
  const examples: ContextExample[] = [];
  const seenEvidence = new Set<string>();
  const passed = readGateOutcomeLedger()
    .rows.filter(
      (row) =>
        row.verdict === "pass" &&
        normalizeTaskType(row.taskType ?? "") === taskType,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  for (const row of passed) {
    if (examples.length >= maxExamples) break;
    const evidencePath = row.evidencePath ?? null;
    const dedupKey = evidencePath ?? `ledger:${row.outcomeKey}`;
    if (seenEvidence.has(dedupKey)) {
      deduplicated.push(dedupKey);
      continue;
    }
    seenEvidence.add(dedupKey);
    const raw = evidencePath ? readSourceFile(evidencePath, options) : "";
    const content = redactSecretsInText(
      raw === "" ? `gate-passed: ${row.outcomeKey}` : raw,
    ).slice(0, maxEvidenceBytes);
    examples.push({
      outcomeKey: row.outcomeKey,
      taskType: row.taskType ?? taskType,
      evidencePath,
      content,
      createdAt: row.createdAt,
    });
  }

  // --- Бюджет токенов: считаем ровно тот документ, что попадёт в результат ---
  const kept: ContextFile[] = candidates.map((item) => ({ ...item }));
  const keptExamples: ContextExample[] = examples.map((item) => ({ ...item }));
  const keptMap = repoMap.map((item) => ({ ...item }));
  const tokensOf = (): number =>
    estimateTokens(
      JSON.stringify({
        taskType,
        model,
        contextWindow,
        tokenBudget,
        repoMap: keptMap,
        examples: keptExamples,
        files: kept,
      }),
    );

  /** Индекс последнего элемента, удовлетворяющего условию, либо -1. */
  const lastIndex = <T,>(items: T[], predicate: (item: T) => boolean): number => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (predicate(items[index])) return index;
    }
    return -1;
  };

  /**
   * Усечение с гарантией строгого уменьшения длины: короткий маркер не может
   * «съесть» выгоду от половинного усечения (иначе цикл не сходится).
   */
  const BUDGET_MARK = "[cut]";
  const shrink = (text: string): string => {
    if (text.length <= BUDGET_MARK.length) return BUDGET_MARK;
    const keep = Math.max(
      0,
      Math.min(Math.floor(text.length / 2), text.length - BUDGET_MARK.length - 1),
    );
    return text.slice(0, keep) + BUDGET_MARK;
  };

  // 1) Некритичные файлы уходят первыми, с конца карты.
  while (tokensOf() > tokenBudget) {
    const index = lastIndex(kept, (item) => !item.critical);
    if (index === -1) break;
    droppedFiles.push(...kept.splice(index, 1).map((item) => item.path));
    truncated = true;
  }
  // 2) Лишние примеры (хотя бы один остаётся).
  while (tokensOf() > tokenBudget && keptExamples.length > 1) {
    keptExamples.pop();
    truncated = true;
  }
  // 3) Критичные файлы усекаются по содержимому, но не удаляются.
  while (tokensOf() > tokenBudget) {
    const target = kept.find((item) => item.content.length > BUDGET_MARK.length);
    if (!target) break;
    target.content = shrink(target.content);
    target.bytes = target.content.length;
    truncated = true;
  }
  // 4) Содержимое примеров; если и этого мало — примеры уходят целиком.
  while (tokensOf() > tokenBudget) {
    const target = keptExamples.find((item) => item.content.length > BUDGET_MARK.length);
    if (target) {
      target.content = shrink(target.content);
      truncated = true;
      continue;
    }
    if (keptExamples.length === 0) break;
    keptExamples.pop();
    truncated = true;
  }
  // 5) Описания карты — последний резерв.
  while (tokensOf() > tokenBudget) {
    const target = keptMap.find((item) => item.description.length > 0);
    if (!target) break;
    target.description = target.description.slice(
      0,
      Math.max(0, Math.floor(target.description.length / 2)),
    );
    truncated = true;
  }
  // 6) Абсолютный резерв: если критичных файлов несколько, оставляем один.
  while (tokensOf() > tokenBudget && kept.length > 1) {
    droppedFiles.push(...kept.splice(-1, 1).map((item) => item.path));
    truncated = true;
  }

  const canonical = JSON.stringify({
    taskType,
    model,
    contextWindow,
    tokenBudget,
    repoMap: keptMap,
    examples: keptExamples,
    files: kept,
  });
  return {
    taskType,
    model,
    contextWindow,
    tokenBudget,
    estimatedTokens: estimateTokens(canonical),
    repoMap: keptMap,
    files: kept,
    examples: keptExamples,
    deduplicated,
    droppedFiles,
    truncated,
    contextHash: createHash("sha256").update(canonical).digest("hex"),
    compiledFrom: "ledger",
  };
}

/** Причина пересборки контекста при эскалации. */
export type RecompileReason = "model-changed" | "window-changed" | "same-window";

/** Результат пересборки: всегда свежий контекст, никогда не старый объект. */
export interface ContextRecompile {
  context: CompiledContext;
  rebuilt: boolean;
  reason: RecompileReason;
  previousModel: string;
  previousWindow: number;
}

/**
 * ARCH-5.2: при эскалации (другая модель → другое окно) контекст собирается
 * заново из ledger, а не переиспользуется. Даже если модель не изменилась,
 * возвращается новый объект: источник истины — ledger, а не previous.
 */
export function recompileContextOnEscalation(
  previous: CompiledContext,
  options: Omit<CompileContextOptions, "taskType"> & { taskType?: string } = {},
): ContextRecompile {
  const context = compileRunContext({
    ...options,
    taskType: options.taskType ?? previous.taskType,
  });
  const reason: RecompileReason =
    previous.model !== context.model
      ? "model-changed"
      : previous.contextWindow !== context.contextWindow
        ? "window-changed"
        : "same-window";
  return {
    context,
    rebuilt: true,
    reason,
    previousModel: previous.model,
    previousWindow: previous.contextWindow,
  };
}
