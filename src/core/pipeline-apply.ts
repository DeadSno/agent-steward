import type { TaskDefinition } from "../task-transfer.js";
import type { PipelineSpec } from "./pipeline-spec.js";
import { pipelineSpecToTasks } from "./pipeline-map.js";

export interface PipelineApplyPlan {
  /** Задачи, которых ещё нет в БД. */
  creates: TaskDefinition[];
  /** Задачи с изменённым определением. */
  updates: { task: TaskDefinition; previous: TaskDefinition }[];
  /** Задачи, определение не изменилось. */
  unchanged: TaskDefinition[];
  /** Задачи этого pipeline, которых больше нет в YAML (не удаляются автоматически). */
  stale: TaskDefinition[];
  warnings: string[];
}

export interface PipelineApplyResult {
  created: number;
  updated: number;
  unchanged: number;
  stale: number;
}

export interface PipelineApplyHandlers {
  create(task: TaskDefinition): Promise<void> | void;
  update(task: TaskDefinition): Promise<void> | void;
}

const SIGNATURE_FIELDS = [
  "name",
  "schedule",
  "prompt",
  "triggerType",
  "dependsOn",
  "model",
  "priority",
  "timeoutSeconds",
  "workingDirectory",
  "workspaceId",
  "retryCount",
  "retryDelay",
  "qualityGate",
  "beforeScript",
  "afterScript",
  "allowedTools",
  "deniedTools",
  "matrix",
  "timezone",
  "notBefore",
  "notAfter",
  "activeDays",
  "windowPolicy",
  "runAt",
  "pipelineName",
  "pipelineStepId",
] as const;

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = normalizeValue(source[key]);
    }
    return result;
  }
  return value;
}

/** Стабильная подпись значимых полей задачи — для сравнения create/update/unchanged. */
export function pipelineTaskSignature(task: TaskDefinition): string {
  const picked: Record<string, unknown> = {};
  const source = task as unknown as Record<string, unknown>;
  for (const field of SIGNATURE_FIELDS) {
    if (source[field] !== undefined) picked[field] = normalizeValue(source[field]);
  }
  return JSON.stringify(picked);
}

function samePipeline(task: TaskDefinition, pipelineName: string): boolean {
  return (
    typeof task.pipelineName === "string" &&
    task.pipelineName.toLowerCase() === pipelineName.toLowerCase()
  );
}

/**
 * Чистый diff: сравнивает желаемые задачи pipeline с существующими.
 * Задачи без маркеров pipelineName/pipelineStepId не трогаются никогда.
 */
export function planPipelineApply(
  spec: PipelineSpec,
  existing: TaskDefinition[],
  options: { resolveWorkspaceId?: (value: string) => string | undefined } = {},
): PipelineApplyPlan {
  const mapped = pipelineSpecToTasks(spec, options);
  const create: TaskDefinition[] = [];
  const updates: { task: TaskDefinition; previous: TaskDefinition }[] = [];
  const unchanged: TaskDefinition[] = [];

  const byStep = new Map<string, TaskDefinition>();
  for (const task of existing) {
    if (!samePipeline(task, spec.name)) continue;
    const stepId = task.pipelineStepId;
    if (typeof stepId !== "string" || !stepId) continue;
    byStep.set(stepId.toLowerCase(), task);
  }

  for (const task of mapped.tasks) {
    const previous = byStep.get((task.pipelineStepId ?? "").toLowerCase());
    if (!previous) {
      create.push(task);
      continue;
    }
    if (pipelineTaskSignature(previous) === pipelineTaskSignature(task)) {
      unchanged.push(task);
    } else {
      updates.push({ task, previous });
    }
    byStep.delete((task.pipelineStepId ?? "").toLowerCase());
  }

  const stale = [...byStep.values()];
  const warnings = [...mapped.warnings];
  if (stale.length > 0) {
    warnings.push(
      `В YAML больше нет шагов: ${stale.map((task) => task.name).join(", ")}. ` +
        "Они не удалены автоматически — удалите вручную или верните шаг.",
    );
  }

  return { creates: create, updates, unchanged, stale, warnings };
}

/** Применяет план через переданные обработчики (БД/планировщик) и считает итог. */
export async function executePipelineApply(
  plan: PipelineApplyPlan,
  handlers: PipelineApplyHandlers,
): Promise<PipelineApplyResult> {
  let created = 0;
  for (const task of plan.creates) {
    await handlers.create(task);
    created += 1;
  }
  let updated = 0;
  for (const entry of plan.updates) {
    await handlers.update(entry.task);
    updated += 1;
  }
  return {
    created,
    updated,
    unchanged: plan.unchanged.length,
    stale: plan.stale.length,
  };
}
