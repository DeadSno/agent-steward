// P2-29: DAG должен смотреть последнюю запись по каждой задаче,
// а не только последние 200 строк истории.
//
// Сценарий: у зависимости "dep" был успех давно. После него высокочастотная
// задача "busy" записала 250 запусков. Старый getHistory(null, 200) успех "dep"
// уже не видит; getLatestHistoryByTask() обязан его вернуть, а DAG — запустить
// зависимую задачу.
//
// Запуск: node test-dag-latest-history.mjs (после npm run build).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-p229-"));
const dbPath = path.join(tempRoot, "scheduler.db");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const { initDb, closeDb } = await import("./dist/db/index.js");
const { insertHistory, getHistory, getLatestHistoryByTask } = await import(
  "./dist/db/history-repo.js"
);
const { selectDependentsToTrigger } = await import(
  "./dist/core/record-history.js"
);

let passed = 0;
function check(name, condition) {
  if (!condition) {
    console.error(`FAIL: ${name}`);
    process.exitCode = 1;
    return;
  }
  passed += 1;
  console.log(`OK: ${name}`);
}

try {
  initDb(dbPath);

  insertHistory({
    taskName: "dep",
    status: "success",
    startedAt: "2020-01-01T00:00:00.000Z",
    finishedAt: "2020-01-01T00:00:01.000Z",
    durationMs: 1000,
  });

  for (let i = 0; i < 250; i += 1) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, i, 0)).toISOString();
    insertHistory({
      taskName: "busy",
      status: "success",
      startedAt: ts,
      finishedAt: ts,
      durationMs: 10,
    });
  }

  const window = getHistory(null, 200);
  check(
    "P2-29: старая запись dep вне окна последних 200 строк",
    !window.some((row) => row.taskName === "dep"),
  );

  const latest = getLatestHistoryByTask();
  const dep = latest.find((row) => row.taskName === "dep");
  check("P2-29: getLatestHistoryByTask возвращает dep", Boolean(dep));
  check("P2-29: последняя запись dep — success", dep?.status === "success");
  check(
    "P2-29: по одной записи на задачу (dep + busy)",
    latest.length === 2 &&
      latest.some((row) => row.taskName === "busy"),
  );

  const dependents = selectDependentsToTrigger(
    "dep",
    [{ name: "downstream", dependsOn: ["dep"] }],
    latest,
  );
  check(
    "P2-29: DAG запускает downstream по старому успеху dep",
    dependents.length === 1 && dependents[0] === "downstream",
  );
} finally {
  try {
    closeDb();
  } catch {
    // ignore
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`Провалено (dag latest history): ${passed} OK.`);
} else {
  console.log(`Все проверки пройдены (dag latest history): ${passed}.`);
}
