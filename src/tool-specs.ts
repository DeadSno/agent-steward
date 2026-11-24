/**
/*.
 *
 * Типы и общая логика построителя вынесены сюда из src/index.ts. Entrypoint
 * остаётся адаптером: он объявляет конкретные инструменты (имена, схемы,
 * описания и execute-обработчики), а вызов buildToolSpecs применяет общие
 * правила дочернего прогона и профилей. Так V1/V2 получают один и тот же
 * контракт, а ядро не тянет платформенные пакеты.
 */
import type { z } from "zod";
import type { AuditEntryInput } from "./core/audit.js";
import { CHILD_RUN_ENV, isChildRunMode } from "./core/run-mode.js";
import { filterToolSpecsByProfile } from "./core/tool-profile.js";

/**
 * Структурный аналог `Tool.Result` из @opencode/schema/tool.
 * duplicated здесь намеренно: ядро не должно импортировать пакеты OpenCode.
 * Форма повторяет контракт 1:1, поэтому обработчики из адаптера совместимы
 * без приведений типов.
 */
export interface ToolResultLike {
  readonly output?: unknown;
  readonly content?:
    | string
    | readonly (| { readonly type: "text"; readonly text: string }
        | {
            readonly type: "file";
            readonly uri: string;
            readonly mime: string;
            readonly name?: string;
          })[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Контекст вызова инструмента: адаптеры пока не передают ничего конкретного. */
export type ToolExecuteContext = unknown;

/**
 * Бивариантные сигнатуры (паттерн `bivarianceHack`). Типизированные
 * обработчики из адаптера принимают конкретные `z.infer`-аргументы,
 * а реестр хранит их как `unknown`: вход проверен Zod-схемой инструмента
 * до вызова, поэтому приведение типов здесь не требуется.
 */
export type ToolSpecExecute = {
  bivarianceHack(args: unknown, context: ToolExecuteContext): Promise<ToolResultLike>;
}["bivarianceHack"];
export type ToolSpecAudit = {
  bivarianceHack(args: unknown): Omit<AuditEntryInput, "actor"> | null;
}["bivarianceHack"];

export interface ToolSpec {
  name: string;
  input: z.ZodTypeAny;
  /** PL-43: схема структурированного output (только V2 Code Mode; V1 использует content). */
  output?: z.ZodTypeAny;
  description: string;
  execute: ToolSpecExecute;
  /** Правила аудита; null/undefined — операция не пишется в журнал. */
  audit?: ToolSpecAudit;
}

/**
 * PL-70/PL-71: подсказки manage_* и честное пояснение про лимит /help остаются
 * в адаптере рядом с описаниями инструментов — там же, где они используются.
 */

/**
 * Общий построитель реестра. Вынесен из createToolSpecs в index.ts:
 * - QV-8: дочерний прогон не получает инструменты планировщика;
 * - T-1/T-3: фильтрация по профилю применяется к уже собранному реестру,
 *   полный список остаётся в исходнике и доступен через profile=all.
 */
export function buildToolSpecs<T extends ToolSpec>(
  _runtime: unknown,
  env: NodeJS.ProcessEnv,
  declarations: readonly T[],
): T[] {
  if (isChildRunMode(env)) {
    console.log(`[qv8] ${CHILD_RUN_ENV}: инструменты планировщика не регистрируются`);
    return [];
  }
  return filterToolSpecsByProfile(declarations, env);
}

/**
 * P-1.2/P-2.4/P-4.1: контрактный снимок имён всех 34 инструментов.
 * Используется MCP/dsh-адаптерами и тестами паритета; порядок — порядок
 * регистрации в адаптере `src/index.ts`.
 */
export const TOOL_NAMES = [
  "backup_db",
  "restore_db",
  "schedule_task",
  "schedule_advanced",
  "list_tasks",
  "update_task",
  "update_advanced",
  "delete_task",
  "run_task_now",
  "pause_task",
  "resume_task",
  "get_history",
  "get_task_logs",
  "dry_run",
  "pipeline_validate",
  "pipeline_apply",
  "pipeline_export",
  "manage_workspaces",
  "matrix_control",
  "get_metrics",
  "get_analytics",
  "self_analysis",
  "manage_settings",
  "manage_local_ai",
  "manage_templates",
  "manage_profiles",
  "transfer_tasks",
  "send_notification",
  "report_bug",
  "get_dashboard_info",
  "cleanup_history",
  "emit_event",
  "manage_secrets",
  "get_audit_log",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
