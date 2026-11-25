/**
 * Роутер, слой 3: декомпозиция миссии.
 *
 * Локальная модель вызывается только здесь и только для того, чтобы разбить
 * миссию на шаги с типом задачи. Маршрут каждого шага (транспорт и исполнитель)
 * определяется слоями 1–2: статическими правилами и Capability Map. Если
 * декомпозера нет, работает эвристика по ключевым словам — она не обращается
 * ни к модели, ни к сети.
 */

import { isStaticTaskType, normalizeTaskType, type RouterExecutor, type RouterTransport } from "./rules.js";

/** Один шаг плана: имя для журнала и тип задачи для маршрутизации. */
export interface MissionStep {
  stepName: string;
  taskType: string;
  /** EX-1.2: запрос роли worker/reviewer; execution loop уточняет его через assignRole. */
  role?: string | null;
}

/** Источник плана: модель или эвристика. */
export type PlanSource = "model" | "heuristic";

/** Результат декомпозиции миссии. */
export interface MissionPlan {
  mission: string;
  steps: MissionStep[];
  source: PlanSource;
  /** Типы шагов, которых нет в статических правилах: их маршрут решают слои 2–3. */
  ambiguousTaskTypes: string[];
}

/** Декомпозер, который поставляет локальная модель. */
export interface MissionDecomposer {
  decompose(mission: string): Promise<MissionStep[]> | MissionStep[];
}

/** Опции декомпозиции. */
export interface PlanOptions {
  decomposer?: MissionDecomposer;
  /** Предохранитель от «простыни» шагов, по умолчанию 12. */
  maxSteps?: number;
}

/** Маршрут шага, собранный из слоёв 1–2 (для удобства интеграции). */
export interface ResolvedStepRoute {
  step: MissionStep;
  transport?: RouterTransport;
  executor?: RouterExecutor;
  source: "static" | "capability" | "unknown";
}

const DEFAULT_MAX_STEPS = 12;

/**
 * Ключевые слова эвристики. Порядок важен: более специфичные типы идут первыми,
 * иначе «проверь тесты в PR» уедет в run_tests вместо github_create_pr.
 */
const HEURISTIC_KEYWORDS: readonly { taskType: string; keywords: readonly string[] }[] = Object.freeze([
  { taskType: "github_create_pr", keywords: ["pull request", "merge request", " pr ", "pr ", "пуш", "push"] },
  { taskType: "jira_update_task", keywords: ["jira", "джира", "тикет", "ticket", "задач"] },
  { taskType: "run_tests", keywords: ["тест", "test", "прогон", "проверк"] },
  { taskType: "apply_diff", keywords: ["исправ", "поправ", "измени", "правк", "patch", "diff", "refactor", "рефактор"] },
  { taskType: "write_file", keywords: ["запиши", "создай", "напиши", "write", "сохрани"] },
  { taskType: "read_file", keywords: ["прочит", "прочитай", "посмотр", "открой", "read", "inspect"] },
]);

/** Разделители шагов в миссии. */
const STEP_SPLIT_PATTERN = /\r?\n|;|,\s*(?:затем|потом|после чего)\s*|\s+(?:затем|потом|после чего)\s+/iu;

/** Нужна ли декомпозиция: одна короткая задача обходится без модели. */
export function needsDecomposition(mission: string): boolean {
  const text = mission.trim();
  if (!text) {
    return false;
  }
  if (STEP_SPLIT_PATTERN.test(text)) {
    return true;
  }
  return !isStaticTaskType(text);
}

/** Определяет тип задачи по ключевым словам фрагмента; неизвестно — `unknown`. */
export function guessTaskType(fragment: string): string {
  const haystack = ` ${fragment.toLowerCase().replace(/ё/gu, "е")} `;
  for (const entry of HEURISTIC_KEYWORDS) {
    if (entry.keywords.some((keyword) => haystack.includes(keyword))) {
      return entry.taskType;
    }
  }
  return "unknown";
}

/** Эвристическая декомпозиция: без модели, без сети, детерминированно. */
export function decomposeHeuristically(mission: string, maxSteps: number = DEFAULT_MAX_STEPS): MissionStep[] {
  const text = mission.trim();
  if (!text) {
    throw new Error("Пустая миссия: декомпозиция невозможна");
  }
  const fragments = text
    .split(STEP_SPLIT_PATTERN)
    .map((fragment) => fragment.trim().replace(/^[-*\d.)\s]+/u, "").trim())
    .filter((fragment) => fragment.length > 0);

  const steps = fragments.slice(0, Math.max(1, maxSteps)).map((fragment) => ({
    stepName: fragment.length > 120 ? `${fragment.slice(0, 117)}...` : fragment,
    taskType: guessTaskType(fragment),
  }));

  if (steps.length === 0) {
    throw new Error("Пустая миссия: декомпозиция невозможна");
  }
  return steps;
}

function assertMaxSteps(maxSteps: number): void {
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new Error(`Некорректный maxSteps: ${String(maxSteps)}`);
  }
}

// QA-A2.7: вывод модели — внешние данные, сужаем через guard.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSteps(raw: unknown, maxSteps: number): MissionStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Декомпозер вернул пустой план");
  }
  const steps: MissionStep[] = [];
  for (const item of raw.slice(0, maxSteps)) {
    if (!isRecord(item)) {
      throw new Error("Декомпозер вернул шаг без имени или типа задачи");
    }
    const stepName = typeof item.stepName === "string" ? item.stepName.trim() : "";
    const taskType = typeof item.taskType === "string" ? normalizeTaskType(item.taskType) : "";
    if (!stepName || !taskType) {
      throw new Error("Декомпозер вернул шаг без имени или типа задачи");
    }
    steps.push({ stepName, taskType });
  }
  return steps;
}

function buildPlan(mission: string, steps: MissionStep[], source: PlanSource): MissionPlan {
  const ambiguousTaskTypes = [...new Set(steps.filter((step) => !isStaticTaskType(step.taskType)).map((step) => step.taskType))];
  return { mission, steps, source, ambiguousTaskTypes };
}

/** Асинхронная декомпозиция: модель, если передана, иначе эвристика. */
export async function planMission(mission: string, options: PlanOptions = {}): Promise<MissionPlan> {
  const text = mission.trim();
  if (!text) {
    throw new Error("Пустая миссия: декомпозиция невозможна");
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  assertMaxSteps(maxSteps);

  if (options.decomposer) {
    const raw = await options.decomposer.decompose(text);
    return buildPlan(text, normalizeSteps(raw, maxSteps), "model");
  }
  return buildPlan(text, decomposeHeuristically(text, maxSteps), "heuristic");
}

/** Синхронный вариант для мест, где промис неудобен. */
export function planMissionSync(mission: string, options: Omit<PlanOptions, "decomposer"> = {}): MissionPlan {
  const text = mission.trim();
  if (!text) {
    throw new Error("Пустая миссия: декомпозиция невозможна");
  }
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  assertMaxSteps(maxSteps);
  return buildPlan(text, decomposeHeuristically(text, maxSteps), "heuristic");
}
