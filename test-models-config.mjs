/**
 * Тесты P3-30 / моделей из OpenCode.
 * Запуск: node test-models-config.mjs (после npm run build).
 *
 * Проверяем:
 *  1. Чистые функции: разбор каталога models.dev, разбор `opencode models`,
 *     правило выбора What-If моделей (история + по одной модели на цену).
 *  2. Поведение с окружением (в отдельных процессах):
 *     OPENCODE_SCHEDULER_MODEL_SOURCE=static, OPENCODE_SCHEDULER_MODELS_CACHE,
 *     OPENCODE_SCHEDULER_MODEL_PRICES, OPENCODE_SCHEDULER_WHAT_IF_MODELS.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_WHAT_IF_MODELS,
  MAX_WHAT_IF_MODELS,
  catalogPricePerMillion,
  findModelsCacheFile,
  parseModelList,
  parseModelsCatalog,
  selectWhatIfModels,
} from "./dist/core/opencode-models.js";

const results = [];
let passed = 0;
let failed = 0;
function check(name, cond) {
  const ok = !!cond;
  results.push({ name, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

// --- 1. Каталог цен models.dev -----------------------------------------------
const catalog = parseModelsCatalog(
  JSON.stringify({
    openai: {
      models: {
        "gpt-4o": { cost: { input: 2.5, output: 10 } },
        "no-cost": { id: "no-cost" },
      },
    },
    deepseek: { models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6 } } } },
    broken: "не объект",
  }),
);
check("каталог: разобран openai/gpt-4o", catalog.get("openai/gpt-4o")?.input === 2.5);
check("каталог: разобран deepseek/deepseek-flash", catalog.get("deepseek/deepseek-flash")?.output === 0.6);
check("каталог: модель без cost пропущена", !catalog.has("openai/no-cost"));
check("каталог: мусорный JSON не бросает", parseModelsCatalog("{oops").size === 0);
check("каталог: не объект не бросает", parseModelsCatalog("null").size === 0);

// --- 2. Разбор `opencode models` --------------------------------------------
const listed = parseModelList(
  "deepseek/deepseek-flash\r\n\r\n  opencode/beam-free  \r\nмусор без провайдера\nopenai/gpt-4o\nopenai/gpt-4o\n",
);
check("список: 3 уникальные модели", listed.length === 3);
check("список: пробелы обрезаны", listed.includes("opencode/beam-free"));
check("список: строки без провайдера отброшены", !listed.some((m) => m === "мусор"));
check("список: дубликаты убраны", listed.filter((m) => m === "openai/gpt-4o").length === 1);

// --- 3. Правило выбора What-If моделей --------------------------------------
const priceOf = (model) =>
  ({ "a/free": 0, "b/cheap": 0.5, "c/mid": 3, "d/expensive": 15, "e/free2": 0, "x/used": 1 })[
    model
  ] ?? null;
const available = ["e/free2", "b/cheap", "c/mid", "d/expensive", "a/free"];

const tiered = selectWhatIfModels([], available, priceOf);
check("what-if: по одной модели на цену", tiered.models.length === 4);
check("what-if: бесплатная — самое короткое имя", tiered.models[0] === "a/free");
check("what-if: цены по возрастанию", tiered.models[3] === "d/expensive");
check("what-if: источник = opencode", tiered.source === "opencode");

const withHistory = selectWhatIfModels(["x/used"], available, priceOf);
check("what-if: модель из истории первая", withHistory.models[0] === "x/used");
check("what-if: источник = history", withHistory.source === "history");

const manyHistory = selectWhatIfModels(
  ["m1/a", "m2/b", "m3/c", "m4/d", "m5/e", "m6/f"],
  available,
  priceOf,
);
check(
  "what-if: не больше MAX моделей",
  manyHistory.models.length === MAX_WHAT_IF_MODELS,
);

const empty = selectWhatIfModels([], [], priceOf);
check("what-if: пусто → значения по умолчанию", empty.source === "default");
check(
  "what-if: значения по умолчанию прежние",
  empty.models.join(",") === DEFAULT_WHAT_IF_MODELS.join(","),
);

// --- Дальше — отдельные процессы: модуль читает env при загрузке -------------
function runWithEnv(env, script) {
  const result = spawnSync(process.execPath, ["-e", script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.log(result.stdout, result.stderr);
    throw new Error(`Дочерний процесс упал: ${result.status}`);
  }
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

// Фикстура каталога: цены как в models.dev (USD за 1M токенов).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-models-"));
const fixture = path.join(tmpDir, "models.json");
fs.writeFileSync(
  fixture,
  JSON.stringify({
    openai: { models: { "gpt-4o": { cost: { input: 2.5, output: 10 } } } },
    deepseek: { models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6 } } } },
    opencode: { models: { "hy4-flash-free": { id: "hy4-flash-free" } } },
  }),
  "utf8",
);

// --- 4. static: без OpenCode, встроенная таблица ----------------------------
const staticEnv = { OPENCODE_SCHEDULER_MODEL_SOURCE: "static" };
const d1 = runWithEnv(
  staticEnv,
  `import { modelPrice } from "./dist/server.js";
   console.log(JSON.stringify({
     gpt4o: modelPrice("openai/gpt-4o"),
     deepseek: modelPrice("deepseek/deepseek-coder"),
     free: modelPrice("opencode/hy4-flash-free"),
     unknown: modelPrice("unknown-model"),
     undef: modelPrice(undefined)
   }));`,
);
check("static: gpt-4o = 10 (встроенная таблица)", d1.gpt4o === 10);
check("static: deepseek-coder = 0.28", d1.deepseek === 0.28);
check("static: неизвестная = 3", d1.unknown === 3);
check("static: undefined = 3", d1.undef === 3);

const d2 = runWithEnv(
  staticEnv,
  `import { aggregateModels } from "./dist/server.js";
   const r = aggregateModels([]);
   console.log(JSON.stringify({ source: r.whatIfSource, models: r.whatIf.map(w => w.model) }));`,
);
check("static: what-if = встроенный список", d2.models.join(",") === DEFAULT_WHAT_IF_MODELS.join(","));
check("static: источник = default", d2.source === "default");

// --- 5. auto: цены из каталога OpenCode ------------------------------------
const autoEnv = { OPENCODE_SCHEDULER_MODELS_CACHE: fixture };
delete autoEnv.OPENCODE_SCHEDULER_MODEL_SOURCE;
const d3 = runWithEnv(
  autoEnv,
  `import { modelPrice } from "./dist/server.js";
   console.log(JSON.stringify({
     gpt4o: modelPrice("openai/gpt-4o"),
     flash: modelPrice("deepseek/deepseek-flash"),
     free: modelPrice("opencode/hy4-flash-free"),
     ollama: modelPrice("ollama/qwen3:4b")
   }));`,
);
check("auto: gpt-4o = 6.25 (среднее 2.5 и 10 из каталога)", d3.gpt4o === 6.25);
check("auto: deepseek-flash = 0.375", d3.flash === 0.375);
check("auto: *-free = 0", d3.free === 0);
check("auto: локальная ollama = 0", d3.ollama === 0);

const d4 = runWithEnv(
  { ...autoEnv, OPENCODE_SCHEDULER_MODEL_PRICES: JSON.stringify({ "openai/gpt-4o": 1.5 }) },
  `import { modelPrice } from "./dist/server.js";
   console.log(JSON.stringify({ gpt4o: modelPrice("openai/gpt-4o"), flash: modelPrice("deepseek/deepseek-flash") }));`,
);
check("auto: ручная цена главнее каталога", d4.gpt4o === 1.5);
check("auto: остальные цены из каталога", d4.flash === 0.375);

const d5 = runWithEnv(
  { ...autoEnv, OPENCODE_SCHEDULER_MODEL_PRICES: "{не json" },
  `import { modelPrice } from "./dist/server.js";
   console.log(JSON.stringify({ gpt4o: modelPrice("openai/gpt-4o") }));`,
);
check("auto: битый JSON цен → каталог (6.25)", d5.gpt4o === 6.25);

// --- 6. Явный список What-If из окружения ----------------------------------
const d6 = runWithEnv(
  { ...autoEnv, OPENCODE_SCHEDULER_WHAT_IF_MODELS: JSON.stringify(["deepseek/deepseek-flash"]) },
  `import { aggregateModels } from "./dist/server.js";
   const h = [{ model: "openai/gpt-4o", tokens: 1000000, costUsd: 0, status: "success", durationMs: 1000 }];
   const r = aggregateModels(h);
   console.log(JSON.stringify({ source: r.whatIfSource, whatIf: r.whatIf }));`,
);
check("env what-if: ровно указанная модель", d6.whatIf.length === 1 && d6.whatIf[0].model === "deepseek/deepseek-flash");
check("env what-if: источник = env", d6.source === "env");
check("env what-if: цена из каталога", d6.whatIf[0].pricePerMillion === 0.375);
check("env what-if: стоимость по токенам", Math.abs(d6.whatIf[0].cost - 0.375) < 1e-9);

// --- 7. Стоимость по каталогу в фактической таблице ------------------------
const d7 = runWithEnv(
  autoEnv,
  `import { aggregateModels } from "./dist/server.js";
   const h = [{ model: "openai/gpt-4o", tokens: 1000000, costUsd: 0, status: "success", durationMs: 1000 }];
   const r = aggregateModels(h);
   console.log(JSON.stringify({ totalCost: r.totals.totalCost }));`,
);
check("calc: 1M токенов gpt-4o по каталогу = $6.25", Math.abs(d7.totalCost - 6.25) < 1e-9);

// --- 8. Поиск файла каталога ----------------------------------------------
process.env.OPENCODE_SCHEDULER_MODELS_CACHE = fixture;
check("findModelsCacheFile: явный путь учитывается", findModelsCacheFile() === fixture);
process.env.OPENCODE_SCHEDULER_MODELS_CACHE = path.join(tmpDir, "нет-такого.json");
check("findModelsCacheFile: отсутствующий файл → null", findModelsCacheFile() === null);
delete process.env.OPENCODE_SCHEDULER_MODELS_CACHE;

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${passed}/${results.length} проверок моделей и цен пройдены.`);
process.exit(failed > 0 ? 1 : 0);
