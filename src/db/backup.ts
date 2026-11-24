/**
 * BN-7 (BP-D15-1): полный backup/restore БД планировщика.
 *
 * `serialize()` снимает консистентный онлайн-снимок открытого соединения.
 * Восстановление делает логический возврат данных через ATTACH временного
 * файла к ТОМУ ЖЕ соединению: `deserialize()` в Node 24 не работает с
 * файловыми БД в режиме WAL (после него соединение теряет файл), а закрытие
 *_connection привело бы к простою дашборда. ATTACH + транзакция сохраняют
 * соединение открытым на всём протяжении операции.
 *
 * Контрольная сумма SHA-256 считается по байтам снимка и проверяется перед
 * восстановлением: повреждённый или подменённый файл не загрузится.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { checkpointDb, getDb, getDbFile } from "./index.js";

export interface DbBackupResult {
  success: boolean;
  file?: string;
  bytes?: number;
  sha256?: string;
  error?: string;
}

export interface DbRestoreResult {
  success: boolean;
  file?: string;
  bytes?: number;
  sha256?: string;
  error?: string;
}

/** Приводит `sha256=<hex>` и «голый» hex к одной форме. */
function normalizeChecksum(value: string): string {
  return value.trim().replace(/^sha256=/i, "").toLowerCase();
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Путь бэкапа по умолчанию — рядом с БД, с расширением `.backup`. */
export function defaultBackupPath(): string {
  return `${getDbFile()}.backup`;
}

/**
 * Снимает онлайн-снимок БД и атомарно пишет его в файл.
 * `file` по умолчанию — `<путь к БД>.backup`.
 */
export function backupDatabase(file?: string): DbBackupResult {
  try {
    checkpointDb();
    const db = getDb();
    if (typeof db.serialize !== "function") {
      return {
        success: false,
        error: "node:sqlite не поддерживает serialize() — обновите Node.js до 22.5+",
      };
    }
    const bytes = db.serialize();
    const sha = checksum(bytes);
    const target = path.resolve(file?.trim() || defaultBackupPath());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(temp, bytes);
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    return { success: true, file: target, bytes: bytes.length, sha256: sha };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Проверяет файл бэкапа по контрольной сумме. */
export function verifyDbBackup(
  file: string,
  expectedSha256?: string,
): { ok: boolean; bytes?: number; sha256?: string; error?: string } {
  try {
    const bytes = fs.readFileSync(path.resolve(file));
    const actual = checksum(bytes);
    if (expectedSha256 && normalizeChecksum(expectedSha256) !== actual) {
      return {
        ok: false,
        bytes: bytes.length,
        sha256: actual,
        error: `SHA-256 не совпал: ожидался ${normalizeChecksum(expectedSha256)}, получен ${actual}`,
      };
    }
    return { ok: true, bytes: bytes.length, sha256: actual };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Восстанавливает БД из файла с обязательной проверкой контрольной суммы.
 * Соединение НЕ закрывается, поэтому дашборд остаётся доступным.
 */
export function restoreDatabase(file: string, expectedSha256?: string): DbRestoreResult {
  const resolved = path.resolve(file?.trim() || "");
  if (!file?.trim()) {
    return { success: false, error: "Укажите файл бэкапа (file)" };
  }
  const verified = verifyDbBackup(resolved, expectedSha256);
  if (!verified.ok || !verified.sha256) {
    return { success: false, file: resolved, error: verified.error ?? "Контрольная сумма не подтверждена" };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-restore-"));
  const attached = path.join(tempDir, "backup.db");
  let attachedOk = false;
  let transactionOpen = false;
  try {
    const db = getDb();
    const bytes = fs.readFileSync(resolved);
    fs.writeFileSync(attached, bytes);
    db.prepare("ATTACH DATABASE ? AS restore_src").run(attached);
    attachedOk = true;

    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const mainTables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((row) => String(row.name)),
    );
    const backupTables = db
      .prepare(
        "SELECT name, sql FROM restore_src.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; sql: string | null }[];

    // Внешние ключи выключаем только на время транзакции, чтобы порядок
    // копирования таблиц не влиял на результат.
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    for (const table of backupTables) {
      const name = String(table.name);
      if (!mainTables.has(name)) {
        if (table.sql) db.exec(table.sql);
        continue;
      }
      db.exec(`DELETE FROM main.${quote(name)}`);
      db.exec(`INSERT INTO main.${quote(name)} SELECT * FROM restore_src.${quote(name)}`);
    }
    // AUTOINCREMENT: счётчики тоже часть состояния БД (если таблица есть в обоих).
    let hasSequence = false;
    try {
      const seqRow = db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence' " +
            "AND EXISTS (SELECT 1 FROM restore_src.sqlite_master WHERE name = 'sqlite_sequence')",
        )
        .get() as { n: number };
      hasSequence = Number(seqRow.n) > 0;
    } catch {
      // Без AUTOINCREMENT — нормально.
    }
    if (hasSequence) {
      db.exec("DELETE FROM main.sqlite_sequence");
      db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM restore_src.sqlite_sequence");
    }
    db.exec("COMMIT;");
    transactionOpen = false;
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("DETACH DATABASE restore_src;");
    attachedOk = false;
    checkpointDb();

    return {
      success: true,
      file: resolved,
      bytes: bytes.length,
      sha256: verified.sha256,
    };
  } catch (err) {
    if (transactionOpen) {
      try { getDb().exec("ROLLBACK;"); } catch { /* транзакции уже нет */ }
    }
    if (attachedOk) {
      try { getDb().exec("DETACH DATABASE restore_src;"); } catch { /* уже отсоединена */ }
    }
    try { getDb().exec("PRAGMA foreign_keys = ON;"); } catch { /* соединение закрыто */ }
    return { success: false, file: resolved, error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
