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

/* ─── ARCH-7.1: классы риска, требующие ручного одобрения ─────────────────── */

/**
 * ARCH-7.1 (связь с A-1, docs/ROADMAP.md §3): externally-visible риск.
 * R0/R1 — read-only/сетевой scope и проходят без одобрения;
 * R2 (edit/subagent) и R3 (shell/legacy) — только после approve.
 */
export const APPROVAL_REQUIRED_RISK_CLASSES: readonly RiskClass[] = ["R2", "R3"];

/** ARCH-7.1: единая проверка «нужен ли ручной approve» для execution loop. */
export function requiresApproval(riskClass: unknown): boolean {
  return isRiskClass(riskClass) && APPROVAL_REQUIRED_RISK_CLASSES.includes(riskClass);
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
  /** ARCH-6.1: whitelist хостов/API в scoped-конфиге; отсутствие = fail-open. */
  egress?: unknown;
}

/** Результат компиляции: то, что уходит в RunContext и обёртку. */
export interface CompiledPermissionPolicy extends RiskBaseline {
  riskClass: RiskClass;
  /** ARCH-6.1: нормализованная egress-политика или null (старое поведение). */
  egress: EgressPolicy | null;
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

  return {
    riskClass,
    policy,
    allowedTools,
    deniedTools,
    limits: { ...baseline.limits },
    egress: normalizeEgressPolicy(input.egress),
  };
}

/* ─── ARCH-6.1: egress-политика (whitelist хостов/API) ────────────────────── */

/**
 * Egress-политика scoped-конфига шага. Разрешено ровно то, что перечислено;
 * политика не задана (`null`) — подсистема необязательна и работает fail-open
 * (поведение 1.5.x/1.6 без ограничений).
 */
export interface EgressPolicy {
  /**
   * Разрешённые хосты. Точное имя (`api.github.com`), запись с ведущей точкой
   * (`.github.com` — сам домен и все поддомены) или с префиксом `*.`.
   */
  allowedHosts: string[];
  /** Разрешённые URL-префиксы API, например `https://api.github.com/repos/`. */
  allowedApis: string[];
}

/** Причина решения egress-политики — пишется в аудит и отчёт. */
export type EgressDecisionReason =
  | "no-policy"
  | "allowed-host"
  | "allowed-api"
  | "blocked-host"
  | "invalid-destination";

/** Решение по одному исходящему обращению. */
export interface EgressDecision {
  allowed: boolean;
  host: string | null;
  reason: EgressDecisionReason;
  /** Человекочитаемая причина для лога/аудита/отчёта. */
  detail: string;
  /** true, только если политика заблокировала выход или адрес недоступен. */
  degraded: boolean;
  /** false = fail-open (политика не задана, старое поведение). */
  policyConfigured: boolean;
}

/** Результат выполнения действия под egress-guard в execute-пути. */
export interface EgressGuardedResult<T> {
  /** true, только если исходящее действие действительно выполнено. */
  ok: boolean;
  /** Раннер-статус: «ok» либо «degraded» (тихого успеха при блоке нет). */
  status: "ok" | "degraded";
  degraded: boolean;
  decision: EgressDecision;
  reason: string;
  value?: T;
}

function normalizeHostEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  // Хост может быть записан как URL — тогда берём только hostname.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) host = extractEgressHost(host) ?? "";
  // Убираем порт и путь, если они остались в «голой» записи; IPv6 в [] не трогаем.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : "";
  } else {
    host = host.split(/[:/?#]/, 1)[0] ?? "";
  }
  host = host.replace(/\.$/, "").trim();
  if (host.startsWith("*.")) host = `.${host.slice(2)}`;
  if (!host || host === ".") return null;
  return host;
}

/** Нормализует whitelist хостов (trim, lower-case, дедуп, без пустых). */
export function normalizeEgressHosts(value: readonly unknown[] | null | undefined): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map(normalizeHostEntry)
        .filter((host): host is string => host != null && host.length > 0),
    ),
  );
}

function normalizeApiEntry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const api = value.trim().toLowerCase();
  return api || null;
}

function normalizeApiList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.trim()
      ? value.split(",")
      : [];
  return Array.from(
    new Set(
      raw
        .map(normalizeApiEntry)
        .filter((api): api is string => api != null && api.length > 0),
    ),
  );
}

/**
 * Приводит scoped-конфиг egress к нормализованному whitelist.
 * `null`/отсутствие/пустые списки — политика НЕ задана (fail-open).
 * Поддерживаются: объект `{ allowedHosts, allowedApis }` (алиасы hosts/apis,
 * whitelist/allowlist), массив хостов и строка хостов через запятую.
 */
export function normalizeEgressPolicy(value: unknown): EgressPolicy | null {
  if (value == null) return null;
  let hostSource: unknown = value;
  let apiSource: unknown = null;
  if (typeof value === "string") {
    hostSource = value.split(",");
  } else if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    hostSource = obj.allowedHosts ?? obj.hosts ?? obj.whitelist ?? obj.allowlist;
    apiSource = obj.allowedApis ?? obj.apis;
  }
  const allowedHosts = normalizeEgressHosts(
    Array.isArray(hostSource)
      ? hostSource
      : typeof hostSource === "string" && hostSource.trim()
        ? [hostSource]
        : [],
  );
  const allowedApis = normalizeApiList(apiSource);
  if (allowedHosts.length === 0 && allowedApis.length === 0) return null;
  return { allowedHosts, allowedApis };
}

/** Извлекает hostname из URL, `host:port` или «голого» хоста. */
export function extractEgressHost(destination: string): string | null {
  if (typeof destination !== "string") return null;
  const trimmed = destination.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `http://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    const match = /^([a-zA-Z0-9._-]+)/.exec(trimmed);
    return match ? match[1].toLowerCase().replace(/\.$/, "") : null;
  }
}

function hostMatches(host: string, allowed: string): boolean {
  if (host === allowed) return true;
  if (allowed.startsWith(".")) {
    return host === allowed.slice(1) || host.endsWith(allowed);
  }
  return false;
}

/**
 * ARCH-6.1: решение по одному выходу. Политика не задана → fail-open;
 * задана → всё, чего нет в whitelist, блокируется (fail-closed) с причиной.
 */
export function checkEgress(policy: unknown, destination: string): EgressDecision {
  const normalized = normalizeEgressPolicy(policy);
  const host = extractEgressHost(destination);
  if (!normalized) {
    return {
      allowed: true,
      host,
      reason: "no-policy",
      detail: "egress-политика не задана: fail-open, прежнее поведение без ограничений",
      degraded: false,
      policyConfigured: false,
    };
  }
  if (!host) {
    return {
      allowed: false,
      host: null,
      reason: "invalid-destination",
      detail: "не удалось разобрать адрес назначения egress-политикой",
      degraded: true,
      policyConfigured: true,
    };
  }
  const target = destination.trim().toLowerCase();
  for (const api of normalized.allowedApis) {
    if (target === api || target.startsWith(api)) {
      return {
        allowed: true,
        host,
        reason: "allowed-api",
        detail: `API-префикс ${api} разрешён egress-политикой`,
        degraded: false,
        policyConfigured: true,
      };
    }
  }
  for (const allowed of normalized.allowedHosts) {
    if (hostMatches(host, allowed)) {
      return {
        allowed: true,
        host,
        reason: "allowed-host",
        detail: `хост ${host} разрешён whitelist egress-политики`,
        degraded: false,
        policyConfigured: true,
      };
    }
  }
  return {
    allowed: false,
    host,
    reason: "blocked-host",
    detail: `хост ${host} отсутствует в whitelist egress-политики`,
    degraded: true,
    policyConfigured: true,
  };
}

/**
 * Execute-path choke point: действие выполняется ТОЛЬКО при разрешённом
 * выходе. При блоке действие не вызывается, `ok=false`, `status="degraded"` —
 * раннер не может сообщить об успехе «тихо».
 */
export async function runWithEgressDecision<T>(
  decision: EgressDecision,
  destination: string,
  action: (destination: string) => T | Promise<T>,
): Promise<EgressGuardedResult<T>> {
  if (!decision.allowed) {
    return {
      ok: false,
      status: "degraded",
      degraded: true,
      decision,
      reason: decision.detail,
    };
  }
  const value = await action(destination);
  return {
    ok: true,
    status: "ok",
    degraded: false,
    decision,
    reason: decision.detail,
    value,
  };
}

/** Удобная обёртка: checkEgress + execute-path guard в одном вызове. */
export async function runEgressGuarded<T>(
  policy: unknown,
  destination: string,
  action: (destination: string) => T | Promise<T>,
): Promise<EgressGuardedResult<T>> {
  return runWithEgressDecision(checkEgress(policy, destination), destination, action);
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
  // QA-A2.7: PermissionPolicy — подмножество string, поэтому достаточно string.
  policy?: string | null;
  /** Переходный флаг задачи: вернуть shell в гибридной политике. */
  legacyShell?: boolean;
  /** Явный allowlist задачи (уже нормализованный или сырой). */
  allowedTools?: readonly string[] | null;
  /** Явный denylist задачи. */
  deniedTools?: readonly string[] | null;
  /** ARCH-6.1: egress-политика scoped-конфига; отсутствие = fail-open. */
  egress?: unknown;
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
  /** ARCH-6.1: whitelist хостов/API или null (политика не задана). */
  egress: EgressPolicy | null;
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
 *    действие, запрещённое политикой (кроме явно запрещённых deniedTools);
 *    при этом безопасные read-only действия read/glob/grep/skill
 *    (READ_ONLY_TOOLS) разрешаются дополнительно, даже если их нет в списке, —
 *    PL-133: shell-only задача всё равно может читать код и загружать скиллы
 *    репозитория; явный deniedTools по-прежнему запрещает любое из них.
 */
export function resolvePermissions(input: PermissionInput = {}): EffectivePermissions {
  const policy = normalizePolicy(input.policy);
  const legacyShell = input.legacyShell === true;
  const allowedTools = normalizeToolList(input.allowedTools);
  const denied = actionsForTools(normalizeToolList(input.deniedTools));
  const allowed = actionsForTools(allowedTools);
  // PL-133: shell-only allowlist не должен блокировать чтение кода и скиллов.
  if (allowedTools.length > 0) {
    for (const action of actionsForTools(READ_ONLY_TOOLS)) allowed.add(action);
  }

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

  return { policy, legacyShell, permissions, deniedByPolicy, egress: normalizeEgressPolicy(input.egress) };
}

/** Готовый OPENCODE_CONFIG_CONTENT для обёрток. */
export function buildOpencodeConfig(input: PermissionInput = {}): string {
  const effective = resolvePermissions(input);
  // ARCH-6.1: egress добавляется в scoped-конфиг только когда политика задана.
  // Без неё вывод байт-в-байт прежний — fail-open для необязательной подсистемы.
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permissions: effective.permissions,
  };
  if (effective.egress) config.egress = effective.egress;
  return JSON.stringify(config, null, 2);
}

/** Краткое описание политики для лога задачи. */
export function formatPolicyLog(effective: EffectivePermissions): string {
  const denied = effective.permissions
    .filter((p) => p.effect === "deny")
    .map((p) => p.action);
  const legacyShell = effective.legacyShell ? ", legacyShell=true" : "";
  return `policy=${effective.policy}${legacyShell}, denied=${denied.length > 0 ? denied.join(",") : "none"}`;
}
