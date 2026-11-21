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
import {
  abortDeferredEffects,
  applyDeferredEffects,
  EffectSagaError,
  recordEffectIntents,
  type EffectIntent,
  type EffectSagaResult,
} from "./gate-integrity.js";
import {
  planMission,
  type MissionDecomposer,
  type MissionStep,
  type PlanSource,
} from "./router/planner.js";
import { routeStep, type StepRoute } from "./router/dispatch.js";
import type { CapabilityThresholds } from "../db/capability-repo.js";
import {
  classifyRiskClass,
  compilePermissionPolicy,
  isRiskClass,
  type CompiledPermissionPolicy,
  type RiskClass,
} from "./permissions.js";

/** Откуда пришёл запуск. Оба источника идут одним путём. */
export type RunOrigin = "registered" | "ad-hoc";

/** Что инициировало запуск. */
export type RunTrigger = "manual" | "cron" | "file" | "git" | "mcp-event" | "once";

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
 * Приводит RunTrigger к trigger_kind из docs/EXECUTION-LOOP.md §3.
 * ad-hoc миссия ≠ зарегистрированная задача даже при том же prompt.
 */
export function triggerKindFor(context: RunContext): string {
  if (context.origin === "ad-hoc") return "adhoc";
  if (context.trigger === "mcp-event") return "mcp";
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
  const steps = planned.steps.map((step, order) => {
    const route = routeStep(step.taskType, options.thresholds);
    if (route.target === "review" || route.target === "explore") {
      warnings.push(
        `Шаг "${step.stepName}" (${step.taskType}) не исполняется автоматически: ${route.reason}`,
      );
    }
    return { ...step, order, route };
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
}

/** Результат исполнителя шага. */
export interface StepExecutionResult {
  output?: unknown;
  /** Явная ошибка без исключения; ядро переведёт шаг в failed. */
  error?: string;
}

/**
 * AC-1.2: абстракция исполнителя. Ядро не знает, OpenCode это, локальная
 * модель или облачный API — только умеет ли исполнитель взять маршрут.
 */
export interface StepExecutor {
  readonly id: string;
  supports(route: StepRoute): boolean;
  execute(input: StepExecutionInput): Promise<StepExecutionResult> | StepExecutionResult;
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
}

export function createOpenCodeExecutor(
  invoke: (input: OpenCodeInvocation) => Promise<unknown> | unknown,
  id = "opencode",
): StepExecutor {
  return {
    id,
    supports: (route) => route.executor !== null,
    async execute({ step, context, plan }) {
      const output = await invoke({
        prompt: plan.context.prompt,
        cwd: plan.context.cwd,
        model: plan.context.profile.model ?? null,
        session: plan.context.profile.session ?? "new",
        sessionId: plan.context.profile.sessionId ?? null,
        step,
        context,
      });
      return { output };
    },
  };
}

/** Вердикт GATE после шага. */
export interface GateVerdict {
  ok: boolean;
  reason?: string;
}

export type Gate = (
  input: StepExecutionInput & { result: StepExecutionResult },
) => GateVerdict | Promise<GateVerdict>;

/** Ошибка GATE: шаг выполнен, но результат не принят. */
export class GateRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GateRejectedError";
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

/** Результат выполнения плана. */
export interface ExecutionResult {
  runId: string;
  status: "passed" | "failed";
  steps: ExecutedStep[];
  error: string | null;
  plan: ExecutionPlan;
  /** ARCH-4: результаты саг отложенных эффектов по шагам. */
  effects?: EffectSagaResult[];
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
}

function pickExecutor(step: PlannedStep, executors: StepExecutor[]): StepExecutor | undefined {
  return executors.find((executor) => executor.supports(step.route));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    try {
      const execution = await runStepStatefullyAsync(run.id, step.stepName, async () => {
        const result = await executor.execute({ step, context: plan.context, plan });
        if (result.error) {
          throw new Error(result.error);
        }
        if (options.gate) {
          const verdict = await options.gate({ step, context: plan.context, plan, result });
          if (!verdict.ok) {
            throw new GateRejectedError(verdict.reason ?? "GATE отклонил результат шага");
          }
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
        executor: executor.id,
        routeSource: step.route.source,
        routeReason: step.route.reason,
        gateType:
          typeof plan.context.metadata?.qualityGate === "string"
            ? plan.context.metadata.qualityGate
            : null,
        verdict: "pass",
        attempt: execution.attempt,
        firstPass: execution.attempt === 1,
        evidencePath: options.evidencePath ?? null,
      });
      executed.push({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: step.route.target,
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
        executor: executor.id,
        routeSource: step.route.source,
        routeReason: step.route.reason,
        gateType:
          typeof plan.context.metadata?.qualityGate === "string"
            ? plan.context.metadata.qualityGate
            : null,
        verdict: "fail",
        attempt: failedAttempt,
        firstPass: false,
        evidencePath: options.evidencePath ?? null,
      });
      executed.push({
        stepName: step.stepName,
        taskType: step.route.taskType,
        target: step.route.target,
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
    ...(sagaResults.length > 0 ? { effects: sagaResults } : {}),
  };
}
