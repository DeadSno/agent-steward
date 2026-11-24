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
// P-3.1: публичный контракт инвокера — тоже контекст-free (только node:child_process).
export {
  HARNESS_VALUES,
  HARNESS_NAMES,
  INVOKERS,
  resolveInvoker,
  OpencodeCliInvoker,
  DshHeadlessInvoker,
  AcpInvoker,
  CursorCliInvoker,
  type HarnessName,
  type AgentInvoker,
  type BuildCommandOptions,
  type BuiltCommand,
  type InvocationResult,
} from "./invokers/agent-invoker.js";
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
