/**
 * Эскалация после провала Quality Gate (Спринт 36.5.d).
 *
 * Правило детерминированное и не обращается ни к БД, ни к модели, ни к сети:
 * провал на локальном исполнителе ведёт в облако, провал в облаке — на ручной
 * review, провал review означает, что автоматических уровней больше нет.
 * Решение принимается по одному флагу `passed`, поэтому его можно вызывать
 * в горячем пути без затрат токенов.
 */

/** Уровень исполнения, на котором сработал Quality Gate. */
export type GateTarget = "local" | "cloud" | "review";

/** Что делать после проверки гейта. */
export type EscalationAction =
  | "accept"
  | "escalate-cloud"
  | "escalate-review"
  | "blocked";

/** Результат Quality Gate, который видит роутер. */
export interface GateResult {
  /** Прошёл ли шаг проверку. */
  passed: boolean;
  /** Свободное пояснение для журнала и уведомлений. */
  reason?: string;
}

/** Решение об эскалации с текущего уровня. */
export interface EscalationDecision {
  /** Уровень, на котором гейт сработал. */
  from: GateTarget;
  /** Куда переходим (при `accept` совпадает с `from`). */
  next: GateTarget;
  action: EscalationAction;
  /** Почему принято решение: стабильный код, а не текст ошибки. */
  reason: "gate-passed" | "local-failed" | "cloud-failed" | "review-failed";
}

/** Следующий уровень эскалации или `null`, если уровни закончились. */
const NEXT_TARGET: Readonly<Record<GateTarget, GateTarget | null>> = Object.freeze(
  {
    local: "cloud",
    cloud: "review",
    review: null,
  },
);

/** Сколько автоматических эскалаций допускает цепочка local → cloud → review. */
export const MAX_ESCALATION_STEPS = 2;

function assertTarget(target: GateTarget): void {
  if (!Object.prototype.hasOwnProperty.call(NEXT_TARGET, target)) {
    throw new Error(`Неизвестный уровень гейта: ${String(target)}`);
  }
}

function assertGate(gate: GateResult): void {
  if (gate === null || typeof gate !== "object") {
    throw new Error("Результат Quality Gate должен быть объектом.");
  }
  if (typeof gate.passed !== "boolean") {
    throw new Error("Результат Quality Gate должен содержать boolean (passed).");
  }
}

/** Следующий уровень эскалации; `null` — автоматических уровней больше нет. */
export function nextGateTarget(current: GateTarget): GateTarget | null {
  assertTarget(current);
  return NEXT_TARGET[current];
}

/** Исчерпаны ли автоматические уровни для текущего исполнителя. */
export function isEscalationExhausted(current: GateTarget): boolean {
  return nextGateTarget(current) === null;
}

/**
 * Решает, что делать после гейта: принять результат или подняться на уровень
 * выше. Модель здесь не вызывается — только таблица переходов.
 */
export function escalateAfterGate(
  current: GateTarget,
  gate: GateResult,
): EscalationDecision {
  assertTarget(current);
  assertGate(gate);
  if (gate.passed) {
    return { from: current, next: current, action: "accept", reason: "gate-passed" };
  }
  const next = NEXT_TARGET[current];
  if (next === null) {
    return {
      from: current,
      next: current,
      action: "blocked",
      reason: "review-failed",
    };
  }
  if (next === "cloud") {
    return {
      from: current,
      next,
      action: "escalate-cloud",
      reason: "local-failed",
    };
  }
  return {
    from: current,
    next,
    action: "escalate-review",
    reason: "cloud-failed",
  };
}

/**
 * Полная цепочка уровней, которые предстоит пройти начиная с текущего
 * (включая его). Полезно для dry-run и объяснения решения оператору.
 */
export function escalationChain(current: GateTarget): GateTarget[] {
  assertTarget(current);
  const chain: GateTarget[] = [];
  let target: GateTarget | null = current;
  while (target !== null) {
    chain.push(target);
    target = NEXT_TARGET[target];
  }
  return chain;
}
