import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-triage-chain-"));
process.env.OPENCODE_SCHEDULER_HOME = home;
process.env.APPDATA = home;

const { decideTriage } = await import("./dist/core/triage-chain.js");
const { saveSettings } = await import("./dist/settings.js");
const { notifyTaskCompletion } = await import("./dist/notifications.js");

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

function triageSettings(baseUrl, extra = {}) {
  return {
    mode: "llm",
    baseUrl,
    model: "qwen3:4b",
    timeoutMs: 500,
    fallback: "rules",
    confidenceThreshold: 0.6,
    ...extra,
  };
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
  durationMs: 1000,
};

const skipDeploy = {
  id: "skip-deploy",
  field: "task",
  operator: "equals",
  value: "deploy",
  action: "skip",
  priority: 50,
};

// 1. Выключенный триаж не трогает доставку
check("off: уведомление отправляется", (await decideTriage(input, undefined)).action === "notify");
const off = await decideTriage(input, triageSettings("http://127.0.0.1:9", { mode: "off" }));
check("off: источник off", off.action === "notify" && off.source === "off");

// 2. Только правила
const rulesSkip = await decideTriage(input, {
  ...triageSettings("http://127.0.0.1:9", { mode: "rules" }),
  rules: [skipDeploy],
});
check("rules: правило skip подавляет", rulesSkip.action === "skip" && rulesSkip.source === "rules");
check("rules: id правила сохранён", rulesSkip.ruleId === "skip-deploy");

const rulesMiss = await decideTriage(
  { ...input, taskName: "other" },
  { ...triageSettings("http://127.0.0.1:9", { mode: "rules" }), rules: [skipDeploy] }
);
check("rules: нет совпадения = notify", rulesMiss.action === "notify" && rulesMiss.source === "rules");

// 3. Валидный LLM
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, { message: { content: JSON.stringify(verdict) } }));
  },
  async (base) => {
    const decision = await decideTriage(input, triageSettings(base));
    check("llm: уведомление отправляется", decision.action === "notify" && decision.source === "llm");
    check("llm: вердикт доступен", decision.verdict?.category === "quality");
  }
);

// 4. Битый JSON → правила
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, { message: { content: "не json" } }));
  },
  async (base) => {
    const decision = await decideTriage(input, triageSettings(base), { retryDelayMs: 0 });
    check("битый JSON: fallback в правила", decision.source === "fallback" && decision.failure === "invalid-json");
    check("битый JSON: уведомление не потеряно", decision.action === "notify");
  }
);

// 5. Низкая уверенность → правила могут подавить
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, {
      message: { content: JSON.stringify({ ...verdict, confidence: 0.2 }) },
    }));
  },
  async (base) => {
    const decision = await decideTriage(
      input,
      { ...triageSettings(base), rules: [skipDeploy] },
      { retryDelayMs: 0 }
    );
    check("низкая уверенность: low-confidence", decision.failure === "low-confidence");
    check("низкая уверенность: решают правила", decision.action === "skip" && decision.source === "fallback");
  }
);

// 6. Таймаут + fallback skip = fail-open
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      sendJson(res, 200, { message: { content: JSON.stringify(verdict) } });
    }, 300));
  },
  async (base) => {
    const decision = await decideTriage(
      input,
      triageSettings(base, { timeoutMs: 40, fallback: "skip" }),
      { retryDelayMs: 0 }
    );
    check("таймаут: failure timeout", decision.failure === "timeout");
    check("таймаут + fallback skip: notify", decision.action === "notify" && decision.source === "fallback");
  }
);

// 7. Сеть недоступна = fail-open
const dead = await decideTriage(
  input,
  triageSettings("http://127.0.0.1:9", { fallback: "skip" }),
  { retryDelayMs: 0 }
);
check("сеть недоступна: notify", dead.action === "notify" && dead.source === "fallback");
check("сеть недоступна: failure network", dead.failure === "network");

// 8. Реальная доставка при недоступном классификаторе
await withServer(
  (req, res) => {
    req.resume();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      globalThis.__webhookBody = body;
      sendJson(res, 200, { ok: true });
    });
  },
  async (webhookUrl) => {
    await saveSettings({
      notifications: {
        enabled: true,
        onlyOnError: false,
        webhook: {
          enabled: true,
          url: webhookUrl,
          timeoutMs: 2000,
          retryCount: 0,
          retryDelayMs: 0,
        },
        filters: { include: [], exclude: [] },
        triage: {
          mode: "llm",
          baseUrl: "http://127.0.0.1:9",
          model: "qwen3:4b",
          timeoutMs: 500,
          fallback: "skip",
          confidenceThreshold: 0.6,
        },
      },
    });
    globalThis.__webhookBody = "";
    await notifyTaskCompletion("deploy", "error", 1000, "boom");
    check(
      "доставка: webhook получен при мёртвом классификаторе",
      typeof globalThis.__webhookBody === "string" && globalThis.__webhookBody.includes("deploy")
    );
  }
);

// 9. Правило skip реально подавляет доставку (shadow выключен — иначе уведомление уходит)
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => {
      globalThis.__webhookBody = "received";
      sendJson(res, 200, { ok: true });
    });
  },
  async (webhookUrl) => {
    await saveSettings({
      notifications: {
        enabled: true,
        onlyOnError: false,
        webhook: {
          enabled: true,
          url: webhookUrl,
          timeoutMs: 2000,
          retryCount: 0,
          retryDelayMs: 0,
        },
        filters: { include: [], exclude: [] },
        triage: {
          mode: "rules",
          baseUrl: "http://127.0.0.1:9",
          model: "qwen3:4b",
          timeoutMs: 500,
          fallback: "rules",
          confidenceThreshold: 0.6,
          rules: [skipDeploy],
          shadow: { enabled: false, days: 14, startedAt: null },
        },
      },
    });
    globalThis.__webhookBody = "";
    await notifyTaskCompletion("deploy", "error", 1000, "boom");
    await new Promise((resolve) => setTimeout(resolve, 100));
    check("подавление: webhook не отправлен", globalThis.__webhookBody === "");
  }
);

// 10. auto ведёт себя как llm
await withServer(
  (req, res) => {
    req.resume();
    req.on("end", () => sendJson(res, 200, { message: { content: JSON.stringify(verdict) } }));
  },
  async (base) => {
    const decision = await decideTriage(input, triageSettings(base, { mode: "auto" }));
    check("auto: источник llm", decision.action === "notify" && decision.source === "llm");
  }
);

console.log(`\nTriage chain: ${passed}/${passed + failed} проверок пройдено.`);
fs.rmSync(home, { recursive: true, force: true });
if (failed > 0) process.exit(1);
