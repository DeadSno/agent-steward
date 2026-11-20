/**
 * AC-1: единый путь createRun → план → маршрут → исполнение → GATE → ledger.
 *
 * Тест не регистрирует задачи в ОС: зарегистрированная задача и ad-hoc миссия
 * проходят один и тот же код, а транспорт подменён исполнителем.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`OK: ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ac1-"));
const dbPath = path.join(tempRoot, "ac1.db");

const { initDb, closeDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const ac1 = await import("./dist/core/execution.js");

initDb(dbPath);

// --- 1. AC-1.1: контракт RunContext -----------------------------------------
const registered = ac1.createRegisteredRunContext({
  name: "registered-report",
  prompt: "run tests; write file",
  workingDirectory: tempRoot,
  model: "local/model",
  allowedTools: ["read"],
  deniedTools: ["shell"],
  qualityGate: "npm test",
});
check("registered: origin = registered", registered.origin === "registered");
check("registered: mission = prompt", registered.mission === registered.prompt);
check("registered: cwd из definition", registered.cwd === tempRoot);
check("registered: профиль и модель", registered.profile.model === "local/model");
check("registered: safety policy по умолчанию hybrid", registered.safety.policy === "hybrid");
check("registered: allowed/denied разведены", registered.safety.allowedTools[0] === "read" && registered.safety.deniedTools[0] === "shell");
check("registered: qualityGate в metadata", registered.metadata.qualityGate === "npm test");

const adhoc = ac1.createAdHocRunContext("run tests; write file", {
  taskName: "adhoc-report",
  cwd: tempRoot,
  policy: "secure",
});
check("ad-hoc: origin = ad-hoc", adhoc.origin === "ad-hoc");
check("ad-hoc: имя из overrides", adhoc.taskName === "adhoc-report");
check("ad-hoc: policy secure", adhoc.safety.policy === "secure");
check("ad-hoc: session = new", adhoc.profile.session === "new");

let emptyMissionRejected = false;
try {
  ac1.createAdHocRunContext("   ");
} catch {
  emptyMissionRejected = true;
}
check("ad-hoc: пустая миссия отклонена", emptyMissionRejected);

let conflictRejected = false;
try {
  ac1.validateRunContext({
    ...adhoc,
    safety: { policy: "hybrid", allowedTools: ["read"], deniedTools: ["read"] },
  });
} catch {
  conflictRejected = true;
}
check("validate: инструмент не может быть разрешён и запрещён", conflictRejected);

let badPolicyRejected = false;
try {
  ac1.validateRunContext({
    ...adhoc,
    safety: { policy: "anything" },
  });
} catch {
  badPolicyRejected = true;
}
check("validate: неизвестная политика отклонена", badPolicyRejected);

// --- 2. AC-1.3: план и трассировка без исполнения ---------------------------
const registeredPlan = await ac1.buildExecutionPlan(registered);
const adhocPlan = await ac1.buildExecutionPlan(adhoc);

check("plan: зарегистрированная задача разложена на 2 шага", registeredPlan.steps.length === 2);
check("plan: ad-hoc разложен на 2 шага", adhocPlan.steps.length === 2);
check(
  "plan: одинаковые шаги у registered и ad-hoc",
  registeredPlan.steps.map((s) => s.taskType).join(",") === adhocPlan.steps.map((s) => s.taskType).join(","),
);
check(
  "plan: run tests маршрутизирован local/direct",
  registeredPlan.steps[0].route.target === "local" &&
    registeredPlan.steps[0].route.transport === "direct",
);
check(
  "plan: write file маршрутизирован local/direct",
  registeredPlan.steps[1].route.target === "local",
);
check("plan: источник эвристики", registeredPlan.source === "heuristic");
check("plan: предупреждений нет", registeredPlan.warnings.length === 0);

const trace = ac1.describeExecutionPlan(registeredPlan);
check("trace: содержит имя задачи", trace.includes("registered-report"));
check("trace: содержит маршрут local/direct", trace.includes("local/direct"));
check("trace: содержит оба шага", trace.includes("run tests") && trace.includes("write file"));
check("dry-run не создал запуск", repo.listRuns("registered-report", 10).length === 0);

// --- 3. AC-1.4: registered и ad-hoc проходят один путь -----------------------
const calls = [];
const executor = {
  id: "fake",
  supports: (route) => route.executor !== null,
  execute: ({ step, context }) => {
    calls.push({ step: step.stepName, origin: context.origin });
    return { output: { step: step.stepName, origin: context.origin } };
  },
};

const registeredRun = await ac1.executeExecutionPlan(registeredPlan, { executors: [executor] });
const adhocRun = await ac1.executeExecutionPlan(adhocPlan, { executors: [executor] });

check("execute: registered завершён passed", registeredRun.status === "passed");
check("execute: ad-hoc завершён passed", adhocRun.status === "passed");
check(
  "execute: оба запуска исполнили одинаковые шаги",
  registeredRun.steps.map((s) => s.stepName).join(",") === adhocRun.steps.map((s) => s.stepName).join(","),
);
check(
  "execute: один исполнитель получил оба origin",
  calls.some((c) => c.origin === "registered") && calls.some((c) => c.origin === "ad-hoc"),
);
check(
  "ledger: registered run записан",
  repo.getRun(registeredRun.runId)?.status === "passed",
);
check(
  "ledger: все шаги registered passed",
  repo.listRunSteps(registeredRun.runId).every((s) => s.status === "passed"),
);
check(
  "ledger: output шага сохранён",
  JSON.stringify(repo.getStep(registeredRun.runId, "run tests")?.output) ===
    JSON.stringify({ step: "run tests", origin: "registered" }),
);
check(
  "ledger: metadata содержит origin и маршруты",
  repo.getRun(adhocRun.runId)?.metadata?.origin === "ad-hoc" &&
    Array.isArray(repo.getRun(adhocRun.runId)?.metadata?.routes),
);
check(
  "execute: attempt = 1 у первого шага",
  registeredRun.steps[0].attempt === 1,
);

// --- 4. GATE отклоняет результат -------------------------------------------
const gatePlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("run tests; write file", { taskName: "gate-report", cwd: tempRoot }),
);
const gateRun = await ac1.executeExecutionPlan(gatePlan, {
  executors: [executor],
  gate: ({ step }) =>
    step.stepName === "write file" ? { ok: false, reason: "GATE: запись запрещена" } : { ok: true },
});

check("gate: запуск failed", gateRun.status === "failed");
check("gate: первый шаг passed", gateRun.steps[0].status === "passed");
check("gate: второй шаг failed", gateRun.steps[1].status === "failed");
check("gate: причина сохранена", gateRun.error?.includes("GATE: запись запрещена"));
check("gate: шаг failed в ledger", repo.getStep(gateRun.runId, "write file")?.status === "failed");

// --- 5. review/explore пропускается, а не исполняется ----------------------
const reviewPlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("сделай что-то неведомое", {
    taskName: "review-report",
    cwd: tempRoot,
    taskType: "totally_unknown_task",
  }),
);
check("plan: неизвестный тип уходит в explore", reviewPlan.steps[0].route.target === "explore");
check("plan: предупреждение о пропуске", reviewPlan.warnings.length === 1);
const reviewRun = await ac1.executeExecutionPlan(reviewPlan, { executors: [executor] });
check("review: запуск passed", reviewRun.status === "passed");
check("review: шаг skipped", reviewRun.steps[0].status === "skipped");
check(
  "review: статус skipped в ledger",
  repo.getStep(reviewRun.runId, reviewRun.steps[0].stepName)?.status === "skipped",
);

// --- 6. AC-1.2: OpenCode-исполнитель не зависит от ядра -------------------
const invocations = [];
const opencode = ac1.createOpenCodeExecutor((input) => {
  invocations.push(input);
  return `done: ${input.step.taskType}`;
});
const opencodeRun = await ac1.executeExecutionPlan(registeredPlan, { executors: [opencode] });
check("opencode: исполнитель поддерживает local", opencode.supports(registeredPlan.steps[0].route));
check("opencode: план выполнен", opencodeRun.status === "passed");
check("opencode: получил промпт и cwd", invocations[0].prompt === registeredPlan.context.prompt && invocations[0].cwd === tempRoot);
check("opencode: получил модель", invocations[0].model === "local/model");
check("opencode: output сохранён", invocations[0].step.taskType === "run_tests");

// --- 7. G-1.2: snapshot и хэш входов Quality Gate ---------------------------
const gateIntegrity = await import("./dist/core/gate-integrity.js");
const snapshotFile = path.join(tempRoot, "gate-snapshot.json");
const gateInputs = { gate: "npm test", prompt: "implement feature", gateTimeoutSeconds: 300 };
const firstHash = gateIntegrity.gateInputsHash(gateInputs);
check(
  "gate-integrity: хэш детерминирован",
  firstHash === gateIntegrity.gateInputsHash({ ...gateInputs }) && /^[0-9a-f]{64}$/.test(firstHash),
);
check(
  "gate-integrity: изменение gate меняет хэш",
  gateIntegrity.gateInputsHash({ ...gateInputs, gate: "exit 0" }) !== firstHash,
);
check(
  "gate-integrity: изменение prompt меняет хэш",
  gateIntegrity.gateInputsHash({ ...gateInputs, prompt: "forge" }) !== firstHash,
);
check(
  "gate-integrity: изменение таймаута меняет хэш",
  gateIntegrity.gateInputsHash({ ...gateInputs, gateTimeoutSeconds: 1 }) !== firstHash,
);

check("gate-integrity: snapshot создан", gateIntegrity.createGateSnapshot("g12", gateInputs, snapshotFile) === snapshotFile);
check("gate-integrity: snapshot прочитан", gateIntegrity.readGateSnapshot(snapshotFile)?.hash === firstHash);
check("gate-integrity: исходные входы верифицируются", gateIntegrity.verifyGateSnapshot(snapshotFile, gateInputs).ok === true);
const tamperedGate = gateIntegrity.verifyGateSnapshot(snapshotFile, { ...gateInputs, gate: "exit 0" });
check("gate-integrity: подмена gate-команды → fail", tamperedGate.ok === false && /изменены/.test(tamperedGate.reason ?? ""));
check(
  "gate-integrity: подмена prompt → fail",
  gateIntegrity.verifyGateSnapshot(snapshotFile, { ...gateInputs, prompt: "forge" }).ok === false,
);
check(
  "gate-integrity: подмена таймаута → fail",
  gateIntegrity.verifyGateSnapshot(snapshotFile, { ...gateInputs, gateTimeoutSeconds: 1 }).ok === false,
);
check(
  "gate-integrity: отсутствующий snapshot → fail",
  gateIntegrity.verifyGateSnapshot(path.join(tempRoot, "missing.json"), gateInputs).ok === false,
);
const invalidSnapshot = path.join(tempRoot, "invalid-snapshot.json");
fs.writeFileSync(invalidSnapshot, JSON.stringify({ version: 2, hash: firstHash }), "utf8");
check("gate-integrity: неверная версия snapshot → fail", gateIntegrity.verifyGateSnapshot(invalidSnapshot, gateInputs).ok === false);

const integrityCli = path.resolve("dist/core/gate-integrity.js");
const cliPromptFile = path.join(tempRoot, "gate-prompt.txt");
fs.writeFileSync(cliPromptFile, gateInputs.prompt, "utf8");
const cliVerify = spawnSync(
  process.execPath,
  [integrityCli, "verify", "--snapshot", snapshotFile, "--gate-command", "npm test", "--prompt-file", cliPromptFile, "--timeout", "300"],
  { encoding: "utf8", windowsHide: true },
);
check("gate-integrity: CLI verify — корректные входы → 0", cliVerify.status === 0);
const cliAttack = spawnSync(
  process.execPath,
  [integrityCli, "verify", "--snapshot", snapshotFile, "--gate-command", "exit 0", "--prompt-file", cliPromptFile, "--timeout", "300"],
  { encoding: "utf8", windowsHide: true },
);
check("gate-integrity: CLI verify — атака (подмена gate) → 1", cliAttack.status === 1);
const cliBadArgs = spawnSync(process.execPath, [integrityCli, "verify"], { encoding: "utf8", windowsHide: true });
check("gate-integrity: CLI verify — плохие аргументы → 2", cliBadArgs.status === 2);

// --- PL-25: worktree snapshot защищает гейт от чужих незакоммиченных правок ---
const guardRepo = path.join(tempRoot, "guard-repo");
const runGit = (args) => spawnSync("git", ["-C", guardRepo, ...args], { encoding: "utf8", windowsHide: true });
fs.mkdirSync(path.join(guardRepo, "src"), { recursive: true });
check("PL-25: temp git repo инициализирован", runGit(["init", "-q"]).status === 0);
runGit(["config", "user.email", "qa@example.invalid"]);
runGit(["config", "user.name", "QA"]);
const guardSrc = path.join(guardRepo, "src", "file.txt");
fs.writeFileSync(guardSrc, "clean\n", "utf8");
runGit(["add", "src/file.txt"]);
check("PL-25: стартовый коммит создан", runGit(["commit", "-q", "-m", "clean"]).status === 0);
const worktreeSnapshot = path.join(tempRoot, "worktree-snapshot.json");
check(
  "PL-25: worktree snapshot создан",
  gateIntegrity.captureWorktreeSnapshot(guardRepo, worktreeSnapshot) === worktreeSnapshot,
);
check(
  "PL-25: неизменённое дерево верифицируется",
  gateIntegrity.verifyWorktreeSnapshot(guardRepo, worktreeSnapshot).ok === true,
);
fs.writeFileSync(guardSrc, "foreign edit\n", "utf8");
const worktreeFail = gateIntegrity.verifyWorktreeSnapshot(guardRepo, worktreeSnapshot);
check(
  "PL-25: чужая правка src ловится",
  worktreeFail.ok === false && /src/i.test(worktreeFail.reason ?? ""),
);
const cliWtSnapshot = spawnSync(
  process.execPath,
  [integrityCli, "worktree-snapshot", "--dir", guardRepo, "--out", path.join(tempRoot, "cli-worktree.json")],
  { encoding: "utf8", windowsHide: true },
);
check("PL-25: CLI worktree-snapshot → 0", cliWtSnapshot.status === 0);
const cliWtVerify = spawnSync(
  process.execPath,
  [integrityCli, "worktree-verify", "--dir", guardRepo, "--snapshot", worktreeSnapshot],
  { encoding: "utf8", windowsHide: true },
);
check("PL-25: CLI worktree-verify на изменённом дереве → 1", cliWtVerify.status === 1);
const cliWtBadArgs = spawnSync(process.execPath, [integrityCli, "worktree-verify"], {
  encoding: "utf8",
  windowsHide: true,
});
check("PL-25: CLI worktree-verify — плохие аргументы → 2", cliWtBadArgs.status === 2);

closeDb();
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {
  /* Windows может держать файл БД */
}

console.log(failures === 0 ? "\nAC-1: все проверки единого пути пройдены." : `\nAC-1: провалов ${failures}.`);
process.exit(failures === 0 ? 0 : 1);
