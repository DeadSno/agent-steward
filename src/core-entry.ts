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
// S-1: открытый spec pipeline (DAG/гейты/бюджеты) без OpenCode-контекста.
export {
  parsePipelineYaml,
  type PipelineParseResult,
} from "./core/pipeline-io.js";
export {
  OPEN_PIPELINE_FORMAT,
  OPEN_PIPELINE_SPEC_VERSION,
  toOpenPipelineSpec,
  type OpenPipelineSpec,
  type OpenPipelineNode,
  type OpenPipelineEdge,
  type OpenPipelineBudget,
} from "./core/pipeline-open-spec.js";
// S-3: публичная метрика объективных гейтов и сэкономленных токенов.
export {
  RELIABILITY_SCORECARD_FORMAT,
  RELIABILITY_SCORECARD_METHODOLOGY_URL,
  RELIABILITY_SCORECARD_VERSION,
  MIN_OBJECTIVE_GATES_FOR_SCORE,
  GATE_WEIGHT,
  TOKEN_WEIGHT,
  buildReliabilityScorecard,
  type ReliabilityScorecard,
  type ReliabilityScorecardInput,
  type ReliabilityScorecardOptions,
  type ReliabilityGateOutcome,
  type GateScorecard,
  type GateTaskRow,
  type TokenScorecard,
} from "./core/reliability-scorecard.js";
// S-4: библиотека gate-passed рецептов с проверкой объективных доказательств.
export {
  RECIPE_LIBRARY_FORMAT,
  RECIPE_LIBRARY_VERSION,
  RECIPES_METHODOLOGY_URL,
  getRecipe,
  getRecipeLibrary,
  listRecipes,
  verifyAllRecipes,
  verifyRecipe,
  verifyRecipeById,
  type GatePassedRecipe,
  type RecipeGate,
  type RecipeGateEvidence,
  type RecipeLibrary,
  type RecipeVerification,
} from "./core/recipes.js";
// S-5: верифицированный чат — ответ только при объективном гейте/источнике.
export {
  VERIFIED_CHAT_FORMAT,
  VERIFIED_CHAT_METHODOLOGY_URL,
  VERIFIED_CHAT_VERSION,
  verifyChatAnswer,
  type ChatGateEvidence,
  type ChatSourceEvidence,
  type VerifiedChatDecision,
  type VerifiedChatEvidence,
  type VerifiedChatInput,
  type VerifiedChatOptions,
} from "./core/verified-chat.js";
// S-6: scaffolding проекта из gate-passed рецептов одной командой.
export {
  SCAFFOLD_FORMAT,
  SCAFFOLD_GATE_SCRIPT,
  SCAFFOLD_METHODOLOGY_URL,
  SCAFFOLD_PIPELINE_FILE,
  SCAFFOLD_README_FILE,
  SCAFFOLD_VERSION,
  scaffoldFromRecipe,
  scaffoldFromRecipeId,
  type ScaffoldOptions,
  type ScaffoldResult,
} from "./core/scaffold.js";
// AD-1.1: режим планировщика и capability хоста (без OpenCode-контекста).
export {
  DEFAULT_NATIVE_SCHEDULER_SETTINGS,
  NATIVE_SCHEDULER_HOST_ENV,
  NATIVE_SCHEDULER_INVARIANTS,
  NativeSchedulerUnavailableError,
  assertNativeSchedulerHost,
  detectNativeSchedulerHost,
  nativeSchedulerContract,
  normalizeNativeSchedulerSettings,
  resolveSchedulerMode,
  type NativeSchedulerHostInfo,
  type NativeSchedulerInvariant,
  type NativeSchedulerSettings,
  type SchedulerMode,
} from "./core/native-scheduler.js";
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
