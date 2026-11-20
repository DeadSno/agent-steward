/**
 * Модели и цены — из самого OpenCode, а не из захардкоженного списка.
 *
 * Что берём и откуда:
 *  1. Список доступных моделей — `opencode models`. Это ровно тот набор,
 *     который настроен у пользователя (провайдеры, ключи, локальные модели),
 *     а не «все модели мира».
 *  2. Цены — кэш каталога models.dev, который OpenCode держит в
 *     `<cache>/opencode/models.json` (`cost.input` / `cost.output`, USD за 1M
 *     токенов). В истории токены не разделены на вход/выход, поэтому берём
 *     среднее из двух цен.
 *
 * Модуль никогда не бросает: если CLI или кэш недоступны, возвращаются
 * значения по умолчанию, чтобы дашборд продолжал работать без OpenCode.
 *
 * Переключатели (переменные окружения):
 *  - OPENCODE_SCHEDULER_MODEL_SOURCE=static — не обращаться к OpenCode вообще
 *    (только встроенные значения; используется тестами);
 *  - OPENCODE_SCHEDULER_MODELS_CACHE=<путь> — свой файл каталога models.dev.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runOpencode } from "./opencode-cli.js";

/** Цена за 1M токенов модели в каталоге models.dev. */
export interface ModelCatalogEntry {
  /** Входные токены, USD за 1M. */
  input: number;
  /** Выходные токены, USD за 1M. */
  output: number;
}

/** Сколько what-if моделей показывать максимум. */
export const MAX_WHAT_IF_MODELS = 5;

/**
 * Цены по умолчанию: используются только если модели нет ни в каталоге
 * OpenCode, ни в OPENCODE_SCHEDULER_MODEL_PRICES.
 */
export const DEFAULT_MODEL_PRICE_PER_MILLION: Record<string, number> = {
  "openai/gpt-4o": 10,
  "openai/gpt-4o-mini": 0.6,
  "deepseek/deepseek-coder": 0.28,
  "anthropic/claude-3-5-sonnet": 9,
  "anthropic/claude-3-5-haiku": 1.2,
  "google/gemini-2.5-pro": 3.5,
  "google/gemini-2.0-flash": 0.3,
};

/** Средняя оценка цены, если модель вообще неизвестна. */
export const DEFAULT_PRICE_PER_MILLION = 3;

/** What-if модели, если OpenCode недоступен и истории ещё нет. */
export const DEFAULT_WHAT_IF_MODELS = [
  "openai/gpt-4o",
  "deepseek/deepseek-coder",
];

/** Провайдеры локальных моделей: они не выставляют счёт. */
const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llamacpp",
  "llama.cpp",
  "vllm",
  "local",
]);

const CATALOG_TTL_MS = 60_000;
const CLI_TTL_MS = 10 * 60_000;
const CLI_TIMEOUT_MS = 20_000;

/** Приводит id модели к виду для сравнения (регистр и пробелы не важны). */
export function normalizeModelId(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

/** Режим общения с OpenCode: "auto" (по умолчанию) или "static". */
export function modelSourceMode(): "auto" | "static" {
  const raw = (process.env.OPENCODE_SCHEDULER_MODEL_SOURCE ?? "").trim().toLowerCase();
  return raw === "static" || raw === "off" ? "static" : "auto";
}

/** Разбирает каталог models.dev в карту `provider/model` → цены. */
export function parseModelsCatalog(raw: string): Map<string, ModelCatalogEntry> {
  const result = new Map<string, ModelCatalogEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!parsed || typeof parsed !== "object") return result;

  for (const [providerId, provider] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const models = (provider as { models?: unknown } | null)?.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      const cost = (model as { cost?: unknown } | null)?.cost;
      if (!cost || typeof cost !== "object") continue;
      const input = Number((cost as { input?: unknown }).input);
      const output = Number((cost as { output?: unknown }).output);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      result.set(normalizeModelId(`${providerId}/${modelId}`), { input, output });
    }
  }
  return result;
}

/** Разбирает вывод `opencode models` (по одному id в строке). */
export function parseModelList(stdout: string): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim();
    if (!id || /\s/.test(id) || !id.includes("/")) continue;
    const key = normalizeModelId(id);
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(id);
  }
  return models;
}

/** Средняя цена за 1M токенов: история не делит токены на вход и выход. */
export function blendedPrice(entry: ModelCatalogEntry): number {
  return (entry.input + entry.output) / 2;
}

/** Путь к файлу каталога models.dev, если он есть на диске. */
export function findModelsCacheFile(): string | null {
  const explicit = process.env.OPENCODE_SCHEDULER_MODELS_CACHE?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : null;

  const home = os.homedir();
  const candidates = [
    path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "opencode", "models.json"),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "opencode", "models.json") : "",
    process.env.APPDATA ? path.join(process.env.APPDATA, "opencode", "models.json") : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Локальная модель: счёт не выставляется, цена — ноль. */
function isLocalProvider(model: string): boolean {
  const provider = normalizeModelId(model).split("/")[0] ?? "";
  return LOCAL_PROVIDERS.has(provider);
}

/** Бесплатная модель OpenCode (`...-free`): счёт не выставляется. */
function isKnownFreeModel(model: string): boolean {
  return /(?:^|\/)[^/]*-free$/i.test(normalizeModelId(model));
}

let catalogCache: {
  file: string;
  mtimeMs: number;
  checkedAt: number;
  data: Map<string, ModelCatalogEntry>;
} | null = null;

/**
 * Каталог цен из кэша OpenCode. Файл читается заново только когда изменился
 * (плюс не чаще раза в минуту), поэтому 6 МБ JSON не парсятся на каждый запрос.
 */
export function getModelsCatalog(): Map<string, ModelCatalogEntry> {
  if (modelSourceMode() === "static") return new Map();

  const file = findModelsCacheFile();
  if (!file) return new Map();

  const now = Date.now();
  if (catalogCache?.file === file && now - catalogCache.checkedAt < CATALOG_TTL_MS) {
    return catalogCache.data;
  }

  try {
    const stat = fs.statSync(file);
    if (catalogCache?.file === file && catalogCache.mtimeMs === stat.mtimeMs) {
      catalogCache.checkedAt = now;
      return catalogCache.data;
    }
    const data = parseModelsCatalog(fs.readFileSync(file, "utf8"));
    catalogCache = { file, mtimeMs: stat.mtimeMs, checkedAt: now, data };
    return data;
  } catch {
    return catalogCache?.data ?? new Map<string, ModelCatalogEntry>();
  }
}

/** Цена модели за 1M токенов по каталогу OpenCode (null — цены нет). */
export function catalogPricePerMillion(model: string | undefined): number | null {
  const key = normalizeModelId(model);
  if (!key) return null;
  const entry = getModelsCatalog().get(key);
  if (entry) return blendedPrice(entry);
  // Локальные провайдеры и бесплатные тарифы счёта не выставляют.
  return isLocalProvider(key) || isKnownFreeModel(key) ? 0 : null;
}

let cliCache: { at: number; models: string[] } | null = null;
/** Один общий запуск CLI: параллельные запросы дашборда не плодят процессы. */
let cliInflight: Promise<string[]> | null = null;

/**
 * Запускает `opencode models` асинхронно.
 *
 * Раньше здесь был `execFileSync`, и это вешало event loop сервера, внутри
 * которого живёт плагин. CLI в этот момент опрашивал тот же сервер как
 * background service, не получал ответа, запускал recovery и перезапускал
 * сервис вместе с дашбордом — отсюда `ERR_CONNECTION_REFUSED` каждые ~10 с.
 * Асинхронный запуск event loop не блокирует.
 */
async function runModelsCli(): Promise<string[]> {
  const result = await runOpencode(["models"], CLI_TIMEOUT_MS);
  if (!result.ok) return [];
  return parseModelList(result.stdout);
}

/** Доступные пользователю модели (`opencode models`), кэш 10 минут. */
export async function listAvailableModels(): Promise<string[]> {
  if (modelSourceMode() === "static") return [];
  const now = Date.now();
  if (cliCache && now - cliCache.at < CLI_TTL_MS) return cliCache.models;
  if (!cliInflight) {
    cliInflight = runModelsCli().finally(() => {
      cliInflight = null;
    });
  }
  const models = await cliInflight;
  // Пустой результат тоже кэшируем: иначе каждый запрос снова дёргает CLI.
  cliCache = { at: Date.now(), models };
  return models;
}

/** Откуда взялся список what-if моделей. */
export type WhatIfSource = "history" | "opencode" | "default";

export interface WhatIfSelection {
  models: string[];
  source: WhatIfSource;
}

/**
 * Что показывать в What-If.
 *
 * Сначала модели, которые пользователь реально запускал (история), затем — по
 * одной модели на каждую цену из доступных в OpenCode: дешёвая, средняя,
 * дорогая. Так список обозрим и отвечает на вопрос «а сколько было бы на
 * другой модели», а не перечисляет пять бесплатных подряд.
 *
 * `available` и `priceOf` вынесены параметрами, чтобы правило выбора
 * проверялось тестом на фиксированных данных.
 */
export function selectWhatIfModels(
  preferred: string[],
  available: string[],
  priceOf: (model: string) => number | null = catalogPricePerMillion,
): WhatIfSelection {
  const picked: string[] = [];
  const seen = new Set<string>();

  const push = (model: string): void => {
    const id = (model ?? "").trim();
    const key = normalizeModelId(id);
    if (!key || seen.has(key)) return;
    seen.add(key);
    picked.push(id);
  };

  const fromHistory: string[] = [];
  for (const model of preferred) {
    if (picked.length >= MAX_WHAT_IF_MODELS) break;
    const before = picked.length;
    push(model);
    if (picked.length > before) fromHistory.push(picked[picked.length - 1]);
  }

  const candidates = available
    .filter((model) => !seen.has(normalizeModelId(model)))
    .map((model) => ({ model, price: priceOf(model) ?? DEFAULT_PRICE_PER_MILLION }))
    .sort((a, b) => {
      if (a.price !== b.price) return a.price - b.price;
      // При равной цене берём самое короткое имя: списку нужен один пример.
      if (a.model.length !== b.model.length) return a.model.length - b.model.length;
      return a.model.localeCompare(b.model);
    });

  const prices = new Set<number>();
  for (const item of candidates) {
    if (picked.length >= MAX_WHAT_IF_MODELS) break;
    if (prices.has(item.price)) continue;
    prices.add(item.price);
    push(item.model);
  }

  if (picked.length === 0) {
    return { models: DEFAULT_WHAT_IF_MODELS.slice(), source: "default" };
  }

  const source: WhatIfSource = fromHistory.length > 0 ? "history" : "opencode";
  return { models: picked, source };
}

/** What-If по реальным источникам: история + `opencode models` + каталог цен. */
export async function resolveWhatIfModels(
  preferred: string[] = [],
): Promise<WhatIfSelection> {
  return selectWhatIfModels(preferred, await listAvailableModels());
}

/** Сбрасывает кэши (нужно тестам). */
export function resetModelCaches(): void {
  catalogCache = null;
  cliCache = null;
  cliInflight = null;
}
