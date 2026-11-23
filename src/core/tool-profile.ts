/**
 * T-1/T-3: профили поверхности инструментов.
 *
 * Реестр остаётся полным (32 инструмента) в исходнике и в `all`-профиле,
 * но в главном агенте по умолчанию регистрируется только ядро: это снижает
 * плату за статические схемы на каждый запрос. Профиль читается из окружения
 * один раз на сборку реестра, поэтому его наследуют оба адаптера (V1/V2) и
 * любые будущие адаптеры (MCP/dsh), если они используют `createToolSpecs`.
 */

export type ToolProfile = "core" | "admin" | "all";

export const TOOL_PROFILE_ENV = "AGENT_STEWARD_TOOL_PROFILE";

/** Минимальный рабочий набор: планирование, запуск, диагностика. */
export const CORE_TOOL_NAMES = [
  "schedule_task",
  "update_task",
  "list_tasks",
  "run_task_now",
  "get_history",
  "get_task_logs",
  "dry_run",
  "get_dashboard_info",
] as const;

/** T-3: административные инструменты подключаются только по запросу. */
export const ADMIN_EXTRA_TOOL_NAMES = [
  "schedule_advanced",
  "update_advanced",
  "manage_workspaces",
  "manage_settings",
  "manage_local_ai",
  "manage_templates",
  "manage_profiles",
  "manage_secrets",
] as const;

/** Неизвестное/пустое значение безопасно даёт самый дешёвый профиль. */
export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = String(env[TOOL_PROFILE_ENV] ?? "").trim().toLowerCase();
  return raw === "admin" || raw === "all" ? raw : "core";
}

/** Пустой набор означает «без фильтрации» (профиль `all`). */
export function profileToolNames(profile: ToolProfile): ReadonlySet<string> {
  if (profile === "all") return new Set<string>();
  return new Set<string>(
    profile === "admin"
      ? [...CORE_TOOL_NAMES, ...ADMIN_EXTRA_TOOL_NAMES]
      : CORE_TOOL_NAMES,
  );
}

export function filterToolSpecsByProfile<T extends { name: string }>(
  specs: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  const profile = resolveToolProfile(env);
  if (profile === "all") return [...specs];
  const allowed = profileToolNames(profile);
  const filtered = specs.filter((spec) => allowed.has(spec.name));
  console.log(`[tool-profile] ${profile}: ${filtered.length}/${specs.length} tools`);
  return filtered;
}
