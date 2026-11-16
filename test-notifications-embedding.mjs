/**
 * Тесты 31.1: семантический дедуп уведомлений через эмбеддинги.
 * Запуск: node test-notifications-embedding.mjs (после npm run build).
 * Локальный HTTP-сервер как webhook-приёмник; планировщик ОС не нужен.
 * Используется bag-of-words вектор (textToVector) без внешних моделей.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-emb-"));
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

// --- Webhook приёмник -------------------------------------------------------
let webhookCalls = [];
async function withServer(handler, fn) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      handler(req, body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/hook`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writeSettings(webhookUrl, overrides = {}) {
  const settingsFile = path.join(
    process.env.OPENCODE_SCHEDULER_HOME,
    "settings.json"
  );
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const base = {
    notifications: {
      enabled: true,
      onlyOnError: false,
      webhook: { enabled: true, url: webhookUrl },
      triage: { mode: "off" },
      dedup: { enabled: false, suppressDuplicates: false },
      embedding: {
        enabled: true,
        suppressDuplicates: true,
        threshold: 0.85,
        windowMinutes: 60,
        maxVectors: 10_000,
      },
    },
  };
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ notifications: { ...base.notifications, ...overrides } }),
    "utf8"
  );
  return await settingsModule.loadSettings();
}

async function withWebhook(fn) {
  webhookCalls = [];
  await withServer(
    (_req, body) => {
      try {
        webhookCalls.push(JSON.parse(body));
      } catch (e) {
        webhookCalls.push({ raw: body });
      }
    },
    fn
  );
}

async function closeDbAndCleanup() {
  try {
    await dbModule.closeDb();
  } catch (_) {}
}

// --- Тесты ------------------------------------------------------------------

// 1. Первое уведомление доставляется, вектор сохраняется
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl);
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check("embedding #1: первое уведомление доставилось", webhookCalls.length === 1);
});

// 2. Похожее сообщение подавляется (семантически близкое)
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl);
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check("embedding #2: похожее уведомление подавлено", webhookCalls.length === 1);
});

// 3. Разное сообщение доставляется (не дубликат по смыслу)
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl);
  await notifyTaskCompletion("Тесты", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check("embedding #3: разное уведомление доставилось", webhookCalls.length === 1);
});

// 4. Важный статус (error) не подавляется даже если семантически близкий
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl);
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Deploy-Production", "error", 1000, "boom", 0, 0, {
    asyncTriage: false,
  });
  check(
    "embedding #4: важный статус error доставился",
    webhookCalls.length === 2
  );
});

// 5. embedding.enabled=false — вектор не подавляет
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl, {
    embedding: { enabled: false, suppressDuplicates: true },
  });
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check(
    "embedding #5: без enable оба уведомления доставлены",
    webhookCalls.length === 2
  );
});

// 6. suppressDuplicates=false — оба доставляются даже если похожи
await withWebhook(async (hookUrl) => {
  await writeSettings(hookUrl, {
    embedding: { enabled: true, suppressDuplicates: false },
  });
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check(
    "embedding #6: без suppressDuplicates оба доставлены",
    webhookCalls.length === 2
  );
});

// --- Очистка ----------------------------------------------------------------
await closeDbAndCleanup();

console.log(`\n${passed}/${results.length} тестов эмбеддинг-дедупа пройдены.`);
process.exit(failed > 0 ? 1 : 0);
