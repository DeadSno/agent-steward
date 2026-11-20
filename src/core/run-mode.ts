/**
 * QV-8: маркер дочернего прогона `opencode run`.
 *
 * Обёртки задач выставляют `AGENT_STEWARD_CHILD_RUN=1` перед запуском ИИ.
 * Плагин читает маркер при загрузке и НЕ регистрирует инструменты
 * планировщика, RPC, скилл и дашборд: дочерний агент не должен рекурсивно
 * создавать задачи и не должен конкурировать с родительским дашбордом за порт.
 */

export const CHILD_RUN_ENV = "AGENT_STEWARD_CHILD_RUN";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** True, когда текущий процесс — дочерний `opencode run` задачи планировщика. */
export function isChildRunMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CHILD_RUN_ENV];
  if (typeof raw !== "string") return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}
