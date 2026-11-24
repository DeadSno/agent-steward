/**
 * D12 (IM-11): выборочный импорт задач и маппинг имён.
 *
 * Чистая функция: не трогает планировщик и БД, поэтому используется и
 * инструментом `transfer_tasks`, и тестами. Сохраняет DAG-связи между
 * выбранными задачами, переименовывая и зависимости, и саму задачу.
 */
import type { TaskDefinition } from "../task-transfer.js";

export interface ImportSelectionOptions {
  /** Имена задач для импорта (регистронезависимо). Без списка — все задачи. */
  names?: string[];
  /** Явное соответствие «старое имя → новое имя». */
  nameMap?: Record<string, string>;
  /** Оставлять ссылки на неимпортированные задачи (по умолчанию — удалять). */
  keepMissingDeps?: boolean;
}

export interface ImportSelectionResult {
  tasks: TaskDefinition[];
  skipped: string[];
  mapped: Record<string, string>;
  warnings: string[];
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

/** Выбирает подмножество задач и переносит маппинг имён на DAG-связи. */
export function selectImportTasks(
  tasks: readonly TaskDefinition[],
  options: ImportSelectionOptions = {},
): ImportSelectionResult {
  const selectedNames = options.names?.map((name) => key(name)).filter(Boolean);
  const selectedSet = selectedNames && selectedNames.length > 0 ? new Set(selectedNames) : null;
  const byLower = new Map<string, TaskDefinition>();
  for (const task of tasks) byLower.set(key(task.name), task);

  const explicitMap = new Map<string, string>();
  for (const [from, to] of Object.entries(options.nameMap ?? {})) {
    const trimmed = String(to).trim();
    if (from.trim() && trimmed) explicitMap.set(key(from), trimmed);
  }

  const chosen = tasks.filter((task) => !selectedSet || selectedSet.has(key(task.name)));
  const skipped = tasks.filter((task) => selectedSet && !selectedSet.has(key(task.name))).map((task) => task.name);
  const mapped: Record<string, string> = {};
  for (const task of chosen) {
    mapped[task.name] = explicitMap.get(key(task.name)) ?? task.name;
  }

  const warnings: string[] = [];
  const resolveRef = (ref: string | undefined, field: string): string | undefined => {
    if (!ref) return undefined;
    const mappedRef = explicitMap.get(key(ref)) ?? ref;
    const target = byLower.get(key(ref));
    if (!target) return options.keepMissingDeps ? mappedRef : undefined;
    if (!chosen.some((task) => key(task.name) === key(target.name))) {
      warnings.push(`${field}: зависимость «${ref}» не импортируется и удалена.`);
      return options.keepMissingDeps ? mappedRef : undefined;
    }
    return mapped[target.name] ?? mappedRef;
  };

  const result = chosen.map((task): TaskDefinition => {
    const clone: TaskDefinition = { ...task, name: mapped[task.name] };
    if (task.dependsOn) {
      const deps = task.dependsOn
        .map((dep) => resolveRef(dep, `${task.name}.dependsOn`))
        .filter((dep): dep is string => Boolean(dep));
      if (deps.length > 0) clone.dependsOn = deps;
      else delete clone.dependsOn;
    }
    for (const field of ["nextTaskOnSuccess", "nextTaskOnError", "matrixParentId"] as const) {
      const value = task[field];
      if (typeof value === "string" && value.trim()) {
        const resolved = resolveRef(value, `${task.name}.${field}`);
        if (resolved) (clone as unknown as Record<string, string>)[field] = resolved;
        else delete (clone as unknown as Record<string, unknown>)[field];
      }
    }
    return clone;
  });

  return { tasks: result, skipped, mapped, warnings };
}

/** Парсит список имён из строки CLI/GUI (`"a, b"`, `"a;b"`). */
export function parseImportNames(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  const names = value
    .split(/[;,]/)
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}
