import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-triage-audit-"));
process.env.OPENCODE_SCHEDULER_HOME = home;
process.env.APPDATA = home;

const {
  recordTriageOutcome,
  readTriageDecisions,
  shadowReport,
  resetShadowDecisions,
} = await import("./dist/core/triage-shadow.js");
const { closeDb } = await import("./dist/db/index.js");
const { readAuditLog } = await import("./dist/core/audit.js");
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

function outcome(overrides = {}) {
  return {
    action: "skip",
    source: "rules",
    verdict: { category: "quality", severity: "medium", confidence: 0.9, reason: "gate" },
    attempts: 0,
    latencyMs: 12,
    ruleId: "test-rule",
    ...overrides,
  };
}

const input = (overrides = {}) => ({
  taskName: "deploy-v2",
  status: "error",
  error: "token=abc123 quality gate failed",
  durationMs: 1000,
  tokens: 42,
  costUsd: 0.02,
  ...overrides,
});

try {
  resetShadowDecisions();

  // 1. Запись решения в persistent-аудит.
  const id = recordTriageOutcome(input(), outcome(), {
    shadowActive: true,
    suppressed: false,
  });
  check("audit: запись создана", typeof id === "number" && id > 0);
  const stored = readTriageDecisions();
  check("audit: решение читается", stored.length === 1);
  const first = stored[0] ?? {};
  check("audit: action=skip", first.action === "skip");
  check("audit: source=rules", first.source === "rules");
  check("audit: ruleId сохранён", first.ruleId === "test-rule");
  check("audit: confidence сохранён", first.confidence === 0.9);
  check("audit: latency сохранена", first.latencyMs === 12);
  check("audit: shadow=true", first.shadow === true);
  check("audit: suppressed=false", first.suppressed === false);
  check("audit: verdict.reason сохранён", first.reason === "gate");
  const auditDetails = readAuditLog({ action: "triage.decision", target: "deploy-v2" })
    .records[0]?.details;
  check(
    "audit: секрет в ошибке замаскирован",
    typeof auditDetails?.error === "string" &&
      auditDetails.error.includes("***") &&
      !auditDetails.error.includes("abc123")
  );

  // 2. Запись переживает закрытие соединения.
  closeDb();
  check("audit: запись пережила reopen", readTriageDecisions().length === 1);

  // 3. Обычное решение не попадает в shadow-отчёт.
  recordTriageOutcome(input({ taskName: "nightly" }), outcome({ source: "llm", action: "notify", ruleId: undefined }), {
    shadowActive: false,
    suppressed: false,
  });
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const report = shadowReport({ enabled: true, days: 14, startedAt });
  check("shadow: только shadow-записи", report.total === 1 && report.skips === 1);
  check("shadow: bySource.rules=1", report.bySource.rules === 1);
  check("shadow: decision содержит shadow", report.decisions[0]?.shadow === true);
  check("shadow: truncated=false", report.truncated === false);

  // 4. Сброс отчёта удаляет только shadow-записи.
  resetShadowDecisions();
  check("reset: shadow-запись удалена", readTriageDecisions().length === 1);
  check("reset: обычный аудит сохранён", readTriageDecisions()[0]?.shadow === false);
  check("reset: отчёт пуст", shadowReport({ enabled: true, days: 14, startedAt }).total === 0);

  // 5. Истёкший период не включает новые shadow-записи.
  const expired = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  recordTriageOutcome(input({ taskName: "late" }), outcome(), { shadowActive: true });
  const expiredReport = shadowReport({ enabled: true, days: 14, startedAt: expired });
  check("shadow: истёкший период пуст", expiredReport.total === 0);
  check("shadow: expired active=false", expiredReport.active === false);

  // 6. Интеграция: правило skip подавляет доставку и пишет suppressed.
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      globalThis.__webhookBody = "received";
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const webhookUrl = `http://127.0.0.1:${port}`;
  const rule = {
    id: "skip-deploy",
    field: "task",
    operator: "equals",
    value: "deploy-guard",
    action: "skip",
    priority: 100,
  };

  try {
    await saveSettings({
      notifications: {
        enabled: true,
        onlyOnError: false,
        webhook: { enabled: true, url: webhookUrl, timeoutMs: 2000, retryCount: 0, retryDelayMs: 0 },
        filters: { include: [], exclude: [] },
        triage: {
          mode: "rules",
          baseUrl: "http://127.0.0.1:9",
          model: "qwen3:4b",
          timeoutMs: 500,
          fallback: "rules",
          confidenceThreshold: 0.6,
          rules: [rule],
          shadow: { enabled: false, days: 14, startedAt: null },
        },
      },
    });
    globalThis.__webhookBody = "";
    await notifyTaskCompletion("deploy-guard", "error", 1000, "boom");
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("integration: skip подавил webhook", globalThis.__webhookBody === "");
    const suppressed = readTriageDecisions({ taskName: "deploy-guard" })[0];
    check("integration: suppressed=true в аудите", suppressed?.suppressed === true);
    check("integration: shadow=false в аудите", suppressed?.shadow === false);

    // 7. Shadow-период: то же правило не подавляет доставку.
    await saveSettings({
      notifications: {
        triage: {
          mode: "rules",
          rules: [rule],
          shadow: { enabled: true, days: 14, startedAt: new Date().toISOString() },
        },
      },
    });
    globalThis.__webhookBody = "";
    await notifyTaskCompletion("deploy-guard", "error", 1000, "boom");
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("integration: shadow доставил webhook", globalThis.__webhookBody === "received");
    const shadowed = readTriageDecisions({ taskName: "deploy-guard" })[0];
    check("integration: shadow=true в аудите", shadowed?.shadow === true);
    check("integration: suppressed=false в shadow", shadowed?.suppressed === false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\nTriage audit: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exit(1);
