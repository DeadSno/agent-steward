/**
 * AD-1.1: бэкенд планировщика для хоста с нативным триггером.
 *
 * ВАЖНО: это НЕ новый движок. Бэкенд лишь регистрирует задачу в том же реестре
 * и передаёт её хост-триггеру. Сам запуск проходит через существующий
 * execution loop (`run_task_now` → RunContext → buildExecutionPlan →
 * executeExecutionPlan), поэтому ledger, DLQ, бюджет, approval и гейты не
 * обходятся. Нет ни одного вызова schtasks/crontab/launchd.
 */
import type { ScheduledTaskInfo } from "../../types.js";
import type { NativeSchedulerHostInfo } from "../native-scheduler.js";
import type { CreateTaskOptions, RunTaskResult, SchedulerBackend } from "./types.js";
import type { RegistryEntry } from "./registry.js";

/** Минимальный контракт реестра, достаточный нативному бэкенду. */
export interface NativeRegistryLike {
  load(): Promise<RegistryEntry[]>;
  upsert(entry: RegistryEntry): Promise<void>;
  remove(name: string): Promise<void>;
  setPaused(name: string, paused: boolean): Promise<void>;
}

/** Опции бэкенда нативного хоста. */
export interface NativeSchedulerBackendOptions {
  /** Обнаруженная capability хоста. */
  host: NativeSchedulerHostInfo;
  /** Реестр задач (тот же, что используется POSIX-бэкендами). */
  registry: NativeRegistryLike;
  /** Колбэк запуска: реализуется рантаймом через существующий execution loop. */
  trigger: (name: string) => Promise<RunTaskResult>;
  /** ОС хоста — информационно, по умолчанию текущая. */
  platform?: NodeJS.Platform;
}

/**
 * Native-бэкенд: регистрация в реестре + triplet-переход в общий execution loop.
 */
export class NativeSchedulerBackend implements SchedulerBackend {
  readonly platform: NodeJS.Platform;
  readonly title = "native-scheduler";

  constructor(private readonly options: NativeSchedulerBackendOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** Хост, на котором работает бэкенд (для диагностики и контракта). */
  get host(): NativeSchedulerHostInfo {
    return this.options.host;
  }

  async createTask(options: CreateTaskOptions): Promise<void> {
    const entry: RegistryEntry = {
      name: options.name,
      schedule: options.schedule,
      command: options.command,
      triggerType: options.triggerType ?? "cron",
      paused: false,
      createdAt: new Date().toISOString(),
      ...(options.runAt ? { runAt: options.runAt } : {}),
      ...(options.logFile ? { logFile: options.logFile } : {}),
      ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
    };
    await this.options.registry.upsert(entry);
  }

  async deleteTask(name: string): Promise<void> {
    await this.options.registry.remove(name);
  }

  /**
   * Запуск целиком делегируется рантайму — здесь нет ни одного вызова LLM,
   * записи в ledger или выбора модели. Если задачи нет в реестре, ошибка.
   */
  async runTask(name: string): Promise<RunTaskResult> {
    const entries = await this.options.registry.load();
    if (!entries.some((entry) => entry.name === name)) {
      throw new Error(`Задача ${name} не зарегистрирована в native-режиме`);
    }
    return this.options.trigger(name);
  }

  async listTasks(): Promise<ScheduledTaskInfo[]> {
    const entries = await this.options.registry.load();
    return entries.map((entry) => ({
      taskName: entry.name,
      status: entry.paused ? "disabled" : "ready",
      comment: `native:${this.options.host.name}`,
      paused: entry.paused,
    }));
  }

  async pauseTask(name: string): Promise<void> {
    await this.options.registry.setPaused(name, true);
  }

  async resumeTask(name: string): Promise<void> {
    await this.options.registry.setPaused(name, false);
  }
}

/** Фабрика бэкенда нативного хоста (для регистрации в планировщике). */
export function createNativeSchedulerBackend(
  options: NativeSchedulerBackendOptions,
): SchedulerBackend {
  return new NativeSchedulerBackend(options);
}
