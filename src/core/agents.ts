/**
 * M-1..M-4: детерминированные примитивы мульти-агентной оркестрации.
 *
 * Чистые функции: без сети, БД, таймеров, системных часов и новых зависимостей.
 * Одинаковый вход всегда даёт одинаковый выход. Все текстовые поля проходят
 * через {@link redactSecrets}, поэтому секреты не попадают ни в сквозной
 * контекст, ни в post-mortem. SCHEMA_VERSION и счётчики инструментов/RPC
 * не затрагиваются.
 */

/** Предел артефактов сквозного контекста, если лимит не задан. */
export const DEFAULT_CONTEXT_LIMIT = 20;

/** Порог confidence, ниже которого подключается запасная модель. */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

/** Предел числа попыток self-correcting retry. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Замена для обнаруженного секрета. */
export const REDACTED = "[REDACTED]";

/* ------------------------------------------------------------------------- *
 * Секреты: детерминированная редукция до попадания текста в контекст.
 * ------------------------------------------------------------------------- */

// Ключ со значением: API_KEY=..., "token": ..., Authorization: ...
const SECRET_VALUE_RE =
  /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization)\s*[:=]\s*["']?[^\s"',;]+["']?/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;

/**
 * Заменяет типичные секреты на {@link REDACTED}. Не бросает исключений и
 * не зависит от окружения — можно применять к любому тексту шага.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_VALUE_RE, (match: string) => {
      const separator = match.search(/[:=]/);
      const prefix = separator >= 0 ? match.slice(0, separator + 1) : match;
      return `${prefix} ${REDACTED}`;
    })
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(SK_KEY_RE, REDACTED);
}

/* ------------------------------------------------------------------------- *
 * M-1.1: сквозной контекст из результатов шагов.
 * ------------------------------------------------------------------------- */

/** Структурный минимум шага, из которого собирается контекст. */
export interface ContextStep {
  stepName?: string;
  taskType?: string;
  status?: string;
  attempt?: number;
  /** Результат/вывод шага: строка, массив строк или объект с text/content/value. */
  output?: unknown;
  result?: unknown;
  artifacts?: unknown;
  error?: string;
}

/** `Array.isArray` сужает до `any[]`; guards сохраняет тип readonly-массива. */
function isContextStepArray(value: unknown): value is readonly ContextStep[] {
  return Array.isArray(value);
}

/** Рекурсивно (с ограничением глубины) вытаскивает строковые фрагменты. */
function collectText(value: unknown, out: string[], depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["text", "content", "value", "output", "result"]) {
      if (key in record) collectText(record[key], out, depth + 1);
    }
  }
}

/**
 * M-1.1: собирает сквозной контекст из результатов шагов в порядке их
 * следования. Дубли (после редукции секретов) отбрасываются, список
 * стабилен: один и тот же вход даёт один и тот же порядок элементов.
 *
 * `limit` — максимум элементов (по умолчанию {@link DEFAULT_CONTEXT_LIMIT});
 * 0 даёт пустой список, нечисловое значение — значение по умолчанию.
 */
export function buildContextArtifact(
  runSteps: readonly ContextStep[] | null | undefined,
  limit?: number,
): string[] {
  const cap = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_CONTEXT_LIMIT;
  if (cap <= 0 || !isContextStepArray(runSteps)) return [];

  const seen = new Set<string>();
  const artifacts: string[] = [];
  for (const step of runSteps) {
    if (step === null || typeof step !== "object") continue;
    const fragments: string[] = [];
    collectText(step.result, fragments);
    collectText(step.output, fragments);
    collectText(step.artifacts, fragments);
    if (typeof step.error === "string" && step.error.trim()) fragments.push(step.error.trim());

    for (const fragment of fragments) {
      const text = redactSecrets(fragment);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      artifacts.push(text);
      if (artifacts.length >= cap) return artifacts;
    }
  }
  return artifacts;
}

/* ------------------------------------------------------------------------- *
 * M-2.1: чередование ролей worker → reviewer.
 * ------------------------------------------------------------------------- */

export type AgentRole = "worker" | "reviewer";

/** Шаг, для которого выбирается роль. Явная `role` — запрос, а не приказ. */
export interface RoleStep {
  stepName?: string;
  taskType?: string;
  role?: string | null;
}

/**
 * M-2.1: детерминированно чередует `worker → reviewer → worker`.
 * Reviewer допустим только после `worker`: явный запрос `reviewer` без
 * предыдущего `worker` понижается до `worker` (запрет одиночного ревью).
 */
export function assignRole(
  step: RoleStep | string | null | undefined,
  previousRole?: string | null,
): AgentRole {
  const prev: AgentRole | null =
    previousRole === "worker" || previousRole === "reviewer" ? previousRole : null;
  let requested = "";
  if (typeof step === "string") {
    requested = step.trim().toLowerCase();
  } else if (step && typeof step.role === "string") {
    requested = step.role.trim().toLowerCase();
  }

  if (requested === "reviewer" && prev === "worker") return "reviewer";
  if (requested === "worker") return "worker";
  return prev === "worker" ? "reviewer" : "worker";
}

/* ------------------------------------------------------------------------- *
 * M-3.1: post-mortem и self-correcting retry.
 * ------------------------------------------------------------------------- */

export type PostmortemKind =
  | "timeout"
  | "transient"
  | "validation"
  | "gate"
  | "secret"
  | "quota"
  | "unknown";

/** Причина отказа и предложенное исправление. */
export interface Postmortem {
  kind: PostmortemKind;
  /** Безопасная (без секретов) причина. Пустая, если шаг не упал. */
  cause: string;
  /** Что исправить в spec перед повтором. */
  correction: string;
  /** Разрешён ли повтор: только для корректируемых ошибок. */
  correctable: boolean;
}

/** Структурный минимум результата шага. */
export interface StepResultLike {
  stepName?: string;
  status?: string;
  output?: unknown;
  error?: string;
  exitCode?: number;
  verdict?: string;
}

const CORRECTIONS: Record<PostmortemKind, string> = {
  timeout: "Увеличить timeoutSeconds шага и повторить с тем же spec.",
  transient: "Повторить шаг: временный сбой транспорта или сети.",
  validation: "Исправить spec шага по сообщению валидации и повторить.",
  gate: "Учесть причину GATE в spec шага и повторить с исправленным результатом.",
  secret: "Секрет в ошибке: повтор запрещён, требуется ротация ключа.",
  quota: "Квота или лимит модели: повтор бесполезен, нужна замена модели.",
  unknown: "Причина не классифицирована: повтор не выполняется.",
};

const CORRECTABLE_KINDS = new Set<PostmortemKind>([
  "timeout",
  "transient",
  "validation",
  "gate",
]);

function classifyCause(cause: string): PostmortemKind {
  const text = cause.toLowerCase();
  if (!text) return "unknown";
  if (/secret|api[_-]?key|authorization|credential|unauthor|forbidden|permission denied|access denied/.test(text)) {
    return "secret";
  }
  if (/quota|insufficient balance|free usage limit|429|rate limit|too many requests/.test(text)) {
    return "quota";
  }
  if (/timeout|timed out|таймаут|etimedout|deadline exceeded/.test(text)) return "timeout";
  if (/gate|rejected|отклон|quality|verdict[=: ]+fail/.test(text)) return "gate";
  if (/validation|schema|invalid|неверн|expected|mismatch/.test(text)) return "validation";
  if (/econnreset|econnrefused|enetwork|network|temporar|unavailable|503|502|504|flake|retry/.test(text)) {
    return "transient";
  }
  return "unknown";
}

/**
 * M-3.1: извлекает причину из результата шага и предлагает исправление.
 * Повтор разрешён только для корректируемых классов (timeout, transient,
 * validation, gate); секреты, квоты и неизвестные ошибки блокируют повтор.
 */
export function postmortem(
  stepResult: StepResultLike | string | null | undefined,
): Postmortem {
  let rawError = "";
  let exitCode: number | undefined;
  if (typeof stepResult === "string") {
    rawError = stepResult;
  } else if (stepResult && typeof stepResult === "object") {
    if (typeof stepResult.error === "string") rawError = stepResult.error;
    if (typeof stepResult.exitCode === "number") exitCode = stepResult.exitCode;
  }
  const errorText = redactSecrets(rawError.trim());
  const cause =
    errorText ||
    (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0
      ? `Код возврата ${String(exitCode)}`
      : "");
  const kind = classifyCause(cause);
  return {
    kind,
    cause,
    correction: CORRECTIONS[kind],
    correctable: CORRECTABLE_KINDS.has(kind),
  };
}

/** Spec шага, который может быть повторён. Остальные поля сохраняются как есть. */
export interface RetrySpec {
  stepName?: string;
  taskType?: string;
  prompt?: string;
  model?: string | null;
  attempt?: number;
  maxAttempts?: number;
  [key: string]: unknown;
}

/** Решение о повторе вместе с обновлённым spec. */
export interface RetryDecision {
  /** Новый spec: исходный не мутируется. */
  spec: RetrySpec;
  retry: boolean;
  reason: string;
  postmortem: Postmortem;
}

function clampAttempts(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(10, Math.trunc(value)));
}

/**
 * M-3.1: возвращает обновлённый spec с лимитом попыток и post-mortem.
 * `attempt` увеличивается только когда ошибка корректируема и лимит не
 * исчерпан; исходный объект остаётся неизменным.
 */
export function retryWithPostmortem(
  stepResult: StepResultLike | string | null | undefined,
  spec: RetrySpec,
  options: { maxAttempts?: number } = {},
): RetryDecision {
  const pm = postmortem(stepResult);
  const maxAttempts = clampAttempts(
    options.maxAttempts ?? spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
  );
  const attempt = clampAttempts(spec.attempt, 1);
  const retry = pm.correctable && attempt < maxAttempts;
  const nextAttempt = retry ? attempt + 1 : attempt;
  const updated: RetrySpec = {
    ...spec,
    attempt: nextAttempt,
    maxAttempts,
    lastPostmortem: {
      kind: pm.kind,
      cause: pm.cause,
      correction: pm.correction,
      correctable: pm.correctable,
    },
  };
  const reason = !pm.correctable
    ? `Повтор запрещён: ${pm.kind} — ${pm.correction}`
    : retry
      ? `Повтор ${String(nextAttempt)}/${String(maxAttempts)}: ${pm.correction}`
      : `Лимит попыток исчерпан (${String(attempt)}/${String(maxAttempts)})`;
  return { spec: updated, retry, reason, postmortem: pm };
}

/* ------------------------------------------------------------------------- *
 * M-4.1: model fallback + confidence.
 * ------------------------------------------------------------------------- */

/**
 * M-4.1: выбирает запасную модель только при confidence ниже порога.
 * Кандидаты перебираются в заданном порядке (первый отличный от primary),
 * поэтому выбор детерминирован. При отсутствии пригодных моделей и при
 * невалидном confidence возвращается primary (fail-open). Секреты в контекст
 * не добавляются: функция лишь возвращает имя модели, не логируя и не
 * сохраняя его.
 */
export function fallbackModel(
  primary: string | null | undefined,
  available: readonly string[] | null | undefined,
  confidence: number | null | undefined,
  options: { threshold?: number } = {},
): string | null {
  const safePrimary =
    typeof primary === "string" && primary.trim() ? primary.trim() : null;
  const thresholdRaw = options.threshold;
  const threshold =
    typeof thresholdRaw === "number" && Number.isFinite(thresholdRaw)
      ? Math.max(0, Math.min(1, thresholdRaw))
      : DEFAULT_CONFIDENCE_THRESHOLD;
  const score =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? Math.max(0, Math.min(1, confidence))
      : 1;
  if (score >= threshold) return safePrimary;
  if (!Array.isArray(available)) return safePrimary;

  const seen = new Set<string>();
  for (const candidate of available) {
    if (typeof candidate !== "string") continue;
    const model = candidate.trim();
    if (!model || model === safePrimary || seen.has(model)) continue;
    seen.add(model);
    return model;
  }
  return safePrimary;
}
