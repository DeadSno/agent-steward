// Спринт 36.2: resume с середины линейной цепочки.
//
// Проверяем:
//  - после kill -9 посреди цепочки resume продолжает с прерванного шага;
//  - завершённые шаги не выполняются повторно, их обработчики не вызываются;
//  - attempt прерванного шага растёт (1 → 2), а не начинается заново;
//  - ошибка шага останавливает цепочку, run помечается failed;
//  - повторный resume с исправленным обработчиком доигрывает остаток;
//  - отсутствие обработчика — ошибка до побочных эффектов;
//  - async-вариант resume;
//  - stopOnError: false продолжает цепочку, но run всё равно failed.
//
// Запуск: node test-run-resume.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-run-resume-"));
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

const assertThrows = (fn, msg) => {
  try {
    fn();
  } catch {
    assert(true, msg);
    return;
  }
  assert(false, msg);
};

const { initDb, closeDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const journal = await import("./dist/db/run-journal.js");
const resume = await import("./dist/db/run-resume.js");

const dbModuleUrl = pathToFileURL(path.join(process.cwd(), "dist", "db", "index.js")).href;
const journalModuleUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "db", "run-journal.js"),
).href;

initDb(dbPath);

const createRun = (taskName, stepNames) =>
  repo.createRun({ taskName, steps: stepNames.map((stepName) => ({ stepName })) });

const handlersFor = (names, calls, overrides = {}) => {
  const handlers = {};
  for (const name of names) {
    handlers[name] = overrides[name] ?? (() => {
      calls.push(name);
      return `${name}-done`;
    });
  }
  return handlers;
};

const stepStatus = (runId, name) => repo.getStep(runId, name)?.status;
const stepAttempt = (runId, name) => repo.getStep(runId, name)?.attempt;

// --- 1. Resume после kill -9 посреди линейной цепочки -----------------------
const chain = ["prepare", "build", "test", "deploy"];
const runA = createRun("resume-chain", chain);

journal.runStepStatefully(runA.id, "prepare", () => "prepared");
assert(stepStatus(runA.id, "prepare") === "passed", "подготовительный шаг пройден до краха");

const childFile = path.join(tempRoot, "crasher.mjs");
fs.writeFileSync(
  childFile,
  [
    `import { initDb } from ${JSON.stringify(dbModuleUrl)};`,
    `import { beginStepAttempt } from ${JSON.stringify(journalModuleUrl)};`,
    "const [runId, stepName] = process.argv.slice(2);",
    "initDb(process.env.OPENCODE_SCHEDULER_DB);",
    "const step = beginStepAttempt(runId, stepName);",
    "console.log(JSON.stringify({ status: step.status, attempt: step.attempt }));",
    'process.kill(process.pid, "SIGKILL");',
    "",
  ].join("\n"),
  "utf8",
);

closeDb();
const child = spawnSync(process.execPath, [childFile, runA.id, "build"], {
  env: { ...process.env, OPENCODE_SCHEDULER_DB: dbPath },
  encoding: "utf8",
  timeout: 30000,
});
const childOutput = (child.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
assert(child.signal === "SIGKILL" || child.status !== 0, "процесс убит во время шага build");
assert(childOutput.includes('"attempt":1'), "до краха build закоммичен с attempt = 1");

initDb(dbPath);
assert(stepStatus(runA.id, "build") === "running", "после краха build остался running");
assert(
  resume.findResumeStep(runA.id)?.stepName === "build",
  "findResumeStep указывает на прерванный build",
);

const callsA = [];
const resultA = resume.resumeRunSync(runA.id, {
  handlers: handlersFor(chain, callsA),
});

assert(resultA.resumedFrom === "build", "resume начался с build");
assert(resultA.resumedFromAttempt === 2, "прерванный шаг выполнен с attempt = 2");
assert(
  JSON.stringify(resultA.executed) === JSON.stringify(["build", "test", "deploy"]),
  "выполнен только остаток цепочки",
);
assert(
  JSON.stringify(resultA.skipped) === JSON.stringify(["prepare"]),
  "prepare пропущен как завершённый",
);
assert(!callsA.includes("prepare"), "обработчик prepare повторно не вызывался");
assert(
  JSON.stringify(callsA) === JSON.stringify(["build", "test", "deploy"]),
  "обработчики вызваны ровно по одному разу",
);
assert(callsA.length === 3, "лишних вызовов обработчиков нет");
assert(resultA.run.status === "passed", "после resume запуск passed");
assert(Boolean(resultA.run.finishedAt), "у завершённого запуска есть finished_at");
assert(
  stepStatus(runA.id, "test") === "passed" && stepAttempt(runA.id, "test") === 1,
  "test выполнен с attempt = 1",
);
assert(
  stepStatus(runA.id, "deploy") === "passed" && stepAttempt(runA.id, "deploy") === 1,
  "deploy выполнен с attempt = 1",
);
assert(stepAttempt(runA.id, "build") === 2, "attempt build сохранён как 2");

// --- 2. Ошибка шага останавливает цепочку, повторный resume доигрывает ------
const runB = createRun("resume-failure", ["a", "b", "c"]);
const callsB = [];
const resultB = resume.resumeRunSync(runB.id, {
  handlers: handlersFor(["a", "b", "c"], callsB, {
    b: () => {
      callsB.push("b");
      throw new Error("b-boom");
    },
  }),
});

assert(resultB.failedStep === "b", "resume остановился на упавшем b");
assert(resultB.error === "b-boom", "текст ошибки попал в результат");
assert(resultB.run.status === "failed", "запуск помечен failed");
assert(stepStatus(runB.id, "c") === "pending", "шаг c после ошибки не запускался");
assert(!callsB.includes("c"), "обработчик c не вызывался");
assert(stepAttempt(runB.id, "b") === 1, "упавший b остался с attempt = 1");

const callsB2 = [];
const resultB2 = resume.resumeRunSync(runB.id, {
  handlers: handlersFor(["a", "b", "c"], callsB2),
});

assert(resultB2.resumedFrom === "b", "второй resume начался с b");
assert(resultB2.resumedFromAttempt === 2, "повтор b выполнен с attempt = 2");
assert(
  JSON.stringify(resultB2.executed) === JSON.stringify(["b", "c"]),
  "второй resume выполнил b и c",
);
assert(
  JSON.stringify(resultB2.skipped) === JSON.stringify(["a"]),
  "шаг a пропущен при повторном resume",
);
assert(!callsB2.includes("a"), "обработчик a повторно не вызывался");
assert(resultB2.run.status === "passed", "после успешного повтора запуск passed");
assert(
  stepAttempt(runB.id, "b") === 2 && stepStatus(runB.id, "b") === "passed",
  "b завершён со счётом попыток 2",
);

// --- 3. Продолжать нечего ---------------------------------------------------
const runC = createRun("resume-done", ["only"]);
journal.runStepStatefully(runC.id, "only", () => "ok");
const callsC = [];
const resultC = resume.resumeRunSync(runC.id, {
  handlers: handlersFor(["only"], callsC),
});
assert(resultC.resumedFrom === null, "для завершённой цепочки resumedFrom = null");
assert(resultC.executed.length === 0, "ничего не выполнялось");
assert(
  JSON.stringify(resultC.skipped) === JSON.stringify(["only"]),
  "завершённый шаг попал в skipped",
);
assert(callsC.length === 0, "обработчики не вызывались");
assert(resultC.run.status === "passed", "запуск остался passed");

// --- 4. Нет обработчика — ошибка до побочных эффектов ----------------------
const runD = createRun("resume-no-handler", ["m", "n"]);
const callsD = [];
assertThrows(
  () =>
    resume.resumeRunSync(runD.id, {
      handlers: { m: () => callsD.push("m") },
    }),
  "отсутствие обработчика шага бросает ошибку",
);
assert(callsD.length === 0, "до ошибки ни один обработчик не вызван");
assert(repo.getRun(runD.id)?.status === "pending", "запуск остался pending");
assert(
  stepStatus(runD.id, "m") === "pending" && stepStatus(runD.id, "n") === "pending",
  "шаги остались pending",
);

// --- 5. Асинхронный resume --------------------------------------------------
const runE = createRun("resume-async", ["p", "q"]);
const callsE = [];
const resultE = await resume.resumeRun(runE.id, {
  handlers: {
    p: async (step) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      callsE.push(`p:${step.attempt}`);
      return "p-done";
    },
    q: async () => {
      callsE.push("q");
      return "q-done";
    },
  },
});
assert(
  JSON.stringify(resultE.executed) === JSON.stringify(["p", "q"]),
  "async-resume выполнил всю цепочку",
);
assert(resultE.run.status === "passed", "async-resume завершил запуск passed");
assert(
  JSON.stringify(callsE) === JSON.stringify(["p:1", "q"]),
  "async-обработчики получили запись шага и выполнились по порядку",
);

// --- 6. stopOnError: false --------------------------------------------------
const runF = createRun("resume-continue", ["u", "v"]);
const callsF = [];
const resultF = resume.resumeRunSync(runF.id, {
  stopOnError: false,
  handlers: {
    u: () => {
      callsF.push("u");
      throw new Error("u-boom");
    },
    v: () => {
      callsF.push("v");
      return "v-done";
    },
  },
});
assert(
  JSON.stringify(resultF.executed) === JSON.stringify(["u", "v"]),
  "stopOnError: false продолжил цепочку после ошибки",
);
assert(resultF.run.status === "failed", "итоговый запуск всё равно failed");
assert(resultF.failedStep === "u", "первый упавший шаг — u");
assert(stepStatus(runF.id, "v") === "passed", "шаг v выполнен несмотря на ошибку u");

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(
  process.exitCode ? "\nЕсть ошибки resume." : "\nВсе проверки resume пройдены.",
);
