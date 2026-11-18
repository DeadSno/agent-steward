// Д3/З3.1: двойной экспорт — V2 читает id/setup, V1 читает server.
//
// Проверяет:
//  1. default export содержит и V2-поля (id, setup), и V1-поле (server).
//  2. V1-адаптер экспортирован и возвращает Hooks с tool/dispose.
//  3. Все инструменты замаплены в V1, схемы — raw shape, читаемые zod V1.
//  4. Конвертация результата V2 → V1 сохраняет текст и metadata.
//
// Запуск: node test-dual-entry.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Полная изоляция: OPENCODE_SCHEDULER_HOME задаёт и PLUGIN_DIR (логи, locks, wrappers), и БД.
process.env.OPENCODE_SCHEDULER_HOME = mkdtempSync(
  join(tmpdir(), "scheduler-dual-entry-")
);

const {
  default: pluginModule,
  createV1Hooks,
  createToolHandlers,
  toV1ToolResult,
} = await import("./dist/index.js");

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

// 2.1. Все инструменты V2 попали в V1 и схемы отданы как raw shape, а не как ZodObject.
const toolNames = Object.keys(hooks.tool).sort();
// З5.1: набор имён V1 совпадает с реестром, который использует V2.
const v2ToolNames = Object.keys(createToolHandlers(null)).sort();
assert.equal(toolNames.length, v2ToolNames.length, `V1 получает все инструменты (${v2ToolNames.length})`);
assert.deepEqual(toolNames, v2ToolNames, "V1 и V2 видят один набор инструментов");
for (const name of toolNames) {
  const item = hooks.tool[name];
  assert.equal(typeof item.description, "string", `${name}: описание — строка`);
  assert.ok(item.description.trim().length > 0, `${name}: описание не пустое`);
  assert.equal(typeof item.execute, "function", `${name}: execute — функция`);
  assert.ok(
    item.args && typeof item.args === "object" && !Array.isArray(item.args),
    `${name}: args — объект`
  );
  assert.ok(!("_def" in item.args), `${name}: args — raw shape, не ZodObject`);
  assert.ok(!("parse" in item.args), `${name}: args без метода parse`);
}
assert.ok("name" in sample.args, "schedule_task: args содержит name");
assert.ok("schedule" in sample.args, "schedule_task: args содержит schedule");

// 2.2. Схемы из корневого zod (4.6.7) читаются zod-копией V1 SDK (4.1.8).
// Путь к zod не хардкодим: он зависит от того, как npm разложил зависимо-
// сти (вложенная копия или hoist). Разрешаем zod из пакета V1 SDK через
// createRequire от его package.json — так тест живёт и после npm update.
const rootDir = fileURLToPath(new URL(".", import.meta.url));
const v1PluginRequire = createRequire(
  join(rootDir, "node_modules", "@opencode-ai", "plugin", "package.json")
);
const v1ZodPath = v1PluginRequire.resolve("zod");
assert.ok(existsSync(v1ZodPath), "найдена zod-копия V1 SDK");
const v1Zod = createRequire(import.meta.url)(v1ZodPath);
const v1ScheduleArgs = v1Zod.object(sample.args);
assert.equal(
  v1ScheduleArgs.safeParse({ name: "demo", prompt: "ping" }).success,
  true,
  "V1 zod принимает валидные args"
);
assert.equal(
  v1ScheduleArgs.safeParse({}).success,
  false,
  "V1 zod применяет обязательность полей"
);
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
