import { Rpc } from "@opencode/plugin/rpc";

/**
 * Общее определение RPC-контракта между серверной частью плагина (src/index.ts)
 * и GUI-панелью (src/gui.tsx).
 *
 * Сервер регистрирует обработчики через ctx.rpc.register(SchedulerRpc, handlers).
 * GUI вызывает методы через ctx.client.rpc(SchedulerRpc).<имя>(аргументы).
 *
 * Схемы ввода/вывода — чистый JSON Schema (не Zod), чтобы сервер мог
 * надёжно кодировать/декодировать ответы через RPC-мост.
 */

/** Параметры MCP-события (triggerType === "mcp-event"). */
const McpEventSchema = {
  type: ["object", "null"] as const,
  properties: {
    server: { type: "string" },
    event: { type: "string" },
    filter: { type: "string" },
  },
  required: ["server", "event"],
} as const;

/** EX-1.1: транспорт исполнения задачи/миссии (fail-open на local). */
const RunnerSchema = {
  type: ["object", "null"] as const,
  properties: {
    kind: { type: ["string", "null"], enum: ["local", "docker", "ssh", null] },
    image: { type: ["string", "null"] },
    host: { type: ["string", "null"] },
    user: { type: ["string", "null"] },
    optOut: { type: ["boolean", "null"] },
  },
} as const;

/** Настройки matrix (fan-out, Спринт 15). */
const MatrixSchema = {
  type: ["object", "null"] as const,
  properties: {
    workspaceIds: { type: "array", items: { type: "string" } },
    strategy: { type: ["string", "null"] },
    failureMode: { type: ["string", "null"] },
    aggregation: { type: ["string", "null"] },
    createAggregator: { type: ["boolean", "null"] },
    /** Лимит одновременных клонов матрицы (Спринт 17). */
    concurrency: { type: ["number", "null"] },
    /** Per-workspace переопределения промпта/модели/хуков/QG (Спринт 17). */
    overrides: {
      type: ["object", "null"],
      additionalProperties: {
        type: "object",
        properties: {
          prompt: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          qualityGate: { type: ["string", "null"] },
          beforeScript: { type: ["string", "null"] },
          afterScript: { type: ["string", "null"] },
        },
      },
    },
  },
  required: ["workspaceIds"],
} as const;

/** Запись задачи, возвращаемая get_tasks. */
const TaskItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    schedule: { type: "string" },
    /** Hotfix 1.5.3.1: лимит времени задачи в секундах (null - по умолчанию). */
    timeoutSeconds: { type: ["number", "null"] },
    status: { type: "string" },
    nextRun: { type: ["string", "null"] },
    /** LLM-модель задачи (null — модель OpenCode по умолчанию). */
    model: { type: ["string", "null"] },
    /** Приоритет задачи 0..10 (10 — наивысший). */
    priority: { type: ["number", "null"] },
    /** Количество повторов при ошибке (опционально). */
    retryCount: { type: ["number", "null"] },
    /** Задержка перед повтором в секундах (опционально). */
    retryDelay: { type: ["number", "null"] },
    /** Проверочная команда после успешного ответа ИИ. */
    qualityGate: { type: ["string", "null"] },
    /** Задача, запускаемая при успехе. */
    nextTaskOnSuccess: { type: ["string", "null"] },
    /** Компенсирующая задача, запускаемая при ошибке. */
    nextTaskOnError: { type: ["string", "null"] },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Промпт задачи (для заполнения формы редактирования). */
    prompt: { type: "string" },
    /** Pre-flight команда (null — не задана). */
    beforeScript: { type: ["string", "null"] },
    /** Post-flight команда (null — не задана). */
    afterScript: { type: ["string", "null"] },
    /** Тип триггера: "cron" (по умолчанию), "file", "mcp-event" или "once". */
    triggerType: { type: ["string", "null"] },
    /** Время разового запуска (triggerType === "once"), ISO-8601; null для остальных. */
    runAt: { type: ["string", "null"] },
    /** Режим сессии OpenCode (Спринт 24): "new" (по умолчанию), "reuse" (--session), "last" (--continue). */
    session: { type: ["string", "null"] },
    /** Идентификатор переиспользуемой сессии (только для session === "reuse"); null для остальных. */
    sessionId: { type: ["string", "null"] },
    /** Сколько запусков переживает reuse-сессия до ротации; null — без ограничения. */
    sessionMaxRuns: { type: ["number", "null"] },
    /** Параметры MCP-события (null — не MCP-триггер). */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: ["string", "null"] },
    /** IANA-часовой пояс задачи (Спринт 19; null — системный). */
    timezone: { type: ["string", "null"] },
    /** Начало окна запуска "HH:MM" (null — без окна). */
    notBefore: { type: ["string", "null"] },
    /** Конец окна запуска "HH:MM" (null — без окна). */
    notAfter: { type: ["string", "null"] },
    /** Спринт 27: разрешённые дни недели 0=Вс..6=Сб (null — все дни). */
    activeDays: {
      type: ["array", "null"],
      items: { type: "number" },
    },
    /** Поведение вне окна: skip, postpone или run (null — postpone). */
    windowPolicy: { type: ["string", "null"] },
    /** Glob-маски файлового триггера (null — без ограничения). */
    watchGlobs: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    /** Glob-маски исключений файлового триггера. */
    watchIgnore: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    /** Git-триггер: фильтр ветки (glob, через запятую). */
    gitBranch: { type: ["string", "null"] },
    /** Git-триггер: маски путей, изменения в которых запускают задачу. */
    gitPaths: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    /** Git-триггер: маски игнорируемых путей. */
    gitIgnore: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    /** Git-триггер: период опроса в секундах (null — 60). */
    gitPollSeconds: { type: ["number", "null"] },
    /** Пауза до даты в ISO (null — автопродолжение не запланировано). */
    pausedUntil: { type: ["string", "null"] },
    /** Рабочая директория задачи (null — папка проекта по умолчанию). */
    workingDirectory: { type: ["string", "null"] },
    /** Привязка к multi-repo workspace (null — без workspace). */
    workspaceId: { type: ["string", "null"] },
    /** Имя workspace для отображения (null — без workspace). */
    workspaceName: { type: ["string", "null"] },
    /** Цвет маркера workspace. */
    workspaceColor: { type: ["string", "null"] },
    /** Белый список инструментов задачи (role-scoped, null — без ограничений). */
    allowedTools: { type: ["array", "null"], items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: ["array", "null"], items: { type: "string" } },
    /** Matrix-настройки родителя (null — обычная задача). */
    matrix: MatrixSchema,
    /** Для клона матрицы — имя родителя (null — не клон). */
    matrixParentId: { type: ["string", "null"] },
    /** true — задача является родителем матрицы. */
    isMatrixParent: { type: "boolean" },
    /** true — задача поставлена на паузу (disabled в планировщике ОС). */
    paused: { type: "boolean" },
    /** true — определение есть в БД, но задачи нет в планировщике ОС. */
    orphaned: { type: "boolean" },
    /** Всего запусков именно этой задачи. */
    runsTotal: { type: "number" },
    /** Успешных запусков этой задачи. */
    runsSuccess: { type: "number" },
    /** Ошибок и таймаутов этой задачи. */
    runsError: { type: "number" },
    /** Частичных выполнений этой задачи (partial). */
    runsPartial: { type: "number" },
    /** Агрегат по клонам для родителя (null — не матрица). */
    matrixSummary: {
      type: ["object", "null"],
      properties: {
        totalCount: { type: "number" },
        successCount: { type: "number" },
        errorCount: { type: "number" },
        pendingCount: { type: "number" },
        status: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  required: ["name", "schedule", "status"],
} as const;

const GetTasksInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetTasksOutput = {
  type: "object" as const,
  properties: {
    tasks: {
      type: "array",
      items: TaskItem,
    },
  },
  required: ["tasks"],
} as const;

const CreateTaskInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    schedule: { type: "string" },
    prompt: { type: "string" },
    /** LLM-модель (например, anthropic/claude-3-5-sonnet). */
    model: { type: "string" },
    /** Приоритет задачи 0..10 (10 — наивысший). */
    priority: { type: "number" },
    /** Сколько раз повторять при ошибке (по умолчанию 0). */
    retryCount: { type: "number" },
    /** Задержка перед повтором в секундах (по умолчанию 60). */
    retryDelay: { type: "number" },
    /** Проверочная команда (Quality Gate), выполняется после успешного ответа ИИ. */
    qualityGate: { type: "string" },
    /** Имя задачи, запускаемой при успехе. */
    nextTaskOnSuccess: { type: "string" },
    /** Имя компенсирующей задачи, запускаемой при ошибке. */
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Команда перед запуском (pre-flight). */
    beforeScript: { type: "string" },
    /** Команда после запуска (post-flight). */
    afterScript: { type: "string" },
    /** Тип триггера: "cron" (по умолчанию; нужен schedule), "file", "mcp-event" или "once" (нужен runAt либо delaySeconds). */
    triggerType: { type: "string" },
    /** Время разового запуска (triggerType === "once"), ISO-8601. Взаимоисключает schedule/newSchedule. */
    runAt: { type: "string" },
    /** Отложенный разовый запуск через N секунд (triggerType === "once"). Взаимоисключает runAt. */
    delaySeconds: { type: "number" },
    /** Режим сессии OpenCode (Спринт 24): "new" (по умолчанию), "reuse" (--session <id>), "last" (--continue). sessionId генерируется плагином. */
    session: { type: "string" },
    /** Сколько запусков переживает reuse-сессия до ротации (удаление и чистый старт). 0/не задано — без ограничения. */
    sessionMaxRuns: { type: "number" },
    /** Параметры MCP-события. */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: "string" },
    /** Привязка к multi-repo workspace. */
    workspaceId: { type: "string" },
    /** Рабочая директория задачи (по умолчанию — папка проекта). */
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped, enforced through OPENCODE_CONFIG_CONTENT). Пустой массив запрещён. */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools и политикой). Enforced. */
    deniedTools: { type: "array", items: { type: "string" } },
    /** Matrix (fan-out): раскладывает задачу-шаблон на клоны по workspace. */
    matrix: MatrixSchema,
    /** IANA-часовой пояс задачи (например, Europe/Moscow). Пусто — системный. */
    timezone: { type: "string" },
    /** Начало окна запуска "HH:MM"; вне окна запуск переносится. */
    notBefore: { type: "string" },
    /** Конец окна запуска "HH:MM"; может быть меньше notBefore (через полночь). */
    notAfter: { type: "string" },
    /** Спринт 27: разрешённые дни недели 0=Вс..6=Сб. Пусто — все дни. */
    activeDays: { type: "array", items: { type: "number" } },
    /** Поведение вне окна/дня: postpone (по умолчанию), skip или run. */
    windowPolicy: { type: "string" },
    /** Glob-маски файлового триггера (например, src/** и *.md). */
    watchGlobs: { type: "array", items: { type: "string" } },
    /** Glob-маски исключений файлового триггера. */
    watchIgnore: { type: "array", items: { type: "string" } },
    /** Git-триггер: ветка или glob (main, release/*), через запятую. */
    gitBranch: { type: "string" },
    /** Git-триггер: маски изменённых файлов, при которых задача запускается. */
    gitPaths: { type: "array", items: { type: "string" } },
    /** Git-триггер: маски изменённых файлов, которые игнорируются. */
    gitIgnore: { type: "array", items: { type: "string" } },
    /** Git-триггер: период опроса в секундах (минимум 5, по умолчанию 60). */
    gitPollSeconds: { type: "number" },
    /** EX-1.1: транспорт исполнения; неполная конфигурация → local. */
    runner: RunnerSchema,
  },
  required: ["name", "prompt"],
} as const;

const CreateTaskOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

const NameOnly = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
} as const;

const DeleteTaskInput = NameOnly;
const RunTaskInput = NameOnly;

const DeleteTaskOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

const RunTaskOutput = DeleteTaskOutput;

const RunMissionInput = {
  type: "object" as const,
  properties: {
    prompt: { type: "string" },
    cwd: { type: "string" },
    taskName: { type: "string" },
    taskType: { type: "string" },
    model: { type: "string" },
    session: { type: "string", enum: ["new", "reuse", "last"] },
    sessionId: { type: "string" },
    timeoutSeconds: { type: "number" },
    gate: { type: "string" },
    gateTimeoutSeconds: { type: "number" },
    policy: { type: "string", enum: ["hybrid", "secure", "legacy"] },
    allowedTools: { type: "array", items: { type: "string" } },
    deniedTools: { type: "array", items: { type: "string" } },
    dryRun: { type: "boolean" },
    /** EX-1.1: транспорт исполнения миссии; неполная конфигурация → local. */
    runner: RunnerSchema,
  },
  required: ["prompt"],
} as const;

const RunMissionOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    dryRun: { type: "boolean" },
    runId: { type: "string" },
    status: { type: "string" },
    description: { type: "string" },
    error: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepName: { type: "string" },
          taskType: { type: "string" },
          target: { type: "string" },
          status: { type: "string" },
          attempt: { type: "number" },
          error: { type: "string" },
        },
      },
    },
  },
  required: ["success", "dryRun", "status", "description"],
} as const;

const GetTaskLogsInput = NameOnly;

const GetTaskLogsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    logs: { type: "string" },
    error: { type: "string" },
  },
  required: ["success", "logs"],
} as const;

const HistoryRecord = {
  type: "object" as const,
  properties: {
    taskName: { type: "string" },
    status: { type: "string" },
    startedAt: { type: "string" },
    finishedAt: { type: "string" },
    durationMs: { type: "number" },
    error: { type: ["string", "null"] },
    nextTask: { type: ["string", "null"] },
    /** LLM-модель, использованная в запуске. */
    model: { type: ["string", "null"] },
    /** Итог pre-flight: success / error / skipped. */
    preFlightStatus: { type: ["string", "null"] },
    /** Итог post-flight: success / error / skipped. */
    postFlightStatus: { type: ["string", "null"] },
    /** Ограничения инструментов, действовавшие на момент запуска. */
    allowedTools: { type: ["array", "null"], items: { type: "string" } },
    deniedTools: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["taskName", "status", "startedAt", "finishedAt", "durationMs", "error"],
} as const;

const GetHistoryInput = {
  type: "object" as const,
  properties: {
    /** Сколько последних записей вернуть (по умолчанию 20, максимум 200). */
    limit: { type: "number" },
    /** QA-HIST-PAGE: пропустить N самых свежих записей (пагинация). */
    offset: { type: "number" },
    /** Фильтр по имени задачи (регистр не важен). */
    taskName: { type: "string" },
    /** Фильтр по статусу: success | error | partial | running | timeout. */
    status: { type: "string" },
  },
  additionalProperties: false,
} as const;

const GetHistoryOutput = {
  type: "object" as const,
  properties: {
    records: {
      type: "array",
      items: HistoryRecord,
    },
    /** QA-HIST-PAGE: полное число записей под фильтром (без учёта лимита). */
    total: { type: "number" },
    offset: { type: "number" },
    hasMore: { type: "boolean" },
    truncated: { type: "boolean" },
  },
  required: ["records"],
} as const;

const Metrics = {
  type: "object" as const,
  properties: {
    total: { type: "number" },
    success: { type: "number" },
    error: { type: "number" },
    // T-7.3: KPI токен-эффективности (необязательное поле для старых клиентов).
    tokenEfficiency: {
      type: "object" as const,
      properties: {
        score: { type: "number" },
        runs: { type: "number" },
        usefulRuns: { type: "number" },
        totalTokens: { type: "number" },
        wastedTokens: { type: "number" },
      },
    },
  },
  required: ["total", "success", "error"],
} as const;

const GetMetricsInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetMetricsOutput = Metrics;

const GetDashboardPortInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetDashboardPortOutput = {
  type: "object" as const,
  properties: {
    /** Фактический порт дашборда (null, если сервер ещё не поднялся). */
    port: { type: ["number", "null"] },
  },
  required: ["port"],
} as const;

const GetPlatformInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetPlatformOutput = {
  type: "object" as const,
  properties: {
    /** process.platform: 'win32' | 'darwin' | 'linux' | ... */
    platform: { type: "string" },
    /** Название планировщика для заголовка GUI. */
    title: { type: "string" },
    /** DEEP-3.2: само-диагностика загруженной копии (как в get_dashboard_info). */
    plugin: { type: ["object", "null"] },
    /** DEEP-3.2: структурированное предупреждение о рассинхроне установки. */
    installationWarning: { type: ["object", "null"] },
  },
  required: ["platform", "title"],
} as const;

const ExportTasksInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const ExportTasksOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    data: { type: "string" },
    count: { type: "number" },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const ImportTasksInput = {
  type: "object" as const,
  properties: {
    data: { type: "string" },
  },
  required: ["data"],
} as const;

const ImportTasksOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    imported: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

/** BN-7: онлайн-бэкап/восстановление БД (дублируются MCP-инструментами). */
const BackupDbInput = {
  type: "object" as const,
  properties: {
    file: { type: "string" },
  },
  additionalProperties: false,
} as const;

const BackupDbOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    file: { type: "string" },
    bytes: { type: "number" },
    sha256: { type: "string" },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const RestoreDbInput = {
  type: "object" as const,
  properties: {
    file: { type: "string" },
    sha256: { type: "string" },
  },
  required: ["file"],
  additionalProperties: false,
} as const;

const RestoreDbOutput = BackupDbOutput;

const GetSettingsInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

/** Настройки уведомлений: webhook, шаблоны, фильтры, матрицы и дайджест (Спринт 20). */
const NotificationSettingsSchema = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" },
    onlyOnError: { type: "boolean" },
    webhook: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        url: { type: "string" },
        timeoutMs: { type: "number" },
        retryCount: { type: "number" },
        retryDelayMs: { type: "number" },
      },
      required: ["enabled", "url"],
    },
    templates: {
      type: "object" as const,
      properties: {
        success: { type: "string" },
        error: { type: "string" },
      },
      required: ["success", "error"],
    },
    filters: {
      type: "object" as const,
      properties: {
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
      },
      required: ["include", "exclude"],
    },
    telegram: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        botToken: { type: "string" },
        chatId: { type: "string" },
        parseMode: {
          type: "string",
          enum: ["", "HTML", "Markdown", "MarkdownV2"],
        },
        disableNotification: { type: "boolean" },
        messageThreadId: { type: ["number", "null"] },
        includeDashboardLink: { type: "boolean" },
        apiBase: { type: "string" },
      },
      required: ["enabled"],
    },
    native: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        sound: { type: "boolean" },
      },
      required: ["enabled"],
    },
    quietHours: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["enabled", "from", "to"],
    },
    dashboardUrl: { type: "string" },
    matrix: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        onPartial: { type: "boolean" },
        onAllFailed: { type: "boolean" },
        stuckAfterMinutes: { type: "number" },
      },
      required: ["enabled", "onPartial", "onAllFailed", "stuckAfterMinutes"],
    },
    digest: {
      type: "object" as const,
      properties: {
        enabled: { type: "boolean" },
        frequency: { type: "string", enum: ["daily", "weekly"] },
        time: { type: "string" },
        lastSentAt: { type: ["string", "null"] },
      },
      required: ["enabled", "frequency", "time"],
    },
    triage: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["off", "rules", "llm", "auto"] },
        baseUrl: { type: "string" },
        model: { type: "string" },
        timeoutMs: { type: "number" },
        fallback: { type: "string", enum: ["rules", "notify", "skip"] },
        confidenceThreshold: { type: "number" },
        rules: {
          type: "array",
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" },
              field: {
                type: "string",
                enum: ["status", "task", "error", "cost"],
              },
              operator: {
                type: "string",
                enum: ["equals", "contains", "regex", "gt", "lt", "gte", "lte"],
              },
              value: { type: ["string", "number"] },
              category: {
                type: "string",
                enum: ["quality", "timeout", "permission", "network", "unknown"],
              },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              confidence: { type: "number" },
              action: { type: "string", enum: ["notify", "skip"] },
              reason: { type: "string" },
              priority: { type: "number" },
            },
            required: ["field", "operator", "value"],
          },
        },
        shadow: {
          type: "object" as const,
          properties: {
            enabled: { type: "boolean" },
            days: { type: "number" },
            startedAt: { type: ["string", "null"] },
          },
          required: ["enabled", "days", "startedAt"],
        },
      },
      required: [
        "mode",
        "baseUrl",
        "model",
        "timeoutMs",
        "fallback",
        "confidenceThreshold",
      ],
    },
  },
  required: ["enabled", "onlyOnError"],
} as const;

/** Ретеншн истории (Спринт 18). */
const HistorySettingsSchema = {
  type: "object" as const,
  properties: {
    retentionDays: { type: "number" },
    maxRecords: { type: "number" },
    lastCleanupAt: { type: ["string", "null"] },
    lastCleanupDeleted: { type: "number" },
  },
  required: ["retentionDays", "maxRecords"],
} as const;

/** Журнал аудита (Спринт 26). */
const AuditSettingsSchema = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" },
    retentionDays: { type: "number" },
    maxRecords: { type: "number" },
  },
  required: ["enabled", "retentionDays", "maxRecords"],
} as const;

/** Бюджеты день/неделя (Экономика v2, E-1.1). */
const BudgetSettingsSchema = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" },
    dailyUsd: { type: "number" },
    weeklyUsd: { type: "number" },
  },
  required: ["enabled", "dailyUsd", "weeklyUsd"],
} as const;

/** Деталь 3.8: настройки обратной связи с автором. */
const FeedbackSettingsSchema = {
  type: "object" as const,
  properties: {
    enabled: { type: "boolean" },
    endpoint: { type: "string" },
    includeLogs: { type: "boolean" },
    contactEmail: { type: "string" },
    maxPerHour: { type: "number" },
  },
  required: ["enabled", "endpoint", "includeLogs", "contactEmail", "maxPerHour"],
} as const;

/** Политика прав фоновых задач (Спринт 32). */
const PermissionSettingsSchema = {
  type: "object" as const,
  properties: {
    defaultPolicy: {
      type: "string",
      enum: ["hybrid", "secure", "legacy"],
    },
  },
  required: ["defaultPolicy"],
} as const;

const GetSettingsOutput = {
  type: "object" as const,
  properties: {
    maxConcurrent: { type: "number" },
    locale: { type: "string", enum: ["auto", "ru", "en", "zh", "tr"] },
    uiLocale: { type: "string", enum: ["ru", "en", "zh"] },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
    history: HistorySettingsSchema,
    audit: AuditSettingsSchema,
    permissions: PermissionSettingsSchema,
    budgets: BudgetSettingsSchema,
    feedback: FeedbackSettingsSchema,
  },
  required: ["maxConcurrent", "locale", "winterMode", "notifications"],
} as const;

const SaveSettingsInput = {
  type: "object" as const,
  properties: {
    maxConcurrent: { type: "number" },
    /** Язык интерфейса (Спринт 28): ru по умолчанию, en — опционально. */
    locale: { type: "string", enum: ["auto", "ru", "en", "zh", "tr"] },
    uiLocale: { type: "string", enum: ["ru", "en", "zh"] },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
    history: HistorySettingsSchema,
    audit: AuditSettingsSchema,
    permissions: PermissionSettingsSchema,
    budgets: BudgetSettingsSchema,
    feedback: FeedbackSettingsSchema,
  },
  additionalProperties: false,
} as const;

const SaveSettingsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    maxConcurrent: { type: "number" },
    locale: { type: "string", enum: ["auto", "ru", "en", "zh", "tr"] },
    uiLocale: { type: "string", enum: ["ru", "en", "zh"] },
    winterMode: { type: "boolean" },
    notifications: NotificationSettingsSchema,
    history: HistorySettingsSchema,
    audit: AuditSettingsSchema,
    permissions: PermissionSettingsSchema,
    budgets: BudgetSettingsSchema,
    feedback: FeedbackSettingsSchema,
  },
  required: ["success", "maxConcurrent", "locale", "winterMode", "notifications"],
} as const;

const CleanupHistoryInput = {
  type: "object" as const,
  properties: {
    /** Удалять записи старше N дней (0 — выключить ограничение по возрасту). */
    retentionDays: { type: "number" },
    /** Хранить не более N записей (0 — без ограничения). */
    maxRecords: { type: "number" },
  },
  additionalProperties: false,
} as const;

const CleanupHistoryOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    deleted: { type: "number" },
    deletedByAge: { type: "number" },
    deletedByCount: { type: "number" },
    kept: { type: "number" },
    retentionDays: { type: "number" },
    maxRecords: { type: "number" },
    vacuumed: { type: "boolean" },
  },
  required: ["success", "message", "deleted", "kept"],
} as const;

const GetAnalyticsInput = {
  type: "object" as const,
  properties: {
    /** Окно анализа в днях (по умолчанию 14, максимум 365). */
    days: { type: "number" },
    /** Сколько строк в топах (по умолчанию 10). */
    topLimit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const GetAnalyticsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    // null при ошибке: report формируется только при success=true.
    report: { type: ["object", "null"] as const },
    error: { type: "string" },
  },
  required: ["success", "report"],
} as const;

const SelfAnalysisInput = {
  type: "object" as const,
  properties: {
    /** Окно анализа в днях (по умолчанию 14, максимум 365). */
    days: { type: "number" },
    /** Сколько строк в топах (по умолчанию 10). */
    topLimit: { type: "number" },
    /** Включить обнаружение аномалий (по умолчанию true). */
    includeAnomalies: { type: "boolean" },
    /** Включить анализ трендов (по умолчанию true). */
    includeTrends: { type: "boolean" },
    /** Включить рекомендации (по умолчанию true). */
    includeRecommendations: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const SelfAnalysisOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    // null при ошибке: report формируется только при success=true.
    report: { type: ["object", "null"] as const },
    error: { type: "string" },
  },
  required: ["success", "report"],
} as const;

const TestNotificationInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const TestNotificationOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

/** Ручная отправка дайджеста (Спринт 20); не сдвигает плановое расписание. */
const SendDigestInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const SendDigestOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

/** Секрет: имя и маскированный превью, значение никогда не возвращается. */
const SecretItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    preview: { type: "string" },
    updatedAt: { type: "string" },
  },
  required: ["name", "preview"],
} as const;

const ListSecretsInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const ListSecretsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    secrets: { type: "array", items: SecretItem },
  },
  required: ["success", "secrets"],
} as const;

const SaveSecretInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    value: { type: "string" },
  },
  required: ["name", "value"],
  additionalProperties: false,
} as const;

const SaveSecretOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    secret: SecretItem,
  },
  required: ["success"],
} as const;

const DeleteSecretInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const DeleteSecretOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

/** Запись журнала аудита (Спринт 26). */
const AuditRecordSchema = {
  type: "object" as const,
  properties: {
    id: { type: "number" },
    ts: { type: "string" },
    action: { type: "string" },
    targetType: { type: ["string", "null"] },
    target: { type: ["string", "null"] },
    actor: { type: "string" },
    source: { type: ["string", "null"] },
    details: {},
    remote: { type: ["string", "null"] },
  },
  required: ["id", "ts", "action", "actor"],
} as const;

const GetAuditInput = {
  type: "object" as const,
  properties: {
    action: { type: "string" },
    target: { type: "string" },
    actor: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const GetAuditOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    records: { type: "array", items: AuditRecordSchema },
    total: { type: "number" },
  },
  required: ["success", "records", "total"],
} as const;

/** Запись dead-letter queue (Спринт 36.6). */
const DlqEntrySchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    runId: { type: "string" },
    stepName: { type: "string" },
    status: { type: "string" },
    reason: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    attempts: { type: "number" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    resolvedAt: { type: ["string", "null"] },
    resolution: { type: ["string", "null"] },
  },
  required: [
    "id",
    "runId",
    "stepName",
    "status",
    "reason",
    "error",
    "attempts",
    "createdAt",
    "updatedAt",
    "resolvedAt",
    "resolution",
  ],
} as const;

const ListDlqInput = {
  type: "object" as const,
  properties: {
    /** open (по умолчанию) | retried | discarded | all. */
    status: { type: "string" },
    /** Сколько записей вернуть (по умолчанию 100, максимум 500). */
    limit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const ListDlqOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    entries: { type: "array", items: DlqEntrySchema },
    open: { type: "number" },
    error: { type: "string" },
  },
  required: ["success", "entries", "open"],
  additionalProperties: false,
} as const;

const RetryDlqInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const RetryDlqOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
    entry: DlqEntrySchema,
    runId: { type: "string" },
    stepName: { type: "string" },
    runReopened: { type: "boolean" },
  },
  required: ["success"],
  additionalProperties: false,
} as const;

const DiscardDlqInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    /** Причина отказа для журнала (по умолчанию discarded). */
    resolution: { type: "string" },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const DiscardDlqOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
    entry: DlqEntrySchema,
  },
  required: ["success"],
  additionalProperties: false,
} as const;

/** Шаг durable-запуска для панели (Спринт 36.8). */
const RunPanelStepSchema = {
  type: "object" as const,
  properties: {
    stepName: { type: "string" },
    position: { type: "number" },
    status: { type: "string" },
    attempt: { type: "number" },
    error: { type: ["string", "null"] },
    anchor: { type: "string" },
  },
  required: ["stepName", "position", "status", "attempt", "error", "anchor"],
} as const;

/** Вставка контекста в истории запуска. */
const RunPanelInjectionSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    kind: { type: "string" },
    content: { type: "string" },
    contentLength: { type: "number" },
    author: { type: "string" },
    createdAt: { type: "string" },
    consumedAt: { type: ["string", "null"] },
    consumedByStep: { type: ["string", "null"] },
  },
  required: [
    "id",
    "kind",
    "content",
    "contentLength",
    "author",
    "createdAt",
    "consumedAt",
    "consumedByStep",
  ],
} as const;

/** Durable-запуск в панели паузы/resume. */
const RunPanelRunSchema = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    taskName: { type: "string" },
    status: { type: "string" },
    createdAt: { type: "string" },
    startedAt: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
    error: { type: ["string", "null"] },
    steps: { type: "array", items: RunPanelStepSchema },
    currentStep: { type: ["object", "null"], properties: RunPanelStepSchema.properties },
    doneSteps: { type: "number" },
    totalSteps: { type: "number" },
    injections: { type: "array", items: RunPanelInjectionSchema },
    pendingInjections: { type: "number" },
  },
  required: [
    "id",
    "taskName",
    "status",
    "createdAt",
    "startedAt",
    "finishedAt",
    "error",
    "steps",
    "currentStep",
    "doneSteps",
    "totalSteps",
    "injections",
    "pendingInjections",
  ],
} as const;

const ListDurableRunsInput = {
  type: "object" as const,
  properties: {
    /** active (по умолчанию) | all | pending | running | paused | passed | failed | cancelled. */
    filter: { type: "string" },
    /** Сколько запусков вернуть (по умолчанию 20, максимум 100). */
    limit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const ListDurableRunsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    runs: { type: "array", items: RunPanelRunSchema },
    active: { type: "number" },
    error: { type: "string" },
  },
  required: ["success", "runs", "active"],
  additionalProperties: false,
} as const;

const PauseDurableRunInput = {
  type: "object" as const,
  properties: {
    runId: { type: "string" },
    /** Явный шаг-получатель; по умолчанию первый незавершённый. */
    stepName: { type: "string" },
    /** Комментарий, который получит шаг при resume. */
    comment: { type: "string" },
    /** Автор комментария (по умолчанию local-user). */
    author: { type: "string" },
  },
  required: ["runId"],
  additionalProperties: false,
} as const;

const PauseDurableRunOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
    run: RunPanelRunSchema,
    stepName: { type: ["string", "null"] },
  },
  required: ["success"],
  additionalProperties: false,
} as const;

const ResumeDurableRunInput = {
  type: "object" as const,
  properties: {
    runId: { type: "string" },
  },
  required: ["runId"],
  additionalProperties: false,
} as const;

const ResumeDurableRunOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
    run: RunPanelRunSchema,
    stepName: { type: ["string", "null"] },
    prepared: { type: "boolean" },
    // PL-92: resume теперь может реально выполнить шаги.
    resumedFrom: { type: ["string", "null"] },
    executed: { type: "array", items: { type: "string" } },
    skipped: { type: "array", items: { type: "string" } },
    injected: { type: "array", items: { type: "string" } },
    failedStep: { type: ["string", "null"] },
  },
  required: ["success"],
  additionalProperties: false,
} as const;

/** PL-95: очередь одобрений (живёт в журнале аудита, ARCH-7.1). */
const ApprovalPanelRecordSchema = {
  type: "object" as const,
  properties: {
    requestId: { type: "string" },
    taskName: { type: "string" },
    riskClass: { type: "string" },
    runRef: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    status: { type: "string" },
    decision: { type: ["string", "null"] },
    decidedBy: { type: ["string", "null"] },
    decidedAt: { type: ["string", "null"] },
    requestedBy: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
  required: ["requestId", "taskName", "riskClass", "status", "createdAt"],
  additionalProperties: false,
} as const;

const ListApprovalsInput = {
  type: "object" as const,
  properties: {
    /** По умолчанию 50, максимум 500. */
    limit: { type: "number" },
  },
  additionalProperties: false,
} as const;

const ListApprovalsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    approvals: { type: "array", items: ApprovalPanelRecordSchema },
    error: { type: "string" },
  },
  required: ["success", "approvals"],
  additionalProperties: false,
} as const;

const DecideApprovalInput = {
  type: "object" as const,
  properties: {
    requestId: { type: "string" },
    decision: { type: "string" },
    decidedBy: { type: "string" },
  },
  required: ["requestId", "decision"],
  additionalProperties: false,
} as const;

const DecideApprovalOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    approval: ApprovalPanelRecordSchema,
    error: { type: "string" },
    /** PL-103: auto | manual | failed | skipped. */
    restart: { type: "string" },
    restartRunId: { type: ["string", "null"] },
    restartError: { type: "string" },
  },
  required: ["success"],
  additionalProperties: false,
} as const;

/** Сравнение триажа «до/после» (Спринт 31.5). */
const CompareTriageInput = {
  type: "object" as const,
  properties: {
    taskName: { type: "string" },
    status: { type: "string" },
    error: { type: ["string", "null"] },
    durationMs: { type: "number" },
    tokens: { type: "number" },
    costUsd: { type: "number" },
    before: { type: ["object", "null"] },
    after: { type: ["object", "null"] },
    dedupCount: { type: "number" },
  },
  required: ["taskName", "status"],
  additionalProperties: false,
} as const;

const CompareTriageOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    result: { type: "object" },
    error: { type: "string" },
  },
  required: ["success", "result"],
  additionalProperties: false,
} as const;

/** Отчёт shadow-режима триажа для GUI. */
const GetShadowReportInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetShadowReportOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    active: { type: "boolean" },
    startedAt: { type: ["string", "null"] },
    days: { type: "number" },
    total: { type: "number" },
    skips: { type: "number" },
    wouldSuppress: { type: "number" },
    bySource: { type: "object" },
    persisted: { type: "boolean" },
    truncated: { type: "boolean" },
    decisions: { type: "array", items: { type: "object" } },
  },
  required: [
    "success",
    "active",
    "startedAt",
    "days",
    "total",
    "skips",
    "wouldSuppress",
    "bySource",
    "persisted",
    "truncated",
    "decisions",
  ],
  additionalProperties: false,
} as const;

/** Сброс shadow-журнала триажа для GUI. */
const ResetShadowReportInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const ResetShadowReportOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
  },
  required: ["success"],
  additionalProperties: false,
} as const;

/** Проверка связи с локальной моделью триажа (GUI). */
const TestLocalAiInput = {
  type: "object" as const,
  properties: {
    mode: { type: "string" },
    baseUrl: { type: "string" },
    model: { type: "string" },
    timeoutMs: { type: "number" },
    fallback: { type: "string" },
    confidenceThreshold: { type: "number" },
  },
  additionalProperties: false,
} as const;

const TestLocalAiOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    localAi: { type: "object" },
    result: { type: "object" },
  },
  required: ["success", "localAi", "result"],
  additionalProperties: false,
} as const;

const TemplateItem = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    timeoutSeconds: { type: "number" },
    /** LLM-модель шаблона. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    beforeScript: { type: "string" },
    afterScript: { type: "string" },
    triggerType: { type: "string" },
    mcpEvent: McpEventSchema,
    watchPath: { type: "string" },
    /** Спринт 27: glob-маски и исключения файлового триггера. */
    watchGlobs: { type: "array", items: { type: "string" } },
    watchIgnore: { type: "array", items: { type: "string" } },
    /** Спринт 27: git-триггер и дни/политика окна. */
    gitBranch: { type: "string" },
    gitPaths: { type: "array", items: { type: "string" } },
    gitIgnore: { type: "array", items: { type: "string" } },
    gitPollSeconds: { type: "number" },
    activeDays: { type: "array", items: { type: "number" } },
    windowPolicy: { type: "string" },
    workspaceId: { type: "string" },
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped, metadata-only). */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: "array", items: { type: "string" } },
  },
  required: ["id", "name", "prompt"],
} as const;

const GetTemplatesInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetTemplatesOutput = {
  type: "object" as const,
  properties: {
    templates: {
      type: "array",
      items: TemplateItem,
    },
  },
  required: ["templates"],
} as const;

const SaveTemplateInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
    schedule: { type: "string" },
    timeoutSeconds: { type: "number" },
    /** LLM-модель шаблона. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    beforeScript: { type: "string" },
    afterScript: { type: "string" },
    triggerType: { type: "string" },
    mcpEvent: McpEventSchema,
    watchPath: { type: "string" },
    workspaceId: { type: "string" },
    workingDirectory: { type: "string" },
    /** Белый список инструментов шаблона (role-scoped). */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов шаблона. */
    deniedTools: { type: "array", items: { type: "string" } },
  },
  required: ["name", "prompt"],
  additionalProperties: false,
} as const;

const SaveTemplateOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    template: TemplateItem,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const DeleteTemplateInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const DeleteTemplateOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const PauseResumeInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    /**
     * Только для pause: пауза до указанного момента (ISO). Плагин включит
     * задачу автоматически; пусто — бессрочная пауза.
     */
    until: { type: "string" },
  },
  required: ["name"],
} as const;

const UpdateTaskInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    newSchedule: { type: "string" },
    newPrompt: { type: "string" },
    /** LLM-модель задачи. */
    model: { type: "string" },
    /** Приоритет задачи 0..10. */
    priority: { type: "number" },
    retryCount: { type: "number" },
    retryDelay: { type: "number" },
    qualityGate: { type: "string" },
    nextTaskOnSuccess: { type: "string" },
    nextTaskOnError: { type: "string" },
    /** DAG-зависимости: задачи, которые должны успешно завершиться раньше этой. */
    dependsOn: { type: "array", items: { type: "string" } },
    /** Команда перед запуском (pre-flight). */
    beforeScript: { type: "string" },
    /** Команда после запуска (post-flight). */
    afterScript: { type: "string" },
    /** Тип триггера: "cron" (по умолчанию; нужен schedule), "file", "mcp-event" или "once" (нужен runAt либо delaySeconds). */
    triggerType: { type: "string" },
    /** Время разового запуска (triggerType === "once"), ISO-8601. Взаимоисключает schedule/newSchedule. */
    runAt: { type: "string" },
    /** Отложенный разовый запуск через N секунд (triggerType === "once"). Взаимоисключает runAt. */
    delaySeconds: { type: "number" },
    /** Режим сессии OpenCode (Спринт 24): "new" (по умолчанию), "reuse" (--session <id>), "last" (--continue). sessionId генерируется плагином. */
    session: { type: "string" },
    /** Сколько запусков переживает reuse-сессия до ротации (удаление и чистый старт). 0/не задано — без ограничения. */
    sessionMaxRuns: { type: "number" },
    /** Параметры MCP-события. */
    mcpEvent: McpEventSchema,
    /** Путь к файлу/папке для файлового триггера. */
    watchPath: { type: "string" },
    /** Привязка к multi-repo workspace. */
    workspaceId: { type: "string" },
    /** Рабочая директория задачи (по умолчанию — папка проекта). */
    workingDirectory: { type: "string" },
    /** Белый список инструментов задачи (role-scoped). Пустой массив запрещён. */
    allowedTools: { type: "array", items: { type: "string" } },
    /** Чёрный список инструментов задачи (приоритет над allowedTools). */
    deniedTools: { type: "array", items: { type: "string" } },
    /** Matrix (fan-out): раскладывает задачу-шаблон на клоны по workspace. */
    matrix: MatrixSchema,
    /** IANA-часовой пояс задачи. Пустая строка — сбросить на системный. */
    timezone: { type: "string" },
    /** Начало окна запуска "HH:MM". Пустая строка — сбросить окно. */
    notBefore: { type: "string" },
    /** Конец окна запуска "HH:MM". Пустая строка — сбросить окно. */
    notAfter: { type: "string" },
    /** Спринт 27: дни недели 0=Вс..6=Сб. Пустой массив — снять ограничение. */
    activeDays: { type: "array", items: { type: "number" } },
    /** Поведение вне окна: postpone (по умолчанию), skip или run. */
    windowPolicy: { type: "string" },
    /** Glob-маски файлового триггера. Пустой массив — снять ограничение. */
    watchGlobs: { type: "array", items: { type: "string" } },
    /** Glob-маски исключений файлового триггера. Пустой массив — очистить. */
    watchIgnore: { type: "array", items: { type: "string" } },
    /** Git-триггер: фильтр ветки (glob, через запятую). Пустая строка — сбросить. */
    gitBranch: { type: "string" },
    /** Git-триггер: маски путей. Пустой массив — сбросить. */
    gitPaths: { type: "array", items: { type: "string" } },
    /** Git-триггер: маски игнорируемых путей. Пустой массив — очистить. */
    gitIgnore: { type: "array", items: { type: "string" } },
    /** Git-триггер: период опроса в секундах (минимум 5). */
    gitPollSeconds: { type: "number" },
    /** EX-1.1: новый runner; null сбрасывает на local. */
    runner: RunnerSchema,
  },
  required: ["name"],
} as const;

const UpdateTaskOutput = DeleteTaskOutput;

const WorkspaceItem = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    gitRemote: { type: ["string", "null"] },
    gitBranch: { type: ["string", "null"] },
    color: { type: ["string", "null"] },
    /** Env-переменные workspace; значения секретов замаскированы (***). */
    env: { type: ["object", "null"], additionalProperties: { type: "string" } },
    /** Путь к .env-файлу workspace (null — не задан). */
    envFile: { type: ["string", "null"] },
    createdAt: { type: "string" },
  },
  required: ["id", "name", "path", "createdAt"],
} as const;

const GetWorkspacesInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetWorkspacesOutput = {
  type: "object" as const,
  properties: {
    workspaces: { type: "array", items: WorkspaceItem },
  },
  required: ["workspaces"],
} as const;

const AddWorkspaceInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    path: { type: "string" },
    color: { type: "string" },
    /** Env-переменные workspace (ключ → значение). */
    env: { type: ["object", "null"], additionalProperties: { type: "string" } },
    /** Путь к .env-файлу workspace. */
    envFile: { type: ["string", "null"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

const AddWorkspaceOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    workspace: WorkspaceItem,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const UpdateWorkspaceInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    color: { type: "string" },
    /** Env-переменные workspace; null — очистить, отсутствие — не менять. */
    env: { type: ["object", "null"], additionalProperties: { type: "string" } },
    /** Путь к .env-файлу; null — очистить. */
    envFile: { type: ["string", "null"] },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

const DeleteWorkspaceInput = {
  type: "object" as const,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const DeleteWorkspaceOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success"],
} as const;

const EmitEventInput = {
  type: "object" as const,
  properties: {
    /** Имя события, например github.pr.opened. */
    eventName: { type: "string" },
    /** Произвольный payload события (используется фильтрами задач). */
    payload: { type: ["object", "null", "string", "number", "boolean", "array"] },
  },
  required: ["eventName"],
} as const;

const EmitEventOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    /** Задачи, запущенные по событию (в порядке приоритета). */
    triggered: { type: "array", items: { type: "string" } },
  },
  required: ["success", "triggered"],
} as const;

const DryRunTaskItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    /** Порядок выполнения в конвейере (0 — первый). */
    order: { type: "number" },
    /** Триггер запуска: manual (первая в конвейере), cron или dag (по dependsOn). */
    trigger: { type: "string" },
    /** Рабочая директория, в которой будет выполнена задача. */
    cwd: { type: "string" },
    /** Команда, которую фактически выполнит обёртка (без реального запуска). */
    command: { type: "string" },
    /** Workspace задачи (null — без workspace). */
    workspace: {
      type: ["object", "null"],
      properties: {
        name: { type: "string" },
        path: { type: "string" },
      },
      required: ["name", "path"],
    },
    /** Pre-flight команда (null — не задана). */
    preFlight: { type: ["string", "null"] },
    /** Post-flight команда (null — не задана). */
    postFlight: { type: ["string", "null"] },
    /** Quality Gate (null — не задан). */
    qualityGate: { type: ["string", "null"] },
    /** Ограничения инструментов (null — без ограничений). */
    roleScoped: {
      type: ["object", "null"],
      properties: {
        allowed: { type: "array", items: { type: "string" } },
        denied: { type: "array", items: { type: "string" } },
      },
    },
    /** Оценка длительности по последним запускам (null — нет истории). */
    estimatedDurationSec: { type: ["number", "null"] },
    /** Оценка стоимости по последним запускам (null — нет истории). */
    estimatedCostUsd: { type: ["number", "null"] },
    /** Оценка токенов по последним запускам (null — нет истории). */
    estimatedTokens: { type: ["number", "null"] },
    /** Для клона матрицы — имя родителя-шаблона (Спринт 15). */
    matrixParent: { type: "string" },
  },
  required: ["name", "order", "trigger", "cwd", "command"],
} as const;

const DryRunReportOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    taskName: { type: "string" },
    /** Упорядоченный список задач конвейера (топологический порядок зависимостей). */
    tasks: { type: "array", items: DryRunTaskItem },
    /** Суммарные оценки по всем задачам. */
    totals: {
      type: "object",
      properties: {
        estimatedDurationSec: { type: ["number", "null"] },
        estimatedCostUsd: { type: ["number", "null"] },
        estimatedTokens: { type: ["number", "null"] },
      },
      required: [],
    },
    /** Предупреждения: опасные команды, недоступные пути, отсутствие истории. */
    warnings: { type: "array", items: { type: "string" } },
    error: { type: "string" },
  },
  required: ["success", "taskName", "tasks", "warnings"],
} as const;

const DryRunInput = {
  type: "object" as const,
  properties: {
    taskName: { type: "string" },
  },
  required: ["taskName"],
  additionalProperties: false,
} as const;

const DryRunAllOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    reports: {
      type: "array",
      items: DryRunReportOutput,
    },
  },
  required: ["success", "reports"],
} as const;

/* === Pipeline-as-code (спринт 32) === */

const PipelineValidateInput = {
  type: "object" as const,
  properties: {
    path: { type: "string" },
    source: { type: "string" },
    dryRun: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const PipelineIssue = {
  type: "object" as const,
  properties: {
    path: { type: "string" },
    message: { type: "string" },
  },
  required: ["path", "message"],
} as const;

const PipelineValidationOutput = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" },
    errors: { type: "array", items: PipelineIssue },
    warnings: { type: "array", items: PipelineIssue },
    spec: {},
  },
  required: ["ok", "errors", "warnings"],
} as const;

const PipelineApplyInput = {
  type: "object" as const,
  properties: {
    path: { type: "string" },
    source: { type: "string" },
    dryRun: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

const PipelineApplyOutput = {
  type: "object" as const,
  properties: {
    created: { type: "number" },
    updated: { type: "number" },
    unchanged: { type: "number" },
    stale: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: PipelineIssue },
  },
  required: ["created", "updated", "unchanged", "stale"],
} as const;

const PipelineExportInput = {
  type: "object" as const,
  properties: {
    pipeline: { type: "string" },
  },
  required: ["pipeline"],
  additionalProperties: false,
} as const;

const PipelineExportOutput = {
  type: "object" as const,
  properties: {
    ok: { type: "boolean" },
    spec: {},
    error: { type: "string" },
  },
  required: ["ok"],
} as const;

/* === end Pipeline-as-code === */

/** Детальный отчёт по одному клону матрицы. */
const MatrixCloneResult = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    workspaceId: { type: ["string", "null"] },
    workspaceName: { type: ["string", "null"] },
    /** success | error | timeout | partial | pending | running */
    status: { type: "string" },
    error: { type: ["string", "null"] },
    finishedAt: { type: ["string", "null"] },
  },
  required: ["name", "status"],
} as const;

const GetMatrixResultsInput = {
  type: "object" as const,
  properties: {
    parentId: { type: "string" },
  },
  required: ["parentId"],
  additionalProperties: false,
} as const;

const MatrixReport = {
  type: "object" as const,
  properties: {
    parentId: { type: "string" },
    totalCount: { type: "number" },
    successCount: { type: "number" },
    errorCount: { type: "number" },
    pendingCount: { type: "number" },
    /** success | error | partial | running | empty */
    status: { type: "string" },
    message: { type: "string" },
    clones: { type: "array", items: MatrixCloneResult },
  },
  required: ["parentId", "totalCount", "successCount", "errorCount", "status"],
} as const;

const GetMatrixResultsOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    report: MatrixReport,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const ExpandMatrixPreviewInput = {
  type: "object" as const,
  properties: {
    /** Имя задачи-родителя (используется в именах клонов). */
    name: { type: "string" },
    workspaceIds: { type: "array", items: { type: "string" } },
    strategy: { type: "string" },
    failureMode: { type: "string" },
    aggregation: { type: "string" },
  },
  required: ["workspaceIds"],
  additionalProperties: false,
} as const;

const ExpandMatrixPreviewOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    clones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          workspaceId: { type: "string" },
          workspaceName: { type: ["string", "null"] },
        },
        required: ["name", "workspaceId"],
      },
    },
    error: { type: "string" },
  },
  required: ["success", "clones"],
} as const;

const CancelMatrixOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    cancelled: { type: "array", items: { type: "string" } },
  },
  required: ["success", "message", "cancelled"],
} as const;

const CleanupMatrixOrphansOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    removed: { type: "array", items: { type: "string" } },
  },
  required: ["success", "message", "removed"],
} as const;

/** Профиль (Спринт 21): отдельная БД, настройки, логи и порт дашборда. */
const ProfileItem = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    dir: { type: "string" },
    port: { type: ["number", "null"] },
    isDefault: { type: "boolean" },
    active: { type: "boolean" },
  },
  required: ["name", "dir", "isDefault", "active"],
} as const;

const GetProfilesInput = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
} as const;

const GetProfilesOutput = {
  type: "object" as const,
  properties: {
    current: { type: "string" },
    /** true — профиль задан переменной OPENCODE_SCHEDULER_PROFILE. */
    pinnedByEnv: { type: "boolean" },
    profiles: { type: "array", items: ProfileItem },
  },
  required: ["current", "pinnedByEnv", "profiles"],
} as const;

const SetProfileInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const SetProfileOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    current: { type: "string" },
    /** true — изменения вступят в силу после перезапуска OpenCode. */
    restartRequired: { type: "boolean" },
  },
  required: ["success", "message", "current", "restartRequired"],
} as const;

const CreateProfileInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    /** Порт дашборда профиля (по умолчанию — свободный 3782+). */
    port: { type: "number" },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const CreateProfileOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
    profile: ProfileItem,
    error: { type: "string" },
  },
  required: ["success"],
} as const;

const DeleteProfileInput = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const DeleteProfileOutput = {
  type: "object" as const,
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
} as const;

export const SchedulerRpc = Rpc.define({
  // ВАЖНО: id RPC-канала совпадает с id плагина и должен оставаться
  // "opencode-windows-scheduler". GUI OpenCode строит URL
  // /api/rpc/<plugin-id>/<method>; если id разойдётся, все вызовы
  // вернут 400 "RPC is unavailable: opencode-windows-scheduler".
  id: "opencode-windows-scheduler",
  methods: {
    get_tasks: { input: GetTasksInput, output: GetTasksOutput },
    create_task: { input: CreateTaskInput, output: CreateTaskOutput },
    delete_task: { input: DeleteTaskInput, output: DeleteTaskOutput },
    run_task: { input: RunTaskInput, output: RunTaskOutput },
    run_mission: { input: RunMissionInput, output: RunMissionOutput },
    pause_task: { input: PauseResumeInput, output: DeleteTaskOutput },
    resume_task: { input: PauseResumeInput, output: DeleteTaskOutput },
    update_task: { input: UpdateTaskInput, output: UpdateTaskOutput },
    get_task_logs: { input: GetTaskLogsInput, output: GetTaskLogsOutput },
    get_history: { input: GetHistoryInput, output: GetHistoryOutput },
    get_metrics: { input: GetMetricsInput, output: GetMetricsOutput },
    get_dashboard_port: { input: GetDashboardPortInput, output: GetDashboardPortOutput },
    get_platform: { input: GetPlatformInput, output: GetPlatformOutput },
    dry_run: { input: DryRunInput, output: DryRunReportOutput },
    dry_run_all: { input: GetTasksInput, output: DryRunAllOutput },
    pipeline_validate: { input: PipelineValidateInput, output: PipelineValidationOutput },
    pipeline_apply: { input: PipelineApplyInput, output: PipelineApplyOutput },
    pipeline_export: { input: PipelineExportInput, output: PipelineExportOutput },
    get_matrix_results: {
      input: GetMatrixResultsInput,
      output: GetMatrixResultsOutput,
    },
    cancel_matrix: { input: NameOnly, output: CancelMatrixOutput },
    cleanup_matrix_orphans: {
      input: GetTasksInput,
      output: CleanupMatrixOrphansOutput,
    },
    cleanup_history: { input: CleanupHistoryInput, output: CleanupHistoryOutput },
    get_analytics: { input: GetAnalyticsInput, output: GetAnalyticsOutput },
    self_analysis: { input: SelfAnalysisInput, output: SelfAnalysisOutput },
    expand_matrix_preview: {
      input: ExpandMatrixPreviewInput,
      output: ExpandMatrixPreviewOutput,
    },
    get_workspaces: { input: GetWorkspacesInput, output: GetWorkspacesOutput },
    add_workspace: { input: AddWorkspaceInput, output: AddWorkspaceOutput },
    update_workspace: { input: UpdateWorkspaceInput, output: AddWorkspaceOutput },
    delete_workspace: { input: DeleteWorkspaceInput, output: DeleteWorkspaceOutput },
    get_profiles: { input: GetProfilesInput, output: GetProfilesOutput },
    set_profile: { input: SetProfileInput, output: SetProfileOutput },
    create_profile: { input: CreateProfileInput, output: CreateProfileOutput },
    delete_profile: { input: DeleteProfileInput, output: DeleteProfileOutput },
    export_tasks: { input: ExportTasksInput, output: ExportTasksOutput },
    import_tasks: { input: ImportTasksInput, output: ImportTasksOutput },
    backup_db: { input: BackupDbInput, output: BackupDbOutput },
    restore_db: { input: RestoreDbInput, output: RestoreDbOutput },
    get_settings: { input: GetSettingsInput, output: GetSettingsOutput },
    save_settings: { input: SaveSettingsInput, output: SaveSettingsOutput },
    get_templates: { input: GetTemplatesInput, output: GetTemplatesOutput },
    save_template: { input: SaveTemplateInput, output: SaveTemplateOutput },
    delete_template: { input: DeleteTemplateInput, output: DeleteTemplateOutput },
    emit_event: { input: EmitEventInput, output: EmitEventOutput },
    test_notification: {
      input: TestNotificationInput,
      output: TestNotificationOutput,
    },
    send_digest: {
      input: SendDigestInput,
      output: SendDigestOutput,
    },
    list_secrets: { input: ListSecretsInput, output: ListSecretsOutput },
    save_secret: { input: SaveSecretInput, output: SaveSecretOutput },
    delete_secret: { input: DeleteSecretInput, output: DeleteSecretOutput },
    get_audit: { input: GetAuditInput, output: GetAuditOutput },
    list_dlq: { input: ListDlqInput, output: ListDlqOutput },
    retry_dlq: { input: RetryDlqInput, output: RetryDlqOutput },
    discard_dlq: { input: DiscardDlqInput, output: DiscardDlqOutput },
    list_durable_runs: { input: ListDurableRunsInput, output: ListDurableRunsOutput },
    pause_durable_run: { input: PauseDurableRunInput, output: PauseDurableRunOutput },
    resume_durable_run: { input: ResumeDurableRunInput, output: ResumeDurableRunOutput },
    // PL-95: очередь одобрений доступна через RPC и GUI.
    list_approvals: { input: ListApprovalsInput, output: ListApprovalsOutput },
    decide_approval: { input: DecideApprovalInput, output: DecideApprovalOutput },
    compare_triage: {
      input: CompareTriageInput,
      output: CompareTriageOutput,
    },
    get_shadow_report: {
      input: GetShadowReportInput,
      output: GetShadowReportOutput,
    },
    reset_shadow_report: {
      input: ResetShadowReportInput,
      output: ResetShadowReportOutput,
    },
    test_local_ai: {
      input: TestLocalAiInput,
      output: TestLocalAiOutput,
    },
  },
  events: {},
});

export type SchedulerRpc = typeof SchedulerRpc;
