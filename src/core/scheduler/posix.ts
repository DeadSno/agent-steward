import { spawn } from "node:child_process";
import type { ScheduledTaskInfo } from "../../types.js";
import { TaskRegistry, type RegistryEntry } from "./registry.js";
import type {
  CreateTaskOptions,
  RunTaskResult,
  SchedulerBackend,
} from "./types.js";

/**
 * Общая база для LinuxScheduler и MacScheduler.
 *
 * Инкапсулирует всё, что одинаково на POSIX: реестр задач, немедленный запуск
 * bash-обёртки detached-процессом, список задач и удаление.
 * Различия (crontab vs launchd) реализуют наследники через installEntry,
 * uninstallEntry и applyPause.
 */
export abstract class PosixSchedulerBase implements SchedulerBackend {
  abstract readonly platform: NodeJS.Platform;
  abstract readonly title: string;

  protected readonly registry: TaskRegistry;

  constructor(backendId: string, profile?: string) {
    this.registry = new TaskRegistry(backendId, profile);
  }

  /** Регистрирует запись в планировщике ОС (crontab-строка или plist). */
  protected abstract installEntry(entry: RegistryEntry): Promise<void>;
  /** Убирает запись из планировщика ОС. */
  protected abstract uninstallEntry(entry: RegistryEntry): Promise<void>;
  /** Применяет состояние паузы к записи в планировщике ОС. */
  protected abstract applyPause(entry: RegistryEntry, paused: boolean): Promise<void>;

  async createTask(options: CreateTaskOptions): Promise<void> {
    const entry: RegistryEntry = {
      name: options.name,
      schedule: options.schedule,
      command: options.command,
      logFile: options.logFile,
      workingDirectory: options.workingDirectory,
      triggerType: options.triggerType ?? "cron",
      ...(options.runAt ? { runAt: options.runAt } : {}),
      paused: false,
      createdAt: new Date().toISOString(),
      ...(options.model ? { model: options.model } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.timezone ? { timezone: options.timezone } : {}),
    };

    // P2-17: запись нужна в реестре ДО installEntry — Linux пересобирает crontab
    // из реестра. Но если установка упала, запись-призрак останется навсегда,
    // поэтому откатываем реестр к предыдущему состоянию.
    const previous = await this.registry.find(entry.name);
    await this.registry.upsert(entry);
    try {
      await this.installEntry(entry);
    } catch (err) {
      try {
        if (previous) await this.registry.upsert(previous);
        else await this.registry.remove(entry.name);
      } catch {
        // Не маскируем исходную ошибку установки ошибкой отката.
      }
      try {
        await this.uninstallEntry(entry);
      } catch {
        // Частичная установка могла не создать запись — это не ошибка отката.
      }
      throw err;
    }
    // installEntry может записать atJobId для Linux one-shot.
    await this.registry.upsert(entry);
  }

  async deleteTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    if (!entry) {
      // QW-9: нет записи — убираем возможную осиротевшую запись реестра.
      await this.registry.remove(name);
      return;
    }
    // QW-9: Linux пересобирает crontab из реестра, поэтому запись удаляется
    // ДО uninstall. Если uninstall упадёт, реестр откатывается — иначе строка
    // останется в crontab, а повторный delete уже не сможет её найти.
    await this.registry.remove(name);
    try {
      await this.uninstallEntry(entry);
    } catch (err) {
      try {
        await this.registry.upsert(entry);
      } catch {
        // Не маскируем исходную ошибку uninstall ошибкой отката.
      }
      throw err;
    }
  }

  async pauseTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);
    await this.registry.setPaused(name, true);
    await this.applyPause(entry, true);
  }

  async resumeTask(name: string): Promise<void> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);
    await this.registry.setPaused(name, false);
    await this.applyPause(entry, false);
  }

  async listTasks(): Promise<ScheduledTaskInfo[]> {
    const entries = await this.registry.load();
    return entries.map((entry) => ({
      taskName: entry.name,
      status: entry.paused ? "Disabled" : "Ready",
      paused: entry.paused,
    }));
  }

  /**
   * Запускает обёртку напрямую, минуя планировщик ОС. Это одинаково работает
   * и для cron-, и для файловых задач. Сама обёртка отвечает за lock-файл,
   * таймаут и запись истории.
   */
  async runTask(name: string): Promise<RunTaskResult> {
    const entry = await this.registry.find(name);
    if (!entry) throw new Error(`Задача "${name}" не найдена.`);

    const child = spawn("/bin/bash", [entry.command], {
      detached: true,
      stdio: "ignore",
      cwd: entry.workingDirectory || process.cwd(),
      windowsHide: true,
    });

    // spawn не бросает синхронно: ошибки (например, удалённый
    // workingDirectory → ENOENT) приходят событием 'error'. Без слушателя
    // это uncaught exception в plugin-host. Ждём 'spawn' либо 'error'.
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (error) => resolve(error));
    });
    if (spawnError) {
      throw new Error(
        `Не удалось запустить задачу "${name}": ${spawnError.message}`,
      );
    }
    child.unref();

    return { alreadyRunning: false };
  }
}

/**
 * Экранирует строку для безопасной вставки в POSIX shell
 * (одинарные кавычки: ' -> '\'').
 */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}
