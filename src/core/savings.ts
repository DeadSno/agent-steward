/**
 * Счётчик «сэкономлено $» (Спринт 31.6).
 *
 * Метод — контрфактика по истории: запуски, которые потратили токены, но не
 * записали стоимость (локальная модель, подписка, неизвестная цена), считаются
 * так, как если бы те же токены обрабатывались по эталонной облачной цене.
 * Это ОЦЕНКА, а не бухгалтерия: она не видит кеш, повторные запросы и скидки.
 *
 * Модуль чистый (без БД и HTTP), поэтому методику легко проверить тестом на
 * фиксированных данных.
 */

/** Эталонная облачная цена за 1k токенов (вход+выход, смешанно), USD. */
export const CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD = 0.01;

/** Ссылка на методику — её показывают GUI и дашборд рядом с оценкой. */
export const SAVINGS_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/SAVINGS.md#methodology";

/** Минимальный вид записи истории, нужный счётчику экономии. */
export interface SavingsRecord {
  taskName: string;
  status: string;
  startedAt: string;
  tokens?: number | null;
  costUsd?: number | null;
  model?: string | null;
}

/** Экономия по одной задаче. */
export interface SavingsTaskRow {
  taskName: string;
  /** Сколько запусков попало в контрфактику. */
  runs: number;
  /** Сколько токенов эти запуски потратили. */
  tokens: number;
  /** Оценка экономии, USD. */
  savedUsd: number;
}

export interface SavingsReport {
  /** Всегда "estimate": счётчик показывает оценку, а не факт. */
  kind: "estimate";
  /** Эталонная цена, на которой построена оценка. */
  referenceCostPer1kTokensUsd: number;
  /** Ссылка на описание методики. */
  methodologyUrl: string;
  /** Запусков, попавших в контрфактику (токены есть, стоимость не записана). */
  runs: number;
  /** Токенов в этих запусках. */
  tokens: number;
  /** Оценка экономии, USD. */
  savedUsd: number;
  /** Фактически записанная стоимость этих же запусков (обычно 0). */
  actualCostUsd: number;
  /** Полная записанная стоимость всех запусков окна — для контекста. */
  totalCostUsd: number;
  /** Разбивка по задачам, самые экономные сверху. */
  byTask: SavingsTaskRow[];
}

export interface ComputeSavingsOptions {
  /** Эталонная цена за 1k токенов; по умолчанию 0.01 USD. */
  referenceCostPer1kTokensUsd?: number;
  /** Сколько строк оставить в разбивке по задачам (по умолчанию 10). */
  topLimit?: number;
}

function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Считает оценку экономии по записям истории.
 *
 * Запуск попадает в контрфактику, если он потратил токены и при этом не
 * записал стоимость (`costUsd` пустой или 0). Такие запуски обычно означают
 * локальную модель или уже оплаченную подписку — деньги за токены не списаны,
 * но при облачном провайдере они бы стоили `tokens / 1000 * reference`.
 */
export function computeSavings(
  records: SavingsRecord[],
  options: ComputeSavingsOptions = {},
): SavingsReport {
  const reference = positiveNumber(options.referenceCostPer1kTokensUsd)
    || CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD;
  const topLimit = Math.max(1, Math.floor(options.topLimit ?? 10));

  let runs = 0;
  let tokens = 0;
  let savedUsd = 0;
  let actualCostUsd = 0;
  let totalCostUsd = 0;
  const byTask = new Map<string, SavingsTaskRow>();

  for (const record of records) {
    const recordTokens = positiveNumber(record.tokens);
    const recordCost = positiveNumber(record.costUsd);
    totalCostUsd += recordCost;

    // Незавершённые запуски не оцениваем: их стоимость ещё не финальна.
    if (String(record.status ?? "") === "running") continue;
    if (recordTokens <= 0 || recordCost > 0) continue;

    const saved = (recordTokens / 1000) * reference;
    runs += 1;
    tokens += recordTokens;
    savedUsd += saved;
    actualCostUsd += recordCost;

    const key = record.taskName || "(без имени)";
    const row = byTask.get(key) ?? {
      taskName: key,
      runs: 0,
      tokens: 0,
      savedUsd: 0,
    };
    row.runs += 1;
    row.tokens += recordTokens;
    row.savedUsd += saved;
    byTask.set(key, row);
  }

  const rows = [...byTask.values()]
    .sort((a, b) => b.savedUsd - a.savedUsd || a.taskName.localeCompare(b.taskName))
    .slice(0, topLimit)
    .map((row) => ({
      taskName: row.taskName,
      runs: row.runs,
      tokens: row.tokens,
      savedUsd: roundUsd(row.savedUsd),
    }));

  return {
    kind: "estimate",
    referenceCostPer1kTokensUsd: reference,
    methodologyUrl: SAVINGS_METHODOLOGY_URL,
    runs,
    tokens,
    savedUsd: roundUsd(savedUsd),
    actualCostUsd: roundUsd(actualCostUsd),
    totalCostUsd: roundUsd(totalCostUsd),
    byTask: rows,
  };
}
