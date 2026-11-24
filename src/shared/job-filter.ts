/**
 * D14 (IM-13): быстрый клиентский фильтр задач в GUI.
 *
 * Чистая функция: фильтрует уже загруженный список задач без обращения к RPC,
 * поэтому результат мгновенный и не зависит от перезагрузки данных.
 */

export type JobFilterStatus =
  | "all"
  | "running"
  | "success"
  | "error"
  | "partial"
  | "skipped"
  | "idle"
  | "unknown";

export interface FilterableJob {
  name: string;
  status?: string;
}

export interface JobFilterOptions {
  /** Подстрока имени (регистронезависимо). Пусто — без фильтрации по имени. */
  query?: string;
  /** Статус задачи. `all`/пусто — без фильтрации по статусу. */
  status?: string;
}

/** Поддерживаемые значения статуса для выпадающего списка GUI. */
export const JOB_FILTER_STATUSES: readonly JobFilterStatus[] = [
  "all",
  "running",
  "success",
  "error",
  "partial",
  "skipped",
  "idle",
  "unknown",
];

/** Возвращает true, если фильтр активен (есть осмысленный запрос/статус). */
export function isJobFilterActive(options: JobFilterOptions): boolean {
  return Boolean(options.query?.trim()) || Boolean(options.status && options.status !== "all");
}

/** Применяет фильтр по имени и статусу, сохраняя исходный порядок. */
export function filterJobs<T extends FilterableJob>(
  jobs: readonly T[],
  options: JobFilterOptions = {},
): T[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const status = options.status && options.status !== "all" ? options.status : "";
  if (!query && !status) return [...jobs];
  return jobs.filter((job) => {
    if (query && !job.name.toLowerCase().includes(query)) return false;
    if (status && (job.status ?? "unknown") !== status) return false;
    return true;
  });
}
