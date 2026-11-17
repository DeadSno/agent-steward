/**
 * Д6: ворота выгрузки плагина.
 *
 * Позволяют перестать принимать новые запуски и дождаться уже начатых
 * in-process операций (запуск задачи, matrix, DAG-триггер) перед закрытием
 * SQLite и HTTP-сервера. Внешние процессы планировщика ОС эти ворота не
 * отслеживают: их жизненным циклом управляет сама ОС.
 */

export interface ShutdownWaitResult {
  timedOut: boolean;
  remaining: number;
}

export interface ShutdownGate {
  /** true после begin(): новые запуски должны отклоняться. */
  isShuttingDown(): boolean;
  /** Переводит ворота в режим выгрузки. */
  begin(): void;
  /** Учитывает промис до его завершения (успех или ошибка). */
  track<T>(promise: Promise<T>): Promise<T>;
  /** Сколько операций ещё выполняется. */
  activeCount(): number;
  /** Ждёт завершения активных операций не дольше timeoutMs. */
  waitForIdle(timeoutMs: number): Promise<ShutdownWaitResult>;
}

export function createShutdownGate(): ShutdownGate {
  let shuttingDown = false;
  const active = new Set<Promise<unknown>>();

  return {
    isShuttingDown: () => shuttingDown,
    begin: () => {
      shuttingDown = true;
    },
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
