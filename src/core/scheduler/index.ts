import { WindowsScheduler } from "./windows.js";
import { LinuxScheduler } from "./linux.js";
import { MacScheduler } from "./mac.js";
import type { SchedulerBackend } from "./types.js";

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

/**
 * Фабрика бэкендов планировщика по платформе.
 *
 *  - win32  → WindowsScheduler (schtasks);
 *  - darwin → MacScheduler (launchd);
 *  - linux (и прочие POSIX) → LinuxScheduler (crontab).
 */
export function createSchedulerBackend(
  platform: NodeJS.Platform = process.platform,
  profile?: string
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
  platform: NodeJS.Platform = process.platform
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
  platform: NodeJS.Platform = process.platform
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

/** Возвращает общий (закэшированный) бэкенд текущей платформы. */
export function getSchedulerBackend(): SchedulerBackend {
  if (!cached) cached = createSchedulerBackend();
  return cached;
}

/** Название планировщика для текущей платформы (для GUI/логов). */
export function getSchedulerTitle(platform: NodeJS.Platform = process.platform): string {
  return createSchedulerBackend(platform).title;
}
