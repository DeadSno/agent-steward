/**
 * D10 (IM-9): экспорт журнала аудита в CSV.
 *
 * Чистый модуль без зависимостей от OpenCode/БД — используется и инструментом
 * `get_audit_log` (режим `format: "csv"`), и клиентской кнопкой экспорта GUI.
 */

/** Строка аудита в том виде, в каком её отдаёт `readAuditLog()`. */
export interface AuditCsvRecord {
  id?: number;
  ts?: string;
  action?: string;
  targetType?: string | null;
  target?: string | null;
  actor?: string;
  source?: string | null;
  details?: unknown;
  remote?: string | null;
}

export const AUDIT_EXPORT_COLUMNS = [
  "timestamp",
  "action",
  "targetType",
  "target",
  "actor",
  "source",
  "remote",
  "details",
] as const;

/** Экранирует ячейку CSV; формулы (`=`, `+`, `-`, `@`) нейтрализуются. */
export function escapeCsvCell(value: unknown): string {
  let text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Маскирует похожие на секреты значения в деталях записи. Вынесено в общий
 * модуль, чтобы CSV из GUI и из инструмента маскировали одинаково.
 */
export function maskAuditDetails(details: unknown): string {
  const text =
    typeof details === "string" ? details : details == null ? "" : JSON.stringify(details);
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ****")
    .replace(
      /(token|secret|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?[^"',;\s]+/gi,
      "$1: ****"
    );
}

/** Собирает CSV с BOM и CRLF — готов к открытию в Excel. */
export function formatAuditCsv(records: readonly AuditCsvRecord[]): string {
  const header = (AUDIT_EXPORT_COLUMNS as readonly string[]).map(escapeCsvCell).join(",");
  const rows = records.map((record) =>
    [
      record.ts ?? "",
      record.action ?? "",
      record.targetType ?? "",
      record.target ?? "",
      record.actor ?? "",
      record.source ?? "",
      record.remote ?? "",
      maskAuditDetails(record.details),
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  return `\uFEFF${[header, ...rows].join("\r\n")}\r\n`;
}

/** Возвращает имя файла вида `audit-2026-11-24.csv`. */
export function buildAuditFilename(now: Date = new Date()): string {
  return `audit-${now.toISOString().slice(0, 10)}.csv`;
}
