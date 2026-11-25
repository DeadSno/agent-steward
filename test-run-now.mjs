import fs from "node:fs";

const { runTaskNow } = await import("./dist/core/scheduler/run-now.js");
const { forceFilePath } = await import("./dist/core/ps-wrapper.js");

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

console.log(`\n${passed}/${passed + failed} OK`);
if (failed > 0) {
  console.error(`Провалено: ${failed}`);
  process.exit(1);
}
