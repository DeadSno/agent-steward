// Спринт 36.6: DLQ в GUI — список, причины, retry/discard через RPC-фасад.
//
// Проверяем:
//  - RPC-контракт list_dlq/retry_dlq/discard_dlq объявлен и связан с GUI;
//  - список отдаёт открытые записи и счётчик, фильтры open/retried/discarded/all;
//  - retry переоткрывает запуск, делает attempt + 1 и закрывает запись;
//  - повторная обработка закрытой записи возвращает success: false, а не падает;
//  - PL-97: retry с дескриптором сразу доигрывает шаг через resume;
//  - PL-97: без дескриптора запись остаётся открытой и возвращается диагностика;
//  - discard закрывает запись, не трогая статус шага;
//  - локали ru/en/zh содержат одинаковый набор ключей gui.dlq*;
//  - GUI использует только объявленные ключи.
//
// Запуск: node test-dlq-gui.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-dlq-gui-"));
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

const root = path.dirname(fileURLToPath(import.meta.url));

// --- 1. Контракт: RPC, обработчики, GUI ------------------------------------
const rpcSrc = fs.readFileSync(path.join(root, "src", "rpc.ts"), "utf8");
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
const guiSrc = fs.readFileSync(path.join(root, "src", "gui.tsx"), "utf8");

for (const method of ["list_dlq", "retry_dlq", "discard_dlq"]) {
  assert(new RegExp(`\\b${method}:\\s*\\{\\s*input:`).test(rpcSrc), `rpc.ts объявляет ${method}`);
  assert(new RegExp(`\\b${method}:\\s*async`).test(indexSrc), `index.ts обрабатывает ${method}`);
}

assert(
  /import\s*\{[^}]*listDlq[^}]*\}\s*from\s*"\.\/core\/dlq-api\.js"/.test(indexSrc),
  "index.ts использует RPC-фасад dlq-api",
);
assert(
  indexSrc.includes("retryDlqExecution(source.id)"),
  "PL-97: RPC retry_dlq вызывает исполняющий retryDlqExecution",
);

for (const method of ["list_dlq", "retry_dlq", "discard_dlq"]) {
  assert(guiSrc.includes(`rpc.${method}(`), `gui.tsx вызывает rpc.${method}`);
}

assert(guiSrc.includes("gui.dlqHeading"), "GUI рисует секцию DLQ");
assert(guiSrc.includes("handleRetryDlq") && guiSrc.includes("handleDiscardDlq"), "GUI имеет обработчики retry/discard");

// --- 2. Локали: одинаковый набор ключей gui.dlq* ---------------------------
const localesDir = path.join(root, "locales");
const localeKeys = {};
for (const locale of ["ru", "en", "zh"]) {
  const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), "utf8"));
  localeKeys[locale] = new Set(Object.keys(catalog).filter((key) => key.startsWith("gui.dlq")));
}
assert(localeKeys.ru.size > 0, "в ru есть ключи gui.dlq*");
for (const locale of ["en", "zh"]) {
  const missing = [...localeKeys.ru].filter((key) => !localeKeys[locale].has(key));
  const extra = [...localeKeys[locale]].filter((key) => !localeKeys.ru.has(key));
  assert(missing.length === 0, `${locale}: нет пропущенных gui.dlq* (${missing.join(", ") || "нет"})`);
  assert(extra.length === 0, `${locale}: нет лишних gui.dlq* (${extra.join(", ") || "нет"})`);
}

const usedKeys = new Set([...guiSrc.matchAll(/gt\("(gui\.dlq[^"]+)"/g)].map((m) => m[1]));
const unusedOrMissing = [...usedKeys].filter((key) => !localeKeys.ru.has(key));
assert(unusedOrMissing.length === 0, `все ключи из GUI есть в локалях (${unusedOrMissing.join(", ") || "нет"})`);

// --- 3. Функциональная проверка фасада -------------------------------------
const { initDb, closeDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const dlq = await import("./dist/db/run-dlq.js");
const api = await import("./dist/core/dlq-api.js");

initDb(dbPath);

function failStepN(runId, stepName, attempts) {
  for (let i = 0; i < attempts; i += 1) {
    const step = repo.getStep(runId, stepName);
    if (step.status === "failed") repo.retryStep(step.id);
    else repo.startStep(step.id);
    repo.finishStep(repo.getStep(runId, stepName).id, "failed", { error: `boom-${i + 1}` });
  }
}

const runA = repo.createRun({ taskName: "gui-dlq", steps: [{ stepName: "build" }, { stepName: "deploy" }] });
repo.startRun(runA.id);
failStepN(runA.id, "build", 3);
repo.finishRun(runA.id, "failed", { error: "build упал" });
const [entryA] = dlq.scanDeadLetters({ runId: runA.id });
assert(Boolean(entryA), "упавший шаг попал в DLQ");

const listOpen = api.listDlq({ status: "open" });
assert(listOpen.success, "listDlq(open) успешен");
assert(listOpen.entries.length === 1, "listDlq(open) отдаёт одну запись");
assert(listOpen.open === 1, "счётчик открытых = 1");
assert(listOpen.entries[0].reason === "attempts-exhausted", "причина — исчерпаны попытки");
assert(listOpen.entries[0].error === "boom-3", "ошибка шага видна в списке");

const listAll = api.listDlq({ status: "all", limit: 5 });
assert(listAll.entries.length === 1, "listDlq(all) видит запись");
const listBogus = api.listDlq({ status: "bogus" });
assert(listBogus.entries.length === 1, "неизвестный статус трактуется как open");
assert(api.listDlq({ limit: 0 }).entries.length === 1, "некорректный лимит заменяется дефолтом");

const retry = api.retryDlq(entryA.id);
assert(retry.success, "retryDlq успешен");
assert(retry.entry?.status === "retried", "запись закрыта как retried");
assert(retry.runReopened === true, "упавший запуск переоткрыт");
assert(retry.stepName === "build", "retry вернул имя шага");
assert(repo.getStep(runA.id, "build").status === "running", "шаг переведён в running");
assert(repo.getStep(runA.id, "build").attempt === 4, "attempt увеличен до 4");
assert(repo.getRun(runA.id).status === "running", "запуск снова running");
assert(api.listDlq({ status: "open" }).entries.length === 0, "открытых записей не осталось");

const retryAgain = api.retryDlq(entryA.id);
assert(retryAgain.success === false, "повторный retry закрытой записи не падает");
assert(Boolean(retryAgain.error), "повторный retry возвращает ошибку");

const runB = repo.createRun({ taskName: "gui-dlq-discard", steps: [{ stepName: "test" }] });
repo.startRun(runB.id);
failStepN(runB.id, "test", 3);
repo.finishRun(runB.id, "failed", { error: "test упал" });
const [entryB] = dlq.scanDeadLetters({ runId: runB.id });
const discarded = api.discardDlq(entryB.id, "не актуально");
assert(discarded.success, "discardDlq успешен");
assert(discarded.entry?.status === "discarded", "запись закрыта как discarded");
assert(discarded.entry?.resolution === "не актуально", "причина отказа сохранена");
assert(repo.getStep(runB.id, "test").status === "failed", "discard не трогает статус шага");
assert(api.listDlq({ status: "discarded" }).entries.length === 1, "фильтр discarded видит запись");
assert(api.listDlq({ status: "retried" }).entries.length === 1, "фильтр retried видит запись");

const missing = api.retryDlq("dlq_missing");
assert(missing.success === false, "retry несуществующей записи возвращает ошибку");
const missingDiscard = api.discardDlq("dlq_missing");
assert(missingDiscard.success === false, "discard несуществующей записи возвращает ошибку");

// --- 4. PL-97: DLQ → retry → finishStep --------------------------------------
const execution = await import("./dist/core/execution.js");
const execContext = execution.createAdHocRunContext("PL-97 dlq", {
  taskName: "pl97-dlq",
  cwd: tempRoot,
  taskType: "apply_diff",
});
const execPlan = await execution.buildExecutionPlan(execContext);
assert(execPlan.steps.length === 1, "PL-97: план состоит из одного шага");
const stepName = execPlan.steps[0].stepName;
const runC = repo.createRun({
  taskName: "pl97-dlq",
  steps: [{ stepName }],
  metadata: {
    durableExecution: {
      schema: 1,
      plan: execPlan,
      executor: { kind: "opencode" },
      evidencePath: null,
    },
  },
});
repo.startRun(runC.id);
failStepN(runC.id, stepName, 3);
repo.finishRun(runC.id, "failed", { error: "pl97 boom" });
const [entryC] = dlq.scanDeadLetters({ runId: runC.id });
assert(Boolean(entryC), "PL-97: упавший шаг попал в DLQ");

let pl97Invocations = 0;
const executedRetry = await api.retryDlqExecution(entryC.id, {
  invokeOpenCode: (input) => {
    pl97Invocations += 1;
    assert(input.prompt === execContext.prompt, "PL-97: исполнитель получил промпт из дескриптора");
    return "pl97 done";
  },
});
assert(executedRetry.success, "PL-97: retry сразу доиграл шаг");
assert(executedRetry.stepName === stepName, "PL-97: retry вернул имя шага");
assert(executedRetry.entry?.status === "retried", "PL-97: запись закрыта как retried");
assert(pl97Invocations === 1, "PL-97: исполнитель вызван один раз");
assert(repo.getStep(runC.id, stepName).status === "passed", "PL-97: шаг закрыт через finishStep");
assert(repo.getStep(runC.id, stepName).attempt === 4, "PL-97: attempt увеличен один раз (было 3)");
assert(repo.getRun(runC.id).status === "passed", "PL-97: запуск закрыт как passed");
assert(executedRetry.executed?.length === 1, "PL-97: executed содержит доигранный шаг");
const pl97Ledger = repo.listGateOutcomes(10000).filter((row) => row.runId === runC.id);
assert(pl97Ledger.length >= 1 && pl97Ledger.every((row) => row.verdict === "pass"), "PL-97: вердикт записан в ledger");
assert(
  (await api.retryDlqExecution(entryC.id)).success === false,
  "PL-97: повторный retry закрытой записи отклоняется",
);

// Без дескриптора: честный отказ, запись остаётся открытой для подготовительного retryDlq.
const runD = repo.createRun({ taskName: "pl97-no-descriptor", steps: [{ stepName: "build" }] });
repo.startRun(runD.id);
failStepN(runD.id, "build", 3);
repo.finishRun(runD.id, "failed", { error: "no descriptor" });
const [entryD] = dlq.scanDeadLetters({ runId: runD.id });
const noDescriptor = await api.retryDlqExecution(entryD.id);
assert(!noDescriptor.success, "PL-97: запуск без дескриптора отклоняется");
assert(
  String(noDescriptor.error).includes("durableExecution"),
  "PL-97: ошибка указывает на отсутствующий дескриптор",
);
assert(
  dlq.getDeadLetter(entryD.id).status === "open",
  "PL-97: запись без дескриптора остаётся открытой",
);

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("DLQ GUI: проверки завершены.");
