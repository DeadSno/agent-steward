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
  fallback: PermissionPolicy = DEFAULT_PERMISSION_POLICY
): PermissionPolicy {
  return typeof value === "string" &&
    (PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as PermissionPolicy)
    : fallback;
}

/** Нормализует список инструментов: trim, lower-case, без пустых и дублей. */
export function normalizeToolList(
  value: readonly string[] | null | undefined
): string[] {
  return Array.from(
    new Set(
      (value ?? [])
        .map((tool) => String(tool).trim().toLowerCase())
        .filter(Boolean)
    )
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
    2
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
