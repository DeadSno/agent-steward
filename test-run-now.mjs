import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const { runTaskNow, checkoutLockPath, activeCheckoutLock } = await import(
  "./dist/core/scheduler/run-now.js"
);
const { forceFilePath } = await import("./dist/core/ps-wrapper.js");
const { saveTask, deleteTask } = await import("./dist/db/tasks-repo.js");

let passed = 0;
let failed = 0;

function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  OK  ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL  ${name}`);
  }
}

// QA-P3.6: run_task_now не должен дёргать schtasks для несуществующей задачи —
// сначала проверяем определения и ОС, затем возвращаем структурную ошибку.
const indexSrc = fs.readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
check(
  indexSrc.includes("scheduler.listTasks().catch(() => [])") &&
    indexSrc.includes('t("tool.error.taskNotFound", { name: trimmed })'),
  "QA-P3.6: runTaskEntry проверяет существование задачи до запуска",
);

/**
 * P1-9.T3.1: цепочки / DAG / retry запускают задачу «сейчас» через тот же
 * helper, что и run_task_now, поэтому цель в poll-режиме получает force-маркер
 * и не отменяется schedule-gate.
 */

// 1. Маркер создаётся ДО вызова backend.runTask и снимается gate'ом/очисткой.
const name = `run-now-ok-${process.pid}`;
const marker = forceFilePath(name);
fs.rmSync(marker, { force: true });

let markerDuringRun = false;
const okBackend = {
  platform: process.platform,
  title: "test",
  async runTask() {
    markerDuringRun = fs.existsSync(marker);
    return { alreadyRunning: false };
  },
};

const result = await runTaskNow(name, okBackend);
check("runTaskNow: force-маркер существует во время backend.runTask", markerDuringRun);
check("runTaskNow: возвращает результат бэкенда", result.alreadyRunning === false);
fs.rmSync(marker, { force: true });

// 2. Если планировщик не принял запуск — маркер удаляется, ошибка пробрасывается.
const failName = `run-now-fail-${process.pid}`;
const failMarker = forceFilePath(failName);
fs.rmSync(failMarker, { force: true });

const failBackend = {
  platform: process.platform,
  title: "test",
  async runTask() {
    throw new Error("scheduler rejected");
  },
};

let threw = false;
try {
  await runTaskNow(failName, failBackend);
} catch (err) {
  threw = String(err?.message) === "scheduler rejected";
}
check("runTaskNow: ошибка планировщика пробрасывается", threw);
check("runTaskNow: маркер удалён при ошибке", !fs.existsSync(failMarker));
fs.rmSync(failMarker, { force: true });

// 3. Регрессия: record-history больше не ходит в бэкенд напрямую.
const recordHistory = fs.readFileSync(
  new URL("./dist/core/record-history.js", import.meta.url),
  "utf8",
);
const helperCalls = (recordHistory.match(/runTaskNow\(/g) || []).length;
check("record-history: цепочки и retry используют runTaskNow (>=2 вызова)", helperCalls >= 2);
// P3-37: запрещаем именно прямые вызовы backend.runTask (они обходят
// force-маркер). createSchedulerBackend() здесь нужен легитимно — P2-27
// очищает отработавшие ONCE-задачи через deleteTask.
const directRunTaskCalls = (recordHistory.match(/\.runTask\s*\(/g) || []).length;
check(
  "record-history: прямых backend.runTask больше нет",
  directRunTaskCalls === 0,
);
check(
  "record-history: cleanup one-shot вызывает createSchedulerBackend().deleteTask",
  /createSchedulerBackend\(\)\s*\.\s*deleteTask\s*\(/.test(recordHistory),
);

// QA-D316-8: skipped/reason от бэкенда должны доходить до вызывающего.
const skipBackend = {
  platform: process.platform,
  title: "test",
  async runTask() {
    return { alreadyRunning: false, skipped: true, reason: "тест пропуска" };
  },
};
const skipName = `run-now-skip-${process.pid}`;
const skipResult = await runTaskNow(skipName, skipBackend);
check("runTaskNow: skipped пробрасывается из бэкенда", skipResult.skipped === true);
check("runTaskNow: причина пропуска пробрасывается", skipResult.reason === "тест пропуска");
fs.rmSync(forceFilePath(skipName), { force: true });

check(
  "QA-D316-8: run_task_now возвращает success:false при skipped",
  indexSrc.includes("if (skipped)") &&
    /success:\s*false,[\s\S]{0,160}reason:\s*skipReason/.test(indexSrc),
);
check(
  "QA-D316-7: once без задания ОС помечается как пропущенный запуск",
  indexSrc.includes('definition.triggerType === "once"') &&
    indexSrc.includes("QA-D316-7: задание планировщика"),
);

// QA-D316-20: early-return для once без задания ОС находился ДО try/finally,
// поэтому счётчик PL-106 оставался поднятым и следующий run_task_now
// без worktree отклонялся. PL-138 заменил глобальный activeNonIsolatedRuns
// на activeNonIsolatedByCheckout (ключ — нормализованный checkout), поэтому
// проверяем тот же инвариант на актуальной реализации: инкремент → try →
// skip → finally со снятием по checkoutKey.
const incAt = indexSrc.indexOf("if (!isolation.isolated) {", indexSrc.indexOf("const isolation = planRuntimeIsolation("));
const guardTryAt = indexSrc.indexOf("try {", incAt);
const skipAt = indexSrc.indexOf("skipped: true", incAt);
const finallyAt = indexSrc.indexOf("} finally {", incAt);
const releaseAt = indexSrc.indexOf("releaseNonIsolatedRun(isolation.isolated ? null : checkoutKey);", incAt);
check(
  "QA-D316-20: early-return once снимает счётчик PL-106",
  incAt > 0 &&
    guardTryAt > incAt &&
    guardTryAt < skipAt &&
    skipAt < finallyAt &&
    releaseAt > finallyAt &&
    !/^\s*(return|throw)\b/m.test(indexSrc.slice(incAt, guardTryAt)),
);
check(
  "QA-D316-20: единая функция снятия счётчика PL-106",
  indexSrc.includes("function releaseNonIsolatedRun(checkoutKey: string | null): void") &&
    (indexSrc.match(/releaseNonIsolatedRun\(/g) || []).length >= 3,
);

// QA-D316-18: пропуск из-за чужого checkout-lock принимается в обёртке ПОСЛЕ
// того, как бэкенд ОС сообщил об успехе /run. Node обязан увидеть lock до запуска
// и вернуть skipped/reason, иначе run_task_now показывает success:true.
const root18 = path.join(process.cwd(), `qa-d316-18-test-${process.pid}`);
fs.mkdirSync(root18, { recursive: true });
const lock18 = checkoutLockPath(root18);
const expectedKey18 = crypto
  .createHash("sha256")
  .update(root18, "utf8")
  .digest("hex")
  .slice(0, 16);
check(
  "QA-D316-18: путь checkout-lock совпадает с хешем PowerShell-обёртки",
  path.basename(lock18) === `checkout-${expectedKey18}.lock`,
);
fs.writeFileSync(lock18, `${process.pid}-${new Date().toISOString()}`);
const verdict18 = await activeCheckoutLock(root18);
check(
  "QA-D316-18: активный checkout-lock определяется по живому PID",
  verdict18 !== null && verdict18.reason.includes("PL-121"),
);
fs.writeFileSync(lock18, `99999999-${new Date().toISOString()}`);
check(
  "QA-D316-18: lock с мёртвым PID считается осиротевшим",
  (await activeCheckoutLock(root18)) === null,
);
fs.writeFileSync(lock18, `${process.pid}-${new Date().toISOString()}`);

const taskName18 = `qa-d316-18-${process.pid}`;
saveTask({
  name: taskName18,
  schedule: "once",
  prompt: "QA-D316-18: проверка пропуска по checkout-lock",
  workingDirectory: root18,
});
let backendCalled18 = false;
const backend18 = {
  platform: process.platform,
  title: "test",
  async runTask() {
    backendCalled18 = true;
    return { alreadyRunning: false };
  },
};
const result18 = await runTaskNow(taskName18, backend18);
check(
  "QA-D316-18: runTaskNow возвращает skipped с причиной PL-121",
  result18.skipped === true && /PL-121/.test(result18.reason ?? ""),
);
check("QA-D316-18: бэкенд ОС не вызывается при активном checkout-lock", backendCalled18 === false);
deleteTask(taskName18);
fs.rmSync(lock18, { force: true });
fs.rmSync(root18, { recursive: true, force: true });
check(
  "QA-D316-18: run_task_now превращает skipped в success:false",
  indexSrc.includes("if (skipped)") && /success:\s*false/.test(indexSrc),
);

console.log(`\n${passed}/${passed + failed} OK`);
if (failed > 0) {
  console.error(`Провалено: ${failed}`);
  process.exit(1);
}
