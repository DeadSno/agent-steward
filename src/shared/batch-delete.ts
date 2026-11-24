/**
 * D02 (IM-2): чистая логика пакетного удаления задач.
 *
 * `delete_task` принимает одно имя (`name`) или пакет (`names`). Пакет
 * выполняется как «транзакция с частичным успехом»: перед удалением все имена
 * проходят проверку, затем каждое удаляется независимо, а результат
 * агрегируется — одна ошибка не отменяет уже удалённые задачи.
 */

export interface DeleteNameArgs {
  name?: string;
  names?: string[];
}

export interface DeleteOutcome {
  name: string;
  removed: string[];
  existed: boolean;
  error?: string;
}

export interface BatchDeleteSummary {
  success: boolean;
  deleted: string[];
  missing: string[];
  failed: { name: string; error: string }[];
  requested: number;
}

/** Приводит аргументы инструмента к уникальному списку непустых имён. */
export function resolveDeleteNames(args: DeleteNameArgs): string[] {
  const raw = [...(args.names ?? []), ...(args.name ? [args.name] : [])];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** Агрегирует исходы пакета: часть задач может быть удалена, часть — нет. */
export function summarizeBatchDelete(outcomes: DeleteOutcome[]): BatchDeleteSummary {
  const deleted: string[] = [];
  const missing: string[] = [];
  const failed: { name: string; error: string }[] = [];

  for (const outcome of outcomes) {
    if (outcome.error) {
      failed.push({ name: outcome.name, error: outcome.error });
      continue;
    }
    if (outcome.existed || outcome.removed.length > 0) {
      deleted.push(outcome.name, ...outcome.removed);
    } else {
      missing.push(outcome.name);
    }
  }

  return {
    success: failed.length === 0,
    deleted: [...new Set(deleted)],
    missing,
    failed,
    requested: outcomes.length,
  };
}
