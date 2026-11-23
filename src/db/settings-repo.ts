import { getDb } from "./index.js";
import { safeStringify } from "../text.js";

/**
 * Key-value настройки в SQLite (таблица settings).
 * Используются для состояния повторов (retry_state) и будущих настроек.
 */

export function getSetting<T>(key: string, fallback: T): T {
  const row: unknown = getDb()
    .prepare("SELECT value_json FROM settings WHERE key = ? LIMIT 1")
    .get(key);
  if (typeof row !== "object" || row === null) return fallback;
  try {
    return JSON.parse(safeStringify((row as { value_json?: unknown }).value_json)) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value_json) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(key, JSON.stringify(value));
}

export function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/**
 * Атомарно уменьшает целочисленный счётчик в settings.
 *
 * P2-30: раньше retry_state был одним JSON-объектом, который читали и
 * перезаписывали целиком разные процессы record-history. При параллельных
 * завершениях задач декременты терялись. Здесь счётчик живёт отдельной
 * строкой, а уменьшение делает один UPDATE — гонки между процессами нет.
 *
 * Возвращает новое значение или null, если счётчик уже исчерпан.
 */
export function decrementCounterSetting(key: string, initial: number): number | null {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).run(key, JSON.stringify(Math.max(0, Math.floor(initial))));

  const row: unknown = db
    .prepare(
      `UPDATE settings
          SET value_json = CAST(CAST(value_json AS INTEGER) - 1 AS TEXT)
        WHERE key = ?
          AND CAST(value_json AS INTEGER) > 0
        RETURNING CAST(value_json AS INTEGER) AS value`,
    )
    .get(key);

  if (typeof row !== "object" || row === null) return null;
  return Number((row as { value?: unknown }).value);
}
