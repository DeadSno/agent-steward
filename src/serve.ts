/**
 * P-5.1 — standalone dashboard: `agent-steward serve` без OpenCode.
 *
 * Переиспользует SQLite и HTTP-сервер плагина, но не загружает V1/V2-адаптер.
 * Обратная совместимость: конфиг, порт и формат данных те же, что у дашборда
 * внутри OpenCode.
 */
import { initDb } from "./db/index.js";
import { listTasks } from "./db/tasks-repo.js";
import { requestImmediateRun } from "./core/ps-wrapper.js";
import { getSchedulerBackend } from "./core/scheduler/index.js";
import { startDashboardServer, type DashboardDeps } from "./server.js";

export interface ServeOptions {
  port?: number;
}

function parsePort(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index < 0) return undefined;
  const raw = argv[index + 1];
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export function dashboardDeps(): DashboardDeps {
  return {
    getTasks: async () => listTasks().map((task) => ({
      name: task.name,
      schedule: task.schedule,
      status: task.paused ? "paused" : "enabled",
      nextRun: task.runAt ?? null,
      triggerType: task.triggerType,
      watchPath: task.watchPath ?? null,
      model: task.model ?? null,
      priority: task.priority ?? null,
      dependsOn: task.dependsOn ?? null,
      workspaceId: task.workspaceId ?? null,
      matrix: task.matrix ?? null,
      harness: task.harness,
    })),
    runTask: async (name: string) => {
      await requestImmediateRun(name);
      return {};
    },
    deleteTask: async (name: string) => {
      await getSchedulerBackend().deleteTask(name);
    },
  };
}

/** Запуск дашборда; process остаётся жив, пока слушает HTTP-сервер. */
export async function startStandaloneDashboard(argv: string[] = []): Promise<{ port: number } | null> {
  initDb();
  const port = parsePort(argv);
  const result = await startDashboardServer(dashboardDeps(), port ? { preferred: port, fallback: port } : undefined);
  console.log(`[agent-steward] serve: дашборд доступен${result ? ` на http://localhost:${result.port}` : ""}`);
  return result;
}
