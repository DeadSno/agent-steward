import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOCK_DIR, STALE_LOCK_MAX_AGE_MS } from "../types.js";

/**
 * Проверяет, жив ли процесс-владелец lock-файла.
 *
 * `process.kill(pid, 0)` не посылает сигнал, а только проверяет существование.
 * EPERM означает, что процесс есть, но у нас нет прав на сигнал — считаем живым.
 * Остальные ошибки трактуем консервативно как «жив», чтобы не вытеснить
 * чужую критическую секцию.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

/** PID владельца из токена lock-файла (`<pid>-<timestamp>-<uuid>`). */
function ownerPidFromToken(content: string): number | null {
  const match = /^(\d+)-/.exec(content.trim());
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  return Number.isInteger(pid) ? pid : null;
}


/**
 * Менеджер файловых блокировок для предотвращения наложения запусков одной задачи.
 *
 * Блокировка реализуется через атомарное создание файла с флагом 'wx' (exclusive create).
 * Если файл уже существует — блокировка удерживается другим запуском.
 * После завершения задачи файл удаляется.
 * Зависшие блокировки (старше STALE_LOCK_MAX_AGE_MS) удаляются при инициализации.
 */
export class LockManager {
  private readonly lockDir: string;

  constructor(lockDir: string = LOCK_DIR) {
    this.lockDir = lockDir;
  }

  /** Имя lock-файла для задачи. */
  private lockFileName(taskName: string): string {
    return `${taskName}.lock`;
  }

  /** Полный путь к lock-файлу задачи. */
  private lockFilePath(taskName: string): string {
    return path.join(this.lockDir, this.lockFileName(taskName));
  }

  /** Публичный путь к lock-файлу (для ожидания/вытеснения зависших lock). */
  pathFor(taskName: string): string {
    return this.lockFilePath(taskName);
  }

  /**
   * Инициализация директории блокировок и очистка зависших (старых) файлов.
   * Вызывается при старте плагина.
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });

    const files = await fs.readdir(this.lockDir).catch(() => []);
    const now = Date.now();

    for (const file of files) {
      const fullPath = path.join(this.lockDir, file);
      // Каталог <task>.lock.d держит POSIX-обёртка (mkdir-блокировка).
      // После kill -9 он остаётся навсегда, поэтому чистим его так же, как .lock.
      const isLockFile = file.endsWith(".lock");
      const isLockDir = file.endsWith(".lock.d");
      const isStaleArtifact = /\.lock(\.d)?\.stale-/.test(file);
      if (!isLockFile && !isLockDir && !isStaleArtifact) continue;
      try {
        // Артефакт предыдущего вытеснения валидным lock быть не может,
        // поэтому убираем его независимо от возраста.
        if (isStaleArtifact) {
          await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        const stat = await fs.stat(fullPath);
        const age = now - stat.mtimeMs;
        if (age > STALE_LOCK_MAX_AGE_MS) {
          // P2-18: возраст — только повод проверить владельца. Задача может
          // легально работать дольше 24 ч (timeoutSeconds: 0), поэтому живой
          // процесс не вытесняем: иначе после рестарта плагина появится дубль.
          if (isLockFile) {
            const content = await fs.readFile(fullPath, "utf8").catch(() => "");
            const ownerPid = ownerPidFromToken(content);
            if (ownerPid !== null && isProcessAlive(ownerPid)) {
              console.log(
                `[agent-steward] Lock ${file} старше ${Math.round(
                  age / 1000,
                )} с, но процесс ${ownerPid} жив — оставляем.`,
              );
              continue;
            }
          }
          // T-03: не удаляем lock напрямую. Два воркера могли одновременно
          // снести один и тот же файл, после чего один из них удалял свежий
          // lock, созданный другим, и задача запускалась повторно. Атомарный
          // rename в уникальное имя выигрывает только один процесс; второй
          // получает ENOENT и не трогает чужой lock.
          const stalePath = `${fullPath}.stale-${process.pid}-${Date.now()}`;
          try {
            await fs.rename(fullPath, stalePath);
          } catch {
            continue;
          }
          await fs.rm(stalePath, { recursive: true, force: true }).catch(() => {});

          console.log(
            `[agent-steward] Вытеснен зависший lock: ${file} (возраст ${Math.round(
              age / 1000,
            )} с)`,
          );
        }
      } catch {
        // Игнорируем ошибки чтения отдельных файлов при очистке.
      }
    }
  }

  /**
   * Пытается захватить блокировку для задачи.
   * Возвращает уникальный токен владельца (он же содержимое lock-файла) или
   * null, если блокировка уже удерживается другим запуском.
   *
   * Токен нужен release(): процесс, чей lock был вытеснен по stale-таймауту,
   * не должен удалять файл нового владельца.
   */
  async acquire(taskName: string): Promise<string | null> {
    await fs.mkdir(this.lockDir, { recursive: true });
    const lockPath = this.lockFilePath(taskName);
    const token = `${process.pid}-${Date.now()}-${randomUUID()}`;

    try {
      // 'wx' — exclusive create: ошибка если файл уже существует.
      await fs.writeFile(lockPath, token, { flag: "wx" });
      return token;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Освобождает блокировку задачи (удаляет lock-файл).
   *
   * Удаляет файл только если в нём лежит токен этого владельца. Если lock
   * успели вытеснить и перехватить, release ничего не трогает и возвращает
   * false — иначе старый процесс снёс бы чужую критическую секцию.
   * Не выбрасывает ошибку, если файл уже удалён.
   */
  async release(taskName: string, token: string): Promise<boolean> {
    const lockPath = this.lockFilePath(taskName);
    let current: string;
    try {
      current = await fs.readFile(lockPath, "utf8");
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
    if (current !== token) return false;
    try {
      await fs.unlink(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Проверяет, удерживается ли блокировка задачей в данный момент.
   */
  async isLocked(taskName: string): Promise<boolean> {
    const lockPath = this.lockFilePath(taskName);
    try {
      await fs.stat(lockPath);
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }
}

/**
 * Выполняет функцию с захватом файловых блокировок.
 * Если блокировка уже удерживается — пропускает выполнение и возвращает null.
 * Гарантирует освобождение блокировки в finally (включая при ошибках).
 */
export async function withLock<T>(
  lockManager: LockManager,
  taskName: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = await lockManager.acquire(taskName);
  if (!token) {

    console.log(
      `[agent-steward] Запуск задачи "${taskName}" пропущен: удерживается активная блокировка.`,
    );
    return null;
  }

  try {
    return await fn();
  } finally {
    await lockManager.release(taskName, token);
  }
}

/**
 * Выполняет функцию с ожиданием освобождения файловой блокировки.
 * В отличие от withLock не пропускает выполнение, а ждёт: критично для
 * read-modify-write операций (crontab), где пропуск ломает состояние.
 * Если lock удерживается дольше staleMs — считается осиротевшим и вытесняется
 * атомарным rename (как в T-03), чтобы зависший процесс не блокировал навсегда.
 */
export async function withLockWait<T>(
  lockManager: LockManager,
  taskName: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryDelayMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const staleMs = options.staleMs ?? 60000;
  const deadline = Date.now() + timeoutMs;
  const lockPath = lockManager.pathFor(taskName);
  let token: string | null = null;

  for (;;) {
    token = await lockManager.acquire(taskName);
    if (token) break;

    // Осиротевший lock: короткая операция не может длиться дольше staleMs.
    if (staleMs > 0) {
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          // P2-18: staleMs — не приговор. Если владелец ещё жив, его
          // критическая секция может быть легально долгой (crontab RMW,
          // длинная задача). Вытесняем только мёртвый/неизвестный lock.
          const content = await fs.readFile(lockPath, "utf8").catch(() => "");
          const ownerPid = ownerPidFromToken(content);
          if (ownerPid !== null && isProcessAlive(ownerPid)) {
            // Ждём дальше; по deadline вернём понятную ошибку.
          } else {
            // T-03-совместимое вытеснение: атомарный rename выигрывает ровно
            // один процесс, остальные получают ENOENT и повторяют попытку.
            const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
            try {
              await fs.rename(lockPath, stalePath);
              await fs.rm(stalePath, { force: true }).catch(() => {});
            } catch {
              // Кто-то успел раньше — просто повторяем acquire.
            }
            continue;
          }
        }
      } catch {
        // lock исчез — сразу пробуем acquire снова.
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Не удалось получить блокировку "${taskName}" за ${timeoutMs} мс.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  try {
    return await fn();
  } finally {
    if (token) await lockManager.release(taskName, token);
  }
}
