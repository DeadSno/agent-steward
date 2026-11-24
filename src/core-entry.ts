/**
 * Публичная точка входа `agent-steward/core` (P-1.2).
 *
 * Контракт фасада — только контекст-free ядро: runtime-примитивы и билдер
 * реестра инструментов. Адаптер OpenCode (`src/index.ts`) сюда НЕ импортируется:
 * он тянет `@opencode/*`, decorated-хуки V1/V2 и состояние плагина. Потребитель
 * `agent-steward/core` получает те же возможности без OpenCode-контекста и без
 * загрузки плагинных пакетов; `createRuntime`/`createToolSpecs` остаются в
 * корневом entrypoint'е `agent-steward` и предназначены только для адаптера.
 */
export {
  createRuntimeCore,
  type RuntimeContextLike,
  type SchedulerRuntime,
  type RuntimeDeps,
} from "./runtime.js";
export {
  TOOL_NAMES,
  buildToolSpecs,
  type ToolName,
  type ToolSpec,
  type ToolSpecExecute,
  type ToolSpecAudit,
  type ToolResultLike,
  type ToolExecuteContext,
} from "./tool-specs.js";
