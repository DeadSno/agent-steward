/**
 * Публичный сабпат `agent-steward/router` (Деталь 3.19 / S-2).
 *
 * Capability-роутинг с `first_pass_rate` и flywheel-обучением без БД и без
 *-model вызова: решение принимается по accumulated gate-исходам, которые
 * подаются через {@link CapabilityRouter.learn}. Модуль не импортирует
 * `src/db/*` и `@opencode/*`, поэтому его можно использовать в любом процессе
 * и переносить снимок состояния между запусками.
 *
 * Слой 1 (статические правила) имеет приоритет по умолчанию; обучение
 * перекрывает его только при явном `learnedOverridesStatic: true`.
 */

import {
  listStaticRouteRules,
  normalizeTaskType,
  routeStaticStep,
  STATIC_ROUTE_RULES,
  type RouterTransport,
  type StaticRouteRule,
} from "./core/router/rules.js";
import {
  applyLearningOutcome,
  decideLearningRoute,
  emptyLearningRecord,
  normalizeThresholds,
  type CapabilityLearningDecision,
  type CapabilityLearningOutcome,
  type CapabilityLearningRecord,
  type CapabilityRouteThresholds,
} from "./core/router/capability-math.js";

export {
  CLOUD_FAILURE_THRESHOLD,
  DECAY_WEIGHT,
  FIRST_PASS_WEIGHT,
  LOCAL_SUCCESS_THRESHOLD,
  MIN_RUNS_FOR_DECISION,
  RECENT_RUNS_LIMIT,
  SUCCESS_HALF_LIFE_RUNS,
  applyLearningOutcome,
  decayedSuccessRate,
  decideLearningRoute,
  effectiveReliability,
  emptyLearningRecord,
  normalizeThresholds,
  type CapabilityLearningDecision,
  type CapabilityLearningOutcome,
  type CapabilityLearningRecord,
  type CapabilityRouteThresholds,
  type CapabilityTarget,
} from "./core/router/capability-math.js";
export {
  STATIC_ROUTE_RULES,
  listStaticRouteRules,
  normalizeTaskType,
  routeStaticStep,
  type RouterTransport,
  type StaticRouteRule,
} from "./core/router/rules.js";

/** Версия формата снимка роутера. */
export const CAPABILITY_ROUTER_SNAPSHOT_VERSION = 1;

export interface CapabilityRouterOptions {
  /** Пороги local/cloud/minRuns; по умолчанию 0.85 / 0.30 / 3. */
  thresholds?: CapabilityRouteThresholds;
  /** Разрешить обученной метрике перекрывать статическое правило. */
  learnedOverridesStatic?: boolean;
}

/** Сериализуемое состояние роутера — можно записать в файл или БД. */
export interface CapabilityRouterSnapshot {
  version: 1;
  thresholds: { localSuccess: number; cloudFailure: number; minRuns: number };
  learnedOverridesStatic: boolean;
  routes: Record<string, CapabilityLearningRecord>;
}

/** Решение с необязательным транспортом статического правила. */
export interface RouterDecision extends CapabilityLearningDecision {
  transport?: RouterTransport;
}

export interface CapabilityRouter {
  /** Выбирает маршрут, не вызывая модель и не меняя состояние. */
  route(taskType: string): RouterDecision;
  /** Flywheel: записывает исход гейта и возвращает обновлённое решение. */
  learn(outcome: CapabilityLearningOutcome): RouterDecision;
  /** Текущая накопленная статистика по типу задачи (копия). */
  get(taskType: string): CapabilityLearningRecord | null;
  /** Детерминированный снимок (ключи отсортированы). */
  snapshot(): CapabilityRouterSnapshot;
  /** Восстанавливает состояние из снимка. */
  restore(snapshot: CapabilityRouterSnapshot): void;
  /** Полностью очищает обученную статистику. */
  reset(): void;
}

function cloneRecord(record: CapabilityLearningRecord): CapabilityLearningRecord {
  return { ...record, last10Runs: [...record.last10Runs] };
}

/**
 * Создаёт роутер с пустой картой. Начальное состояние можно передать через
 * `snapshot()` ранее созданного роутера — flywheel продолжает обучение.
 */
export function createCapabilityRouter(
  options: CapabilityRouterOptions = {},
  initial?: CapabilityRouterSnapshot,
): CapabilityRouter {
  const thresholds = normalizeThresholds(options.thresholds);
  const learnedOverridesStatic = options.learnedOverridesStatic === true;
  const routes = new Map<string, CapabilityLearningRecord>();

  const put = (record: CapabilityLearningRecord): void => {
    routes.set(record.taskType, cloneRecord(record));
  };

  const buildDecision = (taskType: string): RouterDecision => {
    const key = normalizeTaskType(taskType);
    const record = routes.get(key) ?? null;
    const learned = decideLearningRoute(key, record ? cloneRecord(record) : null, thresholds);
    const rule = routeStaticStep(key);
    if (rule && !(learnedOverridesStatic && record && record.runsTotal >= thresholds.minRuns)) {
      return {
        ...learned,
        target: rule.executor,
        reason: "static-rule",
        source: "static",
        transport: rule.transport,
      };
    }
    return learned;
  };

  if (initial) {
    if (initial.version !== CAPABILITY_ROUTER_SNAPSHOT_VERSION) {
      throw new Error(`S-2: неизвестная версия снимка роутера: ${String(initial.version)}.`);
    }
    const restored = normalizeThresholds(initial.thresholds);
    if (
      restored.localSuccess !== thresholds.localSuccess ||
      restored.cloudFailure !== thresholds.cloudFailure ||
      restored.minRuns !== thresholds.minRuns
    ) {
      throw new Error("S-2: пороги снимка не совпадают с порогами роутера.");
    }
    for (const key of Object.keys(initial.routes ?? {}).sort()) {
      put(initial.routes[key]);
    }
  }

  return {
    route: buildDecision,
    learn: (outcome) => {
      const key = normalizeTaskType(outcome.taskType);
      const previous = routes.get(key) ?? null;
      const updated = applyLearningOutcome(previous, outcome);
      put(updated);
      return buildDecision(key);
    },
    get: (taskType) => {
      const record = routes.get(normalizeTaskType(taskType));
      return record ? cloneRecord(record) : null;
    },
    snapshot: () => {
      const routesSnapshot: Record<string, CapabilityLearningRecord> = {};
      for (const key of [...routes.keys()].sort()) {
        routesSnapshot[key] = cloneRecord(routes.get(key)!);
      }
      return {
        version: CAPABILITY_ROUTER_SNAPSHOT_VERSION,
        thresholds: { ...thresholds },
        learnedOverridesStatic,
        routes: routesSnapshot,
      };
    },
    restore: (snapshot) => {
      if (snapshot.version !== CAPABILITY_ROUTER_SNAPSHOT_VERSION) {
        throw new Error(`S-2: неизвестная версия снимка роутера: ${String(snapshot.version)}.`);
      }
      const restored = normalizeThresholds(snapshot.thresholds);
      if (
        restored.localSuccess !== thresholds.localSuccess ||
        restored.cloudFailure !== thresholds.cloudFailure ||
        restored.minRuns !== thresholds.minRuns
      ) {
        throw new Error("S-2: пороги снимка не совпадают с порогами роутера.");
      }
      routes.clear();
      for (const key of Object.keys(snapshot.routes ?? {}).sort()) {
        put(snapshot.routes[key]);
      }
    },
    reset: () => routes.clear(),
  };
}
