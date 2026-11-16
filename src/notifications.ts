import {
  loadSettings,
  saveSettings,
  type DigestFrequency,
  type DigestSettings,
  type NotificationFilters,
  type NotificationSettings,
  type NotificationTemplates,
  isShadowActive,
  type TriageSettings,
  type NotificationDedupSettings,
  type NotificationEmbeddingSettings,
} from "./settings.js";
import {
  buildAnalytics,
  type AnalyticsRecord,
  type ErrorAnalyticsRow,
} from "./core/analytics.js";
import { getHistory } from "./db/history-repo.js";
import { getDb } from "./db/index.js";
import { sendTelegramMessage } from "./core/telegram.js";
import { sendNativeNotification } from "./core/native-notify.js";
import { decideTriage } from "./core/triage-chain.js";
import { recordTriageOutcome } from "./core/triage-shadow.js";
import { scheduleTriageJob } from "./core/triage-worker.js";
import type { TriageInput } from "./core/triage.js";
import { t } from "./i18n.js";

/** Статус завершения задачи, который приходит из record-history. */
export type NotificationStatus = "success" | "error" | "timeout" | string;

/** Содержимое уведомления. */
export interface NotificationPayload {
  taskName: string;
  status: NotificationStatus;
  durationMs: number;
  error?: string | null;
  /** Потраченные токены, если известны. */
  tokens?: number | null;
  /** Стоимость запуска в USD, если известна. */
  costUsd?: number | null;
}

/** Настройки асинхронного триажа (Спринт 31.7). */
export interface NotifyTaskOptions {
  /**
   * Для `llm`/`auto`: доставить уведомление сразу, а вердикт посчитать
   * в отдельном процессе. Тесты и прямые вызовы без опции сохраняют
   * синхронное поведение.
   */
  asyncTriage?: boolean;
  /** Для тестов: подменить запуск фонового процесса. */
  scheduleTriage?: (input: TriageInput, triage: TriageSettings) => unknown;
}

/** Таймаут HTTP-запроса по умолчанию: уведомление не должно подвешивать задачу. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Максимальная задержка backoff между повторами. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Человекочитаемая длительность: 2300 мс → «2.3s». */
export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Number(durationMs) || 0) / 1000;
  return `${seconds.toFixed(1)}s`;
}

/** Экранирует regexp-спецсимволы. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Сопоставление имени задачи с шаблоном: `*` — любая последовательность,
 * регистр не важен. `regen-*` покрывает `regen-api`, `regen-ui`.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  const trimmed = (pattern ?? "").trim();
  if (!trimmed) return false;
  const source = trimmed
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value.trim());
}

/** Проверяет, разрешена ли задача фильтрами include/exclude. */
export function isTaskAllowed(
  taskName: string,
  filters?: NotificationFilters
): boolean {
  if (!filters) return true;
  const name = (taskName ?? "").trim();
  if (!name) return false;
  const exclude = filters.exclude ?? [];
  if (exclude.some((pattern) => wildcardMatch(pattern, name))) return false;
  const include = filters.include ?? [];
  if (include.length === 0) return true;
  return include.some((pattern) => wildcardMatch(pattern, name));
}

/** Подставляет {key} в шаблон; неизвестные плейсхолдеры остаются как есть. */
export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}

/**
 * Формат сообщения по умолчанию:
 *  ✅ Задача "Тест" выполнена (2.3s)
 *  ❌ Задача "Тест" упала (2.3s): Quality Gate провален
 */
export function formatNotificationMessage(
  payload: NotificationPayload,
  templates?: NotificationTemplates
): string {
  const { taskName, status, durationMs, error } = payload;
  const duration = formatDuration(durationMs);
  const isSuccess = status === "success";
  const reason =
    typeof error === "string" && error.trim()
      ? t("notify.reason", { error: error.trim() })
      : "";
  const tokens =
    typeof payload.tokens === "number" && payload.tokens > 0
      ? t("notify.usage.tokens", { tokens: String(Math.round(payload.tokens)) })
      : "";
  const cost =
    typeof payload.costUsd === "number" && payload.costUsd > 0
      ? `$${payload.costUsd.toFixed(4)}`
      : "";
  const usage = [tokens, cost].filter(Boolean).join(" · ");
  const usageSuffix = usage ? ` · ${usage}` : "";
  const costVar = usageSuffix;
  const tokensVar = tokens;

  if (templates && isSuccess && templates.success.trim()) {
    return renderTemplate(templates.success, {
      task: taskName,
      status,
      duration,
      error: "",
      emoji: "✅",
      cost: costVar,
      tokens: tokensVar,
    });
  }
  if (templates && !isSuccess && templates.error.trim()) {
    return renderTemplate(templates.error, {
      task: taskName,
      status,
      duration,
      error: reason,
      emoji: "❌",
      cost: costVar,
      tokens: tokensVar,
    });
  }

  if (isSuccess) {
    return t("notify.task.success", {
      task: taskName,
      duration,
      cost: usageSuffix,
    });
  }
  return t("notify.task.error", {
    task: taskName,
    duration,
    error: reason,
    cost: usageSuffix,
  });
}

/** Информация о завершении матрицы для уведомления. */
export interface MatrixNotificationInfo {
  parentName: string;
  status: "success" | "error" | "partial";
  total: number;
  success: number;
  error: number;
  message?: string | null;
}

/** Текст уведомления о завершении матрицы. */
export function formatMatrixMessage(info: MatrixNotificationInfo): string {
  const { parentName, status, total, success, error } = info;
  const params = { parent: parentName, total, success, error };
  if (status === "success") {
    return t("notify.matrix.success", params);
  }
  if (status === "partial") {
    return t("notify.matrix.partial", params);
  }
  if (total > 0 && error >= total) {
    return t("notify.matrix.failedAll", params);
  }
  return t("notify.matrix.failed", params);
}

/** Ошибка отправки webhook с признаком, имеет ли смысл повторять запрос. */
class WebhookError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export interface WebhookOptions {
  /** Таймаут одной попытки в мс (по умолчанию 10 с). */
  timeoutMs?: number;
  /** Сколько раз повторить после неудачи (по умолчанию 0). */
  retryCount?: number;
  /** Базовая задержка backoff в мс (по умолчанию 1000). */
  retryDelayMs?: number;
  /** Подмена sleep для тестов. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function validateWebhookUrl(url: string): URL {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    throw new Error(t("notify.error.webhookUrlMissing"));
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(t("notify.error.webhookUrlInvalid"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("notify.error.webhookScheme"));
  }
  return parsed;
}

/** Одна попытка POST. Бросает WebhookError с признаком retryable. */
async function postOnce(
  parsed: URL,
  message: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const retryable = response.status >= 500 || response.status === 429;
      throw new WebhookError(
        `HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        retryable
      );
    }
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new WebhookError(
        t("notify.error.webhookTimeout", { seconds: timeoutMs / 1000 }),
        true
      );
    }
    if (err instanceof WebhookError) throw err;
    // Сетевые ошибки fetch (DNS, соединение) имеет смысл повторять.
    throw new WebhookError(err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Отправляет POST на webhook с повторами и экспоненциальным backoff.
 *
 * Тело совместимо одновременно с Discord (`content`) и Slack (`text`).
 * Повторяются только сетевые ошибки, таймауты, 5xx и 429; прочие 4xx — сразу
 * ошибка (повтор не поможет). Бросает исключение только для диагностики —
 * вызывающий код обязан перехватить его, чтобы уведомление не ломало задачу.
 */
export async function sendWebhook(
  url: string,
  message: string,
  options: WebhookOptions = {}
): Promise<void> {
  const parsed = validateWebhookUrl(url);
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? REQUEST_TIMEOUT_MS));
  const retryCount = Math.max(0, Math.floor(options.retryCount ?? 0));
  const retryDelayMs = Math.max(1, Math.floor(options.retryDelayMs ?? 1_000));
  const sleep = options.sleep ?? defaultSleep;

  const attempts = retryCount + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await postOnce(parsed, message, timeoutMs);
      return;
    } catch (err) {
      lastError = err;
      const retryable = err instanceof WebhookError ? err.retryable : true;
      if (!retryable || attempt === attempts - 1) break;
      const delay = Math.min(
        MAX_RETRY_DELAY_MS,
        retryDelayMs * 2 ** attempt
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function webhookOptionsFrom(config: NotificationSettings): WebhookOptions {
  const webhook = config.webhook;
  return {
    timeoutMs: webhook?.timeoutMs,
    retryCount: webhook?.retryCount,
    retryDelayMs: webhook?.retryDelayMs,
  };
}

/** Канал доставки уведомлений. */
export type NotificationChannel = "webhook" | "telegram" | "native";

/** Результат отправки в один канал. */
export interface ChannelDeliveryResult {
  channel: NotificationChannel;
  ok: boolean;
  error?: string;
}

/**
 * Тихие часы: true, если сейчас действует окно `quiet`. Диапазон может
 * переходить через полночь (22:00 → 08:00). Некорректное время — false.
 */
export function isQuietHours(
  now: Date,
  quiet?: { enabled?: boolean; from?: string; to?: string } | null
): boolean {
  if (!quiet?.enabled) return false;
  const parse = (value: unknown): number | null => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(
      typeof value === "string" ? value.trim() : ""
    );
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const from = parse(quiet.from);
  const to = parse(quiet.to);
  if (from === null || to === null) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (from === to) return true;
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

/** URL дашборда: настройка, иначе фактический порт сервера, иначе null. */
async function resolveDashboardUrl(
  config: NotificationSettings
): Promise<string | null> {
  const custom = (config.dashboardUrl ?? "").trim();
  if (custom) return custom;
  try {
    const { getDashboardPort } = await import("./server.js");
    const port = getDashboardPort();
    return port ? `http://localhost:${port}` : null;
  } catch {
    return null;
  }
}

/** Токен и chat_id Telegram: настройки важнее переменных окружения. */
function telegramCredentials(config: NotificationSettings): {
  token: string;
  chatId: string;
} {
  const token =
    (config.telegram?.botToken ?? "").trim() ||
    (process.env.OPENCODE_SCHEDULER_TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId =
    (config.telegram?.chatId ?? "").trim() ||
    (process.env.OPENCODE_SCHEDULER_TELEGRAM_CHAT_ID ?? "").trim();
  return { token, chatId };
}

/**
 * Отправляет сообщение во все включённые каналы и возвращает результат
 * по каждому. Ошибки каналов не прерывают остальные и не содержат секретов.
 */
async function deliverDetailed(
  config: NotificationSettings,
  message: string,
  only?: NotificationChannel
): Promise<ChannelDeliveryResult[]> {
  const results: ChannelDeliveryResult[] = [];
  const dashboardUrl = await resolveDashboardUrl(config);

  const webhook = config.webhook;
  if (
    (!only || only === "webhook") &&
    config.enabled &&
    webhook?.enabled &&
    webhook.url.trim()
  ) {
    try {
      await sendWebhook(webhook.url, message, webhookOptionsFrom(config));
      console.log("[windows-scheduler] Уведомление отправлено в webhook.");
      results.push({ channel: "webhook", ok: true });
    } catch (err: any) {
      const text = err instanceof Error ? err.message : String(err);
      console.error(`[windows-scheduler] Webhook: ${text}`);
      results.push({ channel: "webhook", ok: false, error: text });
    }
  }

  const telegram = config.telegram;
  if ((!only || only === "telegram") && config.enabled && telegram?.enabled) {
    const { token, chatId } = telegramCredentials(config);
    if (!token || !chatId) {
      const text = t("notify.error.telegramNoCreds");
      console.error(`[windows-scheduler] ${text}`);
      results.push({ channel: "telegram", ok: false, error: text });
    } else {
      try {
        await sendTelegramMessage(token, chatId, message, {
          apiBase: telegram.apiBase,
          parseMode: telegram.parseMode,
          disableNotification: telegram.disableNotification,
          messageThreadId: telegram.messageThreadId,
          includeDashboardLink: telegram.includeDashboardLink,
          dashboardUrl,
        });
        console.log("[windows-scheduler] Уведомление отправлено в Telegram.");
        results.push({ channel: "telegram", ok: true });
      } catch (err: any) {
        const text = err instanceof Error ? err.message : String(err);
        console.error(`[windows-scheduler] Telegram: ${text}`);
        results.push({ channel: "telegram", ok: false, error: text });
      }
    }
  }

  const native = config.native;
  if ((!only || only === "native") && config.enabled && native?.enabled) {
    const result = await sendNativeNotification(
      { title: t("notify.native.title"), body: message, sound: native.sound },
      {}
    );
    if (result.success) {
      console.log("[windows-scheduler] Нативное уведомление показано.");
      results.push({ channel: "native", ok: true });
    } else {
      const text = result.error ?? t("notify.error.nativeFailed");
      console.error(`[windows-scheduler] Нативное уведомление: ${text}`);
      results.push({ channel: "native", ok: false, error: text });
    }
  }

  return results;
}

/** Отправляет текст во все включённые каналы; true — хотя бы один успешен. */
async function deliver(config: NotificationSettings, message: string): Promise<boolean> {
  const results = await deliverDetailed(config, message);
  return results.some((item) => item.ok);
}

/**
 * Уведомляет о завершении задачи во все включённые каналы.
 *
 * Правила:
 *  - `notifications.enabled === false` — ничего не делает;
 *  - `onlyOnError === true` — успешные запуски пропускаются;
 *  - фильтры include/exclude отсекают задачи по имени;
 *  - ошибки отправки только логируются, наружу не выбрасываются.
 */

/**
 * Дедуп уведомлений (Спринт 31.2): группирует повторяющиеся уведомления о
 * задаче в окне времени, считает повторы и не подавляет важные статусы.
 *
 * Ключ группировки: taskName + status. Запись хранится в SQLite, поэтому
 * счётчик сохраняется между короткоживущими процессами record-history.
 */
export interface DedupRecord {
  key: string;
  taskName: string;
  status: string;
  count: number;
  firstAt: string;
  lastAt: string;
  windowMinutes: number;
}

/** Ключ дедупа: комбинация задачи и статуса. */
function dedupKey(taskName: string, status: string): string {
  return (taskName + '|' + status).toLowerCase();
}

/** Читает или создаёт запись дедупа. Возвращает { record, isDuplicate }.
 * Если записи нет или окно истекло — создаёт новую с count=1.
 * Если есть и окно ещё активно — увеличивает count и возвращает isDuplicate=true.
 */
function dedupReadOrCreate(
  db: ReturnType<typeof getDb>,
  key: string,
  taskName: string,
  status: string,
  dedup: NotificationDedupSettings
): { record: DedupRecord; isDuplicate: boolean } {
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT * FROM notification_dedup WHERE key = ?")
    .get(key);

  if (!row) {
    db.prepare(
      "INSERT INTO notification_dedup (key, task_name, status, count, first_at, last_at, window_minutes) VALUES (?, ?, ?, 1, ?, ?, ?)"
    ).run(key, taskName, status, now, now, dedup.windowMinutes);
    return {
      record: {
        key,
        taskName,
        status,
        count: 1,
        firstAt: now,
        lastAt: now,
        windowMinutes: dedup.windowMinutes,
      },
      isDuplicate: false,
    };
  }

  const last = new Date(row.last_at).getTime();
  const nowMs = new Date(now).getTime();
  const windowMs = (row.window_minutes ?? dedup.windowMinutes) * 60 * 1000;

  if (nowMs - last > windowMs) {
    // Окно истекло — начинаем заново.
    db.prepare(
      "UPDATE notification_dedup SET count = 1, first_at = ?, last_at = ?, window_minutes = ? WHERE key = ?"
    ).run(now, now, dedup.windowMinutes, key);
    return {
      record: {
        key,
        taskName,
        status,
        count: 1,
        firstAt: now,
        lastAt: now,
        windowMinutes: dedup.windowMinutes,
      },
      isDuplicate: false,
    };
  }

  const count = Math.min(Number(row.count) + 1, dedup.maxCount);
  db.prepare(
    "UPDATE notification_dedup SET count = ?, last_at = ? WHERE key = ?"
  ).run(count, now, key);
  return {
    record: {
      key,
      taskName,
      status,
      count,
      firstAt: row.first_at,
      lastAt: now,
      windowMinutes: row.window_minutes ?? dedup.windowMinutes,
    },
    isDuplicate: true,
  };
}

/** Подавлять ли уведомление по дедупу: только если не важный статус. */
function isDedupSuppressed(
  status: string,
  dedup: NotificationDedupSettings
): boolean {
  const important = dedup.importantStatuses.some(
    (s: string) => s.toLowerCase() === status.toLowerCase()
  );
  return !important;
}

/** Добавляет счётчик повторов к сообщению, если это не первое уведомление. */
function messageWithDedupCount(message: string, count: number): string {
  if (count <= 1) return message;
  return message + ' ' + t("notify.dedup.count", { count });
}

/**
 * Эмбеддинг-дедуп (Спринт 31.1): семантическое подавление похожих уведомлений.
 *
 * Вектор сообщения считается простым баг-векторизатором (bag-of-words с
 * TF-IDF-like взвешиванием) — без новых зависимостей, как требует дорожная
 * карта. Косинусное сходство считается брутфорсом по всем векторам в окне.
 * В будущем можно заменить на nomic-embed-text-v2-moe или другую модель.
 */

interface EmbeddingRecord {
  key: string;
  task_name: string;
  status: string;
  message_text: string;
  embedding: number[];
  dimension: number;
  created_at: string;
  window_minutes: number;
}

function embeddingKey(taskName: string, status: string): string {
  return `emb:${(taskName + '|' + status).toLowerCase()}`;
}

/** Простой токенизатор: слова, цифры, нижний регистр. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Вектор сообщения: нормализованный bag-of-words. Длина 1. */
function textToVector(text: string): number[] {
  const tokens = tokenize(text);
  const counts: Record<string, number> = {};
  for (const tok of tokens) counts[tok] = (counts[tok] ?? 0) + 1;
  const dim = Object.keys(counts).length;
  const vec: number[] = new Array(dim).fill(0);
  let norm = 0;
  let i = 0;
  for (const tok of Object.keys(counts)) {
    const v = Math.sqrt(counts[tok]) / Math.sqrt(tokens.length);
    vec[i] = v;
    norm += v * v;
    i++;
  }
  norm = Math.sqrt(norm) || 1;
  for (let j = 0; j < dim; j++) vec[j] /= norm;
  return vec;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1;
  return dot / denom;
}

/** Проверяет, есть ли в БД вектор, достаточно похожий на text. */
function embeddingExists(
  db: ReturnType<typeof getDb>,
  taskName: string,
  status: string,
  message: string,
  threshold: number,
  windowMinutes: number
): { found: boolean; key: string } | null {
  const since = new Date(
    Date.now() - windowMinutes * 60_000
  ).toISOString();
  const rows = db
    .prepare(
      "SELECT key, embedding_json, dimension, created_at FROM notification_embeddings WHERE created_at >= ?"
    )
    .all(since) as Array<{
    key: string;
    embedding_json: string;
    dimension: number;
    created_at: string;
  }>;
  const vec = textToVector(message);
  let bestKey = "";
  let bestSim = 0;
  for (const row of rows) {
    try {
      const emb: number[] = JSON.parse(row.embedding_json);
      if (emb.length !== vec.length) continue;
      const sim = cosineSimilarity(vec, emb);
      if (sim > bestSim) {
        bestSim = sim;
        bestKey = row.key;
      }
    } catch {
      // пропускаем битую запись
    }
  }
  if (bestSim >= threshold) return { found: true, key: bestKey };
  return null;
}

/** Сохраняет вектор сообщения в БД. */
function storeEmbedding(
  db: ReturnType<typeof getDb>,
  taskName: string,
  status: string,
  message: string,
  vector: number[],
  windowMinutes: number
): void {
  const now = new Date().toISOString();
  const key = embeddingKey(taskName, status);
  db.prepare(
    "INSERT OR REPLACE INTO notification_embeddings (key, task_name, status, message_text, embedding_json, dimension, created_at, window_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    key,
    taskName,
    status,
    message,
    JSON.stringify(vector),
    vector.length,
    now,
    windowMinutes
  );
}

/** Очищает старые векторы вне окна. */
function cleanupEmbeddings(
  db: ReturnType<typeof getDb>,
  windowMinutes: number
): void {
  const since = new Date(
    Date.now() - windowMinutes * 60_000
  ).toISOString();
  db.prepare(
    "DELETE FROM notification_embeddings WHERE created_at < ?"
  ).run(since);
}

export async function notifyTaskCompletion(
  taskName: string,
  status: NotificationStatus,
  durationMs: number,
  error?: string | null,
  tokens?: number | null,
  costUsd?: number | null,
  options: NotifyTaskOptions = {}
): Promise<void> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return;
    if (config.onlyOnError && status === "success") return;
    if (!isTaskAllowed(taskName, config.filters)) return;
    // Тихие часы подавляют успешные запуски, но не ошибки и таймауты.
    if (
      isQuietHours(new Date(), config.quietHours) &&
      status !== "error" &&
      status !== "timeout"
    ) {
      return;
    }

    // Триаж (31.7): в llm/auto уведомление не ждёт локальную модель.
    // Вердикт считается фоновым процессом и пишется в persistent-аудит.
    // В rules правила остаются синхронными, потому что только они подавляют.
    // В shadow-режиме решение фиксируется, но уведомление не подавляется.
    const triageInput = { taskName, status, error, durationMs, tokens, costUsd };
    const triageSettings = config.triage;
    const mode = triageSettings?.mode ?? "off";
    const shadowActive = isShadowActive(triageSettings?.shadow);

    if (triageSettings && (mode === "llm" || mode === "auto") && options.asyncTriage) {
      try {
        const job = (options.scheduleTriage ?? scheduleTriageJob)(
          triageInput,
          triageSettings
        );
        // Injected scheduler может быть асинхронным — не оставляем rejection.
        if (job && typeof (job as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(job).catch((err: any) => {
            console.error(
              `[windows-scheduler] Ошибка фонового триажа: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          });
        }
      } catch (err: any) {
        console.error(
          `[windows-scheduler] Не удалось запустить фоновый триаж: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    } else if (mode !== "off") {
      const triage = await decideTriage(triageInput, triageSettings);
      const suppressed = !shadowActive && triage.action === "skip";
      recordTriageOutcome(triageInput, triage, { shadowActive, suppressed });
      if (suppressed) return;
    }

    // Дедуп (31.2): группирует похожие уведомления в окне времени,
    // считает повторы, но не подавляет важные статусы.
    let dedupCount = 1;
    if (config.dedup?.enabled && config.dedup.suppressDuplicates) {
      const db = getDb();
      const key = dedupKey(taskName, status);
      const { record, isDuplicate } = dedupReadOrCreate(
        db,
        key,
        taskName,
        status,
        config.dedup
      );
      dedupCount = record.count;
      if (isDuplicate && isDedupSuppressed(status, config.dedup)) {
        return;
      }
    }

    // Эмбеддинг-дедуп (31.1): семантическое подавление похожих сообщений.
    // Проверяется после rule-based дедупа: если вектор совпадает с существующим
    // на пороге threshold, уведомление подавляется (если не важный статус).
    if (config.embedding?.enabled && config.embedding.suppressDuplicates) {
      const db = getDb();
      const message = messageWithDedupCount(
        formatNotificationMessage(
          { taskName, status, durationMs, error, tokens, costUsd },
          config.templates
        ),
        dedupCount
      );
      const hit = embeddingExists(
        db,
        taskName,
        status,
        message,
        config.embedding.threshold,
        config.embedding.windowMinutes ?? 60
      );
      if (
        hit &&
        !isDedupSuppressed(status, config.dedup ?? {
          enabled: false,
          windowMinutes: 60,
          suppressDuplicates: false,
          importantStatuses: ["error", "timeout"],
          maxCount: 999,
        })
      ) {
        return;
      }
      const vec = textToVector(message);
      storeEmbedding(
        db,
        taskName,
        status,
        message,
        vec,
        config.embedding.windowMinutes ?? 60
      );
      cleanupEmbeddings(db, config.embedding.windowMinutes ?? 60);
    }

    const message = messageWithDedupCount(
      formatNotificationMessage(
        { taskName, status, durationMs, error, tokens, costUsd },
        config.templates
      ),
      dedupCount
    );
    await deliver(config, message);
  } catch (err: any) {
    // Уведомление не должно ломать запись истории и саму задачу.
    console.error(
      `[windows-scheduler] Ошибка подготовки уведомления: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Уведомляет о завершении матрицы (Спринт 20).
 *
 * partial — только при `matrix.onPartial`; полный провал — при
 * `matrix.onAllFailed`; успех — только когда `onlyOnError === false`.
 */
export async function notifyMatrixCompletion(
  info: MatrixNotificationInfo
): Promise<void> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return;
    const matrix = config.matrix;
    if (!matrix?.enabled) return;
    if (!isTaskAllowed(info.parentName, config.filters)) return;

    if (info.status === "partial" && !matrix.onPartial) return;
    if (info.status === "error" && !matrix.onAllFailed) return;
    if (info.status === "success" && config.onlyOnError) return;
    if (isQuietHours(new Date(), config.quietHours) && info.status !== "error") {
      return;
    }

    await deliver(config, formatMatrixMessage(info));
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка уведомления о матрице: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/** Запись о незавершённом запуске (для детектора зависших матриц). */
export interface RunningTaskRecord {
  id: number;
  taskName: string;
  startedAt: string;
}

/** Найденный зависший клон матрицы. */
export interface StuckMatrixClone {
  id: number;
  cloneName: string;
  parentName: string;
  startedAt: string;
  minutes: number;
}

/**
 * Ищет клоны матриц, которые выполняются дольше порога.
 * `parentByClone` — соответствие «имя клона → имя родителя» (без регистра).
 */
export function findStuckMatrixClones(
  running: RunningTaskRecord[],
  parentByClone: Map<string, string>,
  now: Date,
  thresholdMinutes: number
): StuckMatrixClone[] {
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) return [];
  const thresholdMs = thresholdMinutes * 60_000;
  const result: StuckMatrixClone[] = [];
  for (const record of running) {
    const parentName = parentByClone.get(record.taskName.toLowerCase());
    if (!parentName) continue;
    const started = new Date(record.startedAt).getTime();
    if (!Number.isFinite(started)) continue;
    const elapsed = now.getTime() - started;
    if (elapsed < thresholdMs) continue;
    result.push({
      id: record.id,
      cloneName: record.taskName,
      parentName,
      startedAt: record.startedAt,
      minutes: Math.floor(elapsed / 60_000),
    });
  }
  return result;
}

/** Текст уведомления о зависшем клоне матрицы. */
export function formatStuckMatrixMessage(stuck: StuckMatrixClone): string {
  return t("notify.stuck", {
    parent: stuck.parentName,
    clone: stuck.cloneName,
    minutes: stuck.minutes,
    startedAt: stuck.startedAt,
  });
}

/** Отправляет уведомление о зависшем клоне, если матрицы включены. */
export async function notifyStuckMatrix(stuck: StuckMatrixClone): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return false;
    if (!config.matrix?.enabled) return false;
    if (!isTaskAllowed(stuck.parentName, config.filters)) return false;
    return await deliver(config, formatStuckMatrixMessage(stuck));
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка уведомления о зависшей матрице: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/** Сводка для дайджеста. */
export interface DigestSummary {
  period: "daily" | "weekly";
  windowDays: number;
  total: number;
  success: number;
  error: number;
  partial: number;
  successRate: number;
  tokens: number;
  costUsd: number;
  topErrors: ErrorAnalyticsRow[];
}

/** Форматирует деньги: $0.0412. */
function formatMoney(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** Форматирует локальную дату DD.MM.YYYY. */
function formatLocalDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

/** Строит сводку дайджеста из записей истории. */
export function buildDigestSummary(
  records: AnalyticsRecord[],
  options: { frequency: DigestFrequency; now?: Date }
): DigestSummary {
  const now = options.now ?? new Date();
  const windowDays = options.frequency === "weekly" ? 7 : 1;
  const report = buildAnalytics(records, {
    days: windowDays,
    now,
    topLimit: 5,
  });
  return {
    period: options.frequency,
    windowDays,
    total: report.totals.total,
    success: report.totals.success,
    error: report.totals.error,
    partial: report.totals.partial,
    successRate: report.totals.successRate,
    tokens: report.totals.tokens,
    costUsd: report.totals.costUsd,
    topErrors: report.errors,
  };
}

/** Текст дайджеста. */
export function formatDigestMessage(
  summary: DigestSummary,
  now: Date = new Date()
): string {
  const periodLabel =
    summary.period === "weekly"
      ? t("notify.digest.period.weekly")
      : t("notify.digest.period.daily");
  const lines = [
    t("notify.digest.title", { period: periodLabel, date: formatLocalDate(now) }),
    t("notify.digest.runs", {
      total: summary.total,
      success: summary.success,
      error: summary.error,
      partial: summary.partial,
      rate: summary.successRate,
    }),
    t("notify.digest.cost", {
      cost: formatMoney(summary.costUsd),
      tokens: summary.tokens,
    }),
  ];
  if (summary.topErrors.length > 0) {
    lines.push(t("notify.digest.topErrors"));
    for (const row of summary.topErrors) {
      lines.push(
        t("notify.digest.topErrorRow", { message: row.message, count: row.count })
      );
    }
  } else if (summary.total > 0) {
    lines.push(t("notify.digest.noErrors"));
  }
  return lines.join("\n");
}

/**
 * Пора ли отправлять дайджест.
 *
 * daily — раз в сутки после `digest.time`; weekly — по понедельникам после
 * `digest.time`. `lastSentAt` защищает от повторной отправки после перезапуска.
 */
export function isDigestDue(digest: DigestSettings, now: Date): boolean {
  if (!digest.enabled) return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((digest.time ?? "").trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);

  const target = new Date(now.getTime());
  target.setHours(hour, minute, 0, 0);
  if (digest.frequency === "weekly") {
    // Понедельник текущей недели (getDay(): 0 = воскресенье).
    const offset = (target.getDay() + 6) % 7;
    target.setDate(target.getDate() - offset);
  }

  if (now.getTime() < target.getTime()) return false;
  if (!digest.lastSentAt) return true;
  const last = new Date(digest.lastSentAt).getTime();
  return !Number.isFinite(last) || last < target.getTime();
}

/**
 * Собирает и отправляет дайджест.
 *
 * `updateLastSentAt` включается только для плановой отправки: ручная кнопка
 * «Отправить сейчас» не должна сдвигать расписание.
 */
export async function sendDigestNow(
  options: { now?: Date; updateLastSentAt?: boolean } = {}
): Promise<{ success: boolean; message: string }> {
  const now = options.now ?? new Date();
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) {
      return { success: false, message: t("notify.error.digestDisabled") };
    }
    const channels: NotificationChannel[] = [];
    if (config.webhook?.enabled && config.webhook.url.trim()) channels.push("webhook");
    if (config.telegram?.enabled) channels.push("telegram");
    if (config.native?.enabled) channels.push("native");
    if (channels.length === 0) {
      return {
        success: false,
        message: t("notify.error.digestNoChannels"),
      };
    }
    const digest = config.digest;
    if (!digest) {
      return { success: false, message: t("notify.error.digestMissing") };
    }

    const records = getHistory(null, 5000) as AnalyticsRecord[];
    const summary = buildDigestSummary(records, {
      frequency: digest.frequency,
      now,
    });
    const text = formatDigestMessage(summary, now);
    if (!(await deliver(config, text))) {
      return { success: false, message: t("notify.error.digestFailed") };
    }

    if (options.updateLastSentAt) {
      await saveSettings({
        notifications: {
          ...config,
          digest: { ...digest, lastSentAt: now.toISOString() },
        },
      });
    }
    return { success: true, message: t("notify.ok.digestSent") };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Плановая проверка дайджеста: отправляет, если пора. Возвращает true при отправке. */
export async function maybeSendDigest(now: Date = new Date()): Promise<boolean> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) return false;
    const digest = config.digest;
    if (!digest?.enabled) return false;
    if (!isDigestDue(digest, now)) return false;
    const result = await sendDigestNow({ now, updateLastSentAt: true });
    if (result.success) {
      console.log("[windows-scheduler] Дайджест уведомлений отправлен.");
      return true;
    }
    console.error(`[windows-scheduler] Дайджест не отправлен: ${result.message}`);
    return false;
  } catch (err: any) {
    console.error(
      `[windows-scheduler] Ошибка дайджеста: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}

/**
 * Отправляет тестовое сообщение в выбранный канал или во все включённые
 * (кнопка «🧪 Тестовое уведомление»). В отличие от notifyTaskCompletion,
 * результат возвращается пользователю: при тесте важна причина ошибки.
 */
export async function sendTestNotification(
  channel: "all" | NotificationChannel = "all"
): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const settings = await loadSettings();
    const config = settings.notifications;
    if (!config?.enabled) {
      return {
        success: false,
        message: t("notify.error.testDisabled"),
      };
    }

    const enabled: NotificationChannel[] = [];
    if (config.webhook?.enabled && config.webhook.url.trim()) enabled.push("webhook");
    if (config.telegram?.enabled) enabled.push("telegram");
    if (config.native?.enabled) enabled.push("native");
    if (enabled.length === 0) {
      return {
        success: false,
        message: t("notify.error.testNoChannels"),
      };
    }
    if (channel !== "all" && !enabled.includes(channel)) {
      return {
        success: false,
        message: t("notify.error.testChannelOff", { channel }),
      };
    }

    const results = await deliverDetailed(
      config,
      t("notify.test.body"),
      channel === "all" ? undefined : channel
    );
    const sent = results.filter((item) => item.ok).map((item) => item.channel);
    const failed = results.filter((item) => !item.ok);
    const parts: string[] = [];
    if (sent.length > 0) {
      parts.push(t("notify.test.sent", { channels: sent.join(", ") }));
    }
    if (failed.length > 0) {
      parts.push(
        t("notify.test.errors", {
          errors: failed
            .map(
              (item) =>
                `${item.channel} — ${item.error ?? t("notify.error.testUnknown")}`
            )
            .join("; "),
        })
      );
    }
    return {
      success: failed.length === 0 && sent.length > 0,
      message: parts.join(" ") || t("notify.error.testNotSent"),
    };
  } catch (err: any) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
