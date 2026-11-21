/**
 * Эскалация после провала Quality Gate (Спринт 36.5.d, Деталь 2.3 / ARCH-3).
 *
 * Правило детерминированное и не обращается ни к БД, ни к модели, ни к сети:
 * провал на локальном исполнителе ведёт в облако, провал в облаке — на ручной
 * review, провал review означает, что автоматических уровней больше нет.
 *
 * ARCH-3.1 добавляет вердикты `pass|fail|flake|infra_fail` и повтор гейта до
 * N=2 **на том же артефакте** (исполнитель агента не перезапускается). Стабильный
 * `fail` — вина агента и повторяется немедленно; `flake`/`infra_fail` — шум или
 * инфраструктура, их имеет смысл перепроверить один раз. Итог фиксируется в
 * `attempts_to_pass`/`first_pass` (ledger `gate_outcomes`).
 */

/** Уровень исполнения, на котором сработал Quality Gate. */
export type GateTarget = "local" | "cloud" | "review";

/**
 * Вердикт Quality Gate (ARCH-3.1).
 * - `pass` — стабильно пройден с первой попытки;
 * - `fail` — стабильно провален (вина агента, эскалация по levels);
 * - `flake` — нестабильный результат (прошёл с повтора либо результаты разнятся);
 * - `infra_fail` — инфраструктурная ошибка, отличная от flakes.
 */
export type GateVerdict = "pass" | "fail" | "flake" | "infra_fail";

/** Сколько попыток гейта допускается на одном артефакте. */
export const MAX_GATE_ATTEMPTS = 2;

const GATE_VERDICTS: ReadonlySet<string> = new Set<GateVerdict>([
  "pass",
  "fail",
  "flake",
  "infra_fail",
]);

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
  /** Явный вердикт; по умолчанию выводится из `passed`. */
  verdict?: GateVerdict;
}

/** Итог гейта после повторов на одном артефакте (ARCH-3.1). */
export interface GateOutcome {
  /** Финальный вердикт с учётом всех попыток. */
  verdict: GateVerdict;
  /** Удалось ли гейт пройти (в том числе со второй попытки). */
  passed: boolean;
  /** Сколько попыток фактически выполнено. */
  attempts: number;
  /** На какой попытке гейт прошёл; при провале — число выполненных попыток. */
  attemptsToPass: number;
  /** Прошёл ли гейт с первой попытки без флака. */
  firstPass: boolean;
  /** Был ли повтор гейта. */
  retried: boolean;
  /** Пояснения всех попыток (для ledger и отчёта). */
  reasons: string[];
}

/** Решение об эскалации с текущего уровня. */
export interface EscalationDecision {
  /** Уровень, на котором гейт сработал. */
  from: GateTarget;
  /** Куда переходим (при `accept` совпадает с `from`). */
  next: GateTarget;
  action: EscalationAction;
  /** Почему принято решение: стабильный код, а не текст ошибки. */
  reason:
    | "gate-passed"
    | "local-failed"
    | "cloud-failed"
    | "review-failed"
    | "flake-detected"
    | "infra-error";
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
  if (gate.verdict !== undefined && !GATE_VERDICTS.has(gate.verdict)) {
    throw new Error(`Неизвестный вердикт Quality Gate: ${String(gate.verdict)}`);
  }
}

/** Нормализует результат попытки в вердикт (явный флаг имеет приоритет). */
export function gateVerdict(gate: GateResult): GateVerdict {
  assertGate(gate);
  return gate.verdict ?? (gate.passed ? "pass" : "fail");
}

/**
 * ARCH-3.1: повтор имеет смысл только для шума/инфраструктуры. Стабильный
 * `pass` и стабильный `fail` повторять не нужно — это детерминированные исходы.
 */
export function shouldRetryGate(verdict: GateVerdict): boolean {
  return verdict === "flake" || verdict === "infra_fail";
}

/**
 * Сворачивает цепочку попыток на одном артефакте в итоговый вердикт.
 *
 * - первая попытка `pass` → `pass`, `first_pass = true`, `attempts_to_pass = 1`;
 * - проход со второй попытки → `flake`, `first_pass = false`, `attempts_to_pass = 2`;
 * - все попытки `fail` → `fail`; `infra_fail` доминирует над flake/fail,
 *   потому что инфраструктурная ошибка — отдельный класс, а не шум агента.
 */
export function resolveGateOutcome(attempts: GateResult[]): GateOutcome {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > MAX_GATE_ATTEMPTS) {
    throw new Error(
      `Ожидалось 1..${MAX_GATE_ATTEMPTS} попыток гейта, получено ${Array.isArray(attempts) ? attempts.length : "не массив"}.`,
    );
  }
  const verdicts = attempts.map(gateVerdict);
  const reasons = attempts
    .map((attempt) => attempt.reason)
    .filter((reason): reason is string => typeof reason === "string" && reason.length > 0);
  const passIndex = verdicts.indexOf("pass");
  if (passIndex >= 0) {
    return {
      verdict: passIndex === 0 ? "pass" : "flake",
      passed: true,
      attempts: verdicts.length,
      attemptsToPass: passIndex + 1,
      firstPass: passIndex === 0,
      retried: verdicts.length > 1,
      reasons,
    };
  }
  const verdict: GateVerdict = verdicts.includes("infra_fail")
    ? "infra_fail"
    : verdicts.includes("flake")
      ? "flake"
      : "fail";
  return {
    verdict,
    passed: false,
    attempts: verdicts.length,
    attemptsToPass: verdicts.length,
    firstPass: false,
    retried: verdicts.length > 1,
    reasons,
  };
}

/**
 * Повторяет гейт до N=2 на том же артефакте. Исполнитель агента не
 * перезапускается: `run` получает только номер попытки и работает с одним и тем
 * же результатом/sha артефакта. Функция не импортирует БД, модель и сеть.
 */
export async function runGateWithRetry(
  run: (attempt: number) => GateResult | Promise<GateResult>,
  maxAttempts: number = MAX_GATE_ATTEMPTS,
): Promise<GateOutcome> {
  if (typeof run !== "function") {
    throw new Error("Нужна функция запуска гейта.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_GATE_ATTEMPTS) {
    throw new Error(`maxAttempts должен быть целым 1..${MAX_GATE_ATTEMPTS}.`);
  }
  const attempts: GateResult[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await run(attempt);
    attempts.push(result);
    if (!shouldRetryGate(gateVerdict(result))) break;
  }
  return resolveGateOutcome(attempts);
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
 * Решает, что делать после гейта: принять результат, подняться на уровень выше
 * или остановиться с предупреждением. Модель здесь не вызывается — только
 * таблица переходов и вердикт. `flake`/`infra_fail` намеренно НЕ эскалируются:
 * смена исполнителя не лечит шум и инфраструктуру (ARCH-3.2).
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
  const verdict = gate.verdict ?? "fail";
  if (verdict === "flake" || verdict === "infra_fail") {
    return {
      from: current,
      next: current,
      action: "blocked",
      reason: verdict === "flake" ? "flake-detected" : "infra-error",
    };
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
