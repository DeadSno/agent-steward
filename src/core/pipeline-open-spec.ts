/**
 * Деталь 3.19 / S-1 — открытый spec pipeline.
 *
 * `opencode.pipeline.yaml` остаётся рабочим форматом, но не должен быть
 * единственным способом прочитать pipeline: этот модуль превращает
 * провалидированную спецификацию в vendor-neutral описание DAG, объективных
 * гейтов и бюджетов.
 *
 * Модуль чистый: только типы и детерминированное преобразование, без БД,
 * планировщика ОС и сетевых вызовов.
 */
import { pipelineStepTaskName, type PipelineSpec, type PipelineStep } from "./pipeline-spec.js";

/** Версия открытого формата (семантическая, отделена от version YAML). */
export const OPEN_PIPELINE_SPEC_VERSION = "1.0" as const;
/** Идентификатор формата в поле `format`. */
export const OPEN_PIPELINE_FORMAT = "agent-steward.open-pipeline" as const;
/** Методика, рядом с которой честно показываются оценки. */
export const OPEN_PIPELINE_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/OPEN-SPEC.md#methodology";

export interface OpenPipelineBudget {
  /** Таймаут одного шага в секундах (null — определяется runtime). */
  timeoutSeconds: number | null;
  /** Число повторов после провала гейта. */
  retries: number;
  /** Приоритет планировщика. */
  priority: number | null;
  /** Модель шага (null — выбор харнесса). */
  model: string | null;
}

export interface OpenPipelineNode {
  /** Стабильный id шага из YAML. */
  id: string;
  /** Имя задачи, которое создаст `pipeline apply`. */
  taskName: string;
  trigger: string;
  prompt: string;
  /** Зависимости по id шагов (рёбра DAG строятся из этих значений). */
  needs: string[];
  gates: string[];
  budget: OpenPipelineBudget;
  tools: { allowed: string[]; denied: string[] };
}

export interface OpenPipelineEdge {
  from: string;
  to: string;
}

export interface OpenPipelineSpec {
  format: typeof OPEN_PIPELINE_FORMAT;
  version: typeof OPEN_PIPELINE_SPEC_VERSION;
  name: string;
  description: string | null;
  source: { format: "opencode.pipeline.yaml"; version: number };
  dag: { nodes: OpenPipelineNode[]; edges: OpenPipelineEdge[] };
  /** Объективные (команда/код возврата) гейты, по одному на каждый шаг с qualityGate. */
  gates: { stepId: string; kind: "qualityGate"; command: string }[];
  /** Сводный бюджет pipeline: сумма таймаутов и максимум повторов. */
  budgets: {
    steps: number;
    maxTimeoutSeconds: number | null;
    totalTimeoutSeconds: number | null;
    maxRetries: number;
    gates: number;
  };
  methodologyUrl: string;
}

function numberOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function budgetFor(step: PipelineStep, spec: PipelineSpec): OpenPipelineBudget {
  return {
    timeoutSeconds: numberOrNull(step.timeoutSeconds ?? spec.defaults?.timeoutSeconds),
    retries: step.retryCount ?? spec.defaults?.retryCount ?? 0,
    priority: numberOrNull(step.priority ?? spec.defaults?.priority),
    model: step.model ?? spec.defaults?.model ?? null,
  };
}

/**
 * Преобразует провалидированный `PipelineSpec` в открытое описание.
 *
 * Порядок nodes/edges/gates детерминирован и совпадает с порядком шагов YAML,
 * поэтому вывод пригоден для diff в PR и для снимков в тестах.
 */
export function toOpenPipelineSpec(spec: PipelineSpec): OpenPipelineSpec {
  const nodes = spec.steps.map((step) => ({
    id: step.id,
    taskName: step.name?.trim() || pipelineStepTaskName(spec.name, step.id),
    trigger: step.trigger ?? spec.defaults?.trigger ?? "cron",
    prompt: step.prompt,
    needs: [...(step.needs ?? [])],
    gates: step.qualityGate?.trim() ? [step.qualityGate.trim()] : [],
    budget: budgetFor(step, spec),
    tools: {
      allowed: [...(step.allowedTools ?? spec.defaults?.allowedTools ?? [])],
      denied: [...(step.deniedTools ?? spec.defaults?.deniedTools ?? [])],
    },
  }));

  const known = new Set(spec.steps.map((step) => step.id.toLowerCase()));
  const edges: OpenPipelineEdge[] = [];
  for (const step of spec.steps) {
    for (const need of step.needs ?? []) {
      if (!known.has(need.toLowerCase())) continue;
      edges.push({ from: need, to: step.id });
    }
  }

  const gates = spec.steps
    .filter((step) => step.qualityGate?.trim())
    .map((step) => ({
      stepId: step.id,
      kind: "qualityGate" as const,
      command: (step.qualityGate ?? "").trim(),
    }));

  const timeouts = spec.steps
    .map((step) => numberOrNull(step.timeoutSeconds ?? spec.defaults?.timeoutSeconds))
    .filter((value): value is number => value !== null);

  return {
    format: OPEN_PIPELINE_FORMAT,
    version: OPEN_PIPELINE_SPEC_VERSION,
    name: spec.name,
    description: spec.description ?? null,
    source: { format: "opencode.pipeline.yaml", version: spec.version },
    dag: { nodes, edges },
    gates,
    budgets: {
      steps: spec.steps.length,
      maxTimeoutSeconds: timeouts.length > 0 ? Math.max(...timeouts) : null,
      totalTimeoutSeconds: timeouts.length > 0 ? timeouts.reduce((sum, value) => sum + value, 0) : null,
      maxRetries: Math.max(
        0,
        ...spec.steps.map((step) => step.retryCount ?? spec.defaults?.retryCount ?? 0),
      ),
      gates: gates.length,
    },
    methodologyUrl: OPEN_PIPELINE_METHODOLOGY_URL,
  };
}
