/**
 * Бенчмарк локальной модели для триажа уведомлений (Спринт 30.8).
 *
 * Запуск:
 *   node scripts/bench-local.mjs --model qwen3:4b --runs 3
 *
 * Скрипт не входит в `npm test`: он требует запущенную Ollama и скачанную
 * модель. Цель — измерить скорость (tok/s), латентность и долю схемо-валидных
 * ответов, подобрать тир по объёму RAM и выдать версионированный JSON,
 * пригодный для краудсорсинга (`--out`).
 *
 * Без Ollama скрипт не падает молча: он печатает понятную ошибку и всё равно
 * формирует валидный JSON с `available: false`, чтобы замер можно было
 * приложить к отчёту.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCHEMA_VERSION = "1";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:4b",
  runs: 3,
  timeoutMs: 120000,
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
      console.log(
        "node scripts/bench-local.mjs [--model qwen3:4b] [--runs 3] [--base-url URL] [--timeout MS] [--out FILE]"
      );
      process.exit(0);
    } else {
      console.error(`Неизвестный аргумент: ${key}`);
      process.exit(2);
    }
    i += 1;
  }
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 50) {
    console.error("--runs должен быть целым числом от 1 до 50.");
    process.exit(2);
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1000 || args.timeoutMs > 600000) {
    console.error("--timeout должен быть целым числом от 1000 до 600000 мс.");
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

/** Тир по объёму RAM: рекомендация модели и причина выбора. */
function pickTier(ramGb) {
  if (ramGb < 8) {
    return {
      id: "rules-only",
      recommendedModel: "qwen3:0.6b",
      reason: `RAM ${ramGb} ГБ: локальная модель не помещается с запасом — работают только правила.`,
    };
  }
  if (ramGb < 15) {
    return {
      id: "light",
      recommendedModel: "qwen3:1.7b",
      reason: `RAM ${ramGb} ГБ: хватает на маленькую модель, ожидайте скромную точность.`,
    };
  }
  if (ramGb < 30) {
    return {
      id: "balanced",
      recommendedModel: "qwen3:4b",
      reason: `RAM ${ramGb} ГБ: рекомендуемый тир для триажа — qwen3:4b на CPU.`,
    };
  }
  return {
    id: "max",
    recommendedModel: "qwen3:8b",
    reason: `RAM ${ramGb} ГБ: можно позволить модель крупнее для лучшей точности.`,
  };
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function machineInfo() {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    cpu: cpus.length > 0 ? cpus[0].model.trim() : "unknown",
    cpuCount: cpus.length,
    ramGb: round(os.totalmem() / 1024 ** 3, 1),
    nodeVersion: process.version,
  };
}

async function loadModel(baseUrl, model) {
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`/api/tags: HTTP ${response.status}`);
  const data = await response.json();
  const names = (data.models ?? []).map((item) => item.name);
  if (names.length === 0) {
    throw new Error(`Ollama запущена, но моделей нет: выполните "ollama pull ${model}"`);
  }
  if (!names.some((name) => name === model || name === `${model}:latest`)) {
    throw new Error(`Модель "${model}" не найдена. Доступны: ${names.join(", ")}`);
  }
}

/** Один прогон: латентность, счётчики токенов и валидность схемы. */
async function runOnce(args, index) {
  const started = Date.now();
  const body = {
    model: args.model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    format: schema,
    options: { temperature: 0, seed: index + 1 },
  };
  let response;
  try {
    response = await fetch(`${args.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    return {
      run: index + 1,
      ok: false,
      jsonValid: false,
      schemaValid: false,
      latencyMs: Date.now() - started,
      evalCount: null,
      evalMs: null,
      tokPerSec: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    return { run: index + 1, ok: false, jsonValid: false, schemaValid: false, latencyMs, evalCount: null, evalMs: null, tokPerSec: null, error: `HTTP ${response.status}` };
  }
  const data = await response.json();
  const content = data?.message?.content ?? "";
  const evalCount = typeof data?.eval_count === "number" ? data.eval_count : null;
  const evalNs = typeof data?.eval_duration === "number" ? data.eval_duration : null;
  const evalMs = evalNs !== null ? Math.round(evalNs / 1e6) : null;
  const tokPerSec = evalCount !== null && evalNs !== null && evalNs > 0 ? (evalCount / evalNs) * 1e9 : null;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { run: index + 1, ok: false, jsonValid: false, schemaValid: false, latencyMs, evalCount, evalMs, tokPerSec, content, error: "invalid JSON" };
  }
  const error = validate(parsed);
  return {
    run: index + 1,
    ok: !error,
    jsonValid: true,
    schemaValid: !error,
    latencyMs,
    evalCount,
    evalMs,
    tokPerSec: round(tokPerSec),
    content,
    parsed,
    error,
  };
}

function buildReport({ args, machine, tier, available, error, results }) {
  const completed = results.filter((item) => item.schemaValid);
  const validRuns = results.filter((item) => item.jsonValid);
  const latencies = results.map((item) => item.latencyMs).sort((a, b) => a - b);
  const throughput = results
    .map((item) => item.tokPerSec)
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  const avg = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    available,
    error: error ?? null,
    machine,
    tier,
    baseUrl: args.baseUrl,
    model: args.model,
    runs: args.runs,
    metrics: {
      schemaValid: completed.length,
      schemaValidRate: results.length === 0 ? 0 : round(completed.length / results.length, 2),
      jsonValid: validRuns.length,
      jsonValidRate: results.length === 0 ? 0 : round(validRuns.length / results.length, 2),
      avgLatencyMs: latencies.length === 0 ? null : Math.round(avg(latencies)),
      p95LatencyMs: percentile(latencies, 0.95),
      avgTokPerSec: throughput.length === 0 ? null : round(avg(throughput), 1),
      p95TokPerSec: percentile(throughput, 0.95) === null ? null : round(percentile(throughput, 0.95), 1),
    },
    notes: [
      "tok/s считается по eval_count / eval_duration из ответа Ollama /api/chat.",
      "Тир подобран по объёму RAM; модель можно переопределить флагом --model.",
      "Формат версионирован (schemaVersion) для краудсорсинга замеров.",
    ],
    results,
  };
}

const args = parseArgs(process.argv.slice(2));
const machine = machineInfo();
const tier = pickTier(machine.ramGb);

let available = true;
let availabilityError = null;
try {
  await loadModel(args.baseUrl, args.model);
} catch (error) {
  available = false;
  availabilityError = error instanceof Error ? error.message : String(error);
  console.error(`Не удалось подключиться к Ollama: ${availabilityError}`);
  console.error(`Бенчмарк заблокирован: установите Ollama, выполните "ollama serve" и "ollama pull ${args.model}".`);
}

const results = [];
if (available) {
  for (let i = 0; i < args.runs; i += 1) {
    const result = await runOnce(args, i);
    results.push(result);
    const mark = result.schemaValid ? "OK" : "FAIL";
    console.log(
      `${result.run}/${args.runs} ${mark} ${result.latencyMs}ms${result.tokPerSec ? ` ${result.tokPerSec} tok/s` : ""}${result.error ? ` — ${result.error}` : ""}`
    );
  }
}

const report = buildReport({ args, machine, tier, available, error: availabilityError, results });

console.log("");
console.log(`Машина: ${machine.cpu} × ${machine.cpuCount}, ${machine.ramGb} ГБ RAM, ${machine.platform}/${machine.arch}`);
console.log(`Тир: ${tier.id} → рекомендуется ${tier.recommendedModel}`);
console.log(tier.reason);
if (available) {
  console.log(
    `Схема: ${report.metrics.schemaValid}/${args.runs} (${Math.round(report.metrics.schemaValidRate * 100)}%); JSON: ${report.metrics.jsonValid}/${args.runs}`
  );
  const speed = report.metrics.avgTokPerSec === null ? "n/a" : `${report.metrics.avgTokPerSec} tok/s`;
  console.log(`Латентность: avg ${report.metrics.avgLatencyMs}ms, p95 ${report.metrics.p95LatencyMs}ms; скорость: ${speed}`);
  if (report.metrics.schemaValidRate >= 0.9) {
    console.log("Вывод: модель подходит для триажа, валидацию схемы всё равно оставить.");
  } else if (report.metrics.schemaValidRate >= 0.7) {
    console.log("Вывод: нужен один retry и fallback на правила.");
  } else {
    console.log("Вывод: модель не подходит для критичных вердиктов — только правила или модель крупнее.");
  }
} else {
  console.log("Вывод: замер не выполнен, JSON всё равно сформирован для отчёта.");
}

if (args.out) {
  const target = path.resolve(args.out);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Результат: ${target}`);
} else {
  console.log("");
  console.log(JSON.stringify(report, null, 2));
}

if (!available) process.exit(2);
process.exit(report.metrics.schemaValidRate >= 0.7 ? 0 : 1);
