// Спринт 36.8: пауза и resume durable-запусков в GUI.
//
// Проверяем:
//  - RPC-контракт list_durable_runs/pause_durable_run/resume_durable_run
//    объявлен, обработан и используется GUI;
//  - панель отдаёт текущий шаг, прогресс и историю контекста;
//  - пауза с комментарием сохраняет автора и маскирует секреты;
//  - resume снимает паузу и готовит первый незавершённый шаг;
//  - пауза во время running-шага возвращает success: false (предупреждение);
//  - комментарий паузы доходит до следующего шага через resumeRun;
//  - локали ru/en/zh содержат одинаковый набор ключей gui.runs*.
//
// Запуск: node test-pause-gui.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-pause-gui-"));
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

for (const method of [
  "list_durable_runs",
  "pause_durable_run",
  "resume_durable_run",
  "list_approvals",
  "decide_approval",
]) {
  assert(new RegExp(`\\b${method}:\\s*\\{\\s*input:`).test(rpcSrc), `rpc.ts объявляет ${method}`);
  assert(new RegExp(`\\b${method}:\\s*async`).test(indexSrc), `index.ts обрабатывает ${method}`);
  assert(guiSrc.includes(`rpc.${method}(`), `gui.tsx вызывает rpc.${method}`);
}

// QA-P3.8: при ошибке pause/resume поле `paused` отражает реальное состояние,
// а не запрошенное действие.
assert(
  /message: t\("tool\.error\.taskNotFound"[\s\S]{0,600}paused: false/.test(indexSrc),
  "QA-P3.8: несуществующая задача возвращает paused:false",
);
assert(
  (indexSrc.match(/paused: definition\.paused \?\? false/g) ?? []).length >= 3,
  "QA-P3.8: error-ветки берут paused из определения задачи",
);

assert(
  /import\s*\{[^}]*listRunPanel[^}]*\}\s*from\s*"\.\/core\/run-panel-api\.js"/.test(indexSrc),
  "index.ts использует RPC-фасад run-panel-api",
);
assert(guiSrc.includes("gui.runsHeading"), "GUI рисует секцию запусков");
assert(
  guiSrc.includes("handlePauseRun") && guiSrc.includes("handleResumeRun"),
  "GUI имеет обработчики pause/resume",
);
assert(guiSrc.includes("gui.runsRunningWarning"), "GUI показывает предупреждение о running-шаге");
assert(guiSrc.includes("gui.approvalsHeading"), "GUI рисует секцию одобрений");
assert(
  guiSrc.includes("handleApprovalDecision") && guiSrc.includes("approvalRecords"),
  "GUI имеет состояние и обработчик решений по одобрениям",
);

// QA-C.1: счётчик времени запуска сбрасывается, таймер очищается.
assert(
  /const runningTimer = setInterval\(\(\) => setRunningSec/.test(guiSrc),
  "GUI сохраняет интервал счётчика runningSec в переменную",
);
assert(
  /onCleanup\(\(\) => \{[\s\S]*?clearInterval\(runningTimer\)/.test(guiSrc),
  "GUI очищает интервал runningSec в onCleanup",
);
assert(
  guiSrc.includes("const previousStatuses = new Map") &&
    guiSrc.includes('previousStatuses.get(j.name) !== "running"') &&
    guiSrc.includes("setRunningSec(0)"),
  "GUI сбрасывает счётчик при переходе задачи в running",
);
assert(
  !guiSrc.includes('href={`#${run.currentStep') &&
    guiSrc.includes("<button") &&
    guiSrc.includes("scrollIntoView(") &&
    guiSrc.includes('behavior: "smooth"') &&
    guiSrc.includes('block: "center"'),
  "GUI не меняет hash для текущего шага (нет Unrecognised route)",
);

// --- 2. Локали: одинаковый набор ключей gui.runs* ---------------------------
const localesDir = path.join(root, "locales");
const localeKeys = {};
const catalogs = {};
for (const locale of ["ru", "en", "zh"]) {
  const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), "utf8"));
  catalogs[locale] = catalog;
  localeKeys[locale] = new Set(Object.keys(catalog).filter((key) => key.startsWith("gui.runs")));
}
assert(localeKeys.ru.size > 0, "в ru есть ключи gui.runs*");
for (const locale of ["en", "zh"]) {
  const missing = [...localeKeys.ru].filter((key) => !localeKeys[locale].has(key));
  const extra = [...localeKeys[locale]].filter((key) => !localeKeys.ru.has(key));
  assert(missing.length === 0, `${locale}: нет пропущенных gui.runs* (${missing.join(", ") || "нет"})`);
  assert(extra.length === 0, `${locale}: нет лишних gui.runs* (${extra.join(", ") || "нет"})`);
}

const usedKeys = new Set(
  [...guiSrc.matchAll(/gt\("(gui\.runs[^"]*)"/g)].map((match) => match[1]),
);
for (const key of usedKeys) {
  for (const locale of ["ru", "en", "zh"]) {
    assert(
      typeof catalogs[locale][key] === "string" && catalogs[locale][key].length > 0,
      `${locale}: ключ ${key} непустой`,
    );
  }
}

// PL-95: паритет ключей gui.approvals* и всех ключей, используемых в GUI.
const approvalKeys = new Set(
  Object.keys(catalogs.ru).filter((key) => key.startsWith("gui.approvals")),
);
assert(approvalKeys.size > 0, "в ru есть ключи gui.approvals*");
for (const locale of ["en", "zh"]) {
  const missing = [...approvalKeys].filter((key) => !(key in catalogs[locale]));
  assert(missing.length === 0, `${locale}: нет пропущенных gui.approvals* (${missing.join(", ") || "нет"})`);
}
const usedApprovalKeys = new Set(
  [...guiSrc.matchAll(/gt\("(gui\.approvals[^"]*)"/g)].map((match) => match[1]),
);
for (const key of usedApprovalKeys) {
  for (const locale of ["ru", "en", "zh"]) {
    assert(
      typeof catalogs[locale][key] === "string" && catalogs[locale][key].length > 0,
      `${locale}: ключ ${key} непустой`,
    );
  }
}

// --- 3. Функциональные проверки фасада -------------------------------------
const { initDb, closeDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const journal = await import("./dist/db/run-journal.js");
const resume = await import("./dist/db/run-resume.js");
const panel = await import("./dist/core/run-panel-api.js");
const execution = await import("./dist/core/execution.js");

initDb(dbPath);

const createRun = (taskName, steps) =>
  repo.createRun({ taskName, steps: steps.map((stepName) => ({ stepName })) });

// 3.1. Список: текущий шаг и прогресс.
const runA = createRun("pause-gui", ["prepare", "build", "deploy"]);
const listA = panel.listRunPanel();
assert(listA.success, "listRunPanel успешен");
assert(listA.active >= 1, "активный запуск посчитан");
const entryA = listA.runs.find((run) => run.id === runA.id);
assert(Boolean(entryA), "новый запуск виден в панели");
assert(entryA.totalSteps === 3 && entryA.doneSteps === 0, "прогресс 0/3");
assert(entryA.currentStep?.stepName === "prepare", "текущий шаг — prepare");
assert(entryA.currentStep.position === 0, "позиция текущего шага");
assert(entryA.currentStep.anchor.startsWith("run-step-"), "у шага есть якорь для ссылки");
assert(entryA.injections.length === 0, "история контекста пуста до паузы");

// 3.2. Пауза с комментарием: автор и маскирование.
const paused = panel.pauseRunPanel(runA.id, {
  comment: "Staging only. API_KEY=super-secret-value",
  author: "gui",
});
assert(paused.success, "pauseRunPanel успешен");
assert(paused.run.status === "paused", "запуск переведён в paused");
assert(paused.stepName === "prepare", "контекст адресован текущему шагу");
assert(paused.run.currentStep?.stepName === "prepare", "текущий шаг не сдвинулся");
assert(paused.run.injections.length === 1, "комментарий попал в историю");
assert(paused.run.injections[0].author === "gui", "автор комментария виден");
assert(
  !paused.run.injections[0].content.includes("super-secret-value"),
  "секрет в комментарии замаскирован",
);
assert(paused.run.pendingInjections === 1, "комментарий ожидает resume");

const listPaused = panel.listRunPanel({ filter: "paused" });
assert(
  listPaused.runs.some((run) => run.id === runA.id),
  "фильтр paused показывает запуск",
);
const listActive = panel.listRunPanel({ filter: "active" });
assert(
  listActive.runs.some((run) => run.id === runA.id),
  "фильтр active включает paused",
);

// --- 3.2.1. QA-DAG-1: stale-запуски не считаются активными -------------------
const freshRun = repo.getRun(runA.id);
const nowMs = Date.now();
assert(
  panel.isActiveRun(freshRun, nowMs),
  "isActiveRun: свежий запуск с активным статусом активен",
);
assert(
  !panel.isActiveRun(freshRun, nowMs + 7 * 60 * 60 * 1000),
  "isActiveRun: запуск старше порога не активен",
);
assert(
  !panel.isActiveRun({ ...freshRun, status: "success" }, nowMs),
  "isActiveRun: терминальный статус не активен",
);
assert(
  panel.isActiveRun({ ...freshRun, updatedAt: "not-a-date" }, nowMs),
  "isActiveRun: неразбираемая дата не откидывает запуск (fail-open)",
);

// 3.3. Resume: снимает паузу и готовит шаг.
const resumed = panel.resumeRunPanel(runA.id);
assert(resumed.success, "resumeRunPanel успешен");
assert(resumed.run.status === "running", "resume переводит запуск в running");
assert(resumed.prepared === true, "resume помечает запуск как подготовленный");
assert(resumed.stepName === "prepare", "resume возвращает следующий шаг");
const resumedAgain = panel.resumeRunPanel(runA.id);
assert(!resumedAgain.success, "повторный resume running-запуска отклонён");
assert(
  String(resumedAgain.error).includes("нельзя возобновить"),
  "ошибка повторного resume понятна",
);

// 3.4. Комментарий доходит до шага через resumeRun.
const seen = {};
const executed = resume.resumeRunSync(runA.id, {
  handlers: {
    prepare: (_step, ctx) => {
      seen.prepare = ctx.injections;
      return "ok";
    },
    build: (_step, ctx) => {
      seen.build = ctx.injections;
      return "ok";
    },
    deploy: (_step, ctx) => {
      seen.deploy = ctx.injections;
      return "ok";
    },
  },
});
assert(executed.run.status === "passed", "после resumeRun запуск завершён");
assert(seen.prepare.length === 1, "prepare получил комментарий из GUI");
assert(seen.prepare[0].author === "gui", "шаг видит автора комментария");
assert(
  !seen.prepare[0].content.includes("super-secret-value"),
  "шаг получает замаскированный текст",
);
assert(seen.build.length === 0, "следующий шаг не получает чужой контекст");
const after = panel.listRunPanel({ filter: "all" }).runs.find((run) => run.id === runA.id);
assert(after.pendingInjections === 0, "после выполнения контекст потреблён");
assert(after.injections[0].consumedByStep === "prepare", "история показывает получателя");

// 3.4.1 PL-92: resume реально доигрывает шаги по metadata.durableExecution.
const execContext = execution.createAdHocRunContext("PL-92 resume", {
  taskName: "pl92-resume",
  cwd: tempRoot,
  taskType: "apply_diff",
});
const execPlan = await execution.buildExecutionPlan(execContext);
assert(execPlan.steps.length === 1, "PL-92: план состоит из одного шага");
const durableRun = repo.createRun({
  taskName: "pl92-resume",
  steps: execPlan.steps.map((step) => ({ stepName: step.stepName })),
  metadata: {
    durableExecution: {
      schema: 1,
      plan: execPlan,
      executor: { kind: "opencode" },
      evidencePath: null,
    },
  },
});
repo.startRun(durableRun.id);
const durablePause = panel.pauseRunPanel(durableRun.id, {
  comment: "PL-92 injection",
  author: "test",
});
assert(durablePause.success, "PL-92: пауза перед возобновлением");
let invocations = 0;
const durableResume = await panel.resumeDurableRunExecution(durableRun.id, {
  invokeOpenCode: (input) => {
    invocations += 1;
    assert(input.prompt === execContext.prompt, "PL-92: исполнитель получил промпт из плана");
    return "done";
  },
});
assert(durableResume.success, "PL-92: resume выполнил шаг, а не только переоткрыл запуск");
assert(invocations === execPlan.steps.length, "PL-92: исполнитель вызван для каждого шага");
assert(durableResume.executed?.length === execPlan.steps.length, "PL-92: шаги отмечены выполненными");
assert(durableResume.run.status === "passed", "PL-92: запуск закрыт как passed");
const durableGateRows = repo.listGateOutcomes(10000).filter((row) => row.runId === durableRun.id);
assert(durableGateRows.length >= 1, "PL-92: вердикт возобновлённого шага попал в ledger");
assert(durableGateRows.every((row) => row.verdict === "pass"), "PL-92: вердикт pass");
const noDescriptor = await panel.resumeDurableRunExecution(runA.id);
assert(
  !noDescriptor.success && String(noDescriptor.error).includes("durableExecution"),
  "PL-92: запуск без дескриптора честно отклоняется",
);

// 3.5. Пауза во время running-шага возвращает предупреждение.
const runB = createRun("pause-gui-running", ["slow"]);
journal.beginStepAttempt(runB.id, "slow");
const runningPause = panel.pauseRunPanel(runB.id, { comment: "too early" });
assert(!runningPause.success, "пауза running-шага отклонена");
assert(
  String(runningPause.error).includes("уже выполняется"),
  "ошибка паузы сообщает о running-шаге",
);
journal.recordStepSuccess(runB.id, "slow", "done");

// 3.6. Resume после failed.
const runC = createRun("pause-gui-failed", ["step"]);
repo.startRun(runC.id);
repo.finishRun(runC.id, "failed", { error: "boom" });
const failedResume = panel.resumeRunPanel(runC.id);
assert(failedResume.success, "failed-запуск можно возобновить");
assert(failedResume.run.status === "running", "failed-запуск переоткрыт");
assert(failedResume.stepName === "step", "resume указывает упавший шаг");

// 3.7. Лимит и отсутствующий запуск.
assert(panel.listRunPanel({ limit: 1 }).runs.length === 1, "лимит списка соблюдается");
assert(panel.listRunPanel({ filter: "bogus" }).success, "неизвестный фильтр безопасен");
const missing = panel.resumeRunPanel("does-not-exist");
assert(!missing.success && String(missing.error).includes("не найден"), "resume неизвестного запуска отклонён");

// PL-95: очередь одобрений через фасад (журнал аудита, без новой таблицы).
const approvals = await import("./dist/core/approval-api.js");
const audit = await import("./dist/core/audit.js");
const approvalRequestId = `pl95-${Date.now()}`;
const createdApproval = audit.requestApproval({
  requestId: approvalRequestId,
  taskName: "pl95-high-risk",
  riskClass: "high",
  reason: "PL-95 regression",
  actor: "test",
});
assert(createdApproval?.requestId === approvalRequestId, "PL-95: запрос одобрения создан");
const approvalList = approvals.listApprovalPanel({ limit: 50 });
assert(approvalList.success, "PL-95: listApprovalPanel успешен");
assert(
  approvalList.approvals.some((item) => item.requestId === approvalRequestId && item.status === "pending"),
  "PL-95: pending-запрос виден в списке",
);
assert(approvals.listApprovalPanel({ limit: 0 }).approvals.length >= 1, "PL-95: лимит ограничен снизу");
assert(approvals.listApprovalPanel({ limit: 99999 }).approvals.length <= 500, "PL-95: лимит ограничен сверху");
assert(
  !(await approvals.decideApprovalPanel("", "approve")).success,
  "PL-95: пустой requestId отклонён",
);
assert(
  !(await approvals.decideApprovalPanel(approvalRequestId, "maybe")).success,
  "PL-95: неизвестное решение отклонено",
);
const decided = await approvals.decideApprovalPanel(approvalRequestId, "approve", "gui");
assert(decided.success && decided.approval?.status === "approved", "PL-95: решение approve сохранено");
assert(
  approvals.listApprovalPanel().approvals.find((item) => item.requestId === approvalRequestId)?.decidedBy === "gui",
  "PL-95: автор решения виден в списке",
);
const duplicate = await approvals.decideApprovalPanel(approvalRequestId, "reject", "gui");
assert(
  duplicate.success && duplicate.approval?.status === "approved",
  "PL-95: первое решение не перезаписывается",
);
assert(
  !(await approvals.decideApprovalPanel("pl95-unknown", "approve")).success,
  "PL-95: неизвестный запрос отклонён",
);

// PL-103: approve через фасад доигрывает отложенный план без эффектов.
const pl103Calls = [];
const pl103Executor = {
  id: "opencode",
  descriptor: { kind: "opencode" },
  supports: () => true,
  execute: async ({ step }) => {
    pl103Calls.push(step.stepName);
    return { output: "pl103-ok" };
  },
};
const makePl103Plan = (taskName) =>
  execution.buildExecutionPlan(
    execution.createAdHocRunContext("run tests; write file", {
      taskName,
      cwd: tempRoot,
      riskClass: "R2",
    }),
  );
const pl103Key = "pl103-auto-key";
const pl103Pending = await execution.executeExecutionPlan(await makePl103Plan("pl103-auto"), {
  executors: [pl103Executor],
  approval: { approvalKey: pl103Key, runRef: "pl103-auto-ref", reason: "PL-103", actor: "gui" },
});
assert(
  pl103Pending.status === "awaiting_approval" && pl103Pending.runId === null,
  "PL-103: до approve run не создан",
);
assert(
  audit.readAuditLog({ action: audit.APPROVAL_PENDING_EXECUTION_ACTION, target: pl103Key }).total === 1,
  "PL-103: отложенный план сохранён в аудите",
);
const pl103Decided = await approvals.decideApprovalPanel(pl103Key, "approve", "gui", {
  executors: [pl103Executor],
});
assert(
  pl103Decided.success && pl103Decided.restart === "auto" && typeof pl103Decided.restartRunId === "string",
  "PL-103: approve запустил отложенный план",
);
const pl103ExpectedCalls = pl103Pending.plan.steps.filter((step) => step.route.executor !== null).length;
assert(
  pl103Calls.length === pl103ExpectedCalls,
  "PL-103: исполнитель вызван по разу на каждый шаг плана",
);
assert(
  repo.getRun(pl103Decided.restartRunId)?.status === "passed",
  "PL-103: созданный run завершён passed",
);
assert(
  audit.readAuditLog({ action: audit.APPROVAL_EXECUTION_STARTED_ACTION, target: pl103Key }).total === 1,
  "PL-103: факт старта зафиксирован в аудите",
);
const pl103Duplicate = await approvals.decideApprovalPanel(pl103Key, "approve", "gui", {
  executors: [pl103Executor],
});
assert(
  pl103Duplicate.success &&
    pl103Duplicate.restart === "skipped" &&
    pl103Calls.length === pl103ExpectedCalls,
  "PL-103: повторное одобрение не дублирует запуск",
);

const pl103RejectKey = "pl103-reject-key";
await execution.executeExecutionPlan(await makePl103Plan("pl103-reject"), {
  executors: [pl103Executor],
  approval: { approvalKey: pl103RejectKey },
});
const pl103Rejected = await approvals.decideApprovalPanel(pl103RejectKey, "reject", "gui");
assert(
  pl103Rejected.success && pl103Rejected.restart === "skipped" && repo.listRuns("pl103-reject", 50).length === 0,
  "PL-103: reject не запускает план",
);

const pl103ManualKey = "pl103-manual-key";
const pl103ManualPending = await execution.executeExecutionPlan(await makePl103Plan("pl103-manual"), {
  executors: [pl103Executor],
  effects: [
    {
      id: "pl103-manual-effect",
      reversibility: "reversible",
      apply: () => {},
      compensate: () => {},
    },
  ],
  approval: { approvalKey: pl103ManualKey },
});
assert(pl103ManualPending.status === "awaiting_approval", "PL-103: план с эффектами тоже ждёт одобрения");
const pl103Manual = await approvals.decideApprovalPanel(pl103ManualKey, "approve", "gui", {
  executors: [pl103Executor],
});
assert(
  pl103Manual.success &&
    pl103Manual.restart === "manual" &&
    String(pl103Manual.restartError).includes("вручную") &&
    repo.listRuns("pl103-manual", 50).length === 0,
  "PL-103: план с эффектами честно требует ручного перезапуска",
);
assert(
  audit.readAuditLog({ action: audit.APPROVAL_PENDING_EXECUTION_ACTION, target: pl103ManualKey }).total === 0,
  "PL-103: план с эффектами не сохраняется для авто-старта",
);

// QA-B.4: бюджеты доступны и в дашборде, а не только через RPC.
const guiSource = fs.readFileSync("./src/gui.tsx", "utf8");
for (const [needle, label] of [
  ["interface BudgetSettings", "тип настроек бюджетов"],
  ["budgetEnabled", "сигнал включения бюджетов"],
  ["budgetDailyUsd", "сигнал дневного лимита"],
  ["budgetWeeklyUsd", "сигнал недельного лимита"],
  ["budgets?: BudgetSettings", "patch save_settings с бюджетами"],
  ["saveBudgetSettings()", "сохранение бюджетов из GUI"],
  ['gt("gui.budgetsHeading")', "карточка бюджетов"],
]) {
  assert(guiSource.includes(needle), `gui.tsx: ${label} присутствует`);
}
for (const locale of ["ru", "en", "zh"]) {
  const dict = JSON.parse(fs.readFileSync(`./locales/${locale}.json`, "utf8"));
  assert(dict["gui.budgetsHeading"], `locales/${locale}.json: ключ gui.budgetsHeading`);
}

closeDb();
fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("Пауза и resume в GUI: проверки завершены");
