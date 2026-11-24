/**
 * QW-2: выбор задач для восстановления пропущенных запусков (catch-up).
 *
 * Раньше цикл жил прямо в createRuntimeCore и проверял `pausedUntil`, но не
 * `paused`. На Windows выручал schtasks (disabled-задачу нельзя запустить), а
 * на POSIX runTask спавнит bash напрямую и пауза игнорировалась — задача
 * исполнялась при каждом старте OpenCode. Вынесено в чистую функцию, чтобы
 * поведение паузы проверялось регрессией без поднятия всего runtime.
 */
import type { HistoryRecord } from "../history.js";
import type { TaskDefinition } from "../task-transfer.js";
import { prevRun } from "./schedule-v2.js";

/** Пропуск считается «пропущенным», если прошло больше 5 минут. */
export const CATCH_UP_THRESHOLD_MS = 5 * 60 * 1000;

export interface CatchUpCandidate {
  definition: TaskDefinition;
  /** Предполагаемое время последнего запуска по расписанию. */
  previousRun: Date;
  /** Сколько миллисекунд прошло с previousRun до now. */
  ageMs: number;
}

/**
 * Возвращает cron-задачи, которые нужно восстановить, в порядке приоритета
 * (10 — первым). Задачи на паузе (`paused` или `pausedUntil`) не попадают в
 * выборку: их включит пользователь или авто-продолжение, а не старт плагина.
 */
export function selectCatchUpTasks(
  definitions: TaskDefinition[],
  history: Pick<HistoryRecord, "taskName" | "startedAt">[],
  now: Date = new Date(),
  thresholdMs: number = CATCH_UP_THRESHOLD_MS,
): CatchUpCandidate[] {
  const prioritized = [...definitions].sort(
    (a, b) => (normalizePriorityValue(b.priority) ?? 5) - (normalizePriorityValue(a.priority) ?? 5),
  );
  const selected: CatchUpCandidate[] = [];

  for (const definition of prioritized) {
    // Catch-up имеет смысл только для cron-задач.
    if ((definition.triggerType ?? "cron") !== "cron") continue;
    if (!definition.schedule) continue;
    // QW-2: пауза — это явный запрет запуска, а не «пропущенный тик».
    if (definition.paused) continue;
    // Задача на паузе до даты — её включит авто-продолжение.
    if (definition.pausedUntil) continue;

    const previousRun = prevRun(definition.schedule, now, definition.timezone);
    if (!previousRun) continue;
    const ageMs = now.getTime() - previousRun.getTime();
    if (ageMs < thresholdMs) continue;

    // Есть ли запись в истории после предполагаемого времени запуска?
    const ranAfter = history.some(
      (record) =>
        record.taskName.toLowerCase() === definition.name.toLowerCase() &&
        new Date(record.startedAt).getTime() >= previousRun.getTime(),
    );
    if (ranAfter) continue;

    selected.push({ definition, previousRun, ageMs });
  }

  return selected;
}

/** Локальная копия normalizePriority (floor, 0..10) без импорта тяжёлого task-transfer. */
function normalizePriorityValue(priority: number | undefined): number | undefined {
  if (typeof priority !== "number" || !Number.isFinite(priority)) return undefined;
  return Math.max(0, Math.min(10, Math.floor(priority)));
}
