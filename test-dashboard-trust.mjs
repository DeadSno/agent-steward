/**
 * Dashboard source trust: Origin is authoritative, X-Scheduler-Client never bypasses it.
 *
 * Covers the CSRF/DNS-rebinding regression where the custom header alone used to
 * be treated as trusted before Origin was checked.
 *
 * Run: node test-dashboard-trust.mjs (after npm run build).
 */
import http from "node:http";
import path from "node:path";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

const { root: tempRoot } = createTestHomeSync("ws-scheduler-trust-");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { isDashboardRequestTrusted, startDashboardServer, closeDashboardServer, getDashboardPort } =
  await import("./dist/server.js");
const { closeDb } = await import("./dist/db/index.js");

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
check(
  "QW-13: чужой localhost-порт с заголовком → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "http://localhost:3000" })) === false
);
check(
  "QW-13: Origin без порта → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "http://localhost" })) === false
);
check(
  "QW-13: не-HTTP-схема на локальном порту → не доверяем",
  isDashboardRequestTrusted(request({ ...client, origin: "ftp://localhost:3782" })) === false
);
check(
  "QW-13: стандартный порт плагина без запущенного сервера → доверяем",
  isDashboardRequestTrusted(request({ origin: "https://localhost:3782" })) === true
);

// Живые запросы к реальному серверу: unit-проверки выше не ловят
// рассинхрон между isDashboardRequestTrusted и handleRequest.
const dashboardDeps = {
  getTasks: async () => [],
  runTask: async () => ({ alreadyRunning: false }),
  deleteTask: async () => {},
};

let foreignServer = null;
try {
  // Чужой сервис на порту: плагин не должен принять его за свой дашборд.
  foreignServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("foreign service");
  });
  await new Promise((resolve, reject) => {
    foreignServer.once("error", reject);
    foreignServer.listen(4415, "127.0.0.1", resolve);
  });

  const started = await startDashboardServer(dashboardDeps, { preferred: 4415, fallback: 4416 });
  check(
    "занятый чужим сервисом порт не переиспользуется",
    Boolean(started) && started.port === 4416
  );

  const base = `http://127.0.0.1:${getDashboardPort()}`;
  const noOrigin = await fetch(`${base}/api/tasks`);
  check("живой запрос без Origin → 200", noOrigin.status === 200);

  const evilOrigin = await fetch(`${base}/api/tasks`, {
    headers: { origin: "https://evil.example" },
  });
  check("живой запрос с внешним Origin → 403", evilOrigin.status === 403);

  const localOrigin = await fetch(`${base}/api/tasks`, {
    headers: { origin: `http://127.0.0.1:${getDashboardPort()}` },
  });
  check("живой запрос с локальным Origin → 200", localOrigin.status === 200);

  const foreignLocalOrigin = await fetch(`${base}/api/tasks`, {
    headers: { ...client, origin: "http://localhost:3000" },
  });
  check(
    "QW-13: живой запрос с чужим localhost-портом → 403",
    foreignLocalOrigin.status === 403
  );

  const otherPluginPort = await fetch(`${base}/api/tasks`, {
    headers: { origin: "http://localhost:3782" },
  });
  check(
    "QW-13: живой запрос с портом другого дашборда → 403",
    otherPluginPort.status === 403
  );

  const evilRun = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ name: "test-task" }),
  });
  check("живой POST с внешним Origin → 403", evilRun.status === 403);
} finally {
  await closeDashboardServer().catch(() => {});
  if (foreignServer) {
    await new Promise((resolve) => foreignServer.close(resolve));
  }
  try {
    closeDb();
  } catch {
    // БД могла не открыться — закрывать нечего.
  }
}

removeTestHomeSync(tempRoot);

console.log(`\nDashboard trust: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
