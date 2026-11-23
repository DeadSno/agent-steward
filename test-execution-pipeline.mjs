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

// PL-84: переменные workspace env наследуются обёрткой задачи и попадают даже
// в дочерние тестовые сюиты. Без явного сброса PL-25/PL-47 проверки worktree
// становятся недетерминированными: внешний AGENT_STEWARD_GATE_ALLOW_PATHS=src
// «разрешает» чужую правку, которую тест обязан поймать.
for (const key of ["AGENT_STEWARD_GATE_ALLOW_PATHS", "AGENT_STEWARD_CHILD_RUN"]) {
  delete process.env[key];
}
check(
  "PL-84: внешние gate/child env сброшены перед проверками",
  !("AGENT_STEWARD_GATE_ALLOW_PATHS" in process.env) &&
    !("AGENT_STEWARD_CHILD_RUN" in process.env),
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ac1-"));
const dbPath = path.join(tempRoot, "ac1.db");

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const repo = await import("./dist/db/runs-repo.js");
const ac1 = await import("./dist/core/execution.js");
const audit = await import("./dist/core/audit.js");
// record-history имеет isDirectInvocation guard — импорт не запускает main().
const recorder = await import("./dist/core/record-history.js");

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
  ac1.createAdHocRunContext("run tests; write file", {
    taskName: "gate-report",
    cwd: tempRoot,
    // ARCH-7: этот тест проверяет GATE, а не очередь одобрений — держим R0.
    riskClass: "R0",
  }),
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
    // ARCH-7: проверяем пропуск review-шага, а не очередь одобрений.
    riskClass: "R0",
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
// PL-47: файл из -Files afterScript считается «своим» и гейт не срывает.
const allowEnv = { ...process.env, AGENT_STEWARD_GATE_ALLOW_PATHS: "src/file.txt" };
check(
  "PL-47: allow-путь исключается из сравнения со snapshot",
  gateIntegrity.verifyWorktreeSnapshot(guardRepo, worktreeSnapshot, allowEnv).ok === true &&
    gateIntegrity.readWorktreeState(guardRepo, allowEnv)?.status === "" &&
    gateIntegrity.readWorktreeState(guardRepo)?.status !== "",
);
const psWrapper = await import("./dist/core/ps-wrapper.js");
check(
  "PL-47: -Files из afterScript превращаются в allow-список",
  psWrapper.gateAllowPathsFromAfterScript(
    'powershell.exe -File pl-commit.ps1 -Files "src/index.ts;ROADMAP.md;CHANGELOG.md" -Marker "m"',
  ) === "src/index.ts|ROADMAP.md|CHANGELOG.md" &&
    psWrapper.gateAllowPathsFromAfterScript("echo OK>m") === "",
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

// --- 8. ARCH-3: flake-aware вердикт гейта в едином пути ---------------------
const escalation = await import("./dist/core/router/escalation.js");
const capability = await import("./dist/db/capability-repo.js");

let gateAttempts = 0;
const flakeOutcome = await escalation.runGateWithRetry((attempt) => {
  gateAttempts += 1;
  return attempt === 1
    ? { passed: false, verdict: "flake", reason: "первый вызов гейта флакнул" }
    : { passed: true, reason: "второй вызов прошёл" };
});
check("ARCH-3.1: гейт повторён на том же артефакте", gateAttempts === 2);
check(
  "ARCH-3.1: проход со 2-й попытки → flake, first_pass=false, attempts_to_pass=2",
  flakeOutcome.verdict === "flake" && flakeOutcome.passed &&
    flakeOutcome.firstPass === false && flakeOutcome.attemptsToPass === 2,
);

const flakeRecorded = capability.recordGateVerdict(
  {
    outcomeKey: "pipeline-flake-1",
    taskType: "write_file",
    gateKey: "npm test",
    verdict: flakeOutcome.verdict,
    attemptsToPass: flakeOutcome.attemptsToPass,
    firstPass: flakeOutcome.firstPass,
    runId: registeredRun.runId,
    reason: flakeOutcome.reasons.join("; "),
  },
  new Date(),
);
check("ARCH-3.1: вердикт записан в ledger", flakeRecorded.ledgerId > 0);
check("ARCH-3.2: flake не обновляет capability_map", flakeRecorded.capabilityUpdated === false);
const flakeLedgerRow = repo.listGateOutcomes().find((row) => row.outcomeKey === "pipeline-flake-1");
check(
  "ARCH-3.1: ledger-строка хранит verdict/attempts_to_pass/first_pass",
  flakeLedgerRow?.verdict === "flake" &&
    flakeLedgerRow?.attemptsToPass === 2 &&
    flakeLedgerRow?.firstPass === 0,
);
check("ARCH-3.1: hash-цепочка ledger цела", repo.verifyGateOutcomeChain().ok);

const infraRecorded = capability.recordGateVerdict(
  {
    outcomeKey: "pipeline-infra-1",
    taskType: "write_file",
    gateKey: "npm test",
    verdict: "infra_fail",
    attemptsToPass: 1,
    firstPass: false,
    reason: "инфраструктура недоступна",
  },
  new Date(),
);
check("ARCH-3.2: infra_fail не трогает capability_map", infraRecorded.capabilityUpdated === false);
check(
  "ARCH-3.2: infra_fail даёт предупреждение, отличное от flakes",
  infraRecorded.warning !== null && /инфраструктур/.test(infraRecorded.warning),
);

capability.recordGateVerdict(
  {
    outcomeKey: "pipeline-flake-2",
    taskType: "write_file",
    gateKey: "npm test",
    verdict: "flake",
    attemptsToPass: 2,
    firstPass: false,
  },
  new Date(),
);
check("ARCH-3.2: карантин стабильно флакующего гейта", capability.isGateQuarantined("npm test"));
check(
  "ARCH-3.2: предупреждение о карантине для отчёта",
  capability.getGateQuarantineWarning("npm test") !== null,
);
check(
  "ARCH-3.2: карантин истекает, а не блокирует навсегда",
  !capability.isGateQuarantined("npm test", new Date(Date.now() + 25 * 60 * 60 * 1000)),
);

const stableRecorded = capability.recordGateVerdict(
  {
    outcomeKey: "pipeline-stable-1",
    taskType: "run_tests",
    gateKey: "npm test",
    verdict: "pass",
    attemptsToPass: 1,
    firstPass: true,
  },
  new Date(),
);
check("ARCH-3: регрессия — стабильный pass обновляет карту", stableRecorded.capabilityUpdated === true);
check(
  "ARCH-3: регрессия — statistics в карте корректны",
  capability.getCapability("run_tests")?.runsPassed === 1,
);
check("ARCH-3: стабильный pass снимает карантин", !capability.isGateQuarantined("npm test"));

// --- 9. ARCH-1.x: общий RunContext, registered мост и tamper-evident ledger ----
const twinAdhoc = ac1.createAdHocRunContext(registered.prompt, {
  taskName: registered.taskName,
  cwd: registered.cwd,
  policy: registered.safety.policy,
  profile: { ...registered.profile },
  safety: {
    allowedTools: registered.safety.allowedTools,
    deniedTools: registered.safety.deniedTools,
  },
  // Тот же gate, что у зарегистрированной задачи (иначе gateHash законно отличается).
  metadata: { qualityGate: registered.metadata.qualityGate },
});
const contextFields = (c) =>
  JSON.stringify({
    taskName: c.taskName,
    mission: c.mission,
    prompt: c.prompt,
    cwd: c.cwd,
    model: c.profile.model,
    session: c.profile.session,
    sessionId: c.profile.sessionId,
    workspaceId: c.profile.workspaceId,
    policy: c.safety.policy,
    allowed: c.safety.allowedTools,
    denied: c.safety.deniedTools,
  });
check(
  "ARCH-1.1:registered и ad-hoc дают одинаковый RunContext (кроме origin)",
  contextFields(registered) === contextFields(twinAdhoc) &&
    registered.origin === "registered" &&
    twinAdhoc.origin === "ad-hoc",
);
const registeredHashes = ac1.contextGateHashes(registered);
const twinHashes = ac1.contextGateHashes(twinAdhoc);
check(
  "ARCH-1.2: gate/policy/prompt-хэши двух входов совпадают",
  JSON.stringify(registeredHashes) === JSON.stringify(twinHashes) &&
    /^[0-9a-f]{64}$/.test(registeredHashes.gateHash) &&
    /^[0-9a-f]{64}$/.test(registeredHashes.policyHash) &&
    /^[0-9a-f]{64}$/.test(registeredHashes.promptHash),
);
check(
  "ARCH-1.2: trigger_kind различает зарегистрированную задачу и ad-hoc",
  ac1.triggerKindFor(registered) === "manual" && ac1.triggerKindFor(twinAdhoc) === "adhoc",
);

const bridgeContext = ac1.createRegisteredRunContext({
  name: "registered-ledger-task",
  prompt: "write report",
  workingDirectory: tempRoot,
  model: "local/ledger",
  triggerType: "cron",
  qualityGate: "npm test",
});
ac1.validateRunContext(bridgeContext);
const evidencePath = path.join(tempRoot, "registered-run.log");
const begunRunId = recorder.beginRegisteredRun(bridgeContext, 4242, {
  startedAt: new Date().toISOString(),
});
check(
  "ARCH-1.1:beginRegisteredRun создал durable run через createRun",
  typeof begunRunId === "string" && repo.getRun(begunRunId)?.status === "running",
);
check(
  "ARCH-1.1:шаг создан running (разрешён переход → passed)",
  repo.getStep(begunRunId, "registered-ledger-task")?.status === "running",
);
check(
  "ARCH-1.1:metadata связывает durable run с history id",
  repo.getRun(begunRunId)?.metadata?.registeredHistoryId === 4242,
);
const bridge = recorder.recordRegisteredRun(bridgeContext, {
  historyRunId: 4242,
  status: "passed",
  evidencePath,
});
check("ARCH-1.1:recordRegisteredRun нашёл run по history id", bridge?.runId === begunRunId);
check(
  "ARCH-1.1:run и шаг завершены passed",
  repo.getRun(begunRunId)?.status === "passed" &&
    repo.getStep(begunRunId, "registered-ledger-task")?.status === "passed",
);
const bridgeOutcome = repo
  .listGateOutcomes()
  .find((o) => o.runId === begunRunId && o.verdict === "pass");
check("ARCH-1.2:registered мост записал gate_outcomes", Boolean(bridgeOutcome));
check(
  "ARCH-1.2:verdict/first_pass/attempts",
  bridgeOutcome?.verdict === "pass" &&
    bridgeOutcome?.firstPass === 1 &&
    bridgeOutcome?.attemptsToPass === 1,
);
check(
  "ARCH-1.2:хэши записи — SHA-256 (64 hex)",
  [bridgeOutcome?.gateHash, bridgeOutcome?.policyHash, bridgeOutcome?.promptHash,
    bridgeOutcome?.prevHash, bridgeOutcome?.rowHash].every((h) => /^[0-9a-f]{64}$/.test(h ?? "")),
);
check(
  "ARCH-1.2:trigger_kind/executor/gate_type",
  bridgeOutcome?.triggerKind === "cron" &&
    bridgeOutcome?.executor === "registered-recorder" &&
    bridgeOutcome?.gateType === "npm test",
);
check("ARCH-1.3:evidence_path записан в ledger", bridgeOutcome?.evidencePath === evidencePath);

const outcomesFor = (runId) => repo.listGateOutcomes().filter((o) => o.runId === runId);
// ARCH-3 позже добавил в этот же run строку verdict='flake' — фильтруем по pass.
const registeredPasses = outcomesFor(registeredRun.runId).filter((o) => o.verdict === "pass");
check(
  "ARCH-1.2:executeExecutionPlan пишет pass по каждому исполненному шагу",
  registeredPasses.length === 2 && registeredPasses.every((o) => o.verdict === "pass"),
);
check(
  "ARCH-1.2:fail гейта попал в ledger",
  outcomesFor(gateRun.runId).some((o) => o.verdict === "fail" && o.stepName === "write file"),
);
check("ARCH-1.2:skipped шаг не создаёт gate_outcomes", outcomesFor(reviewRun.runId).length === 0);
check(
  "ARCH-1.2:executor и route_source берутся из плана",
  registeredPasses[0]?.executor === "fake" &&
    typeof registeredPasses[0]?.routeSource === "string",
);

const ledger = repo.readGateOutcomeLedger();
check(
  "ARCH-1.3:read-путь читает только ledger, цепочка валидна",
  ledger.chain.ok === true && ledger.rows.length >= 9,
);
const firstOutcome = ledger.rows[0];
const lastOutcome = ledger.rows[ledger.rows.length - 1];
getDb()
  .prepare("UPDATE gate_outcomes SET prev_hash = ? WHERE id = ?")
  .run("f".repeat(64), firstOutcome.id);
check("ARCH-1.3:подмена prev_hash обнаруживается", repo.verifyGateOutcomeChain().ok === false);
getDb()
  .prepare("UPDATE gate_outcomes SET prev_hash = ? WHERE id = ?")
  .run(firstOutcome.prevHash, firstOutcome.id);
check("ARCH-1.3:восстановление prev_hash → цепочка валидна", repo.verifyGateOutcomeChain().ok === true);

getDb()
  .prepare("UPDATE gate_outcomes SET evidence_path = ? WHERE id = ?")
  .run(path.join(tempRoot, "forged.log"), lastOutcome.id);
check(
  "ARCH-1.3:подмена evidence_path в ПОСЛЕДНЕЙ записи обнаруживается",
  repo.verifyGateOutcomeChain().ok === false,
);
getDb()
  .prepare("UPDATE gate_outcomes SET evidence_path = ? WHERE id = ?")
  .run(lastOutcome.evidencePath, lastOutcome.id);
check("ARCH-1.3:восстановление evidence_path → цепочка валидна", repo.verifyGateOutcomeChain().ok === true);
check(
  "ARCH-1.3:readGateOutcomeLedger({verify:false}) не проверяет цепочку",
  repo.readGateOutcomeLedger({ verify: false }).chain.ok === true,
);

// --- 10. ARCH-7.2: гейт одобрений в execution loop ---------------------------
const approvalExecutor = {
  id: "arch7-test",
  supports: () => true,
  execute: async () => ({ output: "ok" }),
};
const makeApprovalPlan = (taskName, riskClass) =>
  ac1.buildExecutionPlan(
    ac1.createAdHocRunContext("run tests; write file", {
      taskName,
      cwd: tempRoot,
      riskClass,
    }),
  );

const r0Plan = await makeApprovalPlan("arch7-r0", "R0");
const r1Plan = await makeApprovalPlan("arch7-r1", "R1");
const r0Run = await ac1.executeExecutionPlan(r0Plan, { executors: [approvalExecutor] });
const r1Run = await ac1.executeExecutionPlan(r1Plan, { executors: [approvalExecutor] });
check(
  "ARCH-7.2: R0 проходит без одобрения",
  r0Run.status === "passed" && typeof r0Run.runId === "string" && r0Run.approval === undefined,
);
check(
  "ARCH-7.2: R1 проходит без одобрения",
  r1Run.status === "passed" && typeof r1Run.runId === "string" && r1Run.approval === undefined,
);
check(
  "ARCH-7.2: для R0/R1 в очереди нет запросов",
  audit.listApprovals().every((item) => item.taskName !== "arch7-r0" && item.taskName !== "arch7-r1"),
);

// ARCH-7.3: гейт одобрений включается только явным options.approval.
const r2NoApprovalPlan = await makeApprovalPlan("arch7-r2-no-request", "R2");
const r2NoApprovalRun = await ac1.executeExecutionPlan(r2NoApprovalPlan, {
  executors: [approvalExecutor],
});
check(
  "ARCH-7.3: R2 без options.approval проходит как обычный запуск",
  r2NoApprovalRun.status === "passed" &&
    typeof r2NoApprovalRun.runId === "string" &&
    r2NoApprovalRun.approval === undefined,
);
check(
  "ARCH-7.3: R2 без options.approval не создаёт запрос в очереди",
  audit.listApprovals().every((item) => item.taskName !== "arch7-r2-no-request"),
);

// R2: пока нет одобрения — нет ни run, ни эффектов; повтор запроса не дублируется.
const r2Plan = await makeApprovalPlan("arch7-r2", "R2");
let r2Effects = 0;
const r2Options = {
  executors: [approvalExecutor],
  effects: [
    {
      id: "arch7-r2-effect",
      reversibility: "reversible",
      apply: () => {
        r2Effects += 1;
      },
      compensate: () => {
        r2Effects -= 1;
      },
    },
  ],
  approval: {
    approvalKey: "arch7-r2-key",
    runRef: "arch7-r2-ref",
    reason: "внешние эффекты",
    actor: "cron",
  },
};
check("ARCH-7.2: до запроса R2-запуск не существует", repo.listRuns("arch7-r2", 50).length === 0);
const r2Pending = await ac1.executeExecutionPlan(r2Plan, r2Options);
check(
  "ARCH-7.2: R2 без одобрения → awaiting_approval, runId=null, шагов нет",
  r2Pending.status === "awaiting_approval" &&
    r2Pending.runId === null &&
    r2Pending.steps.length === 0 &&
    r2Pending.approval?.status === "pending",
);
check(
  "ARCH-7.2: R2 без одобрения не создаёт run в ledger",
  repo.listRuns("arch7-r2", 50).length === 0,
);
check("ARCH-7.2: R2 без одобрения не применяет эффекты", r2Effects === 0);
check(
  "ARCH-7.2: статус ожидания зафиксирован в аудите",
  audit.readAuditLog({ action: audit.RUN_AWAITING_APPROVAL_ACTION, target: "arch7-r2-key" }).total === 1,
);
check(
  "ARCH-7.1: повторный запрос R2 не дублируется",
  audit.readAuditLog({ action: audit.APPROVAL_REQUESTED_ACTION, target: "arch7-r2-key" }).total === 1,
);
const r2PendingAgain = await ac1.executeExecutionPlan(r2Plan, r2Options);
check(
  "ARCH-7.2: повторный прогон до одобрения снова блокируется и не дублирует запрос",
  r2PendingAgain.status === "awaiting_approval" &&
    r2PendingAgain.runId === null &&
    audit.readAuditLog({ action: audit.APPROVAL_REQUESTED_ACTION, target: "arch7-r2-key" }).total === 1,
);

const r2Decision = audit.decideApproval("arch7-r2-key", "approve", {
  actor: "gui",
  reason: "проверено оператором",
  source: "test-execution-pipeline",
});
check(
  "ARCH-7.1: решение approve сохраняет кто/когда/решение/причину/ссылку",
  r2Decision.status === "approved" &&
    r2Decision.decision === "approve" &&
    r2Decision.decidedBy === "gui" &&
    !!r2Decision.decidedAt &&
    r2Decision.reason === "проверено оператором" &&
    r2Decision.runRef === "arch7-r2-ref",
);
const r2Approved = await ac1.executeExecutionPlan(r2Plan, r2Options);
check(
  "ARCH-7.2: после approve run создан, шаги исполнены и эффект применён",
  r2Approved.status === "passed" &&
    typeof r2Approved.runId === "string" &&
    r2Approved.approval?.status === "approved" &&
    // эффект объявлен общим → применяется по одному разу на каждый из 2 шагов
    r2Effects === 2,
);
check(
  "ARCH-7.2: metadata созданного run связана с запросом одобрения",
  repo.getRun(r2Approved.runId)?.metadata?.approvalRequestId === "arch7-r2-key",
);
check(
  "ARCH-7.1: одобренный запрос не создал второй approval.requested",
  audit.readAuditLog({ action: audit.APPROVAL_REQUESTED_ACTION, target: "arch7-r2-key" }).total === 1 &&
    audit.readAuditLog({ action: audit.APPROVAL_APPROVED_ACTION, target: "arch7-r2-key" }).total === 1,
);

// R3: reject блокирует запуск и эффекты, решение идемпотентно.
const r3Plan = await makeApprovalPlan("arch7-r3", "R3");
let r3Effects = 0;
const r3Options = {
  executors: [approvalExecutor],
  effects: [
    {
      id: "arch7-r3-effect",
      reversibility: "irreversible",
      apply: () => {
        r3Effects += 1;
      },
    },
  ],
  approval: {
    approvalKey: "arch7-r3-key",
    runRef: "arch7-r3-ref",
    reason: "destructive",
    actor: "cron",
  },
};
const r3Pending = await ac1.executeExecutionPlan(r3Plan, r3Options);
check(
  "ARCH-7.2: R3 без одобрения блокируется до createRun",
  r3Pending.status === "awaiting_approval" && r3Pending.runId === null && r3Effects === 0,
);
const r3Decision = audit.decideApproval("arch7-r3-key", "reject", {
  actor: "http",
  reason: "нет разрешения",
  source: "test-execution-pipeline",
});
check(
  "ARCH-7.1: решение reject содержит полный аудит",
  r3Decision.status === "rejected" &&
    r3Decision.decision === "reject" &&
    r3Decision.decidedBy === "http" &&
    !!r3Decision.decidedAt &&
    r3Decision.reason === "нет разрешения" &&
    r3Decision.runRef === "arch7-r3-ref",
);
const r3Rejected = await ac1.executeExecutionPlan(r3Plan, r3Options);
check(
  "ARCH-7.2: reject блокирует run и эффекты",
  r3Rejected.status === "rejected" &&
    r3Rejected.runId === null &&
    r3Rejected.steps.length === 0 &&
    r3Effects === 0 &&
    repo.listRuns("arch7-r3", 50).length === 0,
);
check(
  "ARCH-7.2: отказ запуска записан в аудит",
  audit.readAuditLog({ action: audit.RUN_APPROVAL_REJECTED_ACTION, target: "arch7-r3-key" }).total === 1,
);
check(
  "ARCH-7.1: повторное решение не дублирует аудит reject",
  audit.decideApproval("arch7-r3-key", "approve", { actor: "gui", reason: "передумали" }).status ===
    "rejected" &&
    audit.readAuditLog({ action: audit.APPROVAL_REJECTED_ACTION, target: "arch7-r3-key" }).total === 1 &&
    audit.readAuditLog({ action: audit.APPROVAL_APPROVED_ACTION, target: "arch7-r3-key" }).total === 0,
);

// --- PL-93: retry гейта, эскалация и карантин в execution loop ------------
const flakePlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("PL-93 flake gate", {
    taskName: "pl93-flake",
    cwd: tempRoot,
    taskType: "run_tests",
    riskClass: "R0",
    metadata: { qualityGate: "pl93-flake-gate" },
  }),
);
let gateCalls = 0;
const flakeRun = await ac1.executeExecutionPlan(flakePlan, {
  executors: [executor],
  gate: () => {
    gateCalls += 1;
    return gateCalls === 1
      ? { ok: false, verdict: "flake", reason: "первый прогон гейта шумный" }
      : { ok: true, verdict: "pass" };
  },
  escalation: { enabled: true },
});
check("PL-93: гейт flake повторен на том же артефакте", gateCalls === 2);
check("PL-93: шаг passed после повтора гейта", flakeRun.status === "passed");
check(
  "PL-93: вердикт flake записан в gate_outcomes",
  repo.listGateOutcomes(1000).some(
    (row) => row.runId === flakeRun.runId && row.verdict === "flake",
  ),
);

let localCalls = 0;
let cloudCalls = 0;
const localExecutor = {
  id: "local",
  supports: (route) => route.executor === "local",
  execute: () => {
    localCalls += 1;
    return { output: "local" };
  },
};
const cloudExecutor = {
  id: "cloud",
  supports: (route) => route.executor === "cloud",
  execute: () => {
    cloudCalls += 1;
    return { output: "cloud" };
  },
};
const escalationPlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("PL-93 escalate", {
    taskName: "pl93-escalate",
    cwd: tempRoot,
    taskType: "run_tests",
    riskClass: "R0",
  }),
);
const escalatedRun = await ac1.executeExecutionPlan(escalationPlan, {
  executors: [localExecutor, cloudExecutor],
  gate: ({ step }) => (step.route.executor === "cloud" ? { ok: true } : { ok: false, reason: "local fail" }),
  escalation: { enabled: true },
});
check("PL-93: local executed один раз", localCalls === 1);
check("PL-93: cloud подобран и исполнен после эскалации", cloudCalls === 1);
check("PL-93: запуск passed после эскалации", escalatedRun.status === "passed");
check("PL-93: маршрут шага обновлён до cloud", escalatedRun.steps[0].target === "cloud");

const pl93Capability = await import("./dist/db/capability-repo.js");
for (const suffix of ["q1", "q2"]) {
  pl93Capability.recordGateVerdict({
    outcomeKey: `pl93-${suffix}`,
    taskType: "run_tests",
    gateKey: "pl93-unstable-gate",
    verdict: "flake",
    attemptsToPass: 2,
    firstPass: false,
  });
}
check("PL-93: карантин гейта активен", pl93Capability.isGateQuarantined("pl93-unstable-gate"));
const quarantinedPlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("PL-93 quarantine", {
    taskName: "pl93-quarantine",
    cwd: tempRoot,
    taskType: "run_tests",
    riskClass: "R0",
    metadata: { qualityGate: "pl93-unstable-gate" },
  }),
);
check(
  "PL-93: карантин меняет маршрут на review",
  quarantinedPlan.steps[0].route.target === "review" && quarantinedPlan.steps[0].route.executor === null,
);
check(
  "PL-93: предупреждение о карантине в плане",
  quarantinedPlan.warnings.some((warning) => warning.includes("карантине")),
);
const quarantinedRun = await ac1.executeExecutionPlan(quarantinedPlan, { executors: [executor] });
check("PL-93: шаг в карантине пропущен", quarantinedRun.steps[0].status === "skipped");

// --- PL-94: контекст компилируется из ledger и доходит до исполнителя -------
const pl94Files = {
  "src/core/router/rules.ts": "PL-94 critical payload",
  "src/db/capability-repo.ts": "PL-94 ledger payload " + "x".repeat(200),
};
const pl94Plan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("PL-94 compiled context", {
    taskName: "pl94-context",
    cwd: tempRoot,
    taskType: "run_tests",
    riskClass: "R0",
  }),
  { compileContext: { files: pl94Files, tokenBudget: 2000 } },
);
const pl94Compiled = pl94Plan.steps[0].compiledContext;
check("PL-94: compiledContext приложен к шагу плана", Boolean(pl94Compiled));
check(
  "PL-94: contextHash детерминированный SHA-256",
  /^[0-9a-f]{64}$/.test(pl94Compiled?.contextHash ?? ""),
);
check("PL-94: модель выбрана из маршрута", pl94Compiled?.model === "local-7b");
check("PL-94: контекст помечен как ledger", pl94Compiled?.compiledFrom === "ledger");

const pl94Seen = [];
const pl94Executor = {
  id: "local",
  supports: (route) => route.executor === "local",
  execute: (input) => {
    pl94Seen.push(input);
    return { output: "pl94-ok" };
  },
};
const pl94Run = await ac1.executeExecutionPlan(pl94Plan, { executors: [pl94Executor] });
check("PL-94: запуск с скомпилированным контекстом passed", pl94Run.status === "passed");
check(
  "PL-94: исполнитель получил compiledContext",
  pl94Seen.length === 1 && pl94Seen[0].compiledContext?.contextHash === pl94Compiled.contextHash,
);

const pl94Invocations = [];
const pl94Opencode = ac1.createOpenCodeExecutor((input) => {
  pl94Invocations.push(input);
  return "done";
});
await ac1.executeExecutionPlan(pl94Plan, { executors: [pl94Opencode] });
check(
  "PL-94: OpenCodeInvocation получил contextHash",
  pl94Invocations.length === 1 && pl94Invocations[0].contextHash === pl94Compiled.contextHash,
);

const pl94LocalSeen = [];
const pl94CloudSeen = [];
const pl94ContextPlan = await ac1.buildExecutionPlan(
  ac1.createAdHocRunContext("PL-94 escalation recompile", {
    taskName: "pl94-escalate-context",
    cwd: tempRoot,
    taskType: "run_tests",
    riskClass: "R0",
  }),
  { compileContext: { files: pl94Files, tokenBudget: 2000 } },
);
const pl94ContextRun = await ac1.executeExecutionPlan(pl94ContextPlan, {
  executors: [
    {
      id: "local",
      supports: (route) => route.executor === "local",
      execute: (input) => {
        pl94LocalSeen.push(input);
        return { output: "local" };
      },
    },
    {
      id: "cloud",
      supports: (route) => route.executor === "cloud",
      execute: (input) => {
        pl94CloudSeen.push(input);
        return { output: "cloud" };
      },
    },
  ],
  gate: ({ step }) => (step.route.executor === "cloud" ? { ok: true } : { ok: false, reason: "local gate fail" }),
  escalation: { enabled: true },
});
check("PL-94: эскалация с пересборкой контекста passed", pl94ContextRun.status === "passed");
check(
  "PL-94: локальный шаг получил контекст local-7b",
  pl94LocalSeen.length === 1 && pl94LocalSeen[0].compiledContext?.model === "local-7b",
);
check(
  "PL-94: облачный шаг получил пересобранный контекст cloud-large",
  pl94CloudSeen.length === 1 && pl94CloudSeen[0].compiledContext?.model === "cloud-large",
);
check(
  "PL-94: contextHash после эскалации отличается",
  pl94CloudSeen[0].compiledContext?.contextHash !== pl94LocalSeen[0].compiledContext?.contextHash,
);

closeDb();
try {
  fs.rmSync(tempRoot, { recursive: true, force: true });
} catch {
  /* Windows может держать файл БД */
}

console.log(failures === 0 ? "\nAC-1: все проверки единого пути пройдены." : `\nAC-1: провалов ${failures}.`);
process.exit(failures === 0 ? 0 : 1);
