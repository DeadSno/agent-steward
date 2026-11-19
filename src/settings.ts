import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR } from "./types.js";
import { DEFAULT_LOCALE, DEFAULT_LOCALE_MODE, normalizeLocale, normalizeLocaleMode, SUPPORTED_LOCALES, messageIn, t, type Locale, type LocaleMode } from "./i18n.js";
import {
  DEFAULT_PERMISSION_POLICY,
  normalizePolicy,
  type PermissionPolicy,
} from "./core/permissions.js";

/** Настройки webhook-уведомлений (Discord/Slack/generic). */
export interface WebhookNotificationSettings {
  /** Включён ли канал. */
  enabled: boolean;
  /** URL вебхука. */
  url: string;
  /** Таймаут запроса в мс (1000..120000). */
  timeoutMs: number;
  /** Сколько раз повторить при сетевой ошибке / 5xx / 429 (0..5). */
  retryCount: number;
  /** Базовая задержка backoff в мс; каждая следующая попытка ждёт вдвое дольше. */
  retryDelayMs: number;
}

/** Настраиваемые шаблоны сообщений о завершении задачи. */
export interface NotificationTemplates {
  /** Шаблон успеха. Плейсхолдеры: {task} {status} {duration} {error} {emoji}. */
  success: string;
  /** Шаблон ошибки. {error} разворачивается в «: текст» или пустую строку. */
  error: string;
}

/** Фильтры по задачам: include имеет приоритет, exclude сильнее include. */
export interface NotificationFilters {
  /** Уведомлять только эти задачи (пусто — все). Поддерживает `*`. */
  include: string[];
  /** Никогда не уведомлять эти задачи. Поддерживает `*`. */
  exclude: string[];
}

/** Уведомления о матрицах (Спринт 20). */
export interface MatrixNotificationSettings {
  /** Включены ли уведомления о матрицах. */
  enabled: boolean;
  /** Сообщать о partial (часть клонов упала). */
  onPartial: boolean;
  /** Сообщать, когда упали все клоны. */
  onAllFailed: boolean;
  /** Порог «матрица зависла» в минутах (0 — детектор выключен). */
  stuckAfterMinutes: number;
}

/** Периодичность дайджеста. */
export type DigestFrequency = "daily" | "weekly";

/** Режим локального триажа уведомлений. */
export type TriageMode = "off" | "rules" | "llm" | "auto";

/**
 * Что делать, если LLM-триаж недоступен или не уверен.
 *
 * `rules` — применить правила; `notify` — не применять правила и отправить
 * уведомление. `skip` — устаревшее имя `notify`, сохранено для совместимости.
 */
export type TriageFallback = "rules" | "notify" | "skip";

/** Поле уведомления, по которому проверяется правило. */
export type TriageRuleField = "status" | "task" | "error" | "cost";

/** Оператор сравнения правила. */
export type TriageRuleOperator =
  | "equals"
  | "contains"
  | "regex"
  | "gt"
  | "lt"
  | "gte"
  | "lte";

/** Что делать с уведомлением при совпадении правила. */
export type TriageRuleAction = "notify" | "skip";

/** Категория и серьёзность, которые выставляет правило. */
export type TriageRuleCategory =
  | "quality"
  | "timeout"
  | "permission"
  | "network"
  | "unknown";
export type TriageRuleSeverity = "low" | "medium" | "high";

/**
 * Правило триажа (Спринт 30.4).
 *
 * Правила проверяются по убыванию `priority`; при равном приоритете —
 * в порядке массива. Срабатывает только первое совпавшее правило.
 */
export interface TriageRule {
  /** Стабильный идентификатор для логов и отчётов. */
  id?: string;
  field: TriageRuleField;
  operator: TriageRuleOperator;
  /** Строка для status/task/error, число для cost. */
  value: string | number;
  category?: TriageRuleCategory;
  severity?: TriageRuleSeverity;
  /** Уверенность правила (0..1), по умолчанию 0.8. */
  confidence?: number;
  action?: TriageRuleAction;
  /** Человекочитаемая причина; иначе собирается из id и условия. */
  reason?: string;
  /** Чем больше, тем раньше проверяется. По умолчанию 0. */
  priority?: number;
}

/** Настройки локального триажа уведомлений (Спринт 30). */
export interface TriageSettings {
  /** off — триаж выключен; rules — только правила; llm — только модель; auto — модель, затем правила. */
  mode: TriageMode;
  /** База Ollama/OpenAI-совместимого API; по умолчанию локальная Ollama. */
  baseUrl: string;
  /** Идентификатор модели, например qwen3:4b. */
  model: string;
  /** Таймаут запроса к модели в мс (1000..120000). */
  timeoutMs: number;
  /** Поведение при отказе модели: правила или пропустить триаж (fail-open). */
  fallback: TriageFallback;
  /** Минимальная уверенность модели (0..1); ниже порога срабатывает fallback. */
  confidenceThreshold: number;
  /**
   * Пользовательские правила. `undefined` — встроенный набор,
   * пустой массив — правил нет.
   */
  rules?: TriageRule[];
  /** Shadow-режим триажа (Спринт 30.6): решения логируются, но не подавляются. */
  shadow?: TriageShadowSettings;
}

/** Shadow-режим триажа (Спринт 30.6). */
export interface TriageShadowSettings {
  /** Включён ли shadow-режим. По умолчанию true. */
  enabled: boolean;
  /** Сколько дней длится shadow-период. По умолчанию 14. */
  days: number;
  /** Момент начала shadow-периода (ISO). null — ещё не Started. */
  startedAt: string | null;
}

/** Дни shadow-периода по умолчанию. */
export const DEFAULT_SHADOW_DAYS = 14;

/** Дайджест по истории запусков (Спринт 20). */
export interface DigestSettings {
  /** Включён ли дайджест. */
  enabled: boolean;
  /** Ежедневно или еженедельно (по понедельникам). */
  frequency: DigestFrequency;
  /** Время отправки в формате HH:MM (локальное время сервера). */
  time: string;
  /** ISO-момент последней отправки — дедуп между перезапусками плагина. */
  lastSentAt: string | null;
}

/** parse_mode для Telegram Bot API. Пустая строка — plain text. */
export type TelegramParseMode = "" | "HTML" | "Markdown" | "MarkdownV2";

/** Telegram-канал уведомлений (Спринт 25). */
export interface TelegramNotificationSettings {
  /** Включён ли Telegram-канал. */
  enabled: boolean;
  /** Токен бота из @BotFather. Хранится только локально. */
  botToken: string;
  /** ID чата или канала-получателя. */
  chatId: string;
  /** Разметка сообщения; пусто — plain text. */
  parseMode: TelegramParseMode;
  /** Отправлять без звука. */
  disableNotification: boolean;
  /** ID темы в супергруппе (forum topic), null — обычное сообщение. */
  messageThreadId: number | null;
  /** Добавлять ссылку на локальный дашборд. */
  includeDashboardLink: boolean;
  /** База API; по умолчанию https://api.telegram.org. */
  apiBase: string;
}

/** Нативные уведомления ОС (Спринт 25). */
export interface NativeNotificationSettings {
  /** Windows Toast, macOS Notification Center, Linux notify-send. */
  enabled: boolean;
  /** Со звуком (где поддерживается). */
  sound: boolean;
}

/** Тихие часы (Спринт 25): success/partial подавляются, ошибки проходят. */
export interface QuietHoursSettings {
  /** Включён ли режим тихих часов. */
  enabled: boolean;
  /** Начало в HH:MM (локальное время). */
  from: string;
  /** Конец в HH:MM; диапазон может переходить через полночь. */
  to: string;
}

/**
 * Уведомления о завершении задач.
 *
 * Каналы: webhook (Discord/Slack/generic), Telegram Bot API и нативные
 * уведомления ОС. Все каналы опциональны и не зависят друг от друга.
 */
export interface NotificationSettings {
  /** Главный выключатель уведомлений. */
  enabled: boolean;
  /** true — отправлять только при ошибке (экономит лимиты и не спамит). */
  onlyOnError: boolean;
  /** Webhook-канал. */
  webhook?: WebhookNotificationSettings;
  /** Telegram-канал. */
  telegram?: TelegramNotificationSettings;
  /** Нативные уведомления ОС. */
  native?: NativeNotificationSettings;
  /** Тихие часы. */
  quietHours?: QuietHoursSettings;
  /** Переопределение ссылки на дашборд; пусто — порт берётся у сервера. */
  dashboardUrl?: string;
  /** Шаблоны сообщений. */
  templates?: NotificationTemplates;
  /** Фильтры по задачам. */
  filters?: NotificationFilters;
  /** Уведомления о матрицах. */
  matrix?: MatrixNotificationSettings;
  /** Периодический дайджест. */
  digest?: DigestSettings;
  /** Локальный триаж уведомлений. */
  triage?: TriageSettings;
  /** Дедуп уведомлений (Спринт 31.2). */
  dedup?: NotificationDedupSettings;
  /** Семантический дедуп через эмбеддинги (Спринт 31.1). */
  embedding?: NotificationEmbeddingSettings;
  /** Краткое саммари уведомления (Спринт 31.3). */
  summary?: NotificationSummarySettings;
}

/**
 * Саммари уведомления (Спринт 31.3): три строки для Telegram и тостов.
 * Модель возвращает строгий JSON; при отказе — детерминированное усечение.
 */
export interface NotificationSummarySettings {
  /** Включено ли саммари. По умолчанию false. */
  enabled: boolean;
  /** Максимум строк (1..3). По умолчанию 3. */
  maxLines: number;
  /** Максимум символов в строке. По умолчанию 120. */
  maxCharsPerLine: number;
  /** Таймаут запроса к модели в мс. По умолчанию 8000. */
  timeoutMs: number;
}

/**
 * Дедуп уведомлений (Спринт 31.2): группирует похожие уведомления о задаче
 * в окне времени, показывает счётчик повторов и не подавляет важные.
 */
export interface NotificationDedupSettings {
  /** Включён ли дедуп. По умолчанию false. */
  enabled: boolean;
  /** Окно группировки в минутах. По умолчанию 60. */
  windowMinutes: number;
  /** Подавлять дубликаты (false — только считать и дописывать в сообщение). */
  suppressDuplicates: boolean;
  /** Статусы, которые никогда не подавляются (всегда доставляются). */
  importantStatuses: string[];
  /** Максимальный счётчик в сообщении. */
  maxCount: number;
}

/**
 * Семантический дедуп через эмбеддинги (Спринт 31.1): группирует уведомления
 * по смыслу текста, а не только по задаче+статусу. Векторы хранятся в SQLite,
 * сравнение — косинусным сходством брутфорсом по порогу.
 */
export interface NotificationEmbeddingSettings {
  /** Включён ли семантический дедуп. По умолчанию false. */
  enabled: boolean;
  /** Подавлять семантически похожие уведомления. По умолчанию false. */
  suppressDuplicates: boolean;
  /** Окно группировки в минутах. По умолчанию 60. */
  windowMinutes: number;
  /** Порог косинусного сходства (0..1): выше — строже требуется совпадение. */
  threshold: number;
  /** Максимальное число векторов в таблице (старые удаляются). */
  maxVectors: number;
}

/**
 * Ретеншн истории (Спринт 18).
 *
 * Дашборд и метрики живут на агрегатах, поэтому удаление старых записей
 * не искажает «Всего запусков» и стоимость: чистится только сырая история.
 * 0 — соответствующее ограничение выключено.
 */
export interface HistorySettings {
  /** Удалять завершённые записи старше N дней (0 — не удалять по возрасту). */
  retentionDays: number;
  /** Хранить не более N последних записей (0 — без ограничения). */
  maxRecords: number;
  /** Когда последний раз запускалась автоочистка (ISO). */
  lastCleanupAt: string | null;
  /** Сколько записей удалила последняя очистка (для дашборда). */
  lastCleanupDeleted: number;
}

/**
 * Входящие webhook-триггеры (Спринт 22).
 *
 * Запрос: `POST /api/hooks/<task>?token=<token>` с заголовком
 * `X-Scheduler-Signature: sha256=<hmac>` (совместим с `X-Hub-Signature-256`).
 * Токен подтверждает, кто вызывает хук, HMAC — целостность тела запроса.
 */
export interface HookSettings {
  /** Включены ли входящие webhook-триггеры. */
  enabled: boolean;
  /** Общий токен в query-параметре `token` (сравнивается timing-safe). */
  token: string;
  /** Секрет для HMAC-SHA256 по сырому телу запроса. */
  secret: string;
  /** Требовать HMAC-подпись. Выключение допустимо только для локальных тестов. */
  requireSignature: boolean;
  /** Максимальный размер тела запроса в байтах (1 KiB..5 MiB). */
  maxBodyBytes: number;
  /** Допустимое расхождение `X-Scheduler-Timestamp` с текущим временем, секунды. 0 — не проверять. */
  timestampToleranceSeconds: number;
}

/** Настройки внешних интеграций (Спринт 22). */
export interface IntegrationSettings {
  /** Входящие webhook-триггеры из CI/CD. */
  hooks: HookSettings;
}

/** Настройки журнала аудита (Спринт 26). */
export interface AuditSettings {
  /** Вести журнал мутаций. */
  enabled: boolean;
  /** Сколько дней хранить записи; 0 — без ограничения по времени. */
  retentionDays: number;
  /** Максимум записей; старые удаляются первыми. */
  maxRecords: number;
}

/** Политика прав фоновых задач (Спринт 32, релиз 1.6). */
export interface PermissionSettings {
  /** hybrid — без shell/question; secure — только чтение; legacy — как в 1.5.x. */
  defaultPolicy: PermissionPolicy;
}

/**
 * Глобальные настройки плагина, которые меняются из GUI.
 * Хранятся в settings.json рядом с tasks.json / history.json.
 */
export interface SchedulerSettings {
  /** Максимум одновременно выполняющихся задач. 0 — без ограничения. */
  maxConcurrent: number;
  /**
   * Язык интерфейса (Спринт 28, режим `auto` — T7): `auto` по умолчанию —
   * следовать за языком OpenCode; `ru`/`en`/`zh` — явный выбор пользователя.
   */
  locale: LocaleMode;
  /**
   * Последняя известная локаль интерфейса OpenCode (T7/S24): серверный процесс
   * не видит `ctx.locale`, но рендерит уведомления, дайджест и дашборд.
   * Применяется только при `locale: "auto"`.
   */
  uiLocale: Locale;
  /** Зимняя тема оформления GUI (снежинки, морозные рамки, градиент). */
  winterMode: boolean;
  /** Уведомления о завершении задач. */
  notifications: NotificationSettings;
  /** Ретеншн истории запусков. */
  history: HistorySettings;
  /** Внешние интеграции: входящие webhook-триггеры. */
  integrations: IntegrationSettings;
  /** Журнал аудита мутаций (Спринт 26). */
  audit: AuditSettings;
  /** Политика прав фоновых задач (Спринт 32). */
  permissions: PermissionSettings;
}

export const SETTINGS_FILE = path.join(PLUGIN_DIR, "settings.json");
export const DEFAULT_MAX_CONCURRENT = 1;
export const DEFAULT_WINTER_MODE = false;
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_MAX_RECORDS = 5000;

/** Уведомления (Спринт 20): таймаут webhook, повторы и порог «зависшей» матрицы. */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_RETRY_COUNT = 2;
export const DEFAULT_WEBHOOK_RETRY_DELAY_MS = 1_000;
export const DEFAULT_STUCK_AFTER_MINUTES = 60;

/** Входящие хуки (Спринт 22): тело до 256 KiB, timestamp ±5 минут. */
export const DEFAULT_HOOK_MAX_BODY_BYTES = 256 * 1024;
export const DEFAULT_HOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const MAX_HOOK_BODY_BYTES = 5 * 1024 * 1024;
const MAX_HOOK_CREDENTIAL_LENGTH = 512;

/** Аудит (Спринт 26): включён, 90 дней и не больше 10 000 записей. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_AUDIT_MAX_RECORDS = 10_000;

/** Значения аудита по умолчанию. */
export function defaultAuditSettings(): AuditSettings {
  return {
    enabled: true,
    retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
    maxRecords: DEFAULT_AUDIT_MAX_RECORDS,
  };
}

/** Политика прав по умолчанию: гибрид (без shell/question). */
export function defaultPermissionsSettings(): PermissionSettings {
  return { defaultPolicy: DEFAULT_PERMISSION_POLICY };
}

/** Приводит настройки прав к безопасному виду. */
function normalizePermissionsSettings(
  value: unknown,
  fallback: PermissionSettings,
): PermissionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<PermissionSettings>;
  return {
    defaultPolicy: normalizePolicy(raw.defaultPolicy, fallback.defaultPolicy),
  };
}

/** Приводит настройки аудита к безопасному виду. */
function normalizeAuditSettings(
  value: unknown,
  fallback: AuditSettings,
): AuditSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<AuditSettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    retentionDays: normalizeRetentionLimit(
      raw.retentionDays,
      fallback.retentionDays,
    ),
    maxRecords: normalizeRetentionLimit(raw.maxRecords, fallback.maxRecords),
  };
}

/** Значения интеграций по умолчанию: хуки выключены, подпись обязательна. */
export function defaultIntegrations(): IntegrationSettings {
  return {
    hooks: {
      enabled: false,
      token: "",
      secret: "",
      requireSignature: true,
      maxBodyBytes: DEFAULT_HOOK_MAX_BODY_BYTES,
      timestampToleranceSeconds: DEFAULT_HOOK_TIMESTAMP_TOLERANCE_SECONDS,
    },
  };
}

/** Генерирует криптостойкие учётные данные для входящего хука. */
export function generateHookCredentials(): { token: string; secret: string } {
  return {
    token: crypto.randomBytes(24).toString("hex"),
    secret: crypto.randomBytes(32).toString("hex"),
  };
}

/** Ретеншн по умолчанию: 30 дней и не больше 5000 записей. */
export function defaultHistorySettings(): HistorySettings {
  return {
    retentionDays: DEFAULT_RETENTION_DAYS,
    maxRecords: DEFAULT_MAX_RECORDS,
    lastCleanupAt: null,
    lastCleanupDeleted: 0,
  };
}

/** Приводит счётчик ретеншна к безопасному целому (>= 0). */
function normalizeRetentionLimit(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  return int >= 0 ? int : fallback;
}

/** Приводит настройки ретеншна к безопасному виду. */
function normalizeHistorySettings(
  value: unknown,
  fallback: HistorySettings,
): HistorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<HistorySettings>;
  const lastCleanupAt =
    typeof raw.lastCleanupAt === "string" && raw.lastCleanupAt.trim()
      ? raw.lastCleanupAt.trim()
      : null;
  return {
    retentionDays: normalizeRetentionLimit(raw.retentionDays, fallback.retentionDays),
    maxRecords: normalizeRetentionLimit(raw.maxRecords, fallback.maxRecords),
    lastCleanupAt,
    lastCleanupDeleted: normalizeRetentionLimit(
      raw.lastCleanupDeleted,
      fallback.lastCleanupDeleted,
    ),
  };
}

/** Значения уведомлений по умолчанию: всё выключено, только ошибки. */
export function defaultNotifications(): NotificationSettings {
  return {
    enabled: false,
    onlyOnError: true,
    webhook: {
      enabled: false,
      url: "",
      timeoutMs: DEFAULT_WEBHOOK_TIMEOUT_MS,
      retryCount: DEFAULT_WEBHOOK_RETRY_COUNT,
      retryDelayMs: DEFAULT_WEBHOOK_RETRY_DELAY_MS,
    },
    templates: {
      success: t("notify.task.success"),
      error: t("notify.task.error"),
    },
    filters: { include: [], exclude: [] },
    telegram: {
      enabled: false,
      botToken: "",
      chatId: "",
      parseMode: "HTML",
      disableNotification: false,
      messageThreadId: null,
      includeDashboardLink: true,
      apiBase: "https://api.telegram.org",
    },
    native: {
      enabled: false,
      sound: true,
    },
    quietHours: {
      enabled: false,
      from: "22:00",
      to: "08:00",
    },
    dashboardUrl: "",
    matrix: {
      enabled: true,
      onPartial: true,
      onAllFailed: true,
      stuckAfterMinutes: DEFAULT_STUCK_AFTER_MINUTES,
    },
    digest: {
      enabled: false,
      frequency: "daily",
      time: "09:00",
      lastSentAt: null,
    },
    triage: {
      mode: "off",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      timeoutMs: 60_000,
      fallback: "rules",
      confidenceThreshold: 0.6,
      shadow: {
        enabled: true,
        days: DEFAULT_SHADOW_DAYS,
        startedAt: null,
      },
    },
    dedup: {
      enabled: false,
      windowMinutes: 60,
      suppressDuplicates: false,
      importantStatuses: ["error", "timeout"],
      maxCount: 999,
    },
    embedding: {
      enabled: false,
      suppressDuplicates: false,
      windowMinutes: 60,
      threshold: 0.85,
      maxVectors: 10_000,
    },
    summary: {
      enabled: false,
      maxLines: 3,
      maxCharsPerLine: 120,
      timeoutMs: 8_000,
    },
  };
}

/** Приводит значение лимита к безопасному целому (>= 0). */
function normalizeMaxConcurrent(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const int = Math.floor(n);
  return int >= 0 ? int : fallback;
}

/** Приводит значение зимнего режима к boolean. */
function normalizeWinterMode(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Приводит значение к конечному целому в диапазоне [min, max]. */
function normalizeIntInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Приводит число с плавающей точкой к безопасному диапазону. */
function normalizeFloatInRange(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Приводит время HH:MM к безопасному виду. */
function normalizeDailyTime(value: unknown, fallback: string): string {
  if (typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

/** Список имён задач: массив строк, обрезанных и без пустых значений. */
function normalizeNameList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Приводит parse_mode Telegram к допустимому значению. */
function normalizeTelegramParseMode(
  value: unknown,
  fallback: TelegramParseMode,
): TelegramParseMode {
  return value === "" || value === "HTML" || value === "Markdown" || value === "MarkdownV2"
    ? value
    : fallback;
}

/** Проверяет http(s)-базу API; иначе возвращает fallback. */
function normalizeHttpBase(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return trimmed;
  } catch {
    return fallback;
  }
}

/**
 * Встроенный шаблон (ru или en) заменяется текущим переводом; пользовательский
 * текст остаётся как есть. Иначе сохранённые при первой установке дефолты
 * навсегда застывали бы на языке установки.
 */
function localizedTemplate(
  value: unknown,
  key: string,
  fallback: string,
): string {
  const raw = typeof value === "string" && value.trim() ? value : fallback;
  const builtin = SUPPORTED_LOCALES.some(
    (locale) => messageIn(locale, key) === raw,
  );
  return builtin ? t(key) : raw;
}

/** Приводит режим триажа к допустимому значению. */
function normalizeTriageMode(value: unknown, fallback: TriageMode): TriageMode {
  return value === "off" || value === "rules" || value === "llm" || value === "auto"
    ? value
    : fallback;
}

/**
 * Приводит fallback триажа к допустимому значению.
 *
 * Старое имя `skip` означает «пропустить правила и отправить уведомление»,
 * поэтому нормализуется в однозначное `notify`.
 */
function normalizeTriageFallback(value: unknown, fallback: TriageFallback): TriageFallback {
  if (value === "rules" || value === "notify") return value;
  if (value === "skip") return "notify";
  return fallback === "skip" ? "notify" : fallback;
}

/** Приводит порог уверенности к диапазону 0..1. */
function normalizeConfidence(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const TRIAGE_RULE_FIELDS: readonly TriageRuleField[] = ["status", "task", "error", "cost"];
const TRIAGE_RULE_OPERATORS: readonly TriageRuleOperator[] = [
  "equals",
  "contains",
  "regex",
  "gt",
  "lt",
  "gte",
  "lte",
];
const TRIAGE_RULE_CATEGORIES: readonly TriageRuleCategory[] = [
  "quality",
  "timeout",
  "permission",
  "network",
  "unknown",
];
const TRIAGE_RULE_SEVERITIES: readonly TriageRuleSeverity[] = ["low", "medium", "high"];

/** Допустимые операторы для поля: текст сравнивается строками, cost — числами. */
function ruleOperatorAllowed(field: TriageRuleField, operator: TriageRuleOperator): boolean {
  return field === "cost"
    ? operator !== "contains" && operator !== "regex"
    : operator === "equals" || operator === "contains" || operator === "regex";
}

/** Нормализует одно правило; невалидное возвращает null (правило отбрасывается). */
function normalizeTriageRule(value: unknown): TriageRule | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const field = TRIAGE_RULE_FIELDS.includes(raw.field as TriageRuleField)
    ? (raw.field as TriageRuleField)
    : null;
  const operator = TRIAGE_RULE_OPERATORS.includes(raw.operator as TriageRuleOperator)
    ? (raw.operator as TriageRuleOperator)
    : null;
  if (!field || !operator || !ruleOperatorAllowed(field, operator)) return null;

  let ruleValue: string | number;
  if (field === "cost") {
    const n = Number(raw.value);
    if (!Number.isFinite(n) || n < 0) return null;
    ruleValue = n;
  } else {
    if (typeof raw.value !== "string" || !raw.value.trim()) return null;
    ruleValue = raw.value.trim().slice(0, 500);
  }

  if (operator === "regex") {
    try {
      new RegExp(String(ruleValue), "iu");
    } catch {
      return null;
    }
  }

  const rule: TriageRule = { field, operator, value: ruleValue };
  if (typeof raw.id === "string" && raw.id.trim()) rule.id = raw.id.trim().slice(0, 64);
  if (TRIAGE_RULE_CATEGORIES.includes(raw.category as TriageRuleCategory)) {
    rule.category = raw.category as TriageRuleCategory;
  }
  if (TRIAGE_RULE_SEVERITIES.includes(raw.severity as TriageRuleSeverity)) {
    rule.severity = raw.severity as TriageRuleSeverity;
  }
  if (raw.confidence !== undefined) rule.confidence = normalizeConfidence(raw.confidence, 0.8);
  if (raw.action === "notify" || raw.action === "skip") rule.action = raw.action;
  if (typeof raw.reason === "string" && raw.reason.trim()) {
    rule.reason = raw.reason.trim().slice(0, 300);
  }
  const priority = Number(raw.priority);
  rule.priority = Number.isFinite(priority)
    ? Math.min(10_000, Math.max(-10_000, Math.trunc(priority)))
    : 0;
  return rule;
}

/** Нормализует массив правил; undefined сохраняет встроенный набор. */
function normalizeTriageRules(
  value: unknown,
  fallback: TriageRule[] | undefined,
): TriageRule[] | undefined {
  if (value === undefined) return fallback?.map((rule) => ({ ...rule }));
  if (!Array.isArray(value)) return fallback?.map((rule) => ({ ...rule }));
  return value
    .slice(0, 200)
    .map(normalizeTriageRule)
    .filter((rule): rule is TriageRule => rule !== null);
}

/** Нормализует настройки shadow-режима триажа. */
function normalizeTriageShadow(
  value: unknown,
  fallback: TriageShadowSettings,
): TriageShadowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<TriageShadowSettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    days: normalizeIntInRange(raw.days, fallback.days, 1, 365),
    startedAt:
      typeof raw.startedAt === "string" && raw.startedAt.trim()
        ? raw.startedAt.trim()
        : null,
  };
}

function normalizeDedupSettings(
  value: unknown,
  fallback: NotificationDedupSettings,
): NotificationDedupSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<NotificationDedupSettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    windowMinutes: normalizeIntInRange(
      raw.windowMinutes,
      fallback.windowMinutes,
      1,
      10_080,
    ),
    suppressDuplicates:
      typeof raw.suppressDuplicates === "boolean"
        ? raw.suppressDuplicates
        : fallback.suppressDuplicates,
    importantStatuses:
      Array.isArray(raw.importantStatuses) &&
      raw.importantStatuses.every((s) => typeof s === "string")
        ? raw.importantStatuses.map((s) => String(s)).slice(0, 32)
        : fallback.importantStatuses,
    maxCount: normalizeIntInRange(raw.maxCount, fallback.maxCount, 1, 10_000),
  };
}

/** Нормализация настроек семантического дедупа (Спринт 31.1). */
function normalizeEmbeddingSettings(
  value: unknown,
  fallback: NotificationEmbeddingSettings,
): NotificationEmbeddingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<NotificationEmbeddingSettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    suppressDuplicates:
      typeof raw.suppressDuplicates === "boolean"
        ? raw.suppressDuplicates
        : fallback.suppressDuplicates,
    windowMinutes: normalizeIntInRange(
      raw.windowMinutes,
      fallback.windowMinutes,
      1,
      10_080,
    ),
    threshold: normalizeFloatInRange(
      raw.threshold,
      fallback.threshold,
      0,
      1,
    ),
    maxVectors: normalizeIntInRange(
      raw.maxVectors,
      fallback.maxVectors,
      100,
      100_000,
    ),
  };
}

/** Нормализует настройки саммари уведомлений (Спринт 31.3). */
function normalizeSummarySettings(
  value: unknown,
  fallback: NotificationSummarySettings,
): NotificationSummarySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...fallback };
  }
  const raw = value as Partial<NotificationSummarySettings>;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    maxLines: normalizeIntInRange(raw.maxLines, fallback.maxLines, 1, 3),
    maxCharsPerLine: normalizeIntInRange(
      raw.maxCharsPerLine,
      fallback.maxCharsPerLine,
      20,
      500,
    ),
    timeoutMs: normalizeIntInRange(raw.timeoutMs, fallback.timeoutMs, 1000, 120_000),
  };
}

/** Текущий shadow-период ещё активен? (ничего не меняет, только читает). */
export function isShadowActive(shadow: TriageShadowSettings | undefined): boolean {
  if (!shadow || !shadow.enabled || !shadow.startedAt) return false;
  const started = new Date(shadow.startedAt).getTime();
  if (!Number.isFinite(started)) return false;
  const now = Date.now();
  const days = Number.isFinite(shadow.days) && shadow.days > 0 ? shadow.days : DEFAULT_SHADOW_DAYS;
  return now - started < days * 24 * 60 * 60 * 1000;
}

/** Начать shadow-период, если ещё не Started. Возвращает нормализованные настройки shadow. */
export function startShadow(shadow: TriageShadowSettings | undefined): TriageShadowSettings {
  const nowIso = new Date().toISOString();
  if (!shadow) {
    return { enabled: true, days: DEFAULT_SHADOW_DAYS, startedAt: nowIso };
  }
  if (!shadow.startedAt) {
    return { ...shadow, startedAt: nowIso };
  }
  return { ...shadow };
}

/**
 * Настройки shadow после сохранения: включённый режим без даты старта
 * получает текущий момент, выключенный — сбрасывает дату.
 */
export function settleShadowOnSave(
  shadow: TriageShadowSettings | undefined,
): TriageShadowSettings {
  if (!shadow) return startShadow(undefined);
  if (!shadow.enabled) return { ...shadow, startedAt: null };
  return startShadow(shadow);
}

/**
 * Приводит настройки триажа к безопасному виду.
 *
 * Экспортируется, чтобы RPC-сравнение «до/после» валидировало пользовательский
 * ввод той же схемой, что и сохранённые настройки.
 */
export function normalizeTriageSettings(
  value: unknown,
  fallback: TriageSettings,
): TriageSettings {
  const fallbackShadow =
    fallback.shadow ?? defaultNotifications().triage!.shadow!;
  const raw = asRecord(value);
  const rules = normalizeTriageRules(raw?.rules, fallback.rules);
  return {
    mode: normalizeTriageMode(raw?.mode, fallback.mode),
    baseUrl: normalizeHttpBase(raw?.baseUrl, fallback.baseUrl),
    model:
      typeof raw?.model === "string" && raw.model.trim()
        ? raw.model.trim().slice(0, 200)
        : fallback.model,
    timeoutMs: normalizeIntInRange(
      raw?.timeoutMs,
      fallback.timeoutMs,
      1_000,
      120_000,
    ),
    fallback: normalizeTriageFallback(raw?.fallback, fallback.fallback),
    confidenceThreshold: normalizeConfidence(
      raw?.confidenceThreshold,
      fallback.confidenceThreshold,
    ),
    ...(rules !== undefined ? { rules } : {}),
    shadow: normalizeTriageShadow(raw?.shadow, fallbackShadow),
  };
}

/** Приводит настройки уведомлений к безопасному виду. */
function normalizeNotifications(
  value: unknown,
  fallback: NotificationSettings,
): NotificationSettings {
  const fallbackWebhook = fallback.webhook ?? defaultNotifications().webhook!;
  const fallbackTemplates = fallback.templates ?? defaultNotifications().templates!;
  const fallbackFilters = fallback.filters ?? { include: [], exclude: [] };
  const fallbackMatrix = fallback.matrix ?? defaultNotifications().matrix!;
  const fallbackDigest = fallback.digest ?? defaultNotifications().digest!;
  const fallbackTelegram = fallback.telegram ?? defaultNotifications().telegram!;
  const fallbackNative = fallback.native ?? defaultNotifications().native!;
  const fallbackQuiet = fallback.quietHours ?? defaultNotifications().quietHours!;
  const fallbackTriage = fallback.triage ?? defaultNotifications().triage!;
  const fallbackShadow = fallbackTriage.shadow ?? defaultNotifications().triage!.shadow!;

  const raw = asRecord(value);
  if (!raw) {
    return {
      ...fallback,
      webhook: { ...fallbackWebhook },
      templates: { ...fallbackTemplates },
      filters: {
        include: [...fallbackFilters.include],
        exclude: [...fallbackFilters.exclude],
      },
      matrix: { ...fallbackMatrix },
      digest: { ...fallbackDigest },
      telegram: { ...fallbackTelegram },
      native: { ...fallbackNative },
      quietHours: { ...fallbackQuiet },
      triage: {
        ...fallbackTriage,
        rules: fallbackTriage.rules?.map((rule) => ({ ...rule })),
        shadow: { ...fallbackShadow },
      },
      dashboardUrl: fallback.dashboardUrl ?? "",
    };
  }

  const rawWebhook = asRecord(raw.webhook);
  const rawTemplates = asRecord(raw.templates);
  const rawFilters = asRecord(raw.filters);
  const rawMatrix = asRecord(raw.matrix);
  const rawDigest = asRecord(raw.digest);
  const rawTelegram = asRecord(raw.telegram);
  const rawNative = asRecord(raw.native);
  const rawQuiet = asRecord(raw.quietHours);
  const rawTriage = asRecord(raw.triage);

  const frequency: DigestFrequency =
    rawDigest?.frequency === "weekly" || rawDigest?.frequency === "daily"
      ? rawDigest.frequency
      : fallbackDigest.frequency;

  const lastSentAt =
    typeof rawDigest?.lastSentAt === "string" && rawDigest.lastSentAt.trim()
      ? rawDigest.lastSentAt.trim()
      : null;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    onlyOnError:
      typeof raw.onlyOnError === "boolean" ? raw.onlyOnError : fallback.onlyOnError,
    webhook: {
      enabled:
        typeof rawWebhook?.enabled === "boolean"
          ? rawWebhook.enabled
          : fallbackWebhook.enabled,
      url:
        typeof rawWebhook?.url === "string"
          ? rawWebhook.url.trim()
          : fallbackWebhook.url,
      timeoutMs: normalizeIntInRange(
        rawWebhook?.timeoutMs,
        fallbackWebhook.timeoutMs,
        1_000,
        120_000,
      ),
      retryCount: normalizeIntInRange(
        rawWebhook?.retryCount,
        fallbackWebhook.retryCount,
        0,
        5,
      ),
      retryDelayMs: normalizeIntInRange(
        rawWebhook?.retryDelayMs,
        fallbackWebhook.retryDelayMs,
        100,
        60_000,
      ),
    },
    templates: {
      success: localizedTemplate(
        rawTemplates?.success,
        "notify.task.success",
        fallbackTemplates.success,
      ),
      error: localizedTemplate(
        rawTemplates?.error,
        "notify.task.error",
        fallbackTemplates.error,
      ),
    },
    filters: {
      include: normalizeNameList(rawFilters?.include, fallbackFilters.include),
      exclude: normalizeNameList(rawFilters?.exclude, fallbackFilters.exclude),
    },
    telegram: {
      enabled:
        typeof rawTelegram?.enabled === "boolean"
          ? rawTelegram.enabled
          : fallbackTelegram.enabled,
      botToken:
        typeof rawTelegram?.botToken === "string"
          ? rawTelegram.botToken.trim().slice(0, 512)
          : fallbackTelegram.botToken,
      chatId:
        typeof rawTelegram?.chatId === "string"
          ? rawTelegram.chatId.trim().slice(0, 128)
          : fallbackTelegram.chatId,
      parseMode: normalizeTelegramParseMode(
        rawTelegram?.parseMode,
        fallbackTelegram.parseMode,
      ),
      disableNotification:
        typeof rawTelegram?.disableNotification === "boolean"
          ? rawTelegram.disableNotification
          : fallbackTelegram.disableNotification,
      messageThreadId:
        rawTelegram?.messageThreadId === null
          ? null
          : Number.isFinite(Number(rawTelegram?.messageThreadId))
            ? Math.max(0, Math.floor(Number(rawTelegram?.messageThreadId)))
            : fallbackTelegram.messageThreadId,
      includeDashboardLink:
        typeof rawTelegram?.includeDashboardLink === "boolean"
          ? rawTelegram.includeDashboardLink
          : fallbackTelegram.includeDashboardLink,
      apiBase: normalizeHttpBase(rawTelegram?.apiBase, fallbackTelegram.apiBase),
    },
    native: {
      enabled:
        typeof rawNative?.enabled === "boolean"
          ? rawNative.enabled
          : fallbackNative.enabled,
      sound:
        typeof rawNative?.sound === "boolean"
          ? rawNative.sound
          : fallbackNative.sound,
    },
    quietHours: {
      enabled:
        typeof rawQuiet?.enabled === "boolean"
          ? rawQuiet.enabled
          : fallbackQuiet.enabled,
      from: normalizeDailyTime(rawQuiet?.from, fallbackQuiet.from),
      to: normalizeDailyTime(rawQuiet?.to, fallbackQuiet.to),
    },
    dashboardUrl:
      typeof raw.dashboardUrl === "string"
        ? raw.dashboardUrl.trim().slice(0, 500)
        : (fallback.dashboardUrl ?? ""),
    matrix: {
      enabled:
        typeof rawMatrix?.enabled === "boolean"
          ? rawMatrix.enabled
          : fallbackMatrix.enabled,
      onPartial:
        typeof rawMatrix?.onPartial === "boolean"
          ? rawMatrix.onPartial
          : fallbackMatrix.onPartial,
      onAllFailed:
        typeof rawMatrix?.onAllFailed === "boolean"
          ? rawMatrix.onAllFailed
          : fallbackMatrix.onAllFailed,
      stuckAfterMinutes: normalizeIntInRange(
        rawMatrix?.stuckAfterMinutes,
        fallbackMatrix.stuckAfterMinutes,
        0,
        10_080,
      ),
    },
    digest: {
      enabled:
        typeof rawDigest?.enabled === "boolean"
          ? rawDigest.enabled
          : fallbackDigest.enabled,
      frequency,
      time: normalizeDailyTime(rawDigest?.time, fallbackDigest.time),
      lastSentAt,
    },
    triage: normalizeTriageSettings(rawTriage, fallbackTriage),
    dedup: normalizeDedupSettings(
      raw.dedup,
      fallback.dedup ?? defaultNotifications().dedup!,
    ),
    embedding: normalizeEmbeddingSettings(
      raw.embedding,
      fallback.embedding ?? defaultNotifications().embedding!,
    ),
    summary: normalizeSummarySettings(
      raw.summary,
      fallback.summary ?? defaultNotifications().summary!,
    ),
  };
}

/** Приводит настройки интеграций к безопасному виду. */
function normalizeIntegrations(
  value: unknown,
  fallback: IntegrationSettings,
): IntegrationSettings {
  const fallbackHooks = fallback.hooks ?? defaultIntegrations().hooks;
  const raw = asRecord(value);
  const rawHooks = asRecord(raw?.hooks);

  const readCredential = (input: unknown, previous: string): string => {
    if (typeof input !== "string") return previous;
    return input.trim().slice(0, MAX_HOOK_CREDENTIAL_LENGTH);
  };

  return {
    hooks: {
      enabled:
        typeof rawHooks?.enabled === "boolean"
          ? rawHooks.enabled
          : fallbackHooks.enabled,
      token: readCredential(rawHooks?.token, fallbackHooks.token),
      secret: readCredential(rawHooks?.secret, fallbackHooks.secret),
      requireSignature:
        typeof rawHooks?.requireSignature === "boolean"
          ? rawHooks.requireSignature
          : fallbackHooks.requireSignature,
      maxBodyBytes: normalizeIntInRange(
        rawHooks?.maxBodyBytes,
        fallbackHooks.maxBodyBytes,
        1_024,
        MAX_HOOK_BODY_BYTES,
      ),
      timestampToleranceSeconds: normalizeIntInRange(
        rawHooks?.timestampToleranceSeconds,
        fallbackHooks.timestampToleranceSeconds,
        0,
        86_400,
      ),
    },
  };
}

/** Читает настройки. Битый/отсутствующий файл — значения по умолчанию. */
export async function loadSettings(): Promise<SchedulerSettings> {
  const fallbackNotifications = defaultNotifications();
  const fallbackHistory = defaultHistorySettings();
  const fallbackIntegrations = defaultIntegrations();
  const fallbackAudit = defaultAuditSettings();
  const fallbackPermissions = defaultPermissionsSettings();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<SchedulerSettings> | null;
    return {
      maxConcurrent: normalizeMaxConcurrent(
        parsed?.maxConcurrent,
        DEFAULT_MAX_CONCURRENT,
      ),
      locale: normalizeLocaleMode(parsed?.locale, DEFAULT_LOCALE_MODE),
      uiLocale: normalizeLocale(parsed?.uiLocale, DEFAULT_LOCALE),
      winterMode: normalizeWinterMode(
        parsed?.winterMode,
        DEFAULT_WINTER_MODE,
      ),
      notifications: normalizeNotifications(
        parsed?.notifications,
        fallbackNotifications,
      ),
      history: normalizeHistorySettings(parsed?.history, fallbackHistory),
      integrations: normalizeIntegrations(
        parsed?.integrations,
        fallbackIntegrations,
      ),
      audit: normalizeAuditSettings(parsed?.audit, fallbackAudit),
      permissions: normalizePermissionsSettings(
        parsed?.permissions,
        fallbackPermissions,
      ),
    };
  } catch {
    return {
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      locale: DEFAULT_LOCALE_MODE,
      uiLocale: DEFAULT_LOCALE,
      winterMode: DEFAULT_WINTER_MODE,
      notifications: fallbackNotifications,
      history: fallbackHistory,
      integrations: fallbackIntegrations,
      audit: fallbackAudit,
      permissions: fallbackPermissions,
    };
  }
}

/** Сохраняет настройки (частичное обновление поверх текущих). */
export async function saveSettings(
  patch: Partial<SchedulerSettings>,
): Promise<SchedulerSettings> {
  const current = await loadSettings();
  const next: SchedulerSettings = {
    maxConcurrent:
      patch.maxConcurrent !== undefined
        ? normalizeMaxConcurrent(patch.maxConcurrent, current.maxConcurrent)
        : current.maxConcurrent,
    locale:
      patch.locale !== undefined
        ? normalizeLocaleMode(patch.locale, current.locale)
        : current.locale,
    uiLocale:
      patch.uiLocale !== undefined
        ? normalizeLocale(patch.uiLocale, current.uiLocale)
        : current.uiLocale,
    winterMode:
      patch.winterMode !== undefined
        ? normalizeWinterMode(patch.winterMode, current.winterMode)
        : current.winterMode,
    notifications:
      patch.notifications !== undefined
        ? normalizeNotifications(patch.notifications, current.notifications)
        : current.notifications,
    history:
      patch.history !== undefined
        ? normalizeHistorySettings(patch.history, current.history)
        : current.history,
    integrations:
      patch.integrations !== undefined
        ? normalizeIntegrations(patch.integrations, current.integrations)
        : current.integrations,
    audit:
      patch.audit !== undefined
        ? normalizeAuditSettings(patch.audit, current.audit)
        : current.audit,
    permissions:
      patch.permissions !== undefined
        ? normalizePermissionsSettings(patch.permissions, current.permissions)
        : current.permissions,
  };

  // Удобство: при включении хуков без явных учётных данных генерируем их,
  // чтобы функция сразу работала, а секреты не приходилось придумывать вручную.
  if (next.integrations.hooks.enabled) {
    if (!next.integrations.hooks.token || !next.integrations.hooks.secret) {
      const generated = generateHookCredentials();
      if (!next.integrations.hooks.token) next.integrations.hooks.token = generated.token;
      if (!next.integrations.hooks.secret) next.integrations.hooks.secret = generated.secret;
    }
  }

  // Удобство: включённый shadow-режим без даты старта стартует при первом сохранении.
  // Иначе shadow не логировал бы решения, а триаж реально подавлял бы уведомления.
  const triage = next.notifications.triage;
  if (triage) {
    triage.shadow = settleShadowOnSave(triage.shadow);
  }

  await fs.mkdir(PLUGIN_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}
