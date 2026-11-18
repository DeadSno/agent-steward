/**
 * Тесты P3-30: конфигурируемость цен моделей и what-if моделей.
 * Запуск: node test-models-config.mjs (после npm run build).
 * Цены и what-if модели читаются из env:
 *   OPENCODE_SCHEDULER_MODEL_PRICES (JSON)
 *   OPENCODE_SCHEDULER_WHAT_IF_MODELS (JSON массив)
 */
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

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

function runWithEnv(env, script) {
  return spawnSync(
    process.execPath,
    ["-e", script],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

// --- 1. Дефолтные цены (без env переопределения) ---------------------------
const r1 = runWithEnv(
  {},
  `import { modelPrice } from "./dist/server.js";` +
    `console.log(JSON.stringify({` +
    `  gpt4o: modelPrice("openai/gpt-4o"),` +
    `  deepseek: modelPrice("deepseek/deepseek-coder"),` +
    `  gpt4oMini: modelPrice("openai/gpt-4o-mini"),` +
    `  claude: modelPrice("anthropic/claude-3-5-sonnet"),` +
    `  geminiPro: modelPrice("google/gemini-2.5-pro"),` +
    `  geminiFlash: modelPrice("google/gemini-2.0-flash"),` +
    `  unknown: modelPrice("unknown-model"),` +
    `  undefined: modelPrice(undefined)` +
    `}));`,
);
const d1 = JSON.parse(r1.stdout);
check("default: gpt-4o = 10", d1.gpt4o === 10);
check("default: deepseek-coder = 0.28", d1.deepseek === 0.28);
check("default: gpt-4o-mini = 0.6", d1.gpt4oMini === 0.6);
check("default: claude-3-5-sonnet = 9", d1.claude === 9);
check("default: gemini-2.5-pro = 3.5", d1.geminiPro === 3.5);
check("default: gemini-2.0-flash = 0.3", d1.geminiFlash === 0.3);
check("default: unknown = 3 (DEFAULT_PRICE_PER_MILLION)", d1.unknown === 3);
check("default: undefined = 3", d1.undefined === 3);

// --- 2. Переопределение цен через env --------------------------------------
const r2 = runWithEnv(
  {
    OPENCODE_SCHEDULER_MODEL_PRICES: JSON.stringify({
      "openai/gpt-4o": 2.5,
      "custom/model": 7.77,
    }),
  },
  `import { modelPrice } from "./dist/server.js";` +
    `console.log(JSON.stringify({` +
    `  gpt4o: modelPrice("openai/gpt-4o"),` +
    `  custom: modelPrice("custom/model"),` +
    `  claude: modelPrice("anthropic/claude-3-5-sonnet")` +
    `}));`,
);
const d2 = JSON.parse(r2.stdout);
check("env: gpt-4o = 2.5 (переопределено)", d2.gpt4o === 2.5);
check("env: custom/model = 7.77 (новая модель)", d2.custom === 7.77);
check("env: claude = 9 (дефолт без изменений)", d2.claude === 9);

// --- 3. What-if модели через env -------------------------------------------
const r3 = runWithEnv(
  {
    OPENCODE_SCHEDULER_WHAT_IF_MODELS: JSON.stringify([
      "anthropic/claude-3-5-sonnet",
      "google/gemini-2.5-pro",
    ]),
  },
  `import { aggregateModels } from "./dist/server.js";` +
    `const h = [{model:"openai/gpt-4o",tokens:1000000,costUsd:0,status:"success",durationMs:1000}];` +
    `const r = aggregateModels(h);` +
    `console.log(JSON.stringify({` +
    `  models: r.whatIf.map(w => w.model),` +
    `  count: r.whatIf.length` +
    `}));`,
);
const d3 = JSON.parse(r3.stdout);
check("env: whatIf contains claude", d3.models.includes("anthropic/claude-3-5-sonnet"));
check("env: whatIf contains gemini", d3.models.includes("google/gemini-2.5-pro"));
check("env: whatIf does NOT contain gpt-4o", !d3.models.includes("openai/gpt-4o"));
check("env: whatIf length = 2", d3.count === 2);

// --- 4. Невалидный JSON в env — фолбэк на дефолты --------------------------
const r4 = runWithEnv(
  { OPENCODE_SCHEDULER_MODEL_PRICES: "{not json" },
  `import { modelPrice } from "./dist/server.js";` +
    `console.log(JSON.stringify({ gpt4o: modelPrice("openai/gpt-4o") }));`,
);
const d4 = JSON.parse(r4.stdout);
check("invalid json: gpt-4o = 10 (фолбэк на дефолт)", d4.gpt4o === 10);

// --- 5. aggregateModels считает стоимость по ценам -------------------------
const r5 = runWithEnv(
  {},
  `import { aggregateModels } from "./dist/server.js";` +
    `const h = [{model:"openai/gpt-4o",tokens:1000000,costUsd:0,status:"success",durationMs:1000}];` +
    `const r = aggregateModels(h);` +
    `console.log(JSON.stringify({` +
    `  totalCost: r.totals.totalCost,` +
    `  whatIfGpt4o: r.whatIf.find(w => w.model === "openai/gpt-4o")?.cost` +
    `}));`,
);
const d5 = JSON.parse(r5.stdout);
// 1M токенов * 10 $/1M = $10
check("calc: gpt-4o 1M токенов = $10", Math.abs(d5.totalCost - 10) < 0.0001);
check("calc: whatIf gpt-4o cost = $10", Math.abs(d5.whatIfGpt4o - 10) < 0.0001);

console.log(`\n${passed}/${results.length} проверок конфигурируемости моделей пройдены.`);
process.exit(failed > 0 ? 1 : 0);
