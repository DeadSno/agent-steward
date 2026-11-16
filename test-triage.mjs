import http from "node:http";
import { classifyNotification } from "./dist/core/triage.js";

let passed = 0;
let failed = 0;

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` — ${details}` : ""}`);
  }
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function ollamaBody(verdict) {
  return { message: { role: "assistant", content: JSON.stringify(verdict) } };
}

const verdict = {
  category: "quality",
  severity: "high",
  confidence: 0.95,
  reason: "Quality Gate провален.",
};

const input = {
  taskName: "deploy",
  status: "error",
  error: "Quality Gate вернул код 1",
  durationMs: 2300,
  tokens: 1500,
  costUsd: 0.006,
};

function settingsFor(baseUrl, extra = {}) {
  return {
    mode: "llm",
    baseUrl,
    model: "qwen3:4b",
    timeoutMs: 5000,
    fallback: "rules",
    confidenceThreshold: 0.6,
    ...extra,
  };
}

// 1. Валидный ответ Ollama
await withServer(
  (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      check("Ollama: уходит format-схема", parsed.format?.required?.includes("category") === true);
      check("Ollama: temperature 0", parsed.options?.temperature === 0);
      sendJson(res, 200, ollamaBody(verdict));
    });
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base));
    check("валидный ответ: ok", result.ok === true);
    check("валидный ответ: вердикт разобран", result.verdict?.category === "quality" && result.verdict.confidence === 0.95);
    check("валидный ответ: одна попытка", result.attempts === 1);
    check("валидный ответ: протокол ollama", result.protocol === "ollama");
  }
);

// 2. Битый JSON: один retry и мягкая ошибка
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, { message: { content: "не json" } }));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base), { retryDelayMs: 0 });
    check("битый JSON: fail без исключения", result.ok === false && result.failure === "invalid-json");
    check("битый JSON: ровно две попытки", result.attempts === 2);
  }
);

// 3. Невалидная схема
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, ollamaBody({ ...verdict, category: "banana" })));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base), { retryDelayMs: 0 });
    check("невалидная схема: invalid-schema", result.ok === false && result.failure === "invalid-schema");
  }
);

await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, ollamaBody({ ...verdict, confidence: 1.5 })));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base), { retryDelayMs: 0, retries: 0 });
    check("confidence вне диапазона: invalid-schema", result.ok === false && result.failure === "invalid-schema");
  }
);

// 4. HTTP 500, затем успех — retry помогает
let attempts500 = 0;
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => {
      attempts500++;
      if (attempts500 === 1) sendJson(res, 500, { error: "boom" });
      else sendJson(res, 200, ollamaBody(verdict));
    });
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base), { retryDelayMs: 0 });
    check("HTTP 500 → retry → успех", result.ok === true && result.attempts === 2);
  }
);

// 5. HTTP 400 не повторяется
let attempts400 = 0;
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => {
      attempts400++;
      sendJson(res, 400, { error: "bad request" });
    });
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base), { retryDelayMs: 0 });
    check("HTTP 400: без повторов", result.ok === false && result.failure === "http" && result.attempts === 1 && attempts400 === 1);
  }
);

// 6. Таймаут: не блокирует вызывающего и повторяется
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 200, ollamaBody(verdict));
    }, 300));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base, { timeoutMs: 40 }), { retryDelayMs: 0 });
    check("таймаут: failure timeout", result.ok === false && result.failure === "timeout");
    check("таймаут: две попытки", result.attempts === 2);
  }
);

// 7. OpenAI-совместимый endpoint
await withServer(
  (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      check("OpenAI: путь /v1/chat/completions", req.url === "/v1/chat/completions");
      const parsed = JSON.parse(body);
      check("OpenAI: response_format json_schema", parsed.response_format?.type === "json_schema");
      check("OpenAI: strict schema включён", parsed.response_format?.json_schema?.strict === true);
      check("OpenAI: имя схемы notification_triage", parsed.response_format?.json_schema?.name === "notification_triage");
      check(
        "OpenAI: схема требует verdict-поля",
        Array.isArray(parsed.response_format?.json_schema?.schema?.required) &&
          ["category", "severity", "confidence", "reason"].every((field) =>
            parsed.response_format.json_schema.schema.required.includes(field)
          )
      );
      check("OpenAI: additionalProperties=false", parsed.response_format?.json_schema?.schema?.additionalProperties === false);
      sendJson(res, 200, { choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) } }] });
    });
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(`${base}/v1`));
    check("OpenAI: ответ разобран", result.ok === true && result.protocol === "openai" && result.verdict?.severity === "high");
  }
);

// 8. Конфиг отсутствует — сети нет
const skipped = await classifyNotification(input, undefined);
check("без настроек: disabled и 0 попыток", skipped.ok === false && skipped.failure === "disabled" && skipped.attempts === 0);

// 9. JSON в markdown-заборе принимается
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, {
      message: { content: "```json\n" + JSON.stringify(verdict) + "\n```" },
    }));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base));
    check("markdown-забор: JSON извлечён", result.ok === true && result.verdict?.reason === "Quality Gate провален.");
  }
);

// 10. Модель перечислена в результате
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, ollamaBody(verdict)));
  },
  async (base) => {
    const result = await classifyNotification(input, settingsFor(base, { model: "  custom:4b  " }));
    check("имя модели нормализовано", result.model === "custom:4b");
  }
);

console.log(`\nTriage: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exit(1);
