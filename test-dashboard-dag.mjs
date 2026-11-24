import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestHome, removeTestHome } from "./scripts/test-home.mjs";

// Изолируем PLUGIN_DIR: server.ts/history.ts читают %APPDATA% при импорте.
const { root: tempRoot, appData, pluginDir } = await createTestHome("scheduler-dashboard-dag-");

const historySeed = [
  {
    taskName: "Тесты",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:10.000Z",
    durationMs: 10000,
    tokens: 1500,
    costUsd: 0.006,
  },
  {
    taskName: "Линтер",
    status: "success",
    startedAt: "2026-01-01T00:01:00.000Z",
    finishedAt: "2026-01-01T00:01:10.000Z",
    durationMs: 10000,
    tokens: 2000,
  },
];
await fs.writeFile(
  path.join(pluginDir, "history.json"),
  JSON.stringify(historySeed, null, 2),
  "utf8"
);

process.env.APPDATA = appData;
process.env.OPENCODE_SCHEDULER_HOME = path.join(appData, "opencode", "windows-scheduler");

// Спринт 12: дашборд читает SQLite. Переносим тестовый history.json в БД
// той же миграцией, что и при реальном обновлении плагина.
const { initDb } = await import("./dist/db/index.js");
const { migrateJsonToDb } = await import("./dist/db/migrate.js");
initDb();
await migrateJsonToDb();

const { startDashboardServer, closeDashboardServer } = await import("./dist/server.js");

const deps = {
  getTasks: async () => [
    { name: "Тесты", schedule: "0 9 * * *", status: "success", nextRun: null, dependsOn: [] },
    {
      name: "Линтер",
      schedule: "0 9 * * *",
      status: "success",
      nextRun: null,
      dependsOn: [],
    },
    {
      name: "Деплой",
      schedule: "0 10 * * *",
      status: "success",
      nextRun: null,
      dependsOn: ["Тесты", "Линтер"],
    },
  ],
  runTask: async () => ({ alreadyRunning: false }),
  deleteTask: async () => {},
};

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    throw err;
  }
}

// Уникальный диапазон портов: test-dashboard-xss.mjs одновременно занимает
// 4320/4321 при параллельном прогоне (test:parallel).
const started = await startDashboardServer(deps, { preferred: 4322, fallback: 4323 });
assert.ok(started, "сервер не стартовал");
const base = `http://127.0.0.1:${started.port}`;

try {
  const page = await (await fetch(base + "/")).text();
  // Дашборд локализуется (RU/EN, zh/tr → EN), принимаем оба варианта.
  ok("HTML: карточка «Всего токенов»", () => assert.ok(
    page.includes("Всего токенов") || page.includes("Total tokens")));
  ok("HTML: карточка «Примерная стоимость»", () => assert.ok(
    page.includes("Примерная стоимость") || page.includes("Estimated cost")));
  ok("HTML: колонка «Зависимости»", () => assert.ok(
    page.includes('<th scope="col">Зависимости</th>') ||
      page.includes('<th scope="col">Dependencies</th>')));
  ok("HTML: есть отрисовка графа DAG", () => assert.ok(page.includes("function renderGraph")));
  ok("HTML: подсказка о критическом пути", () => assert.ok(
    page.includes("Критический путь выделен оранжевым") ||
      page.includes("critical path is highlighted")));
  ok("JS: вычисление критического пути по зависимостям", () => assert.ok(
    page.includes("var critical = {}") &&
      page.includes("critical[endKey] = true") &&
      page.includes("levels[candidate] === currentLevel - 1")));
  ok("JS: подсветка узлов и рёбер критического пути", () => assert.ok(
    page.includes("criticalg") && page.includes("★ критический путь") &&
      page.includes("isCriticalEdge")));

  const tasks = await (await fetch(base + "/api/tasks")).json();
  ok("API: dependsOn задачи отдаётся в /api/tasks", () => {
    const deploy = tasks.tasks.find((t) => t.name === "Деплой");
    assert.deepEqual(deploy.dependsOn, ["Тесты", "Линтер"]);
  });

  const metrics = await (await fetch(base + "/api/metrics")).json();
  ok("API: токены суммируются по истории из SQLite", () => assert.equal(metrics.tokens, 3500));
  ok("API: стоимость = явная + оценка по токенам", () => {
    assert.ok(Math.abs(metrics.costUsd - 0.012) < 1e-9, `costUsd=${metrics.costUsd}`);
  });
} finally {
  await closeDashboardServer();
  // Закрываем SQLite до удаления временной папки (Windows блокирует файл).
  const { closeDb } = await import("./dist/db/index.js");
  closeDb();
  await removeTestHome(tempRoot);
}

console.log(`\n${passed}/${passed} проверок дашборда (DAG + стоимость) прошли.`);
