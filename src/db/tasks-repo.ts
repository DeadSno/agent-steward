import { getDb } from "./index.js";
import type { TaskDefinition } from "../task-transfer.js";
import { safeStringify } from "../text.js";

/**
 * Репозиторий определений задач.
 *
 * Имя задачи — первичный ключ, но сравнение идёт без учёта регистра
 * (как в старом tasks.json): пользователь может писать "Daily Report"
 * и "daily report" — это одна и та же задача.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDefinition(raw: unknown): TaskDefinition {
  const definition = { ...(isRecord(raw) ? raw : {}) } as unknown as TaskDefinition;
  // Совместимость со старым полем workdir.
  if (
    definition.workingDirectory === undefined &&
    typeof definition.workdir === "string" &&
    definition.workdir.trim()
  ) {
    definition.workingDirectory = definition.workdir.trim();
  }
  delete definition.workdir;
  return definition;
}

function rowToDefinition(row: unknown): TaskDefinition {
  const json = isRecord(row) ? row.definition_json : undefined;
  const parsed: unknown = JSON.parse(safeStringify(json));
  return normalizeDefinition(parsed);
}

/** Все определения задач (по алфавиту). */
export function listTasks(): TaskDefinition[] {
  const rows = getDb()
    .prepare("SELECT definition_json FROM tasks ORDER BY name COLLATE NOCASE ASC")
    .all();
  return rows.map(rowToDefinition);
}

/**
 * Клоны матрицы по имени родителя (без учёта регистра).
 * Используется фан-аутом, DAG-ожиданием и агрегацией результатов.
 */
export function listMatrixClones(parentName: string): TaskDefinition[] {
  const target = parentName.trim().toLowerCase();
  if (!target) return [];
  return listTasks().filter(
    (definition) =>
      typeof definition.matrixParentId === "string" &&
      definition.matrixParentId.trim().toLowerCase() === target,
  );
}

/** Определение по имени без учёта регистра. */
export function getTask(name: string): TaskDefinition | undefined {
  const row: unknown = getDb()
    .prepare(
      "SELECT definition_json FROM tasks WHERE lower(name) = lower(?) LIMIT 1",
    )
    .get(name);
  return row ? rowToDefinition(row) : undefined;
}

/**
 * Добавляет или обновляет задачу. createdAt не перезаписывается при
 * редактировании; workdir переезжает в workingDirectory.
 */
export function saveTask(definition: TaskDefinition): void {
  const instance = getDb();
  const existing: unknown = instance
    .prepare(
      "SELECT name, definition_json, created_at FROM tasks WHERE lower(name) = lower(?) LIMIT 1",
    )
    .get(definition.name);
  const existingRow = isRecord(existing) ? existing : undefined;

  let existingCreatedAt: string | undefined;
  if (existingRow) {
    try {
      const parsed: unknown = JSON.parse(safeStringify(existingRow.definition_json));
      existingCreatedAt = isRecord(parsed)
        ? (parsed.createdAt as string | undefined)
        : undefined;
    } catch {
      existingCreatedAt = undefined;
    }
  }

  const now = new Date().toISOString();
  const { workdir, ...rest } = definition;
  const workingDirectory =
    rest.workingDirectory?.trim() || workdir?.trim() || undefined;
  const createdAt =
    definition.createdAt ??
    existingCreatedAt ??
    (existingRow?.created_at != null ? safeStringify(existingRow.created_at) : undefined) ??
    now;

  const normalized: TaskDefinition = {
    ...rest,
    ...(workingDirectory !== undefined ? { workingDirectory } : {}),
    ...(Array.isArray(rest.matrix?.workspaceIds) && rest.matrix.workspaceIds.length > 0
      ? { isMatrixParent: true }
      : {}),
    createdAt,
  };
  const json = JSON.stringify(normalized);
  const matrixParentId =
    typeof normalized.matrixParentId === "string" && normalized.matrixParentId.trim()
      ? normalized.matrixParentId.trim()
      : null;
  const isMatrixParent = normalized.isMatrixParent ? 1 : 0;

  if (existingRow) {
    instance
      .prepare(
        "UPDATE tasks SET name = ?, definition_json = ?, created_at = ?, updated_at = ?, matrix_parent_id = ?, is_matrix_parent = ? WHERE name = ?",
      )
      .run(
        definition.name,
        json,
        createdAt,
        now,
        matrixParentId,
        isMatrixParent,
        safeStringify(existingRow.name),
      );
  } else {
    instance
      .prepare(
        "INSERT INTO tasks (name, definition_json, created_at, updated_at, matrix_parent_id, is_matrix_parent) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        definition.name,
        json,
        createdAt,
        now,
        matrixParentId,
        isMatrixParent,
      );
  }
}

/** Удаляет задачу по имени без учёта регистра. */
export function deleteTask(name: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM tasks WHERE lower(name) = lower(?)")
    .run(name);
  return Number(result.changes) > 0;
}

/** Количество задач (для миграции и тестов). */
export function countTasks(): number {
  const row: unknown = getDb().prepare("SELECT COUNT(*) AS count FROM tasks").get();
  return Number(isRecord(row) ? row.count : 0) || 0;
}

/**
 * Отвязывает все задачи от workspace (при удалении workspace).
 * Задачи не удаляются: workspaceId становится null.
 * Возвращает имена затронутых задач.
 */
export function clearWorkspaceAssignments(workspaceId: string): string[] {
  const affected: string[] = [];
  for (const definition of listTasks()) {
    if (definition.workspaceId !== workspaceId) continue;
    saveTask({ ...definition, workspaceId: undefined });
    affected.push(definition.name);
  }
  return affected;
}
