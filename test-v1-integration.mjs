// Д5/З5.2: интеграция V1-адаптера без OpenCode CLI.
//
// V1-загрузчик вызывает `server(input)` и получает `Hooks` с `tool` и
// `dispose`. Здесь этот путь воспроизводится напрямую: тот же default export,
// тот же вызов, реальный `createRuntime` (SQLite, recovery, watchers) и
// настоящие обработчики инструментов. Проверяются только read-only
// инструменты, чтобы стенд не создавал задач в ОС.
//
// Запуск: node test-v1-integration.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Изоляция состояния: БД, логи, locks и обёртки — во временном каталоге.
process.env.OPENCODE_SCHEDULER_HOME = mkdtempSync(
  join(tmpdir(), "scheduler-v1-integration-")
);

// Отдельный порт для дашборда: иначе тест переиспользует живой дашборд
// пользователя и проверяет чужой процесс вместо своего.
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.unref();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
process.env.OPENCODE_SCHEDULER_PORT = String(freePort);

const { default: pluginModule, createToolSpecs } = await import("./dist/index.js");

const hooks = await pluginModule.server({ directory: process.cwd() });
assert.equal(typeof hooks.tool, "object", "server() вернул tool");
assert.equal(typeof hooks.dispose, "function", "server() вернул dispose");
const toolSpecCount = createToolSpecs(null).length;
assert.equal(
  Object.keys(hooks.tool).length,
  toolSpecCount,
  `V1 получает все инструменты (${toolSpecCount})`,
);

const context = {};
const call = async (name, args = {}) => {
  const result = await hooks.tool[name].execute(args, context);
  assert.equal(typeof result, "object", `${name}: результат — объект V1`);
  assert.equal(typeof result.output, "string", `${name}: output — строка`);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.success, true, `${name}: success`);
  return parsed;
};

// Три read-only инструмента: список задач, метрики и сведения о дашборде.
const listed = await call("list_tasks");
assert.ok(Array.isArray(listed.tasks), "list_tasks: tasks — массив");

const metrics = await call("get_metrics");
assert.equal(typeof metrics, "object", "get_metrics: JSON-объект");

const dashboard = await call("get_dashboard_info");
assert.equal(typeof dashboard.platform, "string", "get_dashboard_info: platform");
assert.equal(dashboard.port, freePort, "get_dashboard_info: порт тестового стенда");

await hooks.dispose();
await hooks.dispose(); // повторная выгрузка не должна бросать

console.log("test-v1-integration: все проверки пройдены");
