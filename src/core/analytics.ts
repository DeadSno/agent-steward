/**
 * Аналитика по истории запусков (Спринт 18).
 *
 * Чистые функции без БД и HTTP: дашборд и RPC отдают JSON, экспорт — CSV.
 * Так агрегаты легко тестировать без запуска сервера.
 */
import {
  computeSavings,
  type SavingsRecord,
  type SavingsReport,
} from "./savings.js";
import { safeStringify } from "../text.js";

/** Оценка стоимости, если запись истории не содержит costUsd. */
export const ESTIMATED_COST_PER_1K_TOKENS_USD = 0.003;

/** Минимальный вид записи истории, нужный аналитике. */
export interface AnalyticsRecord {
  taskName: string;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number | null;
  error?: string | null;
  tokens?: number;
  costUsd?: number;
  model?: string;
  workspaceId?: string | null;
}

/** Описание задачи для группировки по матрицам. */
export interface AnalyticsTaskRef {
  name: string;
  matrixParentId?: string | null;
  /** Экономика v2 (E-2): лимит токенов на запуск (0/undefined — без лимита). */
  tokenBudget?: number;
}

export interface DailyBucket {
  /** YYYY-MM-DD (UTC). */
  date: string;
  total: number;
  success: number;
  error: number;
  partial: number;
  tokens: number;
  costUsd: number;
  avgDurationMs: number;
}

export interface TaskAnalyticsRow {
  taskName: string;
  total: number;
  success: number;
  error: number;
  /** Процент успешных запусков (0..100, один знак после запятой). */
  successRate: number;
  avgDurationMs: number;
  tokens: number;
  costUsd: number;
  /** Задача — клон матрицы (matrixParentId задан). */
  isMatrixClone: boolean;
  matrixParentId: string | null;
  /** Экономика v2 (E-2): лимит токенов на запуск (0 — без лимита). */
  tokenBudget?: number;
  /** Сумма токенов за период превысила лимит на задачу. */
  tokenBudgetExceeded?: boolean;
}

export interface MatrixAnalyticsRow {
  parentId: string;
  clones: number;
  total: number;
  success: number;
  error: number;
  successRate: number;
  tokens: number;
  costUsd: number;
}

export interface ModelAnalyticsRow {
  model: string;
  total: number;
  costUsd: number;
}

/** Агрегат по тексту ошибки — топ ошибок для дайджеста (Спринт 20). */
export interface ErrorAnalyticsRow {
  /** Текст ошибки (обрезан до 160 символов). */
  message: string;
  count: number;
  /** Последнее появление (ISO). */
  lastAt: string;
}

export interface AnalyticsReport {
  generatedAt: string;
  /** Окно анализа в днях. */
  windowDays: number;
  totals: {
    total: number;
    success: number;
    error: number;
    partial: number;
    successRate: number;
    avgDurationMs: number;
    tokens: number;
    costUsd: number;
  };
  daily: DailyBucket[];
  tasks: TaskAnalyticsRow[];
  topByCost: TaskAnalyticsRow[];
  matrices: MatrixAnalyticsRow[];
  byModel: ModelAnalyticsRow[];
  /** Топ ошибок по частоте (Спринт 20). */
  errors: ErrorAnalyticsRow[];
  /** Оценка экономии по контрфактике (Спринт 31.6). */
  savings: SavingsReport;
  sources: {
    historyRecords: number;
    /** Сколько записей попало в окно. */
    recordsInWindow: number;
    /** Ограничение по количеству строк в топах. */
    topLimit: number;
  };
}

export interface BuildAnalyticsOptions {
  /** Окно анализа в днях (по умолчанию 14). */
  days?: number;
  /** Опорный момент (для тестов). */
  now?: Date;
  /** Сколько строк оставлять в топах (по умолчанию 10). */
  topLimit?: number;
  /** Известные задачи — нужны для группировки матриц. */
  tasks?: AnalyticsTaskRef[];
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Стоимость записи: явная цена, иначе оценка по токенам. */
export function recordCost(record: AnalyticsRecord): number {
  const cost = toNumber(record.costUsd);
  if (cost > 0) return cost;
  const tokens = toNumber(record.tokens);
  return tokens > 0 ? (tokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD : 0;
}

/** Дата записи в UTC-формате YYYY-MM-DD. */
export function recordDate(record: AnalyticsRecord): string {
  const time = new Date(record.startedAt).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(time).toISOString().slice(0, 10);
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Строит отчёт по истории: итоги, дневные бакеты, разбивка по задачам,
 * матрицам и моделям.
 */
export function buildAnalytics(
  records: AnalyticsRecord[],
  options: BuildAnalyticsOptions = {},
): AnalyticsReport {
  const windowDays = Math.max(1, Math.floor(options.days ?? 14));
  const topLimit = Math.max(1, Math.floor(options.topLimit ?? 10));
  const now = options.now ?? new Date();

  const dayKeys: string[] = [];
  const dayBuckets = new Map<string, DailyBucket>();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const key = utcDayKey(new Date(now.getTime() - i * 24 * 60 * 60 * 1000));
    dayKeys.push(key);
    dayBuckets.set(key, {
      date: key,
      total: 0,
      success: 0,
      error: 0,
      partial: 0,
      tokens: 0,
      costUsd: 0,
      avgDurationMs: 0,
    });
  }

  const byTask = new Map<string, TaskAnalyticsRow & { maxRunTokens: number }>();
  const byModel = new Map<string, ModelAnalyticsRow>();
  const byError = new Map<string, ErrorAnalyticsRow>();
  const cloneParent = new Map<string, string>();
  const taskTokenBudget = new Map<string, number>();
  for (const task of options.tasks ?? []) {
    const parentId = task.matrixParentId?.trim();
    if (parentId) cloneParent.set(task.name.toLowerCase(), parentId);
    const budget = Number(task.tokenBudget);
    if (Number.isFinite(budget) && budget > 0) {
      taskTokenBudget.set(task.name.toLowerCase(), budget);
    }
  }

  let totalsTotal = 0;
  let totalsSuccess = 0;
  let totalsError = 0;
  let totalsPartial = 0;
  let totalsTokens = 0;
  let totalsCost = 0;
  let durationsSum = 0;
  let durationsCount = 0;
  let recordsInWindow = 0;
  const windowRecords: SavingsRecord[] = [];

  for (const record of records) {
    const date = recordDate(record);
    if (!date) continue;
    const bucket = dayBuckets.get(date);
    // Итоги считаются только по окну — это «аналитика за период».
    if (!bucket) continue;
    recordsInWindow += 1;

    const tokens = toNumber(record.tokens);
    const cost = recordCost(record);
    const status = String(record.status ?? "");
    // Незавершённые запуски не участвуют в аналитике: их ещё нельзя оценить.
    if (status === "running") continue;
    windowRecords.push(record);
    const duration = toNumber(record.durationMs);

    bucket.total += 1;
    bucket.tokens += tokens;
    bucket.costUsd += cost;
    if (status === "success") bucket.success += 1;
    else if (status === "partial") bucket.partial += 1;
    else bucket.error += 1;
    if (duration > 0) {
      bucket.avgDurationMs =
        (bucket.avgDurationMs * (bucket.total - 1) + duration) / bucket.total;
    }

    totalsTotal += 1;
    totalsTokens += tokens;
    totalsCost += cost;
    if (status === "success") totalsSuccess += 1;
    else if (status === "partial") totalsPartial += 1;
    else totalsError += 1;
    if (duration > 0) {
      durationsSum += duration;
      durationsCount += 1;
    }

    const taskKey = record.taskName.toLowerCase();
    const existing = byTask.get(taskKey) ?? {
      taskName: record.taskName,
      total: 0,
      success: 0,
      error: 0,
      successRate: 0,
      avgDurationMs: 0,
      tokens: 0,
      costUsd: 0,
      isMatrixClone: cloneParent.has(taskKey),
      matrixParentId: cloneParent.get(taskKey) ?? null,
      tokenBudget: taskTokenBudget.get(taskKey),
      tokenBudgetExceeded: false,
      maxRunTokens: 0,
    };
    existing.maxRunTokens = Math.max(existing.maxRunTokens, tokens);
    existing.total += 1;
    if (status === "success") existing.success += 1;
    else existing.error += 1;
    existing.tokens += tokens;
    existing.costUsd += cost;
    if (duration > 0) {
      existing.avgDurationMs =
        (existing.avgDurationMs * (existing.total - 1) + duration) / existing.total;
    }
    byTask.set(taskKey, existing);

    const model = record.model?.trim() || "(default)";
    const modelRow = byModel.get(model) ?? { model, total: 0, costUsd: 0 };
    modelRow.total += 1;
    modelRow.costUsd += cost;
    byModel.set(model, modelRow);

    // Топ ошибок: группируем по тексту, чтобы дайджест показывал частые причины.
    if (status !== "success" && status !== "partial") {
      // QA-P1.5: легаси-записи успешных запусков содержат "-" вместо текста
      // ошибки. Такой маркер не является сообщением и не должен попадать в топ.
      const rawError = typeof record.error === "string" ? record.error.trim() : "";
      const message =
        rawError && rawError !== "-"
          ? rawError.slice(0, 160)
          : "(без текста)";
      const errorRow = byError.get(message) ?? {
        message,
        count: 0,
        lastAt: record.startedAt,
      };
      errorRow.count += 1;
      if (
        new Date(record.startedAt).getTime() >
        new Date(errorRow.lastAt).getTime()
      ) {
        errorRow.lastAt = record.startedAt;
      }
      byError.set(message, errorRow);
    }
  }

  const tasks = [...byTask.values()]
    .map(({ maxRunTokens, ...row }) => ({
      ...row,
      successRate: percent(row.success, row.total),
      avgDurationMs: Math.round(row.avgDurationMs),
      costUsd: Math.round(row.costUsd * 1e6) / 1e6,
      // E-2: бюджет задаётся на один запуск, поэтому флаг выставляем по
      // максимальному расходу токенов за запуск, а не по сумме за период.
      tokenBudgetExceeded: row.tokenBudget
        ? maxRunTokens > row.tokenBudget
        : false,
    }))
    .sort((a, b) => b.total - a.total || a.taskName.localeCompare(b.taskName));

  const matrices = new Map<string, MatrixAnalyticsRow>();
  for (const row of tasks) {
    if (!row.matrixParentId) continue;
    const key = row.matrixParentId.toLowerCase();
    const matrix = matrices.get(key) ?? {
      parentId: row.matrixParentId,
      clones: 0,
      total: 0,
      success: 0,
      error: 0,
      successRate: 0,
      tokens: 0,
      costUsd: 0,
    };
    matrix.clones += 1;
    matrix.total += row.total;
    matrix.success += row.success;
    matrix.error += row.error;
    matrix.tokens += row.tokens;
    matrix.costUsd += row.costUsd;
    matrices.set(key, matrix);
  }

  const daily = dayKeys.map((key) => {
    const bucket = dayBuckets.get(key)!;
    return {
      ...bucket,
      avgDurationMs: Math.round(bucket.avgDurationMs),
      costUsd: Math.round(bucket.costUsd * 1e6) / 1e6,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    totals: {
      total: totalsTotal,
      success: totalsSuccess,
      error: totalsError,
      partial: totalsPartial,
      successRate: percent(totalsSuccess, totalsTotal),
      avgDurationMs: durationsCount > 0 ? Math.round(durationsSum / durationsCount) : 0,
      tokens: totalsTokens,
      costUsd: Math.round(totalsCost * 1e6) / 1e6,
    },
    daily,
    tasks,
    topByCost: [...tasks].sort((a, b) => b.costUsd - a.costUsd).slice(0, topLimit),
    matrices: [...matrices.values()]
      .map((row) => ({
        ...row,
        successRate: percent(row.success, row.total),
        costUsd: Math.round(row.costUsd * 1e6) / 1e6,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...byModel.values()]
      .map((row) => ({ ...row, costUsd: Math.round(row.costUsd * 1e6) / 1e6 }))
      .sort((a, b) => b.costUsd - a.costUsd),
    errors: [...byError.values()]
      .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
      .slice(0, topLimit),
    savings: computeSavings(windowRecords, { topLimit }),
    sources: {
      historyRecords: records.length,
      recordsInWindow,
      topLimit,
    },
  };
}

/** Экранирование значения для CSV (RFC 4180). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = safeStringify(value);
  if (/[",\r\n;]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Заголовок CSV-экспорта истории. */
export const HISTORY_CSV_HEADER = [
  "startedAt",
  "finishedAt",
  "taskName",
  "status",
  "durationMs",
  "tokens",
  "costUsd",
  "model",
  "workspaceId",
  "error",
] as const;

/** История в CSV: точки с запятой как разделитель — дружелюбно к Excel (RU). */
export function historyToCsv(records: AnalyticsRecord[]): string {
  const rows = [HISTORY_CSV_HEADER.join(";")];
  for (const record of records) {
    rows.push(
      [
        record.startedAt,
        record.finishedAt ?? "",
        record.taskName,
        record.status,
        record.durationMs ?? "",
        record.tokens ?? "",
        record.costUsd ?? "",
        record.model ?? "",
        record.workspaceId ?? "",
        record.error ?? "",
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  // BOM, чтобы Excel корректно открыл UTF-8 с кириллицей.
  return `\uFEFF${rows.join("\r\n")}`;
}

// ---------------------------------------------------------------------------
// Экономика v2, Деталь 3.3: E-4.2 (Grafana JSON) и E-5.1 (local vs cloud).
// Обе функции чистые и детерминированные: без БД, HTTP, ОС и внешних пакетов.
// ---------------------------------------------------------------------------

/** E-4.2: канонические имена метрик, на которые ссылаются панели Grafana. */
export const GRAFANA_METRIC_NAMES = {
  spendUsd: "agent_steward_spend_usd_total",
  tokens: "agent_steward_tokens_total",
  efficiency: "agent_steward_token_efficiency_score",
} as const;

/**
 * Входные данные для дашборда. Поля необязательны: сюда можно передать и
 * результат `buildAnalytics()` (у него есть `windowDays`/`generatedAt`).
 * `generatedAt` намеренно НЕ попадает в JSON — функция детерминирована.
 */
export interface GrafanaDashboardInput {
  title?: string;
  windowDays?: number;
  generatedAt?: string;
}

export interface GrafanaTarget {
  refId: string;
  expr: string;
  legendFormat: string;
}

export interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  gridPos: { h: number; w: number; x: number; y: number };
  targets: GrafanaTarget[];
}

/** E-4.2: объект, пригодный для `JSON.stringify` без дополнительных реплайсеров. */
export interface GrafanaDashboard {
  uid: string;
  title: string;
  tags: string[];
  schemaVersion: number;
  editable: boolean;
  time: { from: string; to: string };
  templating: { list: unknown[] };
  panels: GrafanaPanel[];
}

/**
 * E-4.2: собирает детерминированный JSON дашборда Grafana с панелями расхода,
 * токенов и токен-эффективности. Три панели ссылаются на метрики через
 * `targets[].expr` (см. `GRAFANA_METRIC_NAMES`); порядок панелей и refId
 * фиксированы. Никаких внешних зависимостей и обращений к часам/сети.
 */
export function buildGrafanaDashboard(
  output: GrafanaDashboardInput = {},
): GrafanaDashboard {
  const source = output ?? {};
  const title =
    typeof source.title === "string" && source.title.trim()
      ? source.title.trim()
      : "Agent-steward — Экономика v2";
  const windowDays = Math.max(1, Math.floor(Number(source.windowDays) || 14));

  const panels: GrafanaPanel[] = [
    {
      id: 1,
      title: "Расход (USD)",
      type: "timeseries",
      gridPos: { h: 8, w: 8, x: 0, y: 0 },
      targets: [
        {
          refId: "A",
          expr: GRAFANA_METRIC_NAMES.spendUsd,
          legendFormat: "spend USD",
        },
      ],
    },
    {
      id: 2,
      title: "Токены",
      type: "timeseries",
      gridPos: { h: 8, w: 8, x: 8, y: 0 },
      targets: [
        {
          refId: "A",
          expr: GRAFANA_METRIC_NAMES.tokens,
          legendFormat: "tokens",
        },
      ],
    },
    {
      id: 3,
      title: "Token efficiency",
      type: "gauge",
      gridPos: { h: 8, w: 8, x: 16, y: 0 },
      targets: [
        {
          refId: "A",
          expr: GRAFANA_METRIC_NAMES.efficiency,
          legendFormat: "efficiency %",
        },
      ],
    },
  ];

  return {
    uid: "agent-steward-economics-v2",
    title,
    tags: ["agent-steward", "economics-v2", `window-${windowDays}d`],
    schemaVersion: 39,
    editable: true,
    time: { from: `now-${windowDays}d`, to: "now" },
    templating: { list: [] },
    panels,
  };
}

/** E-5.1: итоги по одному месту исполнения. */
export interface ExecutionPlaceTotals {
  runs: number;
  spentUsd: number;
  tokens: number;
}

/** E-5.1: разбивка запусков, стоимости и токенов по local/cloud. */
export interface LocalCloudSplit {
  local: ExecutionPlaceTotals;
  cloud: ExecutionPlaceTotals;
}

/**
 * Эвристика определения места исполнения (E-5.1), по порядку:
 *  1. Явное поле записи — `executionPlace`, `place`, `executor`, `target`
 *     или `runner` (первое непустое). Значения local/ollama/on-prem/lmstudio
 *     → local; cloud/remote/hosted/openai/anthropic/google/azure → cloud.
 *  2. Префикс модели: ollama/ local/ lmstudio/ localai/ и модели семейств
 *     llama/qwen/phi/gemma/mistral/deepseek/codellama → local; префиксы
 *     gpt-/o1-/o3-/claude-/gemini-/openai/ anthropic/ google/ azure/ bedrock/
 *     groq/ mistralai/ → cloud. Оллама-тег вида `qwen3:4b` → local.
 *  3. Неизвестная/пустая модель считается cloud (консервативно: цена есть).
 */
const CLOUD_MODEL_RE =
  /^(gpt-|o[134]-|claude-|gemini-|openai\/|anthropic\/|google\/|azure\/|bedrock\/|groq\/|mistralai\/|together\/)/;
const LOCAL_MODEL_RE =
  /^(ollama\/|local\/|lmstudio\/|localai\/|llama|qwen|phi|gemma|mistral|deepseek|codellama|falcon|vicuna)/;

function readExecutionPlace(record: AnalyticsRecord): string {
  const source = record as AnalyticsRecord & {
    executionPlace?: unknown;
    place?: unknown;
    executor?: unknown;
    target?: unknown;
    runner?: unknown;
  };
  for (const value of [
    source.executionPlace,
    source.place,
    source.executor,
    source.target,
    source.runner,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
  }
  return "";
}

function classifyExecutionPlace(record: AnalyticsRecord): "local" | "cloud" {
  const explicit = readExecutionPlace(record);
  if (explicit) {
    if (/\b(local|ollama|on[-_ ]?prem|self[-_ ]?hosted|lmstudio)\b/.test(explicit))
      return "local";
    if (/\b(cloud|remote|hosted|openai|anthropic|google|azure|bedrock)\b/.test(explicit))
      return "cloud";
  }
  const model = String(record.model ?? "").trim().toLowerCase();
  if (!model) return "cloud";
  if (CLOUD_MODEL_RE.test(model)) return "cloud";
  if (LOCAL_MODEL_RE.test(model)) return "local";
  if (model.includes(":")) return "local"; // Ollama-тег вида qwen3:4b
  return "cloud";
}

/**
 * E-5.1: разбивка завершённых запусков по месту исполнения. Запуски `running`
 * игнорируются; стоимость берётся через `recordCost` (явная цена либо оценка
 * по токенам, как в бюджете). Возвращаемые суммы округлены до 6 знаков.
 */
export function splitLocalCloud(records: AnalyticsRecord[]): LocalCloudSplit {
  const result: LocalCloudSplit = {
    local: { runs: 0, spentUsd: 0, tokens: 0 },
    cloud: { runs: 0, spentUsd: 0, tokens: 0 },
  };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.status === "running") continue;
    const bucket = result[classifyExecutionPlace(record)];
    bucket.runs += 1;
    bucket.tokens += toNumber(record.tokens);
    bucket.spentUsd += recordCost(record);
  }
  result.local.spentUsd = Math.round(result.local.spentUsd * 1e6) / 1e6;
  result.cloud.spentUsd = Math.round(result.cloud.spentUsd * 1e6) / 1e6;
  return result;
}
