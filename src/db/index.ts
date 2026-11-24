import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { PLUGIN_DIR } from "../types.js";
import { applySchema, getSchemaVersion, SCHEMA_VERSION } from "./schema.js";

/**
 * Подключение к SQLite через встроенный `node:sqlite` (Node 22.22+, см. engines).
 *
 * Мы не импортируем модуль статически: в @types/node 20 типов для node:sqlite
 * ещё нет, а `createRequire` позволяет получить модуль без объявления
 * глобального ambient-модуля (и не конфликтовать с будущими версиями типов).
 */
export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

/**
 * Граница `node:sqlite`: в @types/node нет типов для этого модуля, поэтому
 * драйвер оборачиваем сами. Параметры запросов — `unknown` (вызывающему
 * коду можно передавать любые значения), а форма результата произвольна:
 * `any` в возвращаемых типах остаётся только на этой границе внешнего API
 * (QA-A2.7) — вызывающий код сужает его type guard-ом (см. isRecord в
 * модулях репозиториев).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- внешний API node:sqlite, QA-A2.7 */
export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  iterate(...params: unknown[]): IterableIterator<any>;
}
/* eslint-enable @typescript-eslint/no-explicit-any -- node:sqlite, QA-A2.7 */

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** BN-7: онлайн-снимок БД (node:sqlite, доступен с Node 22.x). */
  serialize?(): Uint8Array;
}

type DatabaseSyncCtor = new (
  location: string,
  options?: Record<string, unknown>
) => SqliteDatabase;

const nodeRequire = createRequire(import.meta.url);

function loadSqlite(): DatabaseSyncCtor {
  try {
    const mod = nodeRequire("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
    return mod.DatabaseSync;
  } catch (err: unknown) {
    throw new Error(
      `node:sqlite недоступен (${err instanceof Error ? err.message : String(err)}). ` +
        "Планировщику требуется Node.js 22.22+ (рекомендуется Node 24).",
    );
  }
}

/** Путь к БД. Переменная окружения нужна только тестам. */
const DEFAULT_DB_FILE = process.env.OPENCODE_SCHEDULER_DB?.trim()
  ? path.resolve(process.env.OPENCODE_SCHEDULER_DB.trim())
  : path.join(PLUGIN_DIR, "scheduler.db");

let dbFile = DEFAULT_DB_FILE;
let db: SqliteDatabase | null = null;
/** Глубина вложенности withTransaction: 0 — транзакции нет, >0 — SAVEPOINT. */
let transactionDepth = 0;

/** Открывает (или переоткрывает) соединение и применяет схему. */
export function initDb(file: string = dbFile): SqliteDatabase {
  if (db && file === dbFile) return db;
  if (db) closeDb();

  dbFile = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const DatabaseSync = loadSqlite();
  const instance = new DatabaseSync(file);

  // busy_timeout ДОЛЖЕН быть установлен до WAL: при одновременном старте
  // нескольких процессов (каждое завершение задачи — отдельный
  // `node record-history`) переключение journal_mode требует эксклюзивной
  // блокировки. Без таймаута SQLite сразу падает с "database is locked".
  instance.exec("PRAGMA busy_timeout = 5000;");
  // WAL — конкурентное чтение во время записи и устойчивость к сбоям.
  // synchronous = NORMAL в WAL гарантирует, что закоммиченная транзакция
  // переживает падение процесса (шаг 36.1.b); при потере питания может
  // потеряться только последний коммит — это осознанный компромисс.
  instance.exec("PRAGMA journal_mode = WAL;");
  instance.exec("PRAGMA synchronous = NORMAL;");
  instance.exec("PRAGMA foreign_keys = ON;");
  applySchema(instance);

  db = instance;
  return instance;
}

/** Singleton-соединение. Создаётся лениво при первом обращении. */
export function getDb(): SqliteDatabase {
  return db ?? initDb();
}

/** Закрывает соединение (вызывается при выгрузке плагина). */
export function closeDb(): void {
  transactionDepth = 0;
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Чекпойнт не критичен при закрытии.
  }
  try {
    db.close();
  } catch {
    // Соединение могло быть уже закрыто.
  }
  db = null;
}

/** Текущий путь к файлу БД. */
export function getDbFile(): string {
  return dbFile;
}

/** Сбрасывает WAL в основной файл — нужно перед отдачей .db наружу. */
export function checkpointDb(): void {
  getDb().exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/** Информация о хранилище для /api/health и футера дашборда. */
export function getDbStatus(): {
  engine: "sqlite";
  file: string;
  journalMode: string;
  wal: boolean;
  schemaVersion: number;
  expectedSchemaVersion: number;
  } {
  let journalMode = "unknown";
  let schemaVersion = 0;
  try {
    const row: unknown = getDb().prepare("PRAGMA journal_mode;").get();
    const mode =
      typeof row === "object" && row !== null ? (row as { journal_mode?: unknown }).journal_mode : undefined;
    journalMode =
      mode == null
        ? "unknown"
        : typeof mode === "string" || typeof mode === "number" || typeof mode === "boolean"
          ? String(mode)
          : "unknown";
    schemaVersion = getSchemaVersion(getDb());
  } catch {
    // Если БД ещё не открыта — не роняем health-check.
  }
  return {
    engine: "sqlite",
    file: dbFile,
    journalMode,
    wal: journalMode.toLowerCase() === "wal",
    schemaVersion,
    expectedSchemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Выполняет функцию в транзакции BEGIN IMMEDIATE.
 * При любой ошибке откатывает изменения и пробрасывает исключение дальше.
 *
 * Вложенный вызов не открывает вторую транзакцию (SQLite это запрещает), а
 * создаёт SAVEPOINT: так композиция вроде «retry из DLQ → reopenRun → retryStep»
 * остаётся атомарной, а внутренний откат не рушит внешнюю транзакцию.
 */
export function withTransaction<T>(fn: () => T): T {
  const instance = getDb();

  if (transactionDepth > 0) {
    const savepoint = `sp_nested_${transactionDepth}`;
    instance.exec(`SAVEPOINT ${savepoint};`);
    transactionDepth += 1;
    try {
      const result = fn();
      instance.exec(`RELEASE ${savepoint};`);
      return result;
    } catch (err) {
      try {
        instance.exec(`ROLLBACK TO ${savepoint};`);
        instance.exec(`RELEASE ${savepoint};`);
      } catch {
        // SAVEPOINT уже снят вместе с внешней транзакцией.
      }
      throw err;
    } finally {
      transactionDepth -= 1;
    }
  }

  instance.exec("BEGIN IMMEDIATE;");
  transactionDepth = 1;
  try {
    const result = fn();
    instance.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      instance.exec("ROLLBACK;");
    } catch {
      // Откат мог не понадобиться (например, SQLite уже откатил сам).
    }
    throw err;
  } finally {
    transactionDepth = 0;
  }
}

/** Пуста ли БД (не считая служебных настроек вроде retry_state). */
export function isDatabaseEmpty(): boolean {
  const row: unknown = getDb()
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM tasks) +
         (SELECT COUNT(*) FROM history) +
         (SELECT COUNT(*) FROM metrics) +
         (SELECT COUNT(*) FROM templates) AS count`,
    )
    .get();
  const count =
    typeof row === "object" && row !== null ? (row as { count?: unknown }).count : undefined;
  return Number(count) === 0;
}
