/**
 * Политика прав фоновых задач (Спринт 32 / релиз 1.6).
 *
 * OpenCode запускается с `--auto`, поэтому единственный барьер между
 * автономной задачей и файловой системой/шеллом — сгенерированный
 * OPENCODE_CONFIG_CONTENT. Здесь находится единый источник истины для
 * PowerShell- и bash-обёрток, чтобы они не расходились в трактовке
 * allowedTools/deniedTools.
 *
 * Важно: это политика на момент СОЗДАНИЯ/ОБНОВЛЕНИЯ задачи. Отдельный
 * процесс обёртки не имеет доступа к SQLite, поэтому аудит фиксирует
 * сгенерированную политику, а не попытки вызова инструментов.
 */

/** Действия OpenCode v2, которые понимает permissions. */
export const PERMISSION_ACTIONS = [
  "read",
  "edit",
  "glob",
  "grep",
  "shell",
  "subagent",
  "skill",
  "question",
  "webfetch",
  "websearch",
] as const;

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Имена инструментов, которые OpenCode отображает на действия. */
export const ACTION_ALIASES: Record<PermissionAction, readonly string[]> = {
  read: ["read"],
  edit: ["write", "edit", "apply_patch", "remove"],
  glob: ["glob"],
  grep: ["grep"],
  shell: ["bash", "shell"],
  subagent: ["subagent"],
  skill: ["skill"],
  question: ["question"],
  webfetch: ["webfetch"],
  websearch: ["websearch"],
};

export const PERMISSION_POLICIES = ["hybrid", "secure", "legacy"] as const;
export type PermissionPolicy = (typeof PERMISSION_POLICIES)[number];
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = "hybrid";

/* ─── ARCH-2.1 / ARCH-2.2: класс риска и компиляция политики ─────────────── */

/** Класс риска запуска: R0 — минимальный scope, R3 — максимальный. */
export const RISK_CLASSES = ["R0", "R1", "R2", "R3"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];
export const DEFAULT_RISK_CLASS: RiskClass = "R2";

const READ_ONLY_TOOLS = ["read", "glob", "grep", "skill"] as const;
const EDIT_TOOLS = ["write", "edit", "apply_patch", "remove"] as const;
const SHELL_TOOLS = ["bash", "shell"] as const;
const NETWORK_TOOLS = ["webfetch", "websearch"] as const;
const SUBAGENT_TOOLS = ["subagent"] as const;
const QUESTION_TOOLS = ["question"] as const;

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === "string" && (RISK_CLASSES as readonly string[]).includes(value);
}

/** Приводит произвольное значение к известному классу (для аудита/старых данных). */
export function normalizeRiskClass(
  value: unknown,
  fallback: RiskClass = DEFAULT_RISK_CLASS,
): RiskClass {
  return isRiskClass(value) ? value : fallback;
}

/** Ограничения, которые компилятор связывает с классом риска. */
export interface PolicyLimits {
  /** Максимум шагов плана (совпадает с дефолтом планировщика для R2). */
  maxSteps: number;
  /** Таймаут Quality Gate по умолчанию, с. */
  gateTimeoutSeconds: number;
  /** Максимум попыток шага. */
  maxRetries: number;
  /** Требуется ли Quality Gate для этого класса. */
  requireGate: boolean;
}

/** Базовый (без явных переопределений) контракт класса риска. */
export interface RiskBaseline {
  policy: PermissionPolicy;
  allowedTools: string[];
  deniedTools: string[];
  limits: PolicyLimits;
}

/**
 * Таблица соответствия класс → политика + явные списки инструментов + лимиты.
 * Единственный источник истины для компилятора; без внешних движков политик
 * (OPA/Rego/Cedar отклонены в docs/EXECUTION-LOOP.md §10).
 */
export const RISK_POLICY_BASELINE: Record<RiskClass, RiskBaseline> = {
  R0: {
    policy: "secure",
    allowedTools: [...READ_ONLY_TOOLS],
    deniedTools: [...EDIT_TOOLS, ...SHELL_TOOLS, ...SUBAGENT_TOOLS, ...QUESTION_TOOLS, ...NETWORK_TOOLS],
    limits: { maxSteps: 4, gateTimeoutSeconds: 120, maxRetries: 0, requireGate: false },
  },
  R1: {
    policy: "secure",
    allowedTools: [...READ_ONLY_TOOLS, ...NETWORK_TOOLS],
    deniedTools: [...EDIT_TOOLS, ...SHELL_TOOLS, ...SUBAGENT_TOOLS, ...QUESTION_TOOLS],
    limits: { maxSteps: 8, gateTimeoutSeconds: 180, maxRetries: 1, requireGate: false },
  },
  R2: {
    policy: "hybrid",
    allowedTools: [...READ_ONLY_TOOLS, "write", ...SUBAGENT_TOOLS, ...NETWORK_TOOLS],
    deniedTools: [...SHELL_TOOLS, ...QUESTION_TOOLS],
    limits: { maxSteps: 12, gateTimeoutSeconds: 300, maxRetries: 2, requireGate: true },
  },
  R3: {
    policy: "legacy",
    allowedTools: [
      ...READ_ONLY_TOOLS,
      ...EDIT_TOOLS,
      ...SHELL_TOOLS,
      ...SUBAGENT_TOOLS,
      ...QUESTION_TOOLS,
      ...NETWORK_TOOLS,
    ],
    deniedTools: [],
    limits: { maxSteps: 12, gateTimeoutSeconds: 600, maxRetries: 3, requireGate: true },
  },
};

/** Что известно о scope миссии на момент классификации. */
export interface RiskClassificationInput {
  /** Quality Gate (исполняемая команда) — часть scope миссии. */
  gate?: string | null;
  allowedTools?: readonly string[] | null;
  deniedTools?: readonly string[] | null;
  policy?: unknown;
  legacyShell?: boolean;
}

/**
 * ARCH-2.1: детерминированная классификация по фактически доступным
 * инструментам (учитывает политику и явные списки) и наличию гейта.
 * Гейт исполняет команду: он поднимает минимальный read-only класс R0 до R1,
 * но не снижает классы с уже расширенным tool scope.
 */
export function classifyRiskClass(input: RiskClassificationInput = {}): RiskClass {
  const effective = resolvePermissions({
    policy: normalizePolicy(input.policy),
    legacyShell: input.legacyShell === true,
    allowedTools: input.allowedTools,
    deniedTools: input.deniedTools,
  });
  const allows = (action: PermissionAction): boolean =>
    effective.permissions.some((entry) => entry.action === action && entry.effect === "allow");

  let klass: RiskClass;
  if (allows("shell")) klass = "R3";
  else if (allows("edit") || allows("subagent")) klass = "R2";
  else if (allows("webfetch") || allows("websearch")) klass = "R1";
  else klass = "R0";

  return klass === "R0" && input.gate ? "R1" : klass;
}

/** Вход компилятора: класс риска плюс необязательные явные переопределения. */
export interface CompilePermissionInput {
  riskClass?: unknown;
  policy?: unknown;
  allowedTools?: readonly string[] | null;
  deniedTools?: readonly string[] | null;
}

/** Результат компиляции: то, что уходит в RunContext и обёртку. */
export interface CompiledPermissionPolicy extends RiskBaseline {
  riskClass: RiskClass;
}

/**
 * ARCH-2.2: детерминированный компилятор риск-класс → PermissionPolicy.
 * Приоритет: явный denylist > явный allowlist > базовая таблица риск-класса;
 * явная политика заменяет политику класса, но не расширяет список инструментов.
 */
export function compilePermissionPolicy(
  input: CompilePermissionInput = {},
): CompiledPermissionPolicy {
  const riskClass = normalizeRiskClass(input.riskClass);
  const baseline = RISK_POLICY_BASELINE[riskClass];
  const policy = input.policy == null ? baseline.policy : normalizePolicy(input.policy, baseline.policy);

  const explicitAllowed =
    input.allowedTools && input.allowedTools.length > 0 ? normalizeToolList(input.allowedTools) : null;
  const explicitDenied =
    input.deniedTools && input.deniedTools.length > 0 ? normalizeToolList(input.deniedTools) : null;
  // При явном allowlist базовый denylist не применяется: он конфликтовал бы с
  // алиасами того же действия (например, bash/shell). Явный denylist всегда выигрывает.
  const deniedTools = explicitDenied ?? (explicitAllowed ? [] : [...baseline.deniedTools]);
  const deniedSet = new Set(explicitDenied ?? []);
  const allowedTools = (explicitAllowed ?? baseline.allowedTools).filter(
    (tool) => !deniedSet.has(tool),
  );

  return { riskClass, policy, allowedTools, deniedTools, limits: { ...baseline.limits } };
}

/** Базовые политики: какие действия разрешены без учёта списков задачи. */
const POLICY_BASE: Record<PermissionPolicy, readonly PermissionAction[]> = {
  // Гибрид: агенту можно менять файлы, но не выполнять команды и не задавать
  // вопросы (автономная задача всё равно некому на них ответить).
  hybrid: ["read", "edit", "glob", "grep", "subagent", "skill", "webfetch", "websearch"],
  // Строгий режим: только чтение и анализ исходников.
  secure: ["read", "glob", "grep", "skill"],
  // Прежнее поведение 1.5.x: разрешено всё.
  legacy: [...PERMISSION_ACTIONS],
};

export interface PermissionInput {
  /** Глобальная политика из SchedulerSettings.permissions.defaultPolicy. */
  policy?: PermissionPolicy | string | null;
  /** Переходный флаг задачи: вернуть shell в гибридной политике. */
  legacyShell?: boolean;
  /** Явный allowlist задачи (уже нормализованный или сырой). */
  allowedTools?: readonly string[] | null;
  /** Явный denylist задачи. */
  deniedTools?: readonly string[] | null;
}

export interface EffectivePermission {
  action: PermissionAction;
  resource: "*";
  effect: "allow" | "deny";
}

export interface DeniedByPolicy {
  action: PermissionAction;
  hint: string;
}

export interface EffectivePermissions {
  policy: PermissionPolicy;
  legacyShell: boolean;
  permissions: EffectivePermission[];
  /**
   * Действия, запрещённые именно политикой по умолчанию (а не списками
   * задачи). Используется для аудита и подсказок в логе.
   */
  deniedByPolicy: DeniedByPolicy[];
}

/** Приводит произвольное значение к известной политике. */
export function normalizePolicy(
  value: unknown,
  fallback: PermissionPolicy = DEFAULT_PERMISSION_POLICY,
): PermissionPolicy {
  return typeof value === "string" &&
    (PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as PermissionPolicy)
    : fallback;
}

/** Нормализует список инструментов: trim, lower-case, без пустых и дублей. */
export function normalizeToolList(
  value: readonly string[] | null | undefined,
): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((tool) => String(tool).trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function actionsForTools(tools: Iterable<string>): Set<PermissionAction> {
  const result = new Set<PermissionAction>();
  for (const tool of tools) {
    for (const action of PERMISSION_ACTIONS) {
      if (ACTION_ALIASES[action].includes(tool)) result.add(action);
    }
  }
  return result;
}

function hintFor(action: PermissionAction): string {
  switch (action) {
    case "shell":
      return "shell запрещён политикой: добавьте shell в allowedTools задачи либо вынесите команду в qualityGate/afterScript.";
    case "question":
      return "question запрещён политикой: автономная задача не может ответить на вопрос; уберите интерактивный шаг или добавьте question в allowedTools.";
    case "edit":
      return "edit запрещён политикой secure: добавьте edit/write в allowedTools или выберите политику hybrid/legacy.";
    default:
      return `${action} запрещён политикой secure: добавьте ${action} в allowedTools или выберите политику hybrid/legacy.`;
  }
}

/**
 * Вычисляет эффективные права задачи.
 *
 * Порядок:
 * 1. базовая политика (hybrid/secure/legacy), legacyShell возвращает shell;
 * 2. deniedTools переводит действие в deny (выигрывает всегда);
 * 3. непустой allowedTools превращается в allowlist и может явно вернуть
 *    действие, запрещённое политикой (кроме явно запрещённых deniedTools).
 */
export function resolvePermissions(input: PermissionInput = {}): EffectivePermissions {
  const policy = normalizePolicy(input.policy);
  const legacyShell = input.legacyShell === true;
  const allowed = actionsForTools(normalizeToolList(input.allowedTools));
  const denied = actionsForTools(normalizeToolList(input.deniedTools));

  const base = new Set<PermissionAction>(POLICY_BASE[policy]);
  if (policy === "hybrid" && legacyShell) base.add("shell");

  const permissions: EffectivePermission[] = PERMISSION_ACTIONS.map((action) => {
    let effect: "allow" | "deny" = base.has(action) ? "allow" : "deny";
    if (denied.has(action)) effect = "deny";
    else if (allowed.size > 0) effect = allowed.has(action) ? "allow" : "deny";
    return { action, resource: "*", effect };
  });

  const deniedByPolicy: DeniedByPolicy[] = [];
  for (const entry of permissions) {
    if (entry.effect !== "deny") continue;
    if (denied.has(entry.action)) continue;
    // Если список allowedTools непустой, запрет мог быть вызван им.
    if (allowed.size > 0) continue;
    deniedByPolicy.push({
      action: entry.action,
      hint: hintFor(entry.action),
    });
  }

  return { policy, legacyShell, permissions, deniedByPolicy };
}

/** Готовый OPENCODE_CONFIG_CONTENT для обёрток. */
export function buildOpencodeConfig(input: PermissionInput = {}): string {
  const effective = resolvePermissions(input);
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      permissions: effective.permissions,
    },
    null,
    2,
  );
}

/** Краткое описание политики для лога задачи. */
export function formatPolicyLog(effective: EffectivePermissions): string {
  const denied = effective.permissions
    .filter((p) => p.effect === "deny")
    .map((p) => p.action);
  const legacyShell = effective.legacyShell ? ", legacyShell=true" : "";
  return `policy=${effective.policy}${legacyShell}, denied=${denied.length > 0 ? denied.join(",") : "none"}`;
}
