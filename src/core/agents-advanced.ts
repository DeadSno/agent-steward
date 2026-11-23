/**
 * M-5..M-8: детерминированные примитивы расширенной оркестрации.
 *
 * Чистые функции: без сети, БД, таймеров, системных часов и новых зависимостей.
 * Одинаковый вход всегда даёт одинаковый выход. Секреты в память между
 * прогонами не попадают: сохраняются только хеш идентификатора и числовые
 * метрики из фиксированного списка. SCHEMA_VERSION и счётчики инструментов/RPC
 * не затрагиваются.
 */

/* ------------------------------------------------------------------------- *
 * Общие помощники.
 * ------------------------------------------------------------------------- */

function asArray<T>(value: unknown): readonly T[] | null {
  return Array.isArray(value) ? (value as readonly T[]) : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------------- *
 * M-5.1: турнир моделей/промптов.
 * ------------------------------------------------------------------------- */

/** Кандидат: строка (имя модели/промпта) или объект с идентификатором. */
export type TournamentCandidate = string | { id?: unknown; [key: string]: unknown };

/** Одна строка таблицы результатов. */
export interface TournamentRow {
  id: string;
  score: number;
  rank: number;
}

/** Итог турнира: победитель и детерминированно отсортированная таблица. */
export interface TournamentResult {
  winner: string | null;
  results: TournamentRow[];
}

/** Оценка приходит снаружи; функция не знает ни моделей, ни промптов. */
export type TournamentScoreFn = (candidate: TournamentCandidate, index: number) => number;

function candidateId(candidate: TournamentCandidate, index: number): string {
  if (typeof candidate === "string") return candidate;
  if (candidate && typeof candidate === "object") {
    for (const key of ["id", "name", "model", "prompt", "label"]) {
      const value = candidate[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return `#${index}`;
}

/**
 * M-5.1: сравнивает кандидатов с помощью переданной `scoreFn`.
 *
 * Победитель — первый после сортировки: большее число баллов, при равенстве
 * лексикографически меньший идентификатор. Нечисловой балл или исключение
 * `scoreFn` дают балл 0 (fail-open). Дубликаты идентификаторов отбрасываются
 * по первому вхождению; входные аргументы не мутируются.
 */
export function tournament(
  candidates: readonly TournamentCandidate[] | null | undefined,
  scoreFn: TournamentScoreFn | null | undefined,
): TournamentResult {
  const list = asArray<TournamentCandidate>(candidates);
  if (!list || typeof scoreFn !== "function") return { winner: null, results: [] };

  const seen = new Set<string>();
  const rows: TournamentRow[] = [];
  list.forEach((candidate, index) => {
    const id = candidateId(candidate, index);
    if (seen.has(id)) return;
    seen.add(id);
    let score = 0;
    try {
      score = finiteOrNull(scoreFn(candidate, index)) ?? 0;
    } catch {
      score = 0;
    }
    rows.push({ id, score, rank: 0 });
  });

  rows.sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return { winner: rows[0]?.id ?? null, results: rows };
}

/* ------------------------------------------------------------------------- *
 * M-6.1: минимальный CEP без фоновых таймеров.
 * ------------------------------------------------------------------------- */

/** Событие: строка-тип или объект с полем type/name/kind/event. */
export type EventInput =
  | string
  | { type?: unknown; name?: unknown; kind?: unknown; event?: unknown; [key: string]: unknown }
  | null
  | undefined;

export type EventPatternKind = "sequence" | "window" | "aggregate";

/** Описание шаблона: последовательность, окно или агрегат. */
export interface EventPattern {
  kind?: string | null;
  /** Типы событий в ожидаемом порядке. */
  sequence?: readonly string[] | null;
  /** Для aggregate — фильтр типов (по умолчанию все). */
  types?: readonly string[] | null;
  /** Максимальное число событий между первым и последним (включительно). */
  window?: number | null;
  /** Числовое поле для агрегата (по умолчанию "value"). */
  field?: string | null;
  /** sum | avg | count | min | max (по умолчанию sum). */
  aggregate?: string | null;
  /** Нижняя и верхняя границы результата агрегата. */
  min?: number | null;
  max?: number | null;
}

/** Результат сопоставления: индексы событий и значение агрегата. */
export interface EventPatternResult {
  matched: boolean;
  indices: number[];
  aggregate: number | null;
}

function eventType(event: EventInput): string {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    for (const key of ["type", "name", "kind", "event"]) {
      const value = event[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return "";
}

function patternTypes(types: readonly string[] | null | undefined): string[] {
  const list = asArray<unknown>(types);
  if (!list) return [];
  return list.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function noMatch(): EventPatternResult {
  return { matched: false, indices: [], aggregate: null };
}

/**
 * M-6.1: ищет первое совпадение шаблона в последовательности событий.
 *
 * `sequence` — подряд идущие типы; `window` — те же типы в порядке, но с
 * разрывами в пределах окна; `aggregate` — sum/avg/count/min/max по числовому
 * полю с необязательными порогами `min`/`max`. Пустые входы и невалидный
 * шаблон дают `matched: false`. Никаких таймеров и фоновой обработки нет.
 */
export function matchEventPattern(
  events: readonly EventInput[] | null | undefined,
  pattern: EventPattern | null | undefined,
): EventPatternResult {
  const list = asArray<EventInput>(events);
  if (!list || !pattern || typeof pattern !== "object") return noMatch();
  const types = patternTypes(pattern.sequence ?? pattern.types);
  if (types.length === 0) return noMatch();

  const window = finiteOrNull(pattern.window);
  const spanLimit = window !== null && window >= 1 ? Math.trunc(window) : list.length;
  const kind = typeof pattern.kind === "string" ? pattern.kind : "sequence";

  if (kind === "aggregate") {
    const field = typeof pattern.field === "string" && pattern.field ? pattern.field : "value";
    let filter = patternTypes(pattern.types);
    if (filter.length === 0) filter = types;
    const values: number[] = [];
    const indices: number[] = [];
    list.forEach((event, index) => {
      const type = eventType(event);
      if (filter.length > 0 && !filter.includes(type)) return;
      if (event === null || typeof event !== "object") return;
      const value = finiteOrNull((event as Record<string, unknown>)[field]);
      if (value === null) return;
      indices.push(index);
      values.push(value);
    });
    const op = typeof pattern.aggregate === "string" ? pattern.aggregate : "sum";
    let aggregate: number | null = 0;
    if (op === "count") aggregate = values.length;
    else if (values.length > 0) {
      if (op === "avg") aggregate = values.reduce((a, b) => a + b, 0) / values.length;
      else if (op === "min") aggregate = Math.min(...values);
      else if (op === "max") aggregate = Math.max(...values);
      else aggregate = values.reduce((a, b) => a + b, 0);
    } else aggregate = null;
    const low = finiteOrNull(pattern.min);
    const high = finiteOrNull(pattern.max);
    const matched =
      aggregate !== null &&
      (low === null || aggregate >= low) &&
      (high === null || aggregate <= high);
    return { matched, indices, aggregate };
  }

  if (kind === "window") {
    for (let start = 0; start < list.length; start += 1) {
      if (eventType(list[start]) !== types[0]) continue;
      const indices: number[] = [start];
      let position = start;
      for (let t = 1; t < types.length; t += 1) {
        let next = -1;
        for (let i = position + 1; i < list.length; i += 1) {
          if (eventType(list[i]) === types[t]) {
            next = i;
            break;
          }
        }
        if (next < 0 || next - start + 1 > spanLimit) break;
        indices.push(next);
        position = next;
      }
      if (indices.length === types.length) return { matched: true, indices, aggregate: null };
    }
    return noMatch();
  }

  // sequence: только подряд идущие события.
  for (let start = 0; start + types.length <= list.length; start += 1) {
    let ok = true;
    for (let t = 0; t < types.length; t += 1) {
      if (eventType(list[start + t]) !== types[t]) {
        ok = false;
        break;
      }
    }
    if (!ok || types.length > spanLimit) continue;
    const indices = types.map((_, offset) => start + offset);
    return { matched: true, indices, aggregate: null };
  }
  return noMatch();
}

/* ------------------------------------------------------------------------- *
 * M-7.1: память между прогонами.
 * ------------------------------------------------------------------------- */

/** Число записей по умолчанию; 0 означает пустую память. */
export const DEFAULT_MEMORY_LIMIT = 8;

/** Множитель затухания за один новый прогон. */
export const MEMORY_DECAY_FACTOR = 0.5;

/** Разрешённые числовые метрики — произвольные строки не сохраняются. */
export const MEMORY_METRIC_KEYS = [
  "attempts",
  "confidence",
  "duration",
  "durationMs",
  "errors",
  "latency",
  "latencyMs",
  "retries",
  "score",
  "steps",
  "success",
  "tokens",
] as const;

/** Запись прогона. Любые лишние поля (включая секреты) игнорируются. */
export interface RunMemoryRecord {
  runId?: string | number | null;
  hash?: string | null;
  metrics?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Обезличенная запись в памяти. */
export interface RunMemoryEntry {
  hash: string;
  metrics: Record<string, number>;
  weight: number;
  runsAgo: number;
}

/** Состояние памяти между прогонами. */
export interface RunMemory {
  entries: RunMemoryEntry[];
  totalRuns: number;
  limit: number;
}

/** Детерминированный некриптографический хеш FNV-1a (32 бита). */
function hashId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sanitizeMetrics(metrics: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!metrics || typeof metrics !== "object") return out;
  for (const key of MEMORY_METRIC_KEYS) {
    const raw = metrics[key];
    if (typeof raw === "boolean") {
      out[key] = raw ? 1 : 0;
      continue;
    }
    const value = finiteOrNull(raw);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * M-7.1: добавляет прогон в память с limit и затуханием по числу запусков.
 *
 * Старые записи получают `runsAgo + 1` и `weight * MEMORY_DECAY_FACTOR`;
 * записи, достигшие `limit`, отбрасываются. Исходный объект не мутируется.
 * Хеш идентификатора и метрики — единственное, что попадает в результат.
 */
export function rememberRun(
  memory: RunMemory | null | undefined,
  record: RunMemoryRecord | null | undefined,
  limit?: number,
): RunMemory {
  const previous = memory && typeof memory === "object" ? memory : null;
  const storedLimit = previous ? finiteOrNull(previous.limit) : null;
  const requested = finiteOrNull(limit);
  const cap = Math.max(0, Math.trunc(requested ?? storedLimit ?? DEFAULT_MEMORY_LIMIT));
  const totalRuns = (previous ? finiteOrNull(previous.totalRuns) ?? 0 : 0) + 1;

  const aged: RunMemoryEntry[] = [];
  for (const entry of asArray<RunMemoryEntry>(previous?.entries) ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const runsAgo = (finiteOrNull(entry.runsAgo) ?? 0) + 1;
    if (runsAgo >= cap) continue;
    const weight = (finiteOrNull(entry.weight) ?? 0) * MEMORY_DECAY_FACTOR;
    if (weight <= 0) continue;
    aged.push({
      hash: typeof entry.hash === "string" ? hashId(entry.hash) : hashId(""),
      metrics: sanitizeMetrics(entry.metrics),
      weight,
      runsAgo,
    });
  }

  const id = record && typeof record === "object"
    ? String(record.runId ?? record.hash ?? "")
    : "";
  const fresh: RunMemoryEntry = {
    hash: hashId(id),
    metrics: sanitizeMetrics(record?.metrics),
    weight: 1,
    runsAgo: 0,
  };
  return { entries: [fresh, ...aged].slice(0, cap), totalRuns, limit: cap };
}

/* ------------------------------------------------------------------------- *
 * M-8.1: само настраивающиеся конвейеры (smart recipes).
 * ------------------------------------------------------------------------- */

/** История: массив записей или состояние памяти из rememberRun. */
export interface RecipeHistoryEntry {
  metrics?: Record<string, unknown> | null;
  success?: boolean | number | null;
  [key: string]: unknown;
}

/** Конфиг конвейера, предлагаемый по метрикам прошлых запусков. */
export interface RecipeConfig {
  strategy: "fast" | "balanced" | "thorough";
  model: "primary" | "fallback";
  maxAttempts: number;
  confidenceThreshold: number;
  parallelism: number;
}

/** Fail-open конфиг для пустой или невалидной истории. */
export const DEFAULT_RECIPE: RecipeConfig = {
  strategy: "balanced",
  model: "primary",
  maxAttempts: 3,
  confidenceThreshold: 0.6,
  parallelism: 1,
};

function metricValues(entries: readonly RecipeHistoryEntry[], key: string): number[] {
  const values: number[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const metrics = entry.metrics && typeof entry.metrics === "object" ? entry.metrics : null;
    const raw = key === "success" && metrics && !("success" in metrics) ? entry.success : metrics?.[key];
    if (typeof raw === "boolean") values.push(raw ? 1 : 0);
    else {
      const value = finiteOrNull(raw);
      if (value !== null) values.push(value);
    }
  }
  return values;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * M-8.1: детерминированно предлагает конфиг конвейера по метрикам истории.
 *
 * Высокая доля неудач, retries или ошибки → `thorough`; быстрые успешные
 * прогоны с высокой оценкой → `fast`; остальные и пустая история →
 * {@link DEFAULT_RECIPE}. Поддерживается как массив записей, так и `RunMemory`.
 */
export function suggestRecipe(
  history: readonly RecipeHistoryEntry[] | RunMemory | null | undefined,
): RecipeConfig {
  const direct = asArray<RecipeHistoryEntry>(history);
  const memoryEntries = !direct && history && typeof history === "object"
    ? asArray<RunMemoryEntry>((history as RunMemory).entries)
    : null;
  const entries = (direct ?? memoryEntries ?? []) as readonly RecipeHistoryEntry[];
  if (entries.length === 0) return { ...DEFAULT_RECIPE };

  const success = average(metricValues(entries, "success"));
  const retries = average(metricValues(entries, "retries"));
  const errors = average(metricValues(entries, "errors"));
  const score = average(metricValues(entries, "score"));
  const duration = average(metricValues(entries, "durationMs") ?? metricValues(entries, "duration"));

  const failRate = success === null ? 0 : 1 - success;
  if (failRate >= 0.5 || (retries !== null && retries >= 2) || (errors !== null && errors >= 1)) {
    return {
      strategy: "thorough",
      model: "fallback",
      maxAttempts: 4,
      confidenceThreshold: 0.75,
      parallelism: 1,
    };
  }
  if (score !== null && score >= 0.8 && failRate <= 0.1 && (duration === null || duration <= 5000)) {
    return {
      strategy: "fast",
      model: "primary",
      maxAttempts: 2,
      confidenceThreshold: 0.5,
      parallelism: 2,
    };
  }
  return { ...DEFAULT_RECIPE };
}
