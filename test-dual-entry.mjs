// Д3/З3.1: двойной экспорт — V2 читает id/setup, V1 читает server.
//
// Проверяет:
//  1. default export содержит и V2-поля (id, setup), и V1-поле (server).
//  2. V1-адаптер экспортирован и возвращает Hooks с tool/dispose.
//  3. Конвертация результата V2 → V1 сохраняет текст и metadata.
//
// Запуск: node test-dual-entry.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Полная изоляция: OPENCODE_SCHEDULER_HOME задаёт и PLUGIN_DIR (логи, locks, wrappers), и БД.
process.env.OPENCODE_SCHEDULER_HOME = mkdtempSync(
  join(tmpdir(), "scheduler-dual-entry-")
);

const { default: pluginModule, createV1Hooks, toV1ToolResult } = await import(
  "./dist/index.js"
);

// 1. Обе линии видят свои поля в одном default export.
assert.equal(pluginModule.id, "opencode-windows-scheduler", "V2 id на месте");
assert.equal(typeof pluginModule.setup, "function", "V2 setup на месте");
assert.equal(typeof pluginModule.server, "function", "V1 server на месте");
assert.equal(pluginModule.server.length, 1, "V1 server принимает PluginInput");

// 2. V1-адаптер собирает инструменты и выгрузку из общего ядра.
assert.equal(typeof createV1Hooks, "function", "createV1Hooks экспортирован");
const hooks = await createV1Hooks(
  { directory: process.cwd() },
  { startDashboard: false }
);
assert.equal(typeof hooks.tool, "object", "V1 Hooks содержат tool");
assert.ok(Object.keys(hooks.tool).length > 0, "V1 tool не пустой");
assert.equal(typeof hooks.dispose, "function", "V1 Hooks содержат dispose");
const sample = hooks.tool.schedule_task;
assert.equal(typeof sample.description, "string", "у инструмента есть описание");
assert.equal(typeof sample.args, "object", "у инструмента есть args-shape");
assert.equal(typeof sample.execute, "function", "у инструмента есть execute");
await hooks.dispose();

// 3. Результат V2 приводится к V1 без потери текста и metadata.
assert.equal(toV1ToolResult("ok"), "ok", "строка проходит как есть");
assert.deepEqual(
  toV1ToolResult({ content: '{"success":true}', metadata: { a: 1 } }),
  { output: '{"success":true}', metadata: { a: 1 } },
  "content → output"
);
assert.deepEqual(
  toV1ToolResult({
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  }),
  { output: "a\nb", metadata: undefined },
  "текстовые части склеиваются"
);
assert.deepEqual(
  toV1ToolResult({ output: "done" }),
  { output: "done", metadata: undefined },
  "output сохраняется"
);

console.log("test-dual-entry: все проверки пройдены");
