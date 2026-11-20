// B4: изоляция профилей на уровне порта.
// Первый профиль держит порт, второй не должен его переиспользовать
// (иначе покажет чужие данные) и не должен снимать чужой живой процесс.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeTestHomeSync } from "./scripts/test-home.mjs";

// QA-P0.3: изолируем HOME до импорта сервера, чтобы тест не читал/не писал
// рабочую БД профиля. Статический import инициализировал бы её с live-путём.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-profile-iso-"));
process.env.APPDATA = home;
process.env.OPENCODE_SCHEDULER_HOME = home;
const { startDashboardServer, closeDashboardServer, probeDashboardOn } =
  await import("./dist/server.js");

const preferred = 4335;
const fallback = 4336;

let failed = 0;
const check = (cond, msg) => {
  if (cond) console.log("OK: " + msg);
  else {
    failed += 1;
    console.error("FAIL: " + msg);
  }
};

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const childScript = path.join(home, "start-alpha.mjs");
fs.writeFileSync(
  childScript,
  `import { startDashboardServer } from ${JSON.stringify(pathToFileURL(path.resolve("dist/server.js")).href)};
const started = await startDashboardServer(
  { getTasks: async () => [{ name: "alpha-secret", schedule: "* * * * *", status: "success", nextRun: null }] },
  { preferred: ${preferred}, fallback: ${fallback} },
);
console.log("STARTED:" + (started ? started.port : "none"));
setInterval(() => {}, 1000);
`,
  "utf8",
);

const child = spawn(process.execPath, [childScript], {
  env: {
    ...process.env,
    APPDATA: home,
    OPENCODE_SCHEDULER_HOME: home,
    OPENCODE_SCHEDULER_PROFILE: "alpha",
    OPENCODE_SCHEDULER_PORT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let childOut = "";
child.stdout.on("data", (d) => (childOut += d.toString()));
child.stderr.on("data", (d) => (childOut += d.toString()));

const stop = async () => {
  await closeDashboardServer().catch(() => {});
  child.kill();
  await new Promise((r) => setTimeout(r, 300));
  removeTestHomeSync(home);
};

try {
  const alphaUp = await waitFor(async () => {
    const p = await probeDashboardOn(preferred);
    return p.dashboard;
  });
  check(alphaUp, "дашборд профиля alpha поднялся на " + preferred);
  if (!alphaUp) throw new Error("alpha не стартовал:\n" + childOut);

  const probe = await probeDashboardOn(preferred);
  check(probe.profile === "alpha", "probeDashboardOn() вернул профиль alpha (факт: " + probe.profile + ")");

  const alphaRes = await fetch(`http://127.0.0.1:${preferred}/`);
  check(
    alphaRes.headers.get("x-plugin-profile") === "alpha",
    "ответ дашборда содержит x-plugin-profile: alpha",
  );
  check(
    alphaRes.headers.get("x-plugin-dashboard") === "agent-steward",
    "маркер x-plugin-dashboard сохранён",
  );
  const alphaTasks = await fetch(`http://127.0.0.1:${preferred}/api/tasks`).then((r) => r.json());
  check(
    alphaTasks.tasks?.some((t) => t.name === "alpha-secret"),
    "alpha отдаёт свои задачи",
  );

  // Второй профиль в этом процессе пытается занять тот же порт.
  process.env.OPENCODE_SCHEDULER_PROFILE = "beta";
  const beta = await startDashboardServer(
    { getTasks: async () => [{ name: "beta-task", schedule: "", status: "success", nextRun: null }] },
    { preferred, fallback },
  );
  check(Boolean(beta), "дашборд beta запустился");
  check(beta?.port === fallback, "beta ушёл на запасной порт, а не переиспользовал чужой (факт: " + beta?.port + ")");

  const betaBase = `http://127.0.0.1:${beta?.port}`;
  const betaHtml = await fetch(betaBase + "/");
  check(
    betaHtml.headers.get("x-plugin-profile") === "beta",
    "дашборд beta отдаёт x-plugin-profile: beta",
  );

  const betaTasks = await fetch(betaBase + "/api/tasks").then((r) => r.json());
  check(
    betaTasks.tasks?.some((t) => t.name === "beta-task"),
    "beta отдаёт задачи своего профиля",
  );
  check(
    !betaTasks.tasks?.some((t) => t.name === "alpha-secret"),
    "beta не видит задачи профиля alpha",
  );

  // Чужой живой процесс не должен быть снят как зомби.
  const alphaStill = await fetch(`http://127.0.0.1:${preferred}/api/tasks`)
    .then((r) => r.json())
    .catch(() => null);
  check(Boolean(alphaStill?.tasks?.some((t) => t.name === "alpha-secret")), "дашборд alpha не тронут");
} catch (err) {
  failed += 1;
  console.error("FAIL: " + (err instanceof Error ? err.message : String(err)));
} finally {
  await stop();
}

// После остановки оба порта освобождены.
const after = await probeDashboardOn(preferred);
check(!after.dashboard, "после остановки порт " + preferred + " свободен");

if (failed > 0) {
  console.error(`\nПрофили: ${failed} проверок упало.`);
  process.exit(1);
}
console.log("\nПрофили: все проверки пройдены.");
