/**
 * AC-1: единый путь исполнения.
 *
 * Любой запуск — зарегистрированная задача или ad-hoc миссия — сначала
 * превращается в `RunContext` (вход, задача, профиль, безопасность), затем в
 * план `createRun → декомпозиция → маршрут → исполнение → GATE → ledger`.
 * Транспорт (OpenCode, локальная модель, облако) скрыт за `StepExecutor`,
 * поэтому ядро не зависит от конкретного CLI.
 *
 * Модуль намеренно не запускает процессы сам: исполнитель передаётся снаружи.
 * Это позволяет тестировать путь без регистрации задачи в ОС и подменять
 * OpenCode на любой другой транспорт.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createRun,
  finishRun,
  finishStep,
  getStep,
  recordGateOutcome,
  startRun,
  type GateOutcomeRecord,
  type GateVerdictValue,
} from "../db/runs-repo.js";
import { runStepStatefullyAsync } from "../db/run-journal.js";
import type { CompiledContext, CompileContextOptions } from "../db/run-context.js";
import { isGateQuarantined, recordGateVerdict } from "../db/capability-repo.js";
import {
  MAX_ESCALATION_STEPS,
  escalateAfterGate,
  runGateWithRetry,
  type GateOutcome as EscalationOutcome,
  type GateResult as EscalationGateResult,
  type GateTarget,
  type GateVerdict as EscalationVerdict,
} from "./router/escalation.js";
import {
  abortDeferredEffects,
  applyDeferredEffects,
  EffectSagaError,
  gateSnapshotPath,
  recordEffectIntents,
  worktreeGuardPaths,
  type EffectIntent,
  type EffectSagaResult,
} from "./gate-integrity.js";
import {
  planMission,
  type MissionDecomposer,
  type MissionStep,
  type PlanSource,
} from "./router/planner.js";
import {
  compileContextForRoute,
  EXECUTOR_MODEL,
  recompileContextForRouteEscalation,
  routeStep,
  type StepRoute,
} from "./router/dispatch.js";
import type { CapabilityThresholds } from "../db/capability-repo.js";
import {
  classifyRiskClass,
  compilePermissionPolicy,
  isRiskClass,
  requiresApproval,
  type CompiledPermissionPolicy,
  type RiskClass,
} from "./permissions.js";
import {
  recordApprovalGateBlock,
  recordApprovalPendingExecution,
  requestApproval,
  type ApprovalRecord,
} from "./audit.js";

/** Откуда пришёл запуск. Оба источника идут одним путём. */
export type RunOrigin = "registered" | "ad-hoc";

/** Что инициировало запуск. */
export type RunTrigger = "manual" | "cron" | "file" | "git" | "mcp-event" | "once" | "webhook";

/** Политика доступа к инструментам (совпадает с core/permissions). */
export type RunPermissionPolicy = "hybrid" | "secure" | "legacy";

/** Профиль исполнения: модель, сессия и рабочее пространство. */
export interface RunProfile {
  model?: string | null;
  session?: "new" | "reuse" | "last";
  sessionId?: string | null;
  workspaceId?: string | null;
}

/** Контракт безопасности запуска. */
export interface RunSafety {
  policy: RunPermissionPolicy;
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
}

/**
 * AC-1.1: контракт контекста запуска.
 * Содержит всё, что нужно ядру до первого шага, и не содержит транспорта.
 */
export interface RunContext {
  origin: RunOrigin;
  trigger: RunTrigger;
  taskName: string;
  /** Исходная миссия/промпт, по которой строится план. */
  mission: string;
  /** Промпт, который получит исполнитель (обычно совпадает с mission). */
  prompt: string;
  cwd: string;
  /** Явный тип задачи: если задан, декомпозиция не нужна. */
  taskType?: string;
  profile: RunProfile;
  safety: RunSafety;
  /** ARCH-2.1: класс риска (R0..R3), вычисленный по gate/tool scope. */
  riskClass: RiskClass;
  /** ARCH-2.2: детерминированная компиляция политики для этого класса. */
  compiledPolicy: CompiledPermissionPolicy;
  /** Свободные метаданные: родительский запуск, матрица, источник. */
  metadata?: Record<string, unknown>;
}

/** Структурный минимум определения зарегистрированной задачи. */
export interface RegisteredTaskLike {
  name: string;
  prompt: string;
  taskType?: string;
  schedule?: string;
  priority?: number;
  model?: string | null;
  workingDirectory?: string;
  workdir?: string;
  workspaceId?: string;
  session?: "new" | "reuse" | "last";
  sessionId?: string | null;
  allowedTools?: string[];
  deniedTools?: string[];
  triggerType?: RunTrigger;
  qualityGate?: string;
  beforeScript?: string;
  afterScript?: string;
}

/** Опции фабрик контекста. */
export interface RunContextOverrides {
  cwd?: string;
  taskName?: string;
  taskType?: string;
  trigger?: RunTrigger;
  policy?: RunPermissionPolicy;
  /** ARCH-2.1: явно заданный класс риска; иначе выводится из scope. */
  riskClass?: RiskClass;
  profile?: Partial<RunProfile>;
  safety?: Partial<RunSafety>;
  metadata?: Record<string, unknown>;
}

/**
 * ARCH-2.1/2.2: вычисляет класс риска и компилирует политику для обоих
 * входов. Явная политика/списки переопределяют базу класса, но политика
 * по умолчанию (hybrid) базу не перекрывает — поэтому один класс даёт одну
 * политику и в ad-hoc, и в registered пути.
 */
function resolveRiskPolicy(
  safety: RunSafety,
  overrides: RunContextOverrides,
  gate: unknown,
): { riskClass: RiskClass; compiledPolicy: CompiledPermissionPolicy } {
  const scope = {
    gate: typeof gate === "string" && gate.trim() ? gate : null,
    allowedTools: safety.allowedTools,
    deniedTools: safety.deniedTools,
    policy: safety.policy,
  };
  const riskClass = overrides.riskClass ?? classifyRiskClass(scope);
  const policyExplicit = overrides.policy !== undefined || overrides.safety?.policy !== undefined;
  const compiledPolicy = compilePermissionPolicy({
    riskClass,
    policy: policyExplicit ? safety.policy : undefined,
    allowedTools: safety.allowedTools,
    deniedTools: safety.deniedTools,
  });
  return { riskClass, compiledPolicy };
}

function normalizeList(values?: readonly string[]): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const cleaned = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

function assertNonEmpty(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new Error(`Пустой ${field}: запуск невозможен`);
  return text;
}

function normalizePolicy(policy?: RunPermissionPolicy): RunPermissionPolicy {
  return policy === "secure" || policy === "legacy" ? policy : "hybrid";
}

/**
 * AC-1.1: контекст зарегистрированной задачи. Определение из БД — только
 * источник данных; дальнейший путь не отличается от ad-hoc.
 */
export function createRegisteredRunContext(
  definition: RegisteredTaskLike,
  overrides: RunContextOverrides = {},
): RunContext {
  const taskName = assertNonEmpty(overrides.taskName ?? definition.name, "имя задачи");
  const prompt = assertNonEmpty(definition.prompt, "промпт задачи");
  const cwd =
    overrides.cwd?.trim() ||
    definition.workingDirectory?.trim() ||
    definition.workdir?.trim() ||
    process.cwd();
  const safety = {
    policy: normalizePolicy(overrides.safety?.policy ?? overrides.policy),
    allowedTools: normalizeList(overrides.safety?.allowedTools ?? definition.allowedTools),
    deniedTools: normalizeList(overrides.safety?.deniedTools ?? definition.deniedTools),
  };
  const { riskClass, compiledPolicy } = resolveRiskPolicy(
    safety,
    overrides,
    definition.qualityGate,
  );
  return {
    origin: "registered",
    trigger: overrides.trigger ?? definition.triggerType ?? "manual",
    taskName,
    mission: prompt,
    prompt,
    cwd,
    ...(overrides.taskType ?? definition.taskType
      ? { taskType: overrides.taskType ?? definition.taskType }
      : {}),
    profile: {
      model: overrides.profile?.model ?? definition.model ?? null,
      session: overrides.profile?.session ?? definition.session ?? "new",
      sessionId: overrides.profile?.sessionId ?? definition.sessionId ?? null,
      workspaceId: overrides.profile?.workspaceId ?? definition.workspaceId ?? null,
    },
    safety,
    riskClass,
    compiledPolicy,
    metadata: {
      ...(overrides.metadata ?? {}),
      schedule: definition.schedule ?? null,
      priority: definition.priority ?? 5,
      qualityGate: definition.qualityGate ?? null,
      beforeScript: definition.beforeScript ?? null,
      afterScript: definition.afterScript ?? null,
    },
  };
}

/** AC-1.1: контекст ad-hoc миссии — без записи в ОС и без task definition. */
export function createAdHocRunContext(
  mission: string,
  overrides: RunContextOverrides = {},
): RunContext {
  const text = assertNonEmpty(mission, "миссия");
  const taskName = assertNonEmpty(overrides.taskName ?? "ad-hoc", "имя запуска");
  const cwd = overrides.cwd?.trim() || process.cwd();
  const safety = {
    policy: normalizePolicy(overrides.safety?.policy ?? overrides.policy),
    allowedTools: normalizeList(overrides.safety?.allowedTools),
    deniedTools: normalizeList(overrides.safety?.deniedTools),
  };
  const { riskClass, compiledPolicy } = resolveRiskPolicy(
    safety,
    overrides,
    overrides.metadata?.gate,
  );
  return {
    origin: "ad-hoc",
    trigger: overrides.trigger ?? "manual",
    taskName,
    mission: text,
    prompt: text,
    cwd,
    ...(overrides.taskType ? { taskType: overrides.taskType } : {}),
    profile: {
      model: overrides.profile?.model ?? null,
      session: overrides.profile?.session ?? "new",
      sessionId: overrides.profile?.sessionId ?? null,
      workspaceId: overrides.profile?.workspaceId ?? null,
    },
    safety,
    riskClass,
    compiledPolicy,
    metadata: overrides.metadata,
  };
}

/** Проверяет контракт безопасности до создания запуска. */
export function validateRunContext(context: RunContext): void {
  assertNonEmpty(context.taskName, "имя запуска");
  assertNonEmpty(context.prompt, "промпт запуска");
  assertNonEmpty(context.cwd, "рабочая директория");
  // Контексты, собранные вручную старым кодом, могут не иметь riskClass —
  // не ломаем их, но явно некорректное значение отклоняем.
  if (context.riskClass !== undefined && !isRiskClass(context.riskClass)) {
    throw new Error(`Неизвестный класс риска: ${String(context.riskClass)}`);
  }
  if (!["hybrid", "secure", "legacy"].includes(context.safety.policy)) {
    throw new Error(`Неизвестная политика безопасности: ${String(context.safety.policy)}`);
  }
  const allowed = new Set(context.safety.allowedTools ?? []);
  const denied = context.safety.deniedTools ?? [];
  const conflict = denied.find((tool) => allowed.has(tool));
  if (conflict) {
    throw new Error(`Инструмент "${conflict}" одновременно разрешён и запрещён`);
  }
}

/* ------------------------------------------------------------------------- *
 * ARCH-1.2/1.3: provenance гейта (gate/policy/prompt hash) и ledger-запись
 * ------------------------------------------------------------------------- */

/** SHA-256 строки или канонического JSON значения. */
function sha256(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Три хэша входов гейта из единого RunContext: самого гейта, политики доступа
 * и промпта. `gate` можно переопределить явно; иначе берём qualityGate из
 * метаданных задачи или имя задачи. Значения хэшируются детерминированно,
 * поэтому один и тот же вход у registered и ad-hoc даёт одинаковый хэш.
 */
export function contextGateHashes(
  context: RunContext,
  gate?: unknown,
): { gateHash: string; policyHash: string; promptHash: string } {
  const gateValue = gate ?? context.metadata?.qualityGate ?? context.taskName;
  const policyValue = {
    policy: context.safety.policy,
    allowedTools: context.safety.allowedTools ?? [],
    deniedTools: context.safety.deniedTools ?? [],
  };
  return {
    gateHash: sha256(gateValue),
    policyHash: sha256(policyValue),
    promptHash: sha256(context.prompt),
  };
}

/**
 * ARCH-7.2: стабильный ключ запроса на одобрение. Явный `approval.approvalKey`
 * выигрывает; иначе ключ детерминированно выводится из контекста — одинаковая
 * миссия не создаёт дубликатов в очереди.
 */
export function approvalKeyFor(
  context: RunContext,
  options: Pick<ExecutePlanOptions, "approval"> = {},
): string {
  const explicit = options.approval?.approvalKey ?? context.metadata?.approvalKey;
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  return `approval:${sha256({
    origin: context.origin,
    taskName: context.taskName,
    mission: context.mission,
    cwd: context.cwd,
    trigger: context.trigger,
    riskClass: context.riskClass,
  })}`;
}

/**
 * Приводит RunTrigger к trigger_kind из docs/EXECUTION-LOOP.md §3.
 * ad-hoc миссия ≠ зарегистрированная задача даже при том же prompt.
 */
export function triggerKindFor(context: RunContext): string {
  if (context.origin === "ad-hoc") return "adhoc";
  if (context.trigger === "mcp-event") return "mcp";
  // PL-91: webhook-запуск не должен попадать в ledger как manual.
  if (context.trigger === "webhook") return "webhook";
  return context.trigger;
}

export interface WriteGateOutcomeOptions {
  context: RunContext;
  runId: string;
  stepId?: string | null;
  stepName: string;
  taskType?: string | null;
  executor?: string | null;
  routeSource?: string | null;
  routeReason?: string | null;
  gateType?: string | null;
  verdict: GateVerdictValue;
  attempt?: number;
  firstPass?: boolean;
  evidencePath?: string | null;
  missionId?: string | null;
  /** Явное значение gate вместо metadata.qualityGate / taskName. */
  gate?: unknown;
}

/**
 * Единая точка записи вердикта гейта в ledger. Используется и ядром исполнения,
 * и рекордером зарегистрированных задач — оба входа пишут одинаковый набор
 * хэшей и trigger_kind. Ключ идемпотентности уникален на (run, step, verdict, attempt).
 */
export function writeGateOutcome(options: WriteGateOutcomeOptions): GateOutcomeRecord {
  const hashes = contextGateHashes(options.context, options.gate);
  const attempt = Math.max(1, Math.floor(options.attempt ?? 1));
  return recordGateOutcome({
    outcomeKey: `${options.runId}:${options.stepName}:${options.verdict}:${attempt}`,
    missionId: options.missionId ?? null,
    runId: options.runId,
    stepId: options.stepId ?? null,
    stepName: options.stepName,
    taskType: options.taskType ?? options.context.taskType ?? null,
    triggerKind: triggerKindFor(options.context),
    executor: options.executor ?? null,
    routeSource: options.routeSource ?? null,
    routeReason: options.routeReason ?? null,
    gateType: options.gateType ?? null,
    verdict: options.verdict,
    attemptsToPass: attempt,
    firstPass: options.firstPass ?? options.verdict === "pass",
    evidencePath: options.evidencePath ?? null,
    gateHash: hashes.gateHash,
    policyHash: hashes.policyHash,
    promptHash: hashes.promptHash,
    modelVersion: options.context.profile.model ?? null,
  });
}

/** Один шаг плана с готовым маршрутом (AC-1.3: трассировка). */
export interface PlannedStep extends MissionStep {
  order: number;
  route: StepRoute;
  /**
   * PL-94: контекст, собранный из ledger после роутинга. Исполнителю передаётся
   * именно он, а не сырой `RunContext`; при эскалации пересобирается заново.
   */
  compiledContext?: CompiledContext;
}

/** План исполнения: контекст + шаги + источник декомпозиции. */
export interface ExecutionPlan {
  context: RunContext;
  steps: PlannedStep[];
  source: PlanSource;
  ambiguousTaskTypes: string[];
  warnings: string[];
}

/** Опции построения плана. */
export interface BuildPlanOptions {
  maxSteps?: number;
  decomposer?: MissionDecomposer;
  thresholds?: CapabilityThresholds;
  /** PL-94: параметры компиляции контекста (кроме taskType/model — их даёт маршрут). */
  compileContext?: Omit<CompileContextOptions, "taskType" | "model">;
}

function planStepsForContext(
  context: RunContext,
  options: BuildPlanOptions,
): Promise<{ steps: MissionStep[]; source: PlanSource; ambiguous: string[] }> {
  if (context.taskType) {
    return Promise.resolve({
      steps: [{ stepName: context.taskName, taskType: context.taskType }],
      source: "heuristic",
      ambiguous: [],
    });
  }
  return planMission(context.mission, {
    maxSteps: options.maxSteps,
    decomposer: options.decomposer,
  }).then((plan) => ({
    steps: plan.steps,
    source: plan.source,
    ambiguous: plan.ambiguousTaskTypes,
  }));
}

/**
 * AC-1.3: строит план и маршрут каждого шага до первого исполнения.
 * Сам по себе план ничего не запускает — это и есть dry-run.
 */
export async function buildExecutionPlan(
  context: RunContext,
  options: BuildPlanOptions = {},
): Promise<ExecutionPlan> {
  validateRunContext(context);
  const planned = await planStepsForContext(context, options);
  const warnings: string[] = [];
  const qualityGate =
    typeof context.metadata?.qualityGate === "string" && context.metadata.qualityGate.trim()
      ? context.metadata.qualityGate.trim()
      : null;
  const quarantined = qualityGate !== null && isGateQuarantined(qualityGate);
  if (quarantined) {
    warnings.push(`Гейт "${qualityGate}" в карантине: автоматический роутинг отключён.`);
  }
  const steps = planned.steps.map((step, order) => {
    const baseRoute = routeStep(step.taskType, options.thresholds);
    const route: StepRoute = quarantined
      ? {
        ...baseRoute,
        target: "review",
        executor: null,
        transport: null,
        reason: `gate-quarantined:${qualityGate}`,
      }
      : baseRoute;
    if (route.target === "review" || route.target === "explore") {
      warnings.push(
        `Шаг "${step.stepName}" (${step.taskType}) не исполняется автоматически: ${route.reason}`,
      );
    }
    const compiledContext = compileContextForRoute(route, {
      rootDir: context.cwd,
      ...(options.compileContext ?? {}),
    });
    return { ...step, order, route, compiledContext };
  });
  return {
    context,
    steps,
    source: planned.source,
    ambiguousTaskTypes: planned.ambiguous,
    warnings,
  };
}

/** Человекочитаемая трассировка маршрута для dry-run и логов. */
export function describeExecutionPlan(plan: ExecutionPlan): string {
  const lines = [
    `План ${plan.context.origin}: ${plan.context.taskName} → ${plan.steps.length} шаг(ов), источник ${plan.source}`,
  ];
  for (const step of plan.steps) {
    const route = step.route;
    const target = route.executor ? `${route.executor}/${route.transport}` : route.target;
    lines.push(
      `  ${step.order + 1}. ${step.stepName} [${route.taskType}] → ${target} (${route.source}: ${route.reason})`,
    );
  }
  for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

/** Вход исполнителя шага: всё, что нужно транспорту, без знания о ядре. */
export interface StepExecutionInput {
  step: PlannedStep;
  context: RunContext;
  /** Полный план — исполнителю может понадобиться предыдущий шаг. */
  plan: ExecutionPlan;
  /** PL-94: детерминированный контекст из ledger (может отсутствовать в старых планах). */
  compiledContext?: CompiledContext;
}

/** Результат исполнителя шага. */
export interface StepExecutionResult {
  output?: unknown;
  /** Явная ошибка без исключения; ядро переведёт шаг в failed. */
  error?: string;
  /**
   * PL-62: код выхода процесса агента. Отделен от вердикта гейта: ненулевой
   * код сам по себе не означает провал, если qualityGate прошёл.
   */
  exitCode?: number;
}

/**
 * AC-1.2: абстракция исполнителя. Ядро не знает, OpenCode это, локальная
 * модель или облачный API — только умеет ли исполнитель взять маршрут.
 */
export interface StepExecutor {
  readonly id: string;
  supports(route: StepRoute): boolean;
  execute(input: StepExecutionInput): Promise<StepExecutionResult> | StepExecutionResult;
  /**
   * PL-92: сериализуемый способ восстановить исполнителя после краша.
   * Без него `metadata.durableExecution` нельзя воссоздать в новом процессе.
   */
  readonly descriptor?: StepExecutorDescriptor;
}

/**
 * PL-92: как именно исполнялся шаг. Хранится в `runs.metadata_json`, чтобы
 * `resumeDurableRunExecution` мог поднять тот же транспорт без доступа к
 * исходному объекту `StepExecutor` (функции не сериализуются).
 */
export type StepExecutorDescriptor =
  | { kind: "opencode" }
  | {
      kind: "mission-wrapper";
      wrapperPath: string;
      cwd: string;
      timeoutSeconds: number;
    };

/** PL-92: самодостаточное описание для возобновления прерванного запуска. */
export interface DurableExecutionDescriptor {
  schema: 1;
  plan: ExecutionPlan;
  executor: StepExecutorDescriptor;
  evidencePath: string | null;
}

/** PL-92: выбирает первого исполнителя с сериализуемым дескриптором. */
export function durableExecutorDescriptor(
  executors: readonly StepExecutor[],
): StepExecutorDescriptor | null {
  return executors.find((executor) => executor.descriptor)?.descriptor ?? null;
}

/** HTTP-/CLI-независимый исполнитель OpenCode: транспорт передаётся функцией. */
export interface OpenCodeInvocation {
  prompt: string;
  cwd: string;
  model: string | null;
  session: RunProfile["session"];
  sessionId: string | null;
  step: PlannedStep;
  context: RunContext;
  /** PL-94: хэш скомпилированного контекста для трассировки прогона. */
  contextHash?: string;
}

export function createOpenCodeExecutor(
  invoke: (input: OpenCodeInvocation) => unknown,
  id = "opencode",
): StepExecutor {
  return {
    id,
    descriptor: { kind: "opencode" },
    supports: (route) => route.executor !== null,
    async execute({ step, context, plan, compiledContext }) {
      const output = await invoke({
        prompt: plan.context.prompt,
        cwd: plan.context.cwd,
        model: plan.context.profile.model ?? null,
        session: plan.context.profile.session ?? "new",
        sessionId: plan.context.profile.sessionId ?? null,
        step,
        context,
        ...(compiledContext ? { contextHash: compiledContext.contextHash } : {}),
      });
      return { output };
    },
  };
}

/** Вердикт GATE после шага. */
export interface GateVerdict {
  ok: boolean;
  reason?: string;
  /** PL-93: явный вердикт ARCH-3.1; по умолчанию выводится из `ok`. */
  verdict?: EscalationVerdict;
}

export type Gate = (
  input: StepExecutionInput & { result: StepExecutionResult; attempt?: number },
) => GateVerdict | Promise<GateVerdict>;

/**
 * PL-102: гейт по факту выполнения шага для production-вызовов, у которых
 * quality gate — это команда обёртки, а не JavaScript-функция. Команда гейта
 * продолжает выполняться внутри обёртки на каждой попытке, а этот гейт
 * проверяет, что агент вернул результат без ошибки/ненулевого кода, и даёт
 * execution loop вердикт для retry/эскалации и capability map.
 */
export function agentResultGate({
  result,
}: StepExecutionInput & { result: StepExecutionResult }): GateVerdict {
  if (typeof result.error === "string" && result.error.trim()) {
    return { ok: false, reason: result.error, verdict: "fail" };
  }
  if (typeof result.exitCode === "number" && result.exitCode !== 0) {
    return {
      ok: false,
      reason: `Код выхода агента ${result.exitCode}`,
      verdict: "fail",
    };
  }
  return { ok: true, verdict: "pass" };
}

/** Ошибка GATE: шаг выполнен, но результат не принят. */
export class GateRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GateRejectedError";
  }
}

/* ------------------------------------------------------------------------- *
 * PL-62: код выхода процесса агента ≠ результат Quality Gate.
 *
 * Обёртка раньше помечала задачу `error` («Код возврата 1»), хотя агент
 * завершил работу, и пропускала qualityGate/коммит только потому, что код
 * выхода процесса агента был ненулевым. Код выхода — это факт завершения
 * процесса, а не вердикт проверки. Решение принимается по гейту, а при
 * расхождении (exit != 0, gate=pass) причина кода фиксируется в логе и истории.
 * ------------------------------------------------------------------------- */

/** PL-62: вход решения о запуске qualityGate при ненулевом коде агента. */
export interface AgentExitGateInput {
  /** Код выхода процесса агента (например, `opencode run`). */
  readonly agentExitCode: number;
  /** Задан ли qualityGate у задачи. */
  readonly hasQualityGate: boolean;
  /** Есть ли признаки того, что агент реально выполнил работу (артефакты/вывод). */
  readonly workCompleted?: boolean;
  /** Куда писать диагностику (по умолчанию — `console.warn`). */
  readonly log?: (message: string) => void;
}

/**
 * PL-62: решает, нужно ли запускать qualityGate.
 *
 * Ненулевой код выхода сам по себе не отменяет гейт: если агент оставил
 * артефакты/вывод, гейт запускается и уже его вердикт определяет статус.
 * Гейт пропускается только при настоящей аварии до работы (нет вывода),
 * либо когда он не задан.
 */
export function shouldRunQualityGate(input: AgentExitGateInput): boolean {
  const workCompleted = input.workCompleted ?? true;
  const run =
    input.hasQualityGate && (input.agentExitCode === 0 || workCompleted === true);
  if (!run && input.hasQualityGate && input.agentExitCode !== 0) {
    (input.log ?? ((line) => console.warn(line)))(
      `[agent-steward] PL-62: qualityGate пропущен: код выхода ${input.agentExitCode} при отсутствии артефактов работы`,
    );
  }
  return run;
}

/** PL-62: итоговое решение по расхождению кода выхода агента и гейта. */
export interface AgentExitVerdict {
  /** Статус задачи с учётом вердикта гейта, а не только кода выхода. */
  readonly status: "success" | "error";
  /** Причина, которую нужно записать в историю/лог (null при чистом успехе). */
  readonly reason: string | null;
  /** Код выхода и гейт разошлись. */
  readonly diverged: boolean;
  /** qualityGate/afterScript должны быть запущены, даже если код ненулевой. */
  readonly runQualityGate: boolean;
  readonly runAfterScript: boolean;
  /** Диагностические строки с префиксом PL-62. */
  readonly logLines: readonly string[];
}

/** PL-62: вход {@link resolveAgentExitVerdict}. */
export interface AgentExitVerdictInput {
  /** Код выхода процесса агента. */
  readonly agentExitCode: number;
  /** Вердикт qualityGate: `true`/`false`, либо `null`, если гейта нет. */
  readonly gatePassed: boolean | null;
  /** Признак выполненной работы (артефакты/вывод). */
  readonly workCompleted?: boolean;
  /** Имя задачи для диагностики. */
  readonly taskName?: string;
  /** Куда писать диагностику (по умолчанию — `console.warn`). */
  readonly log?: (message: string) => void;
}

/**
 * PL-62: различает код выхода процесса агента и результат qualityGate.
 *
 * - gate=pass + exit!=0 → расхождение: статус `success`, после-runScript
 *   запускается, причина кода 1 логируется с префиксом PL-62;
 * - gate=fail → `error` (при exit=0 это тоже расхождение, в сторону гейта);
 * - гейта нет → статус определяется кодом выхода.
 */
export function resolveAgentExitVerdict(input: AgentExitVerdictInput): AgentExitVerdict {
  const workCompleted = input.workCompleted ?? true;
  const code = Number.isFinite(input.agentExitCode) ? Math.trunc(input.agentExitCode) : 1;
  const runQualityGate = shouldRunQualityGate({
    agentExitCode: code,
    hasQualityGate: input.gatePassed !== null,
    workCompleted,
    log: input.log,
  });
  const runAfterScript = true; // post-flight выполняется всегда, включая расхождения.
  const logLines: string[] = [];
  const emit = (line: string): void => {
    logLines.push(line);
    (input.log ?? ((message) => console.warn(message)))(line);
  };

  if (input.gatePassed === true) {
    if (code === 0) {
      return {
        status: "success",
        reason: null,
        diverged: false,
        runQualityGate,
        runAfterScript,
        logLines,
      };
    }
    const reason = `Код возврата ${code} при пройденном qualityGate (PL-62)`;
    emit(
      `[agent-steward] PL-62: расхождение: код выхода процесса агента ${code}, qualityGate=pass — ` +
        `задача '${input.taskName ?? ""}' считается успешной, причина кода зафиксирована`,
    );
    return {
      status: "success",
      reason,
      diverged: true,
      runQualityGate,
      runAfterScript,
      logLines,
    };
  }

  if (input.gatePassed === false) {
    const reason =
      code === 0
        ? "Quality Gate провален (PL-62: расхождение с кодом выхода 0)"
        : `Quality Gate провален (код возврата агента ${code})`;
    if (code === 0) {
      emit(
        "[agent-steward] PL-62: расхождение: код выхода 0, qualityGate=fail — статус error по вердикту гейта",
      );
    }
    return {
      status: "error",
      reason,
      diverged: code === 0,
      runQualityGate,
      runAfterScript,
      logLines,
    };
  }

  // Гейта нет: код выхода остаётся единственным источником статуса.
  if (code === 0) {
    return {
      status: "success",
      reason: null,
      diverged: false,
      runQualityGate,
      runAfterScript,
      logLines,
    };
  }
  const reason = `Код возврата ${code}`;
  emit(
    `[agent-steward] PL-62: qualityGate не задан, код выхода ${code} — статус error, причина зафиксирована`,
  );
  return {
    status: "error",
    reason,
    diverged: false,
    runQualityGate,
    runAfterScript,
    logLines,
  };
}

/* ------------------------------------------------------------------------- *
 * PL-58: атрибуция файлов коммита (фактический diff задачи vs manifest)
 * ------------------------------------------------------------------------- */

/** Приводит путь из `git diff --name-only` / `-Files` к одному виду. */
function normalizeCommitPath(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/**
 * PL-58: парсит вывод `git diff --name-only` в нормализованный список путей
 * (без пустых строк и дублей, с прямыми слешами).
 */
export function commitFilesFromDiff(diffOutput: string): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const line of String(diffOutput ?? "").split(/\r?\n/)) {
    const file = normalizeCommitPath(line);
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

/** PL-58: результат сопоставления фактического diff задачи с её manifest. */
export interface CommitFileAttribution {
  /** Изменённые файлы из manifest — их задача вправе коммитить. */
  commitFiles: string[];
  /** Изменённые файлы вне manifest — чужие, от параллельных задач. */
  foreignFiles: string[];
}

/**
 * PL-58: вычисляет список файлов коммита из фактического diff задачи
 * (`git diff --name-only`) и отделяет чужие файлы, которых нет в manifest.
 */
export function commitFilesForTask(
  diffOutput: string,
  manifest: readonly string[],
): CommitFileAttribution {
  const changed = commitFilesFromDiff(diffOutput);
  const allowed = new Set(manifest.map(normalizeCommitPath).filter(Boolean));
  return {
    commitFiles: changed.filter((file) => allowed.has(file)),
    foreignFiles: changed.filter((file) => !allowed.has(file)),
  };
}

/** Параметры qualityGate атрибуции коммита (PL-58). */
export interface CommitAttributionGateOptions {
  /** Manifest задачи — файлы, которые она вправе коммитить (`-Files`). */
  manifest: readonly string[];
  /**
   * Источник вывода `git diff --name-only`. Инъекция: ядро исполнения не
   * запускает процессы само — транспорт/процессы передаются снаружи.
   */
  diff: () => string | Promise<string>;
}

/**
 * PL-58: qualityGate, который отклоняет коммит с чужими файлами. Возвращает
 * `ok: false`, если фактический diff задачи содержит пути вне её manifest —
 * типичное следствие параллельных задач в одном worktree (ARCH-3 утащил
 * файлы ARCH-1/ARCH-2, а ARCH-1 остался почти пустым).
 */
export function createCommitAttributionGate(options: CommitAttributionGateOptions): Gate {
  return async () => {
    const attribution = commitFilesForTask(await options.diff(), options.manifest);
    if (attribution.foreignFiles.length > 0) {
      return {
        ok: false,
        reason: `PL-58: коммит содержит чужие файлы вне manifest: ${attribution.foreignFiles.join(", ")}`,
      };
    }
    return { ok: true };
  };
}

/* ------------------------------------------------------------------------- *
 * PL-59: обязательный worktree-snapshot для задач с qualityGate.
 *
 * Раньше снимок дерева (PL-25) снимался обёрткой «тихо»: если каталог не был
 * git-репозиторием, не задавался workdir или не создавался файл снимка, в
 * курсе не оставался никто — в get_history просто висел
 * `preFlightStatus=skipped`. Теперь решение фиксируется структурой с ясной
 * причиной пропуска, причина логируется, а для qualityGate-задач с
 * guarded-путями снимок становится обязательным (fail-closed).
 * ------------------------------------------------------------------------- */

/** PL-59: решение о снимке рабочего дерева для задачи с qualityGate. */
export interface WorktreeSnapshotDecision {
  /** qualityGate + git-дерево с guarded-путями → снимок обязателен. */
  readonly required: boolean;
  /** Файл снимка создан. */
  readonly taken: boolean;
  /** Человекочитаемая причина пропуска; пустая, если снимок снят. */
  readonly skipReason: string;
  readonly guardedPaths: readonly string[];
  readonly workdir: string | null;
  readonly snapshotFile: string;
}

/** Параметры {@link decideWorktreeSnapshot}; `exists`/`log` — инъекции для тестов. */
export interface WorktreeSnapshotDecisionOptions {
  readonly taskName: string;
  readonly qualityGate?: string | null;
  readonly workdir?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  /** Явно заданные guarded-пути; по умолчанию из AGENT_STEWARD_GATE_GUARD_PATHS. */
  readonly guardedPaths?: readonly string[];
  readonly exists?: (file: string) => boolean;
  readonly log?: (message: string) => void;
}

/** Имя файла worktree-снимка рядом со snapshot'ом входов гейта. */
export function worktreeSnapshotFileFor(taskName: string): string {
  const gateFile = gateSnapshotPath(taskName);
  return path.join(path.dirname(gateFile), `${path.basename(gateFile, ".json")}.worktree.json`);
}

/**
 * PL-59: решает, нужен ли снимок дерева, и объясняет каждый пропуск.
 * Никаких процессов не запускается — только проверка путей и логирование.
 */
export function decideWorktreeSnapshot(
  options: WorktreeSnapshotDecisionOptions,
): WorktreeSnapshotDecision {
  const guardedPaths = [...(options.guardedPaths ?? worktreeGuardPaths(options.env))];
  const workdir = options.workdir?.trim() || null;
  const snapshotFile = worktreeSnapshotFileFor(options.taskName);
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  const hasGate = Boolean(options.qualityGate?.trim());

  let required = false;
  let skipReason = "";
  if (!hasGate) {
    skipReason = "qualityGate не задан — worktree-snapshot не требуется";
  } else if (!workdir) {
    skipReason = "не задан workdir задачи — снимок дерева невозможен";
  } else if (!exists(path.join(workdir, ".git"))) {
    // PL-25: не-git каталоги не guarding — сравнивать не с чем.
    skipReason = "дерево не является git-репозиторием (PL-25: проверка отключена)";
  } else if (guardedPaths.length === 0) {
    skipReason = "не заданы guarded-пути — сравнивать нечего";
  } else {
    const present = guardedPaths.filter((item) => exists(path.join(workdir, item)));
    if (present.length === 0) {
      skipReason = `в дереве нет guarded-путей (${guardedPaths.join(", ")})`;
    } else {
      required = true;
      if (!exists(snapshotFile)) {
        skipReason = `обязательный worktree-snapshot отсутствует: ${snapshotFile}`;
      }
    }
  }

  const taken = required ? exists(snapshotFile) : false;
  const decision: WorktreeSnapshotDecision = {
    required,
    taken,
    skipReason: required && taken ? "" : skipReason,
    guardedPaths,
    workdir,
    snapshotFile,
  };
  options.log?.(
    `[agent-steward] PL-59: worktree-snapshot ${required ? "обязателен" : "пропущен"}: ` +
      (decision.skipReason || "снят"),
  );
  return decision;
}

/**
 * PL-59: fail-closed проверка перед прогоном qualityGate. Для задачи с
 * qualityGate и guarded-путями отсутствующий снимок — ошибка, а не тихий
 * `preFlightStatus=skipped`.
 */
export function enforceWorktreeSnapshot(decision: WorktreeSnapshotDecision): void {
  if (decision.required && !decision.taken) {
    throw new Error(
      `Quality Gate: обязательный worktree-snapshot отсутствует (${decision.snapshotFile}). ` +
        `guarded-пути: ${decision.guardedPaths.join(", ")}. Причина: ${decision.skipReason}`,
    );
  }
}

/** Результат выполнения одного шага. */
export interface ExecutedStep {
  stepName: string;
  taskType: string;
  target: StepRoute["target"];
  status: "passed" | "failed" | "skipped";
  attempt: number;
  output?: unknown;
  error?: string;
}

/** ARCH-7.2: параметры гейта ручных одобрений. */
export interface ApprovalGateOptions {
  /** Стабильный ключ запроса (иначе вычисляется из контекста). */
  approvalKey?: string;
  /** Ссылка на будущий запуск в аудите одобрений. */
  runRef?: string;
  /** Кто инициировал запрос. */
  actor?: string;
  /** Причина запроса. */
  reason?: string;
}

/** Результат выполнения плана. */
export interface ExecutionResult {
  /** null, если запуск не создан (ARCH-7.2: нет одобрения). */
  runId: string | null;
  status: "passed" | "failed" | "awaiting_approval" | "rejected";
  steps: ExecutedStep[];
  error: string | null;
  plan: ExecutionPlan;
  /** ARCH-4: результаты саг отложенных эффектов по шагам. */
  effects?: EffectSagaResult[];
  /** ARCH-7.2: состояние очереди одобрений, если класс риска её требует. */
  approval?: ApprovalRecord;
  /** PL-59: решение о worktree-snapshot (только для registered + qualityGate). */
  snapshot?: WorktreeSnapshotDecision;
}

/**
 * PL-93: включение flake-aware retry и таблицы переходов эскалации.
 * По умолчанию выключено, чтобы не менять существующие прогоны с одним
 * исполнителем: старый контракт `gate: {ok, reason}` сохраняется.
 */
export interface ExecutionEscalationOptions {
  enabled?: boolean;
  /** Сколько автоматических переходов допустимо (1..MAX_ESCALATION_STEPS). */
  maxEscalations?: number;
}

/** Опции исполнения. */
export interface ExecutePlanOptions {
  /** Исполнители в порядке приоритета. */
  executors: StepExecutor[];
  gate?: Gate;
  /** Останавливаться на первой ошибке (по умолчанию true). */
  stopOnError?: boolean;
  /** Дополнительные метаданные запуска. */
  metadata?: Record<string, unknown>;
  /** ARCH-1.3: путь к логу/артефакту — provenance для gate_outcomes. */
  evidencePath?: string | null;
  /**
   * ARCH-4.1/4.2: отложенные внешние эффекты. Объявляются ДО гейта,
   * исполняются только после вердикта pass; при отказе одного эффекта
   * уже применённые обратимые эффекты откатываются (saga).
   */
  effects?: readonly EffectIntent[];
  /** Эффекты конкретных шагов (имеют приоритет над общими `effects`). */
  effectsByStep?: Readonly<Record<string, readonly EffectIntent[]>>;
  /**
   * ARCH-7.2: явный запрос ручного одобрения для R2/R3. Без этого поля
   * execution loop работает как раньше, даже если класс риска требует
   * одобрения для привилегированных операций.
   */
  approval?: ApprovalGateOptions;
  /** PL-93: retry гейта и эскалация local → cloud → review. */
  escalation?: ExecutionEscalationOptions;
}

function pickExecutor(step: PlannedStep, executors: StepExecutor[]): StepExecutor | undefined {
  return executors.find((executor) => executor.supports(step.route));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------- *
 * PL-93:retry вердикта гейта и таблица переходов эскалации в execution loop.
 * ------------------------------------------------------------------------- */

function gateTargetForRoute(route: StepRoute): GateTarget {
  if (route.target === "cloud") return "cloud";
  if (route.target === "review" || route.target === "explore") return "review";
  return "local";
}

function routeForTarget(route: StepRoute, target: GateTarget): StepRoute {
  if (target === "local") {
    return { ...route, target: "local", executor: "local", transport: "direct" };
  }
  if (target === "cloud") {
    return { ...route, target: "cloud", executor: "cloud", transport: "cloud" };
  }
  return { ...route, target: "review", executor: null, transport: null };
}

/** Ключ гейта для capability_map: явный qualityGate, иначе имя шага. */
function gateKeyFor(plan: ExecutionPlan, step: PlannedStep): string {
  const qualityGate = plan.context.metadata?.qualityGate;
  return typeof qualityGate === "string" && qualityGate.trim()
    ? qualityGate.trim()
    : step.stepName;
}

/** PL-93: вердикт гейта обучает capability_map и обновляет карантин. */
function recordCapabilityGateVerdict(
  runId: string,
  step: PlannedStep,
  plan: ExecutionPlan,
  outcome: EscalationOutcome,
  attempt: number,
): void {
  const reasons = outcome.reasons.filter((reason) => reason.length > 0).join("; ");
  recordGateVerdict({
    outcomeKey: `esc:${runId}:${step.stepName}:${attempt}`,
    taskType: step.route.taskType,
    gateKey: gateKeyFor(plan, step),
    verdict: outcome.verdict,
    attemptsToPass: outcome.attemptsToPass,
    firstPass: outcome.firstPass,
    runId,
    stepName: step.stepName,
    gateType: gateKeyFor(plan, step),
    ...(reasons ? { reason: reasons } : {}),
  });
}

interface EscalatedStepExecution {
  output: unknown;
  executorId: string;
  target: GateTarget;
  outcome: EscalationOutcome;
  escalations: number;
}

/**
 * Исполняет шаг с ARCH-3.1 retry гейта и ARCH-3 таблицей переходов.
 * Повтор гейта не перезапускает агента; эскалация меняет маршрут и, если для
 * нового уровня есть исполнитель, перезапускает шаг один раз.
 */
async function executeStepWithEscalation(
  runId: string,
  step: PlannedStep,
  plan: ExecutionPlan,
  options: ExecutePlanOptions,
  pick: (route: StepRoute) => StepExecutor | undefined,
  onOutcome: (outcome: EscalationOutcome) => void,
): Promise<EscalatedStepExecution> {
  const maxEscalations = Math.max(
    1,
    Math.min(MAX_ESCALATION_STEPS, Math.floor(options.escalation?.maxEscalations ?? MAX_ESCALATION_STEPS)),
  );
  let target = gateTargetForRoute(step.route);
  let escalations = 0;
  let compiledContext = step.compiledContext;

  for (;;) {
    const route = routeForTarget(step.route, target);
    // PL-94: эскалация меняет модель/окно — контекст пересобирается из ledger,
    // а не переиспользуется. Это тот же путь, что и в router/dispatch.ts.
    if (escalations > 0 && compiledContext) {
      compiledContext = recompileContextForRouteEscalation(compiledContext, {
        rootDir: plan.context.cwd,
        taskType: route.taskType,
        model: route.executor ? EXECUTOR_MODEL[route.executor] : compiledContext.model,
      }).context;
    }
    const effectiveStep: PlannedStep = { ...step, route, compiledContext };
    const executor = route.executor === null ? undefined : pick(route);
    if (!executor) {
      throw new Error(
        `Нет исполнителя для маршрута ${route.executor ?? "review"}/${String(route.transport)} после эскалации на ${target}`,
      );
    }
    const result = await executor.execute({
      step: effectiveStep,
      context: plan.context,
      plan,
      compiledContext,
    });
    const agentExitCode =
      typeof result.exitCode === "number" ? result.exitCode : result.error ? 1 : 0;
    const workCompleted = result.output !== undefined;
    let gateResult: EscalationGateResult;
    let outcome: EscalationOutcome;

    if (options.gate && shouldRunQualityGate({ agentExitCode, hasQualityGate: true, workCompleted })) {
      outcome = await runGateWithRetry(async (attempt) => {
        const verdict = await options.gate!({
          step: effectiveStep,
          context: plan.context,
          plan,
          compiledContext,
          result,
          attempt,
        });
        return {
          passed: verdict.ok,
          ...(verdict.reason ? { reason: verdict.reason } : {}),
          verdict: verdict.verdict ?? (verdict.ok ? "pass" : "fail"),
        } satisfies EscalationGateResult;
      });
      gateResult = {
        passed: outcome.passed,
        ...(outcome.reasons.length > 0 ? { reason: outcome.reasons.join("; ") } : {}),
        verdict: outcome.verdict,
      };
    } else {
      const decision = resolveAgentExitVerdict({
        agentExitCode,
        gatePassed: null,
        workCompleted,
        taskName: plan.context.taskName,
      });
      if (decision.status === "error") {
        throw new Error(result.error ?? decision.reason ?? "Код возврата агента");
      }
      outcome = {
        verdict: "pass",
        passed: true,
        attempts: 1,
        attemptsToPass: 1,
        firstPass: true,
        retried: false,
        reasons: [],
      };
      gateResult = { passed: true, verdict: "pass" };
    }

    recordCapabilityGateVerdict(runId, step, plan, outcome, escalations + 1);
    onOutcome(outcome);

    if (!gateResult.passed) {
      const decision = escalateAfterGate(target, gateResult);
      const canEscalate =
        (decision.action === "escalate-cloud" || decision.action === "escalate-review") &&
        escalations < maxEscalations &&
        decision.next !== target;
      const nextExecutor = canEscalate ? pick(routeForTarget(step.route, decision.next)) : undefined;
      // PL-102: обёртка миссии поддерживает и local, и cloud маршрут одним и
      // тем же исполнителем. Повторно дёргать его под другим target — это
      // дублирование дорогого прогона без смены модели/возможностей.
      if (nextExecutor?.id === executor.id) {
        throw new Error(
          `GATE: ${gateResult.reason ?? "шаг отклонён гейтом"} ` +
            `(PL-102: эскалация на ${decision.next} не выполнена — исполнитель ` +
            `"${executor.id}" не меняется при смене маршрута; нужен отдельный executor для cloud)`,
        );
      }
      if (nextExecutor && decision.next !== "review") {
        target = decision.next;
        escalations += 1;
        continue;
      }
      const reason = gateResult.reason ?? "GATE отклонил результат шага";
      throw new Error(`GATE: ${reason} (${decision.action}/${decision.reason})`);
    }

    return { output: result.output, executorId: executor.id, target, outcome, escalations };
  }
}

/**
 * AC-1.4: единое исполнение плана для зарегистрированной и ad-hoc миссии.
 *
 * Создаёт запуск в ledger, для каждого шага фиксирует running/passed/failed,
 * применяет GATE и завершает запуск. Шаги `review`/`explore` пропускаются:
 * их нельзя исполнить автоматически.
 */
export async function executeExecutionPlan(
  plan: ExecutionPlan,
  options: ExecutePlanOptions,
): Promise<ExecutionResult> {
  validateRunContext(plan.context);

  // PL-59: зарегистрированная задача с qualityGate обязана снимать снимок
  // дерева, если в нём есть guarded-пути. Причину пропуска логируем, а
  // обязательный, но отсутствующий снимок отклоняем до создания запуска.
  let snapshotDecision: WorktreeSnapshotDecision | undefined;
  const planGate = plan.context.metadata?.qualityGate;
  if (plan.context.origin === "registered" && typeof planGate === "string") {
    snapshotDecision = decideWorktreeSnapshot({
      taskName: plan.context.taskName,
      qualityGate: planGate,
      workdir: plan.context.cwd,
      log: (message) => console.warn(message),
    });
    enforceWorktreeSnapshot(snapshotDecision);
  }

  // ARCH-7.2: гейт одобрений — ДО createRun и до применения любых эффектов.
  // Гейт включается только при явном запросе (`options.approval`):
  // обычные ad-hoc/registered прогоны с hybrid-политикой (класс R2) не должны
  // внезапно требовать ручного одобрения. При отсутствии approve run не
  // создаётся, эффекты не объявляются и не применяются, а статус/аудит
  // показывают ожидание (или отказ).
  let approval: ApprovalRecord | null = null;
  // PL-92/PL-103: дескриптор нужен и здесь (отложенный план одобрения), и ниже
  // при создании run. Функции исполнителя не сериализуются, поэтому сохраняем
  // только описание транспорта.
  const durableDescriptor = durableExecutorDescriptor(options.executors);
  if (options.approval && requiresApproval(plan.context.riskClass)) {
    const requestId = approvalKeyFor(plan.context, options);
    const runRef = options.approval?.runRef ?? requestId;
    approval = requestApproval({
      requestId,
      taskName: plan.context.taskName,
      riskClass: plan.context.riskClass,
      runRef,
      reason: options.approval?.reason ?? null,
      actor: options.approval?.actor ?? "system",
      source: "execution-loop",
    });
    if (approval.status !== "approved") {
      // PL-103: сохраняем план, чтобы approve через RPC/GUI мог доиграть его.
      // Эффекты не сериализуются — для таких планов остаётся ручной перезапуск
      // исходным вызывающим кодом (факт сообщается ответом decide_approval).
      if (
        approval.status === "pending" &&
        durableDescriptor &&
        !(options.effects?.length) &&
        !(options.effectsByStep && Object.keys(options.effectsByStep).length)
      ) {
        recordApprovalPendingExecution(requestId, {
          schema: 1,
          plan,
          executor: durableDescriptor,
          evidencePath: options.evidencePath ?? null,
          approval: {
            approvalKey: options.approval?.approvalKey,
            runRef,
            reason: options.approval?.reason,
            actor: options.approval?.actor,
          },
          ...(options.escalation ? { escalation: options.escalation } : {}),
        });
      }
      const status = approval.status === "rejected" ? "rejected" : "awaiting_approval";
      const message =
        approval.status === "rejected"
          ? `Запуск "${plan.context.taskName}" отклонён (${requestId})`
          : `Запуск "${plan.context.taskName}" ожидает ручного одобрения (${requestId})`;
      recordApprovalGateBlock({
        requestId,
        taskName: plan.context.taskName,
        riskClass: plan.context.riskClass,
        runRef,
        reason: approval.reason,
        status: approval.status === "rejected" ? "rejected" : "pending",
        actor: options.approval?.actor ?? "system",
        source: "execution-loop",
      });
      return {
        runId: null,
        status,
        steps: [],
        error: message,
        plan,
        approval,
        ...(snapshotDecision ? { snapshot: snapshotDecision } : {}),
      };
    }
  }

  // PL-92: дескриптор уже вычислен до гейта и сохраняется в metadata run.

  const run = createRun({
    taskName: plan.context.taskName,
    steps: plan.steps.map((step) => ({ stepName: step.stepName })),
    metadata: {
      origin: plan.context.origin,
      trigger: plan.context.trigger,
      planSource: plan.source,
      routes: plan.steps.map((step) => ({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: step.route.target,
        transport: step.route.transport,
        executor: step.route.executor,
        source: step.route.source,
        reason: step.route.reason,
      })),
      ...(plan.context.metadata ?? {}),
      ...(options.metadata ?? {}),
      ...(approval
        ? { approvalRequestId: approval.requestId, approvalRunRef: approval.runRef }
        : {}),
      ...(durableDescriptor
        ? {
          durableExecution: {
            schema: 1,
            plan,
            executor: durableDescriptor,
            evidencePath: options.evidencePath ?? null,
          } satisfies DurableExecutionDescriptor,
        }
        : {}),
    },
  });
  startRun(run.id);

  const executed: ExecutedStep[] = [];
  const sagaResults: EffectSagaResult[] = [];
  let firstError: string | null = null;
  const stopOnError = options.stopOnError !== false;

  for (const step of plan.steps) {
    const executor =
      step.route.executor === null ? undefined : pickExecutor(step, options.executors);

    // review/explore или нет подходящего транспорта — шаг не исполняется.
    if (!executor) {
      const record = getStep(run.id, step.stepName);
      const reason =
        step.route.executor === null
          ? `маршрут ${step.route.target}: ${step.route.reason}`
          : `нет исполнителя для маршрута ${step.route.executor}/${String(step.route.transport)}`;
      if (record) {
        finishStep(record.id, "skipped", { error: reason });
      }
      executed.push({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: step.route.target,
        status: "skipped",
        attempt: record?.attempt ?? 0,
        error: reason,
      });
      continue;
    }

    // ARCH-4.1: намерения пишутся в ledger gate_outcomes ДО прогона гейта.
    // Ни один apply() (включая irreversible) здесь ещё не вызывается.
    const stepEffects = options.effectsByStep?.[step.stepName] ?? options.effects ?? [];
    let intentKey: string | null = null;
    if (stepEffects.length > 0) {
      const stepRecord = getStep(run.id, step.stepName);
      intentKey = recordEffectIntents({
        runId: run.id,
        stepName: step.stepName,
        stepId: stepRecord?.id ?? null,
        taskName: plan.context.taskName,
        attempt: stepRecord?.attempt ?? 1,
        intents: stepEffects,
        evidencePath: options.evidencePath ?? null,
      });
    }

    const escalationEnabled = options.escalation?.enabled === true;
    const escalationState: {
      outcome: EscalationOutcome | null;
      executorId: string | null;
      target: GateTarget | null;
    } = { outcome: null, executorId: null, target: null };

    try {
      const execution = await runStepStatefullyAsync(run.id, step.stepName, async () => {
        if (escalationEnabled) {
          const escalated = await executeStepWithEscalation(
            run.id,
            step,
            plan,
            options,
            (route) => options.executors.find((item) => item.supports(route)),
            (outcome) => {
              escalationState.outcome = outcome;
            },
          );
          escalationState.executorId = escalated.executorId;
          escalationState.target = escalated.target;
          return escalated.output;
        }
        const result = await executor.execute({
          step,
          context: plan.context,
          plan,
          compiledContext: step.compiledContext,
        });
        // PL-62: код выхода процесса агента — ещё не вердикт. Даже при
        // ненулевом коде запускаем гейт, если агент оставил артефакты/вывод.
        const agentExitCode =
          typeof result.exitCode === "number" ? result.exitCode : result.error ? 1 : 0;
        const workCompleted = result.output !== undefined;
        let gatePassed: boolean | null = null;
        if (
          options.gate &&
          shouldRunQualityGate({
            agentExitCode,
            hasQualityGate: true,
            workCompleted,
          })
        ) {
          const verdict = await options.gate({ step, context: plan.context, plan, result });
          gatePassed = verdict.ok;
          if (!verdict.ok) {
            throw new GateRejectedError(verdict.reason ?? "GATE отклонил результат шага");
          }
        }
        const decision = resolveAgentExitVerdict({
          agentExitCode,
          gatePassed,
          workCompleted,
          taskName: plan.context.taskName,
        });
        if (decision.status === "error") {
          throw new Error(result.error ?? decision.reason ?? "Код возврата агента");
        }
        return result.output;
      });
      // ARCH-4.1: гейт вернул pass — только теперь допустимы внешние эффекты.
      // ARCH-4.2: при падении одного эффекта сага сама откатит уже применённые
      // обратимые и бросит EffectSagaError с результатом для ledger/аудита.
      if (intentKey && stepEffects.length > 0) {
        try {
          sagaResults.push(await applyDeferredEffects(intentKey, stepEffects));
        } catch (error) {
          if (error instanceof EffectSagaError) sagaResults.push(error.result);
          throw error;
        }
      }
      // ARCH-1.2: успех гейта пишется из того же пути, что и шаг.
      writeGateOutcome({
        context: plan.context,
        runId: run.id,
        stepId: getStep(run.id, step.stepName)?.id ?? null,
        stepName: step.stepName,
        taskType: step.route.taskType,
        executor: escalationState.executorId ?? executor.id,
        routeSource: step.route.source,
        routeReason: escalationState.target
          ? `${step.route.reason};escalated-to:${escalationState.target}`
          : step.route.reason,
        gateType:
          typeof plan.context.metadata?.qualityGate === "string"
            ? plan.context.metadata.qualityGate
            : null,
        verdict: escalationState.outcome?.verdict ?? "pass",
        attempt: execution.attempt,
        firstPass: escalationState.outcome?.firstPass ?? execution.attempt === 1,
        evidencePath: options.evidencePath ?? null,
      });
      executed.push({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: escalationState.target ?? step.route.target,
        status: "passed",
        attempt: execution.attempt,
        output: execution.result,
      });
    } catch (error) {
      const message = errorMessage(error);
      // ARCH-4.1: гейт не прошёл (или упал эффект) — зафиксировать отказ в
      // ledger/аудит. abortDeferredEffects не вызывает apply() и не трогает
      // сагу, которая уже успела примениться/скомпенсироваться.
      if (intentKey) {
        const aborted = abortDeferredEffects(intentKey, message);
        if (aborted && !sagaResults.some((saga) => saga.outcomeKey === aborted.outcomeKey)) {
          sagaResults.push(aborted);
        }
      }
      firstError = firstError ?? message;
      const failedAttempt = getStep(run.id, step.stepName)?.attempt ?? 1;
      writeGateOutcome({
        context: plan.context,
        runId: run.id,
        stepId: getStep(run.id, step.stepName)?.id ?? null,
        stepName: step.stepName,
        taskType: step.route.taskType,
        executor: escalationState.executorId ?? executor.id,
        routeSource: step.route.source,
        routeReason: escalationState.target
          ? `${step.route.reason};escalated-to:${escalationState.target}`
          : step.route.reason,
        gateType:
          typeof plan.context.metadata?.qualityGate === "string"
            ? plan.context.metadata.qualityGate
            : null,
        verdict: escalationState.outcome?.verdict ?? "fail",
        attempt: failedAttempt,
        firstPass: false,
        evidencePath: options.evidencePath ?? null,
      });
      executed.push({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: escalationState.target ?? step.route.target,
        status: "failed",
        attempt: failedAttempt,
        error: message,
      });
      if (stopOnError) break;
    }
  }

  const failed = executed.some((step) => step.status === "failed");
  finishRun(run.id, failed ? "failed" : "passed", {
    ...(firstError ? { error: firstError } : {}),
  });
  return {
    runId: run.id,
    status: failed ? "failed" : "passed",
    steps: executed,
    error: firstError,
    plan,
    ...(approval ? { approval } : {}),
    ...(snapshotDecision ? { snapshot: snapshotDecision } : {}),
    ...(sagaResults.length > 0 ? { effects: sagaResults } : {}),
  };
}

/* ------------------------------------------------------------------------- *
 * M-1..M-4: примитивы мульти-агентной оркестрации живут в ./agents.js и
 * реэкспортируются здесь как часть единого пути исполнения. Поведение самого
 * execution loop не меняется: это чистые функции без сети и без БД.
 * ------------------------------------------------------------------------- */
export {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_MAX_ATTEMPTS,
  REDACTED,
  assignRole,
  buildContextArtifact,
  fallbackModel,
  postmortem,
  redactSecrets,
  retryWithPostmortem,
} from "./agents.js";
export type {
  AgentRole,
  ContextStep,
  Postmortem,
  PostmortemKind,
  RetryDecision,
  RetrySpec,
  RoleStep,
  StepResultLike,
} from "./agents.js";
