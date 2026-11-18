/**
 * P1-7.T1.3: e2e-проверка one-shot планировщика с РЕАЛЬНЫМ `at`.
 *
 * Тест запускается только там, где есть настоящий GNU `at` и `atd`
 * (Linux CI, WSL с установленным at). На Windows без at — честно пропуск.
 *
 * Проверяемый контракт:
 *   1. LinuxScheduler.createTask({triggerType:"once"}) ставит задание в очередь at
 *      (появляется в `atq`) и сохраняет числовой atJobId в реестре.
 *   2. В момент runAt команда РЕАЛЬНО выполняется (появляется файл-маркер).
 *   3. deleteTask снимает ещё не выполнившееся задание (`atq` пустеет).
 *
 * Запуск: node test-at-e2e.mjs  (после npm run build).
 * В WSL: NODE_PATH=<windows repo>/node_modules node test-at-e2e.mjs
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
};

// --- Предусловия: нужен реальный GNU at ----------------------------------
// Проверяем только Linux: на Windows `which at` из Git Bash находит
// C:\Windows\System32\at.exe — это ДРУГОЙ `at` (планировщик Windows), он
// печатает usage и валит createTask. На macOS one-shot идёт через launchd,
// а atrun выключен по умолчанию — задания висят в atq и никогда не срабатывают.
if (process.platform !== "linux") {
  console.log(
    `SKIP: e2e с GNU at проверяется только на Linux (текущая платформа: ${process.platform}); ` +
      "на Windows/macOS one-shot реализован через schtasks/launchd."
  );
  process.exit(0);
}
const whichAt = run("which", ["at"]);
if (whichAt.code !== 0 || !whichAt.out.trim()) {
  console.log("SKIP: реальный GNU `at` не найден (минимальный образ).");
  process.exit(0);
}
const atVersion = run("at", ["-V"]);
if (!/at version/i.test(atVersion.out)) {
  console.log(`SKIP: найден не GNU at (${atVersion.out.trim().split("\n")[0] || "нет вывода"}).`);
  process.exit(0);
}
// atd может не быть запущен в контейнере — стартуем, если есть права.
const atd = run("pgrep", ["-a", "atd"]);
if (atd.code !== 0) {
  run("atd", []);
}

let failures = 0;
const check = (msg, cond, detail) => {
  if (cond) console.log("OK: " + msg);
  else {
    failures += 1;
    console.error("FAIL: " + msg + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
};

const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "at-e2e-"));
const marker = path.join(markerDir, "fired.txt");

// Изолируем реестр планировщика, чтобы не задеть реальные задачи.
process.env.OPENCODE_SCHEDULER_HOME = path.join(markerDir, "plugin-home");
fs.mkdirSync(process.env.OPENCODE_SCHEDULER_HOME, { recursive: true });

const { LinuxScheduler } = await import("./dist/core/scheduler/linux.js");

const atq = () => {
  const r = run("atq", []);
  return r.out;
};

// --- 1. createTask(once) реально ставит задание в atq --------------------
// at принимает время с минутным разрешением — ставим +2 минуты, чтобы было
// время проверить atq и отменить задание до срабатывания.
const runAt = new Date(Date.now() + 2 * 60_000);
const command = `printf 'fired\\n' > '${marker}'`;
const scheduler = new LinuxScheduler("at-e2e-profile");
const before = atq();
await scheduler.createTask({
  name: "at-e2e-one-shot",
  schedule: "",
  command,
  triggerType: "once",
  runAt: runAt.toISOString(),
  logFile: null,
  workingDirectory: markerDir,
});
const afterCreate = atq();
check("createTask(once): задание появилось в atq", afterCreate.length > before.length, {
  before: before.trim(),
  after: afterCreate.trim(),
});

const listed = await scheduler.listTasks();
check("createTask(once): задача видна в listTasks", listed.some((t) => t.taskName === "at-e2e-one-shot"), listed);

// --- 2. deleteTask снимает задание из atq --------------------------------
await scheduler.deleteTask("at-e2e-one-shot");
const afterDelete = atq();
check("deleteTask: задание исчезло из atq", afterDelete.trim() === before.trim(), {
  before: before.trim(),
  after: afterDelete.trim(),
});
check("deleteTask: задача исчезла из listTasks", !(await scheduler.listTasks()).some((t) => t.taskName === "at-e2e-one-shot"));

// --- 3. реальное выполнение: ставим на +1 минуту и ждём маркер -----------
const fireAt = new Date(Date.now() + 65_000);
await scheduler.createTask({
  name: "at-e2e-fire",
  schedule: "",
  command,
  triggerType: "once",
  runAt: fireAt.toISOString(),
  logFile: null,
  workingDirectory: markerDir,
});
check("реальное выполнение: задание в atq", atq().includes("at-e2e-fire") || atq().trim().length > 0);

const deadline = Date.now() + 100_000;
let fired = false;
while (Date.now() < deadline) {
  if (fs.existsSync(marker)) {
    fired = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
check("реальное выполнение: at выполнил команду (маркер создан)", fired, { marker });

// Уборка: снимаем всё, что осталось от теста.
try {
  await scheduler.deleteTask("at-e2e-fire");
} catch {}
fs.rmSync(markerDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "e2e OK" : failures + " проверок e2e провалено"}.`);
process.exit(failures > 0 ? 1 : 0);
