/**
 * Регрессия: анализ моделей не должен блокировать event loop сервера.
 *
 * Причина бага: `listAvailableModels()` вызывал `opencode models` через
 * `execFileSync`. Плагин живёт в том же процессе, что и веб-дашборд, поэтому
 * CLI переставал получать ответ от background service, запускал recovery и
 * перезапускал сервис — дашборд отдавал ERR_CONNECTION_REFUSED каждые ~10 с.
 *
 * Проверяем: агрегация моделей процесс не порождает, а `resolveWhatIfModels`
 * делает это асинхронно и ровно один раз на пачку параллельных запросов.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

delete process.env.OPENCODE_SCHEDULER_MODEL_SOURCE;
delete process.env.OPENCODE_SCHEDULER_WHAT_IF_MODELS;
delete process.env.OPENCODE_SCHEDULER_MODEL_PRICES;

const { aggregateModels } = await import("./dist/server.js");
const {
  listAvailableModels,
  resolveWhatIfModels,
  resetModelCaches,
  DEFAULT_WHAT_IF_MODELS,
} = await import("./dist/core/opencode-models.js");

const BASE_PATH = process.env.PATH ?? "";

/**
 * Подставной `opencode` в отдельном каталоге: пишет строку в свой маркер на
 * каждый запуск и печатает две модели. Отдельный каталог на проверку — чтобы
 * результаты не перемешивались.
 */
function fakeOpenCode() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-bin-"));
  const marker = path.join(dir, "called.log");

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(dir, "opencode.cmd"),
      [
        "@echo off",
        `echo called>>"${marker}"`,
        "echo openai/gpt-4o",
        "echo ollama/qwen3:4b",
        "",
      ].join("\r\n"),
    );
  } else {
    const file = path.join(dir, "opencode");
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho called >> "${marker}"\necho openai/gpt-4o\necho ollama/qwen3:4b\n`,
    );
    fs.chmodSync(file, 0o755);
  }

  process.env.PATH = `${dir}${path.delimiter}${BASE_PATH}`;

  return {
    calls() {
      if (!fs.existsSync(marker)) return 0;
      return fs
        .readFileSync(marker, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "").length;
    },
  };
}

let failed = false;

function ok(message, fn) {
  try {
    fn();
    console.log(`OK: ${message}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${message}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function okAsync(message, fn) {
  try {
    await fn();
    console.log(`OK: ${message}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${message}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// --- 1. Агрегация моделей не порождает процесс ------------------------------
const noSpawn = fakeOpenCode();
resetModelCaches();
const plain = aggregateModels([]);

ok("aggregateModels не запускает opencode models", () => {
  assert.equal(noSpawn.calls(), 0);
});

ok("без истории и без CLI — встроенный список What-If", () => {
  assert.equal(plain.whatIfSource, "default");
  assert.deepEqual(
    plain.whatIf.map((item) => item.model),
    DEFAULT_WHAT_IF_MODELS,
  );
});

// --- 2. CLI-путь стал асинхронным -------------------------------------------
await okAsync("listAvailableModels возвращает промис", async () => {
  fakeOpenCode();
  resetModelCaches();
  const result = listAvailableModels();
  assert.equal(typeof result?.then, "function");
  await result;
});

await okAsync("resolveWhatIfModels возвращает промис", async () => {
  fakeOpenCode();
  resetModelCaches();
  const result = resolveWhatIfModels([]);
  assert.equal(typeof result?.then, "function");
  await result;
});

// --- 3. Один запрос — один запуск CLI ---------------------------------------
await okAsync("resolveWhatIfModels запускает CLI и разбирает вывод", async () => {
  const fake = fakeOpenCode();
  resetModelCaches();
  const selection = await resolveWhatIfModels([]);
  assert.equal(fake.calls(), 1);
  assert.equal(selection.source, "opencode");
  assert.ok(selection.models.includes("openai/gpt-4o"));
  assert.ok(selection.models.includes("ollama/qwen3:4b"));

  // Повторный запрос берётся из кэша (10 минут).
  await resolveWhatIfModels([]);
  assert.equal(fake.calls(), 1);
});

// --- 4. Пачка параллельных запросов — один процесс --------------------------
await okAsync("три параллельных запроса дают один запуск CLI", async () => {
  const fake = fakeOpenCode();
  resetModelCaches();
  await Promise.all([
    resolveWhatIfModels([]),
    resolveWhatIfModels([]),
    resolveWhatIfModels([]),
  ]);
  assert.equal(fake.calls(), 1);
});

// --- 5. static-режим вообще не трогает OpenCode -----------------------------
await okAsync("static-режим не запускает CLI", async () => {
  const fake = fakeOpenCode();
  process.env.OPENCODE_SCHEDULER_MODEL_SOURCE = "static";
  resetModelCaches();
  const models = await listAvailableModels();
  assert.deepEqual(models, []);
  assert.equal(fake.calls(), 0);
  delete process.env.OPENCODE_SCHEDULER_MODEL_SOURCE;
});

if (!failed) {
  console.log("Models analysis: все проверки пройдены.");
}
