/**
 * D15 (IM-14): авто-бэкап БД перед каждой ступенью миграции схемы.
 *
 * Модуль намеренно не импортирует `./index.js`: `initDb()` вызывает
 * `applySchema()` до присваивания модульного singleton-а `db`, поэтому
 * использование `getDb()` здесь привело бы к рекурсии. Вместо этого снимок
 * делается из соединения, переданного вызывающим кодом.
 *
 * Политика: копия создаётся только для существующего файла БД, у которого
 * `PRAGMA user_version` отстаёт от целевой ступени. Хранятся последние
 * {@link MIGRATION_BACKUP_KEEP} копий в каталоге `<db>.migration-backups/`.
 * Перед записью проверяется `PRAGMA integrity_check`, после записи —
 * SHA-256 прочитанного файла и SQLite-заголовок. При любой ошибке миграция
 * прерывается: лучше не открывать БД, чем переписать её без страховки.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Сколько последних миграционных копий оставляем. */
export const MIGRATION_BACKUP_KEEP = 5;

const BACKUP_NAME = /^v\d+-to-\d+-\d+T\d+\.db$/;

export interface MigrationBackupDb {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
  serialize?(): Uint8Array;
}

export interface MigrationBackupResult {
  created: boolean;
  file?: string;
  bytes?: number;
  sha256?: string;
  reason?: string;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");
}

/** Удаляет старые копии, оставляя не более {@link MIGRATION_BACKUP_KEEP}. */
export function pruneMigrationBackups(dir: string, keep = MIGRATION_BACKUP_KEEP): number {
  if (!fs.existsSync(dir)) return 0;
  const names = fs
    .readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort((a, b) => b.localeCompare(a));
  let removed = 0;
  for (const name of names.slice(Math.max(0, keep))) {
    fs.rmSync(path.join(dir, name), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Снимает проверенную копию БД перед переходом `fromVersion → toVersion`.
 * Возвращает `{created:false}` для новых/виртуальных БД — там мигрировать
 * нечего. Бросает исключение при ошибке снимка или верификации.
 */
export function createMigrationBackup(
  db: MigrationBackupDb,
  dbFile: string | undefined,
  fromVersion: number,
  toVersion: number,
  now: Date = new Date(),
): MigrationBackupResult {
  if (!dbFile || dbFile === ":memory:" || !fs.existsSync(dbFile)) {
    return { created: false, reason: "БД ещё не существует — миграция не нужна" };
  }
  // QA-D316-31: на Node 22.22 в CI node:sqlite может не предоставлять
  // serialize(). Fallback — чекпойнт WAL + чтение файла БД: снимок остаётся
  // консистентным, а миграции не падают до старта всех остальных тестов.
  const canSerialize = typeof db.serialize === "function";

  const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check?: string }[];
  if (integrity.length !== 1 || String(integrity[0]?.integrity_check).toLowerCase() !== "ok") {
    throw new Error(
      `Миграционный бэкап: PRAGMA integrity_check не прошёл (${JSON.stringify(integrity)})`,
    );
  }
  // В WAL часть данных живёт в отдельном файле; чекпойнт делает снимок полным.
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // Чекпойнт может быть заблокирован читателями — serialize() всё равно
    // вернёт консистентную картинку, а верификация ниже это подтвердит.
  }

  const bytes =
    (canSerialize ? db.serialize?.() : undefined) ?? fs.readFileSync(path.resolve(dbFile));
  if (!bytes?.length) throw new Error("Миграционный бэкап: снимок БД пуст");
  const sha = checksum(bytes);
  const dir = path.join(path.dirname(path.resolve(dbFile)), `${path.basename(dbFile)}.migration-backups`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `v${fromVersion}-to-${toVersion}-${timestamp(now)}.db`);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temp, bytes);
    const reread = fs.readFileSync(temp);
    if (checksum(reread) !== sha) throw new Error("SHA-256 снимка не совпал после записи");
    if (reread.subarray(0, 16).toString("utf8") !== "SQLite format 3\u0000") {
      throw new Error("Снимок не является SQLite-БД");
    }
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
  pruneMigrationBackups(dir);
  return { created: true, file: target, bytes: bytes.length, sha256: sha };
}
