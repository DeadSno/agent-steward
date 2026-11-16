/**
 * Dashboard source trust: Origin is authoritative, X-Scheduler-Client never bypasses it.
 *
 * Covers the CSRF/DNS-rebinding regression where the custom header alone used to
 * be treated as trusted before Origin was checked.
 *
 * Run: node test-dashboard-trust.mjs (after npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-trust-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { isDashboardRequestTrusted } = await import("./dist/server.js");

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

function request(headers) {
  return { headers };
}

const client = { "x-scheduler-client": "scheduler-panel" };

check(
  "внешний Origin + X-Scheduler-Client → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "https://evil.example" })) === false
);
check(
  "Origin: null + X-Scheduler-Client → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "null" })) === false
);
check(
  "локальный Origin + X-Scheduler-Client → доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "http://127.0.0.1:3782" })) === true
);
check(
  "локальный localhost Origin → доверяем",
  isDashboardRequestTrusted(request({ origin: "http://localhost:3782" })) === true
);
check(
  "IPv6 loopback Origin → доверяем",
  isDashboardRequestTrusted(request({ origin: "http://[::1]:3782" })) === true
);
check(
  "внешний Origin без заголовка → не доверяем",
  isDashboardRequestTrusted(request({ origin: "https://evil.example" })) === false
);
check(
  "без Origin, внешний Host + заголовок → не доверяем (DNS rebinding)",
  isDashboardRequestTrusted(request({ ...client, host: "evil.example:3782" })) === false
);
check(
  "без Origin, локальный Host + заголовок → доверяем",
  isDashboardRequestTrusted(request({ ...client, host: "127.0.0.1:3782" })) === true
);
check(
  "без Origin, локальный Host без заголовка → доверяем",
  isDashboardRequestTrusted(request({ host: "localhost:3782" })) === true
);
check(
  "Origin: file:// → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "file://" })) === false
);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(`\nDashboard trust: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
