import { createEffect, createSignal, onCleanup, ErrorBoundary } from "solid-js"
import { Panel, Plugin } from "@opencode/plugin/gui"
import { SchedulerRpc } from "./rpc.js"
import { loadHistory, loadMetrics, type HistoryRecord } from "./history.js"
import { normalizeLocale, normalizeLocaleMode, registerCatalog, setLocale, t, type LocaleMode, type TranslateParams, type Locale } from "./i18n.js"
// Каталоги встраиваются в бандл на этапе сборки: в webview OpenCode нет
// доступа к файлам пакета, поэтому ленивый fs-загрузчик из i18n.ts не работает.
import ruCatalog from "../locales/ru.json"
import enCatalog from "../locales/en.json"
import zhCatalog from "../locales/zh.json"

registerCatalog("ru", ruCatalog)
registerCatalog("en", enCatalog)
registerCatalog("zh", zhCatalog)

/** Счётчик смены локали: чтение в JSX-геттерах делает строки реактивными. */
const [localeTick, setLocaleTick] = createSignal(0)

/** gt — t() + подписка на смену локали для Solid. */
const gt = (key: string, params?: TranslateParams): string => {
  localeTick()
  return t(key, params)
}

/** Переключает язык интерфейса без перезапуска панели. */
const applyLocale = (locale: unknown): void => {
  setLocale(locale as Locale)
  setLocaleTick((v) => v + 1)
}

/** Статус задачи для отображения в GUI. */
type JobStatus = "running" | "success" | "error" | "partial" | "idle" | "unknown"

/** Per-workspace переопределения клона (Спринт 17). */
interface MatrixOverrideFields {
  prompt?: string
  model?: string
  qualityGate?: string
  beforeScript?: string
  afterScript?: string
}

/** Matrix-настройки задачи-шаблона (Спринт 15: fan-out по workspace). */
interface MatrixConfig {
  workspaceIds: string[]
  strategy?: "parallel" | "sequential"
  failureMode?: "continue" | "stop"
  aggregation?: "summary" | "per-task"
  createAggregator?: boolean
  concurrency?: number
  overrides?: Record<string, MatrixOverrideFields>
}

/** Настройки уведомлений (webhook, шаблоны, фильтры, матрицы, дайджест — Спринт 20). */
interface NotificationSettings {
  enabled: boolean
  onlyOnError: boolean
  webhook?: {
    enabled: boolean
    url: string
    timeoutMs?: number
    retryCount?: number
    retryDelayMs?: number
  }
  templates?: { success: string; error: string }
  filters?: { include: string[]; exclude: string[] }
  telegram?: {
    enabled: boolean
    botToken: string
    chatId: string
    parseMode: "" | "HTML" | "Markdown" | "MarkdownV2"
    disableNotification: boolean
    messageThreadId: number | null
    includeDashboardLink: boolean
    apiBase: string
  }
  native?: { enabled: boolean; sound: boolean }
  quietHours?: { enabled: boolean; from: string; to: string }
  dashboardUrl?: string
  matrix?: {
    enabled: boolean
    onPartial: boolean
    onAllFailed: boolean
    stuckAfterMinutes: number
  }
  digest?: {
    enabled: boolean
    frequency: "daily" | "weekly"
    time: string
    lastSentAt?: string | null
  }
  triage?: {
    mode: "off" | "rules" | "llm" | "auto"
    baseUrl: string
    model: string
    timeoutMs: number
    fallback: "rules" | "notify"
    confidenceThreshold: number
    rules?: TriageRule[]
    shadow?: { enabled: boolean; days: number; startedAt: string | null }
  }
}

/** Настройки ретеншна истории (Спринт 18). 0 — соответствующее ограничение выключено. */
interface HistorySettings {
  retentionDays: number
  maxRecords: number
  lastCleanupAt: string | null
  lastCleanupDeleted: number
}

interface Job {
  name: string
  schedule: string
  status: JobStatus
  /** Всего запусков именно этой задачи (не общий итог по всем). */
  runsTotal?: number
  /** Успешных запусков этой задачи. */
  runsSuccess?: number
  /** Ошибок и таймаутов этой задачи. */
  runsError?: number
  /** Частичных выполнений этой задачи (partial). */
  runsPartial?: number
  nextRun?: string
  paused?: boolean
  orphaned?: boolean
  retryCount?: number
  retryDelay?: number
  qualityGate?: string
  /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
  dependsOn?: string[]
  prompt?: string
  /** LLM-модель задачи (undefined — модель OpenCode по умолчанию). */
  model?: string
  /** Приоритет задачи 0..10 (10 — наивысший). */
  priority?: number
  /** Pre-flight команда (undefined — не задана). */
  beforeScript?: string
  /** Post-flight команда (undefined — не задана). */
  afterScript?: string
  triggerType?: "cron" | "file" | "git" | "mcp-event" | "once"
  /** Для triggerType "once" — время одного запуска (ISO-8601). */
  runAt?: string | null
  /** OpenCode-сессия: new — каждый запуск новая, reuse — переиспользовать, last — --continue. */
  session?: "new" | "reuse" | "last" | null
  /** Сколько запусков переживает reuse-сессия до удаления; пусто — без лимита. */
  sessionMaxRuns?: number | null
  /** Параметры MCP-события. */
  mcpEvent?: { server: string; event: string; filter?: string }
  watchPath?: string
  workingDirectory?: string
  /** Привязка к multi-repo workspace. */
  workspaceId?: string
  workspaceName?: string
  workspaceColor?: string
  /** Ограничения инструментов (role-scoped, metadata-only). */
  allowedTools?: string[] | null
  deniedTools?: string[] | null
  /** Matrix (fan-out): задача-шаблон раскладывается на клоны. */
  matrix?: MatrixConfig | null
  /** Для клона матрицы — имя родительской задачи. */
  matrixParentId?: string | null
  /** true — задача является родителем матрицы. */
  isMatrixParent?: boolean
  /** Агрегат по клонам (только для родителя). */
  matrixSummary?: {
    totalCount: number
    successCount: number
    errorCount: number
    pendingCount: number
    status: string
    message: string
  } | null
  /** IANA-часовой пояс задачи (Спринт 19); null — системный. */
  timezone?: string | null
  /** Окно запуска: начало "HH:MM" (Спринт 19). */
  notBefore?: string | null
  /** Окно запуска: конец "HH:MM" (может быть меньше notBefore). */
  notAfter?: string | null
  /** Разрешённые дни недели 0=Вс..6=Сб (null — все дни). */
  activeDays?: number[] | null
  /** Поведение вне окна: skip / postpone / run (null — postpone). */
  windowPolicy?: "skip" | "postpone" | "run" | null
  /** Glob-маски файлового триггера (null — любое изменение). */
  watchGlobs?: string[] | null
  /** Glob-маски игнорируемых файлов файлового триггера. */
  watchIgnore?: string[] | null
  /** Git-триггер: фильтр по ветке (glob, через запятую). */
  gitBranch?: string | null
  /** Git-триггер: маски изменённых файлов, запускающих задачу. */
  gitPaths?: string[] | null
  /** Git-триггер: маски игнорируемых изменённых файлов. */
  gitIgnore?: string[] | null
  /** Git-триггер: период опроса, секунды. */
  gitPollSeconds?: number | null
  /** Пауза до даты (ISO) — задача включится автоматически. */
  pausedUntil?: string | null
  /** Windows: задача запускается и без входа пользователя (/ru SYSTEM). */
  runWhenLoggedOff?: boolean | null
  /** Windows: фактический режим входа из планировщика (Interactive/Background). */
  logonMode?: string | null
}

/** Пользовательский шаблон, сохранённый в templates.json. */
interface CustomTemplate {
  id: string
  name: string
  prompt: string
  schedule?: string
  timeoutSeconds?: number
  model?: string
  priority?: number
  retryCount?: number
  retryDelay?: number
  qualityGate?: string
  beforeScript?: string
  afterScript?: string
  dependsOn?: string[]
  triggerType?: "cron" | "file" | "git" | "mcp-event"
  mcpEvent?: { server: string; event: string; filter?: string }
  watchPath?: string
  watchGlobs?: string[]
  watchIgnore?: string[]
  gitBranch?: string
  gitPaths?: string[]
  gitIgnore?: string[]
  gitPollSeconds?: number
  activeDays?: number[]
  windowPolicy?: "skip" | "postpone" | "run"
  workingDirectory?: string
  workspaceId?: string
  allowedTools?: string[]
  deniedTools?: string[]
  matrix?: MatrixConfig
}

/** Multi-repo workspace: один репозиторий = один cwd = один git-контекст. */
interface Workspace {
  id: string
  name: string
  path: string
  gitRemote?: string | null
  gitBranch?: string | null
  color?: string | null
  /** Env-переменные workspace (Спринт 21); секреты приходят замаскированными. */
  env?: Record<string, string> | null
  /** Путь к .env-файлу workspace (Спринт 21). */
  envFile?: string | null
  createdAt: string
}

/** Описание профиля плагина (Спринт 21). */
interface ProfileInfo {
  name: string
  dir: string
  port: number | null
  isDefault: boolean
  active: boolean
}

/** Запись dead-letter queue (Спринт 36.6). */
interface DlqEntry {
  id: string
  runId: string
  stepName: string
  status: "open" | "retried" | "discarded" | string
  reason: string | null
  error: string | null
  attempts: number
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
  resolution: string | null
}

function statusColor(status: JobStatus): string {
  switch (status) {
    case "running": return "#f5a623"
    case "success": return "#34c759"
    case "error": return "#ff3b30"
    case "partial": return "#ff9f0a"
    default: return "#8e8e93"
  }
}

/** Приоритет по умолчанию — «Обычный». */
const DEFAULT_PRIORITY = 5

/** Внутренний маркер dry-run локальной формы — не переводится. */
const DRYRUN_FORM_MARKER = "form"

/** Человекочитаемая подпись приоритета (0..10). */
function priorityLabel(priority?: number): string {
  const value =
    typeof priority === "number" && Number.isFinite(priority)
      ? Math.min(10, Math.max(0, Math.floor(priority)))
      : DEFAULT_PRIORITY
  if (value >= 10) return gt("gui.priority.critical")
  if (value >= 8) return gt("gui.priority.high")
  if (value <= 3) return gt("gui.priority.low")
  return gt("gui.priority.normal")
}

/** Варианты выпадающего списка «Приоритет». */
const priorityOptions = (): Array<{ value: number; label: string }> => [
  { value: 2, label: gt("gui.priority.low") },
  { value: 5, label: gt("gui.priority.normal") },
  { value: 8, label: gt("gui.priority.high") },
  { value: 10, label: gt("gui.priority.critical") },
]

/** Безопасно извлекает текст ошибки из любого thrown value. */
function errorMessage(err: any): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null && "message" in err)
    return String((err as any).message)
  return JSON.stringify(err)
}

/**
 * Укорачивает текст ошибки для показа в интерфейсе:
 * берёт первую непустую строку и обрезает её до 150 символов.
 * Полные «простыни» из документации/стека в UI не попадают.
 */
function shortError(msg: string, limit = 150): string {
  const firstLine = (msg || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? ""
  return firstLine.length > limit ? firstLine.slice(0, limit - 1).trimEnd() + "…" : firstLine
}

/** Разбивает строку из textarea в список: по запятым и переводам строк. */
function splitListInput(raw: string): string[] {
  return (raw || "")
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Обратное преобразование списка масок в строку для textarea. */
function joinListInput(list?: string[] | null): string {
  return Array.isArray(list) ? list.join("\n") : ""
}

/** Пресеты cron-расписаний */
const cronPresets = (): Array<{ label: string; value: string }> => [
  { label: gt("gui.cron.everyMinute"), value: "* * * * *" },
  { label: gt("gui.cron.everyHour"), value: "0 * * * *" },
  { label: gt("gui.cron.dailyAt9"), value: "0 9 * * *" },
  { label: gt("gui.cron.mondayAt10"), value: "0 10 * * 1" },
  { label: gt("gui.cron.custom"), value: "__custom__" },
]

export default Plugin.define({
  setup(ctx) {
    const rpc = ctx.client.rpc(SchedulerRpc)

    const [jobs, setJobs] = createSignal<Job[]>([])
    const [workspaces, setWorkspaces] = createSignal<Workspace[]>([])
    const [workspacesCollapsed, setWorkspacesCollapsed] = createSignal(false)
    const [workspaceFilter, setWorkspaceFilter] = createSignal("all")
    const [workspaceBusy, setWorkspaceBusy] = createSignal(false)
    const [workspaceId, setWorkspaceId] = createSignal("")
    // Профили плагина (Спринт 21): отдельные БД/настройки/порт дашборда.
    const [profiles, setProfiles] = createSignal<ProfileInfo[]>([])
    const [profileCurrent, setProfileCurrent] = createSignal("default")
    const [profilePinned, setProfilePinned] = createSignal(false)
    const [profilesOpen, setProfilesOpen] = createSignal(false)
    const [profileBusy, setProfileBusy] = createSignal(false)
    // Собственный текстовый prompt: в Electron/WebView window.prompt не работает
    // (возвращает null), из-за чего «{gt("gui.createProfile")}» в профилях молча ничего не делал.
    const [promptOpen, setPromptOpen] = createSignal(false)
    const [promptTitle, setPromptTitle] = createSignal("")
    const [promptValue, setPromptValue] = createSignal("")
    let promptResolve: ((value: string | null) => void) | null = null

    /** Модальный ввод строки. Возвращает null при отмене/Escape/клике по фону. */
    function askText(title: string, initial = ""): Promise<string | null> {
      // Предыдущий незакрытый запрос отменяем, чтобы не потерять промис.
      promptResolve?.(null)
      return new Promise((resolve) => {
        promptResolve = resolve
        setPromptTitle(title)
        setPromptValue(initial)
        setPromptOpen(true)
      })
    }

    function answerPrompt(value: string | null) {
      const resolve = promptResolve
      promptResolve = null
      setPromptOpen(false)
      resolve?.(value)
    }
    const [logs, setLogs] = createSignal("")
    const [logsTask, setLogsTask] = createSignal<string | null>(null)
    const [busy, setBusy] = createSignal(false)
    const [cronError, setCronError] = createSignal("")

    // Метрики и история запусков
    const [metrics, setMetrics] = createSignal<{ total: number; success: number; error: number }>({ total: 0, success: 0, error: 0 })
    const [historyOpen, setHistoryOpen] = createSignal<string | null>(null)
    const [history, setHistory] = createSignal<HistoryRecord[]>([])

    // Шаблоны промптов
    const promptTemplates = (): Array<{ label: string; value: string; prompt: string }> => [
      { label: gt("gui.promptTemplates.custom"), value: "custom", prompt: "" },
      {
        label: gt("gui.promptTemplates.nightWatch"),
        value: "night-watch",
        prompt: gt("gui.promptTemplates.nightWatchPrompt"),
      },
      {
        label: gt("gui.promptTemplates.morningDigest"),
        value: "morning-digest",
        prompt: gt("gui.promptTemplates.morningDigestPrompt"),
      },
      {
        label: gt("gui.promptTemplates.codeHygiene"),
        value: "code-hygiene",
        prompt: gt("gui.promptTemplates.codeHygienePrompt"),
      },
    ]
    const [template, setTemplate] = createSignal<string>("custom")

    // Пользовательские шаблоны (templates.json) — загружаются при монтировании панели.
    const [customTemplates, setCustomTemplates] = createSignal<CustomTemplate[]>([])

    // Таймер для выполнения задачи (секунды)
    const [runningSec, setRunningSec] = createSignal(0)
    setInterval(() => setRunningSec((s) => s + 1), 1000)

    // Глобальные настройки (макс. одновременных задач, зимняя тема)
    const [maxConcurrent, setMaxConcurrent] = createSignal(1)
    const [winterMode, setWinterMode] = createSignal(false)

    // Режим языка (T7): auto — следовать за локалью интерфейса OpenCode.
    const [localeMode, setLocaleMode] = createSignal<LocaleMode>("ru")
    // Последняя известная серверу локаль интерфейса (уведомления, дайджест, дашборд).
    const [uiLocaleKnown, setUiLocaleKnown] = createSignal<Locale>("ru")

    /** Локаль интерфейса OpenCode (BCP 47) или undefined, если хост её не дал. */
    function appLocale(): string | undefined {
      try {
        return ctx.locale?.locale?.()
      } catch {
        return undefined
      }
    }

    /** Применяет режим: auto берёт локаль OpenCode, иначе — явную. */
    function applyLocaleMode(mode: LocaleMode): void {
      applyLocale(mode === "auto" ? appLocale() : mode)
    }

    // auto должен следовать за сменой языка OpenCode в реальном времени.
    // S24: серверный процесс окно не видит, поэтому при изменении отправляем
    // ему разрешённую локаль — иначе уведомления останутся на прежнем языке.
    createEffect(() => {
      const mode = localeMode()
      const app = appLocale()
      if (mode !== "auto") return
      applyLocale(app)
      const resolved = normalizeLocale(app, "ru")
      if (resolved !== uiLocaleKnown()) {
        setUiLocaleKnown(resolved)
        void rpc.save_settings({ uiLocale: resolved }).catch((err: any) => {
          console.error("RPC Error (save_settings uiLocale):", err)
        })
      }
    })

    // Настройки уведомлений (webhook)
    const [notificationsEnabled, setNotificationsEnabled] = createSignal(false)
    const [onlyOnError, setOnlyOnError] = createSignal(true)
    const [webhookEnabled, setWebhookEnabled] = createSignal(false)
    const [webhookUrl, setWebhookUrl] = createSignal("")
    const [notificationsCollapsed, setNotificationsCollapsed] = createSignal(true)
    const [testNotificationBusy, setTestNotificationBusy] = createSignal(false)
    // Спринт 20: webhook-ретраи, шаблоны, фильтры, матрицы и дайджест.
    const [webhookTimeoutMs, setWebhookTimeoutMs] = createSignal(10000)
    const [webhookRetryCount, setWebhookRetryCount] = createSignal(2)
    const [webhookRetryDelayMs, setWebhookRetryDelayMs] = createSignal(1000)
    const [templateSuccess, setTemplateSuccess] = createSignal("")
    const [templateError, setTemplateError] = createSignal("")
    const [filterInclude, setFilterInclude] = createSignal("")
    const [filterExclude, setFilterExclude] = createSignal("")
    const [matrixNotifyEnabled, setMatrixNotifyEnabled] = createSignal(true)
    const [matrixNotifyPartial, setMatrixNotifyPartial] = createSignal(true)
    const [matrixNotifyAllFailed, setMatrixNotifyAllFailed] = createSignal(true)
    const [matrixStuckMinutes, setMatrixStuckMinutes] = createSignal(60)
    const [digestEnabled, setDigestEnabled] = createSignal(false)
    const [digestFrequency, setDigestFrequency] = createSignal<"daily" | "weekly">("daily")
    const [digestTime, setDigestTime] = createSignal("09:00")
    const [digestLastSentAt, setDigestLastSentAt] = createSignal<string | null>(null)
    // Спринт 30.7: настройки локального ассистента (триаж).
    const [localAiMode, setLocalAiMode] = createSignal<"off" | "rules" | "llm" | "auto">("off")
    const [localAiBaseUrl, setLocalAiBaseUrl] = createSignal("http://127.0.0.1:11434")
    const [localAiModel, setLocalAiModel] = createSignal("")
    const [localAiTimeoutMs, setLocalAiTimeoutMs] = createSignal(60000)
    const [localAiThreshold, setLocalAiThreshold] = createSignal(0.6)
    const [localAiFallback, setLocalAiFallback] = createSignal<"rules" | "notify">("rules")
    const [localAiBusy, setLocalAiBusy] = createSignal(false)
    const [localAiResult, setLocalAiResult] = createSignal<string | null>(null)
    // Спринт 31.13: видимый статус подключения к провайдеру.
    const [localAiState, setLocalAiState] = createSignal<"idle" | "checking" | "ok" | "error">("idle")
    // Спринт 31.4: мастер настройки триажа.
    const [wizardOpen, setWizardOpen] = createSignal(false)
    const [wizardStep, setWizardStep] = createSignal<1 | 2 | 3>(1)
    const [wizardProvider, setWizardProvider] = createSignal<"ollama" | "openai">("ollama")
    const [wizardBaseUrl, setWizardBaseUrl] = createSignal("http://127.0.0.1:11434")
    const [wizardModel, setWizardModel] = createSignal("")
    const [wizardError, setWizardError] = createSignal("")
    const [wizardPreset, setWizardPreset] = createSignal<"minimal" | "recommended" | null>(null)
    const localAiStatusColor = () => {
      switch (localAiState()) {
        case "ok":
          return "#2ecc71"
        case "error":
          return "#e74c3c"
        case "checking":
          return "#d9a441"
        default:
          return "#8e8e93"
      }
    }
    const localAiStatusText = () => {
      switch (localAiState()) {
        case "ok":
          return gt("localAi.status.ok")
        case "error":
          return gt("localAi.status.error")
        case "checking":
          return gt("localAi.status.checking")
        default:
          return gt("localAi.status.idle")
      }
    }
    // Спринт 30.6: shadow-режим триажа.
    const [shadowEnabled, setShadowEnabled] = createSignal(false)
    const [shadowDays, setShadowDays] = createSignal(14)
    const [shadowStartedAt, setShadowStartedAt] = createSignal<string | null>(null)
    const [shadowReportData, setShadowReportData] = createSignal<{ total: number; skips: number; active: boolean } | null>(null)
    const [shadowBusy, setShadowBusy] = createSignal(false)
    // Спринт 25: Telegram, нативные уведомления и тихие часы.
    const [telegramEnabled, setTelegramEnabled] = createSignal(false)
    const [telegramBotToken, setTelegramBotToken] = createSignal("")
    const [telegramChatId, setTelegramChatId] = createSignal("")
    const [telegramParseMode, setTelegramParseMode] = createSignal<"" | "HTML" | "Markdown" | "MarkdownV2">("HTML")
    const [telegramSilent, setTelegramSilent] = createSignal(false)
    const [telegramLink, setTelegramLink] = createSignal(true)
    const [telegramApiBase, setTelegramApiBase] = createSignal("https://api.telegram.org")
    const [telegramThreadId, setTelegramThreadId] = createSignal<number | null>(null)
    const [nativeEnabled, setNativeEnabled] = createSignal(false)
    const [nativeSound, setNativeSound] = createSignal(true)
    const [quietEnabled, setQuietEnabled] = createSignal(false)
    const [quietFrom, setQuietFrom] = createSignal("22:00")
    const [quietTo, setQuietTo] = createSignal("08:00")
    const [digestBusy, setDigestBusy] = createSignal(false)

    // Секреты (Спринт 26): зашифрованное хранилище.
    const [secretsList, setSecretsList] = createSignal<{ name: string; preview: string; updatedAt: string }[]>([])
    const [secretsBusy, setSecretsBusy] = createSignal(false)
    const [secretName, setSecretName] = createSignal("")
    const [secretValue, setSecretValue] = createSignal("")

    // Аудит (Спринт 26): журнал мутаций.
    const [dlqEntries, setDlqEntries] = createSignal<DlqEntry[]>([])
    const [dlqOpen, setDlqOpen] = createSignal(0)
    const [dlqBusy, setDlqBusy] = createSignal(false)
    const [dlqCollapsed, setDlqCollapsed] = createSignal(true)
    const [dlqFilter, setDlqFilter] = createSignal<"open" | "all" | "retried" | "discarded">("open")
    const [auditRecords, setAuditRecords] = createSignal<{ id: number; ts: string; action: string; targetType: string | null; target: string | null; actor: string; source: string | null; details: unknown; remote: string | null }[]>([])
    const [auditBusy, setAuditBusy] = createSignal(false)
    const [auditCollapsed, setAuditCollapsed] = createSignal(true)
    const [auditFilterAction, setAuditFilterAction] = createSignal("")
    const [auditFilterActor, setAuditFilterActor] = createSignal("")
    const [auditFilterTarget, setAuditFilterTarget] = createSignal("")

    // Настройки аудита (ретеншн).
    const [auditRetentionEnabled, setAuditRetentionEnabled] = createSignal(true)
    const [auditRetentionDays, setAuditRetentionDays] = createSignal(90)
    const [auditMaxRecords, setAuditMaxRecords] = createSignal(10000)

    // Настройки ретеншна истории (Спринт 18): очистка старых записей.
    const [historyRetentionDays, setHistoryRetentionDays] = createSignal(30)
    const [historyMaxRecords, setHistoryMaxRecords] = createSignal(5000)
    const [historyLastCleanupAt, setHistoryLastCleanupAt] = createSignal<string | null>(null)
    const [historyLastCleanupDeleted, setHistoryLastCleanupDeleted] = createSignal(0)
    const [historyCollapsed, setHistoryCollapsed] = createSignal(true)
    const [historyCleanupBusy, setHistoryCleanupBusy] = createSignal(false)

    // Таймеры ожидания завершения ручных запусков (для тостов OpenCode).
    const pendingRunTimers = new Map<string, ReturnType<typeof setInterval>>()
    onCleanup(() => {
      for (const timer of pendingRunTimers.values()) clearInterval(timer)
      pendingRunTimers.clear()
    })

    // Название планировщика приходит с бэкенда: на Windows — «Планировщик Windows»,
    // на macOS/Linux — «OpenCode Scheduler». GUI не зависит от ОС напрямую.
    const [schedulerTitle, setSchedulerTitle] = createSignal(gt("gui.app.title"))
    // Платформа нужна форме: режим входа есть только у Планировщика Windows.
    const [schedulerPlatform, setSchedulerPlatform] = createSignal<NodeJS.Platform | "">("")

    async function loadPlatformGui() {
      try {
        const info = await rpc.get_platform({})
        if (info?.title) setSchedulerTitle(info.title)
        if (info?.platform) setSchedulerPlatform(info.platform)
      } catch (err: any) {
        console.error("RPC Error (get_platform):", err)
      }
    }

    /** Разложить настройки уведомлений по сигналам формы (Спринт 20). */
    function applyNotificationSettings(n: NotificationSettings | undefined) {
      setNotificationsEnabled(Boolean(n?.enabled))
      setOnlyOnError(n?.onlyOnError !== false)
      setWebhookEnabled(Boolean(n?.webhook?.enabled))
      setWebhookUrl(n?.webhook?.url ?? "")
      setWebhookTimeoutMs(Number(n?.webhook?.timeoutMs ?? 10000))
      setWebhookRetryCount(Number(n?.webhook?.retryCount ?? 2))
      setWebhookRetryDelayMs(Number(n?.webhook?.retryDelayMs ?? 1000))
      setTemplateSuccess(n?.templates?.success ?? "")
      setTemplateError(n?.templates?.error ?? "")
      setFilterInclude((n?.filters?.include ?? []).join(", "))
      setFilterExclude((n?.filters?.exclude ?? []).join(", "))
      setMatrixNotifyEnabled(n?.matrix?.enabled !== false)
      setMatrixNotifyPartial(n?.matrix?.onPartial !== false)
      setMatrixNotifyAllFailed(n?.matrix?.onAllFailed !== false)
      setMatrixStuckMinutes(Number(n?.matrix?.stuckAfterMinutes ?? 60))
      setDigestEnabled(Boolean(n?.digest?.enabled))
      setDigestFrequency(n?.digest?.frequency === "weekly" ? "weekly" : "daily")
      setDigestTime(n?.digest?.time ?? "09:00")
      setDigestLastSentAt(n?.digest?.lastSentAt ?? null)
      setTelegramEnabled(Boolean(n?.telegram?.enabled))
      setTelegramBotToken(n?.telegram?.botToken ?? "")
      setTelegramChatId(n?.telegram?.chatId ?? "")
      setTelegramParseMode((n?.telegram?.parseMode ?? "HTML") as "" | "HTML" | "Markdown" | "MarkdownV2")
      setTelegramSilent(Boolean(n?.telegram?.disableNotification))
      setTelegramLink(n?.telegram?.includeDashboardLink !== false)
      setTelegramApiBase(n?.telegram?.apiBase ?? "https://api.telegram.org")
      setTelegramThreadId(typeof n?.telegram?.messageThreadId === "number" ? n.telegram.messageThreadId : null)
      setNativeEnabled(Boolean(n?.native?.enabled))
      setNativeSound(n?.native?.sound !== false)
      setQuietEnabled(Boolean(n?.quietHours?.enabled))
      setQuietFrom(n?.quietHours?.from ?? "22:00")
      setQuietTo(n?.quietHours?.to ?? "08:00")
      setLocalAiMode((n?.triage?.mode ?? "off") as "off" | "rules" | "llm" | "auto")
      setLocalAiBaseUrl(n?.triage?.baseUrl ?? "http://127.0.0.1:11434")
      setLocalAiModel(n?.triage?.model ?? "")
      setLocalAiTimeoutMs(Number(n?.triage?.timeoutMs ?? 60000))
      setLocalAiThreshold(Number(n?.triage?.confidenceThreshold ?? 0.6))
      setLocalAiFallback(n?.triage?.fallback === "rules" ? "rules" : "notify")
      setLocalAiState("idle")
      setLocalAiResult(null)
      setShadowEnabled(Boolean(n?.triage?.shadow?.enabled !== false))
      setShadowDays(Number(n?.triage?.shadow?.days ?? 14))
      setShadowStartedAt(n?.triage?.shadow?.startedAt ?? null)
    }

    async function loadSettingsGui() {
      try {
        const s = await rpc.get_settings({})
        setMaxConcurrent(s.maxConcurrent ?? 1)
        setWinterMode(Boolean(s.winterMode))
        applyNotificationSettings(s.notifications)
        const h = s.history
        setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
        setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
        setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
        setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
        const au = s.audit
        setAuditRetentionEnabled(Boolean(au?.enabled !== false))
        setAuditRetentionDays(Number(au?.retentionDays ?? 90))
        setAuditMaxRecords(Number(au?.maxRecords ?? 10000))
        setUiLocaleKnown(normalizeLocale((s as { uiLocale?: string }).uiLocale, "ru"))
        const mode = normalizeLocaleMode((s as { locale?: string }).locale, "ru")
        setLocaleMode(mode)
        // При auto язык задаёт OpenCode: ответ сервера его не переопределяет.
        applyLocaleMode(mode)
      } catch (err: any) {
        console.error("RPC Error (get_settings):", err)
      }
      try {
        const report = await rpc.get_shadow_report({})
        if (report?.success) {
          setShadowReportData({
            total: Number(report.total ?? 0),
            skips: Number(report.skips ?? 0),
            active: Boolean(report.active),
          })
        }
      } catch (err: any) {
        console.error("RPC Error (get_shadow_report):", err)
      }

      void loadSecretsGui()
      void loadAuditGui()
      void loadDlqGui()
    }

    /** Текущие настройки уведомлений из сигналов формы. */
    function currentNotificationSettings(): NotificationSettings {
      const splitList = (value: string) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      return {
        enabled: notificationsEnabled(),
        onlyOnError: onlyOnError(),
        webhook: {
          enabled: webhookEnabled(),
          url: (webhookUrl() || "").trim(),
          timeoutMs: Math.max(1000, Math.min(120000, Math.floor(Number(webhookTimeoutMs()) || 10000))),
          retryCount: Math.max(0, Math.min(5, Math.floor(Number(webhookRetryCount()) || 0))),
          retryDelayMs: Math.max(100, Math.min(60000, Math.floor(Number(webhookRetryDelayMs()) || 1000))),
        },
        templates: {
          success: templateSuccess().trim(),
          error: templateError().trim(),
        },
        filters: {
          include: splitList(filterInclude()),
          exclude: splitList(filterExclude()),
        },
        telegram: {
          enabled: telegramEnabled(),
          botToken: (telegramBotToken() || "").trim(),
          chatId: (telegramChatId() || "").trim(),
          parseMode: telegramParseMode(),
          disableNotification: telegramSilent(),
          messageThreadId: telegramThreadId(),
          includeDashboardLink: telegramLink(),
          apiBase: telegramApiBase(),
        },
        native: {
          enabled: nativeEnabled(),
          sound: nativeSound(),
        },
        quietHours: {
          enabled: quietEnabled(),
          from: (quietFrom() || "22:00").trim(),
          to: (quietTo() || "08:00").trim(),
        },
        matrix: {
          enabled: matrixNotifyEnabled(),
          onPartial: matrixNotifyPartial(),
          onAllFailed: matrixNotifyAllFailed(),
          stuckAfterMinutes: Math.max(
            0,
            Math.min(10080, Math.floor(Number(matrixStuckMinutes()) || 0))
          ),
        },
        digest: {
          enabled: digestEnabled(),
          frequency: digestFrequency(),
          time: (digestTime() || "09:00").trim(),
          lastSentAt: digestLastSentAt(),
        },
        triage: {
          mode: localAiMode(),
          baseUrl: (localAiBaseUrl() || "").trim().replace(/\/+$/, ""),
          model: (localAiModel() || "").trim(),
          timeoutMs: Math.max(1000, Math.min(120000, Math.floor(Number(localAiTimeoutMs()) || 60000))),
          fallback: localAiFallback(),
          confidenceThreshold: Math.max(0, Math.min(1, Number(localAiThreshold()) || 0)),
          shadow: {
            enabled: shadowEnabled(),
            days: Math.max(1, Math.min(365, Math.floor(Number(shadowDays()) || 14))),
            startedAt: shadowStartedAt(),
          },
        },
      }
    }

    /** Текущие настройки ретеншна из сигналов формы. */
    function currentHistorySettings(): HistorySettings {
      return {
        retentionDays: Math.max(0, Math.floor(Number(historyRetentionDays()) || 0)),
        maxRecords: Math.max(0, Math.floor(Number(historyMaxRecords()) || 0)),
        lastCleanupAt: historyLastCleanupAt(),
        lastCleanupDeleted: Math.max(0, Math.floor(Number(historyLastCleanupDeleted()) || 0)),
      }
    }

    async function persistSettings(patch: {
      maxConcurrent?: number
      locale?: LocaleMode
      winterMode?: boolean
      notifications?: NotificationSettings
      history?: HistorySettings
    }): Promise<boolean> {
      try {
        const s = await rpc.save_settings(patch)
        if (patch.maxConcurrent !== undefined) setMaxConcurrent(s.maxConcurrent)
        if (patch.winterMode !== undefined) setWinterMode(Boolean(s.winterMode))
        if (patch.notifications !== undefined) {
          applyNotificationSettings(s.notifications)
        }
        if (patch.history !== undefined) {
          const h = s.history
          setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
          setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
          setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
          setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
        }
        if (patch.audit !== undefined) {
          const au = s.audit
          setAuditRetentionEnabled(Boolean(au?.enabled !== false))
          setAuditRetentionDays(Number(au?.retentionDays ?? 90))
          setAuditMaxRecords(Number(au?.maxRecords ?? 10000))
        }
        setUiLocaleKnown(normalizeLocale((s as { uiLocale?: string }).uiLocale, "ru"))
        const mode = normalizeLocaleMode((s as { locale?: string }).locale, "ru")
        setLocaleMode(mode)
        // При auto язык задаёт OpenCode: ответ сервера его не переопределяет.
        applyLocaleMode(mode)
        return true
      } catch (err: any) {
        console.error("RPC Error (save_settings):", err)
        ctx.toast.show({ title: gt("gui.toast.settingsSaveFailed"), variant: "error", description: errorMessage(err) })
        return false
      }
    }

    /** Сохраняет настройки уведомлений (вызывается после изменения любого поля). */
    async function saveNotificationSettings() {
      await persistSettings({ notifications: currentNotificationSettings() })
    }

    /** Сохраняет настройки ретеншна (вызывается после изменения любого поля). */
    async function saveHistorySettings() {
      await persistSettings({ history: currentHistorySettings() })
    }

    /** Кнопка «🧹 Очистить сейчас»: фиксирует форму и запускает очистку. */
    async function handleHistoryCleanup() {
      setHistoryCleanupBusy(true)
      try {
        // Сначала фиксируем значения формы — очистка использует settings.json.
        await persistSettings({ history: currentHistorySettings() })
        const result = await rpc.cleanup_history({})
        // cleanup_history обновляет lastCleanupAt/lastCleanupDeleted в settings.json.
        const s = await rpc.get_settings({})
        const h = s.history
        setHistoryRetentionDays(Number(h?.retentionDays ?? 30))
        setHistoryMaxRecords(Number(h?.maxRecords ?? 5000))
        setHistoryLastCleanupAt(h?.lastCleanupAt ?? null)
        setHistoryLastCleanupDeleted(Number(h?.lastCleanupDeleted ?? 0))
        setUiLocaleKnown(normalizeLocale((s as { uiLocale?: string }).uiLocale, "ru"))
        const mode = normalizeLocaleMode((s as { locale?: string }).locale, "ru")
        setLocaleMode(mode)
        // При auto язык задаёт OpenCode: ответ сервера его не переопределяет.
        applyLocaleMode(mode)
        ctx.toast.show({
          title: result.success ? gt("gui.toast.historyCleanupDone") : gt("gui.toast.historyCleanupFailed"),
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (cleanup_history):", err)
        ctx.toast.show({
          title: gt("gui.toast.historyCleanupFailed"),
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setHistoryCleanupBusy(false)
      }
    }

    /** Загрузка списка секретов (имена + превью, без значений). */
    async function loadSecretsGui() {
      setSecretsBusy(true)
      try {
        const result = await rpc.list_secrets({})
        setSecretsList(result?.secrets ?? [])
      } catch (err: any) {
        console.error("RPC Error (list_secrets):", err)
      } finally {
        setSecretsBusy(false)
      }
    }

    /** Сохранить/создать секрет. */
    async function handleSaveSecret() {
      const name = secretName().trim()
      const value = secretValue()
      if (!name || !value) return
      setSecretsBusy(true)
      try {
        const result = await rpc.save_secret({ name, value })
        if (result?.success) {
          setSecretName("")
          setSecretValue("")
          ctx.toast.show({ title: gt("gui.toast.secretSaved"), variant: "success", description: result.message })
          void loadSecretsGui()
        } else {
          ctx.toast.show({ title: gt("gui.toast.secretNotSaved"), variant: "error", description: result?.message ?? "" })
        }
      } catch (err: any) {
        console.error("RPC Error (save_secret):", err)
        ctx.toast.show({ title: gt("gui.toast.secretNotSaved"), variant: "error", description: errorMessage(err) })
      } finally {
        setSecretsBusy(false)
      }
    }

    /** Удалить секрет по имени. */
    async function handleDeleteSecret(name: string) {
      setSecretsBusy(true)
      try {
        const result = await rpc.delete_secret({ name })
        if (result?.success) {
          ctx.toast.show({ title: gt("gui.toast.secretDeleted"), variant: "success", description: result?.message ?? "" })
          void loadSecretsGui()
        } else {
          ctx.toast.show({ title: gt("gui.toast.secretNotDeleted"), variant: "error", description: result?.message ?? "" })
        }
      } catch (err: any) {
        console.error("RPC Error (delete_secret):", err)
        ctx.toast.show({ title: gt("gui.toast.secretNotDeleted"), variant: "error", description: errorMessage(err) })
      } finally {
        setSecretsBusy(false)
      }
    }

    /** Загрузка журнала аудита с фильтрами. */
    async function loadAuditGui() {
      setAuditBusy(true)
      try {
        const result = await rpc.get_audit({
          action: auditFilterAction() || undefined,
          actor: auditFilterActor() || undefined,
          target: auditFilterTarget() || undefined,
          limit: 200,
        })
        if (result?.success) {
          setAuditRecords(result?.records ?? [])
        }
      } catch (err: any) {
        console.error("RPC Error (get_audit):", err)
      } finally {
        setAuditBusy(false)
      }
    }

    /** Сохраняет настройки аудита. */
    async function saveAuditSettings() {
      await persistSettings({ audit: { enabled: auditRetentionEnabled(), retentionDays: auditRetentionDays(), maxRecords: auditMaxRecords() } })
    }

    /** Загрузка dead-letter queue (Спринт 36.6). */
    async function loadDlqGui() {
      setDlqBusy(true)
      try {
        const result = await rpc.list_dlq({ status: dlqFilter(), limit: 100 })
        if (result?.success) {
          setDlqEntries(result.entries ?? [])
          setDlqOpen(Number(result.open ?? 0))
        } else if (result?.error) {
          console.error("RPC Error (list_dlq):", result.error)
        }
      } catch (err: any) {
        console.error("RPC Error (list_dlq):", err)
      } finally {
        setDlqBusy(false)
      }
    }

    /** Ручной retry записи DLQ: шаг вернётся в запуск, выполнение подхватит resume. */
    async function handleRetryDlq(entry: DlqEntry) {
      if (!window.confirm(gt("gui.dlqRetryConfirm", { step: entry.stepName, run: entry.runId }))) return
      setDlqBusy(true)
      try {
        const result = await rpc.retry_dlq({ id: entry.id })
        if (result?.success) {
          ctx.toast.show({
            title: gt("gui.dlqRetried"),
            variant: "success",
            description: gt("gui.dlqRetriedDescription", { step: entry.stepName }),
          })
        } else {
          ctx.toast.show({
            title: gt("gui.dlqRetryFailed"),
            variant: "error",
            description: result?.error ?? gt("gui.dlqUnknownError"),
          })
        }
        await loadDlqGui()
      } catch (err: any) {
        console.error("RPC Error (retry_dlq):", err)
        ctx.toast.show({ title: gt("gui.dlqRetryFailed"), variant: "error", description: errorMessage(err) })
      } finally {
        setDlqBusy(false)
      }
    }

    /** Осознанный отказ от повтора: запись закрывается, шаг остаётся failed. */
    async function handleDiscardDlq(entry: DlqEntry) {
      if (!window.confirm(gt("gui.dlqDiscardConfirm", { step: entry.stepName, run: entry.runId }))) return
      setDlqBusy(true)
      try {
        const result = await rpc.discard_dlq({ id: entry.id })
        if (result?.success) {
          ctx.toast.show({
            title: gt("gui.dlqDiscarded"),
            variant: "success",
            description: gt("gui.dlqDiscardedDescription", { step: entry.stepName }),
          })
        } else {
          ctx.toast.show({
            title: gt("gui.dlqDiscardFailed"),
            variant: "error",
            description: result?.error ?? gt("gui.dlqUnknownError"),
          })
        }
        await loadDlqGui()
      } catch (err: any) {
        console.error("RPC Error (discard_dlq):", err)
        ctx.toast.show({ title: gt("gui.dlqDiscardFailed"), variant: "error", description: errorMessage(err) })
      } finally {
        setDlqBusy(false)
      }
    }

    /** Кнопка «🧪 Тестовое уведомление». */
    async function handleTestNotification() {
      setTestNotificationBusy(true)
      try {
        // Сначала фиксируем текущие значения, чтобы тест использовал введённый URL.
        await saveNotificationSettings()
        const result = await rpc.test_notification({})
        ctx.toast.show({
          title: result.success ? gt("gui.toast.testSent") : gt("gui.toast.testFailed"),
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (test_notification):", err)
        ctx.toast.show({
          title: gt("gui.toast.testFailed"),
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setTestNotificationBusy(false)
      }
    }

    /** Кнопка «📊 Отправить дайджест сейчас» (Спринт 20). */
    async function handleSendDigest() {
      setDigestBusy(true)
      try {
        // Сначала фиксируем настройки формы — дайджест читает settings.json.
        await saveNotificationSettings()
        const result = await rpc.send_digest({})
        ctx.toast.show({
          title: result.success ? gt("gui.toast.digestSent") : gt("gui.toast.digestFailed"),
          variant: result.success ? "success" : "error",
          description: result.message,
        })
      } catch (err: any) {
        console.error("RPC Error (send_digest):", err)
        ctx.toast.show({
          title: gt("gui.toast.digestFailed"),
          variant: "error",
          description: errorMessage(err),
        })
      } finally {
        setDigestBusy(false)
      }
    }

    async function saveSettingsGui(val: number) {
      setMaxConcurrent(val)
      await persistSettings({ maxConcurrent: val })
    }

    /** Переключатель зимней темы: сразу применяем в UI и сохраняем в settings.json. */
    async function toggleWinterMode(next: boolean) {
      setWinterMode(next)
      await persistSettings({ winterMode: next })
    }

    // Режим редактирования
    const [editingJob, setEditingJob] = createSignal<Job | null>(null)

    // Свёрнута ли форма создания/редактирования (чтобы не скроллить длинную форму)
    const [formCollapsed, setFormCollapsed] = createSignal(false)

    // Поля формы создания/редактирования задачи
    const [name, setName] = createSignal("")
    const [schedule, setSchedule] = createSignal("* * * * *")
    const [prompt, setPrompt] = createSignal("")
    const [cronPreset, setCronPreset] = createSignal<"* * * * *" | "0 * * * *" | "0 9 * * *" | "0 10 * * 1" | "__custom__">("* * * * *")

    // Повторы при ошибке
    const [retryCount, setRetryCount] = createSignal(0)
    const [retryDelay, setRetryDelay] = createSignal(60)

    // Модель LLM и приоритет запуска
    const [model, setModel] = createSignal("")
    const [priority, setPriority] = createSignal(DEFAULT_PRIORITY)

    // Quality Gate и DAG-зависимости
    const [qualityGate, setQualityGate] = createSignal("")
    const [dependsOn, setDependsOn] = createSignal<string[]>([])

    // Lifecycle hooks (CI/CD): pre-flight и post-flight команды
    const [beforeScript, setBeforeScript] = createSignal("")
    const [afterScript, setAfterScript] = createSignal("")

    // Триггеры (cron / file / git / mcp-event / once) и рабочая директория
    const [triggerType, setTriggerType] = createSignal<"cron" | "file" | "git" | "mcp-event" | "once">("cron")
    const [watchPath, setWatchPath] = createSignal("")
    // Разовое время: ISO-8601 или задержка в секундах от нажатия "Запланировать".
    const [runAt, setRunAt] = createSignal("")
    const [delaySeconds, setDelaySeconds] = createSignal("")
    // Сессия OpenCode (Спринт 24): new / reuse (сохраняем sessionId на задаче) / last (--continue).
    const [session, setSession] = createSignal<"new" | "reuse" | "last">("new")
    const [sessionMaxRuns, setSessionMaxRuns] = createSignal("")
    // Спринт 27.5.9: режим входа (Windows). false — только при активном входе,
    // true — задача работает и без входа (/ru SYSTEM, session 0).
    const [runWhenLoggedOff, setRunWhenLoggedOff] = createSignal(false)
    // Часовой пояс и окно запуска (Спринт 19). Пусто = системный пояс / без окна.
    const [timezone, setTimezone] = createSignal("")
    const [notBefore, setNotBefore] = createSignal("")
    const [notAfter, setNotAfter] = createSignal("")
    // Спринт 27: дни недели, политика вне окна, glob- и git-фильтры.
    const [activeDays, setActiveDays] = createSignal<number[]>([])
    const [windowPolicy, setWindowPolicy] = createSignal<"skip" | "postpone" | "run">("postpone")
    const [watchGlobs, setWatchGlobs] = createSignal("")
    const [watchIgnore, setWatchIgnore] = createSignal("")
    const [gitBranch, setGitBranch] = createSignal("")
    const [gitPaths, setGitPaths] = createSignal("")
    const [gitIgnore, setGitIgnore] = createSignal("")
    const [gitPollSeconds, setGitPollSeconds] = createSignal("")
    const [mcpServer, setMcpServer] = createSignal("")
    const [mcpEventName, setMcpEventName] = createSignal("")
    const [mcpFilter, setMcpFilter] = createSignal("")
    const [workingDirectory, setWorkingDirectory] = createSignal("")

    // Ограничения инструментов (role-scoped, Спринт 14): metadata-only,
    // denied имеет приоритет над allowed.
    const [allowedTools, setAllowedTools] = createSignal<string[]>([])
    const [deniedTools, setDeniedTools] = createSignal<string[]>([])
    const [customTool, setCustomTool] = createSignal("")
    // Matrix (fan-out, Спринт 15): задача-шаблон + список workspace.
    const [matrixMode, setMatrixMode] = createSignal(false)
    const [matrixWorkspaceIds, setMatrixWorkspaceIds] = createSignal<string[]>([])
    const [matrixStrategy, setMatrixStrategy] = createSignal<"parallel" | "sequential">("parallel")
    const [matrixFailureMode, setMatrixFailureMode] = createSignal<"continue" | "stop">("continue")
    const [matrixAggregation, setMatrixAggregation] = createSignal<"summary" | "per-task">("summary")
    const [matrixAggregator, setMatrixAggregator] = createSignal(false)
    // Спринт 17: лимит одновременных клонов и per-workspace переопределения.
    const [matrixConcurrency, setMatrixConcurrency] = createSignal("")
    const [matrixOverrides, setMatrixOverrides] = createSignal<Record<string, MatrixOverrideFields>>({})
    const [dryRunOpen, setDryRunOpen] = createSignal(false)
    const [dryRunBusy, setDryRunBusy] = createSignal(false)
    const [dryRunReport, setDryRunReport] = createSignal<any>(null)
    const [dryRunName, setDryRunName] = createSignal("")

    /** Популярные инструменты для мультивыбора. */
    const POPULAR_TOOLS = ["bash", "edit", "write", "read", "grep", "glob", "webfetch"]

    function toggleTool(target: "allowed" | "denied", tool: string) {
      if (target === "allowed") {
        setAllowedTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]))
      } else {
        setDeniedTools((prev) => (prev.includes(tool) ? prev.filter((t) => t !== tool) : [...prev, tool]))
      }
    }

    function addCustomTool(target: "allowed" | "denied") {
      const name = customTool().trim()
      if (!name) return
      if (target === "allowed") {
        if (!allowedTools().includes(name)) setAllowedTools([...allowedTools(), name])
      } else {
        if (!deniedTools().includes(name)) setDeniedTools([...deniedTools(), name])
      }
      setCustomTool("")
    }

    /** Добавляет/убирает workspace из матрицы. */
    function toggleMatrixWorkspace(id: string, checked: boolean) {
      setMatrixWorkspaceIds((current) => {
        if (checked) return current.includes(id) ? current : [...current, id]
        return current.filter((item) => item !== id)
      })
    }

    /** Имя клона — та же санитизация, что и на бэкенде (expandMatrixTask). */
    function matrixClonePreviewName(parent: string, workspaceName: string): string {
      const base = parent.trim() || "task"
      const safe = workspaceName.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-")
      return `${base}-matrix-${safe || "workspace"}`
    }

    /** Превью имён клонов по текущим полям формы. */
    const matrixPreview = () =>
      matrixWorkspaceIds()
        .map((id) => workspaces().find((w) => w.id === id))
        .filter((w): w is Workspace => Boolean(w))
        .map((w) => matrixClonePreviewName(name(), w.name))

    /** Обновляет одно поле per-workspace переопределения. */
    function updateMatrixOverride(
      workspaceId: string,
      field: keyof MatrixOverrideFields,
      value: string
    ) {
      setMatrixOverrides((prev) => {
        const current: MatrixOverrideFields = { ...(prev[workspaceId] ?? {}) }
        if (value.trim()) {
          current[field] = value
        } else {
          delete current[field]
        }
        const next = { ...prev }
        if (Object.keys(current).length > 0) {
          next[workspaceId] = current
        } else {
          delete next[workspaceId]
        }
        return next
      })
    }

    /** Сколько workspace имеют переопределения (для подписи). */
    const matrixOverrideCount = () => Object.keys(matrixOverrides()).length

    /** Matrix-поле для payload RPC (undefined — обычная задача). */
    const matrixPayload = (): MatrixConfig | undefined => {
      if (!matrixMode()) return undefined
      const concurrencyRaw = matrixConcurrency().trim()
      const concurrency = concurrencyRaw ? Number(concurrencyRaw) : undefined
      const overrides = matrixOverrides()
      return {
        workspaceIds: matrixWorkspaceIds(),
        strategy: matrixStrategy(),
        failureMode: matrixFailureMode(),
        aggregation: matrixAggregation(),
        createAggregator: matrixAggregator(),
        ...(concurrency !== undefined && Number.isFinite(concurrency) && concurrency >= 1
          ? { concurrency: Math.floor(concurrency) }
          : {}),
        ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      }
    }

    /** Спринт 27: дни недели, политика окна и glob/git-фильтры для payload. */
    const triggerExtrasPayload = () => {
      const pollRaw = gitPollSeconds().trim()
      const poll = pollRaw ? Number(pollRaw) : undefined
      return {
        activeDays: activeDays().length > 0 ? activeDays() : undefined,
        windowPolicy: windowPolicy(),
        watchGlobs: splitListInput(watchGlobs()),
        watchIgnore: splitListInput(watchIgnore()),
        gitBranch: (gitBranch() || "").trim(),
        gitPaths: splitListInput(gitPaths()),
        gitIgnore: splitListInput(gitIgnore()),
        ...(poll !== undefined && Number.isFinite(poll) && poll >= 5
          ? { gitPollSeconds: Math.floor(poll) }
          : {}),
      }
    }

    /** Сбрасывает поля формы матрицы. */
    function resetMatrixForm() {
      setMatrixMode(false)
      setMatrixWorkspaceIds([])
      setMatrixStrategy("parallel")
      setMatrixFailureMode("continue")
      setMatrixAggregation("summary")
      setMatrixAggregator(false)
      setMatrixConcurrency("")
      setMatrixOverrides({})
    }

    /** Превью конвейера по текущим полям формы (dry_run требует сохранённую задачу —
     *  для несохранённой формы показываем локальную оценку без RPC). */
    function buildFormCommand(): string {
      const modelArg = model().trim() ? ` --model ${model().trim()}` : ""
      // Обёртка добавляет флаги сессии сама; показываем их в превью, чтобы
      // команда не расходилась с реальным запуском.
      const sessionArg =
        session() === "last"
          ? " --continue"
          : session() === "reuse"
          ? " --session <id>"
          : ""
      return `opencode run${modelArg}${sessionArg} "${prompt().replace(/\s+/g, " ").trim()}"`
    }

    // Экспорт/импорт задач
    const [exportData, setExportData] = createSignal<string | null>(null)
    const [exportBusy, setExportBusy] = createSignal(false)
    const [importBusy, setImportBusy] = createSignal(false)
    const [importFile, setImportFile] = createSignal<File | null>(null)

    async function handleExport() {
      setExportBusy(true)
      try {
        const result = await rpc.export_tasks({})
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.exportFailed"), variant: "error", description: result.error })
          return
        }
        setExportData(result.data)
        const blob = new Blob([result.data], { type: "application/json" })
        const url = URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = `agent-steward-tasks-${new Date().toISOString().slice(0, 10)}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        ctx.toast.show({ title: gt("gui.toast.exported", { count: result.count }), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (export_tasks):", err)
        ctx.toast.show({ title: gt("gui.toast.exportFailed"), variant: "error", description: errorMessage(err) })
      } finally {
        setExportBusy(false)
      }
    }

    function handleImportFile(e: Event) {
      const input = e.target as HTMLInputElement
      const file = input.files?.[0] ?? null
      setImportFile(file)
    }

    async function handleImport() {
      const file = importFile()
      if (!file) {
        ctx.toast.show({ title: gt("gui.toast.chooseFile"), variant: "error", description: gt("gui.toast.noFileForImport") })
        return
      }
      setImportBusy(true)
      try {
        const text = await file.text()
        const result = await rpc.import_tasks({ data: text })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.importFailed"), variant: "error", description: result.error })
          return
        }
        setImportFile(null)
        ctx.toast.show({ title: gt("gui.toast.imported", { count: result.imported }), variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (import_tasks):", err)
        ctx.toast.show({ title: gt("gui.toast.importFailed"), variant: "error", description: errorMessage(err) })
      } finally {
        setImportBusy(false)
      }
    }

    async function loadTemplatesGui() {
      try {
        const result = await rpc.get_templates({})
        const list = Array.isArray(result?.templates) ? (result.templates as CustomTemplate[]) : []
        setCustomTemplates(list)
      } catch (err: any) {
        console.error("RPC Error (get_templates):", err)
      }
    }

    async function loadWorkspacesGui() {
      try {
        const result = await rpc.get_workspaces({})
        const list = Array.isArray(result?.workspaces) ? (result.workspaces as Workspace[]) : []
        setWorkspaces(list)
      } catch (err: any) {
        console.error("RPC Error (get_workspaces):", err)
      }
    }

    /** Активный workspace выбранной задачи (для dry-run подсказки). */
    const selectedWorkspace = () => workspaces().find((w) => w.id === workspaceId())

    // ---- Профили (Спринт 21) ----

    async function loadProfilesGui() {
      try {
        const result = await rpc.get_profiles({})
        const list = Array.isArray(result?.profiles) ? (result.profiles as ProfileInfo[]) : []
        setProfiles(list)
        if (result?.current) setProfileCurrent(result.current)
        setProfilePinned(Boolean(result?.pinnedByEnv))
      } catch (err: any) {
        console.error("RPC Error (get_profiles):", err)
      }
    }

    async function handleSwitchProfile(name: string) {
      if (!name || name === profileCurrent()) return
      setProfileBusy(true)
      try {
        const result = await rpc.set_profile({ name })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.profileSwitchFailed"), variant: "error", description: result.message ?? gt("gui.common.unknownError") })
          return
        }
        setProfileCurrent(result.current ?? name)
        ctx.toast.show({ title: gt("gui.toast.profileSwitched"), variant: "success", description: result.message })
        await loadProfilesGui()
      } catch (err: any) {
        console.error("RPC Error (set_profile):", err)
        ctx.toast.show({ title: gt("gui.toast.profileSwitchError"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setProfileBusy(false)
      }
    }

    async function handleCreateProfile() {
      const name = ((await askText(gt("gui.profile.namePrompt"), "")) ?? "").trim()
      if (!name) return
      setProfileBusy(true)
      try {
        const result = await rpc.create_profile({ name })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.profileCreateFailed"), variant: "error", description: result.message ?? gt("gui.common.unknownError") })
          return
        }
        await loadProfilesGui()
        ctx.toast.show({ title: gt("gui.toast.profileCreated"), variant: "success", description: result.message })
      } catch (err: any) {
        console.error("RPC Error (create_profile):", err)
        ctx.toast.show({ title: gt("gui.toast.profileCreateError"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setProfileBusy(false)
      }
    }

    async function handleDeleteProfile(name: string) {
      if (!name || name === "default") return
      if (!window.confirm(gt("gui.profile.deleteConfirm", { name }))) return
      setProfileBusy(true)
      try {
        const result = await rpc.delete_profile({ name })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.profileDeleteFailed"), variant: "error", description: result.message ?? gt("gui.common.unknownError") })
          return
        }
        await loadProfilesGui()
        ctx.toast.show({ title: gt("gui.toast.profileDeleted"), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (delete_profile):", err)
        ctx.toast.show({ title: gt("gui.toast.profileDeleteError"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setProfileBusy(false)
      }
    }

    // ---- Env-переменные workspace (Спринт 21) ----

    /** Строки `KEY=VALUE` из объекта env (для textarea). */
    function envToText(env?: Record<string, string> | null): string {
      if (!env) return ""
      return Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")
    }

    /** Разбирает textarea `KEY=VALUE`: возвращает пары или null при ошибке. */
    function parseEnvText(text: string): Record<string, string> | null {
      const result: Record<string, string> = {}
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (!line || line.startsWith("#")) continue
        const eq = line.indexOf("=")
        if (eq <= 0) return null
        const key = line.slice(0, eq).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
        result[key] = line.slice(eq + 1).trim()
      }
      return result
    }

    async function handleEditWorkspaceEnv(workspace: Workspace) {
      const envText = await askText(
        gt("gui.workspace.envPrompt"),
        envToText(workspace.env)
      )
      if (envText === null) return
      const env = parseEnvText(envText)
      if (!env) {
        ctx.toast.show({ title: gt("gui.toast.envInvalid"), variant: "error", description: gt("gui.workspace.envInvalidHelp") })
        return
      }
      const envFile = await askText(
        gt("gui.workspace.envFilePrompt"),
        workspace.envFile ?? ""
      )
      if (envFile === null) return
      setWorkspaceBusy(true)
      try {
        const result = await rpc.update_workspace({
          id: workspace.id,
          env: Object.keys(env).length ? env : null,
          envFile: envFile.trim() || null,
        })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.envSaveFailed"), variant: "error", description: result.error ?? gt("gui.common.unknownError") })
          return
        }
        await loadWorkspacesGui()
        ctx.toast.show({ title: gt("gui.toast.envSaved"), variant: "success", description: gt("gui.workspace.envSecretsMasked") })
      } catch (err: any) {
        console.error("RPC Error (update_workspace env):", err)
        ctx.toast.show({ title: gt("gui.toast.envSaveError"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    async function handleAddWorkspace() {
      const workspacePath = ((await askText(gt("gui.workspace.pathPrompt"), "")) ?? "").trim()
      if (!workspacePath) return
      const workspaceName = ((await askText(gt("gui.workspace.namePrompt"), "")) ?? "").trim()
      setWorkspaceBusy(true)
      try {
        const result = await rpc.add_workspace({
          path: workspacePath,
          ...(workspaceName ? { name: workspaceName } : {}),
        })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.workspaceAddFailed"), variant: "error", description: result.error ?? gt("gui.common.unknownError") })
          return
        }
        await loadWorkspacesGui()
        if (result.workspace?.id) setWorkspaceId(result.workspace.id)
        ctx.toast.show({ title: gt("gui.toast.workspaceAdded"), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (add_workspace):", err)
        ctx.toast.show({ title: gt("gui.toast.workspaceAddFailed"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    async function handleEditWorkspace(workspace: Workspace) {
      const nextPath = ((await askText(gt("gui.workspace.pathPromptShort"), workspace.path)) ?? "").trim()
      if (!nextPath) return
      const nextName = ((await askText(gt("gui.workspace.namePromptShort"), workspace.name)) ?? "").trim()
      setWorkspaceBusy(true)
      try {
        const result = await rpc.update_workspace({
          id: workspace.id,
          path: nextPath,
          ...(nextName ? { name: nextName } : {}),
        })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.workspaceUpdateFailed"), variant: "error", description: result.error ?? gt("gui.common.unknownError") })
          return
        }
        await loadWorkspacesGui()
        ctx.toast.show({ title: gt("gui.toast.workspaceUpdated"), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (update_workspace):", err)
        ctx.toast.show({ title: gt("gui.toast.workspaceUpdateFailed"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    async function handleDeleteWorkspace(workspace: Workspace) {
      if (!window.confirm(gt("gui.workspace.deleteConfirm", { name: workspace.name }))) return
      setWorkspaceBusy(true)
      try {
        const result = await rpc.delete_workspace({ id: workspace.id })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.workspaceDeleteFailed"), variant: "error", description: result.message ?? gt("gui.common.unknownError") })
          return
        }
        if (workspaceId() === workspace.id) setWorkspaceId("")
        if (workspaceFilter() === workspace.id) setWorkspaceFilter("all")
        await loadWorkspacesGui()
        await loadJobs()
        ctx.toast.show({ title: gt("gui.toast.workspaceDeleted"), variant: "success", description: result.message })
      } catch (err: any) {
        console.error("RPC Error (delete_workspace):", err)
        ctx.toast.show({ title: gt("gui.toast.workspaceDeleteFailed"), variant: "error", description: shortError(errorMessage(err)) })
      } finally {
        setWorkspaceBusy(false)
      }
    }

    /**
     * При выборе шаблона:
     * — встроенный подставляет только промпт (как раньше);
     * — пользовательский заполняет ВСЕ поля формы (расписание, ретраи,
     *   Quality Gate, цепочки, триггер и рабочую директорию).
     */
    const selectTemplate = (val: string) => {
      setTemplate(val)

      if (val.startsWith("custom:")) {
        const t = customTemplates().find((item) => `custom:${item.id}` === val)
        if (!t) return
        setPrompt(t.prompt ?? "")
        if (t.schedule) {
          setSchedule(t.schedule)
          const preset = cronPresets().find((p) => p.value === t.schedule)
          setCronPreset((preset ? preset.value : "__custom__") as any)
        }
        setRetryCount(t.retryCount ?? 0)
        setRetryDelay(t.retryDelay ?? 60)
        setQualityGate(t.qualityGate ?? "")
        setModel(t.model ?? "")
        setPriority(typeof t.priority === "number" ? t.priority : DEFAULT_PRIORITY)
        setDependsOn(Array.isArray(t.dependsOn) ? t.dependsOn : [])
        setBeforeScript(t.beforeScript ?? "")
        setAfterScript(t.afterScript ?? "")
        setTriggerType(
          t.triggerType === "file"
            ? "file"
            : t.triggerType === "git"
            ? "git"
            : t.triggerType === "mcp-event"
            ? "mcp-event"
            : "cron"
        )
        setWatchPath(t.watchPath ?? "")
        setWatchGlobs(joinListInput(t.watchGlobs))
        setWatchIgnore(joinListInput(t.watchIgnore))
        setGitBranch(t.gitBranch ?? "")
        setGitPaths(joinListInput(t.gitPaths))
        setGitIgnore(joinListInput(t.gitIgnore))
        setGitPollSeconds(t.gitPollSeconds ? String(t.gitPollSeconds) : "")
        setActiveDays(Array.isArray(t.activeDays) ? t.activeDays : [])
        setWindowPolicy(t.windowPolicy ?? "postpone")
        setTimezone(t.timezone ?? "")
        setNotBefore(t.notBefore ?? "")
        setNotAfter(t.notAfter ?? "")
        setMcpServer(t.mcpEvent?.server ?? "")
        setMcpEventName(t.mcpEvent?.event ?? "")
        setMcpFilter(t.mcpEvent?.filter ?? "")
        setWorkingDirectory(t.workingDirectory ?? "")
        setWorkspaceId(t.workspaceId ?? "")
        setAllowedTools(Array.isArray(t.allowedTools) ? t.allowedTools : [])
        setDeniedTools(Array.isArray(t.deniedTools) ? t.deniedTools : [])
        if (t.matrix) {
          setMatrixMode(true)
          setMatrixWorkspaceIds(Array.isArray(t.matrix.workspaceIds) ? t.matrix.workspaceIds : [])
          setMatrixStrategy(t.matrix.strategy === "sequential" ? "sequential" : "parallel")
          setMatrixFailureMode(t.matrix.failureMode === "stop" ? "stop" : "continue")
          setMatrixAggregation(t.matrix.aggregation === "per-task" ? "per-task" : "summary")
          setMatrixAggregator(Boolean(t.matrix.createAggregator))
          setMatrixConcurrency(
            typeof t.matrix.concurrency === "number" ? String(t.matrix.concurrency) : ""
          )
          const overrides = (t.matrix as MatrixConfig).overrides
          setMatrixOverrides(overrides ? { ...overrides } : {})
        } else {
          resetMatrixForm()
        }
        return
      }

      const builtin = promptTemplates().find((t) => t.value === val)
      if (builtin) setPrompt(builtin.prompt)
    }

    /** Сохраняет текущие значения формы как пользовательский шаблон. */
    async function handleSaveAsTemplate() {
      if (!(prompt() || "").trim()) {
        ctx.toast.show({
          title: gt("gui.toast.nothingToSave"),
          variant: "error",
          description: gt("gui.toast.promptRequired"),
        })
        return
      }

      const templateName = ((await askText(gt("gui.templates.namePrompt"), "")) ?? "").trim()
      if (!templateName) return

      try {
        const result = await rpc.save_template({
          name: templateName,
          prompt: (prompt() || "").trim(),
          schedule: (schedule() || "").trim(),
          timeoutSeconds: 3600,
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          ...triggerExtrasPayload(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : undefined,
          deniedTools: deniedTools().length > 0 ? deniedTools() : undefined,
          matrix: matrixPayload(),
        })
        if (!result.success) {
          ctx.toast.show({
            title: gt("gui.toast.templateSaveFailed"),
            variant: "error",
            description: result.error || gt("gui.common.unknownError"),
          })
          return
        }
        await loadTemplatesGui()
        const saved = (result as any).template
        if (saved?.id) setTemplate(`custom:${saved.id}`)
        ctx.toast.show({ title: gt("gui.toast.templateSaved", { name: templateName }), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (save_template):", err)
        ctx.toast.show({
          title: gt("gui.toast.templateSaveError"),
          variant: "error",
          description: errorMessage(err),
        })
      }
    }

    /** Удаляет пользовательский шаблон по id. */
    async function handleDeleteTemplate(t: CustomTemplate) {
      if (!window.confirm(gt("gui.templates.deleteConfirm", { name: t.name }))) return
      try {
        const result = await rpc.delete_template({ id: t.id })
        if (!result.success) {
          ctx.toast.show({
            title: gt("gui.toast.templateDeleteFailed"),
            variant: "error",
            description: result.error || gt("gui.common.unknownError"),
          })
          return
        }
        if (template() === `custom:${t.id}`) setTemplate("custom")
        await loadTemplatesGui()
        ctx.toast.show({ title: gt("gui.toast.templateDeleted", { name: t.name }), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (delete_template):", err)
        ctx.toast.show({
          title: gt("gui.toast.templateDeleteError"),
          variant: "error",
          description: errorMessage(err),
        })
      }
    }

    async function loadJobs() {
      try {
        const result = await rpc.get_tasks({})
        console.log("[GUI] Received tasks:", result)
        const tasks = Array.isArray(result?.tasks) ? (result.tasks as any[]) : []
        console.log("[GUI] tasks count:", tasks.length)
        const mapped: Job[] = tasks.map((t: any) => ({
          name: t.name,
          schedule: t.schedule,
          status: (t.status as JobStatus) ?? "unknown",
          runsTotal: typeof t.runsTotal === "number" ? t.runsTotal : 0,
          runsSuccess: typeof t.runsSuccess === "number" ? t.runsSuccess : 0,
          runsError: typeof t.runsError === "number" ? t.runsError : 0,
          runsPartial: typeof t.runsPartial === "number" ? t.runsPartial : 0,
          nextRun: t.nextRun ?? undefined,
          // Признак паузы приходит из collectTasksView явно (disabled в ОС).
          paused: Boolean((t as any).paused),
          orphaned: Boolean((t as any).orphaned),
          retryCount: t.retryCount ?? 0,
          retryDelay: t.retryDelay ?? 60,
          qualityGate: t.qualityGate ?? undefined,
          dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : undefined,
          model: t.model ?? undefined,
          priority: typeof t.priority === "number" ? t.priority : DEFAULT_PRIORITY,
          beforeScript: t.beforeScript ?? undefined,
          afterScript: t.afterScript ?? undefined,
          triggerType: (t.triggerType ?? "cron") as "cron" | "file" | "mcp-event" | "once",
          runAt: t.runAt ?? undefined,
          session: (t as any).session ?? undefined,
          sessionMaxRuns: (t as any).sessionMaxRuns ?? undefined,
          mcpEvent: t.mcpEvent ?? undefined,
          watchPath: t.watchPath ?? undefined,
          timezone: t.timezone ?? undefined,
          notBefore: t.notBefore ?? undefined,
          notAfter: t.notAfter ?? undefined,
          pausedUntil: t.pausedUntil ?? undefined,
          workingDirectory: t.workingDirectory ?? undefined,
          workspaceId: t.workspaceId ?? undefined,
          workspaceName: t.workspaceName ?? undefined,
          workspaceColor: t.workspaceColor ?? undefined,
          allowedTools: Array.isArray(t.allowedTools) ? t.allowedTools : undefined,
          deniedTools: Array.isArray(t.deniedTools) ? t.deniedTools : undefined,
          matrix: (t as any).matrix ?? null,
          matrixParentId: (t as any).matrixParentId ?? null,
          isMatrixParent: Boolean((t as any).isMatrixParent),
          matrixSummary: (t as any).matrixSummary ?? null,
          prompt: t.prompt ?? "",
        }))
        setJobs(mapped)
        console.log("[GUI] jobs:", jobs())
        await loadMetrics()
      } catch (err: any) {
        console.error("RPC Error (get_tasks):", err)
        // Оставляем старые данные на экране, не роняем UI
        ctx.toast.show({ title: gt("gui.toast.jobsLoadFailed"), variant: "error", description: shortError(errorMessage(err)) })
      }
    }

    async function loadMetrics() {
      try {
        const m = await rpc.get_metrics({})
        setMetrics({ total: m.total ?? 0, success: m.success ?? 0, error: m.error ?? 0 })
      } catch (err: any) {
        console.error("RPC Error (get_metrics):", err)
      }
    }

    async function fetchHistory(taskName: string) {
      setHistoryOpen(taskName)
      try {
        const result = await rpc.get_history({ limit: 10, taskName })
        setHistory(result.records ?? [])
      } catch (err: any) {
        console.error("RPC Error (get_history):", err)
        ctx.toast.show({ title: gt("gui.toast.historyLoadFailed"), variant: "error", description: errorMessage(err) })
      }
    }

    /** Dry-Run: симуляция конвейера задачи без реального запуска (Спринт 14). */
    async function openDryRun(taskName: string) {
      setDryRunOpen(true)
      setDryRunName(taskName)
      setDryRunBusy(true)
      setDryRunReport(null)
      try {
        const result: any = await rpc.dry_run({ taskName })
        setDryRunReport(result)
      } catch (err: any) {
        console.error("RPC Error (dry_run):", err)
        setDryRunReport({ success: false, error: errorMessage(err), tasks: [], warnings: [] })
      } finally {
        setDryRunBusy(false)
      }
    }

    function closeDryRun() {
      setDryRunOpen(false)
      setDryRunName("")
      setDryRunReport(null)
    }

    async function handleCreate() {
      setBusy(true)
      setCronError("")
      try {
        const result = await rpc.create_task({
          name: (name() || "").trim(),
          schedule: (schedule() || "").trim(),
          prompt: (prompt() || "").trim(),
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          session: session(),
          ...(session() === "reuse" && (sessionMaxRuns() || "").trim()
            ? { sessionMaxRuns: Number((sessionMaxRuns() || "").trim()) }
            : {}),
          ...(triggerType() === "once"
            ? {
                runAt: (runAt() || "").trim() || undefined,
                delaySeconds: (delaySeconds() || "").trim() ? Number(delaySeconds().trim()) : undefined,
              }
            : {}),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          ...triggerExtrasPayload(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : undefined,
          deniedTools: deniedTools().length > 0 ? deniedTools() : undefined,
          runWhenLoggedOff: runWhenLoggedOff(),
          matrix: matrixPayload(),
        })
        if (!result.success) {
          const short = shortError(result.message)
          setCronError(short)
          ctx.toast.show({ title: gt("gui.toast.taskCreateFailed"), variant: "error", description: short })
          return
        }
        // Windows регистрирует задачу в Планировщике не мгновенно:
        // даём schtasks ~500 мс, иначе get_tasks может вернуть список без новой задачи.
        await new Promise((r) => setTimeout(r, 500))
        await loadJobs()

        // Форму очищаем только после успешного создания и обновления списка.
        setName("")
        setSchedule("* * * * *")
        setPrompt("")
        setCronPreset("* * * * *")
        setRetryCount(0)
        setRetryDelay(60)
        setQualityGate("")
        setDependsOn([])
        setModel("")
        setPriority(DEFAULT_PRIORITY)
        setBeforeScript("")
        setAfterScript("")
        setTriggerType("cron")
        setWatchPath("")
        setRunAt("")
        setDelaySeconds("")
        setSession("new")
        setSessionMaxRuns("")
        setRunWhenLoggedOff(false)
        setTimezone("")
        setNotBefore("")
        setNotAfter("")
        setMcpServer("")
        setMcpEventName("")
        setMcpFilter("")
        setWorkingDirectory("")
        setWorkspaceId("")
        setAllowedTools([])
        setDeniedTools([])
        resetMatrixForm()
        setEditingJob(null)
        setTemplate("custom")
        ctx.toast.show({ title: gt("gui.toast.taskCreated"), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (create_task):", err)
        const msg = shortError(errorMessage(err))
        setCronError(msg)
        ctx.toast.show({ title: gt("gui.toast.taskCreateFailed"), variant: "error", description: msg })
      } finally {
        setBusy(false)
      }
    }

    /**
     * Следит за завершением ручного запуска и показывает тост OpenCode.
     *
     * Серверный контекст плагина не имеет ctx.toast, поэтому тост показываем
     * в GUI: опрашиваем историю и ждём запись с taskName и startedAt >= since.
     */
    function watchManualRun(jobName: string) {
      const since = new Date().toISOString()
      const previous = pendingRunTimers.get(jobName)
      if (previous) clearInterval(previous)

      let attempts = 0
      const timer = setInterval(() => {
        attempts += 1
        // 900 попыток × 2 с = 30 минут; дальше просто прекращаем опрос.
        if (attempts > 900) {
          clearInterval(timer)
          pendingRunTimers.delete(jobName)
          return
        }

        void (async () => {
          try {
            const result = await rpc.get_history({ limit: 50 })
            const records = (result.records ?? []) as HistoryRecord[]
            const record = records.find(
              (r) =>
                String(r.taskName ?? "").toLowerCase() === jobName.toLowerCase() &&
                typeof r.startedAt === "string" &&
                r.startedAt >= since
            )
            if (!record) return

            clearInterval(timer)
            pendingRunTimers.delete(jobName)

            const ok = record.status === "success"
            const seconds = ((Number(record.durationMs) || 0) / 1000).toFixed(1)
            const reason = record.error ? `: ${record.error}` : ""
            ctx.toast.show({
              title: ok ? gt("gui.toast.taskDone", { name: jobName }) : gt("gui.toast.taskCrashed", { name: jobName }),
              variant: ok ? "success" : "error",
              description: `${seconds}s${reason}`,
            })
            await loadJobs()
          } catch (err: any) {
            console.error("RPC Error (get_history):", err)
          }
        })()
      }, 2000)

      pendingRunTimers.set(jobName, timer)
    }

    async function handleRun(jobName: string) {
      // Защита от { name: undefined }: без валидного имени RPC не отправляем.
      if (!jobName || typeof jobName !== "string") {
        console.error("[GUI] run_task aborted: empty task name")
        return
      }
      try {
        const result = await rpc.run_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.taskStartFailed", { name: jobName }), variant: "error", description: result.message })
          return
        }
        // Уже выполняющаяся задача приходит как success с сообщением
        // «Задача ... уже выполняется» — показываем мягкое уведомление, не ошибку.
        ctx.toast.show({ title: result.message || gt("gui.toast.taskStarted", { name: jobName }), variant: "success" })
        // Для уже идущего запуска не ждём новую запись истории.
        if (!/уже выполняется/i.test(result.message || "")) {
          watchManualRun(jobName)
        }
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (run_task):", err)
        ctx.toast.show({ title: gt("gui.toast.runFailed"), variant: "error", description: errorMessage(err) })
      }
    }

    async function handlePause(jobName: string) {
      try {
        const result = await rpc.pause_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.pauseFailed", { name: jobName }), variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: gt("gui.toast.paused", { name: jobName }), variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (pause_task):", err)
        ctx.toast.show({ title: gt("gui.toast.pauseError"), variant: "error", description: errorMessage(err) })
      }
    }

    async function handleResume(jobName: string) {
      try {
        const result = await rpc.resume_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.resumeFailed", { name: jobName }), variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: gt("gui.toast.resumed", { name: jobName }), variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (resume_task):", err)
        ctx.toast.show({ title: gt("gui.toast.resumeError"), variant: "error", description: errorMessage(err) })
      }
    }

    async function handleCancelMatrix(jobName: string) {
      if (!window.confirm(gt("gui.matrix.cancelClonesConfirm", { name: jobName }))) return
      try {
        const result = await rpc.cancel_matrix({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.matrixCancelFailed"), variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: result.message, variant: "success" })
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (cancel_matrix):", err)
        ctx.toast.show({ title: gt("gui.toast.matrixCancelError"), variant: "error", description: errorMessage(err) })
      }
    }

    async function handleDelete(jobName: string) {
      const target = jobs().find((job) => job.name === jobName)
      const message = target?.matrix
        ? gt("gui.matrix.deleteConfirm", { name: jobName })
        : gt("gui.task.deleteConfirm", { name: jobName })
      if (!window.confirm(message)) return
      try {
        const result = await rpc.delete_task({ name: jobName })
        if (!result.success) {
          ctx.toast.show({ title: gt("gui.toast.deleteFailed"), variant: "error", description: result.message })
          return
        }
        ctx.toast.show({ title: gt("gui.toast.taskDeleted", { name: jobName }), variant: "success" })
        if (logsTask() === jobName) {
          setLogs("")
          setLogsTask(null)
        }
        if (editingJob()?.name === jobName) setEditingJob(null)
        await loadJobs()
      } catch (err: any) {
        console.error("RPC Error (delete_task):", err)
        ctx.toast.show({ title: gt("gui.toast.deleteFailed"), variant: "error", description: errorMessage(err) })
      }
    }

    async function showLogs(jobName: string) {
      setLogsTask(jobName)
      setLogs(gt("gui.logs.loading"))
      try {
        const result = await rpc.get_task_logs({ name: jobName })
        if (!result.success) {
          setLogs(result.error || gt("gui.logs.loadFailed"))
          ctx.toast.show({ title: gt("gui.toast.logsReadFailed"), variant: "error", description: result.error })
          return
        }
        setLogs(result.logs || gt("gui.logs.empty"))
      } catch (err: any) {
        console.error("RPC Error (get_task_logs):", err)
        setLogs(gt("gui.logs.readError", { error: errorMessage(err) }))
      }
    }

    async function handleUpdate() {
      const job = editingJob()
      if (!job) return
      setBusy(true)
      try {
        const result = await rpc.update_task({
          name: job.name,
          newSchedule: (schedule() || "").trim(),
          newPrompt: (prompt() || "").trim(),
          model: (model() || "").trim(),
          priority: priority(),
          retryCount: retryCount(),
          retryDelay: retryDelay(),
          qualityGate: (qualityGate() || "").trim(),
          beforeScript: (beforeScript() || "").trim(),
          afterScript: (afterScript() || "").trim(),
          dependsOn: dependsOn(),
          triggerType: triggerType(),
          session: session(),
          ...(session() === "reuse" && (sessionMaxRuns() || "").trim()
            ? { sessionMaxRuns: Number((sessionMaxRuns() || "").trim()) }
            : {}),
          ...(triggerType() === "once"
            ? {
                runAt: (runAt() || "").trim() || undefined,
                delaySeconds: (delaySeconds() || "").trim() ? Number(delaySeconds().trim()) : undefined,
              }
            : {}),
          timezone: (timezone() || "").trim() || undefined,
          notBefore: (notBefore() || "").trim() || undefined,
          notAfter: (notAfter() || "").trim() || undefined,
          mcpEvent:
            triggerType() === "mcp-event"
              ? {
                  server: (mcpServer() || "").trim(),
                  event: (mcpEventName() || "").trim(),
                  ...(mcpFilter().trim() ? { filter: mcpFilter().trim() } : {}),
                }
              : undefined,
          watchPath: (watchPath() || "").trim(),
          ...triggerExtrasPayload(),
          workingDirectory: (workingDirectory() || "").trim(),
          workspaceId: (workspaceId() || "").trim() || undefined,
          allowedTools: allowedTools().length > 0 ? allowedTools() : [],
          deniedTools: deniedTools().length > 0 ? deniedTools() : [],
          runWhenLoggedOff: runWhenLoggedOff(),
          matrix: matrixPayload(),
        })
        if (!result.success) {
          setCronError(result.message)
          ctx.toast.show({ title: gt("gui.toast.taskUpdateFailed"), variant: "error", description: result.message })
          return
        }
        setEditingJob(null)
        setName("")
        setSchedule("* * * * *")
        setPrompt("")
        setRetryCount(0)
        setRetryDelay(60)
        setQualityGate("")
        setDependsOn([])
        setModel("")
        setPriority(DEFAULT_PRIORITY)
        setBeforeScript("")
        setAfterScript("")
        setTriggerType("cron")
        setWatchPath("")
        setRunAt("")
        setDelaySeconds("")
        setSession("new")
        setSessionMaxRuns("")
        setRunWhenLoggedOff(false)
        setTimezone("")
        setNotBefore("")
        setNotAfter("")
        setMcpServer("")
        setMcpEventName("")
        setMcpFilter("")
        setWorkingDirectory("")
        setWorkspaceId("")
        setAllowedTools([])
        setDeniedTools([])
        resetMatrixForm()
        setCronPreset("* * * * *")
        await loadJobs()
        ctx.toast.show({ title: gt("gui.toast.taskUpdated"), variant: "success" })
      } catch (err: any) {
        console.error("RPC Error (update_task):", err)
        const msg = errorMessage(err)
        setCronError(msg)
        ctx.toast.show({ title: gt("gui.toast.taskUpdateFailed"), variant: "error", description: msg })
      } finally {
        setBusy(false)
      }
    }

    function startEditing(job: Job) {
      setEditingJob(job)
      setFormCollapsed(false)
      setName(job.name)
      setSchedule(job.schedule)
      setPrompt(job.prompt ?? "")
      setModel(job.model ?? "")
      setPriority(typeof job.priority === "number" ? job.priority : DEFAULT_PRIORITY)
      setRetryCount(job.retryCount ?? 0)
      setRetryDelay(job.retryDelay ?? 60)
      setQualityGate(job.qualityGate ?? "")
      setDependsOn(Array.isArray(job.dependsOn) ? job.dependsOn : [])
      setBeforeScript(job.beforeScript ?? "")
      setAfterScript(job.afterScript ?? "")
      setTriggerType(job.triggerType ?? "cron")
      setWatchPath(job.watchPath ?? "")
      setWatchGlobs(joinListInput(job.watchGlobs))
      setWatchIgnore(joinListInput(job.watchIgnore))
      setGitBranch(job.gitBranch ?? "")
      setGitPaths(joinListInput(job.gitPaths))
      setGitIgnore(joinListInput(job.gitIgnore))
      setGitPollSeconds(
        typeof job.gitPollSeconds === "number" ? String(job.gitPollSeconds) : ""
      )
      setActiveDays(Array.isArray(job.activeDays) ? job.activeDays : [])
      setWindowPolicy(job.windowPolicy ?? "postpone")
      setRunAt(job.runAt ?? "")
      setDelaySeconds("")
      setSession(job.session === "reuse" || job.session === "last" ? job.session : "new")
      setRunWhenLoggedOff(job.runWhenLoggedOff === true)
      setSessionMaxRuns(
        typeof job.sessionMaxRuns === "number" ? String(job.sessionMaxRuns) : ""
      )
      setTimezone(job.timezone ?? "")
      setNotBefore(job.notBefore ?? "")
      setNotAfter(job.notAfter ?? "")
      setMcpServer(job.mcpEvent?.server ?? "")
      setMcpEventName(job.mcpEvent?.event ?? "")
      setMcpFilter(job.mcpEvent?.filter ?? "")
      setWorkingDirectory(job.workingDirectory ?? "")
      setWorkspaceId(job.workspaceId ?? "")
      setAllowedTools(Array.isArray(job.allowedTools) ? job.allowedTools : [])
      setDeniedTools(Array.isArray(job.deniedTools) ? job.deniedTools : [])
      if (job.matrix) {
        setMatrixMode(true)
        setMatrixWorkspaceIds(Array.isArray(job.matrix.workspaceIds) ? job.matrix.workspaceIds : [])
        setMatrixStrategy(job.matrix.strategy === "sequential" ? "sequential" : "parallel")
        setMatrixFailureMode(job.matrix.failureMode === "stop" ? "stop" : "continue")
        setMatrixAggregation(job.matrix.aggregation === "per-task" ? "per-task" : "summary")
        setMatrixAggregator(Boolean(job.matrix.createAggregator))
        setMatrixConcurrency(
          typeof job.matrix.concurrency === "number" ? String(job.matrix.concurrency) : ""
        )
        setMatrixOverrides(job.matrix.overrides ? { ...job.matrix.overrides } : {})
      } else {
        resetMatrixForm()
      }
      // Определяем пресет по расписанию
      const preset = CRON_PRESETS.find((p) => p.value === job.schedule)
      setCronPreset((preset ? preset.value : "__custom__") as any)
    }

    // Автообновление списка задач каждые 5 секунд
    loadJobs()
    loadWorkspacesGui()
    loadProfilesGui()
    loadSettingsGui()
    loadPlatformGui()
    loadTemplatesGui()
    const timer = setInterval(loadJobs, 5000)
    onCleanup(() => clearInterval(timer))

    const showCustomCron = cronPreset() === "__custom__"
    const isEditing = editingJob() !== null
    // Валидация формы: возвращает причину, почему сохранение недоступно.
    // Одна функция — и для disabled, и для подсказки в title кнопки.
    /** Валиден ли IANA-пояс (пустой — значит пояс системы). */
    const validTimezone = () => {
      const tz = (timezone() || "").trim()
      if (!tz) return true
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz })
        return true
      } catch {
        return false
      }
    }

    /** Целое число в диапазоне (NaN и пустое поле не проходят). */
    const isIntInRange = (value: number, min: number, max?: number) =>
      Number.isInteger(value) && value >= min && (max === undefined || value <= max)

    const validationError = (): string => {
      const taskName = (name() || "").trim()
      if (!taskName) return gt("gui.validation.taskNameRequired")
      if (!(prompt() || "").trim()) return gt("gui.validation.promptRequired")
      if (triggerType() === "cron" && !(schedule() || "").trim()) return gt("gui.validation.cronRequired")
      if (triggerType() === "once" && !(runAt() || "").trim() && !(delaySeconds() || "").trim()) {
        return gt("gui.validation.runAtRequired")
      }
      // Спринт 27: git-триггер работает только в git-репозитории задачи.
      if (triggerType() === "git" && !(workspaceId() || "").trim() && !(workingDirectory() || "").trim()) {
        return gt("gui.validation.gitWorkspaceRequired")
      }
      if ((gitPollSeconds() || "").trim() && !/^([5-9]|[1-9]\d+)$/.test(gitPollSeconds().trim())) {
        return gt("gui.validation.gitPollInvalid")
      }
      if (matrixMode() && matrixWorkspaceIds().length === 0) return gt("gui.validation.matrixWorkspacesRequired")
      if (session() === "reuse" && (sessionMaxRuns() || "").trim() && !/^[1-9]\d*$/.test(sessionMaxRuns().trim())) {
        return gt("gui.validation.sessionMaxRunsInvalid")
      }
      if (matrixMode() && (matrixConcurrency() || "").trim() && !/^[1-9]\d*$/.test(matrixConcurrency().trim())) {
        return gt("gui.validation.matrixConcurrencyInvalid")
      }
      if (((notBefore() || "").trim() === "") !== ((notAfter() || "").trim() === "")) {
        return gt("gui.validation.windowPairRequired")
      }
      if (!validTimezone()) return gt("gui.validation.timezoneInvalid")
      if (!isIntInRange(priority(), 0, 10)) return gt("gui.validation.priorityInvalid")
      if (!isIntInRange(retryCount(), 0)) return gt("gui.validation.retryCountInvalid")
      if (!isIntInRange(retryDelay(), 0)) return gt("gui.validation.retryDelayInvalid")
      const self = taskName.toLowerCase()
      if (dependsOn().some((dep) => dep.trim().toLowerCase() === self)) {
        return gt("gui.validation.dependsOnSelf")
      }
      return ""
    }

    const canSubmit = () => validationError() === ""

    const jobsArr = () => jobs() ?? []
    const visibleJobs = () => {
      const filter = workspaceFilter()
      if (filter === "all") return jobsArr()
      if (filter === "none") return jobsArr().filter((job) => !job.workspaceId)
      return jobsArr().filter((job) => job.workspaceId === filter)
    }

    /**
     * Кандидаты в зависимости: все задачи, кроме редактируемой/создаваемой.
     * Сравнение без учёта регистра — как в tasks.json.
     */
    const dependencyCandidates = () => {
      const self = (editingJob()?.name ?? name()).trim().toLowerCase()
      return jobsArr()
        .map((job) => job.name)
        .filter((taskName) => taskName.trim().toLowerCase() !== self)
    }

    /** Добавляет/убирает задачу из списка DAG-зависимостей. */
    function toggleDependsOn(taskName: string, checked: boolean) {
      setDependsOn((current) => {
        if (checked) {
          return current.some((n) => n.toLowerCase() === taskName.toLowerCase())
            ? current
            : [...current, taskName]
        }
        return current.filter((n) => n.toLowerCase() !== taskName.toLowerCase())
      })
    }

    // Имя задачи, на кнопке «Запустить» которой сейчас курсор (для снежинки в зимнем режиме).
    const [hoveredRun, setHoveredRun] = createSignal<string | null>(null)

    /** Базовый стиль маленькой иконки-кнопки в карточке задачи. */
    function iconButtonStyle(active = false): string {
      return `background:${active ? "rgba(90,200,250,0.16)" : "transparent"};border:1px solid ${active ? "rgba(90,200,250,0.5)" : "#333"};border-radius:6px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:${active ? "#5ac8fa" : "#cfcfd2"};font-size:14px;line-height:1;padding:0;transition:background 0.18s ease, border-color 0.18s ease, color 0.18s ease`
    }

    /** Плавный hover: лёгкая подсветка фона + смена цвета иконки. */
    function iconHover(e: MouseEvent, on: boolean, active = false) {
      const btn = e.currentTarget as HTMLButtonElement | null
      if (!btn) return
      btn.style.background = on
        ? "rgba(255,255,255,0.09)"
        : active
        ? "rgba(90,200,250,0.16)"
        : "transparent"
      btn.style.borderColor = on ? "#5ac8fa" : active ? "rgba(90,200,250,0.5)" : "#333"
      btn.style.color = on || active ? "#5ac8fa" : "#cfcfd2"
    }

    /**
     * Карточка задачи.
     * SolidJS вызывает компонент с объектом пропсов, поэтому сигнатура
     * `(props: { job: Job })` соответствует вызову `<JobCard job={job} />`.
     * Обращаемся к `props.job` (а не деструктурируем) — так сохраняется реактивность.
     */
    const JobCard = (props: { job: Job }) => {
      const job = props.job
      // Защита: без имени задача не может быть отрендерена и не должна слать RPC.
      if (!job || !job.name) return null
      return (
      <div
        style={`background:#252526;border-radius:10px;padding:16px;margin-bottom:12px;display:flex;flex-direction:column;gap:10px;border:1px solid ${winterMode() ? "rgba(135, 206, 250, 0.4)" : "#333"}`}
      >
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:6px;min-width:0">
              <div style="font-weight:700;font-size:16px;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                {job.name}
              </div>
              {job.workspaceName && (
                <span
                  title={`Workspace: ${job.workspaceName}${job.workingDirectory ? ` (${job.workingDirectory})` : ""}`}
                  style={`font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid ${job.workspaceColor || "#5ac8fa"};color:${job.workspaceColor || "#5ac8fa"};background:${(job.workspaceColor || "#5ac8fa")}1a`}
                >📦 {job.workspaceName}</span>
              )}
              {job.isMatrixParent && job.matrix && (
                <span
                  title={gt("gui.job.fanoutTitle", {
                    count: job.matrix.workspaceIds.length,
                    strategy: job.matrix.strategy ?? "parallel",
                    failureMode: job.matrix.failureMode ?? "continue",
                    concurrency: job.matrix.concurrency
                      ? gt("gui.job.fanoutConcurrency", { concurrency: job.matrix.concurrency })
                      : "",
                    overrides: job.matrix.overrides
                      ? gt("gui.job.fanoutOverrides", { overrides: Object.keys(job.matrix.overrides).length })
                      : "",
                  })}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ff9f0a;color:#ff9f0a;background:rgba(255,159,10,0.12)"
                >📦 Matrix ({job.matrix.workspaceIds.length}){job.matrix.concurrency ? ` ⚙${job.matrix.concurrency}` : ""}</span>
              )}
              {job.matrixParentId && (
                <span
                  title={gt("gui.job.matrixClone", { parent: job.matrixParentId })}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #8e8e93;color:#b0b0b6;background:rgba(142,142,147,0.12)"
                >↳ matrix {job.matrixParentId}</span>
              )}
              {job.watchPath && (
                <span title={gt("gui.job.watchFile", { path: job.watchPath })} style="font-size:13px;flex-shrink:0;cursor:help">👁️</span>
              )}
              {Array.isArray(job.watchGlobs) && job.watchGlobs.length > 0 && (
                <span title={gt("gui.job.watchGlobsTitle", { globs: job.watchGlobs.join(", ") })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #5ac8fa;color:#5ac8fa;background:rgba(90,200,250,0.12)">{gt("gui.job.watchGlobsCount", { count: job.watchGlobs.length })}</span>
              )}
              {job.triggerType === "git" && (
                <span title={gt("gui.job.gitTriggerTitle", {
                  branch: job.gitBranch ? gt("gui.job.gitTriggerBranch", { branch: job.gitBranch }) : "",
                  paths: Array.isArray(job.gitPaths) && job.gitPaths.length > 0 ? gt("gui.job.gitTriggerPaths", { paths: job.gitPaths.join(", ") }) : "",
                  seconds: job.gitPollSeconds ?? 60,
                })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ff9f0a;color:#ff9f0a;background:rgba(255,159,10,0.12)">🔀 git</span>
              )}
              {Array.isArray(job.activeDays) && job.activeDays.length > 0 && (
                <span title={gt("gui.job.activeDaysTitle", { days: job.activeDays.map((d) => [gt("gui.weekday.0"), gt("gui.weekday.1"), gt("gui.weekday.2"), gt("gui.weekday.3"), gt("gui.weekday.4"), gt("gui.weekday.5"), gt("gui.weekday.6")][d] ?? d).join(", ") })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #30d158;color:#30d158;background:rgba(48,209,88,0.12)">📅 {job.activeDays.length}/7</span>
              )}
              {job.timezone && (
                <span title={gt("gui.job.timezoneTitle", { tz: job.timezone })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #64d2ff;color:#64d2ff;background:rgba(100,210,255,0.12)">🌍 {job.timezone}</span>
              )}
              {job.notBefore && job.notAfter && (
                <span title={gt("gui.job.windowTitle", { from: job.notBefore, to: job.notAfter })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #bf5af2;color:#bf5af2;background:rgba(191,90,242,0.12)">🪟 {job.notBefore}–{job.notAfter}</span>
              )}
              {job.pausedUntil && (
                <span title={gt("gui.job.pausedUntilTitle", { date: new Date(job.pausedUntil).toLocaleString() })} style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ffd60a;color:#ffd60a;background:rgba(255,214,10,0.12)">{gt("gui.job.pausedUntilShort", { date: new Date(job.pausedUntil).toLocaleDateString() })}</span>
              )}
              {job.runWhenLoggedOff && (
                <span
                  title={gt("gui.job.runWhenLoggedOffTitle", {
                    mode: job.logonMode ?? gt("gui.job.logonModeUnknown"),
                  })}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #ff9f0a;color:#ff9f0a;background:rgba(255,159,10,0.12)"
                >
                  🌙 {gt("gui.job.runWhenLoggedOffShort")}
                </span>
              )}
              {(job.beforeScript || job.afterScript) && (
                <span
                  title={`Lifecycle hooks: ${[job.beforeScript ? `pre: ${job.beforeScript}` : "", job.afterScript ? `post: ${job.afterScript}` : ""].filter(Boolean).join(" · ")}`}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >⚡</span>
              )}
              {job.triggerType === "mcp-event" && (
                <span
                  title={gt("gui.job.mcpEventTitle", {
                    event: job.mcpEvent?.event ?? "—",
                    filterSuffix: job.mcpEvent?.filter ? gt("gui.job.mcpEventFilterSuffix", { filter: job.mcpEvent.filter }) : "",
                  })}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >📡</span>
              )}
              {job.session && job.session !== "new" && (
                <span
                  title={job.session === "reuse"
                    ? (job.sessionId
                      ? gt("gui.job.sessionReuseTitleId", { id: job.sessionId })
                      : gt("gui.job.sessionReuseTitle"))
                    : gt("gui.job.sessionContinueTitle")}
                  style="font-size:11px;font-weight:600;flex-shrink:0;cursor:help;white-space:nowrap;padding:2px 7px;border-radius:999px;border:1px solid #30d158;color:#30d158;background:rgba(48,209,88,0.12)"
                >{job.session === "reuse" ? gt("gui.job.sessionReuseShort") : gt("gui.job.sessionContinueShort")}</span>
              )}
              {job.model && (
                <span title={gt("gui.job.modelTitle", { model: job.model })} style="font-size:12px;flex-shrink:0;cursor:help;color:#c084fc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px">🧠 {job.model}</span>
              )}
              {typeof job.priority === "number" && job.priority !== DEFAULT_PRIORITY && (
                <span title={gt("gui.job.priorityTitle", { label: priorityLabel(job.priority), priority: job.priority })} style="font-size:12px;flex-shrink:0;cursor:help;color:#f5a623;white-space:nowrap">🚀 {priorityLabel(job.priority)}</span>
              )}
              {(Array.isArray(job.allowedTools) && job.allowedTools.length > 0) || (Array.isArray(job.deniedTools) && job.deniedTools.length > 0) ? (
                <span
                  title={gt("gui.job.toolLimitsTitle", { limits: [
                    job.allowedTools?.length ? `allowed=[${job.allowedTools.join(", ")}]` : "",
                    job.deniedTools?.length ? `denied=[${job.deniedTools.join(", ")}]` : "",
                  ].filter(Boolean).join(" · ") })}
                  style="font-size:13px;flex-shrink:0;cursor:help"
                >🔒</span>
              ) : null}
            </div>
            {Array.isArray(job.dependsOn) && job.dependsOn.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11px;line-height:1.35">
                <span style="color:#5ac8fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{gt("gui.job.dependsOn", { list: job.dependsOn.join(" + ") })}</span>
              </div>
            )}
            {job.isMatrixParent && job.matrixSummary && (
              <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px;font-size:11px;line-height:1.35">
                <span
                  title={job.matrixSummary.message}
                  style={`cursor:help;color:${statusColor(job.matrixSummary.status as JobStatus)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}
                >
                  {gt("gui.job.matrixDone", { success: job.matrixSummary.successCount, total: job.matrixSummary.totalCount })}
                  {job.matrixSummary.errorCount > 0 ? ` · ❌ ${job.matrixSummary.errorCount}` : ""}
                  {job.matrixSummary.pendingCount > 0 ? ` · ⏳ ${job.matrixSummary.pendingCount}` : ""}
                </span>
              </div>
            )}
            <div
              title={gt("gui.job.runsTitle")}
              style="font-size:12px;color:#a0a0a6;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
            >
              {gt("gui.job.runsLine", { total: job.runsTotal ?? 0, success: job.runsSuccess ?? 0, partial: job.runsPartial ?? 0, error: job.runsError ?? 0 })}
            </div>
            {(job.schedule || job.nextRun) && (
              <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#a0a0a6;margin-top:2px">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{job.schedule}</span>
                {job.nextRun && <span>→ {job.nextRun}</span>}
              </div>
            )}
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;min-width:110px">
            {job.status === "running" ? (
              <div style="font-size:12px;color:#f5a623;font-weight:600;white-space:nowrap">
                {gt("gui.jobStatus.running", { seconds: runningSec() })}
              </div>
            ) : (
              <div style="font-size:12px;font-weight:600;white-space:nowrap">
                {job.orphaned
                  ? gt("gui.jobStatus.orphan")
                  : job.paused
                  ? gt("gui.jobStatus.paused")
                  : job.status === "success"
                  ? gt("gui.jobStatus.success")
                  : job.status === "error"
                  ? gt("gui.jobStatus.error")
                  : job.status === "partial"
                  ? gt("gui.jobStatus.partial")
                  : job.status === "idle"
                  ? gt("gui.jobStatus.never")
                  : gt("gui.jobStatus.unknown")}
              </div>
            )}
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button
            onClick={() => void handleRun(job.name)}
            title={gt("gui.job.runTitle", { name: job.name })}
            style={iconButtonStyle()}
            onMouseEnter={(e) => {
              iconHover(e, true)
              if (winterMode()) setHoveredRun(job.name)
            }}
            onMouseLeave={(e) => {
              iconHover(e, false)
              setHoveredRun((n) => (n === job.name ? null : n))
            }}
          >
            {winterMode() && hoveredRun() === job.name ? "❄️" : "▶"}
          </button>
          <button
            onClick={() => {
              if (job.orphaned) return
              void (job.paused ? handleResume(job.name) : handlePause(job.name))
            }}
            disabled={!!job.orphaned}
            title={
              job.orphaned
                ? gt("gui.job.pauseUnavailable", { name: job.name })
                : job.paused
                ? gt("gui.job.resumeTitle", { name: job.name })
                : gt("gui.job.pauseTitle", { name: job.name })
            }
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            {job.paused ? "▶" : "⏸"}
          </button>
          <button
            onClick={() => void showLogs(job.name)}
            title={gt("gui.job.logsTitle", { name: job.name })}
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            📄
          </button>
          <button
            onClick={() => void openDryRun(job.name)}
            title={gt("gui.job.dryRunTitle", { name: job.name })}
            style={iconButtonStyle(dryRunOpen() && dryRunName() === job.name)}
            onMouseEnter={(e) => iconHover(e, true, dryRunOpen() && dryRunName() === job.name)}
            onMouseLeave={(e) => iconHover(e, false, dryRunOpen() && dryRunName() === job.name)}
          >
            🧪
          </button>
          <button
            onClick={() => void fetchHistory(job.name)}
            title={gt("gui.job.historyTitle", { name: job.name })}
            style={iconButtonStyle(historyOpen() === job.name)}
            onMouseEnter={(e) => iconHover(e, true, historyOpen() === job.name)}
            onMouseLeave={(e) => iconHover(e, false, historyOpen() === job.name)}
          >
            📜
          </button>
          <button
            onClick={() => void startEditing(job)}
            title={gt("gui.job.editTitle", { name: job.name })}
            style={iconButtonStyle()}
            onMouseEnter={(e) => iconHover(e, true)}
            onMouseLeave={(e) => iconHover(e, false)}
          >
            ✏️
          </button>
          {job.matrix && (
            <button
              onClick={() => void handleCancelMatrix(job.name)}
              title={gt("gui.job.cancelMatrixTitle", { name: job.name })}
              style={iconButtonStyle()}
              onMouseEnter={(e) => iconHover(e, true)}
              onMouseLeave={(e) => iconHover(e, false)}
            >
              ⛔
            </button>
          )}
          {!job.matrixParentId && (
            <button
              onClick={() => void handleDelete(job.name)}
              title={job.matrix ? gt("gui.job.deleteMatrixTitle", { name: job.name }) : gt("gui.job.deleteTitle", { name: job.name })}
              style={iconButtonStyle()}
              onMouseEnter={(e) => iconHover(e, true)}
              onMouseLeave={(e) => iconHover(e, false)}
            >
              🗑
            </button>
          )}
        </div>
        </div>
        {historyOpen() === job.name && (
          <div style="margin-top:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;gap:6px;width:100%">
            <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;align-items:center;gap:6px">
              {gt("gui.job.historyPanelTitle")}
              <button
                onClick={() => setHistoryOpen(null)}
                style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0"
                onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ffffff" }}
                onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
              >
                ✕
              </button>
            </div>
            {history().length === 0 ? (
              <div style="font-size:12px;color:#8e8e93;padding:6px 0">{gt("gui.job.historyEmpty")}</div>
            ) : (
              history().map((r) => (
                <div key={r.startedAt + r.durationMs} style="display:flex;align-items:flex-start;gap:10px;font-size:12px;color:#e0e0e0;padding:4px 0;border-bottom:1px solid #333">
                  <span style="color:#8e8e93;white-space:nowrap">{new Date(r.startedAt).toLocaleString()}</span>
                  <span style={{color: r.status === "success" ? "#34c759" : "#ff3b30", fontWeight: 600, whiteSpace: "nowrap"}}>
                    {r.status === "success" ? gt("gui.history.success") : gt("gui.history.error")}
                  </span>
                  <span style="color:#b0b0b0;white-space:nowrap">{gt("gui.history.durationMs", { ms: r.durationMs })}</span>
                  {r.model && (
                    <span style="color:#c084fc;white-space:nowrap" title={gt("gui.history.modelTitle", { model: r.model })}>🧠 {r.model}</span>
                  )}
                  {r.preFlightStatus && r.preFlightStatus !== "skipped" && (
                    <span
                      title={`Pre-flight: ${r.preFlightStatus}`}
                      style={{ color: r.preFlightStatus === "success" ? "#34c759" : "#ff3b30", whiteSpace: "nowrap" }}
                    >
                      ⚡ pre: {r.preFlightStatus === "success" ? "✅" : "❌"}
                    </span>
                  )}
                  {r.postFlightStatus && r.postFlightStatus !== "skipped" && (
                    <span
                      title={`Post-flight: ${r.postFlightStatus}`}
                      style={{ color: r.postFlightStatus === "success" ? "#34c759" : "#ff3b30", whiteSpace: "nowrap" }}
                    >
                      ⚡ post: {r.postFlightStatus === "success" ? "✅" : "❌"}
                    </span>
                  )}
                  {r.error && (
                    <div style="margin-top:2px;color:#ff6b6b;font-size:11px;white-space:pre-wrap;word-break:break-word">{r.error}</div>
                  )}
                  {r.nextTask && (
                    <span style="color:#5ac8fa;font-size:11px;white-space:nowrap" title={gt("gui.history.nextTaskTitle")}>🔗 → {r.nextTask}</span>
                  )}
                </div>
              ))
            )}
          </div>
        )}
        {dryRunOpen() && dryRunName() === job.name && (
          <div style="margin-top:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;gap:6px;width:100%">
            <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;align-items:center;gap:6px">
              🧪 Dry-Run: {job.name}
              <button
                onClick={() => closeDryRun()}
                style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0"
                onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ffffff" }}
                onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
              >
                ✕
              </button>
            </div>
            {dryRunBusy() && <div style="font-size:12px;color:#8e8e93;padding:6px 0">{gt("gui.job.simulating")}</div>}
            {!dryRunBusy() && dryRunReport() && !dryRunReport().success && (
              <div style="font-size:12px;color:#ff6b6b;padding:6px 0">❌ {dryRunReport().error ?? gt("gui.job.simulationFailed")}</div>
            )}
            {!dryRunBusy() && dryRunReport() && dryRunReport().success && (
              <div style="display:flex;flex-direction:column;gap:4px">
                {Array.isArray(dryRunReport().warnings) && dryRunReport().warnings.length > 0 && (
                  <div style="font-size:11px;color:#f5a623;padding:4px 0">
                    ⚠ {dryRunReport().warnings.map((w: string) => `· ${w}`).join(" | ")}
                  </div>
                )}
                {dryRunReport().tasks.map((t: any) => (
                  <div key={`${t.name}-${t.order}`} style="font-size:11px;color:#e0e0e0;padding:4px 0;border-bottom:1px solid #333;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline">
                    <span style="color:#8e8e93;white-space:nowrap">#{(t.order ?? 0) + 1} {t.trigger}</span>
                    <span style="font-weight:600;white-space:nowrap">🧪 {t.name}</span>
                    {t.workspace && <span style="color:#5ac8fa;white-space:nowrap">📦 {t.workspace.name}</span>}
                    {t.matrixParent && <span style="color:#ff9f0a;white-space:nowrap">↳ matrix {t.matrixParent}</span>}
                    <span style="color:#8e8e93;white-space:nowrap">cwd: {t.cwd || gt("gui.common.projectDir")}</span>
                    {t.roleScoped && <span style="cursor:help" title={`allowed=[${(t.roleScoped.allowed ?? []).join(", ")}] · denied=[${(t.roleScoped.denied ?? []).join(", ")}]`}>🔒</span>}
                    {t.estimatedDurationSec != null && <span style="color:#8e8e93;white-space:nowrap">{gt("gui.job.durationEst", { seconds: t.estimatedDurationSec })}</span>}
                    {t.estimatedTokens != null && <span style="color:#8e8e93;white-space:nowrap">{gt("gui.job.tokensEst", { tokens: t.estimatedTokens })}</span>}
                    {t.estimatedCostUsd != null && <span style="color:#8e8e93;white-space:nowrap">· ~${Number(t.estimatedCostUsd).toFixed(4)}</span>}
                    <div style="width:100%;color:#a0a0a6;overflow-wrap:anywhere">$ {t.command}</div>
                    {t.preFlight && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">⚡ pre: {t.preFlight}</div>}
                    {t.postFlight && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">⚡ post: {t.postFlight}</div>}
                    {t.qualityGate && <div style="width:100%;color:#8e8e93;overflow-wrap:anywhere">✅ QG: {t.qualityGate}</div>}
                  </div>
                ))}
                {dryRunReport().totals && (dryRunReport().totals.estimatedDurationSec != null || dryRunReport().totals.estimatedTokens != null) && (
                  <div style="font-size:11px;color:#b0b0b0;padding:4px 0">
                    {gt("gui.job.totalsLine", {
                      duration: dryRunReport().totals.estimatedDurationSec ?? "—",
                      tokens: dryRunReport().totals.estimatedTokens ?? "—",
                      cost: dryRunReport().totals.estimatedCostUsd != null ? ` · ~$${Number(dryRunReport().totals.estimatedCostUsd).toFixed(4)}` : "",
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      )
    }

    try {
      return ctx.add(Panel, {
        id: "scheduler-jobs",
        region: "side",
        list: () => [{ id: "jobs", title: gt("gui.jobsTitle"), pinned: true }],
        render: () => (
          <ErrorBoundary fallback={(err: any) => (
            <div style="padding:16px;color:#ff3b30;font-size:13px">
              {gt("gui.uiError", { message: err.message })}
            </div>
          )}>
            <div class="scheduler-panel-root" style={`display:flex;flex-direction:column;width:100%;height:100%;max-height:100vh;min-height:0;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;gap:24px;padding:20px;font-size:13px;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;color:#e0e0e0;transition:background 0.3s ease;scrollbar-width:thin;scrollbar-color:#444 transparent;background:${winterMode() ? "linear-gradient(180deg, #0f172a 0%, #000000 100%)" : "#0f0f0f"}`}>
            {/* Прокручивается корень, а не дети: иначе короткий viewport сжимает карточки до 2px. */}
            <style>{`.scheduler-panel-root > * { flex-shrink: 0; }`}</style>
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div style="min-width:0">
                <h2 style="margin:0;font-size:22px;font-weight:800;letter-spacing:0.2px;line-height:1.2;color:#ffffff">
                  {winterMode() ? `❄️ ${schedulerTitle()} ❄️` : schedulerTitle()}
                </h2>
                <div style="margin-top:5px;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#8e8e93">
                  Local AI CI/CD Orchestrator
                </div>
                <div
                  title={gt("gui.metricsTotalsTitle")}
                  style="margin-top:4px;font-size:11px;color:#8e8e93"
                >
                  {gt("gui.metricsTotalsLine", { total: metrics().total, success: metrics().success, error: metrics().error })}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <select
                  value={localeMode()}
                  onChange={async (e) => {
                    const next = normalizeLocaleMode(e.currentTarget.value, "ru")
                    setLocaleMode(next)
                    applyLocaleMode(next)
                    await persistSettings({ locale: next })
                  }}
                  title={gt("gui.languageTitle")}
                  style="padding:6px 10px;border-radius:999px;cursor:pointer;font-size:12px;border:1px solid #333;background:#1e1e1e;color:#e0e0e0;outline:none"
                >
                  <option value="auto">🌐 {gt("gui.languageAuto")}</option>
                  <option value="ru">{gt("gui.languageRu")}</option>
                  <option value="en">{gt("gui.languageEn")}</option>
                  <option value="zh">{gt("gui.languageZh")}</option>
                </select>
                <select
                  value={workspaceFilter()}
                  onChange={(e) => setWorkspaceFilter(e.currentTarget.value)}
                  title={gt("gui.workspaceFilterTitle")}
                  style="padding:6px 10px;border-radius:999px;cursor:pointer;font-size:12px;border:1px solid #333;background:#1e1e1e;color:#e0e0e0;outline:none;max-width:200px"
                >
                  <option value="all">{gt("gui.workspaceAll")}</option>
                  {workspaces().map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>📦 {workspace.name}</option>
                  ))}
                  <option value="none">{gt("gui.workspaceNone")}</option>
                </select>
                <button
                  onClick={() => setProfilesOpen((v) => !v)}
                  title={profilePinned()
                    ? gt("gui.profileEnvLockedTitle")
                    : gt("gui.profilesTitle")}
                  style={`display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;border:1px solid ${profilesOpen() ? "#bf5af2" : "#333"};background:${profilesOpen() ? "rgba(191,90,242,0.12)" : "#1e1e1e"};color:${profilesOpen() ? "#bf5af2" : "#e0e0e0"}`}
                >
                  👤 {profileCurrent()}{profilePinned() ? " 🔒" : ""}
                </button>
                <button
                  onClick={async () => {
                    // Открываем окно сразу (внутри клика), чтобы не сработал блокировщик попапов.
                    const win = window.open("", "_blank");
                    let port = 3782;
                    try {
                      const info = await rpc.get_dashboard_port({});
                      if (info && typeof info.port === "number" && info.port > 0) {
                        port = info.port;
                      }
                    } catch (err) {
                      console.warn("[scheduler] Не удалось получить порт дашборда:", err);
                    }
                    const url = "http://localhost:" + port;
                    if (win) win.location.href = url;
                    else window.open(url, "_blank");
                  }}
                  title={gt("gui.openDashboardTitle")}
                  style="display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;transition:background 0.2s ease, border-color 0.2s ease;border:1px solid #333;background:#1e1e1e;color:#e0e0e0"
                  onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = "#5ac8fa"; b.style.background = "rgba(90,200,250,0.12)"; b.style.color = "#5ac8fa" }}
                  onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = "#333"; b.style.background = "#1e1e1e"; b.style.color = "#e0e0e0" }}
                >
                  {gt("gui.openDashboard")}
                </button>
                <label
                  title={gt("gui.winterModeTitle")}
                  style={`display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;cursor:pointer;font-size:12px;user-select:none;white-space:nowrap;transition:background 0.2s ease, border-color 0.2s ease;border:1px solid ${winterMode() ? "rgba(135, 206, 250, 0.5)" : "#333"};background:${winterMode() ? "rgba(135, 206, 250, 0.12)" : "#1e1e1e"};color:#e0e0e0`}
                >
                  <input
                    type="checkbox"
                    checked={winterMode()}
                    onChange={(e) => void toggleWinterMode(e.currentTarget.checked)}
                    style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                  />
                  {gt("gui.winterMode")}
                </label>
              </div>
            </div>

            {profilesOpen() && (
              <div style="background:#1e1e1e;border:1px solid #333;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
                  <div style="font-size:12px;font-weight:600;color:#e0e0e0">{gt("gui.profilesHeading")}</div>
                  <button
                    onClick={() => void handleCreateProfile()}
                    disabled={profileBusy()}
                    style={`padding:4px 10px;border-radius:6px;border:1px solid #333;background:#262626;color:#e0e0e0;font-size:11px;cursor:${profileBusy() ? "not-allowed" : "pointer"}`}
                  >
                    {gt("gui.createProfile")}
                  </button>
                </div>
                {profilePinned() && (
                  <div style="font-size:11px;color:#ffd60a">
                    {gt("gui.profileEnvLocked")}
                  </div>
                )}
                <div style="display:flex;flex-direction:column;gap:6px">
                  {profiles().map((profile) => (
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px">
                      <span style={`font-weight:${profile.active ? 700 : 400};color:${profile.active ? "#bf5af2" : "#e0e0e0"}`}>
                        {profile.name}{profile.isDefault ? gt("gui.defaultSuffix") : ""}
                      </span>
                      <span style="font-size:11px;color:#8e8e93">
                        {profile.port ? gt("gui.profilePort", { port: profile.port }) : gt("gui.profilePortDefault")}
                      </span>
                      <span style="font-size:11px;color:#8e8e93;overflow:hidden;text-overflow:ellipsis;max-width:340px" title={profile.dir}>{profile.dir}</span>
                      {profile.active ? (
                        <span style="font-size:11px;color:#34c759">{gt("gui.profileActive")}</span>
                      ) : (
                        <button
                          onClick={() => void handleSwitchProfile(profile.name)}
                          disabled={profileBusy() || profilePinned()}
                          style={`padding:2px 8px;border-radius:6px;border:1px solid #333;background:#262626;color:#e0e0e0;font-size:11px;cursor:${profileBusy() || profilePinned() ? "not-allowed" : "pointer"};opacity:${profilePinned() ? 0.5 : 1}`}
                        >
                          {gt("gui.profileSwitch")}
                        </button>
                      )}
                      {!profile.isDefault && !profile.active && (
                        <button
                          onClick={() => void handleDeleteProfile(profile.name)}
                          disabled={profileBusy()}
                          style={`padding:2px 8px;border-radius:6px;border:1px solid rgba(255,59,48,0.4);background:rgba(255,59,48,0.12);color:#ff3b30;font-size:11px;cursor:${profileBusy() ? "not-allowed" : "pointer"}`}
                        >
                          {gt("gui.profileDelete")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div style="font-size:11px;color:#8e8e93">
                  {gt("gui.profilesHint")}
                </div>
              </div>
            )}

            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
              <button
                onClick={handleExport}
                disabled={exportBusy()}
                style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${exportBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${exportBusy() ? 0.6 : 1};transition:background 0.18s ease`}
              >
                {exportBusy() ? gt("gui.exportBusy") : gt("gui.export")}
              </button>
              <input
                type="file"
                accept=".json"
                onChange={handleImportFile}
                style="display:none"
              />
              <button
                onClick={() => document.querySelector('input[type="file"]')?.click()}
                disabled={importBusy()}
                style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${importBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${importBusy() ? 0.6 : 1};transition:background 0.18s ease`}
              >
                {importBusy() ? gt("gui.importBusy") : gt("gui.import")}
              </button>
            </div>

            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px">
              <label style="font-size:12px;color:#b0b0b0;font-weight:500;white-space:nowrap">{gt("gui.maxConcurrentLabel")}</label>
              <input
                type="number"
                min="0"
                value={maxConcurrent()}
                onChange={(e) => saveSettingsGui(Number(e.currentTarget.value) || 1)}
                style="width:60px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
              />
              <span style="font-size:11px;color:#8e8e93;white-space:nowrap">{gt("gui.zeroUnlimited")}</span>
            </div>

            {/* 🔔 Уведомления (сворачиваемая секция, чтобы не загромождать форму) */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <button
                onClick={() => setNotificationsCollapsed(!notificationsCollapsed())}
                style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:10px 14px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left"
              >
                <span>{gt("gui.notifications")}</span>
                <span style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:400;color:#8e8e93">
                  {notificationsEnabled() ? (onlyOnError() ? gt("gui.notifyOnlyErrors") : gt("gui.notifyAllRuns")) : gt("gui.notifyDisabled")}
                  <span>{notificationsCollapsed() ? "▾" : "▴"}</span>
                </span>
              </button>

              {!notificationsCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#e0e0e0;cursor:pointer">
                    <input
                      type="checkbox"
                      checked={notificationsEnabled()}
                      onChange={(e) => {
                        setNotificationsEnabled(e.currentTarget.checked)
                        void saveNotificationSettings()
                      }}
                      style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                    />
                    {gt("gui.notifyEnable")}
                  </label>

                  <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                    <input
                      type="checkbox"
                      checked={onlyOnError()}
                      disabled={!notificationsEnabled()}
                      onChange={(e) => {
                        setOnlyOnError(e.currentTarget.checked)
                        void saveNotificationSettings()
                      }}
                      style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                    />
                    {gt("gui.notifyOnlyOnError")}
                  </label>

                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={webhookEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setWebhookEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.webhookLabel")}
                    </label>
                    <input
                      type="url"
                      value={webhookUrl() || ""}
                      disabled={!notificationsEnabled() || !webhookEnabled()}
                      onInput={(e) => setWebhookUrl(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder="https://discord.com/api/webhooks/..."
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() && webhookEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.webhookPostHint", { payload: "{ content, text }" })}
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:#b0b0b0">
                      <span>{gt("gui.timeoutMs")}</span>
                      <input
                        type="number"
                        min="1000"
                        max="120000"
                        step="1000"
                        value={webhookTimeoutMs()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookTimeoutMs(Number(e.currentTarget.value) || 10000)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span>{gt("gui.retryCount")}</span>
                      <input
                        type="number"
                        min="0"
                        max="5"
                        value={webhookRetryCount()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookRetryCount(Number(e.currentTarget.value) || 0)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:56px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span>{gt("gui.retryDelayMs")}</span>
                      <input
                        type="number"
                        min="100"
                        max="60000"
                        step="100"
                        value={webhookRetryDelayMs()}
                        disabled={!notificationsEnabled() || !webhookEnabled()}
                        onInput={(e) => setWebhookRetryDelayMs(Number(e.currentTarget.value) || 1000)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.retryHint")}
                    </div>
                  </div>

                  {/* Telegram (Спринт 25) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={telegramEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setTelegramEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      Telegram
                    </label>
                    <input
                      type="password"
                      autocomplete="off"
                      value={telegramBotToken() || ""}
                      disabled={!notificationsEnabled() || !telegramEnabled()}
                      onInput={(e) => setTelegramBotToken(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.botTokenPlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() && telegramEnabled() ? 1 : 0.5}`}
                    />
                    <input
                      type="text"
                      value={telegramChatId() || ""}
                      disabled={!notificationsEnabled() || !telegramEnabled()}
                      onInput={(e) => setTelegramChatId(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.chatIdPlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() && telegramEnabled() ? 1 : 0.5}`}
                    />
                    <div style={`display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && telegramEnabled() ? 1 : 0.5}`}>
                      <span>{gt("gui.parseModeLabel")}</span>
                      <select
                        value={telegramParseMode()}
                        disabled={!notificationsEnabled() || !telegramEnabled()}
                        onChange={(e) => {
                          setTelegramParseMode(e.currentTarget.value as "" | "HTML" | "Markdown" | "MarkdownV2")
                          void saveNotificationSettings()
                        }}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      >
                        <option value="HTML">HTML</option>
                        <option value="MarkdownV2">MarkdownV2</option>
                        <option value="Markdown">Markdown</option>
                        <option value="">plain text</option>
                      </select>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={telegramSilent()}
                          disabled={!notificationsEnabled() || !telegramEnabled()}
                          onChange={(e) => {
                            setTelegramSilent(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        {gt("gui.silent")}
                      </label>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={telegramLink()}
                          disabled={!notificationsEnabled() || !telegramEnabled()}
                          onChange={(e) => {
                            setTelegramLink(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        {gt("gui.dashboardLink")}
                      </label>
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.botTokenEnvHint")}
                    </div>
                  </div>

                  {/* {gt("gui.nativeNotifications")} (Спринт 25) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={nativeEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setNativeEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.nativeNotifications")}
                    </label>
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() && nativeEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={nativeSound()}
                        disabled={!notificationsEnabled() || !nativeEnabled()}
                        onChange={(e) => {
                          setNativeSound(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.withSound")}
                    </label>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.nativeHint")}
                    </div>
                  </div>

                  {/* {gt("gui.quietHours")} (Спринт 25) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={quietEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setQuietEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.quietHours")}
                    </label>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && quietEnabled() ? 1 : 0.5}`}>
                      <span>{gt("gui.quietFrom")}</span>
                      <input
                        type="time"
                        value={quietFrom()}
                        disabled={!notificationsEnabled() || !quietEnabled()}
                        onInput={(e) => setQuietFrom(e.currentTarget.value)}
                        onChange={() => void saveNotificationSettings()}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span>{gt("gui.quietTo")}</span>
                      <input
                        type="time"
                        value={quietTo()}
                        disabled={!notificationsEnabled() || !quietEnabled()}
                        onInput={(e) => setQuietTo(e.currentTarget.value)}
                        onChange={() => void saveNotificationSettings()}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.quietHoursHint")}
                    </div>
                  </div>

                  {/* Фильтры по задачам (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">{gt("gui.taskFiltersHeading")}</div>
                    <input
                      type="text"
                      value={filterInclude() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setFilterInclude(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.filterIncludePlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <input
                      type="text"
                      value={filterExclude() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setFilterExclude(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.filterExcludePlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.filterHint")}
                    </div>
                  </div>

                  {/* Шаблоны сообщений (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">{gt("gui.templatesHeading")}</div>
                    <input
                      type="text"
                      value={templateSuccess() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setTemplateSuccess(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.templateSuccessPlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <input
                      type="text"
                      value={templateError() || ""}
                      disabled={!notificationsEnabled()}
                      onInput={(e) => setTemplateError(e.currentTarget.value)}
                      onChange={() => void saveNotificationSettings()}
                      placeholder={gt("gui.templateErrorPlaceholder")}
                      style={`display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;opacity:${notificationsEnabled() ? 1 : 0.5}`}
                    />
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.templateHint")}
                    </div>
                  </div>

                  {/* 🔐 Секреты (Спринт 26) */}
                  <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px">
                      <span style="font-size:12px;font-weight:600;color:#e0e0e0">{gt("gui.secrets")}</span>
                      <span style="font-size:11px;color:#8e8e93">{secretsList().length}</span>
                    </div>
                    <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                        <input
                          type="text"
                          value={secretName()}
                          placeholder={gt("gui.secretNamePlaceholder")}
                          onInput={(e) => setSecretName(e.currentTarget.value)}
                          style="width:220px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                        />
                        <input
                          type="password"
                          autocomplete="new-password"
                          value={secretValue()}
                          placeholder={gt("gui.secretValuePlaceholder")}
                          onInput={(e) => setSecretValue(e.currentTarget.value)}
                          style="width:320px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                        />
                        <button
                          onClick={() => void handleSaveSecret()}
                          disabled={secretsBusy() || !secretName().trim() || !secretValue()}
                          style={secretsBusy() || !secretName().trim() || !secretValue()
                            ? "padding:6px 12px;background:#666;color:white;border:none;border-radius:6px;cursor:not-allowed;font-size:12px;font-weight:500;opacity:0.6"
                            : "padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;opacity:1"}
                        >
                          {secretsBusy() ? gt("gui.saving") : gt("gui.save")}
                        </button>
                      </div>
                      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;overflow:auto">
                        {secretsList().map((item) => (
                          <span
                            key={item.name}
                            style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:#252526;border:1px solid #333;border-radius:4px;font-size:11px;color:#e0e0e0"
                          >
                            <span style="font-weight:600;color:#569cd6">{item.name}</span>
                            <span style="color:#ce9178">•••• {item.preview}</span>
                            <button
                              onClick={() => void handleDeleteSecret(item.name)}
                              title={gt("gui.delete")}
                              style="padding:2px 6px;background:#c43b2b;color:white;border:none;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;line-height:1"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        {secretsList().length === 0 && (
                          <span style="font-size:11px;color:#8e8e93">{gt("gui.secretsEmpty")}</span>
                        )}
                      </div>
                      <div style="font-size:11px;color:#8e8e93">
                        {gt("gui.secretsUsage", { secretRef: "{secret:NAME}" })}
                      </div>
                    </div>
                  </div>
                  {/* Уведомления о матрицах (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">{gt("gui.matrixNotifyHeading")}</div>
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={matrixNotifyEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setMatrixNotifyEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.matrixNotifyEnable")}
                    </label>
                    <div style={`display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && matrixNotifyEnabled() ? 1 : 0.5}`}>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={matrixNotifyPartial()}
                          disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                          onChange={(e) => {
                            setMatrixNotifyPartial(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        partial
                      </label>
                      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                        <input
                          type="checkbox"
                          checked={matrixNotifyAllFailed()}
                          disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                          onChange={(e) => {
                            setMatrixNotifyAllFailed(e.currentTarget.checked)
                            void saveNotificationSettings()
                          }}
                          style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                        />
                        {gt("gui.matrixAllFailed")}
                      </label>
                      <span>{gt("gui.matrixStuckMinutes")}</span>
                      <input
                        type="number"
                        min="0"
                        max="10080"
                        value={matrixStuckMinutes()}
                        disabled={!notificationsEnabled() || !matrixNotifyEnabled()}
                        onInput={(e) => setMatrixStuckMinutes(Number(e.currentTarget.value) || 0)}
                        onChange={() => void saveNotificationSettings()}
                        style="width:72px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.matrixStuckHint")}
                    </div>
                  </div>

                  {/* Дайджест (Спринт 20) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;color:#e0e0e0;font-weight:600">{gt("gui.digestHeading")}</div>
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={digestEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setDigestEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {gt("gui.digestEnable")}
                    </label>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && digestEnabled() ? 1 : 0.5}`}>
                      <select
                        value={digestFrequency()}
                        disabled={!notificationsEnabled() || !digestEnabled()}
                        onChange={(e) => {
                          setDigestFrequency(e.currentTarget.value === "weekly" ? "weekly" : "daily")
                          void saveNotificationSettings()
                        }}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      >
                        <option value="daily">{gt("gui.digestDaily")}</option>
                        <option value="weekly">{gt("gui.digestWeekly")}</option>
                      </select>
                      <input
                        type="time"
                        value={digestTime()}
                        disabled={!notificationsEnabled() || !digestEnabled()}
                        onInput={(e) => setDigestTime(e.currentTarget.value)}
                        onChange={() => void saveNotificationSettings()}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span style="font-size:11px;color:#8e8e93">
                        {digestLastSentAt()
                          ? gt("gui.digestLastSent", { when: new Date(digestLastSentAt()!).toLocaleString() })
                          : gt("gui.digestNeverSent")}
                      </span>
                    </div>
                    <div style="font-size:11px;color:#8e8e93">
                      {gt("gui.digestHint")}
                    </div>
                  </div>

                  {/* Локальный ассистент: триаж уведомлений (Спринт 30.7) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <div style="font-size:12px;font-weight:600;color:#e0e0e0">{gt("localAi.title")}</div>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <label style="white-space:nowrap">{gt("localAi.mode")}</label>
                      <select
                        value={localAiMode()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setLocalAiMode(e.currentTarget.value as "off" | "rules" | "llm" | "auto")
                          setLocalAiState("idle")
                          setLocalAiResult(null)
                          void saveNotificationSettings()
                        }}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      >
                        <option value="off">{gt("localAi.mode.off")}</option>
                        <option value="rules">{gt("localAi.mode.rules")}</option>
                        <option value="llm">{gt("localAi.mode.llm")}</option>
                        <option value="auto">{gt("localAi.mode.auto")}</option>
                      </select>
                      <label style="white-space:nowrap">{gt("localAi.fallback")}</label>
                      <select
                        value={localAiFallback()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setLocalAiFallback(e.currentTarget.value === "notify" ? "notify" : "rules")
                          void saveNotificationSettings()
                        }}
                        style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      >
                        <option value="rules">{gt("localAi.fallback.rules")}</option>
                        <option value="notify">{gt("localAi.fallback.notify")}</option>
                      </select>
                    </div>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="text"
                        value={localAiBaseUrl()}
                        placeholder="http://127.0.0.1:11434"
                        disabled={!notificationsEnabled()}
                        onInput={(e) => {
                          setLocalAiBaseUrl(e.currentTarget.value)
                          setLocalAiState("idle")
                          setLocalAiResult(null)
                        }}
                        onChange={() => void saveNotificationSettings()}
                        style="width:220px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <input
                        type="text"
                        value={localAiModel()}
                        placeholder={gt("localAi.modelPlaceholder")}
                        disabled={!notificationsEnabled()}
                        onInput={(e) => {
                          setLocalAiModel(e.currentTarget.value)
                          setLocalAiState("idle")
                          setLocalAiResult(null)
                        }}
                        onChange={() => void saveNotificationSettings()}
                        style="width:160px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <label style="white-space:nowrap">{gt("localAi.timeout")}</label>
                      <input
                        type="number"
                        min="1000"
                        max="120000"
                        step="1000"
                        value={localAiTimeoutMs()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setLocalAiTimeoutMs(Math.max(1000, Math.min(120000, Math.floor(Number(e.currentTarget.value) || 60000))))
                          void saveNotificationSettings()
                        }}
                        style="width:90px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <label style="white-space:nowrap">{gt("localAi.threshold")}</label>
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.05"
                        value={localAiThreshold()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          const value = Number(e.currentTarget.value)
                          setLocalAiThreshold(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.6)
                          void saveNotificationSettings()
                        }}
                        style="width:70px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px">
                      <button
                        onClick={async () => {
                          setLocalAiBusy(true)
                          setLocalAiState("checking")
                          setLocalAiResult(null)
                          try {
                            const result = await rpc.test_local_ai({
                              mode: localAiMode(),
                              baseUrl: (localAiBaseUrl() || "").trim(),
                              model: (localAiModel() || "").trim(),
                              timeoutMs: Math.max(1000, Math.min(120000, Math.floor(Number(localAiTimeoutMs()) || 60000))),
                              fallback: localAiFallback(),
                              confidenceThreshold: localAiThreshold(),
                            })
                            const info = result?.result
                            if (result?.success) {
                              setLocalAiState("ok")
                              setLocalAiResult(
                                gt("localAi.testOk", {
                                  model: String(info?.model ?? localAiModel()),
                                  latency: String(info?.latencyMs ?? 0),
                                })
                              )
                            } else {
                              setLocalAiState("error")
                              setLocalAiResult(
                                gt("localAi.testFailed", {
                                  reason: String(info?.error ?? info?.failure ?? "unknown"),
                                })
                              )
                            }
                          } catch (err: any) {
                            console.error("RPC Error (test_local_ai):", err)
                            setLocalAiState("error")
                            setLocalAiResult(gt("localAi.testFailed", { reason: errorMessage(err) }))
                          } finally {
                            setLocalAiBusy(false)
                          }
                        }}
                        disabled={localAiBusy() || !notificationsEnabled()}
                        style={`padding:4px 8px;background:#3a6ea5;color:white;border:none;border-radius:4px;cursor:${localAiBusy() ? "not-allowed" : "pointer"};font-size:12px;opacity:${localAiBusy() ? 0.6 : 1}`}
                      >
                        {localAiBusy() ? gt("localAi.testing") : gt("localAi.test")}
                      </button>
                      <span style="display:inline-flex;align-items:center;gap:6px;font-size:11px">
                        <span style={`width:7px;height:7px;border-radius:50%;background:${localAiStatusColor()}`}></span>
                        <span style={`color:${localAiStatusColor()}`}>{localAiStatusText()}</span>
                      </span>
                      {localAiResult() && <span style="font-size:11px;color:#8e8e93">{localAiResult()}</span>}
                    </div>
                    <div style="font-size:11px;color:#8e8e93">{gt("localAi.hint")}</div>
                    <button
                      onClick={() => {
                        setWizardStep(1)
                        setWizardProvider("ollama")
                        setWizardModel("")
                        setWizardPreset(null)
                        setWizardOpen(true)
                      }}
                      disabled={!notificationsEnabled()}
                      style={`padding:4px 8px;background:#546e7a;color:white;border:none;border-radius:4px;cursor:${notificationsEnabled() ? "pointer" : "not-allowed"};font-size:12px;margin-top:6px`}
                    >
                      {gt("localAi.wizard")}
                    </button>
                    {(localAiMode() === "llm" || localAiMode() === "auto") && (
                      <div style="font-size:11px;color:#d9a441;margin-top:4px">{gt("localAi.asyncHint")}</div>
                    )}
                    <div style="font-size:11px;color:#8e8e93;margin-top:4px">{gt("localAi.rulesHint")}</div>
                  </div>

                  {/* Shadow-режим триажа (Спринт 30.6) */}
                  <div style="border-top:1px solid #333;padding-top:10px;display:flex;flex-direction:column;gap:8px">
                    <label style={`display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;opacity:${notificationsEnabled() ? 1 : 0.5}`}>
                      <input
                        type="checkbox"
                        checked={shadowEnabled()}
                        disabled={!notificationsEnabled()}
                        onChange={(e) => {
                          setShadowEnabled(e.currentTarget.checked)
                          void saveNotificationSettings()
                        }}
                        style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                      />
                      {shadowEnabled() ? gt("shadow.enabled") : gt("shadow.disabled")}
                    </label>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:#b0b0b0;opacity:${notificationsEnabled() && shadowEnabled() ? 1 : 0.5}`}>
                      <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.days")}</label>
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={shadowDays()}
                        disabled={!notificationsEnabled() || !shadowEnabled()}
                        onChange={(e) => {
                          setShadowDays(Math.max(1, Math.min(365, Math.floor(Number(e.currentTarget.value) || 14))))
                          void saveNotificationSettings()
                        }}
                        style="width:70px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                      />
                      <span style="font-size:11px;color:#8e8e93">{shadowStartedAt() ? gt("shadow.active", { days: shadowDays() }) : gt("shadow.expired")}</span>
                    </div>
                    <div style={`display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:${shadowEnabled() ? "#e0e0e0" : "#666666"}`}>
                      <span style="font-weight:600">{shadowReportData()?.total ?? 0} {gt("shadow.total", { count: shadowReportData()?.total ?? 0 }).split(":")[0]}</span>
                      <span style="color:#ff6b6b">{shadowReportData()?.skips ?? 0} {gt("shadow.skips", { count: shadowReportData()?.skips ?? 0 }).split(":")[0]}</span>
                      <button
                        onClick={async () => {
                          setShadowBusy(true)
                          try {
                            await rpc.reset_shadow_report({})
                            setShadowReportData({ total: 0, skips: 0, active: shadowEnabled() })
                          } catch (err: any) {
                            console.error("RPC Error (reset_shadow_report):", err)
                          } finally {
                            setShadowBusy(false)
                          }
                        }}
                        disabled={shadowBusy()}
                        style={`padding:4px 8px;background:#2d7d46;color:white;border:none;border-radius:4px;cursor:${shadowBusy() ? "not-allowed" : "pointer"};font-size:12px;opacity:${shadowBusy() ? 0.6 : 1}`}
                      >
                        {gt("shadow.reset")}
                      </button>
                    </div>
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button
                      onClick={() => void handleTestNotification()}
                      disabled={testNotificationBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled())}
                      style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${testNotificationBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled()) ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${testNotificationBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled()) ? 0.6 : 1}`}
                    >
                      {testNotificationBusy() ? gt("gui.sending") : gt("gui.sendTestNotification")}
                    </button>
                    <button
                      onClick={() => void handleSendDigest()}
                      disabled={digestBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled())}
                      style={`padding:6px 12px;background:#2d7d46;color:white;border:none;border-radius:6px;cursor:${digestBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled()) ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${digestBusy() || !(webhookEnabled() || telegramEnabled() || nativeEnabled()) ? 0.6 : 1}`}
                    >
                      {digestBusy() ? gt("gui.sending") : gt("gui.sendDigestNow")}
                    </button>
                    <span style="font-size:11px;color:#8e8e93">
                      {gt("gui.digestChannels")}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* 🧹 История и ретеншн (Спринт 18) */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <button
                onClick={() => setHistoryCollapsed(!historyCollapsed())}
                style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:10px 14px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left"
              >
                <span>{gt("gui.historyHeading")}</span>
                <span style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:400;color:#8e8e93">
                  {historyRetentionDays() > 0 ? gt("gui.historyOlderThan", { days: historyRetentionDays() }) : gt("gui.historyNoExpiry")} · {historyMaxRecords() > 0 ? gt("gui.historyUpToRecords", { count: historyMaxRecords() }) : gt("gui.historyNoLimit")}
                  <span>{historyCollapsed() ? "▾" : "▴"}</span>
                </span>
              </button>

              {!historyCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.historyDeleteOlderLabel")}</label>
                    <input
                      type="number"
                      min="0"
                      value={historyRetentionDays()}
                      onChange={(e) => {
                        setHistoryRetentionDays(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                        void saveHistorySettings()
                      }}
                      style="width:70px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <span style="font-size:11px;color:#8e8e93">{gt("gui.zeroKeepByAge")}</span>
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.historyKeepMaxLabel")}</label>
                    <input
                      type="number"
                      min="0"
                      value={historyMaxRecords()}
                      onChange={(e) => {
                        setHistoryMaxRecords(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                        void saveHistorySettings()
                      }}
                      style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <span style="font-size:11px;color:#8e8e93">{gt("gui.zeroNoLimit")}</span>
                  </div>

                  <div style="font-size:11px;color:#8e8e93">
                    {gt("gui.lastCleanupLabel")}{" "}
                    {historyLastCleanupAt()
                      ? gt("gui.lastCleanupDone", { when: new Date(historyLastCleanupAt()!).toLocaleString(), deleted: historyLastCleanupDeleted() })
                      : gt("gui.lastCleanupNever")}
                  </div>

                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                    <button
                      onClick={() => void handleHistoryCleanup()}
                      disabled={historyCleanupBusy()}
                      style={`padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:${historyCleanupBusy() ? "not-allowed" : "pointer"};font-size:12px;font-weight:500;opacity:${historyCleanupBusy() ? 0.6 : 1}`}
                    >
                      {historyCleanupBusy() ? gt("gui.cleaningUp") : gt("gui.cleanupNow")}
                    </button>
                    <span style="font-size:11px;color:#8e8e93">
                      {gt("gui.historyCleanupHint")}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* ♻️ Dead-letter queue (Спринт 36.6) */}
            <div style="width:100%;max-width:900px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <button
                onClick={() => setDlqCollapsed(!dlqCollapsed())}
                style="display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;box-sizing:border-box;padding:10px 14px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left"
              >
                <span>{gt("gui.dlqHeading")}</span>
                <span style="display:flex;align-items:center;gap:8px;font-size:11px;font-weight:400;color:#8e8e93">
                  {gt("gui.dlqOpenCount", { count: dlqOpen() })}
                  <span>{dlqCollapsed() ? "▾" : "▴"}</span>
                </span>
              </button>

              {!dlqCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <div style="font-size:11px;color:#8e8e93">{gt("gui.dlqHint")}</div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.dlqFilter")}</label>
                    <select
                      value={dlqFilter()}
                      onChange={(e) => {
                        setDlqFilter(e.currentTarget.value as "open" | "all" | "retried" | "discarded")
                        void loadDlqGui()
                      }}
                      style="padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    >
                      <option value="open">{gt("gui.dlqFilterOpen")}</option>
                      <option value="all">{gt("gui.dlqFilterAll")}</option>
                      <option value="retried">{gt("gui.dlqFilterRetried")}</option>
                      <option value="discarded">{gt("gui.dlqFilterDiscarded")}</option>
                    </select>
                    <button
                      onClick={() => void loadDlqGui()}
                      disabled={dlqBusy()}
                      style={dlqBusy()
                        ? "padding:6px 12px;background:#666;color:white;border:none;border-radius:6px;cursor:not-allowed;font-size:12px;font-weight:500;opacity:0.6"
                        : "padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;opacity:1"}
                    >
                      {dlqBusy() ? gt("gui.loading") : gt("gui.refresh")}
                    </button>
                  </div>
                  <div style="width:100%;overflow:auto;border:1px solid #333;border-radius:6px;background:#0f0f0f">
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                      <thead>
                        <tr style="border-bottom:1px solid #333">
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqCreated")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqRun")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqReason")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqAttempts")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqError")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.dlqActions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dlqEntries().map((entry) => (
                          <tr key={entry.id} style="border-bottom:1px solid #222">
                            <td style="padding:5px 8px;color:#8e8e93;white-space:nowrap">{new Date(entry.createdAt).toLocaleString()}</td>
                            <td style="padding:5px 8px;color:#e0e0e0">
                              <div style="color:#5ac8fa">{entry.stepName}</div>
                              <div style="color:#8e8e93;font-size:10px">run: {entry.runId}</div>
                            </td>
                            <td style="padding:5px 8px;color:#e0e0e0;white-space:nowrap">
                              {entry.reason === "attempts-exhausted"
                                ? gt("gui.dlqReasonAttempts")
                                : entry.reason === "manual"
                                  ? gt("gui.dlqReasonManual")
                                  : (entry.reason ?? "—")}
                            </td>
                            <td style="padding:5px 8px;color:#e0e0e0">{entry.attempts}</td>
                            <td style="padding:5px 8px;color:#ff9f0a;max-width:280px;overflow-wrap:anywhere" title={entry.error ?? ""}>{entry.error ? shortError(entry.error) : "—"}</td>
                            <td style="padding:5px 8px;white-space:nowrap">
                              {entry.status === "open" ? (
                                <div style="display:flex;align-items:center;gap:6px">
                                  <button
                                    onClick={() => void handleRetryDlq(entry)}
                                    disabled={dlqBusy()}
                                    title={gt("gui.dlqRetryTitle")}
                                    style="padding:3px 8px;background:#007acc;color:white;border:none;border-radius:5px;cursor:pointer;font-size:11px"
                                  >
                                    ↻ {gt("gui.dlqRetry")}
                                  </button>
                                  <button
                                    onClick={() => void handleDiscardDlq(entry)}
                                    disabled={dlqBusy()}
                                    title={gt("gui.dlqDiscardTitle")}
                                    style="padding:3px 8px;background:#3a3a3c;color:#e0e0e0;border:none;border-radius:5px;cursor:pointer;font-size:11px"
                                  >
                                    ✕ {gt("gui.dlqDiscard")}
                                  </button>
                                </div>
                              ) : (
                                <span style="color:#8e8e93">{entry.status}{entry.resolution ? ` · ${entry.resolution}` : ""}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                        {dlqEntries().length === 0 && (
                          <tr>
                            <td colspan="6" style="padding:8px;color:#8e8e93">{gt("gui.dlqEmpty")}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            {/* 📜 Журнал аудита (Спринт 26) */}
            <div style="width:100%;max-width:900px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px">
                <button
                  onClick={() => setAuditCollapsed(!auditCollapsed())}
                  style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left;padding:0"
                >
                  <span>{gt("gui.auditHeading")}</span>
                  <span style="font-size:11px;font-weight:400;color:#8e8e93">{auditRecords().length}</span>
                  <span style="font-size:11px;color:#8e8e93">{auditCollapsed() ? "▾" : "▴"}</span>
                </button>
              </div>

              {!auditCollapsed() && (
                <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.auditAction")}</label>
                    <input
                      type="text"
                      value={auditFilterAction()}
                      placeholder={gt("gui.auditActionPlaceholder")}
                      onInput={(e) => setAuditFilterAction(e.currentTarget.value)}
                      onChange={() => void loadAuditGui()}
                      style="width:150px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.auditSource")}</label>
                    <input
                      type="text"
                      value={auditFilterActor()}
                      placeholder="mcp/gui/http"
                      onInput={(e) => setAuditFilterActor(e.currentTarget.value)}
                      onChange={() => void loadAuditGui()}
                      style="width:110px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.auditTarget")}</label>
                    <input
                      type="text"
                      value={auditFilterTarget()}
                      placeholder={gt("gui.auditTargetPlaceholder")}
                      onInput={(e) => setAuditFilterTarget(e.currentTarget.value)}
                      onChange={() => void loadAuditGui()}
                      style="width:180px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                    />
                    <button
                      onClick={() => void loadAuditGui()}
                      disabled={auditBusy()}
                      style={auditBusy()
                        ? "padding:6px 12px;background:#666;color:white;border:none;border-radius:6px;cursor:not-allowed;font-size:12px;font-weight:500;opacity:0.6"
                        : "padding:6px 12px;background:#007acc;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;opacity:1"}
                    >
                      {auditBusy() ? gt("gui.loading") : gt("gui.refresh")}
                    </button>
                  </div>
                  <div style="width:100%;overflow:auto;border:1px solid #333;border-radius:6px;background:#0f0f0f">
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                      <thead>
                        <tr style="border-bottom:1px solid #333">
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditTime")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditAction")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditTarget")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditSource")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditActor")}</th>
                          <th style="text-align:left;padding:6px 8px;color:#8e8e93">{gt("gui.auditDeletedFrom")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {auditRecords().map((r) => (
                          <tr key={r.id} style="border-bottom:1px solid #222">
                            <td style="padding:5px 8px;color:#e0e0e0;white-space:nowrap">{new Date(r.ts).toLocaleString()}</td>
                            <td style="padding:5px 8px;color:#569cd6">{r.action}</td>
                            <td style="padding:5px 8px;color:#e0e0e0;white-space:nowrap">{r.targetType ?? ""}: {r.target ?? "—"}</td>
                            <td style="padding:5px 8px;color:#ce9178">{r.source ?? "—"}</td>
                            <td style="padding:5px 8px;color:#e0e0e0">{r.actor}</td>
                            <td style="padding:5px 8px;color:#8e8e93;white-space:nowrap">{r.remote ?? "—"}</td>
                          </tr>
                        ))}
                        {auditRecords().length === 0 && (
                          <tr>
                            <td colspan="6" style="padding:10px 8px;color:#8e8e93;text-align:center">{gt("gui.auditEmpty")}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div style="font-size:11px;color:#8e8e93">
                    {gt("gui.auditHint", { redacted: "***" })}
                  </div>
                </div>
              )}
            </div>

            {/* 🧹 Настройки аудита (ретеншн) */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;margin-top:8px;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px">
                <span style="font-size:12px;font-weight:600;color:#e0e0e0">{gt("gui.auditStorageHeading")}</span>
              </div>
              <div style="padding:0 14px 14px;display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                    <input
                      type="checkbox"
                      checked={auditRetentionEnabled()}
                      onChange={(e) => {
                        setAuditRetentionEnabled(e.currentTarget.checked)
                        void saveAuditSettings()
                      }}
                      style="accent-color:#5ac8fa;cursor:pointer;margin:0"
                    />
                    {gt("gui.auditEnable")}
                  </label>
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.historyDeleteOlderLabel")}</label>
                  <input
                    type="number"
                    min="0"
                    value={auditRetentionDays()}
                    onChange={(e) => {
                      setAuditRetentionDays(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                      void saveAuditSettings()
                    }}
                    style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                  />
                  <span style="font-size:11px;color:#8e8e93">{gt("gui.zeroKeepByAge")}</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  <label style="font-size:12px;color:#e0e0e0;white-space:nowrap">{gt("gui.historyKeepMaxLabel")}</label>
                  <input
                    type="number"
                    min="0"
                    value={auditMaxRecords()}
                    onChange={(e) => {
                      setAuditMaxRecords(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))
                      void saveAuditSettings()
                    }}
                    style="width:80px;padding:4px 6px;background:#1e1e1e;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px;outline:none"
                  />
                  <span style="font-size:11px;color:#8e8e93">{gt("gui.zeroNoLimit")}</span>
                </div>
              </div>
            </div>

            {/* 📦 Multi-repo workspaces */}
            <div style="width:100%;max-width:700px;box-sizing:border-box;background:#1e1e1e;border:1px solid #333;border-radius:10px;overflow:hidden">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px">
                <button
                  onClick={() => setWorkspacesCollapsed(!workspacesCollapsed())}
                  style="display:flex;align-items:center;gap:8px;background:transparent;border:none;color:#e0e0e0;font-size:12px;font-weight:600;cursor:pointer;text-align:left;padding:0"
                >
                  <span>📦 Workspaces</span>
                  <span style="font-size:11px;font-weight:400;color:#8e8e93">{workspaces().length}</span>
                  <span style="font-size:11px;color:#8e8e93">{workspacesCollapsed() ? "▾" : "▴"}</span>
                </button>
                <button
                  onClick={() => void handleAddWorkspace()}
                  disabled={workspaceBusy()}
                  title={gt("gui.workspaceAddTitle")}
                  style={`padding:5px 10px;border-radius:6px;border:1px solid #333;background:#252526;color:${workspaceBusy() ? "#666" : "#5ac8fa"};font-size:11px;font-weight:600;cursor:${workspaceBusy() ? "not-allowed" : "pointer"}`}
                >
                  {gt("gui.add")}
                </button>
              </div>
              {!workspacesCollapsed() && (
                <div style="display:flex;flex-direction:column;gap:6px;padding:0 14px 12px">
                  {workspaces().length === 0 ? (
                    <div style="font-size:12px;color:#8e8e93;padding:4px 0">
                      {gt("gui.workspaceEmpty")}
                    </div>
                  ) : (
                    workspaces().map((workspace) => (
                      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:#252526;border:1px solid #333;border-radius:8px;min-width:0">
                        <span style={`width:9px;height:9px;border-radius:50%;background:${workspace.color || "#5ac8fa"};flex-shrink:0`}></span>
                        <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
                          <span style="font-size:12px;font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📦 {workspace.name}</span>
                          <span style="font-size:10px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title={workspace.path}>{workspace.path}</span>
                          <span style="font-size:10px;color:#a0a0a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                            {gt("gui.workspaceGitInfo", { branch: workspace.gitBranch || "—", remote: workspace.gitRemote || gt("gui.remoteNotSet") })}
                          </span>
                          <span style="font-size:10px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                            {gt("gui.workspaceEnvLine", { count: workspace.env ? Object.keys(workspace.env).length : "—", envFile: workspace.envFile ? gt("gui.workspaceEnvFile") : "" })}
                          </span>
                        </div>
                        <div style="display:flex;gap:4px;flex-shrink:0">
                          <button
                            onClick={() => void handleEditWorkspaceEnv(workspace)}
                            disabled={workspaceBusy()}
                            title={gt("gui.workspaceEnvTitle")}
                            style="background:transparent;border:none;color:#a0a0a6;cursor:pointer;font-size:14px;padding:2px"
                          >🔑</button>
                          <button
                            onClick={() => void handleEditWorkspace(workspace)}
                            disabled={workspaceBusy()}
                            title={gt("gui.workspaceEditTitle")}
                            style="background:transparent;border:none;color:#a0a0a6;cursor:pointer;font-size:14px;padding:2px"
                          >✏️</button>
                          <button
                            onClick={() => void handleDeleteWorkspace(workspace)}
                            disabled={workspaceBusy()}
                            title={gt("gui.workspaceDeleteTitle")}
                            style="background:transparent;border:none;color:#ff3b30;cursor:pointer;font-size:14px;padding:2px"
                          >🗑</button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Форма создания/редактирования задачи (сворачиваемая) */}
            {formCollapsed() ? (
              <button
                onClick={() => setFormCollapsed(false)}
                title={gt("gui.expandFormTitle")}
                style="display:flex;align-items:center;justify-content:center;gap:8px;width:100%;max-width:700px;box-sizing:border-box;padding:12px 16px;background:#1e1e1e;border:1px dashed #3a3a3a;border-radius:10px;color:#e0e0e0;font-size:13px;font-weight:600;cursor:pointer;transition:border-color 0.18s ease, background 0.18s ease"
                onMouseEnter={(e) => { const b = e.currentTarget; b.style.borderColor = "#5ac8fa"; b.style.background = "#232326" }}
                onMouseLeave={(e) => { const b = e.currentTarget; b.style.borderColor = "#3a3a3a"; b.style.background = "#1e1e1e" }}
              >
                {gt("gui.createTask")}
              </button>
            ) : (
            <div style="display:block;width:100%;max-width:700px;box-sizing:border-box;background:#1e1e1e;padding:20px;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.2)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:16px;flex-wrap:wrap">
                <h3 style="margin:0;font-size:14px;font-weight:600;color:#ffffff">
                  {isEditing ? gt("gui.editingTask") : gt("gui.newTask")}
                </h3>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  <button
                    onClick={handleSaveAsTemplate}
                    title={gt("gui.saveAsTemplateTitle")}
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:4px 10px;color:#a0a0a6;font-size:11px;cursor:pointer;white-space:nowrap;transition:color 0.18s ease, border-color 0.18s ease"
                    onMouseEnter={(e) => { const b = e.currentTarget; b.style.color = "#5ac8fa"; b.style.borderColor = "#5ac8fa" }}
                    onMouseLeave={(e) => { const b = e.currentTarget; b.style.color = "#a0a0a6"; b.style.borderColor = "#333" }}
                  >
                    {gt("gui.saveAsTemplate")}
                  </button>
                  <button
                    onClick={() => setFormCollapsed(true)}
                    title={gt("gui.collapseFormTitle")}
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:4px 10px;color:#a0a0a6;font-size:11px;cursor:pointer;white-space:nowrap;transition:color 0.18s ease, border-color 0.18s ease"
                    onMouseEnter={(e) => { const b = e.currentTarget; b.style.color = "#5ac8fa"; b.style.borderColor = "#5ac8fa" }}
                    onMouseLeave={(e) => { const b = e.currentTarget; b.style.color = "#a0a0a6"; b.style.borderColor = "#333" }}
                  >
                    {gt("gui.hideForm")}
                  </button>
                </div>
              </div>

              {/* Matrix (fan-out, Спринт 15): вместо одного workspace — список. */}
              <div style="display:block;width:100%;margin-bottom:12px;padding:10px 12px;background:#1a1a1a;border:1px solid #333;border-radius:8px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600;color:#fff">
                  <input
                    type="checkbox"
                    checked={matrixMode()}
                    onChange={(e) => {
                      const on = e.currentTarget.checked
                      setMatrixMode(on)
                      if (on) {
                        setWorkspaceId("")
                        if (matrixWorkspaceIds().length === 0) {
                          setMatrixWorkspaceIds(workspaces().map((w) => w.id))
                        }
                      }
                    }}
                    style="accent-color:#ff9f0a"
                  />
                  📦 Matrix (Fan-Out)
                </label>
                <div style="font-size:11px;color:#8e8e93;margin-top:4px;line-height:1.45">
                  {gt("gui.matrixHint")}
                </div>

                {matrixMode() && (
                  <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
                    <div>
                      <div style="font-size:12px;color:#b0b0b0;font-weight:500;margin-bottom:6px">
                        {gt("gui.matrixWorkspacesSelected", { count: matrixWorkspaceIds().length })}
                      </div>
                      {workspaces().length === 0 ? (
                        <div style="font-size:11px;color:#f5a623">{gt("gui.addWorkspaceFirst")}</div>
                      ) : (
                        <div style="display:flex;flex-direction:column;gap:4px;max-height:170px;overflow:auto;padding:6px 8px;background:#141414;border:1px solid #333;border-radius:6px">
                          {workspaces().map((workspace) => (
                            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#e0e0e0">
                              <input
                                type="checkbox"
                                checked={matrixWorkspaceIds().includes(workspace.id)}
                                onChange={(e) => toggleMatrixWorkspace(workspace.id, e.currentTarget.checked)}
                                style="accent-color:#ff9f0a"
                              />
                              <span style={`color:${workspace.color || "#5ac8fa"}`}>📦 {workspace.name}</span>
                              <span style="font-size:10px;color:#8e8e93;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{workspace.path}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        {gt("gui.strategy")}
                        <select
                          value={matrixStrategy()}
                          onChange={(e) => setMatrixStrategy(e.currentTarget.value === "sequential" ? "sequential" : "parallel")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="parallel">{gt("gui.matrixParallel")}</option>
                          <option value="sequential">{gt("gui.matrixSequential")}</option>
                        </select>
                      </label>
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        {gt("gui.onFailure")}
                        <select
                          value={matrixFailureMode()}
                          onChange={(e) => setMatrixFailureMode(e.currentTarget.value === "stop" ? "stop" : "continue")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="continue">{gt("gui.matrixContinue")}</option>
                          <option value="stop">{gt("gui.matrixStop")}</option>
                        </select>
                      </label>
                      <label style="flex:1;min-width:150px;font-size:11px;color:#b0b0b0">
                        {gt("gui.aggregation")}
                        <select
                          value={matrixAggregation()}
                          onChange={(e) => setMatrixAggregation(e.currentTarget.value === "per-task" ? "per-task" : "summary")}
                          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                        >
                          <option value="summary">{gt("gui.matrixSummary")}</option>
                          <option value="per-task">{gt("gui.matrixPerTask")}</option>
                        </select>
                      </label>
                    </div>

                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;color:#e0e0e0">
                      <input
                        type="checkbox"
                        checked={matrixAggregator()}
                        onChange={(e) => setMatrixAggregator(e.currentTarget.checked)}
                        style="accent-color:#ff9f0a"
                      />
                      {gt("gui.matrixAggregator")}
                    </label>

                    <label style="font-size:11px;color:#b0b0b0;max-width:240px">
                      {gt("gui.matrixConcurrency")}
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={matrixConcurrency()}
                        onInput={(e) => setMatrixConcurrency(e.currentTarget.value)}
                        placeholder={matrixStrategy() === "sequential" ? gt("gui.concurrencySequentialPlaceholder") : gt("gui.concurrencyUnlimitedPlaceholder")}
                        style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                      />
                    </label>

                    {matrixWorkspaceIds().length > 0 && (
                      <details style="padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px">
                        <summary style="cursor:pointer;font-size:12px;color:#b0b0b0;font-weight:500">
                          {gt("gui.matrixOverridesTitle", { count: matrixOverrideCount() })}
                        </summary>
                        <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;max-height:340px;overflow:auto">
                          {matrixWorkspaceIds().map((wsId) => {
                            const workspace = workspaces().find((w) => w.id === wsId)
                            if (!workspace) return null
                            const override = matrixOverrides()[wsId] ?? {}
                            const inputStyle =
                              "padding:6px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none;box-sizing:border-box"
                            return (
                              <div style="padding:8px;background:#101010;border:1px solid #2a2a2a;border-radius:6px">
                                <div style={`font-size:12px;font-weight:600;margin-bottom:6px;color:${workspace.color || "#5ac8fa"}`}>
                                  📦 {workspace.name}
                                  <span style="margin-left:6px;font-size:10px;color:#8e8e93">{matrixClonePreviewName(name(), workspace.name)}</span>
                                </div>
                                <div style="display:flex;flex-direction:column;gap:6px">
                                  <textarea
                                    rows={2}
                                    placeholder={gt("gui.matrixPromptPlaceholder")}
                                    value={override.prompt ?? ""}
                                    onInput={(e) => updateMatrixOverride(wsId, "prompt", e.currentTarget.value)}
                                    style={`${inputStyle};width:100%;resize:vertical;font-family:inherit`}
                                  />
                                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                                    <input
                                      placeholder={gt("gui.matrixModelPlaceholder")}
                                      value={override.model ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "model", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                    <input
                                      placeholder="Quality Gate (override)"
                                      value={override.qualityGate ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "qualityGate", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                  </div>
                                  <div style="display:flex;gap:6px;flex-wrap:wrap">
                                    <input
                                      placeholder="beforeScript (override)"
                                      value={override.beforeScript ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "beforeScript", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                    <input
                                      placeholder="afterScript (override)"
                                      value={override.afterScript ?? ""}
                                      onInput={(e) => updateMatrixOverride(wsId, "afterScript", e.currentTarget.value)}
                                      style={`${inputStyle};flex:1;min-width:150px`}
                                    />
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </details>
                    )}

                    <div style="padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px;font-size:11px;line-height:1.55;color:#a0a0a6">
                      {matrixPreview().length > 0 ? (
                        <>
                          <div style="color:#ff9f0a;font-weight:600">{gt("gui.matrixWillCreate", { count: matrixPreview().length })}</div>
                          <div style="color:#e0e0e0;word-break:break-all">{matrixPreview().join(", ")}</div>
                        </>
                      ) : (
                        <span style="color:#f5a623">{gt("gui.matrixSelectHint")}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {!matrixMode() && (
              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.workspaceMultiRepo")}</label>
                <select
                  value={workspaceId()}
                  onChange={(e) => {
                    setWorkspaceId(e.currentTarget.value)
                    if (e.currentTarget.value) setWorkingDirectory("")
                  }}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  <option value="">{gt("gui.noWorkspaceOption")}</option>
                  {workspaces().map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>📦 {workspace.name}</option>
                  ))}
                </select>
                {selectedWorkspace() && (
                  <div style="margin-top:8px;padding:8px 10px;background:#141414;border:1px solid #333;border-radius:6px;font-size:11px;line-height:1.55;color:#a0a0a6">
                    <div>cwd = <span style="color:#e0e0e0">{selectedWorkspace()!.path}</span></div>
                    <div>git branch = <span style="color:#5ac8fa">{selectedWorkspace()!.gitBranch || "—"}</span></div>
                    <div>git remote = <span style="color:#e0e0e0">{selectedWorkspace()!.gitRemote || "—"}</span></div>
                  </div>
                )}
              </div>
              )}

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.taskNameLabel")}</label>
                <input
                  type="text"
                  value={name() || ""}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder={gt("gui.taskNamePlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              {!workspaceId() && !matrixMode() && (
              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.workingDirectoryLabel")}</label>
                <input
                  type="text"
                  value={workingDirectory() || ""}
                  onInput={(e) => setWorkingDirectory(e.currentTarget.value)}
                  placeholder={gt("gui.workingDirectoryPlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.workingDirectoryHint")}</div>
              </div>
              )}

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.triggerTypeLabel")}</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "cron"}
                      onChange={() => setTriggerType("cron")}
                      style="accent-color:#007acc"
                    />
                    {gt("gui.triggerCron")}
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "file"}
                      onChange={() => setTriggerType("file")}
                      style="accent-color:#007acc"
                    />
                    {gt("gui.triggerFile")}
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "git"}
                      onChange={() => setTriggerType("git")}
                      style="accent-color:#007acc"
                    />
                    {gt("gui.triggerGit")}
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "mcp-event"}
                      onChange={() => setTriggerType("mcp-event")}
                      style="accent-color:#007acc"
                    />
                    MCP Event
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="triggerType"
                      checked={triggerType() === "once"}
                      onChange={() => setTriggerType("once")}
                      style="accent-color:#007acc"
                    />
                    {gt("gui.triggerOnce")}
                  </label>
                </div>
              </div>

              {triggerType() === "file" && (
                <div style="display:block;width:100%;margin-bottom:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.watchFileLabel")}</label>
                  <input
                    type="text"
                    value={watchPath() || ""}
                    onInput={(e) => setWatchPath(e.currentTarget.value)}
                    placeholder={gt("gui.watchFilePlaceholder")}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                  <label style="display:block;margin:12px 0 6px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.watchGlobsLabel")}</label>
                  <textarea
                    value={watchGlobs() || ""}
                    onInput={(e) => setWatchGlobs(e.currentTarget.value)}
                    rows={3}
                    placeholder={"**/*.md\nsrc/**"}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical;font-family:ui-monospace,Consolas,monospace"
                  />
                  <label style="display:block;margin:12px 0 6px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.watchIgnoreLabel")}</label>
                  <textarea
                    value={watchIgnore() || ""}
                    onInput={(e) => setWatchIgnore(e.currentTarget.value)}
                    rows={2}
                    placeholder={"node_modules/**\n*.log"}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical;font-family:ui-monospace,Consolas,monospace"
                  />
                  <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.watchGlobsHint")}</div>
                </div>
              )}

              {triggerType() === "git" && (
                <>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.gitBranchesLabel")}</label>
                    <input
                      type="text"
                      value={gitBranch() || ""}
                      onInput={(e) => setGitBranch(e.currentTarget.value)}
                      placeholder="main, release/*"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.gitPathsLabel")}</label>
                    <textarea
                      value={gitPaths() || ""}
                      onInput={(e) => setGitPaths(e.currentTarget.value)}
                      rows={3}
                      placeholder={"src/**\n**/*.md"}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical;font-family:ui-monospace,Consolas,monospace"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.gitIgnoreLabel")}</label>
                    <textarea
                      value={gitIgnore() || ""}
                      onInput={(e) => setGitIgnore(e.currentTarget.value)}
                      rows={2}
                      placeholder={"docs/**\n*.lock"}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical;font-family:ui-monospace,Consolas,monospace"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.gitPollLabel")}</label>
                    <input
                      type="number"
                      min="5"
                      value={gitPollSeconds() || ""}
                      onInput={(e) => setGitPollSeconds(e.currentTarget.value)}
                      placeholder="60"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.gitPollHint")}</div>
                  </div>
                </>
              )}

              {triggerType() === "mcp-event" && (
                <>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.mcpSourceLabel")}</label>
                    <input
                      type="text"
                      value={mcpServer() || ""}
                      onInput={(e) => setMcpServer(e.currentTarget.value)}
                      placeholder={gt("gui.mcpSourcePlaceholder")}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.mcpEventLabel")}</label>
                    <input
                      type="text"
                      value={mcpEventName() || ""}
                      onInput={(e) => setMcpEventName(e.currentTarget.value)}
                      placeholder={gt("gui.mcpEventPlaceholder")}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;width:100%;margin-bottom:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.mcpFilterLabel")}</label>
                    <input
                      type="text"
                      value={mcpFilter() || ""}
                      onInput={(e) => setMcpFilter(e.currentTarget.value)}
                      placeholder={gt("gui.mcpFilterPlaceholder")}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.mcpFilterHint")}</div>
                  </div>
                </>
              )}

              {triggerType() === "once" && (
                <div style="display:block;width:100%;margin-bottom:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.oneShotTimeLabel")}</label>
                  <input
                    type="text"
                    value={runAt() || ""}
                    onInput={(e) => setRunAt(e.currentTarget.value)}
                    placeholder={gt("gui.oneShotTimePlaceholder")}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                  <div style="font-size:11px;color:#8e8e93;margin:6px 0">{gt("gui.oneShotDelayHint")}</div>
                  <input
                    type="number"
                    min="1"
                    value={delaySeconds() || ""}
                    onInput={(e) => setDelaySeconds(e.currentTarget.value)}
                    placeholder={gt("gui.oneShotDelayPlaceholder")}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                  <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.oneShotHint")}</div>
                </div>
              )}

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.sessionLabel")}</label>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="sessionMode"
                      checked={session() === "new"}
                      onChange={() => setSession("new")}
                      style="accent-color:#007acc"
                    />
                        {gt("gui.sessionNew")}
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="sessionMode"
                      checked={session() === "reuse"}
                      onChange={() => setSession("reuse")}
                      style="accent-color:#007acc"
                    />
                        {gt("gui.sessionReuse")}
                  </label>
                  <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                    <input
                      type="radio"
                      name="sessionMode"
                      checked={session() === "last"}
                      onChange={() => setSession("last")}
                      style="accent-color:#007acc"
                    />
                    {gt("gui.sessionContinue")}
                  </label>
                </div>
                {session() === "reuse" && (
                  <div style="margin-top:8px">
                    <label style="display:block;margin-bottom:6px;font-size:11px;color:#8e8e93">{gt("gui.sessionMaxRunsLabel")}</label>
                    <input
                      type="number"
                      min="1"
                      value={sessionMaxRuns() || ""}
                      onInput={(e) => setSessionMaxRuns(e.currentTarget.value)}
                      placeholder={gt("gui.unboundedPlaceholder")}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.sessionMaxRunsHint")}</div>
                  </div>
                )}
              </div>

              {schedulerPlatform() === "win32" && (
                <div style="display:block;width:100%;margin-bottom:12px">
                  <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                    <input
                      type="checkbox"
                      checked={runWhenLoggedOff()}
                      onChange={(e) => setRunWhenLoggedOff(e.currentTarget.checked)}
                      style="accent-color:#007acc;margin-top:3px"
                    />
                    <span>
                      <span style="display:block;font-size:12px;color:#b0b0b0;font-weight:500">
                        {gt("gui.runWhenLoggedOffLabel")}
                      </span>
                      <span
                        style={{
                          display: "block",
                          "font-size": "11px",
                          "margin-top": "4px",
                          color: runWhenLoggedOff() ? "#ffd60a" : "#8e8e93",
                        }}
                      >
                        {gt("gui.runWhenLoggedOffHint")}
                      </span>
                    </span>
                  </label>
                </div>
              )}

              <div
                style={{
                  display: triggerType() !== "cron" ? "none" : "block",
                  width: "100%",
                  marginBottom: "12px",
                }}
              >
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.scheduleLabel")}</label>
                <select
                  value={cronPreset()}
                  onChange={(e) => {
                    const val = e.currentTarget.value
                    setCronPreset(val)
                    if (val !== "__custom__") setSchedule(val)
                  }}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {cronPresets().map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                {showCustomCron && (
                  <div style="display:block;width:100%;margin-top:8px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.cronExprLabel")}</label>
                    <input
                      type="text"
                      value={schedule() || ""}
                      onInput={(e) => setSchedule(e.currentTarget.value)}
                      placeholder="* * * * *"
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                )}
                {cronError() && (
                  <div style="display:block;max-height:80px;overflow-y:auto;margin-top:8px;padding:8px;background:#2a1113;border:1px solid #5a1d21;border-radius:6px;font-size:11px;line-height:1.4;color:#ff6b6b;white-space:pre-wrap;word-break:break-word">{cronError()}</div>
                )}
                <div style="display:block;width:100%;margin-top:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.timezoneLabel")}</label>
                  <input
                    type="text"
                    list="iana-timezones"
                    value={timezone() || ""}
                    onInput={(e) => setTimezone(e.currentTarget.value)}
                    placeholder={gt("gui.timezonePlaceholder")}
                    style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                  />
                  <datalist id="iana-timezones">
                    <option value="Europe/Moscow" />
                    <option value="Europe/London" />
                    <option value="Europe/Berlin" />
                    <option value="America/New_York" />
                    <option value="America/Los_Angeles" />
                    <option value="Asia/Almaty" />
                    <option value="Asia/Tokyo" />
                    <option value="UTC" />
                  </datalist>
                  <div style="display:block;margin-top:6px;font-size:11px;color:#808080">
                    {gt("gui.timezoneHint")}
                  </div>
                </div>
                <div style="display:block;width:100%;margin-top:12px">
                  <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.windowLabel")}</label>
                  <div style="display:flex;gap:8px;align-items:center">
                    <input
                      type="time"
                      value={notBefore() || ""}
                      onInput={(e) => setNotBefore(e.currentTarget.value)}
                      title={gt("gui.windowStartTitle")}
                      style="display:block;flex:1;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                    <span style="color:#808080;font-size:12px">—</span>
                    <input
                      type="time"
                      value={notAfter() || ""}
                      onInput={(e) => setNotAfter(e.currentTarget.value)}
                      title={gt("gui.windowEndTitle")}
                      style="display:block;flex:1;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    />
                  </div>
                  <div style="display:block;margin-top:6px;font-size:11px;color:#808080">
                    {gt("gui.windowHint")}
                  </div>
                  <div style="display:block;margin-top:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.weekdaysLabel")}</label>
                    <div style="display:flex;gap:10px;flex-wrap:wrap">
                      {[
                        { value: 1, day: "gui.weekday.1" },
                        { value: 2, day: "gui.weekday.2" },
                        { value: 3, day: "gui.weekday.3" },
                        { value: 4, day: "gui.weekday.4" },
                        { value: 5, day: "gui.weekday.5" },
                        { value: 6, day: "gui.weekday.6" },
                        { value: 0, day: "gui.weekday.0" },
                      ].map((day) => (
                        <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#d0d0d5">
                          <input
                            type="checkbox"
                            checked={activeDays().includes(day.value)}
                            onChange={(e) => {
                              const next = e.currentTarget.checked
                                ? [...activeDays(), day.value]
                                : activeDays().filter((d) => d !== day.value)
                              setActiveDays([...next].sort((a, b) => a - b))
                            }}
                            style="accent-color:#007acc"
                          />
                          {gt(day.day)}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style="display:block;margin-top:12px">
                    <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.outsideWindowLabel")}</label>
                    <select
                      value={windowPolicy()}
                      onChange={(e) => setWindowPolicy(e.currentTarget.value as "skip" | "postpone" | "run")}
                      style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                    >
                      <option value="postpone">{gt("gui.windowPostpone")}</option>
                      <option value="skip">{gt("gui.windowSkip")}</option>
                      <option value="run">{gt("gui.windowRun")}</option>
                    </select>
                    <div style="display:block;margin-top:6px;font-size:11px;color:#808080">
                      {gt("gui.windowPolicyHint")}
                    </div>
                  </div>
                </div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.promptLabel")}</label>
                <textarea
                  value={prompt() || ""}
                  onInput={(e) => setPrompt(e.currentTarget.value)}
                  placeholder={gt("gui.promptPlaceholder")}
                  rows={2}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none;resize:vertical"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.promptTemplateLabel")}</label>
                <select
                  value={template()}
                  onChange={(e) => selectTemplate(e.currentTarget.value)}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {promptTemplates().map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                  {customTemplates().map((t) => (
                    <option key={t.id} value={`custom:${t.id}`}>{t.name}</option>
                  ))}
                </select>
                {template().startsWith("custom:") && (
                  <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
                    <span style="font-size:10px;color:#8e8e93">{gt("gui.customTemplate")}</span>
                    {customTemplates().map((t) => {
                      if (`custom:${t.id}` !== template()) return null;
                      return (
                        <span key={t.id} style="font-size:11px;color:#ff3b30;font-weight:500;cursor:default">
                          {t.name}
                        </span>
                      );
                    })}
                    <button
                      onClick={() => {
                        const t = customTemplates().find((x) => `custom:${x.id}` === template());
                        if (t) handleDeleteTemplate(t);
                      }}
                      title={gt("gui.deleteTemplateTitle")}
                      style="background:transparent;border:none;color:#ff3b30;cursor:pointer;font-size:14px;line-height:1;padding:0"
                      onMouseEnter={(e) => { e.currentTarget.style.color = "#c92a2a"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "#ff3b30"; }}
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.modelLabel")}</label>
                <input
                  type="text"
                  list="scheduler-model-presets"
                  value={model() || ""}
                  onInput={(e) => setModel(e.currentTarget.value)}
                  placeholder={gt("gui.modelPlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <datalist id="scheduler-model-presets">
                  <option value="anthropic/claude-3-5-sonnet" />
                  <option value="openai/gpt-4o" />
                  <option value="deepseek/deepseek-coder" />
                  <option value="google/gemini-2.5-pro" />
                  <option value="openai/gpt-4o-mini" />
                </datalist>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.modelHint")}</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.priorityLabel")}</label>
                <select
                  value={String(priority())}
                  onChange={(e) => setPriority(Number(e.currentTarget.value) || DEFAULT_PRIORITY)}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                >
                  {priorityOptions().map((p) => (
                    <option key={p.value} value={String(p.value)}>{p.label}</option>
                  ))}
                  {!priorityOptions().some((p) => p.value === priority()) && (
                    <option value={String(priority())}>{gt("gui.otherPriorityOption", { priority: priority() })}</option>
                  )}
                </select>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.priorityHint")}</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.maxRetriesLabel")}</label>
                <input
                  type="number"
                  min="0"
                  value={retryCount()}
                  onInput={(e) => setRetryCount(Number(e.currentTarget.value) || 0)}
                  placeholder="0"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.retryDelayLabel")}</label>
                <input
                  type="number"
                  min="1"
                  value={retryDelay()}
                  onInput={(e) => setRetryDelay(Number(e.currentTarget.value) || 60)}
                  placeholder="60"
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.qualityGateLabel")}</label>
                <input
                  type="text"
                  value={qualityGate() || ""}
                  onInput={(e) => setQualityGate(e.currentTarget.value)}
                  placeholder={gt("gui.qualityGatePlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.qualityGateHint")}</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.preflightLabel")}</label>
                <input
                  type="text"
                  value={beforeScript() || ""}
                  onInput={(e) => setBeforeScript(e.currentTarget.value)}
                  placeholder={gt("gui.preflightPlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.preflightHint")}</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.postflightLabel")}</label>
                <input
                  type="text"
                  value={afterScript() || ""}
                  onInput={(e) => setAfterScript(e.currentTarget.value)}
                  placeholder={gt("gui.postflightPlaceholder")}
                  style="display:block;width:100%;box-sizing:border-box;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;color:#fff;font-size:13px;outline:none"
                />
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.postflightHint")}</div>
              </div>

              <div style="display:block;width:100%;margin-bottom:12px">
                <label style="display:block;margin-bottom:8px;font-size:12px;color:#b0b0b0;font-weight:500">{gt("gui.dependsOnLabel")}</label>
                <div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;background:#1e1e1e;border:1px solid #333;border-radius:6px;min-height:38px;box-sizing:border-box">
                  {dependencyCandidates().length === 0 ? (
                    <span style="font-size:12px;color:#8e8e93">{gt("gui.noOtherTasks")}</span>
                  ) : (
                    dependencyCandidates().map((candidate) => (
                      <label style={`display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:14px;border:1px solid ${dependsOn().includes(candidate) ? "#5ac8fa" : "#333"};background:${dependsOn().includes(candidate) ? "rgba(90,200,250,0.12)" : "transparent"};color:${dependsOn().includes(candidate) ? "#5ac8fa" : "#cfcfd2"};font-size:12px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={dependsOn().includes(candidate)}
                          onChange={(e) => toggleDependsOn(candidate, e.currentTarget.checked)}
                          style="margin:0"
                        />
                        {candidate}
                      </label>
                    ))
                  )}
                </div>
                <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("gui.dependsOnHint")}</div>
              </div>

              {/* Role-scoped tools (Спринт 14): metadata-only, denied имеет приоритет */}
              <details style="display:block;width:100%;margin-bottom:12px">
                <summary style="cursor:pointer;font-size:12px;color:#b0b0b0;font-weight:500;margin-bottom:8px;user-select:none">
                  {gt("gui.toolLimitsHeading")}
                  {(allowedTools().length > 0 || deniedTools().length > 0) && (
                    <span style="color:#5ac8fa;font-size:11px;margin-left:6px">
                      ({allowedTools().length} allowed · {deniedTools().length} denied)
                    </span>
                  )}
                </summary>
                <div style="display:block;width:100%;padding:10px;background:#1e1e1e;border:1px solid #333;border-radius:6px;box-sizing:border-box">
                  <div style="font-size:11px;color:#8e8e93;margin-bottom:8px">
                    {gt("gui.toolLimitsNote")}
                    {gt("gui.toolLimitsDenied")}
                  </div>
                  <div style="font-size:11px;color:#b0b0b0;margin-bottom:4px">{gt("gui.allowedToolsLabel")}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
                    {POPULAR_TOOLS.map((tool) => (
                      <label style={`display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:12px;border:1px solid ${allowedTools().includes(tool) ? "#34c759" : "#333"};background:${allowedTools().includes(tool) ? "rgba(52,199,89,0.12)" : "transparent"};color:${allowedTools().includes(tool) ? "#34c759" : "#cfcfd2"};font-size:11px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={allowedTools().includes(tool)}
                          onChange={() => toggleTool("allowed", tool)}
                          style="margin:0"
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                  <div style="font-size:11px;color:#b0b0b0;margin-bottom:4px">{gt("gui.deniedToolsLabel")}</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
                    {POPULAR_TOOLS.map((tool) => (
                      <label style={`display:flex;align-items:center;gap:5px;padding:4px 9px;border-radius:12px;border:1px solid ${deniedTools().includes(tool) ? "#ff3b30" : "#333"};background:${deniedTools().includes(tool) ? "rgba(255,59,48,0.12)" : "transparent"};color:${deniedTools().includes(tool) ? "#ff3b30" : "#cfcfd2"};font-size:11px;cursor:pointer;user-select:none`}>
                        <input
                          type="checkbox"
                          checked={deniedTools().includes(tool)}
                          onChange={() => toggleTool("denied", tool)}
                          style="margin:0"
                        />
                        {tool}
                      </label>
                    ))}
                  </div>
                  <div style="display:flex;gap:6px">
                    <input
                      type="text"
                      value={customTool()}
                      onInput={(e) => setCustomTool(e.currentTarget.value)}
                      placeholder={gt("gui.toolPlaceholder")}
                      style="flex:1;padding:6px 8px;background:#141414;border:1px solid #333;border-radius:6px;color:#fff;font-size:12px;outline:none"
                    />
                    <button onClick={() => addCustomTool("allowed")} style="padding:6px 10px;background:transparent;border:1px solid #34c759;color:#34c759;border-radius:6px;cursor:pointer;font-size:12px">+ allowed</button>
                    <button onClick={() => addCustomTool("denied")} style="padding:6px 10px;background:transparent;border:1px solid #ff3b30;color:#ff3b30;border-radius:6px;cursor:pointer;font-size:12px">+ denied</button>
                  </div>
                  {(allowedTools().length > 0 || deniedTools().length > 0) && (
                    <div style="font-size:11px;color:#cfcfd2;margin-top:8px">
                      {allowedTools().length > 0 && <div>allowed: [{allowedTools().join(", ")}]</div>}
                      {deniedTools().length > 0 && <div>denied: [{deniedTools().join(", ")}]</div>}
                    </div>
                  )}
                </div>
              </details>

              <div style="display:block;width:100%;margin-top:8px">
                <button
                  onClick={() => {
                    setDryRunName(DRYRUN_FORM_MARKER)
                    const baseTask = {
                      order: 0,
                      trigger: "manual",
                      command: buildFormCommand(),
                      roleScoped:
                        allowedTools().length > 0 || deniedTools().length > 0
                          ? { allowed: allowedTools(), denied: deniedTools() }
                          : null,
                      preFlight: (beforeScript() || "").trim() || null,
                      postFlight: (afterScript() || "").trim() || null,
                      qualityGate: (qualityGate() || "").trim() || null,
                    }
                    const matrixTasks = matrixWorkspaceIds()
                      .map((id) => workspaces().find((w) => w.id === id))
                      .filter((w): w is Workspace => Boolean(w))
                      .map((w, index) => ({
                        ...baseTask,
                        name: matrixClonePreviewName(name(), w.name),
                        order: index,
                        cwd: w.path,
                        matrixParent: name() || gt("gui.noNameFallback"),
                      }))
                    setDryRunReport({
                      tasks: matrixMode()
                        ? matrixTasks
                        : [
                            {
                              ...baseTask,
                              name: name() || gt("gui.noNameFallback"),
                              cwd:
                                selectedWorkspace()?.path ||
                                (workingDirectory() || "").trim() ||
                                gt("gui.projectFolderFallback"),
                            },
                          ],
                      totals: {},
                      warnings: [
                        ...(!name().trim() ? [gt("gui.dryRunNoNameWarning")] : []),
                        ...(matrixMode()
                          ? [
                              gt("gui.dryRunMatrixPreview", { count: matrixTasks.length }),
                            ]
                          : []),
                      ],
                    })
                    setDryRunOpen(true)
                  }}
                  title={gt("gui.dryRunPreviewTitle")}
                  style="display:block;width:100%;padding:8px;margin-top:4px;background:transparent;border:1px solid #333;border-radius:6px;color:#d4e6ff;cursor:pointer;font-size:12px"
                >
                  {gt("gui.dryRunButton")}
                </button>
                <button
                  onClick={handleCreate}
                  disabled={busy() || !canSubmit()}
                  title={!canSubmit() ? validationError() : undefined}
                  style={`display:block;width:100%;padding:10px;margin-top:8px;background:${busy() ? "#666" : "#007acc"};color:white;border-radius:6px;border:none;cursor:${busy() || !canSubmit() ? "not-allowed" : "pointer"};font-size:13px;font-weight:500;opacity:${busy() || !canSubmit() ? 0.6 : 1}`}
                >
                  {busy() ? gt("gui.creating") : isEditing ? gt("gui.save") : gt("gui.createTaskSubmit")}
                </button>
                {isEditing && (
                  <button
                    onClick={() => { setEditingJob(null); setName(""); setSchedule("* * * * *"); setPrompt(""); setModel(""); setPriority(DEFAULT_PRIORITY); setRetryCount(0); setRetryDelay(60); setQualityGate(""); setDependsOn([]); setBeforeScript(""); setAfterScript(""); setTriggerType("cron"); setWatchPath(""); setRunAt(""); setDelaySeconds(""); setSession("new"); setSessionMaxRuns(""); setRunWhenLoggedOff(false); setTimezone(""); setNotBefore(""); setNotAfter(""); setMcpServer(""); setMcpEventName(""); setMcpFilter(""); setWorkingDirectory(""); setWorkspaceId(""); setAllowedTools([]); setDeniedTools([]); resetMatrixForm(); setCronPreset("* * * * *"); setCronError("") }}
                    style="background:transparent;border:1px solid #333;border-radius:6px;padding:8px 16px;color:#ff3b30;cursor:pointer;font-size:13px;width:100%"
                  >
                      {gt("gui.cancel")}
                    </button>
                )}
              </div>

              {dryRunOpen() && dryRunName() === DRYRUN_FORM_MARKER && (
                <div style="display:block;width:100%;margin-top:8px;padding:10px;background:#1e1e1e;border:1px solid #333;border-radius:6px">
                  <div style="font-size:12px;font-weight:600;color:#ffffff;display:flex;justify-content:space-between;align-items:center">
                    {gt("gui.dryRunLocalTitle")}
                    <button onClick={() => closeDryRun()} style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:14px;padding:0">✕</button>
                  </div>
                  {(() => {
                    const r: any = dryRunReport()
                    if (!r) return null
                    const t = r.tasks?.[0]
                    return (
                      <div style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#e0e0e0;margin-top:6px">
                        <div style="overflow-wrap:anywhere">$ {t?.command}</div>
                        <div style="color:#8e8e93">cwd: {t?.cwd}</div>
                        {t?.roleScoped && (
                          <div style="color:#8e8e93">
                            🔒 allowed=[{(t.roleScoped.allowed ?? []).join(", ")}] · denied=[{(t.roleScoped.denied ?? []).join(", ")}]
                          </div>
                        )}
                        {t?.preFlight && <div style="color:#8e8e93">⚡ pre: {t.preFlight}</div>}
                        {t?.postFlight && <div style="color:#8e8e93">⚡ post: {t.postFlight}</div>}
                        {t?.qualityGate && <div style="color:#8e8e93">✅ QG: {t.qualityGate}</div>}
                        {Array.isArray(r.warnings) && r.warnings.length > 0 && (
                          <div style="color:#f5a623">⚠ {r.warnings.join(" | ")}</div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
            )}

            {/* Список задач */}
            <div style="display:block;width:100%;margin-top:24px">
              <h3 style="margin:0;margin-bottom:8px;font-size:14px;font-weight:600;color:#ffffff">{gt("gui.tasksHeading")}</h3>
              {workspaceFilter() !== "all" && (
                <div style="font-size:11px;color:#8e8e93;margin-bottom:8px">
                  {gt("gui.filterSummary", { scope: workspaceFilter() === "none" ? gt("gui.workspaceNone") : `📦 ${workspaces().find((w) => w.id === workspaceFilter())?.name ?? "workspace"}`, visible: visibleJobs().length, total: jobsArr().length })}
                </div>
              )}
              {visibleJobs().length === 0 ?
                <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 16px;color:#a0a0a6;font-size:13px;gap:10px">
                  <span style="font-size:40px;line-height:1">{winterMode() ? "🎄" : "📅"}</span>
                  <span style="max-width:380px;line-height:1.5">
                    {winterMode()
                      ? gt("gui.emptyWinter")
                      : gt("gui.emptyNormal")}
                  </span>
                </div>
              :
                <div style="display:flex;flex-direction:column;gap:0">
                  {visibleJobs().map(job => <JobCard key={job.name} job={job} />)}
                </div>
              }
            </div>

            {/* Модальный текстовый ввод (замена неработающего в Electron window.prompt) */}
            {promptOpen() && (
              <div
                style="position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:2000;padding:20px"
                onClick={() => answerPrompt(null)}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style="width:min(540px,100%);background:#1e1e1e;border:1px solid #444;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,0.6)"
                >
                  <div style="font-size:13px;font-weight:600;color:#e0e0e0;white-space:pre-wrap">{promptTitle()}</div>
                  {promptTitle().includes("KEY=VALUE") ? (
                    <textarea
                      autofocus
                      rows={6}
                      value={promptValue()}
                      onInput={(e) => setPromptValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") answerPrompt(null)
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          answerPrompt(promptValue())
                        }
                        e.stopPropagation()
                      }}
                      style="width:100%;box-sizing:border-box;resize:vertical;padding:8px 10px;border-radius:8px;border:1px solid #3a3a3a;background:#141414;color:#e0e0e0;font-family:Menlo, Monaco, 'Courier New', monospace;font-size:12px;outline:none"
                    />
                  ) : (
                    <input
                      autofocus
                      value={promptValue()}
                      onInput={(e) => setPromptValue(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") answerPrompt(null)
                        if (e.key === "Enter") {
                          e.preventDefault()
                          answerPrompt(promptValue())
                        }
                        e.stopPropagation()
                      }}
                      style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #3a3a3a;background:#141414;color:#e0e0e0;font-size:13px;outline:none"
                    />
                  )}
                  <div style="display:flex;justify-content:flex-end;gap:8px">
                    <button
                      onClick={() => answerPrompt(null)}
                      style="padding:6px 14px;border-radius:6px;border:1px solid #3a3a3a;background:#262626;color:#e0e0e0;font-size:12px;cursor:pointer"
                    >
                      {gt("gui.cancel")}
                    </button>
                    <button
                      onClick={() => answerPrompt(promptValue())}
                      style="padding:6px 14px;border-radius:6px;border:1px solid #0a84ff;background:#0a84ff;color:#fff;font-size:12px;font-weight:600;cursor:pointer"
                    >
                      {gt("gui.ok")}
                    </button>
                  </div>
                  {promptTitle().includes("KEY=VALUE") && (
                    <div style="font-size:11px;color:#8e8e93">{gt("gui.modalShortcutHint")}</div>
                  )}
                </div>
              </div>
            )}

            {/* Панель логов */}
            {logsTask() && (
              <div style="position:fixed;bottom:16px;left:16px;right:16px;background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:0;max-height:300px;overflow:hidden;display:flex;flex-direction:column;z-index:1000">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #333;background:#252526;border-radius:8px 8px 0 0">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:13px;font-weight:600;color:#ffffff">{gt("gui.logsHeading")}</span>
                    <span style="font-size:11px;color:#8e8e93">{logsTask()}</span>
                  </div>
                  <button
                    onClick={() => { setLogsTask(null); setLogs("") }}
                    style="background:transparent;border:none;color:#8e8e93;cursor:pointer;font-size:18px;line-height:1;padding:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center"
                    onMouseEnter={(e) => { (e.target as HTMLButtonElement).style.color = "#ff3b30" }}
                    onMouseLeave={(e) => { (e.target as HTMLButtonElement).style.color = "#8e8e93" }}
                  >
                    ✕
                  </button>
                </div>
                <div style="flex:1;overflow-y:auto;padding:12px;font-family:Menlo, Monaco, 'Courier New', monospace;font-size:11px;line-height:1.5;color:#d4d4d4;background:#1e1e1e;border-radius:0 0 8px 8px">
                  {logs().split("\n").map((line, i) => (
                    <div key={i} style="white-space:pre-wrap;margin-bottom:2px">{line}</div>
                  ))}
                </div>
              </div>
            )}
            {/* Мастер настройки триажа (Спринт 31.4) */}
            {wizardOpen() && (
              <div style="position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6)">
                <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;width:560px;max-width:92vw;max-height:92vh;overflow:hidden;display:flex;flex-direction:column;color:#e0e0e0;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">
                  <div style="padding:16px 20px;border-bottom:1px solid #333;display:flex;justify-content:space-between;align-items:center">
                    <div style="font-size:16px;font-weight:600">{wizardStep() === 1 ? gt("localAi.wizard.screen1.title") : wizardStep() === 2 ? gt("localAi.wizard.screen2.title") : gt("localAi.wizard.screen3.title")}</div>
                    <button onClick={() => setWizardOpen(false)} style="background:none;border:none;color:#8e8e93;cursor:pointer;font-size:18px;padding:0">✕</button>
                  </div>
                  <div style="padding:16px 20px;overflow-y:auto">
                    {wizardStep() === 1 && (
                      <div style="display:flex;flex-direction:column;gap:12px">
                        <div style="font-size:13px;color:#b0b0b0">{gt("localAi.wizard.screen1.desc")}</div>
                        <div style="font-size:12px;font-weight:500;color:#e0e0e0;margin-top:4px">{gt("localAi.wizard.screen1.provider")}</div>
                        <div style="display:flex;gap:10px">
                          <button
                            onClick={() => {
                              setWizardProvider("ollama")
                              setWizardBaseUrl("http://127.0.0.1:11434")
                              setWizardError("")
                            }}
                            style={`flex:1;padding:8px 12px;background:${wizardProvider() === "ollama" ? "#007acc" : "#2a2a2a"};border:1px solid ${wizardProvider() === "ollama" ? "#007acc" : "#333"};border-radius:6px;color:#fff;cursor:pointer;font-size:12px`}
                          >
                            {gt("localAi.wizard.screen1.provider.ollama")}
                          </button>
                          <button
                            onClick={() => {
                              setWizardProvider("openai")
                              setWizardBaseUrl("")
                              setWizardError("")
                            }}
                            style={`flex:1;padding:8px 12px;background:${wizardProvider() === "openai" ? "#007acc" : "#2a2a2a"};border:1px solid ${wizardProvider() === "openai" ? "#007acc" : "#333"};border-radius:6px;color:#fff;cursor:pointer;font-size:12px`}
                          >
                            {gt("localAi.wizard.screen1.provider.openai")}
                          </button>
                        </div>
                        <div style="font-size:12px;font-weight:500;color:#e0e0e0;margin-top:8px">{gt("localAi.wizard.screen1.baseUrl")}</div>
                        <input
                          type="text"
                          value={wizardBaseUrl()}
                          placeholder={gt("localAi.wizard.screen1.baseUrlDesc")}
                          onInput={(e) => { setWizardBaseUrl(e.currentTarget.value); setWizardError("") }}
                          style="width:100%;padding:6px 8px;background:#0f0f0f;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px"
                        />
                        <div style="font-size:11px;color:#8e8e93;margin-top:2px">{gt("localAi.wizard.screen1.baseUrlHint")}</div>
                        <div style="font-size:12px;font-weight:500;color:#e0e0e0;margin-top:8px">{gt("localAi.wizard.screen1.model")}</div>
                        <input
                          type="text"
                          value={wizardModel()}
                          placeholder={gt("localAi.wizard.screen1.modelDesc")}
                          onInput={(e) => setWizardModel(e.currentTarget.value)}
                          style="width:100%;padding:6px 8px;background:#0f0f0f;border:1px solid #333;border-radius:4px;color:#fff;font-size:12px"
                        />
                        <div style="font-size:11px;color:#8e8e93;margin-top:6px">{gt("localAi.wizard.screen1.consequence")}</div>
                      </div>
                    )}
                    {wizardStep() === 2 && (
                      <div style="display:flex;flex-direction:column;gap:12px">
                        <div style="font-size:13px;color:#b0b0b0">{gt("localAi.wizard.screen2.desc")}</div>
                        <button
                          onClick={() => setWizardPreset("minimal")}
                          style={`flex:1;padding:14px 16px;background:${wizardPreset() === "minimal" ? "#007acc" : "#2a2a2a"};border:1px solid ${wizardPreset() === "minimal" ? "#007acc" : "#333"};border-radius:6px;color:#fff;cursor:pointer;text-align:left;font-size:13px`}
                        >
                          <div style="font-weight:600">{gt("localAi.wizard.screen2.preset.minimal")}</div>
                          <div style="font-size:11px;color:#b0b0b0;margin-top:4px">{gt("localAi.wizard.screen2.preset.minimal.desc")}</div>
                        </button>
                        <button
                          onClick={() => setWizardPreset("recommended")}
                          style={`flex:1;padding:14px 16px;background:${wizardPreset() === "recommended" ? "#007acc" : "#2a2a2a"};border:1px solid ${wizardPreset() === "recommended" ? "#007acc" : "#333"};border-radius:6px;color:#fff;cursor:pointer;text-align:left;font-size:13px`}
                        >
                          <div style="font-weight:600">{gt("localAi.wizard.screen2.preset.recommended")}</div>
                          <div style="font-size:11px;color:#b0b0b0;margin-top:4px">{gt("localAi.wizard.screen2.preset.recommended.desc")}</div>
                        </button>
                      </div>
                    )}
                    {wizardStep() === 3 && (
                      <div style="display:flex;flex-direction:column;gap:12px">
                        <div style="font-size:13px;color:#b0b0b0">{gt("localAi.wizard.screen3.desc")}</div>
                        <div style="font-size:12px;font-weight:500;color:#e0e0e0">{gt("localAi.wizard.screen3.ruleOrder")}</div>
                        <div style="background:#0f0f0f;border:1px solid #333;border-radius:6px;padding:10px;font-size:11px;color:#b0b0b0;line-height:1.6">
                          <div>{gt("localAi.wizard.rule.errorTimeout")}</div>
                          <div>{gt("localAi.wizard.rule.errorPermission")}</div>
                          <div>{gt("localAi.wizard.rule.errorNetwork")}</div>
                          <div>{gt("localAi.wizard.rule.errorQuality")}</div>
                          <div>{gt("localAi.wizard.rule.costHigh")}</div>
                          <div>{gt("localAi.wizard.rule.taskImportant")}</div>
                          <div>{gt("localAi.wizard.rule.statusError")}</div>
                          <div>{gt("localAi.wizard.rule.statusSuccess")}</div>
                        </div>
                        <div style="font-size:12px;font-weight:500;color:#e0e0e0;margin-top:8px">{gt("localAi.wizard.screen3.confidenceThreshold")}</div>
                        <div style="font-size:11px;color:#8e8e93">{gt("localAi.wizard.screen3.confidenceHint")}</div>
                      </div>
                    )}
                    {wizardError() && (
                      <div style="margin-top:10px;font-size:11px;color:#ff6b6b">{wizardError()}</div>
                    )}
                  </div>
                  <div style="padding:12px 20px;border-top:1px solid #333;display:flex;justify-content:space-between;gap:8px">
                    {wizardStep() > 1 && (
                      <button
                        onClick={() => setWizardStep((s) => s - 1)}
                        style="padding:6px 16px;background:#2a2a2a;border:1px solid #333;border-radius:4px;color:#b0b0b0;cursor:pointer;font-size:12px"
                      >
                        {gt("localAi.wizard.back")}
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        setWizardError("")
                        if (wizardStep() === 1) {
                          if (!wizardModel().trim()) {
                            setWizardError(gt("localAi.wizard.screen1.modelRequired"))
                            return
                          }
                          if (wizardProvider() === "openai" && !wizardBaseUrl().trim()) {
                            setWizardError(gt("localAi.wizard.screen1.baseUrlRequired"))
                            return
                          }
                          setWizardStep(2)
                        } else if (wizardStep() === 2) {
                          if (!wizardPreset()) return
                          setWizardStep(3)
                        } else {
                          // Apply settings
                          const mode = wizardPreset() === "minimal" ? "rules" : "auto"
                          const baseUrl = wizardProvider() === "ollama"
                            ? wizardBaseUrl().trim() || "http://127.0.0.1:11434"
                            : wizardBaseUrl().trim().replace(/\/+$/, "")
                          const model = wizardModel().trim()
                          const saved = await persistSettings({
                            notifications: {
                              triage: {
                                mode,
                                baseUrl,
                                model,
                                timeoutMs: 60000,
                                fallback: "rules",
                                confidenceThreshold: 0.7,
                                shadow: { enabled: false, days: 14, startedAt: null },
                              },
                            },
                          })
                          if (!saved) {
                            setWizardError(gt("localAi.wizard.saveFailed"))
                            return
                          }
                          setLocalAiMode(mode)
                          setLocalAiBaseUrl(baseUrl)
                          setLocalAiModel(model)
                          setLocalAiTimeoutMs(60000)
                          setLocalAiThreshold(0.7)
                          setLocalAiFallback("rules")
                          setLocalAiState("idle")
                          setLocalAiResult(null)
                          setShadowEnabled(false)
                          setWizardOpen(false)
                        }
                      }}
                      style={`padding:6px 16px;background:#007acc;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;font-weight:500`}
                    >
                      {wizardStep() === 3 ? gt("localAi.wizard.finish") : gt("localAi.wizard.next")}
                    </button>
                  </div>
                </div>
              </div>
            )}
            </div>
          </ErrorBoundary>
        ),
      })
    } catch (err: any) {
      // Error boundary: если рендеринг падает, выводим сообщение вместо исчезновения панели
      console.error("GUI render error:", err)
      return ctx.add(Panel, {
        id: "scheduler-jobs",
        region: "side",
        list: () => [{ id: "jobs", title: gt("gui.jobsTitle"), pinned: true }],
        render: () => (
          <ErrorBoundary fallback={(err: any) => (
            <div style="padding:16px;color:#ff3b30;font-size:13px">
              {gt("gui.uiError", { message: err.message })}
            </div>
          )}>
            <div style="padding:16px;display:flex;flex-direction:column;gap:16px;font-size:13px;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;color:#e0e0e0;background:#0f0f0f">
            <h2 style="margin:0;font-size:22px;font-weight:800;color:#ffffff">{schedulerTitle()}</h2>
            <div style="margin-top:5px;font-size:11px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:#8e8e93">Local AI CI/CD Orchestrator</div>
            <div style="background:#2a1a1a;border:1px solid #ff3b30;border-radius:8px;padding:16px;color:#ff3b30">
              {gt("gui.errorBoundaryDetail")}
            </div>
            </div>
          </ErrorBoundary>
        ),
      })
    }
  },
})
