// Спринт 36.7: пауза с инъекцией контекста.
//
// Проверяем:
//  - схема v7: таблица run_injections и индексы;
//  - пауза до старта и между шагами, адресация первому незавершённому шагу;
//  - явная адресация шагу и ошибка для завершённого/несуществующего шага;
//  - комментарий, файл и артефакт сохраняются с автором и маскируют секреты;
//  - resume передаёт вставки обработчику ровно один раз и помечает consumed;
//  - пауза без контекста, async-resume, каскадное удаление;
//  - пауза во время выполняющегося шага запрещена.
//
// Запуск: node test-run-context.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-run-context-"));
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

const assertThrows = (fn, msg, fragment) => {
  try {
    fn();
    assert(false, msg);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (fragment && !text.includes(fragment)) {
      assert(false, `${msg} (в ошибке нет "${fragment}": ${text})`);
      if (err instanceof Error && err.stack) console.error(err.stack);
      return;
    }
    assert(true, msg);
  }
};

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { SCHEMA_VERSION, getSchemaVersion } = await import("./dist/db/schema.js");
const repo = await import("./dist/db/runs-repo.js");
const journal = await import("./dist/db/run-journal.js");
const resume = await import("./dist/db/run-resume.js");
const context = await import("./dist/db/run-context.js");

initDb(dbPath);

const createRun = (taskName, steps) =>
  repo.createRun({ taskName, steps: steps.map((stepName) => ({ stepName })) });
const stepStatus = (runId, name) => repo.getStep(runId, name)?.status;

// --- 1. Схема v7 ------------------------------------------------------------
assert(SCHEMA_VERSION === 7, `SCHEMA_VERSION = ${SCHEMA_VERSION}`);
assert(getSchemaVersion(getDb()) === 7, "user_version = 7");
const table = getDb()
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_injections'")
  .get();
assert(Boolean(table), "таблица run_injections создана");

// --- 2. Пауза до старта: комментарий, файл и артефакт ------------------------
const runA = createRun("pause-before-start", ["prepare", "build", "test"]);
const pausedA = context.pauseRun(runA.id, {
  author: "analyst",
  comment: "Staging only. API_KEY=super-secret-value",
  file: {
    path: "configs/staging.json",
    title: "staging config",
    content: '{"env":"staging","token":"abc123"}',
  },
  artifact: {
    name: "decision",
    content: { retry: true, password: "hunter2", apiToken: "topsecret" },
  },
});

assert(pausedA.run.status === "paused", "запуск переведён в paused");
assert(pausedA.stepName === "prepare", "контекст адресован первому незавершённому шагу");
assert(pausedA.injections.length === 3, "сохранены три вставки");
assert(
  pausedA.injections.map((item) => item.kind).join(",") === "comment,file,artifact",
  "виды вставок: comment,file,artifact",
);
assert(
  pausedA.injections.every((item) => item.author === "analyst"),
  "автор виден в каждой вставке",
);
const commentA = pausedA.injections.find((item) => item.kind === "comment");
const fileA = pausedA.injections.find((item) => item.kind === "file");
const artifactA = pausedA.injections.find((item) => item.kind === "artifact");
assert(!commentA.content.includes("super-secret-value"), "секрет в комментарии замаскирован");
assert(commentA.content.includes("API_KEY=***"), "присваивание в комментарии замаскировано");
assert(fileA.metadata.path === "configs/staging.json", "путь файла сохранён в metadata");
assert(fileA.metadata.title === "staging config", "название файла сохранено");
assert(!fileA.content.includes("abc123"), "секрет в содержимом файла замаскирован");
assert(fileA.content.includes('"token":"***"'), "JSON-поле файла замаскировано");
assert(!artifactA.content.includes("hunter2"), "секрет в артефакте замаскирован");
assert(!artifactA.content.includes("topsecret"), "токен в артефакте замаскирован");
assert(artifactA.metadata.name === "decision", "имя артефакта сохранено");
assert(context.listRunInjections(runA.id).length === 3, "история контекста содержит три записи");
assert(
  context.listRunInjections(runA.id).every((item) => item.createdAt && item.author),
  "в истории есть время и автор",
);

// --- 3. Resume передаёт контекст и потребляет его ---------------------------
const seenA = {};
const callsA = [];
const resultA = resume.resumeRunSync(runA.id, {
  handlers: {
    prepare: (_step, ctx) => {
      callsA.push("prepare");
      seenA.prepare = ctx;
      return "prepared";
    },
    build: (_step, ctx) => {
      callsA.push("build");
      seenA.build = ctx;
      return "built";
    },
    test: (_step, ctx) => {
      callsA.push("test");
      seenA.test = ctx;
      return "tested";
    },
  },
});

assert(resultA.run.status === "passed", "resume после паузы завершил запуск");
assert(resultA.resumedFrom === "prepare", "resume начался с шага, которому оставлен контекст");
assert(seenA.prepare.injections.length === 3, "обработчик первого шага получил три вставки");
assert(seenA.prepare.injections[0].author === "analyst", "обработчик видит автора");
assert(
  !seenA.prepare.injections[0].content.includes("super-secret-value"),
  "обработчик получает уже замаскированный текст",
);
assert(seenA.build.injections.length === 0, "следующий шаг не получает чужой контекст");
assert(resultA.injected.length === 3, "результат resume перечисляет переданные вставки");
const consumedA = context.listRunInjections(runA.id);
assert(
  consumedA.every((item) => item.consumedAt && item.consumedByStep === "prepare"),
  "все вставки помечены потреблёнными шагом prepare",
);
assert(
  consumedA.every((item) => item.consumedAttempt === 1),
  "номер попытки зафиксирован у вставок",
);
const againA = resume.resumeRunSync(runA.id, {
  handlers: { prepare: () => "x", build: () => "x", test: () => "x" },
});
assert(againA.injected.length === 0, "повторный resume не передаёт контекст снова");

// --- 4. Пауза между шагами: следующий шаг получает комментарий ---------------
const runB = createRun("pause-between", ["prepare", "build", "deploy"]);
journal.runStepStatefully(runB.id, "prepare", () => "prepared");
const pausedB = context.pauseRun(runB.id, {
  author: "reviewer",
  comment: "Use the staging cluster before deploy",
});
assert(pausedB.stepName === "build", "следующий незавершённый шаг — build");
assert(pausedB.run.status === "paused", "запуск приостановлен между шагами");
assert(stepStatus(runB.id, "prepare") === "passed", "завершённый шаг не откатывается");

const callsB = [];
let contextB = null;
const resultB = resume.resumeRunSync(runB.id, {
  handlers: {
    prepare: () => callsB.push("prepare"),
    build: (_step, ctx) => {
      callsB.push("build");
      contextB = ctx;
      return "built";
    },
    deploy: () => callsB.push("deploy"),
  },
});
assert(!callsB.includes("prepare"), "обработчик завершённого шага не вызывался");
assert(contextB.injections.length === 1, "build получил комментарий паузы");
assert(contextB.injections[0].author === "reviewer", "автор комментария виден обработчику");
assert(resultB.skipped.includes("prepare"), "prepare отмечен пропущенным");
assert(resultB.run.status === "passed", "цепочка после resume завершена успешно");

// --- 5. Явная адресация более позднему шагу ---------------------------------
const runC = createRun("pause-target", ["prepare", "build", "test"]);
const pausedC = context.pauseRun(runC.id, {
  stepName: "test",
  comment: "Only for the test step",
});
assert(pausedC.stepName === "test", "явно указанный шаг сохранён");
const seenC = {};
resume.resumeRunSync(runC.id, {
  handlers: {
    prepare: (_s, ctx) => (seenC.prepare = ctx.injections),
    build: (_s, ctx) => (seenC.build = ctx.injections),
    test: (_s, ctx) => (seenC.test = ctx.injections),
  },
});
assert(seenC.prepare.length === 0, "prepare не получил контекст для test");
assert(seenC.build.length === 0, "build не получил контекст для test");
assert(seenC.test.length === 1, "test получил адресованный ему контекст");

// --- 6. Пауза без контекста -------------------------------------------------
const runD = createRun("pause-empty", ["only"]);
const pausedD = context.pauseRun(runD.id, { author: "operator" });
assert(pausedD.injections.length === 0, "пауза без вложений не создаёт записей");
const resultD = resume.resumeRunSync(runD.id, {
  handlers: { only: () => "done" },
});
assert(resultD.run.status === "passed", "пауза без контекста возобновляется");

// --- 7. Ошибки паузы --------------------------------------------------------
const runE = createRun("pause-errors", ["prepare", "build"]);
assertThrows(
  () => context.pauseRun(runE.id, { stepName: "missing", comment: "x" }),
  "несуществующий шаг отклонён",
  "Шаг не найден",
);
journal.runStepStatefully(runE.id, "prepare", () => "ok");
assertThrows(
  () => context.pauseRun(runE.id, { stepName: "prepare", comment: "x" }),
  "завершённый шаг отклонён",
  "уже завершён",
);
context.pauseRun(runE.id, { comment: "after prepare" });
const resultE = resume.resumeRunSync(runE.id, {
  handlers: { prepare: () => "x", build: () => "y" },
});
assert(resultE.run.status === "passed", "запуск после resume завершён");
assertThrows(
  () => context.pauseRun(runE.id, { comment: "too late" }),
  "терминальный запуск нельзя поставить на паузу",
  "нельзя поставить на паузу",
);
void resultE;

const runF = createRun("pause-running", ["slow"]);
journal.beginStepAttempt(runF.id, "slow");
assertThrows(
  () => context.pauseRun(runF.id, { comment: "while running" }),
  "пауза во время выполняющегося шага отклонена",
  "уже выполняется",
);
journal.recordStepSuccess(runF.id, "slow", "done");

const runG = createRun("pause-nothing", []);
assertThrows(
  () => context.pauseRun(runG.id, { comment: "nothing to do" }),
  "запуск без незавершённых шагов отклонён",
  "нет незавершённых шагов",
);

assertThrows(
  () => context.pauseRun(createRun("pause-validation", ["step"]).id, { file: { path: "  " } }),
  "пустой путь файла отклонён",
  "Путь файла",
);
assertThrows(
  () =>
    context.pauseRun(createRun("pause-validation-2", ["step"]).id, {
      artifact: { name: "bad" },
    }),
  "артефакт без content отклонён",
  "content",
);
const longRun = createRun("pause-long", ["step"]);
assertThrows(
  () => context.pauseRun(longRun.id, { comment: "x".repeat(context.MAX_INJECTION_CONTENT + 1) }),
  "слишком длинный контекст отклонён",
  "слишком длинный",
);

// --- 8. Async-resume с контекстом ------------------------------------------
const runH = createRun("pause-async", ["alpha", "beta"]);
context.pauseRun(runH.id, { author: "async-reviewer", comment: "async note" });
let asyncContext = null;
const resultH = await resume.resumeRun(runH.id, {
  handlers: {
    alpha: async (_step, ctx) => {
      asyncContext = ctx;
      return "alpha-done";
    },
    beta: async () => "beta-done",
  },
});
assert(asyncContext.injections.length === 1, "async-обработчик получил вставку");
assert(asyncContext.injections[0].author === "async-reviewer", "async-обработчик видит автора");
assert(resultH.run.status === "passed", "async-resume завершил запуск");
assert(resultH.injected.length === 1, "async-resume отметил переданную вставку");

// --- 9. Каскадное удаление --------------------------------------------------
const runI = createRun("pause-cascade", ["step"]);
context.pauseRun(runI.id, { comment: "will be deleted" });
assert(context.listRunInjections(runI.id).length === 1, "вставка существует до удаления");
repo.deleteRun(runI.id);
assert(context.listRunInjections(runI.id).length === 0, "удаление запуска убирает вставки");

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("Пауза с контекстом: проверки завершены");
