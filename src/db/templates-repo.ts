import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import type { TaskTemplate } from "../templates.js";
import { safeStringify } from "../text.js";

/** Репозиторий пользовательских шаблонов задач. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowToTemplate(row: unknown): TaskTemplate {
  const json = isRecord(row) ? row.definition_json : undefined;
  const parsed: unknown = JSON.parse(safeStringify(json));
  return parsed as TaskTemplate;
}

/** Все шаблоны (по имени). */
export function listTemplates(): TaskTemplate[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, definition_json FROM templates ORDER BY name COLLATE NOCASE ASC",
    )
    .all();
  return rows
    .map(rowToTemplate)
    .filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.prompt === "string",
    );
}

/** Шаблон по id. */
export function getTemplate(id: string): TaskTemplate | undefined {
  const row: unknown = getDb()
    .prepare("SELECT definition_json FROM templates WHERE id = ? LIMIT 1")
    .get(id);
  return row ? rowToTemplate(row) : undefined;
}

/**
 * Добавляет или обновляет шаблон. Если id не передан — генерируется uuid.
 * Пустое название — ошибка (как в старом saveTemplate).
 */
export function saveTemplate(
  template: Omit<TaskTemplate, "id"> & { id?: string },
): TaskTemplate {
  const normalized: TaskTemplate = {
    ...template,
    id: template.id?.trim() || randomUUID(),
    name: template.name.trim(),
    prompt: template.prompt,
  };

  if (!normalized.name) {
    throw new Error("Название шаблона не может быть пустым.");
  }

  getDb()
    .prepare(
      `INSERT INTO templates (id, name, definition_json)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         definition_json = excluded.definition_json`,
    )
    .run(normalized.id, normalized.name, JSON.stringify(normalized));

  return normalized;
}

/** Удаляет шаблон по id или имени (QA-P3.3). */
export function deleteTemplate(idOrName: string): void {
  getDb()
    .prepare("DELETE FROM templates WHERE id = ? OR name = ?")
    .run(idOrName, idOrName);
}

/** Количество шаблонов (для миграции и тестов). */
export function countTemplates(): number {
  const row: unknown = getDb().prepare("SELECT COUNT(*) AS count FROM templates").get();
  const count = isRecord(row) ? row.count : undefined;
  return Number(count) || 0;
}
