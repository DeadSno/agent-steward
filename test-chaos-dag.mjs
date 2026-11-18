// Chaos-тест ночного workflow (Sprint 36.5): kill -9 посреди DAG.
//
// Проверяем, что внезапное убийство процесса не ломает durable-состояние:
//  - шаги, завершённые до краха, остаются passed и не выполняются повторно;
//  - шаг, в котором убили процесс, остаётся running с attempt = 1;
//  - шаги после него остаются pending;
//  - recoverInterruptedSteps помечает жертву failed, сохраняя attempt;
//  - resume продолжает цепочку с жертвы, выполняет её с attempt = 2,
//    пропускает завершённые шаги и доводит запуск до passed;
//  - SQLite проходит integrity_check, WAL не теряет коммиты.
//
// Запуск: node test-chaos-dag.mjs (после npm run build).
// Ночью сценарий гоняет .github/workflows/nightly.yml на Windows и Ubuntu.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-chaos-dag-"));
const dbPath = path.join(tempRoot, "scheduler.db");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const journal = await import("./dist/db/run-journal.js");
const resume = await import("./dist/db/run-resume.js");

const dbModuleUrl = pathToFileURL(path.join(process.cwd(), "dist", "db", "index.js")).href;
const journalModuleUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "db", "run-journal.js"),
).href;

// Дочерний процесс выполняет DAG-цепочку и печатает маркеры старта/финиша.
// Родитель читает stdout и убивает его ровно между этими маркерами.
const childFile = path.join(tempRoot, "dag-runner.mjs");
fs.writeFileSync(
  childFile,
  [
    `import { initDb } from ${JSON.stringify(dbModuleUrl)};`,
    `import { runStepStatefullyAsync } from ${JSON.stringify(journalModuleUrl)};`,
    "const [runId, delayMs, ...steps] = process.argv.slice(2);",
    "initDb(process.env.OPENCODE_SCHEDULER_DB);",
    "for (const name of steps) {",
    "  await runStepStatefullyAsync(runId, name, async () => {",
    "    console.log(`started:${name}`);",
    "    await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));",
    "    console.log(`done:${name}`);",
    "    return `${name}-done`;",
    "  });",
    "}",
    "",
  ].join("\n"),
  "utf8",
);

const chain = ["prepare", "build", "test", "deploy"];

const createRun = () => {
  const run = repo.createRun({
    taskName: "chaos-dag",
    steps: chain.map((stepName) => ({ stepName })),
  });
  return run.id;
};

// Запускает дочерний процесс и убивает его сразу после начала шага killAt.
function runUntilKilled(runId, killAt, delayMs = 500) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childFile, runId, String(delayMs), ...chain], {
      env: { ...process.env, OPENCODE_SCHEDULER_DB: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const watchdog = setTimeout(() => {
      // Страховка от зависания: сценарий не должен дойти до конца.
      if (!killed) child.kill("SIGKILL");
    }, 30000);
    watchdog.unref();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!killed && stdout.includes(`started:${killAt}`)) {
        killed = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ stdout, stderr, code, signal, killed });
    });
  });
}

const stepStatus = (runId, name) => repo.getStep(runId, name)?.status;
const stepAttempt = (runId, name) => repo.getStep(runId, name)?.attempt;

async function chaosRound(killAt) {
  console.log(`\n--- Chaos: kill -9 на шаге ${killAt} ---`);

  initDb(dbPath);
  const runId = createRun();
  closeDb();

  const child = await runUntilKilled(runId, killAt);

  assert(child.killed, `процесс убит после старта шага ${killAt}`);
  assert(
    child.signal === "SIGKILL" || child.code !== 0,
    `процесс завершился не штатно (signal=${child.signal}, code=${child.code})`,
  );
  assert(child.stdout.includes(`started:${killAt}`), `до краха шаг ${killAt} был запущен`);
  assert(
    !child.stdout.includes(`done:${killAt}`),
    `шаг ${killAt} не успел завершиться до kill -9`,
  );
  assert(child.stderr === "", "дочерний процесс не писал в stderr");

  initDb(dbPath);

  const killIndex = chain.indexOf(killAt);
  for (const name of chain.slice(0, killIndex)) {
    assert(
      stepStatus(runId, name) === "passed" && stepAttempt(runId, name) === 1,
      `шаг ${name} до краха завершён passed, attempt = 1`,
    );
  }
  assert(
    stepStatus(runId, killAt) === "running" && stepAttempt(runId, killAt) === 1,
    `шаг ${killAt} после краха остался running, attempt = 1`,
  );
  for (const name of chain.slice(killIndex + 1)) {
    assert(stepStatus(runId, name) === "pending", `шаг ${name} после краха остался pending`);
  }
  assert(repo.getRun(runId)?.status === "running", "запуск после краха остался running");

  const integrity = getDb().prepare("PRAGMA integrity_check;").get();
  assert(String(integrity?.integrity_check) === "ok", "SQLite integrity_check = ok");

  const recovered = journal.recoverInterruptedSteps(runId);
  assert(recovered.length === 1, "recoverInterruptedSteps нашёл ровно один зависший шаг");
  assert(
    recovered[0]?.stepName === killAt &&
      recovered[0]?.status === "failed" &&
      recovered[0]?.attempt === 1,
    `прерванный ${killAt} помечен failed, attempt = 1`,
  );
  assert(
    recovered[0]?.error === journal.STEP_INTERRUPTED_ERROR,
    "причина прерывания сохранена в error",
  );
  assert(journal.listRunningSteps(runId).length === 0, "running-шагов не осталось");
  assert(
    journal.recoverInterruptedSteps(runId).length === 0,
    "повторное восстановление ничего не меняет",
  );
  assert(
    resume.findResumeStep(runId)?.stepName === killAt,
    `findResumeStep указывает на ${killAt}`,
  );

  const calls = [];
  const handlers = Object.fromEntries(
    chain.map((name) => [
      name,
      () => {
        calls.push(name);
        return `${name}-done`;
      },
    ]),
  );
  const result = resume.resumeRunSync(runId, { handlers });
  const remaining = chain.slice(killIndex);

  assert(result.resumedFrom === killAt, `resume начался с ${killAt}`);
  assert(result.resumedFromAttempt === 2, `${killAt} выполнен с attempt = 2`);
  assert(
    JSON.stringify(result.executed) === JSON.stringify(remaining),
    `resume выполнил только остаток: ${remaining.join(", ")}`,
  );
  assert(
    JSON.stringify(result.skipped) === JSON.stringify(chain.slice(0, killIndex)),
    "завершённые до краха шаги пропущены",
  );
  assert(
    JSON.stringify(calls) === JSON.stringify(remaining),
    "обработчики завершённых шагов повторно не вызывались",
  );
  assert(result.run.status === "passed", "после resume запуск passed");
  assert(Boolean(result.run.finishedAt), "у завершённого запуска есть finished_at");
  assert(
    repo.listRunSteps(runId).length === chain.length,
    "количество шагов не изменилось (дублей нет)",
  );
  assert(
    chain.every((name) => stepStatus(runId, name) === "passed"),
    "все шаги цепочки passed",
  );
  assert(stepAttempt(runId, killAt) === 2, `attempt ${killAt} = 2 после повтора`);
  for (const name of chain.slice(killIndex + 1)) {
    assert(stepAttempt(runId, name) === 1, `шаг ${name} выполнен с attempt = 1`);
  }
  assert(
    repo.listRunSteps(runId).filter((step) => step.status === "running").length === 0,
    "незавершённых шагов не осталось",
  );

  closeDb();
}

// Убиваем процесс на среднем шаге и ближе к концу цепочки: оба сценария
// проверяют, что resume не переигрывает уже завершённые шаги.
for (const killAt of ["build", "test"]) {
  await chaosRound(killAt);
}

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

console.log(
  process.exitCode
    ? "\nChaos DAG: есть ошибки."
    : "\nChaos DAG: kill -9 посреди цепочки пережит, resume продолжил с прерванного шага.",
);
