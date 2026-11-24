/**
/*.
 *
 * Реализация перенесена сюда из src/index.ts. Entrypoint (index.ts) остаётся
 * адаптером: он импортирует createRuntimeCore, передаёт ссылки на своё
 * состояние через RuntimeDeps и сохраняет dual-export V1/V2.
 */
import { loadSettings } from "./settings.js";
import { resolveLocale, setLocale } from "./i18n.js";
import { initDb } from "./db/index.js";
import { migrateJsonToDb } from "./db/migrate.js";
import { checkJsonBackups, recoverInterruptedRuns } from "./db/recovery.js";
import { verifyGateLedgerIntegrity } from "./core/audit.js";
import { flushOutbox } from "./core/feedback.js";
import { LinuxScheduler } from "./core/scheduler/index.js";
import type { SchedulerBackend } from "./core/scheduler/types.js";
import { maybeRunHistoryRetention } from "./core/retention.js";
import { LockManager } from "./core/lock.js";
import { LOCK_DIR } from "./types.js";
import { selectCatchUpTasks } from "./core/catch-up.js";
import { loadHistory } from "./history.js";
import { loadTaskDefinitions } from "./task-transfer.js";
import {
  FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS,
  FileWatchManager,
} from "./core/file-watcher.js";
import { GitTriggerManager } from "./core/git-trigger.js";

/** Минимальный контракт контекста, который нужен общему ядру. */
export interface RuntimeContextLike {
  location?: { directory?: string };
}

/** Возвращаемое значение ядра запуска (совпадает с SchedulerRuntime адаптера). */
export interface SchedulerRuntime {
  projectDirectory: string;
  /** Останавливает таймеры и наблюдателей; БД закрывает entrypoint после ожидания idle. */
  dispose: () => void;
}

/**
 * Всё, чем ядро запуска пользуется из адаптера index.ts.
 * Часть функций живёт в index.ts (execute-обработчики, реестры триггеров),
 * поэтому они передаются явно — импорт index.ts создал бы цикл и вернул
 * @opencode-зависимость в ядро.
 */
export interface RuntimeDeps {
  /** Тот же закэшированный бэкенд, что используют инструменты и RPC. */
  scheduler: SchedulerBackend;
  setProjectDirectory(directory: string): void;
  setFileWatcherManager(manager: FileWatchManager | null): void;
  getFileWatcherManager(): FileWatchManager | null;
  setGitTriggerManager(manager: GitTriggerManager | null): void;
  getGitTriggerManager(): GitTriggerManager | null;
  garbageCollectTaskArtifacts(): Promise<unknown>;
  resumeExpiredPauses(): Promise<unknown>;
  maybeSendDigest(now?: Date): Promise<unknown>;
  checkStuckMatrices(): Promise<unknown>;
  refreshTriggers(): Promise<unknown>;
  scheduleEventRun(taskName: string, reason: string): Promise<unknown>;
  runTaskEntry(name: string): Promise<unknown>;
}

const PAUSED_UNTIL_CHECK_MS = 5 * 60 * 1000;
const NOTIFICATION_CHECK_MS = 60 * 1000;

export async function createRuntimeCore(ctxLike: RuntimeContextLike, deps: RuntimeDeps): Promise<SchedulerRuntime> {
  // Папка проекта — рабочая директория задач по умолчанию. Благодаря ей
  // `opencode run` подхватывает opencode.json с MCP-серверами проекта.
  const projectDirectory = ctxLike.location?.directory || process.cwd();
  deps.setProjectDirectory(projectDirectory);

  // Спринт 28: язык интерфейса берём из настроек. Ошибка чтения не должна
  // мешать старту — в этом случае остаётся локаль по умолчанию (ru).
  try {
    const initialSettings = await loadSettings();
    setLocale(resolveLocale(initialSettings.locale, initialSettings.uiLocale));
  } catch {
    // Локаль по умолчанию уже активна.
  }

  // Спринт 12: SQLite — основное хранилище. Открываем БД, при первом запуске
  // автоматически переносим данные из JSON, затем восстанавливаем прерванные
  // запуски. Ошибки миграции не должны мешать плагину стартовать.
  initDb();
  try {
    await migrateJsonToDb();
  } catch (err) {
    console.error(
      `[migrate] Не удалось мигрировать JSON → SQLite: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    recoverInterruptedRuns();
  } catch (err) {
    console.error(
      `[recovery] Не удалось восстановить незавершённые запуски: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // PL-98: проверяем tamper-evident цепочку gate_outcomes при каждом старте.
  // Результат пишется в журнал аудита; ошибка не должна ломать старт плагина.
  try {
    verifyGateLedgerIntegrity("startup");
  } catch (err) {
    console.error(
      `[gate-ledger] Автопроверка цепочки не выполнена: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Деталь 3.8 (F-1.6): повторяем недоставленные отчёты из outbox.
  // Fire-and-forget: сеть не должна задерживать или ломать старт плагина.
  void loadSettings()
    .then((settings) => flushOutbox(settings.feedback))
    .then((result) => {
      if (result.sent > 0) {
        console.log(`[feedback] Из outbox доставлено отчётов: ${result.sent}`);
      }
    })
    .catch((err: unknown) => {
      console.error(
        `[feedback] Ошибка повтора outbox: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  // P1-14: pid:-записи fallback'а не переживают перезагрузку. Чистим их и
  // пересоздаём будущие one-shot, иначе после reboot можно убить чужой pid.
  if (deps.scheduler instanceof LinuxScheduler) {
    try {
      const report = await deps.scheduler.pruneStaleFallbacks();
      if (report.removed || report.rescheduled || report.missed) {
        console.log(
          `[scheduler] Fallback one-shot: удалено ${report.removed}, ` +
            `пересоздано ${report.rescheduled}, пропущено ${report.missed}, ` +
            `живо ${report.kept}.`,
        );
      }
    } catch (err) {
      console.error(
        `[scheduler] Не удалось очистить fallback-записи: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  checkJsonBackups();
  void deps.garbageCollectTaskArtifacts().catch((err) => {
    console.log(`[gc] Не удалось вычистить мусорные файлы: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Спринт 18: ежедневная очистка истории. Ошибка ретеншна не должна мешать
  // плагину стартовать — пишем в лог и продолжаем.
  void maybeRunHistoryRetention()
    .then((report) => {
      if (report && report.deleted > 0) {
        console.log(
          `[retention] Удалено ${report.deleted} записей истории ` +
            `(по возрасту: ${report.deletedByAge}, по лимиту: ${report.deletedByCount}); ` +
            `осталось ${report.kept}.`,
        );
      }
    })
    .catch((err) => {
      console.error(
        `[retention] Не удалось очистить историю: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

  // Спринт 19: автопродолжение задач, поставленных на паузу до даты.
  // Проверяем сразу при старте и далее раз в 5 минут, пока плагин жив.
  void deps.resumeExpiredPauses().catch((err) => {
    console.error(
      `[agent-steward] Не удалось проверить автопродолжение: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  const pausedUntilTimer = setInterval(() => {
    void deps.resumeExpiredPauses().catch((err) => {
      console.error(
        `[agent-steward] Не удалось проверить автопродолжение: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, PAUSED_UNTIL_CHECK_MS);
  pausedUntilTimer.unref?.();

  // Спринт 20: дайджест и детектор зависших матриц. Проверяем сразу при
  // старте и далее раз в минуту; таймер не держит процесс Node живым.
  const notificationTimer = setInterval(() => {
    void deps.maybeSendDigest().catch(() => undefined);
    void deps.checkStuckMatrices().catch((err) => {
      console.error(
        `[agent-steward] Детектор зависших матриц: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }, NOTIFICATION_CHECK_MS);
  notificationTimer.unref?.();
  void deps.maybeSendDigest().catch(() => undefined);
  void deps.checkStuckMatrices().catch(() => undefined);

  // Инициализация блокировок: создаём директорию и очищаем зависшие lock-файлы (>24 ч).
  const lockManager = new LockManager(LOCK_DIR);
  await lockManager.initialize();

  // Восстановление пропущенных запусков (catch-up): если OpenCode был закрыт,
  // а задача должна была выполниться (с nextRun прошло >5 мин и в истории нет
  // записи после этого времени) — запускаем её немедленно.
  void (async () => {
    try {
      const definitions = await loadTaskDefinitions();
      const history = await loadHistory();
      const now = new Date();
      // QW-2: paused/pausedUntil отсеиваются внутри selectCatchUpTasks.
      // На POSIX runTask спавнит bash напрямую и не проверяет disabled-задачу,
      // поэтому старт плагина больше не должен запускать задачи на паузе.
      const candidates = selectCatchUpTasks(definitions, history, now);

      for (const candidate of candidates) {
        const { definition, ageMs } = candidate;
        // Запускаем задачу и пишем в лог.
        try {
          await deps.runTaskEntry(definition.name);
          console.log(
            `[agent-steward] Запущено восстановление пропущенной задачи "${definition.name}" (последний срабатывал ~${Math.round(ageMs / 1000)} с назад).`,
          );
        } catch (err) {
          console.error(
            `[agent-steward] Не удалось восстановить задачу "${definition.name}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[agent-steward] Catch-up ошибка: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  // Файловые триггеры (File Watchers): задачи с triggerType === "file"
  // запускаются при изменении watchPath через chokidar (с дебаунсом).
  deps.setFileWatcherManager(new FileWatchManager(async (taskName) => {
    try {
      // PL-130: задачу уже запустили — последующие правки наблюдаемого файла
      // сделаны этим же агентом и не должны вызывать самоповтор (11 лишних
      // запусков в зонде DS313-FILE-PROBE).
      // PL-143: окно берётся из AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS
      // (по умолчанию FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS); каждое фактическое
      // подавление логируется в FileWatchManager.onChange с префиксом PL-143.
      console.log(
        `[PL-143] Задача "${taskName}": установлено окно подавления self-write ` +
          `${deps.getFileWatcherManager()?.selfWriteSuppressMs ?? FILE_TRIGGER_SELF_WRITE_SUPPRESS_MS} мс.`,
      );
      deps.getFileWatcherManager()?.suppressForTask(taskName);
      await deps.scheduleEventRun(taskName, "изменение отслеживаемого файла");
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось запустить задачу "${taskName}" по файловому триггеру: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }));

  // Спринт 27: git-триггеры — опрос HEAD и запуск при новых коммитах,
  // затронувших подходящие файлы.
  deps.setGitTriggerManager(new GitTriggerManager(async (taskName, info) => {
    try {
      await deps.scheduleEventRun(taskName, `новый коммит ${info.head?.slice(0, 7) ?? ""}`);
    } catch (err) {
      console.error(
        `[agent-steward] Не удалось запустить задачу "${taskName}" по git-триггеру: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }));
  void deps.refreshTriggers();

  return {
    projectDirectory,
    dispose: () => {
      clearInterval(pausedUntilTimer);
      clearInterval(notificationTimer);
      const fileManager = deps.getFileWatcherManager();
      if (fileManager) {
        void fileManager.stop();
        deps.setFileWatcherManager(null);
      }
      const gitManager = deps.getGitTriggerManager();
      if (gitManager) {
        void gitManager.stop();
        deps.setGitTriggerManager(null);
      }
    },
  };
}
