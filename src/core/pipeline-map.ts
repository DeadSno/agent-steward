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
  pipelineStepTaskName,
  type PipelineMatrix,
  type PipelineSpec,
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
