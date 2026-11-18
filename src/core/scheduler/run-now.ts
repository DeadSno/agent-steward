import fs from "node:fs/promises";
import { requestImmediateRun } from "../ps-wrapper.js";
import { createSchedulerBackend } from "./index.js";
import type { RunTaskResult, SchedulerBackend } from "./types.js";

/**
 * Немедленный запуск задачи в обход schedule-gate.
 *
 * Зачем: для poll-режима (расширенный cron / чужая IANA-таймзона / окно
 * запуска) обёртка всегда прогоняет schedule-gate, и запуск вне cron-окна
 * молча завершается с exit 3. Это касается не только `run_task_now`, но и
 * цепочек (nextTaskOnSuccess / nextTaskOnError), DAG-зависимостей и retry:
 * они тоже запускают задачу «сейчас», а не «по расписанию».
 *
 * Маркер `requestImmediateRun` снимает проверку расписания внутри обёртки.
 * Если планировщик не принял запуск, маркер удаляется, чтобы он не «разрешил»
 * следующий плановый тик в обход расписания.
 */
export async function runTaskNow(
  taskName: string,
  backend: SchedulerBackend = createSchedulerBackend(),
): Promise<RunTaskResult> {
  const forceFile = await requestImmediateRun(taskName);
  try {
    return await backend.runTask(taskName);
  } catch (err) {
    await fs.unlink(forceFile).catch(() => {
      /* маркер мог быть уже поглощён gate'ом или удалён по TTL */
    });
    throw err;
  }
}
