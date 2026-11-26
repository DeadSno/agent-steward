/**
 * Тесты 31.3: трёхстрочное саммари уведомлений.
 * Запуск: node test-notifications-summary.mjs (после npm run build).
 * Локальные HTTP-серверы: webhook-приёмник и mock Ollama (/api/chat).
 * Проверяем: валидный JSON модели, отказ модели → усечение, выключенное
 * саммари, недоступный провайдер (доставка не блокируется).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-sum-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

const notifications = await import("./dist/notifications.js");
const settingsModule = await import("./dist/settings.js");
const dbModule = await import("./dist/db/index.js");

const { notifyTaskCompletion } = notifications;

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

// --- HTTP-серверы -----------------------------------------------------------
let webhookBodies = [];
async function withServers(modelHandler, fn) {
  webhookBodies = [];
  const webhook = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      webhookBodies.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => modelHandler(req, body, res));
  });
  await new Promise((r) => webhook.listen(0, "127.0.0.1", r));
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const hookUrl = `http://127.0.0.1:${webhook.address().port}/hook`;
  const modelUrl = `http://127.0.0.1:${model.address().port}`;
  try {
    return await fn(hookUrl, modelUrl);
  } finally {
    // QA-CI-NODE26: закрываем keeps-alive-сокеты до close(), иначе Node 26
    // на Windows может ассертить UV_HANDLE_CLOSING при выходе из процесса.
    webhook.closeAllConnections?.();
    model.closeAllConnections?.();
    await new Promise((r) => webhook.close(r));
    await new Promise((r) => model.close(r));
  }
}

function writeSettings(webhookUrl, modelUrl, summary, triage) {
  const settingsFile = path.join(
    process.env.OPENCODE_SCHEDULER_HOME,
    "settings.json"
  );
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      notifications: {
        enabled: true,
        onlyOnError: false,
        webhook: { enabled: true, url: webhookUrl },
        triage: {
          mode: "off",
          baseUrl: modelUrl,
          model: "qwen3:4b",
          timeoutMs: 4000,
          ...triage,
        },
        dedup: { enabled: false, suppressDuplicates: false },
        embedding: { enabled: false, suppressDuplicates: false },
        summary,
      },
    }),
    "utf8"
  );
  return settingsModule.loadSettings();
}

// --- Тесты ------------------------------------------------------------------

// 1. Валидный JSON модели → в сообщении три строки модели
await withServers(
  (_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        message: {
          content: JSON.stringify({
            lines: ["Deploy завершился успешно", "Все тесты зелёные", "1.0 с, $0.5"],
          }),
        },
      })
    );
  },
  async (hookUrl, modelUrl) => {
    await writeSettings(hookUrl, modelUrl, {
      enabled: true,
      maxLines: 3,
      maxCharsPerLine: 120,
      timeoutMs: 4000,
    });
    await notifyTaskCompletion("Deploy", "success", 1000, null, 0, 0.5, {
      asyncTriage: false,
    });
    check("summary #1: уведомление доставлено", webhookBodies.length === 1);
    const body = webhookBodies[0] ?? "";
    check(
      "summary #1: в сообщении строки модели",
      body.includes("Deploy завершился успешно") && body.includes("Все тесты зелёные")
    );
  }
);

// 2. Невалидный JSON модели → детерминированное усечение (не падаем)
await withServers(
  (_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: { content: "не json" } }));
  },
  async (hookUrl, modelUrl) => {
    await writeSettings(hookUrl, modelUrl, {
      enabled: true,
      maxLines: 3,
      maxCharsPerLine: 120,
      timeoutMs: 4000,
    });
    await notifyTaskCompletion("Lint", "error", 2000, "eslint: 3 ошибки", 120, 0, {
      asyncTriage: false,
    });
    check("summary #2: fallback доставлен", webhookBodies.length === 1);
    const body = webhookBodies[0] ?? "";
    check(
      "summary #2: fallback содержит статус и ошибку",
      body.includes("error") && body.includes("eslint")
    );
  }
);

// 3. summary.enabled=false → обычное сообщение шаблона
await withServers(
  (_req, _body, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: { content: "{}" } }));
  },
  async (hookUrl, modelUrl) => {
    await writeSettings(hookUrl, modelUrl, {
      enabled: false,
      maxLines: 3,
      maxCharsPerLine: 120,
      timeoutMs: 4000,
    });
    await notifyTaskCompletion("Backup", "success", 500, null, 0, 0, {
      asyncTriage: false,
    });
    check("summary #3: без enable доставлено", webhookBodies.length === 1);
    const body = webhookBodies[0] ?? "";
    check(
      "summary #3: обычный шаблон (нет строк модели)",
      body.includes("Backup")
    );
  }
);

// 4. Недоступный провайдер → fallback, доставка не блокируется
await withServers(
  (_req, _body, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  },
  async (hookUrl, modelUrl) => {
    await writeSettings(hookUrl, modelUrl, {
      enabled: true,
      maxLines: 3,
      maxCharsPerLine: 120,
      timeoutMs: 3000,
    });
    const started = Date.now();
    await notifyTaskCompletion("Tests", "error", 3000, "2 теста упали", 0, 0, {
      asyncTriage: false,
    });
    const elapsed = Date.now() - started;
    check("summary #4: доставка при отказе модели", webhookBodies.length === 1);
    const body = webhookBodies[0] ?? "";
    check(
      "summary #4: fallback содержит ошибку",
      body.includes("Tests") && body.includes("2 теста упали")
    );
    check("summary #4: доставка не ждёт сверх таймаута", elapsed < 10_000);
  }
);

// --- Очистка ----------------------------------------------------------------
try {
  await dbModule.closeDb();
} catch (_) {}

console.log(`\n${passed}/${results.length} тестов саммари пройдены.`);
// QA-CI-NODE26: даём event loop дренироваться; принудительный выход процесса
// ловит закрывающийся libuv-async-хендл на Windows Node 26.4.
process.exitCode = failed > 0 ? 1 : 0;
