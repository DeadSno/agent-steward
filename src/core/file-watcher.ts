import { watch, type FSWatcher } from "chokidar";
import { isAbsolute } from "node:path";
import { loadTaskDefinitions } from "../task-transfer.js";
import { filterPaths, relativeTo } from "./glob.js";
import { hasPathControlChars } from "./watch-paths.js";

/**
 * Задержка между последним изменением файла и запуском задачи.
 * Нужна потому, что редакторы часто пишут файл несколькими порциями
 * (truncate + write + rename) — без дебаунса задача стартовала бы 3-5 раз.
 */
export const FILE_TRIGGER_DEBOUNCE_MS = 2000;

/**
 * PL-130: окно по умолчанию, в котором изменения наблюдаемого файла игнорируются
 * после запуска задачи. Запущенный агент сам редактирует файл (например, ROADMAP.md),
 * и без подавления эти правки порождают каскад самоповторов (11 лишних запусков
 * в зонде DS313-FILE-PROBE). PL-143: окно настраивается через env (0 — выключить
 * подавление), каждый фактический пропуск логируется.
 */
export const FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS = 15000;

/** PL-143: переменная окружения с окном подавления self-write в миллисекундах. */
export const FILE_SELF_WRITE_SUPPRESS_ENV = "AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS";

/** PL-143: результат разбора окна подавления из строки окружения. */
export interface FileSelfWriteSuppressParseResult {
  /** Эффективное окно в миллисекундах. */
  value: number;
  /** Предупреждение о невалидном значении (null — значение корректно). */
  warning: string | null;
}

/**
 * PL-143: чистая функция разбора окна подавления. Принимает неотрицательное целое
 * число мс; пустая строка, дроби, отрицательные и слишком большие значения дают
 * `fallbackMs` вместе с предупреждением. Никаких сайд-эффектов — легко тестировать.
 */
export function parseFileSelfWriteSuppressMs(
  raw: string | undefined,
  fallbackMs: number = FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,
): FileSelfWriteSuppressParseResult {
  if (raw === undefined) return { value: fallbackMs, warning: null };

  const trimmed = raw.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    return {
      value: fallbackMs,
      warning:
        `[PL-143] Некорректное значение ${FILE_SELF_WRITE_SUPPRESS_ENV}="${raw}": ` +
        `ожидалось неотрицательное целое число мс. Используется ${fallbackMs} мс.`,
    };
  }
  return { value: parsed, warning: null };
}

/**
 * PL-143: читает env и возвращает эффективное окно подавления, предупреждая
 * в консоли о невалидном значении. Вызывается один раз при создании менеджера.
 */
export function resolveFileSelfWriteSuppressMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { value, warning } = parseFileSelfWriteSuppressMs(env[FILE_SELF_WRITE_SUPPRESS_ENV]);
  if (warning) console.warn(warning);
  return value;
}

export type FileTriggerHandler = (
  taskName: string,
  changedPath: string
) => void | Promise<void>;

interface WatchedTask {
  /** Имя задачи так, как оно записано в tasks.json. */
  name: string;
  /** Нормализованный путь, который отслеживаем. */
  path: string;
  /** Спринт 27: glob-маски и ignore-список (пусто — любое изменение). */
  globs: string[];
  ignore: string[];
  watcher: FSWatcher;
  /** Таймер дебаунса (одна задача = один отложенный запуск). */
  timer: NodeJS.Timeout | null;
}

/**
 * Менеджер файловых триггеров: держит по одному chokidar- watcher'у на задачу
 * с triggerType === "file" и пересобирает их при изменении tasks.json.
 */
export class FileWatchManager {
  private entries = new Map<string, WatchedTask>();
  private stopped = false;
  /** PL-130: задача → момент, до которого её собственные записи игнорируются. */
  private suppressUntil = new Map<string, number>();

  constructor(
    private readonly handler: FileTriggerHandler,
    private readonly debounceMs: number = FILE_TRIGGER_DEBOUNCE_MS,
    /** PL-143: эффективное окно подавления, прочитанное из env (или по умолчанию). */
    private readonly suppressMs: number = resolveFileSelfWriteSuppressMs(),
  ) {}

  /** Сколько задач сейчас отслеживается. */
  get size(): number {
    return this.entries.size;
  }

  /** PL-143: действующее окно подавления self-write в миллисекундах. */
  get selfWriteSuppressMs(): number {
    return this.suppressMs;
  }

  /**
   * PL-130: помечает задачу как «ожидает собственной записи» на `ms` мс.
   * Изменения watchPath в это окно не запускают задачу и не сбрасывают таймер
   * дебаунса — иначе агент, отредактировав наблюдаемый файл, перезапускает сам
   * себя. Ключ — имя задачи в нижнем регистре, как и в `entries`.
   */
  suppressForTask(taskName: string, ms: number = this.suppressMs): void {
    if (!taskName) return;
    this.suppressUntil.set(taskName.toLowerCase(), Date.now() + Math.max(0, ms));
  }

  /**
   * Перечитывает tasks.json и приводит набор watcher'ов в соответствие:
   * новые задачи добавляются, удалённые/изменённые — закрываются.
   * Возвращает количество активных файловых триггеров.
   */
  async refresh(): Promise<number> {
    if (this.stopped) return 0;

    const definitions = await loadTaskDefinitions();
    const wanted = definitions
      .filter(
        (d) =>
          d.triggerType === "file" &&
          typeof d.watchPath === "string" &&
          d.watchPath.trim().length > 0,
      )
      .map((d) => ({
        name: d.name.trim(),
        path: d.watchPath!.trim(),
        globs: Array.isArray(d.watchGlobs)
          ? d.watchGlobs.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
          : [],
        ignore: Array.isArray(d.watchIgnore)
          ? d.watchIgnore.filter((g): g is string => typeof g === "string" && g.trim().length > 0)
          : [],
      }))
      .filter((d) => d.name.length > 0)
      .filter((d) => {
        // Защита от legacy-записей и ручного редактирования БД: не запускаем
        // watcher на путях с управляющими символами или выходом через `..`.
        if (hasPathControlChars(d.path)) {
          console.error(
            `[agent-steward] Задача "${d.name}": путь наблюдения содержит управляющие символы — пропущен.`,
          );
          return false;
        }
        if (!isAbsolute(d.path) && d.path.split(/[\\/]/).includes("..")) {
          console.error(
            `[agent-steward] Задача "${d.name}": относительный путь наблюдения выходит за рабочую директорию — пропущен.`,
          );
          return false;
        }
        return true;
      });

    const wantedKeys = new Set(wanted.map((d) => d.name.toLowerCase()));

    // Убираем watcher'ы для задач, которых больше нет или у которых сменился
    // путь/маски (Спринт 27).
    for (const [key, entry] of Array.from(this.entries.entries())) {
      const target = wanted.find((d) => d.name.toLowerCase() === key);
      if (
        target?.path !== entry.path ||
        target?.globs.join("\u0000") !== entry.globs.join("\u0000") ||
        target?.ignore.join("\u0000") !== entry.ignore.join("\u0000")
      ) {
        await this.remove(key);
      }
    }

    // Добавляем новые.
    for (const item of wanted) {
      const key = item.name.toLowerCase();
      if (this.entries.has(key) || !wantedKeys.has(key)) continue;
      this.add(item.name, item.path, item.globs, item.ignore);
    }

    return this.entries.size;
  }

  /** Закрывает все watcher'ы (вызывается при выгрузке плагина). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const key of Array.from(this.entries.keys())) {
      await this.remove(key);
    }
  }

  private add(
    name: string,
    watchPath: string,
    globs: string[] = [],
    ignore: string[] = [],
  ): void {
    // Спринт 27: маски с "**" требуют рекурсивного обхода директории.
    const needsRecursive = globs.some((g) => g.includes("**"));
    let watcher: FSWatcher;
    try {
      watcher = watch(watchPath, {
        // Не считаем уже существующий файл «изменением» при старте.
        ignoreInitial: true,
        // Следим за одним файлом/папкой, без рекурсии в глубину, если маски
        // этого не требуют.
        depth: needsRecursive ? undefined : 0,
        // Файлы могут быть большими: дождёмся, пока запись успокоится.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignorePermissionErrors: true,
      });
    } catch (err: unknown) {
      console.error(
        `[agent-steward] Не удалось начать отслеживание "${watchPath}" для задачи "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const entry: WatchedTask = {
      name,
      path: watchPath,
      globs,
      ignore,
      watcher,
      timer: null,
    };

    /** Спринт 27: маски применяются к пути относительно watchPath. */
    const accepts = (changedPath: string): boolean => {
      if (globs.length === 0 && ignore.length === 0) return true;
      if (globs.length === 0) {
        const rel = relativeTo(watchPath, changedPath) ?? changedPath;
        return filterPaths([rel], undefined, ignore).length > 0;
      }
      const rel = relativeTo(watchPath, changedPath);
      const candidates = rel ? [rel, changedPath] : [changedPath];
      return candidates.some(
        (candidate) => filterPaths([candidate], globs, ignore).length > 0,
      );
    };

    const onChange = (changedPath: string) => {
      if (this.stopped) return;
      // PL-130: пока задача активна, её собственные правки наблюдаемого файла
      // не запускают новый прогон и не перезапускают дебаунс-таймер.
      const until = this.suppressUntil.get(name.toLowerCase());
      if (until !== undefined && Date.now() < until) {
        // PL-143: пропуск больше не молчаливый — видно, какая задача и какой
        // путь были проигнорированы и до какого момента действует окно.
        console.log(
          `[PL-143] Подавляю self-write задачи "${name}": изменение "${changedPath}" ` +
            `проигнорировано (окно подавления до ${new Date(until).toISOString()}).`,
        );
        return;
      }
      if (!accepts(changedPath)) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (this.stopped) return;
        try {
          const result = this.handler(name, changedPath);
          if (result && typeof result === "object" && typeof result.catch === "function") {
            result.catch((err: unknown) => {
              console.error(
                `[agent-steward] Ошибка запуска задачи "${name}" по изменению файла: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
        } catch (err: unknown) {
          console.error(
            `[agent-steward] Ошибка запуска задачи "${name}" по изменению файла: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }, this.debounceMs);
      // Таймер не должен удерживать процесс, если хост завершается.
      if (typeof entry.timer.unref === "function") entry.timer.unref();
    };

    // Спринт 27: переименование/удаление файла тоже считается изменением —
    // иначе mac/win-редакторы, пишущие через rename, «пропадали» бы.
    watcher.on("change", onChange);
    watcher.on("add", onChange);
    watcher.on("unlink", onChange);

    watcher.on("error", (err) => {
      console.error(
        `[agent-steward] Ошибка наблюдения за "${watchPath}" (задача "${name}"): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    this.entries.set(name.toLowerCase(), entry);
    console.log(
      `[agent-steward] Слежу за "${watchPath}" — задача "${name}" запускается при изменении файла.`,
    );
  }

  private async remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await entry.watcher.close();
    } catch {
      // watcher уже мог быть закрыт — не критично.
    }
  }
}
