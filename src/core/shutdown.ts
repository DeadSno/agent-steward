/**
 * Д6: ворота выгрузки плагина.
 *
 * Позволяют перестать принимать новые запуски и дождаться уже начатых
 * in-process операций (запуск задачи, matrix, DAG-триггер) перед закрытием
 * SQLite и HTTP-сервера. Внешние процессы планировщика ОС эти ворота не
 * отслеживают: их жизненным циклом управляет сама ОС.
 *
 * PL-10/QV-2: состояние ворот наблюдаемо (причина, время, PID, активные
 * операции), а «зависшие» ворота (begin без complete, нет активных операций,
 * прошло больше STALE_MS) автоматически открываются при первом же запросе.
 * Так hot-reload каталога инструментов не блокирует in-process запуски,
 * пока ОС-планировщик продолжает тикать.
 */

/** Порог «зависших» ворот; переопределяется для тестов через env. */
const STALE_GATE_MS = Number(process.env.AGENT_STEWARD_SHUTDOWN_STALE_MS ?? 30_000);

export interface ShutdownWaitResult {
  timedOut: boolean;
  remaining: number;
}

export interface ShutdownGateState {
  shuttingDown: boolean;
  /** Причина, по которой ворота были закрыты (обычно «plugin unload»). */
  reason: string | null;
  /** ISO-время вызова begin(). */
  startedAt: string | null;
  /** PID процесса, в котором ворота закрыты. */
  pid: number;
  /** Число ещё выполняемых in-process операций. */
  activeCount: number;
  /** true после complete() — выгрузка действительно завершена. */
  unloadCompleted: boolean;
  /** Диагностика последнего автоматического сброса. */
  lastAutoReset: string | null;
}

export interface ShutdownGate {
  /** true после begin(), пока ворота не открылись повторно. */
  isShuttingDown(): boolean;
  /** Переводит ворота в режим выгрузки. */
  begin(reason?: string): void;
  /** Подтверждает, что выгрузка завершена (запрещает автосброс). */
  complete(): void;
  /**
   * PL-45: принудительно открывает ворота. Вызывается при повторной
   * регистрации плагина (V2 setup / V1 hooks), когда хост ранее вызвал
   * begin()+complete(), но модуль остался в памяти (Code Mode / hot-reload).
   */
  reset(): void;
  /** Снимок состояния для диагностики и структурированных ошибок. */
  state(): ShutdownGateState;
  /** Учитывает промис до его завершения (успех или ошибка). */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Сколько операций ещё выполняется. */
  activeCount(): number;
  /** Ждёт завершения активных операций не дольше timeoutMs. */
  waitForIdle(timeoutMs: number): Promise<ShutdownWaitResult>;
}

export function createShutdownGate(): ShutdownGate {
  let shuttingDown = false;
  let reason: string | null = null;
  let startedAtMs: number | null = null;
  let unloadCompleted = false;
  let lastAutoReset: string | null = null;
  const active = new Set<Promise<unknown>>();

  const maybeResetStale = (): void => {
    if (
      !shuttingDown ||
      active.size !== 0 ||
      startedAtMs === null ||
      Date.now() - startedAtMs < STALE_GATE_MS
    ) {
      return;
    }
    const waitedMs = Date.now() - startedAtMs;
    lastAutoReset =
      `ворота оставались закрытыми ${waitedMs} мс без активных операций ` +
      (unloadCompleted
        ? "после complete() без выгрузки модуля — автосброс в Code Mode"
        : "и без complete() — автосброс после hot-reload");
    shuttingDown = false;
    reason = null;
    startedAtMs = null;
  };

  return {
    isShuttingDown: () => {
      maybeResetStale();
      return shuttingDown;
    },
    begin: (why = "plugin unload") => {
      shuttingDown = true;
      reason = why;
      startedAtMs = Date.now();
      unloadCompleted = false;
    },
    complete: () => {
      unloadCompleted = true;
    },
    reset: () => {
      if (shuttingDown) {
        lastAutoReset = "ворота открыты повторной регистрацией плагина (PL-45)";
      }
      shuttingDown = false;
      reason = null;
      startedAtMs = null;
      unloadCompleted = false;
    },
    state: () => ({
      shuttingDown,
      reason,
      startedAt: startedAtMs === null ? null : new Date(startedAtMs).toISOString(),
      pid: process.pid,
      activeCount: active.size,
      unloadCompleted,
      lastAutoReset,
    }),
    track<T>(promise: Promise<T>): Promise<T> {
      const tracked = promise.finally(() => {
        active.delete(tracked);
      });
      active.add(tracked);
      return tracked;
    },
    activeCount: () => active.size,
    async waitForIdle(timeoutMs: number): Promise<ShutdownWaitResult> {
      if (active.size === 0) {
        return { timedOut: false, remaining: 0 };
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
      });

      try {
        const outcome = await Promise.race([
          Promise.allSettled(Array.from(active)).then(() => "done" as const),
          timeout,
        ]);
        return {
          timedOut: outcome === "timeout",
          remaining: active.size,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
