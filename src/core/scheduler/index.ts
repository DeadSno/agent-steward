import { WindowsScheduler } from "./windows.js";
import { LinuxScheduler } from "./linux.js";
import { MacScheduler } from "./mac.js";
import type { SchedulerBackend } from "./types.js";
import {
  assertNativeSchedulerHost,
  detectNativeSchedulerHost,
  NativeSchedulerUnavailableError,
  resolveSchedulerMode,
  type NativeSchedulerHostInfo,
  type NativeSchedulerSettings,
  type SchedulerMode,
} from "../native-scheduler.js";

export type {
  SchedulerBackend,
  CreateTaskOptions,
  RunTaskResult,
  TriggerType,
} from "./types.js";
export { WindowsScheduler, SchtasksError, WINDOWS_TASK_PREFIX } from "./windows.js";
export { LinuxScheduler } from "./linux.js";
export { MacScheduler } from "./mac.js";
export { TaskRegistry } from "./registry.js";
export type { RegistryEntry } from "./registry.js";
export {
  NativeSchedulerBackend,
  createNativeSchedulerBackend,
  type NativeRegistryLike,
  type NativeSchedulerBackendOptions,
} from "./native.js";
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
} from "../native-scheduler.js";

/**
 * Фабрика бэкендов планировщика по платформе.
 *
 *  - win32  → WindowsScheduler (schtasks);
 *  - darwin → MacScheduler (launchd);
 *  - linux (и прочие POSIX) → LinuxScheduler (crontab).
 */
export function createSchedulerBackend(
  platform: NodeJS.Platform = process.platform,
  profile?: string,
): SchedulerBackend {
  if (platform === "win32") return new WindowsScheduler(profile);
  if (platform === "darwin") return new MacScheduler(profile);
  return new LinuxScheduler(profile);
}

/**
 * Бэкенд планировщика в пространстве имён конкретного профиля — в том числе
 * неактивного. Нужен, чтобы удаление профиля снимало ЕГО задачи, а не задачи
 * активного профиля (T-05).
 */
export function createSchedulerBackendForProfile(
  profile: string,
  platform: NodeJS.Platform = process.platform,
): SchedulerBackend {
  return createSchedulerBackend(platform, profile);
}

/**
 * Снимает все задачи профиля из планировщика ОС перед удалением его файлов.
 * Ошибки по отдельным задачам игнорируются; бросает только если сам список
 * задач получить не удалось.
 */
export async function removeScheduledTasksForProfile(
  profile: string,
  platform: NodeJS.Platform = process.platform,
): Promise<number> {
  const scheduler = createSchedulerBackendForProfile(profile, platform);
  const tasks = await scheduler.listTasks();
  let removed = 0;
  for (const task of tasks) {
    const name = task.taskName ?? "";
    if (!name) continue;
    try {
      await scheduler.deleteTask(name);
      removed++;
    } catch {
      // Задача уже удалена или недоступна — продолжаем чистить остальные.
    }
  }
  return removed;
}

let cached: SchedulerBackend | null = null;
let configuredMode: SchedulerMode | null = null;
let configuredHost: NativeSchedulerHostInfo | null = null;
let nativeFactory: ((host: NativeSchedulerHostInfo) => SchedulerBackend) | null = null;

/**
 * AD-1.1: выбирает режим из настроек и capability хоста.
 * `auto` без объявленной capability остаётся на polling (fail-open в сторону
 * проверенного пути). Вызов сбрасывает кэш бэкенда.
 */
export function configureSchedulerMode(
  settings: NativeSchedulerSettings | undefined = undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SchedulerMode {
  configuredMode = resolveSchedulerMode(settings, env, platform);
  configuredHost = detectNativeSchedulerHost(env, platform);
  cached = null;
  return configuredMode;
}

/**
 * Регистрирует фабрику нативного бэкенда. Рантайм передаёт сюда реестр и
 * колбэк запуска, ведущий в существующий execution loop.
 */
export function registerNativeSchedulerFactory(
  factory: (host: NativeSchedulerHostInfo) => SchedulerBackend,
): void {
  nativeFactory = factory;
  cached = null;
}

/** Текущий режим планировщика (для диагностики и внешнего контракта). */
export function getSchedulerMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SchedulerMode {
  return configuredMode ?? resolveSchedulerMode(undefined, env, platform);
}

/** Возвращает общий (закэшированный) бэкенд выбранного режима. */
export function getSchedulerBackend(): SchedulerBackend {
  if (!cached) {
    const mode = getSchedulerMode();
    if (mode === "native") {
      const host = assertNativeSchedulerHost(configuredHost ?? detectNativeSchedulerHost(), mode);
      if (!nativeFactory) {
        throw new NativeSchedulerUnavailableError(
          "Native-режим выбран, но фабрика бэкенда не зарегистрирована рантаймом",
        );
      }
      cached = nativeFactory(host);
    } else {
      cached = createSchedulerBackend();
    }
  }
  return cached;
}

/** Название планировщика для текущей платформы/режима (для GUI/логов). */
export function getSchedulerTitle(platform: NodeJS.Platform = process.platform): string {
  const mode = getSchedulerMode(undefined, platform);
  if (mode === "native") return "native-scheduler";
  return createSchedulerBackend(platform).title;
}
