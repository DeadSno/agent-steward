import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { LOCK_DIR, STALE_LOCK_MAX_AGE_MS } from "../types.js";

/**
 * O-2: ошибки очистки больше не проглатываются молча. Прямой импорт
 * `structured-log.ts` создал бы цикл (structured-log → secrets → lock), поэтому
 * здесь используется `console.warn` — предупреждение всё равно видно в логе
 * процесса и не ломает основной сценарий.
 */
function warnCleanupFailure(target: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(`[agent-steward] Не удалось удалить lock-артефакт «${target}»: ${reason}`);
}

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
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return false;
    return true;
  }
}

/** Разобранный lock-токен: PID владельца и формат записи. */
export interface LockToken {
  pid: number | null;
  createdAt: string | null;
  format: "unified" | "node-legacy" | "ps-legacy" | "pid" | "unknown";
}

/** Достаёт ISO-время из первой части legacy PS-токена (`ISO|PID`). */
function parseIsoOrNull(value: string | undefined): string | null {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(text) ? text : null;
}

/**
 * Разбирает содержимое lock-файла в едином для Node/PS/bash виде.
 *
 * Поддерживаемые форматы:
 *   `<pid>-<iso>`          — единый формат (Node и PS, B6);
 *   `<pid>-<epoch>-<uuid>` — старый Node-токен;
 *   `<iso>|<pid>`          — старый PS-токен (ISO|PID);
 *   `<pid>`                — голый PID (pid-файл bash-обёртки).
 *
 * Порядок важен: legacy PS проверяется до `<pid>-…`, иначе год из ISO
 * (`2026`) принимался за PID — именно это ломало межпроцессную совместимость.
 */
export function parseLockToken(content: string): LockToken {
  const text = String(content ?? "").trim();
  if (!text) return { pid: null, createdAt: null, format: "unknown" };

  const withPipe = text.indexOf("|");
  if (withPipe !== -1) {
    const pid = Number.parseInt(text.slice(withPipe + 1).trim(), 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      createdAt: parseIsoOrNull(text.slice(0, withPipe)),
      format: "ps-legacy",
    };
  }

  const unified = /^(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:-.*)?$/i.exec(text);
  if (unified) {
    const pid = Number.parseInt(unified[1], 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      createdAt: unified[2],
      format: "unified",
    };
  }

  // Старый Node мог добавить любой суффикс после epoch (`-live-owner`, uuid).
  const legacyNode = /^(\d+)-(\d{10,})(?:-.*)?$/i.exec(text);
  if (legacyNode) {
    const pid = Number.parseInt(legacyNode[1], 10);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      createdAt: null,
      format: "node-legacy",
    };
  }

  if (/^\d+$/.test(text)) {
    const pid = Number.parseInt(text, 10);
    // Голое число — PID (pid-файл bash), но не epoch из старого тестового
    // lock: 1.7e12 не может быть PID и раньше не распознавалось владельцем.
    return {
      pid: Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647 ? pid : null,
      createdAt: null,
      format: "pid",
    };
  }

  return { pid: null, createdAt: null, format: "unknown" };
}

/** PID владельца из токена lock-файла (любой поддерживаемый формат). */
export function ownerPidFromToken(content: string): number | null {
  return parseLockToken(content).pid;
}

/**
 * PID владельца lock-артефакта.
 *
 * B7: файловый lock Node/PS хранит токен в самом файле, а POSIX-обёртка
 * держит каталог `<lock>.d` и пишет `<pid>-<iso>` в `<lock>.d/pid`.
 * Раньше каталог вытеснялся только по возрасту, без чтения этого файла,
 * поэтому легально долгая задача (> 24 ч) после рестарта плагина
 * дублировалась. Нет pid-файла/не разобрался — возвращаем null,
 * и решение принимает возраст (fallback).
 */
export async function readLockOwnerPid(
  lockPath: string,
  isDir: boolean,
): Promise<number | null> {
  const tokenPath = isDir ? path.join(lockPath, "pid") : lockPath;
  const content = await fs.readFile(tokenPath, "utf8").catch(() => "");
  return ownerPidFromToken(content);
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
          await fs.rm(fullPath, { recursive: true, force: true }).catch((err: unknown) =>
            warnCleanupFailure(fullPath, err),
          );
          continue;
        }
        const stat = await fs.stat(fullPath);
        const age = now - stat.mtimeMs;
        if (age > STALE_LOCK_MAX_AGE_MS) {
          // P2-18/B7: возраст — только повод проверить владельца. Задача может
          // легально работать дольше 24 ч (timeoutSeconds: 0), поэтому живой
          // процесс не вытесняем: иначе после рестарта плагина появится дубль.
          // B7: для каталога `.lock.d` владелец лежит в `<dir>/pid`, а не в
          // самом файле; без этого проверка смотрела только на `.lock`.
          const ownerPid = await readLockOwnerPid(fullPath, isLockDir);
          if (ownerPid !== null && isProcessAlive(ownerPid)) {
            console.log(
              `[agent-steward] Lock ${file} старше ${Math.round(
                age / 1000,
              )} с, но процесс ${ownerPid} жив — оставляем.`,
            );
            continue;
          }
          // QW-15.3: между stat() и rename() владелец мог заново захватить
          // lock. Перепроверяем токен непосредственно перед вытеснением,
          // чтобы не снести живую критическую секцию.
          const currentOwnerPid = await readLockOwnerPid(fullPath, isLockDir);
          if (currentOwnerPid !== null && isProcessAlive(currentOwnerPid)) {
            continue;
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
          await fs.rm(stalePath, { recursive: true, force: true }).catch((err: unknown) =>
            warnCleanupFailure(stalePath, err),
          );

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
    // B6: единый формат `<pid>-<iso>` (+ uuid для уникальности токена).
    // PS-обёртка пишет тот же префикс, поэтому её stale-проверка видит PID,
    // а не год из даты, и не вытесняет живой Node-лок.
    const token = `${process.pid}-${new Date().toISOString()}-${randomUUID()}`;

    try {
      // 'wx' — exclusive create: ошибка если файл уже существует.
      await fs.writeFile(lockPath, token, { flag: "wx" });
      return token;
    } catch (err: unknown) {
      // P3-39: на Windows конкурентный create/delete того же lock-файла
      // возвращает EPERM/EACCES/EBUSY вместо EEXIST. Это тот же случай
      // «блокировка занята», а не ошибка прав: отдаём null, а withLockWait
      // повторит попытку (withLock корректно пропустит запуск).
      if (
        (err as NodeJS.ErrnoException).code === "EEXIST" ||
        (err as NodeJS.ErrnoException).code === "EPERM" ||
        (err as NodeJS.ErrnoException).code === "EACCES" ||
        (err as NodeJS.ErrnoException).code === "EBUSY"
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Удаляет lock-файл, переживая кратковременные Windows-блокировки.
   *
   * На Windows unlink может вернуть EPERM/EACCES/EBUSY, пока другой процесс
   * читает файл (проверка владельца в withLockWait) или файл ещё «висящий»
   * после создания. Несколько коротких повторов решают гонку; ENOENT — уже
   * удалён, это не ошибка.
   */
  private async unlinkWithRetry(
    lockPath: string,
    expectedToken: string,
    attempts = 6,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i += 1) {
      // QW-15.3: read→unlink не атомарен. Перед КАЖДОЙ попыткой удаления
      // перепроверяем токен: если lock уже перехвачен новым владельцем,
      // удалять чужой файл нельзя (TOCTOU между readFile и unlink).
      let current: string;
      try {
        current = await fs.readFile(lockPath, "utf8");
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw err;
      }
      if (current !== expectedToken) return false;
      try {
        await fs.unlink(lockPath);
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        const transient =
          (err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EBUSY";
        if (transient && i < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 10 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
    return false;
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
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (current !== token) return false;
    // P3-39: на Windows unlink может кратковременно упасть EPERM, пока
    // другие процессы читают lock для проверки владельца.
    // QW-15.3: unlinkWithRetry сам повторно проверяет токен перед unlink.
    return this.unlinkWithRetry(lockPath, token);
  }

  /**
   * Проверяет, удерживается ли блокировка задачей в данный момент.
   */
  async isLocked(taskName: string): Promise<boolean> {
    const lockPath = this.lockFilePath(taskName);
    try {
      await fs.stat(lockPath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
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
              await fs.rm(stalePath, { force: true }).catch((err: unknown) =>
                warnCleanupFailure(stalePath, err),
              );
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
