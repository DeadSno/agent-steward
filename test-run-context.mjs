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
const capability = await import("./dist/db/capability-repo.js");

initDb(dbPath);

const createRun = (taskName, steps) =>
  repo.createRun({ taskName, steps: steps.map((stepName) => ({ stepName })) });
const stepStatus = (runId, name) => repo.getStep(runId, name)?.status;

// --- 1. Схема (run_injections с v7) ---------------------------------------
assert(SCHEMA_VERSION >= 7, `SCHEMA_VERSION не ниже v7 (${SCHEMA_VERSION})`);
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, `user_version = ${SCHEMA_VERSION}`);
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

// --- 10. ARCH-5.1: карта репозитория и отбор файлов по типу задачи ------------
const repoMap = context.buildRepoMap();
assert(repoMap.length > 0, "карта репозитория не пуста");
assert(
  new Set(repoMap.map((item) => item.path)).size === repoMap.length,
  "пути в карте уникальны",
);
assert(
  repoMap.some((item) => item.path === "src/db/run-context.ts"),
  "карта описывает компилятор контекста",
);
const selected = context.selectRepoFiles("Run Tests");
assert(
  selected.some((item) => item.path === "src/core/router/rules.ts"),
  "для run_tests отобран rules.ts",
);
assert(
  !selected.some((item) => item.path === "src/core/permissions.ts"),
  "для run_tests не отобран нерелевантный permissions.ts",
);
assert(
  selected.some((item) => item.critical),
  "в отборе есть критичные файлы",
);

// Gate-passed пример читается из ledger; проваленный вердикт игнорируется.
const evidenceFile = path.join(tempRoot, "gate-pass-example.txt");
fs.writeFileSync(evidenceFile, "gate example token=secretvalue run_tests");
repo.recordGateOutcome({
  outcomeKey: "arch5-example-pass",
  taskType: "run_tests",
  verdict: "pass",
  evidencePath: evidenceFile,
  createdAt: "2026-01-01T00:00:00.000Z",
});
repo.recordGateOutcome({
  outcomeKey: "arch5-example-fail",
  taskType: "run_tests",
  verdict: "fail",
  evidencePath: evidenceFile,
  createdAt: "2026-01-01T00:01:00.000Z",
});

// EV-2.1: learning-loop = карта задачи + gate-passed пример с известным runId.
const ev2Evidence = path.join(tempRoot, "ev2-learning-loop-example.txt");
fs.writeFileSync(ev2Evidence, "gate-passed ev2 learning-loop evidence");
capability.recordGateVerdict({
  outcomeKey: "ev21-learning-loop-pass",
  taskType: "run_tests",
  gateKey: "ev21-gate",
  verdict: "pass",
  attemptsToPass: 1,
  firstPass: true,
  runId: "ev21-source-run",
  evidencePath: ev2Evidence,
});
assert(
  capability.getCapability("run_tests") !== null,
  "EV-2.1: карта способности создана learning-loop",
);

const compileFiles = {
  "src/core/router/rules.ts": "export const RULES = 1; API_KEY=abc123",
  "src/core/router/dispatch.ts": "export function route() {}",
  "src/db/runs-repo.ts": "export const ledger = 1;",
  // Два файла с одинаковым содержимым — проверка дедупликации.
  "src/db/capability-repo.ts": "duplicate payload",
  "src/core/execution.ts": "duplicate payload",
  [evidenceFile]: "gate example token=secretvalue run_tests",
  [ev2Evidence]: "gate-passed ev2 learning-loop evidence",
};
const compileOptions = {
  taskType: "run_tests",
  model: "local-7b",
  files: compileFiles,
  maxFiles: 12,
  tokenBudget: 4000,
};

// --- 11. Дедуп / лимит / scrub ----------------------------------------------
const compiled = context.compileRunContext(compileOptions);
assert(compiled.compiledFrom === "ledger", "источник контекста — ledger");
assert(compiled.model === "local-7b", "модель зафиксирована в контексте");
assert(compiled.contextWindow === 8192, "окно local-7b — 8192 токенов");
assert(compiled.tokenBudget === 4000, "явный бюджет уважается");
assert(
  compiled.repoMap.length === context.REPO_MAP.length,
  "в контекст включена полная карта репозитория",
);
assert(
  compiled.files[0].path === "src/core/router/rules.ts",
  "файлы идут в порядке карты (детерминированно)",
);
assert(
  compiled.deduplicated.includes("src/core/execution.ts"),
  "дуб по содержимому устранён",
);
assert(
  compiled.files.length <= compileOptions.maxFiles,
  "соблюдён лимит количества файлов",
);
assert(
  !JSON.stringify(compiled).includes("abc123") &&
    !JSON.stringify(compiled).includes("secretvalue"),
  "секреты вырезаны из файлов и примеров",
);
assert(
  JSON.stringify(compiled).includes("API_KEY=***"),
  "присваивание секрета замаскировано",
);
assert(
  compiled.examples.length >= 1 &&
    compiled.examples[0].outcomeKey === "arch5-example-pass",
  "пример взят из gate-passed строки ledger",
);
assert(
  !compiled.examples.some((item) => item.outcomeKey === "arch5-example-fail"),
  "проваленный гейт в примеры не попал",
);
const ev2Example = compiled.examples.find(
  (item) => item.outcomeKey === "ev21-learning-loop-pass",
);
assert(
  ev2Example !== undefined &&
    ev2Example.learningLoop === true &&
    ev2Example.fromRunId === "ev21-source-run",
  "EV-2.1: пример помечен как learning-loop и адресует исходный runId",
);
assert(
  !compiled.examples.some((item) => item.learningLoop === false),
  "EV-2.1: все примеры этого типа помечены как learning-loop",
);

// EV-2.1: проверка реального переиспользования, а не только записи в карту.
const reusedKeys = compiled.examples.map((item) => item.outcomeKey);
const reuseOk = context.verifyExampleReuse(compiled, reusedKeys, "ev21-next-run");
assert(
  reuseOk.verified === true &&
    reuseOk.reason === "reused" &&
    reuseOk.examples.every(
      (item) => item.reused && item.usedInRunId === "ev21-next-run",
    ),
  "EV-2.1: все примеры реально переданы исполнителю",
);
assert(
  reuseOk.examples.some((item) => item.fromRunId === "ev21-source-run"),
  "EV-2.1: отчёт о переиспользовании сохраняет источник примера",
);
const reuseNone = context.verifyExampleReuse(compiled, []);
assert(
  reuseNone.verified === false && reuseNone.reason === "not-reused",
  "EV-2.1: пустой вызов исполнителя не считается переиспользованием",
);
const reusePartial = context.verifyExampleReuse(compiled, [reusedKeys[0]]);
assert(
  reusePartial.verified === false && reusePartial.reason === "partial",
  "EV-2.1: частичная передача примеров не считается полным переиспользованием",
);
assert(
  context.verifyExampleReuse({ ...compiled, examples: [] }, []).reason === "no-examples",
  "EV-2.1: отсутствие примеров явно фиксируется",
);

// Воспроизводимость: тот же ledger и параметры дают тот же хэш.
const compiledAgain = context.compileRunContext(compileOptions);
assert(
  compiledAgain.contextHash === compiled.contextHash,
  "повторная сборка даёт тот же contextHash",
);
assert(
  JSON.stringify(compiledAgain) === JSON.stringify(compiled),
  "контекст воспроизводим побайтово",
);

const limited = context.compileRunContext({
  ...compileOptions,
  maxFiles: 2,
  maxFileBytes: 20,
});
assert(limited.files.length <= 2, "лимит maxFiles=2 соблюдён");
assert(limited.truncated, "превышение лимита отмечено как усечение");
assert(limited.droppedFiles.length > 0, "отброшенные файлы перечислены");
assert(
  limited.files.every((item) => item.bytes <= 20),
  "лимит размера файла соблюдён",
);

// --- 12. ARCH-5.2: бюджет токенов без потери критичных файлов ---------------
const tight = context.compileRunContext({
  ...compileOptions,
  model: "local-3b",
  tokenBudget: 380,
});
assert(
  tight.estimatedTokens <= tight.tokenBudget,
  `бюджет 380 токенов соблюдён (${tight.estimatedTokens})`,
);
assert(tight.truncated, "малый бюджет вызвал усечение");
assert(
  tight.files.some((item) => item.critical),
  "критичные файлы сохранены при усечении бюджета",
);
assert(
  tight.files.every((item) => !item.critical || item.content.length > 0),
  "критичный файл не утерян полностью",
);

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("Пауза с контекстом: проверки завершены");
