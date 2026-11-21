/**
 * Сборка маршрута шага из слоёв 1–2 (Спринт 36.5.d).
 *
 * Слой 1 отвечает мгновенно по таблице правил, слой 2 — по Capability Map.
 * Модель здесь не участвует: `routeStep` не импортирует planner и ничего не
 * декомпозирует, поэтому известный тип задачи обходится в 0 токенов.
 */

import { decideCapabilityRoute } from "../../db/capability-repo.js";
import type { CapabilityDecision, CapabilityThresholds } from "../../db/capability-repo.js";
import {
  compileRunContext,
  recompileContextOnEscalation,
  DEFAULT_CONTEXT_MODEL,
  type CompiledContext,
  type CompileContextOptions,
  type ContextRecompile,
} from "../../db/run-context.js";
import { normalizeTaskType, routeStaticStep } from "./rules.js";
import type { RouterExecutor, RouterTransport } from "./rules.js";
export { contextWindowForModel } from "../../db/run-context.js";

/** Откуда взято решение о маршруте. */
export type RouteSource = "static" | "capability";

/** Куда направляется шаг: исполнение или ручной разбор. */
export type RouteTarget = "local" | "cloud" | "review" | "explore";

/** Готовый маршрут шага. */
export interface StepRoute {
  /** Нормализованный тип задачи. */
  taskType: string;
  /** Кто исполняет шаг либо почему шаг уходит человеку. */
  target: RouteTarget;
  /** Транспорт; `null` для `review`/`explore`, где исполнения пока нет. */
  transport: RouterTransport | null;
  /** Исполнитель; `null` для `review`/`explore`. */
  executor: RouterExecutor | null;
  /** Слой, принявший решение. */
  source: RouteSource;
  /** Стабильный код причины: `static-rule` либо решение Capability Map. */
  reason: string;
  /** Решение слоя 2, если он участвовал. */
  decision?: CapabilityDecision;
}

/**
 * Строит маршрут для типа задачи: статическое правило, затем Capability Map.
 * Пустой тип — ошибка, а не молчаливый `explore`: маршрутизировать нечего.
 */
export function routeStep(
  taskType: string,
  thresholds: CapabilityThresholds = {},
): StepRoute {
  const key = normalizeTaskType(taskType);
  if (key === "") {
    throw new Error("Пустой тип задачи: маршрутизация невозможна.");
  }

  const rule = routeStaticStep(key);
  if (rule !== undefined) {
    return {
      taskType: key,
      target: rule.executor,
      transport: rule.transport,
      executor: rule.executor,
      source: "static",
      reason: "static-rule",
    };
  }

  const decision = decideCapabilityRoute(key, thresholds);
  const target: RouteTarget = decision.target;
  return {
    taskType: key,
    target,
    transport: transportForTarget(target),
    executor: executorForTarget(target),
    source: "capability",
    reason: decision.reason,
    decision,
  };
}

function transportForTarget(target: RouteTarget): RouterTransport | null {
  if (target === "cloud") {
    return "cloud";
  }
  if (target === "local") {
    return "direct";
  }
  return null;
}

function executorForTarget(target: RouteTarget): RouterExecutor | null {
  if (target === "cloud") {
    return "cloud";
  }
  if (target === "local") {
    return "local";
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * ARCH-5: контекст Po маршруту и пересборка при эскалации
 * ------------------------------------------------------------------------- */

/** Модель по умолчанию для исполнителя: окно зависит от модели. */
export const EXECUTOR_MODEL: Readonly<Record<RouterExecutor, string>> = Object.freeze({
  local: "local-7b",
  cloud: "cloud-large",
});

/** Параметры сборки контекста для уже выбранного маршрута. */
export type RouteContextOptions = Omit<CompileContextOptions, "taskType" | "model"> & {
  /** Явная модель; иначе берётся модель исполнителя маршрута. */
  model?: string;
};

/** Модель шага: явная или зависимая от исполнителя маршрута. */
function modelForRoute(route: StepRoute, options: RouteContextOptions): string {
  if (options.model !== undefined && String(options.model).trim() !== "") {
    return String(options.model).trim();
  }
  return route.executor ? EXECUTOR_MODEL[route.executor] : DEFAULT_CONTEXT_MODEL;
}

/**
 * ARCH-5.1: собрать контекст после роутинга. Тип задачи и модель определяют
 * отбор файлов и окно/бюджет; решение принимается из ledger, а не моделью.
 */
export function compileContextForRoute(
  route: StepRoute,
  options: RouteContextOptions = {},
): CompiledContext {
  return compileRunContext({
    ...options,
    taskType: route.taskType,
    model: modelForRoute(route, options),
  });
}

/**
 * ARCH-5.2: эскалация меняет модель и окно, поэтому старый контекст не
 * передаётся дальше — он пересобирается из ledger под новое окно.
 */
export function recompileContextForRouteEscalation(
  previous: CompiledContext,
  options: Omit<CompileContextOptions, "taskType"> & { taskType?: string } = {},
): ContextRecompile {
  return recompileContextOnEscalation(previous, options);
}
