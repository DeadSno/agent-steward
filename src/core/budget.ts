/**
 * Бюджеты день/неделя (Экономика v2, E-1.1).
 *
 * Чистые функции без БД, HTTP и ОС: расход считается из уже загруженной
 * истории запусков, лимиты задаются пользователем в settings.json.
 * Fail-open по умолчанию: выключенная группа или нулевой лимит никогда
 * не блокируют запуски — они только перестают проверяться.
 */
import { recordCost, type AnalyticsRecord } from "./analytics.js";

export type BudgetPeriod = "day" | "week";

/** Лимиты в USD. 0 означает «без лимита» (fail-open). */
export interface BudgetSettings {
  /** Включён ли учёт/проверка бюджетов. */
  enabled: boolean;
  /** Лимит на один UTC-день, USD (0 — без лимита). */
  dailyUsd: number;
  /** Лимит на одну UTC-неделю (с понедельника), USD (0 — без лимита). */
  weeklyUsd: number;
}

export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {
  enabled: false,
  dailyUsd: 0,
  weeklyUsd: 0,
};

export function defaultBudgetSettings(): BudgetSettings {
  return { ...DEFAULT_BUDGET_SETTINGS };
}

/** Учёт одного периода: потрачено, осталось, достигнут ли лимит. */
export interface BudgetUsage {
  period: BudgetPeriod;
  /** Начало периода в UTC, ISO-строка. */
  periodStart: string;
  /** Конечный лимит, USD (0 — лимит выключен). */
  limitUsd: number;
  /** Потрачено завершёнными запусками в периоде, USD. */
  spentUsd: number;
  /** Сколько запусков попало в период. */
  runs: number;
  /** Остаток; 0, если лимит выключен или уже исчерпан. */
  remainingUsd: number;
  /** Доля расхода от лимита (0, если лимит выключен). Может быть > 1. */
  ratio: number;
  /** Лимит включён и расход достиг/превысил его. */
  exceeded: boolean;
  /**
   * Проверка не активна: группа выключена глобально или лимит равен нулю.
   * По умолчанию true — fail-open.
   */
  disabled: boolean;
}

export interface BudgetReport {
  generatedAt: string;
  enabled: boolean;
  day: BudgetUsage;
  week: BudgetUsage;
  /** Хотя бы один включённый лимит достигнут/превышен. */
  exceeded: boolean;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Начало UTC-дня, в котором находится `now`. */
export function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Начало UTC-недели (понедельник 00:00), в которой находится `now`. */
export function startOfUtcWeek(now: Date): Date {
  const day = startOfUtcDay(now);
  const weekday = day.getUTCDay(); // 0 = воскресенье
  const mondayOffset = weekday === 0 ? 6 : weekday - 1;
  return new Date(day.getTime() - mondayOffset * 24 * 60 * 60 * 1000);
}

function periodLimit(settings: BudgetSettings, period: BudgetPeriod): number {
  const raw = period === "day" ? settings.dailyUsd : settings.weeklyUsd;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function computeUsage(
  records: AnalyticsRecord[],
  settings: BudgetSettings,
  period: BudgetPeriod,
  start: Date,
  now: Date,
): BudgetUsage {
  const startMs = start.getTime();
  const endMs = now.getTime();
  let spent = 0;
  let runs = 0;

  for (const record of records) {
    // Незавершённые запуски ещё нельзя оценить — как и в buildAnalytics.
    if (record.status === "running") continue;
    // Расход относится к моменту завершения: запуск, начатый до полуночи,
    // но закончившийся внутри периода, должен попасть именно в этот период.
    // Для старых записей без finishedAt сохраняем прежнюю атрибуцию по startedAt.
    const finishedMs = record.finishedAt
      ? new Date(record.finishedAt).getTime()
      : NaN;
    const startedMs = new Date(record.startedAt).getTime();
    const time = Number.isFinite(finishedMs) ? finishedMs : startedMs;
    if (!Number.isFinite(time) || time < startMs || time > endMs) continue;
    spent += recordCost(record);
    runs += 1;
  }

  const limitUsd = periodLimit(settings, period);
  const spentUsd = roundUsd(spent);
  const disabled = !settings.enabled || limitUsd <= 0;
  const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
  return {
    period,
    periodStart: start.toISOString(),
    limitUsd,
    spentUsd,
    runs,
    remainingUsd: disabled ? 0 : roundUsd(Math.max(0, limitUsd - spentUsd)),
    ratio: disabled ? 0 : Math.round(ratio * 1e6) / 1e6,
    exceeded: !disabled && spentUsd >= limitUsd,
    disabled,
  };
}

/**
 * Считает расход за текущий UTC-день и UTC-неделю (с понедельника).
 * Запуск относится к периоду по времени завершения (`finishedAt`, при
 * отсутствии — `startedAt`); даты вне периода и статус `running` игнорируются.
 */
export function buildBudgetReport(
  records: AnalyticsRecord[],
  settings: BudgetSettings = DEFAULT_BUDGET_SETTINGS,
  now: Date = new Date(),
): BudgetReport {
  const day = computeUsage(records, settings, "day", startOfUtcDay(now), now);
  const week = computeUsage(records, settings, "week", startOfUtcWeek(now), now);
  return {
    generatedAt: now.toISOString(),
    enabled: settings.enabled,
    day,
    week,
    exceeded: day.exceeded || week.exceeded,
  };
}

/** Причина решения гейта запуска. */
export type BudgetGateReason =
  | "disabled"
  | "within_limit"
  | "day_exceeded"
  | "week_exceeded";

/** Решение: можно ли начинать новый запуск. */
export interface BudgetGateDecision {
  allowed: boolean;
  reason: BudgetGateReason;
  /** Какой лимит сработал (только при exceeded). */
  period?: BudgetPeriod;
  report: BudgetReport;
}

/**
 * E-1.2: авто-пауза при превышении лимита.
 *
 * Fail-open: если группа выключена или оба лимита нулевые, запуски не
 * блокируются. Иначе новый запуск пропускается, как только расход за
 * текущий день/неделю достиг лимита. Дневной лимит проверяется первым.
 */
export function evaluateBudgetGate(
  records: AnalyticsRecord[],
  settings: BudgetSettings = DEFAULT_BUDGET_SETTINGS,
  now: Date = new Date(),
): BudgetGateDecision {
  const report = buildBudgetReport(records, settings, now);
  if (!settings.enabled || (report.day.disabled && report.week.disabled)) {
    return { allowed: true, reason: "disabled", report };
  }
  if (report.day.exceeded) {
    return { allowed: false, reason: "day_exceeded", period: "day", report };
  }
  if (report.week.exceeded) {
    return { allowed: false, reason: "week_exceeded", period: "week", report };
  }
  return { allowed: true, reason: "within_limit", report };
}

/** Человекочитаемая причина пропуска; пустая строка, если запуск разрешён. */
export function formatBudgetSkipMessage(decision: BudgetGateDecision): string {
  if (decision.allowed) return "";
  const usage =
    decision.period === "week" ? decision.report.week : decision.report.day;
  const label = decision.period === "week" ? "weekly" : "daily";
  return `Budget limit exceeded: ${label} spend $${usage.spentUsd.toFixed(2)} of $${usage.limitUsd.toFixed(2)} — run skipped.`;
}

/**
 * E-1.3: текст алерта о превышении бюджета. Пустая строка, если лимит не
 * превышен. Отличается от сообщения о пропуске запуска (E-1.2) тем, что
 * явно сообщает об остановке всех новых запусков.
 */
export function formatBudgetAlertMessage(decision: BudgetGateDecision): string {
  if (decision.allowed) return "";
  const usage =
    decision.period === "week" ? decision.report.week : decision.report.day;
  const label = decision.period === "week" ? "Weekly" : "Daily";
  return `⚠️ Agent-steward budget alert: ${label} spend $${usage.spentUsd.toFixed(2)} of $${usage.limitUsd.toFixed(2)} — new runs are paused.`;
}

/**
 * E-2.2: гейт токен-бюджета одной задачи (per-task token budget).
 *
 * Лимит задаётся в определении задачи (`tokenBudget`, токены на один запуск).
 * Если какой-либо завершённый прогон задачи в текущем UTC-дне/неделе превысил
 * лимит, новые запуски пропускаются до начала следующего периода — та же
 * логика, что у глобального бюджетного гейта E-1.2, но в разрезе одной задачи.
 * Fail-open: лимит 0/undefined отключает проверку, запуски не блокируются.
 */
export type TaskTokenBudgetReason =
  | "no_budget"
  | "within_limit"
  | "day_exceeded"
  | "week_exceeded";

export interface TaskTokenBudgetDecision {
  allowed: boolean;
  reason: TaskTokenBudgetReason;
  taskName: string;
  tokenBudget: number;
  /** Максимум токенов за один прогон в сработавшем периоде. */
  maxRunTokens: number;
  period?: BudgetPeriod;
}

function normalizeTokenBudget(value: number | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function maxRunTokensInWindow(
  records: AnalyticsRecord[],
  taskKey: string,
  startMs: number,
  endMs: number,
): number {
  let max = 0;
  for (const record of records) {
    if (record.status === "running") continue;
    if ((record.taskName ?? "").trim().toLowerCase() !== taskKey) continue;
    // Расход относится к моменту завершения (как и в глобальном бюджете):
    // запуск, начатый в прошлом периоде, но закончившийся в текущем, учитывается
    // именно в текущем. Для легаси-записей без finishedAt — по startedAt.
    const finishedMs = record.finishedAt
      ? new Date(record.finishedAt).getTime()
      : NaN;
    const startedMs = new Date(record.startedAt).getTime();
    const time = Number.isFinite(finishedMs) ? finishedMs : startedMs;
    if (!Number.isFinite(time) || time < startMs || time > endMs) continue;
    const tokens = Number(record.tokens);
    if (Number.isFinite(tokens) && tokens > max) max = tokens;
  }
  return max;
}

/**
 * Решение гейта персонального токен-бюджета задачи.
 *
 * Источник данных — уже загруженная история (`getHistoryForBudget`). Как и в
 * аналитике (QA-B.1), превышение считается по одному прогону, а не по сумме за
 * период; дневное окно проверяется первым (как дневной лимит в E-1.2).
 */
export function evaluateTaskTokenBudgetGate(
  records: AnalyticsRecord[],
  taskName: string,
  tokenBudget: number | undefined,
  now: Date = new Date(),
): TaskTokenBudgetDecision {
  const budget = normalizeTokenBudget(tokenBudget);
  const key = (taskName ?? "").trim().toLowerCase();
  const base: TaskTokenBudgetDecision = {
    allowed: true,
    reason: budget > 0 ? "within_limit" : "no_budget",
    taskName,
    tokenBudget: budget,
    maxRunTokens: 0,
  };
  if (!budget || !key) return base;

  const endMs = now.getTime();
  const dayMax = maxRunTokensInWindow(
    records,
    key,
    startOfUtcDay(now).getTime(),
    endMs,
  );
  if (dayMax > budget) {
    return {
      ...base,
      allowed: false,
      reason: "day_exceeded",
      maxRunTokens: dayMax,
      period: "day",
    };
  }
  const weekMax = maxRunTokensInWindow(
    records,
    key,
    startOfUtcWeek(now).getTime(),
    endMs,
  );
  if (weekMax > budget) {
    return {
      ...base,
      allowed: false,
      reason: "week_exceeded",
      maxRunTokens: weekMax,
      period: "week",
    };
  }
  return { ...base, maxRunTokens: Math.max(dayMax, weekMax) };
}

/** Человекочитаемая причина пропуска; пустая строка, если запуск разрешён. */
export function formatTaskTokenBudgetSkipMessage(
  decision: TaskTokenBudgetDecision,
): string {
  if (decision.allowed) return "";
  const period = decision.period === "week" ? "weekly" : "daily";
  return `Task token budget exceeded: "${decision.taskName}" used ${decision.maxRunTokens} tokens in one run (${period} limit ${decision.tokenBudget}) — run skipped.`;
}

// ---------------------------------------------------------------------------
// Экономика v2, Деталь 3.3: E-3.1 (token efficiency) и E-4.1 (forecast).
// Обе функции чистые: только уже загруженная история, без БД/HTTP/ОС.
// ---------------------------------------------------------------------------

/** Статусы завершённых запусков, токены которых потрачены впустую. */
const WASTED_TOKEN_STATUSES = new Set(["error", "aborted"]);

function nonNegativeTokens(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Доля токенов, не потраченных впустую, в процентах (0..100). */
function tokensEfficiency(totalTokens: number, wastedTokens: number): number {
  if (totalTokens <= 0) return 0;
  return roundScore(((totalTokens - wastedTokens) / totalTokens) * 100);
}

/** Эффективность одной модели (E-3.1). */
export interface ModelEfficiencyRow {
  model: string;
  runs: number;
  usefulRuns: number;
  totalTokens: number;
  wastedTokens: number;
  /** Процент токенов, не потраченных впустую (0..100). */
  score: number;
}

/** E-3.1: метрика токен-эффективности по всей истории и в разрезе моделей. */
export interface TokenEfficiencyScore {
  /** Процент «полезных» токенов (0..100); 0, если данных нет (fail-open). */
  score: number;
  /** Все завершённые запуски. */
  runs: number;
  /** Запуски со статусом success. */
  usefulRuns: number;
  /** Сумма токенов завершённых запусков. */
  totalTokens: number;
  /** Токены запусков со статусом error/aborted. */
  wastedTokens: number;
  /** Разбивка по моделям; ключи отсортированы для детерминизма. */
  scoreByModel: Record<string, ModelEfficiencyRow>;
}

/**
 * E-3.1: оценка токен-эффективности по уже загруженным записям.
 *
 * Методика (детерминированная, без округления «на глаз»):
 *  - учитываются только завершённые записи (не `running`);
 *  - `usefulRuns` — запуски со статусом `success`;
 *  - `wastedTokens` — токены запусков со статусом `error`/`aborted`;
 *  - `score = (totalTokens - wastedTokens) / totalTokens * 100`, округление
 *    до 2 знаков; при отсутствии токенов score = 0.
 *
 * Fail-open: пустой список, только незавершённые записи и записи без валидных
 * токенов дают нули и пустой `scoreByModel` — без NaN/Infinity и без выбросов.
 */
export function tokenEfficiencyScore(
  records: AnalyticsRecord[],
): TokenEfficiencyScore {
  const list = Array.isArray(records) ? records : [];
  const byModel = new Map<string, ModelEfficiencyRow>();
  let runs = 0;
  let usefulRuns = 0;
  let totalTokens = 0;
  let wastedTokens = 0;

  for (const record of list) {
    if (!record || record.status === "running") continue;
    const status = String(record.status ?? "");
    const model = String(record.model ?? "").trim() || "(default)";
    const tokens = nonNegativeTokens(record.tokens);
    const wasted = WASTED_TOKEN_STATUSES.has(status) ? tokens : 0;

    runs += 1;
    totalTokens += tokens;
    wastedTokens += wasted;
    if (status === "success") usefulRuns += 1;

    const row = byModel.get(model) ?? {
      model,
      runs: 0,
      usefulRuns: 0,
      totalTokens: 0,
      wastedTokens: 0,
      score: 0,
    };
    row.runs += 1;
    row.totalTokens += tokens;
    row.wastedTokens += wasted;
    if (status === "success") row.usefulRuns += 1;
    byModel.set(model, row);
  }

  const scoreByModel: Record<string, ModelEfficiencyRow> = {};
  for (const model of [...byModel.keys()].sort((a, b) => a.localeCompare(b))) {
    const row = byModel.get(model)!;
    scoreByModel[model] = {
      ...row,
      score: tokensEfficiency(row.totalTokens, row.wastedTokens),
    };
  }

  return {
    score: tokensEfficiency(totalTokens, wastedTokens),
    runs,
    usefulRuns,
    totalTokens,
    wastedTokens,
    scoreByModel,
  };
}

/** Уверенность прогноза расхода (E-4.1). */
export type ForecastConfidence = "low" | "medium" | "high";

/** E-4.1: линейный прогноз расхода на следующий период. */
export interface SpendForecast {
  /** Прогноз расхода на ближайшие `days` дней, USD. */
  projectedUsd: number;
  /** Средний расход за день в окне, USD. */
  dailyRateUsd: number;
  /** Сколько завершённых запусков попало в окно. */
  basedOnRuns: number;
  /** Плотность истории: low / medium / high. */
  confidence: ForecastConfidence;
}

/**
 * E-4.1: линейный прогноз затрат по завершённым запускам за последние N дней.
 *
 * Окно — `[now - days * 24h, now]`; расход относится ко времени завершения
 * (`finishedAt`, для легаси — `startedAt`), как и в `buildBudgetReport`.
 * `dailyRateUsd = spent / days`, `projectedUsd = dailyRateUsd * days`
 * (прогноз на следующий период той же длины). Все суммы округляются до 6
 * знаков, деление на ноль исключено.
 *
 * Fail-open: пустая история/все `running`/невалидные даты дают нули и
 * `confidence: "low"` — без NaN и Infinity.
 */
export function forecastSpend(
  records: AnalyticsRecord[],
  days = 7,
  now = new Date(),
): SpendForecast {
  const windowDays = Math.max(1, Math.floor(Number(days) || 7));
  const endMs =
    now instanceof Date && Number.isFinite(now.getTime())
      ? now.getTime()
      : Date.now();
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1000;
  let spent = 0;
  let basedOnRuns = 0;

  for (const record of Array.isArray(records) ? records : []) {
    if (!record || record.status === "running") continue;
    const finishedMs = record.finishedAt
      ? new Date(record.finishedAt).getTime()
      : NaN;
    const startedMs = new Date(record.startedAt).getTime();
    const time = Number.isFinite(finishedMs) ? finishedMs : startedMs;
    if (!Number.isFinite(time) || time < startMs || time > endMs) continue;
    const cost = recordCost(record);
    if (!Number.isFinite(cost)) continue;
    spent += cost;
    basedOnRuns += 1;
  }

  const dailyRateUsd = roundUsd(spent / windowDays);
  const projectedUsd = roundUsd(dailyRateUsd * windowDays);
  let confidence: ForecastConfidence = "low";
  if (basedOnRuns >= windowDays * 2) confidence = "high";
  else if (basedOnRuns >= Math.max(1, Math.ceil(windowDays / 2)))
    confidence = "medium";

  return { projectedUsd, dailyRateUsd, basedOnRuns, confidence };
}
