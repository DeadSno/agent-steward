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
    const time = new Date(record.startedAt).getTime();
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
 * Даты вне периода и записи со статусом `running` игнорируются.
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
