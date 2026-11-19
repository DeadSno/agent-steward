/**
 * Спринт 32 (Pipeline-as-code, 0.0.5): маппинг `PipelineSpec` → `TaskDefinition[]`.
 *
 * Модуль чистый: не читает БД и не трогает планировщик. Всё, что требует
 * состояния (разрешение имён workspace в id), передаётся через опции.
 * Маркеры `pipelineName` / `pipelineStepId` сохраняются в definition_json,
 * чтобы идемпотентный apply мог отличать шаги pipeline от «чужих» задач.
 */
import type { MatrixConfig, TaskDefinition } from "../task-transfer.js";
import {
  PIPELINE_VERSION,
  pipelineStepTaskName,
  type PipelineMatrix,
  type PipelineSpec,
  type PipelineStep,
  type PipelineTrigger,
  type PipelineWindowPolicy,
} from "./pipeline-spec.js";

export interface PipelineMapOptions {
  /**
   * Разрешение имени workspace в id. Если не задано, значения
   * `matrix.workspaces` считаются уже id. Apply передаёт резолвер из БД.
   */
  resolveWorkspaceId?: (nameOrId: string) => string | undefined;
}

export interface PipelineTaskMapping {
  tasks: TaskDefinition[];
  warnings: string[];
}

/**
 * Преобразует провалидированный pipeline в определения задач.
 *
 * Правила:
 *  - `trigger: dag` → задача без собственного триггера (`triggerType: "file"`),
 *    как матричные родители: её запускает только DAG-движок по `dependsOn`;
 *  - `needs` → `dependsOn` с именами задач (`<pipeline> <step>`);
 *  - `defaults` наследуются шагом;
 *  - матрица `workspaces` переносится в `matrix.workspaceIds`.
 */
export function pipelineSpecToTasks(
  spec: PipelineSpec,
  options: PipelineMapOptions = {},
): PipelineTaskMapping {
  const defaults = spec.defaults ?? {};
  const warnings: string[] = [];

  const nameByStep = new Map<string, string>();
  for (const step of spec.steps) {
    const explicit = step.name?.trim();
    nameByStep.set(
      step.id.toLowerCase(),
      explicit || pipelineStepTaskName(spec.name, step.id),
    );
  }

  const tasks = spec.steps.map((step) => {
    const trigger = step.trigger ?? defaults.trigger ?? "cron";
    const scheduleValue = step.schedule ?? defaults.schedule ?? "";
    const schedule = trigger === "cron" ? scheduleValue : "";

    const dependsOn = step.needs?.length
      ? step.needs.map((need) => nameByStep.get(need.toLowerCase())!)
      : undefined;

    const task: TaskDefinition = {
      name: nameByStep.get(step.id.toLowerCase())!,
      schedule,
      prompt: step.prompt,
      // TaskDefinition не знает "dag": ручной триггер "file" не регистрирует
      // cron, задачу запускает DAG-движок после успеха зависимостей.
      triggerType: trigger === "dag" ? "file" : trigger,
      ...(dependsOn ? { dependsOn } : {}),
      ...(step.qualityGate !== undefined ? { qualityGate: step.qualityGate } : {}),
      ...(step.beforeScript !== undefined ? { beforeScript: step.beforeScript } : {}),
      ...(step.afterScript !== undefined ? { afterScript: step.afterScript } : {}),
      ...(step.guards !== undefined ? { guards: step.guards } : {}),
      ...(step.model !== undefined || defaults.model !== undefined
        ? { model: step.model ?? defaults.model }
        : {}),
      ...(step.priority !== undefined || defaults.priority !== undefined
        ? { priority: step.priority ?? defaults.priority }
        : {}),
      ...(step.timeoutSeconds !== undefined || defaults.timeoutSeconds !== undefined
        ? { timeoutSeconds: step.timeoutSeconds ?? defaults.timeoutSeconds }
        : {}),
      ...(step.workingDirectory !== undefined || defaults.workingDirectory !== undefined
        ? { workingDirectory: step.workingDirectory ?? defaults.workingDirectory }
        : {}),
      ...(step.workspaceId !== undefined ? { workspaceId: step.workspaceId } : {}),
      ...(step.retryCount !== undefined || defaults.retryCount !== undefined
        ? { retryCount: step.retryCount ?? defaults.retryCount }
        : {}),
      ...(step.retryDelay !== undefined || defaults.retryDelay !== undefined
        ? { retryDelay: step.retryDelay ?? defaults.retryDelay }
        : {}),
      ...(step.allowedTools !== undefined || defaults.allowedTools !== undefined
        ? { allowedTools: step.allowedTools ?? defaults.allowedTools }
        : {}),
      ...(step.deniedTools !== undefined || defaults.deniedTools !== undefined
        ? { deniedTools: step.deniedTools ?? defaults.deniedTools }
        : {}),
      ...(step.timezone !== undefined || defaults.timezone !== undefined
        ? { timezone: step.timezone ?? defaults.timezone }
        : {}),
      ...(step.notBefore !== undefined ? { notBefore: step.notBefore } : {}),
      ...(step.notAfter !== undefined ? { notAfter: step.notAfter } : {}),
      ...(step.activeDays !== undefined ? { activeDays: step.activeDays } : {}),
      ...(step.windowPolicy !== undefined ? { windowPolicy: step.windowPolicy } : {}),
      ...(trigger === "once" && step.runAt !== undefined ? { runAt: step.runAt } : {}),
      ...(step.matrix ? { matrix: mapMatrix(step.matrix, options, warnings) } : {}),
      pipelineName: spec.name,
      pipelineStepId: step.id,
    };
    return task;
  });

  return { tasks, warnings };
}

function mapMatrix(
  matrix: PipelineMatrix,
  options: PipelineMapOptions,
  warnings: string[],
): MatrixConfig {
  const workspaceIds = matrix.workspaces.map((raw) => {
    const value = raw.trim();
    const resolved = options.resolveWorkspaceId?.(value);
    if (options.resolveWorkspaceId && !resolved) {
      warnings.push(`workspace «${value}» не найден — шаг будет отклонён при apply.`);
      return value;
    }
    return resolved ?? value;
  });
  return {
    workspaceIds,
    ...(matrix.strategy ? { strategy: matrix.strategy } : {}),
    ...(matrix.failureMode ? { failureMode: matrix.failureMode } : {}),
    ...(matrix.aggregation ? { aggregation: matrix.aggregation } : {}),
    ...(matrix.concurrency !== undefined ? { concurrency: matrix.concurrency } : {}),
    ...(matrix.createAggregator !== undefined
      ? { createAggregator: matrix.createAggregator }
      : {}),
  };
}

export interface PipelineExportResult {
  spec: PipelineSpec;
  warnings: string[];
}

/**
 * Обратный маппинг: задачи одного pipeline из БД → `PipelineSpec` для export.
 *
 * Восстанавливает `needs` по `dependsOn`, `matrix.workspaces` по
 * `matrix.workspaceIds`, trigger по `triggerType`. Шаг `dag` неотличим от
 * ручного `file`-шага с зависимостями, поэтому восстанавливается эвристикой:
 * `file`, без cron и watchPath, но с `dependsOn` → `dag`.
 */
export function tasksToPipelineSpec(
  tasks: TaskDefinition[],
  pipelineName: string,
): PipelineExportResult {
  const warnings: string[] = [];
  const own = tasks.filter(
    (task) =>
      task.pipelineName?.toLowerCase() === pipelineName.toLowerCase() &&
      Boolean(task.pipelineStepId),
  );

  const stepIdByTaskName = new Map<string, string>();
  for (const task of own) {
    const key = task.name.trim().toLowerCase();
    if (key && !stepIdByTaskName.has(key)) {
      stepIdByTaskName.set(key, task.pipelineStepId!);
    }
  }

  const steps: PipelineStep[] = own.map((task) => {
    const stepId = task.pipelineStepId!;
    const trigger = inferTrigger(task);
    const needs = task.dependsOn
      ?.map((dep) => {
        const id = stepIdByTaskName.get(dep.trim().toLowerCase());
        if (!id) {
          warnings.push(
            `Шаг «${stepId}»: зависимость «${dep}» не входит в pipeline и опущена.`,
          );
        }
        return id;
      })
      .filter((value): value is string => Boolean(value));

    const defaultName = pipelineStepTaskName(pipelineName, stepId);
    const step: PipelineStep = {
      id: stepId,
      ...(task.name.trim() !== defaultName ? { name: task.name } : {}),
      prompt: task.prompt,
      ...(needs?.length ? { needs } : {}),
      ...(trigger === "cron" && task.schedule ? { schedule: task.schedule } : {}),
      ...(trigger !== "cron" ? { trigger } : {}),
      ...(trigger === "once" && task.runAt !== undefined ? { runAt: task.runAt } : {}),
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.timeoutSeconds !== undefined ? { timeoutSeconds: task.timeoutSeconds } : {}),
      ...(task.workingDirectory !== undefined
        ? { workingDirectory: task.workingDirectory }
        : {}),
      ...(task.workspaceId !== undefined ? { workspaceId: task.workspaceId } : {}),
      ...(task.retryCount !== undefined ? { retryCount: task.retryCount } : {}),
      ...(task.retryDelay !== undefined ? { retryDelay: task.retryDelay } : {}),
      ...(task.qualityGate !== undefined ? { qualityGate: task.qualityGate } : {}),
      ...(task.beforeScript !== undefined ? { beforeScript: task.beforeScript } : {}),
      ...(task.afterScript !== undefined ? { afterScript: task.afterScript } : {}),
      ...(task.guards !== undefined ? { guards: task.guards } : {}),
      ...(task.allowedTools !== undefined ? { allowedTools: task.allowedTools } : {}),
      ...(task.deniedTools !== undefined ? { deniedTools: task.deniedTools } : {}),
      ...(task.matrix
        ? {
          matrix: {
            workspaces: task.matrix.workspaceIds,
            ...(task.matrix.strategy ? { strategy: task.matrix.strategy } : {}),
            ...(task.matrix.failureMode ? { failureMode: task.matrix.failureMode } : {}),
            ...(task.matrix.aggregation ? { aggregation: task.matrix.aggregation } : {}),
            ...(task.matrix.concurrency !== undefined
              ? { concurrency: task.matrix.concurrency }
              : {}),
            ...(task.matrix.createAggregator !== undefined
              ? { createAggregator: task.matrix.createAggregator }
              : {}),
          },
        }
        : {}),
      ...(task.timezone !== undefined ? { timezone: task.timezone } : {}),
      ...(task.notBefore !== undefined ? { notBefore: task.notBefore } : {}),
      ...(task.notAfter !== undefined ? { notAfter: task.notAfter } : {}),
      ...(task.activeDays !== undefined ? { activeDays: task.activeDays } : {}),
      ...(task.windowPolicy !== undefined
        ? { windowPolicy: task.windowPolicy }
        : {}),
    };
    return step;
  });

  return {
    spec: { version: PIPELINE_VERSION, name: pipelineName, steps },
    warnings,
  };
}

function inferTrigger(task: TaskDefinition): PipelineTrigger {
  const trigger = task.triggerType ?? "cron";
  if (
    trigger === "file" &&
    !task.schedule &&
    !task.watchPath &&
    Boolean(task.dependsOn?.length)
  ) {
    return "dag";
  }
  return trigger;
}
