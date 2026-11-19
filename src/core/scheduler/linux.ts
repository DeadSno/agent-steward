import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildAtTimestamp } from "../one-shot.js";
import {
  cancelAtFallback,
  isAtMissingError,
  isPidJobId,
  pruneStaleFallbackEntries,
  scheduleAtFallback,
  type PruneAtFallbackReport,
} from "./at-fallback.js";
import { needsPosixPollMode } from "../schedule-v2.js";
import { LockManager, withLockWait } from "../lock.js";
import { getBasePluginDir, getProfileName } from "../../profiles.js";
import { taskFolderNameForProfile, legacyTaskFolderNameForProfile } from "../../types.js";
import { PosixSchedulerBase, shellQuote } from "./posix.js";
import type { RegistryEntry } from "./registry.js";

const execFileAsync = promisify(execFile);

/**
 * Бэкенд планировщика Linux на основе пользовательского crontab.
 *
 * Все задачи плагина живут в одном управляемом блоке:
 *   # >>> opencode-scheduler >>>
 *   # task: <имя>
 *   <cron> /bin/bash '<обёртка>' >> '<лог>' 2>&1
 *   # <<< opencode-scheduler <<<
 * При паузе строка задачи комментируется ("# PAUSED: ..."), при удалении —
 * блок перегенерируется из реестра.
 */
export class LinuxScheduler extends PosixSchedulerBase {
  readonly platform: NodeJS.Platform = "linux";
  readonly title = "agent-steward by DeadSno";

  private readonly blockBegin: string;
  private readonly blockEnd: string;
  private readonly legacyBlockBegin: string;
  private readonly legacyBlockEnd: string;
  private readonly ownsLegacyBlock: boolean;

  constructor(profile: string = getProfileName()) {
    super("linux", profile);
    const folderName = taskFolderNameForProfile(profile);
    const legacyFolderName = legacyTaskFolderNameForProfile(profile);
    this.blockBegin = `# >>> opencode-scheduler:${folderName} >>>`;
    this.blockEnd = `# <<< opencode-scheduler:${folderName} <<<`;
    this.legacyBlockBegin = `# >>> opencode-scheduler:${legacyFolderName} >>>`;
    this.legacyBlockEnd = `# <<< opencode-scheduler:${legacyFolderName} <<<`;
    // Древний бессуффиксный блок принадлежит только профилю default.
    this.ownsLegacyBlock = profile === "default";
  }

  private cronLine(entry: RegistryEntry): string {
    if (entry.triggerType !== "cron") {
      // Файловый/MCP-триггер не имеет расписания — держим задачу только в реестре.
      return "";
    }
    const log = entry.logFile ? ` >> ${shellQuote(entry.logFile)} 2>&1` : "";
    const cmd = `/bin/bash ${shellQuote(entry.command)}${log}`;
    // Vixie-совместимый 5-полевой cron crontab выполняет сам: списки,
    // диапазоны, шаги и имена месяцев/дней недели писать как есть можно.
    // Quartz-расширения (L, d#n) и @-макросы (не 5 полей) crontab не понимает —
    // для них "* * * * *" + gate во враппере. Чужая IANA-таймзона тоже уходит
    // в poll: иначе crontab сработает по системному времени задачи.
    const schedule = needsPosixPollMode(entry.schedule, entry.timezone)
      ? "* * * * *"
      : entry.schedule;
    return `${schedule} ${cmd}`;
  }

  private renderBlock(entries: RegistryEntry[]): string {
    const lines: string[] = [this.blockBegin];
    for (const entry of entries) {
      const line = this.cronLine(entry);
      if (!line) continue;
      lines.push(`# task: ${entry.name}`);
      lines.push(entry.paused ? `# PAUSED: ${line}` : line);
    }
    lines.push(this.blockEnd);
    return lines.join("\n");
  }

  /** Читает текущий crontab (пустая строка, если crontab ещё не создан). */
  private async readCrontab(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("crontab", ["-l"], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (err: unknown) {
      const stderrRaw = (err as { stderr?: unknown } | undefined)?.stderr;
      const stderr = typeof stderrRaw === "string" ? stderrRaw : String(stderrRaw ?? "");
      // "no crontab for user" — это нормальное состояние. Любую другую ошибку
      // (нет доступа, сбой crontab) нельзя превращать в пустой crontab: иначе
      // последующая запись затрёт пользовательские задания.
      if (/no crontab/i.test(stderr) || /no crontab/i.test(String((err as Error | undefined)?.message ?? ""))) {
        return "";
      }
      throw new Error(`Не удалось прочитать crontab: ${stderr.trim() || (err as Error | undefined)?.message || String(err)}`);
    }
  }

  /**
   * Убирает управляемый блок плагина из текста crontab.
   *
   * B9: удаляются только строки между парными маркерами. Незакрытый блок
   * (маркер начала без конца) — fail-closed: бросаем ошибку, чтобы вызывающий
   * не записал crontab и пользовательские задания после маркера не пропали.
   * Строки вне маркеров сохраняются байт-в-байт, включая пустые.
   */
  private stripBlock(content: string): string {
    // Совместимость: до появления профилей блок назывался без суффикса.
    // Он принадлежит профилю default; другие профили его не трогают.
    const legacyBegin = "# >>> opencode-scheduler >>>";
    const legacyEnd = "# <<< opencode-scheduler <<<";
    const ownsLegacy = this.ownsLegacyBlock;
    const isBegin = (line: string) =>
      line === this.blockBegin ||
      line === this.legacyBlockBegin ||
      (ownsLegacy && line === legacyBegin);
    const isEnd = (line: string) =>
      line === this.blockEnd ||
      line === this.legacyBlockEnd ||
      (ownsLegacy && line === legacyEnd);
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    let inside = false;
    let openAt = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const trimmed = line.trim();
      if (isBegin(trimmed)) {
        if (inside) {
          throw new Error(
            `crontab: вложенный маркер начала блока на строке ${index + 1} ` +
              `(предыдущий блок открыт на строке ${openAt}). Файл не изменён.`,
          );
        }
        inside = true;
        openAt = index + 1;
        continue;
      }
      if (inside && isEnd(trimmed)) {
        inside = false;
        continue;
      }
      // Строки внутри блока удаляются; всё остальное (включая «сиротский»
      // маркер конца) остаётся без изменений.
      if (!inside) result.push(line);
    }
    if (inside) {
      throw new Error(
        `crontab: незакрытый блок плагина с строки ${openAt} — ` +
          "маркер конца не найден. Файл не изменён.",
      );
    }
    return result.join("\n");
  }

  /** Записывает crontab через stdin: `crontab -`. */
  private async writeCrontab(content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("crontab", ["-"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`crontab - завершился с кодом ${code}: ${stderr.trim()}`));
      });
      child.stdin.end(content.endsWith("\n") ? content : `${content}\n`);
    });
  }

  /** Перегенерирует блок плагина из реестра. */
  private async rebuildCrontab(): Promise<void> {
    // T-17: crontab общий для всех профилей пользователя, а read-modify-write
    // не атомарен — параллельные операции разных профилей могли затирать блоки
    // друг друга. Кросс-процессный замок живёт в базовой директории плагина
    // (общей для всех профилей) и ждёт освобождения вместо пропуска.
    const crontabLock = new LockManager(
      path.join(getBasePluginDir(), "locks"),
    );
    await withLockWait(
      crontabLock,
      "crontab",
      async () => {
        const entries = await this.registry.load();
        const current = await this.readCrontab();
        // B9: stripBlock сохраняет содержимое вне маркеров. Отрезаем только
        // хвостовые переводы строк, чтобы повторные rebuild не копили пустые
        // строки; одна финальная добавляется ниже.
        const base = this.stripBlock(current).replace(/\n+$/, "");
        const block = this.renderBlock(entries);

        // Пустой блок (нет задач) не пишем, чтобы не оставлять мусор в crontab.
        const hasTasks = block
          .split("\n")
          .some((line) => line.trim().startsWith("# task:"));
        const next = [base, hasTasks ? block : ""].filter(Boolean).join("\n");
        await this.writeCrontab(next ? `${next}\n` : "");
      },
      { timeoutMs: 15000, staleMs: 60000 },
    );
  }

  /** Строка команды one-shot для stdin `at`.
   *  P1-7.T1.3: без `-c` bash трактует аргумент как ИМЯ ФАЙЛА скрипта
   *  (exit 127 «No such file or directory»), поэтому at «выполнял» задание,
   *  но команда на самом деле не запускалась. */
  private atCommand(entry: RegistryEntry): string {
    const log = entry.logFile ? ` >> ${shellQuote(entry.logFile)} 2>&1` : "";
    return `/bin/bash -c ${shellQuote(entry.command)}${log}`;
  }

  /**
   * Ставит one-shot в `at` и возвращает id задания.
   * `at -t` принимает локальное время системы в формате YYYYMMDDHHMM.
   */
  private async scheduleAt(entry: RegistryEntry): Promise<string> {
    if (!entry.runAt) {
      throw new Error(`Задача "${entry.name}": не задано runAt для one-shot.`);
    }
    const timestamp = buildAtTimestamp(entry.runAt);
    return new Promise<string>((resolve, reject) => {
      const child = spawn("at", ["-t", timestamp], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        // P1-7.T1.2: `at` может отсутствовать (минимальные образы, Alpine и
        // т.п.). Не роняем задачу — планируем отвязанный bash-процесс.
        if (isAtMissingError(err)) {
          void scheduleAtFallback(entry, this.atCommand(entry))
            .then((jobId) => {
              console.warn(
                `[agent-steward] at не найден — задача "${entry.name}" запланирована через fallback (${jobId}). ` +
                  "Fallback не переживает перезагрузку; установите пакет at.",
              );
              resolve(jobId);
            })
            .catch((fallbackErr) => {
              reject(
                new Error(
                  `Не удалось вызвать at и fallback-планировщик: ${
                    fallbackErr instanceof Error
                      ? fallbackErr.message
                      : String(fallbackErr)
                  }`,
                ),
              );
            });
          return;
        }
        reject(
          new Error(
            `Не удалось вызвать at (установите пакет at): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `at завершился с кодом ${code}: ${stderr.trim() || stdout.trim()}`,
            ),
          );
          return;
        }
        // GNU at пишет «job N at …» в stderr, а не в stdout — ищем в обоих потоках.
        const match = /job\s+(\d+)/i.exec(stdout + "\n" + stderr);
        if (!match) {
          reject(new Error(`at не вернул id задания: ${stdout.trim()}`));
          return;
        }
        resolve(match[1]);
      });
      child.stdin.end(`${this.atCommand(entry)}\n`);
    });
  }

  /** Отменяет задание at, если оно ещё существует. */
  private async cancelAt(entry: RegistryEntry): Promise<void> {
    if (!entry.atJobId) return;
    if (isPidJobId(entry.atJobId)) {
      // P1-7.T1.2: снимаем fallback-процесс, а не at-задание.
      // P1-14: передаём имя — без сверки маркера pid мог быть переиспользован.
      cancelAtFallback(entry.atJobId, entry.name);
      delete entry.atJobId;
      return;
    }
    try {
      await execFileAsync("atrm", [entry.atJobId]);
    } catch {
      // Задание уже выполнилось или было удалено — это не ошибка.
    }
    delete entry.atJobId;
  }

  /**
   * P1-14: чистит `pid:`-записи fallback'а, пережившие перезагрузку.
   * Вызывается из старта плагина; на других платформах не используется.
   */
  async pruneStaleFallbacks(): Promise<PruneAtFallbackReport> {
    return pruneStaleFallbackEntries(this.registry);
  }

  protected async installEntry(entry: RegistryEntry): Promise<void> {
    if (entry.triggerType === "once") {
      if (!entry.paused) {
        entry.atJobId = await this.scheduleAt(entry);
      }
      return;
    }
    await this.rebuildCrontab();
  }

  protected async uninstallEntry(entry: RegistryEntry): Promise<void> {
    if (entry.triggerType === "once") {
      await this.cancelAt(entry);
      return;
    }
    await this.rebuildCrontab();
  }

  protected async applyPause(entry: RegistryEntry, paused: boolean): Promise<void> {
    // P1-12: entry получен из find() ДО setPaused(), поэтому без этой строки
    // upsert ниже возвращал в реестр paused:false, и listTasks() показывал
    // приостановленную one-shot задачу как Ready.
    entry.paused = paused;
    if (entry.triggerType === "once") {
      if (paused) {
        await this.cancelAt(entry);
      } else if (entry.runAt && Date.parse(entry.runAt) > Date.now()) {
        entry.atJobId = await this.scheduleAt(entry);
      } else {
        console.warn(
          `[scheduler] Задача "${entry.name}" не будет перезапущена: время one-shot запуска уже прошло (${entry.runAt ?? "runAt не задан"}). Создайте новую задачу.`,
        );
      }
      await this.registry.upsert(entry);
      return;
    }
    await this.rebuildCrontab();
  }
}
