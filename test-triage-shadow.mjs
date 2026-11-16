import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-triage-shadow-"));
process.env.OPENCODE_SCHEDULER_HOME = home;
process.env.APPDATA = home;

const { loadSettings, saveSettings, defaultNotifications, isShadowActive } = await import("./dist/settings.js");
const { shadowReport, resetShadowDecisions, shadowTotalCount, shadowSkipCount } = await import(
  "./dist/core/triage-shadow.js"
);
const { decideTriage, recordShadow } = await import("./dist/core/triage-chain.js");
const { closeDb } = await import("./dist/db/index.js");

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

const input = {
  taskName: "deploy",
  status: "error",
  error: "Quality Gate вернул код 1",
  durationMs: 1000,
};

const shadowOn = {
  mode: "llm",
  baseUrl: "http://127.0.0.1:9",
  model: "qwen3:4b",
  timeoutMs: 500,
  fallback: "rules",
  confidenceThreshold: 0.6,
  shadow: { enabled: true, days: 14, startedAt: new Date().toISOString() },
};

// 1. Shadow active → isShadowActive returns true
check("shadow: isShadowActive true", isShadowActive(shadowOn.shadow) === true);

// 2. Shadow disabled → false
check("shadow: disabled → false", isShadowActive({ enabled: false, days: 14, startedAt: new Date().toISOString() }) === false);

// 3. Shadow undefined → false
check("shadow: undefined → false", isShadowActive(undefined) === false);

// 4. Shadow startedAt null → false
check("shadow: startedAt null → false", isShadowActive({ enabled: true, days: 14, startedAt: null }) === false);

// 5. recordShadow records decision when shadow enabled
resetShadowDecisions();
const decisionSkip = {
  action: "skip",
  source: "rules",
  ruleId: "skip-deploy",
  failure: undefined,
  attempts: 0,
  latencyMs: 0,
};
recordShadow(input, decisionSkip, shadowOn.shadow);
check("shadow: recordShadow adds decision", shadowTotalCount() === 1);
check("shadow: skip counted", shadowSkipCount() === 1);

// 6. shadowReport structure
const report = shadowReport(shadowOn.shadow);
check("shadow: report active", report.active === true);
check("shadow: report total=1", report.total === 1);
check("shadow: report skips=1", report.skips === 1);
check("shadow: report wouldSuppress=1", report.wouldSuppress === 1);
check("shadow: report bySource.rules=1", report.bySource.rules === 1);

// 7. resetShadowDecisions clears
resetShadowDecisions();
check("shadow: reset clears", shadowTotalCount() === 0 && shadowSkipCount() === 0);

// 8. Shadow expiry: startedAt in the past (days=1, started 2 days ago)
const expired = { enabled: true, days: 1, startedAt: new Date(Date.now() - 2 * 86400000).toISOString() };
check("shadow: expired → isShadowActive false", isShadowActive(expired) === false);

// 9. Shadow still active: days=14, started 1 day ago
const active = { enabled: true, days: 14, startedAt: new Date(Date.now() - 86400000).toISOString() };
check("shadow: still active → isShadowActive true", isShadowActive(active) === true);

// 10. recordShadow does nothing when shadow disabled
resetShadowDecisions();
recordShadow(input, decisionSkip, { enabled: false, days: 14, startedAt: new Date().toISOString() });
check("shadow: disabled → no record", shadowTotalCount() === 0);

// 11. Settings shadow normalization
await saveSettings({
  notifications: {
    enabled: true,
    onlyOnError: false,
    triage: {
      mode: "off",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      timeoutMs: 45000,
      fallback: "rules",
      confidenceThreshold: 0.6,
      shadow: { enabled: false, days: 7, startedAt: null },
    },
  },
});
const loaded = await loadSettings();
check("settings: shadow enabled false", loaded.notifications.triage.shadow.enabled === false);
check("settings: shadow days=7", loaded.notifications.triage.shadow.days === 7);
check("settings: shadow startedAt null", loaded.notifications.triage.shadow.startedAt === null);

// 12. Default settings shadow
const defaults = defaultNotifications();
check("defaults: shadow enabled true", defaults.triage.shadow.enabled === true);
check("defaults: shadow days=14", defaults.triage.shadow.days === 14);
check("defaults: shadow startedAt null", defaults.triage.shadow.startedAt === null);

// 13. decideTriage: off → notify
check("decideTriage: off → notify", (await decideTriage(input, undefined)).action === "notify");

// 14. Save with shadow enabled but no startedAt → period starts automatically
await saveSettings({
  notifications: {
    enabled: true,
    onlyOnError: false,
    triage: {
      mode: "off",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      timeoutMs: 45000,
      fallback: "rules",
      confidenceThreshold: 0.6,
      shadow: { enabled: true, days: 14, startedAt: null },
    },
  },
});
const started = (await loadSettings()).notifications.triage.shadow;
check("settings: save starts shadow", Boolean(started.startedAt));
check("settings: started shadow is active", isShadowActive(started) === true);

// 15. Save with shadow disabled resets startedAt
await saveSettings({
  notifications: {
    enabled: true,
    onlyOnError: false,
    triage: {
      mode: "off",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      timeoutMs: 45000,
      fallback: "rules",
      confidenceThreshold: 0.6,
      shadow: { enabled: false, days: 14, startedAt: started.startedAt },
    },
  },
});
const stopped = (await loadSettings()).notifications.triage.shadow;
check("settings: disabling shadow clears startedAt", stopped.startedAt === null);

// 16. Report active mirrors isShadowActive (expired period → false)
check("shadow: report active false when expired", shadowReport(expired).active === false);

console.log(`\nTriage shadow: ${passed}/${passed + failed} проверок пройдено.`);
closeDb();
// Windows: ОС может ещё держать handle на файл БД, и rmSync падает с EPERM
// (force это не подавляет). Teardown не проверка — повторяем, не роняем тест.
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    break;
  } catch {
    if (attempt === 4) {
      console.log(`  (teardown) не удалось удалить ${home} — пропускаем`);
    }
  }
}
if (failed > 0) process.exit(1);

