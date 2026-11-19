import fs from "node:fs/promises";
import path from "node:path";
import { getProfileDir, getProfileName } from "../../profiles.js";
import { LockManager, withLockWait } from "../lock.js";
import type { TriggerType } from "./types.js";

/**
 * Запись реестра задач POSIX-бэкендов.
 *
 * crontab и launchd не хранят исходный cron-текст в удобном виде, а для
 * файловых триггеров вообще не создают расписание. Поэтому источником правды
 * для Linux/macOS служит собственный JSON-реестр плагина.
 */
export interface RegistryEntry {
  name: string;
  schedule: string;
  command: string;
  logFile?: string;
  workingDirectory?: string;
  triggerType: TriggerType;
  /** Абсолютное время однократного запуска (ISO-8601, только для once). */
  runAt?: string;
  /** Идентификатор задания `at` на Linux (для отмены one-shot). */
  atJobId?: string;
  paused: boolean;
  createdAt: string;
  /** LLM-модель задачи (опционально). */
  model?: string;
  /** Приоритет задачи 0..10 (опционально). */
  priority?: number;
  /** IANA-таймзона задачи (опционально, undefined — системная). */
  timezone?: string;
}

/** Реестр задач конкретного бэкенда: <pluginDir>/scheduler-<backend>.json. */
export class TaskRegistry {
  private readonly file: string;
  private readonly dir: string;
  private readonly backendId: string;
  private readonly lock: LockManager;

  constructor(backendId: string, profile: string = getProfileName()) {
    this.backendId = backendId;
    this.dir = getProfileDir(profile);
    this.file = path.join(this.dir, `scheduler-${backendId}.json`);
    // P2-16: мутации реестра — read-modify-write. Лок сериализует их между
    // процессами (хост OpenCode, CLI, detached record-history).
    this.lock = new LockManager(path.join(this.dir, "locks"));
  }

  /** Путь к файлу реестра (для диагностики). */
  get path(): string {
    return this.file;
  }

  /** Маркер того, что реестр был повреждён и перемещён в карантин. */
  private get blockedPath(): string {
    return `${this.file}.blocked`;
  }

  async load(): Promise<RegistryEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
        // Карантин уже переместил файл. Пустой реестр нельзя выдавать за
        // «задач нет»: rebuildCrontab вычистил бы все cron-строки плагина.
        const blocked = await fs.readFile(this.blockedPath, "utf8").catch(() => null);
        if (blocked) {
          throw new Error(
            `Реестр задач повреждён (карантин: ${blocked.trim()}). ` +
              `Восстановите ${this.file} вручную или удалите маркер ${this.blockedPath}.`,
          );
        }
        return [];
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return this.quarantineCorrupt(err);
    }
    if (!Array.isArray(parsed)) {
      return this.quarantineCorrupt(new Error("expected an array of registry entries"));
    }
    return parsed.filter(
      (entry): entry is RegistryEntry =>
        entry && typeof entry.name === "string" && typeof entry.command === "string",
    );
  }

  /** Перемещает повреждённый файл в карантин и блокирует дальнейшие записи. */
  private async quarantineCorrupt(err: unknown): Promise<never> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${this.file}.corrupt-${stamp}`;
    let moved = "";
    try {
      await fs.rename(this.file, target);
      await fs.writeFile(this.blockedPath, target, "utf8");
      moved = ` Файл перемещён в ${target}.`;
      console.warn(
        `[scheduler] Реестр ${path.basename(this.file)} повреждён и перемещён в ${target}. ` +
          `Запись заблокирована маркером ${this.blockedPath}.`,
        err,
      );
    } catch (renameErr) {
      console.error(
        `[scheduler] Не удалось переместить повреждённый реестр ${this.file} в ${target}.`,
        renameErr,
      );
    }
    throw new Error(
      `Реестр задач повреждён.${moved} Восстановите ${this.file} вручную или удалите маркер ${this.blockedPath}.`,
    );
  }

  async save(entries: RegistryEntry[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
    await fs.rename(tmp, this.file);
    await fs.rm(this.blockedPath, { force: true }).catch(() => {
      /* маркера могло не быть */
    });
  }

  /**
   * Read-modify-write под межпроцессной блокировкой: два процесса на одном
   * профиле не должны терять чужие записи (P2-16).
   */
  private async mutate<T>(fn: (entries: RegistryEntry[]) => T | Promise<T>): Promise<T> {
    await this.lock.initialize();
    return withLockWait(
      this.lock,
      `registry-${this.backendId}`,
      async () => {
        const entries = await this.load();
        const result = await fn(entries);
        await this.save(entries);
        return result;
      },
      { timeoutMs: 15000, staleMs: 60000 },
    );
  }

  async find(name: string): Promise<RegistryEntry | undefined> {
    const entries = await this.load();
    return entries.find((e) => e.name.toLowerCase() === name.toLowerCase());
  }

  async upsert(entry: RegistryEntry): Promise<void> {
    await this.mutate((entries) => {
      const index = entries.findIndex(
        (e) => e.name.toLowerCase() === entry.name.toLowerCase(),
      );
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
    });
  }

  async remove(name: string): Promise<void> {
    await this.mutate((entries) => {
      const index = entries.findIndex(
        (e) => e.name.toLowerCase() === name.toLowerCase(),
      );
      if (index !== -1) entries.splice(index, 1);
    });
  }

  async setPaused(name: string, paused: boolean): Promise<void> {
    await this.mutate((entries) => {
      const entry = entries.find(
        (e) => e.name.toLowerCase() === name.toLowerCase(),
      );
      if (entry) entry.paused = paused;
    });
  }
}
