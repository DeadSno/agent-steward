/**
 * Спайк structured output локальной модели через Ollama.
 *
 * Запуск:
 *   node scripts/spike-local-structured.mjs --model qwen3:4b --runs 10
 *
 * Скрипт не входит в `npm test`: он требует запущенную Ollama и скачанную
 * модель. Цель — получить воспроизводимый ответ на вопрос, можно ли доверять
 * JSON 4B-модели без retry. Результат печатается в stdout и, если указан
 * `--out`, сохраняется в JSON.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:4b",
  runs: 10,
  timeoutMs: 60000,
  out: "",
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--base-url") args.baseUrl = value;
    else if (key === "--model") args.model = value;
    else if (key === "--runs") args.runs = Number(value);
    else if (key === "--timeout") args.timeoutMs = Number(value);
    else if (key === "--out") args.out = value;
    else if (key === "--help" || key === "-h") {
      console.log("node scripts/spike-local-structured.mjs [--model qwen3:4b] [--runs 10] [--base-url URL] [--timeout MS] [--out FILE]");
      process.exit(0);
    } else {
      console.error(`Неизвестный аргумент: ${key}`);
      process.exit(2);
    }
    i += 1;
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 100) {
    console.error("--runs должен быть целым числом от 1 до 100.");
    process.exit(2);
  }
  return args;
}

const schema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["quality", "timeout", "permission", "network", "unknown"] },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["category", "severity", "confidence", "reason"],
};

const prompt = `Ты классифицируешь уведомление планировщика задач.
Верни только JSON без markdown и пояснений по схеме:
{"category":"quality|timeout|permission|network|unknown","severity":"low|medium|high","confidence":0..1,"reason":"кратко"}

Уведомление:
Задача "nightly-tests" упала за 2.3s. Quality Gate вернул код 1: 3 теста не прошли в auth-модуле.`;

function validate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "not an object";
  for (const key of schema.required) {
    if (!(key in value)) return `missing ${key}`;
  }
  if (!schema.properties.category.enum.includes(value.category)) return "bad category";
  if (!schema.properties.severity.enum.includes(value.severity)) return "bad severity";
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) return "bad confidence";
  if (typeof value.reason !== "string" || value.reason.trim() === "") return "bad reason";
  return "";
}

async function loadModel(baseUrl, model) {
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`/api/tags: HTTP ${response.status}`);
  const data = await response.json();
  const names = (data.models ?? []).map((item) => item.name);
  if (names.length === 0) throw new Error("Ollama запущена, но моделей нет: выполните ollama pull " + model);
  if (!names.some((name) => name === model || name === `${model}:latest`)) {
    throw new Error(`Модель "${model}" не найдена. Доступны: ${names.join(", ")}`);
  }
}

async function runOnce(args, index) {
  const started = Date.now();
  const body = {
    model: args.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    format: schema,
    options: { temperature: 0, seed: index + 1 },
  };
  const response = await fetch(`${args.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    return { run: index + 1, ok: false, jsonValid: false, schemaValid: false, latencyMs, error: `HTTP ${response.status}` };
  }
  const data = await response.json();
  const content = data?.message?.content ?? "";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { run: index + 1, ok: false, jsonValid: false, schemaValid: false, latencyMs, content, error: "invalid JSON" };
  }
  const error = validate(parsed);
  return {
    run: index + 1,
    ok: !error,
    jsonValid: true,
    schemaValid: !error,
    latencyMs,
    content,
    parsed,
    error,
  };
}

const args = parseArgs(process.argv.slice(2));

try {
  await loadModel(args.baseUrl, args.model);
} catch (error) {
  console.error(`Не удалось подключиться к Ollama: ${error.message}`);
  console.error("Спайк заблокирован: установите Ollama, выполните `ollama serve` и `ollama pull " + args.model + "`.");
  process.exit(2);
}

const results = [];
for (let i = 0; i < args.runs; i += 1) {
  const result = await runOnce(args, i);
  results.push(result);
  const mark = result.schemaValid ? "OK" : "FAIL";
  console.log(`${result.run}/${args.runs} ${mark} ${result.latencyMs}ms${result.error ? ` — ${result.error}` : ""}`);
}

const jsonValid = results.filter((item) => item.jsonValid).length;
const schemaValid = results.filter((item) => item.schemaValid).length;
const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
const avg = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)];

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: args.baseUrl,
  model: args.model,
  runs: args.runs,
  jsonValid,
  schemaValid,
  schemaValidRate: Number((schemaValid / args.runs).toFixed(2)),
  avgLatencyMs: avg,
  p95LatencyMs: p95,
  results,
};

console.log("");
console.log(`Модель: ${args.model}`);
console.log(`JSON валиден: ${jsonValid}/${args.runs}; схема: ${schemaValid}/${args.runs} (${Math.round(summary.schemaValidRate * 100)}%)`);
console.log(`Латентность: avg ${avg}ms, p95 ${p95}ms`);
if (schemaValid >= 9) console.log("Вывод: 4B можно использовать без retry, но валидацию схемы оставить.");
else if (schemaValid >= 7) console.log("Вывод: нужен ровно один retry и fallback на правила.");
else console.log("Вывод: 4B нельзя использовать для критичных вердиктов; только правила или модель крупнее.");

if (args.out) {
  const target = path.resolve(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`Результат: ${target}`);
}

process.exit(schemaValid >= 7 ? 0 : 1);
