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
 *
 * SC-1.1: в оценку включена стоимость проверок (gate/eval). Повторные проверки
 * с тем же gate+prompt+inputs попадают в ограниченный кэш и платятся один раз —
 * иначе net-экономия завышалась бы на каждый повтор.
 */
import { createHash } from "node:crypto";

/** Эталонная облачная цена за 1k токенов (вход+выход, смешанно), USD. */
export const CLOUD_REFERENCE_COST_PER_1K_TOKENS_USD = 0.01;

/** Консервативная оценка стоимости одной уникальной проверки (gate/eval), USD. */
export const VERIFICATION_COST_PER_CHECK_USD = 0.002;

/** Максимум записей в детерминированном кэше проверок (вытеснение oldest-first). */
export const VERIFICATION_CACHE_MAX_ENTRIES = 256;

/** Ссылка на методику — её показывают GUI и дашборд рядом с оценкой. */
export const SAVINGS_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/SAVINGS.md#methodology";

/** Один вход проверки (objective gate / eval). */
export interface VerificationCheck {
  /** Стабильный идентификатор гейта. */
  gate?: string | null;
  /** Стабильный идентификатор промпта. */
  prompt?: string | null;
  /** Остальные входные данные проверки (любая структура). */
  inputs?: unknown;
}

/** Сведение о кэше проверок: повторы с тем же входом платятся один раз. */
export interface VerificationCacheStats {
  /** Всего предъявлено проверок. */
  checks: number;
  /** Уникальных входов в кэше после вытеснений. */
  unique: number;
  /** Повторов с уже виденным входом. */
  hits: number;
  /** Первых входов (стоимость начислена). */
  misses: number;
  /** Вытеснено oldest-first при достижении лимита. */
  evicted: number;
  /** Итоговая стоимость уникальных проверок, USD. */
  costUsd: number;
}

/**
 * Детерминированный канонический JSON: порядок ключей не влияет на хэш.
 * undefined и null оба сериализуются в JSON null: это отсутствие значения,
 * а не два разных входа. Порядок ключей объектов на хэш не влияет.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/** Стабильный ключ проверки: SHA-256 от gate + prompt + inputs. */
export function verificationCheckKey(check: VerificationCheck): string {
  const canonical = stableStringify({
    gate: check.gate ?? "",
    prompt: check.prompt ?? "",
    inputs: check.inputs ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Считает стоимость проверок с ограниченным кэшем повторов.
 *
 * Один и тот же вход (gate+prompt+inputs) начисляется один раз: повтор — hit.
 * Разные входы начисляются отдельно. При достижении лимита вытесняется самая
 * старая запись (Map сохраняет порядок вставки), поэтому результат полностью
 * детерминирован последовательностью входов.
 */
export function computeVerificationBudget(
  checks: readonly VerificationCheck[] = [],
  options: { costPerCheckUsd?: number; maxEntries?: number } = {},
): VerificationCacheStats {
  const costPerCheck = positiveNumber(options.costPerCheckUsd) || VERIFICATION_COST_PER_CHECK_USD;
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? VERIFICATION_CACHE_MAX_ENTRIES));
  const seen = new Map<string, true>();
  let hits = 0;
  let misses = 0;
  let evicted = 0;
  let costUsd = 0;
  for (const check of checks ?? []) {
    const key = verificationCheckKey(check);
    if (seen.has(key)) {
      hits += 1;
      continue;
    }
    if (seen.size >= maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
        evicted += 1;
      }
    }
    seen.set(key, true);
    misses += 1;
    costUsd += costPerCheck;
  }
  return {
    checks: checks.length,
    unique: seen.size,
    hits,
    misses,
    evicted,
    costUsd: roundUsd(costUsd),
  };
}

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
  /**
   * SC-1.1: стоимость уникальных проверок (gate/eval) — вычитается из net.
   * Повторы с тем же входом в кэше не платятся повторно.
   */
  verificationCostUsd: number;
  /** SC-1.1: сведение о кэше проверок (hits/misses/unique/evicted). */
  verificationCache: VerificationCacheStats;
  /** SC-1.1: честная net-экономия = savedUsd - totalCostUsd - verificationCostUsd. */
  netEconomyUsd: number;
  /** Разбивка по задачам, самые экономные сверху. */
  byTask: SavingsTaskRow[];
}

export interface ComputeSavingsOptions {
  /** Эталонная цена за 1k токенов; по умолчанию 0.01 USD. */
  referenceCostPer1kTokensUsd?: number;
  /** Сколько строк оставить в разбивке по задачам (по умолчанию 10). */
  topLimit?: number;
  /** SC-1.1: проверки, стоимость которых нужно учесть (дедуп по входу). */
  verificationChecks?: readonly VerificationCheck[];
  /** Цена одной уникальной проверки, USD (по умолчанию 0.002). */
  verificationCostPerCheckUsd?: number;
  /** Лимит записей кэша проверок (по умолчанию 256). */
  verificationCacheMaxEntries?: number;
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
  const verificationCache = computeVerificationBudget(options.verificationChecks ?? [], {
    costPerCheckUsd: options.verificationCostPerCheckUsd,
    maxEntries: options.verificationCacheMaxEntries,
  });
  const verificationCostUsd = verificationCache.costUsd;

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
    verificationCostUsd,
    verificationCache,
    netEconomyUsd: roundUsd(savedUsd - totalCostUsd - verificationCostUsd),
    byTask: rows,
  };
}
