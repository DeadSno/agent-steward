// Тест исполнения: hotfix 1.5.3.1.
// Проверяем то, что раньше не работало:
//   1. TimeoutSeconds реально убивает задачу, статус = "timeout"
//   2. Повторный запуск при активной блокировке пропускается (нет второго запуска)
//   3. Ретраи: обёртка делает одну попытку, повторы планирует recorder (B2)
//   4. Кавычки в before/after-скриптах (путь с пробелами) не ломают хук
//   5. Recorder не сдвигает аргументы при пустом сообщении об ошибке
//      (model не превращается в preFlight, postFlightStatus сохраняется)
//   6. list_tasks отдаёт timeoutSeconds
//
// Запуск: node test-execution-hardening.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

// T-05 (CI): тест построен на cmd.exe/батниках и schtasks — на Linux/macOS
// секции 1–5 не имеют смысла и падают. Пропускаем целиком.
if (process.platform !== "win32") {
  console.log("execution-hardening: пропуск на не-Windows (нужны cmd.exe и schtasks).");
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-exec-hardening-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
// Тест проверяет регистрацию инструментов, а маркер дочернего прогона
// (его выставляет обёртка планировщика) registration отключает. Стенд
// запускается внутри задачи — снимаем маркер для изоляции.
delete process.env.AGENT_STEWARD_CHILD_RUN;

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const fakeBin = path.join(tempRoot, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
const counterFile = path.join(tempRoot, "fake-opencode-calls.txt");
const fakeOpencode = path.join(fakeBin, "opencode.cmd");
fs.writeFileSync(
  fakeOpencode,
  [
    "@echo off",
    "setlocal",
    `echo call>>"${counterFile}"`,
    'if "%FAKE_MODE%"=="fail" (',
    "  echo FAKE-OPENCODE-FAIL",
    "  exit /b 1",
    ")",
    'if "%FAKE_MODE%"=="sleep" (',
    "  echo FAKE-OPENCODE-SLEEP-START",
    "  ping -n %FAKE_SLEEP% 127.0.0.1 >nul",
    "  echo FAKE-OPENCODE-SLEEP-DONE",
    "  exit /b 0",
    ")",
    "echo FAKE-OPENCODE-OK %*",
    "exit /b 0",
    "",
  ].join("\r\n"),
  "utf8"
);
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

// ВАЖНО: dist-модули импортируем ТОЛЬКО после настройки env,
// иначе PLUGIN_DIR зафиксируется на реальном %APPDATA%.
const { initDb } = await import("./dist/db/index.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { getHistory } = await import("./dist/db/history-repo.js");
const { getSetting, deleteSetting } = await import("./dist/db/settings-repo.js");
const {
  writeWrapperCmd,
  WORKTREE_CREATE_FAILURE_REASON,
  writePromptFile,
  lockFilePath,
  ensureWrapper,
  gateAllowPathsFromScope,
  gateAllowPathsFromAfterScript,
  WRAPPER_SCRIPT: psWrapperScript,
} = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");
// ARCH-4: отложенные эффекты и saga-компенсация.
const { createAdHocRunContext, buildExecutionPlan, executeExecutionPlan } = await import(
  "./dist/core/execution.js"
);
const { listEffectIntents, readEffectIntentLedger } = await import(
  "./dist/core/gate-integrity.js"
);
const { readAuditLog } = await import("./dist/core/audit.js");
const { planRuntimeIsolation } = await import("./dist/core/scheduler/run-now.js");
// A-6: команды Telegram-бота. Никаких сетевых вызовов — только панель и БД.
const { parseTelegramCommand, handleTelegramCommand } = await import(
  "./dist/core/telegram.js"
);
const { createRun, getRun: getRunRecord } = await import("./dist/db/runs-repo.js");
const { listRunPanel, pauseRunPanel, resumeRunPanel } = await import(
  "./dist/core/run-panel-api.js"
);

initDb();
await ensureWrapper();

// PL-83: исчерпание квоты модели классифицируется отдельно от обычного
// «Код возврата 1» в обеих обёртках (PowerShell и bash).
const bashQuotaScript = buildBashWrapperScript({
  sanitizedName: "quota-probe",
  taskName: "Quota Probe",
  promptFile: path.join(tempRoot, "quota-prompt.txt"),
  timeoutSeconds: 60,
  lockFile: path.join(tempRoot, "quota-probe.lock"),
  workdir: tempRoot,
  logFile: path.join(tempRoot, "quota-probe.log"),
  recorderFile: path.join(tempRoot, "record-history.js"),
});
check(
  "PL-83 PowerShell: квота обнаруживается по логу",
  psWrapperScript.includes("Free usage limit reached|Insufficient Balance|free usage limit") &&
    psWrapperScript.includes("Get-Content -LiteralPath $LogFile -Tail 80")
);
check(
  "PL-83 PowerShell: отдельный код 126 и подсказка по модели",
  psWrapperScript.includes("$script:exitCode = 126") &&
    psWrapperScript.includes("update_task name=$TaskName model=provider/model")
);
check(
  "PL-83 PowerShell: partial-diff сохраняется в reports",
  psWrapperScript.includes('reports/quota-') && psWrapperScript.includes("git -C $Workdir diff")
);
check(
  "PL-83 bash: квота обнаруживается по логу и даёт код 126",
  bashQuotaScript.includes("Free usage limit reached|Insufficient Balance|free usage limit") &&
    bashQuotaScript.includes("EXIT_CODE=126")
);
check(
  "PL-83 bash: partial-diff и подсказка по модели",
  bashQuotaScript.includes('QUOTA_DIFF="$WORKDIR/reports/quota-$SAFE_NAME.diff"') &&
    bashQuotaScript.includes("update_task name=$TASK_NAME model=provider/model")
);
// PL-113: аргументы дочернего powershell не должны проходить через повторный
// разбор командной строки - иначе промпт с кавычками и многоточием падает до
// старта агента с Cannot process argument ... name.
check(
  "PL-113 PowerShell: аргументы идут через JSON-файл и EncodedCommand",
  psWrapperScript.includes("ConvertTo-Json -InputObject @($Arguments) -Compress -Depth 32") &&
    psWrapperScript.includes("-EncodedCommand $encodedCommand") &&
    psWrapperScript.includes("| ConvertFrom-Json; & ''{1}'' @a") &&
    !psWrapperScript.includes("@(Get-Content -LiteralPath ''{0}''")
);
check(
  "PL-113 PowerShell: больше нет -File с аргументами в cmdline",
  !psWrapperScript.includes("-File $CommandPath @Arguments")
);
// PL-107: qualityGate получает список файлов задачи, чтобы не линтить чужие
// незакоммиченные файлы общего worktree.
const lintTaskFiles = fs.readFileSync(path.resolve("scripts/lint-task-files.mjs"), "utf8");
check(
  "PL-107 PowerShell: gate-хук получает -AllowPaths",
  psWrapperScript.includes("-Command $QualityGate -AllowPaths $GateAllowPaths") &&
    psWrapperScript.includes("$env:AGENT_STEWARD_GATE_ALLOW_PATHS = $AllowPaths")
);
check(
  "PL-107: хелпер линтит только файлы из AGENT_STEWARD_GATE_ALLOW_PATHS",
  lintTaskFiles.includes("AGENT_STEWARD_GATE_ALLOW_PATHS") &&
    lintTaskFiles.includes("eslint") &&
    lintTaskFiles.includes("no-error-on-unmatched-pattern")
);

const recorder = path.resolve("dist/core/record-history.js");

async function prepareTask(spec) {
  saveTask({
    name: spec.name,
    schedule: "0 9 * * *",
    prompt: "Скажи hello",
    timeoutSeconds: spec.timeoutSeconds,
    retryCount: spec.retryCount,
    retryDelay: spec.retryDelay,
  });
  const promptFile = await writePromptFile(spec.name, "Скажи hello");
  const logFile = path.join(pluginDir, "logs", `${spec.name}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const wrapperPath = await writeWrapperCmd(
    spec.sanitized,
    spec.name,
    promptFile,
    spec.timeoutSeconds,
    lockFilePath(spec.name),
    tempRoot,
    logFile,
    recorder,
    spec.qualityGate,
    undefined,
    spec.beforeScript,
    spec.afterScript,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "new",
    undefined
  );
  return { wrapperPath, logFile };
}

function runWrapper(wrapperPath, env) {
  const started = Date.now();
  const res = spawnSync("cmd.exe", ["/c", wrapperPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180000,
    windowsHide: true,
  });
  return { ...res, elapsedMs: Date.now() - started };
}

// QA-CI-6: на Windows/Node 24 лог может ещё удерживаться процессом обёртки —
// повторяем чтение, вместо того чтобы падать с EBUSY/EPERM.
function readLog(file) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err?.code !== "EBUSY" && err?.code !== "EPERM" && err?.code !== "ENOENT") throw err;
      if (attempt === 9) return "";
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  return "";
}

// --- 1. Успешный запуск + кавычки в хуках + recorder без сдвига аргументов ---
{
  const spacesDir = path.join(tempRoot, "hooks with spaces");
  fs.mkdirSync(spacesDir, { recursive: true });
  const beforeMarker = path.join(spacesDir, "before-marker.txt");
  const afterMarker = path.join(spacesDir, "after-marker.txt");
  const spec = {
    name: "Exec Hardening Success",
    sanitized: "exec-hardening-success",
    timeoutSeconds: 60,
    beforeScript: `echo before>"${beforeMarker}"`,
    afterScript: `echo after>"${afterMarker}"`,
  };
  const { wrapperPath, logFile } = await prepareTask(spec);
  const run = runWrapper(wrapperPath, { FAKE_MODE: "ok" });

  check("успешный запуск: код 0", run.status === 0, `status=${run.status}`);

  const [record] = getHistory(spec.name, 5);
  check("успешный запуск: запись истории есть", Boolean(record));
  check("успешный запуск: статус success", record?.status === "success", record?.status);
  check(
    "кавычки в before-скрипте не ломают хук (маркер создан)",
    fs.existsSync(beforeMarker)
  );
  check(
    "кавычки в after-скрипте не ломают хук (маркер создан)",
    fs.existsSync(afterMarker)
  );
  check(
    "recorder: model не сдвинут в preFlight",
    record?.model !== "success" && record?.model !== "skipped",
    `model=${record?.model}`
  );
  check(
    "recorder: postFlightStatus сохранён",
    record?.postFlightStatus === "success",
    `postFlight=${record?.postFlightStatus}`
  );
  check(
    "лог содержит вывод opencode",
    readLog(logFile).includes("FAKE-OPENCODE-OK")
  );
}

// --- 2. Таймаут реально останавливает задачу ---
{
  const spec = {
    name: "Exec Hardening Timeout",
    sanitized: "exec-hardening-timeout",
    timeoutSeconds: 2,
  };
  const { wrapperPath } = await prepareTask(spec);
  const run = runWrapper(wrapperPath, { FAKE_MODE: "sleep", FAKE_SLEEP: "25" });

  check(
    "таймаут: задача убита раньше 15 с",
    run.elapsedMs < 15000,
    `elapsedMs=${run.elapsedMs}`
  );
  const [record] = getHistory(spec.name, 5);
  check("таймаут: статус timeout", record?.status === "timeout", record?.status);
  check(
    "таймаут: в ошибке упомянут лимит",
    String(record?.error ?? "").includes("Таймаут"),
    record?.error
  );
}

// --- 3. Блокировка: второй запуск пропускается ---
{
  const spec = {
    name: "Exec Hardening Lock",
    sanitized: "exec-hardening-lock",
    timeoutSeconds: 30,
  };
  const { wrapperPath, logFile } = await prepareTask(spec);
  const lockFile = lockFilePath(spec.name);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, new Date().toISOString(), "utf8");

  const run = runWrapper(wrapperPath, { FAKE_MODE: "ok" });
  const log = readLog(logFile);

  check("блокировка: код 0 (тихий пропуск)", run.status === 0, `status=${run.status}`);
  check(
    "блокировка: в логе сообщение о пропуске",
    log.includes("пропущен") && log.includes("блокировка")
  );
  check("блокировка: история не создавалась", getHistory(spec.name, 5).length === 0);
  check("блокировка: lock-файл не удалён чужим запуском", fs.existsSync(lockFile));

  fs.rmSync(lockFile, { force: true });
}

// --- 4. Ретраи: одна попытка у обёртки, повторы у recorder'а (B2) ---
{
  const spec = {
    name: "Exec Hardening Retry",
    sanitized: "exec-hardening-retry",
    timeoutSeconds: 30,
    retryCount: 2,
    retryDelay: 2,
  };
  fs.rmSync(counterFile, { force: true });
  deleteSetting(`retry_state:${spec.name.toLowerCase()}`);
  const { wrapperPath } = await prepareTask(spec);

  const wrapperCmd = fs.readFileSync(wrapperPath, "utf8");
  check(
    "ретраи: обёртка не получает -RetryCount (единственный слой)",
    !wrapperCmd.includes("-RetryCount")
  );

  const run = runWrapper(wrapperPath, { FAKE_MODE: "fail" });

  const calls = fs.existsSync(counterFile)
    ? fs.readFileSync(counterFile, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  check("ретраи: обёртка делает ровно одну попытку", calls === 1, `calls=${calls}`);
  check("ретраи: итоговый код не 0", run.status !== 0, `status=${run.status}`);
  const [record] = getHistory(spec.name, 5);
  check("ретраи: статус error", record?.status === "error", record?.status);

  // Recorder — единственный владелец повторов: он декрементирует счётчик
  // задачи (2 -> 1) и запускает detached-повтор с задержкой retryDelay.
  const remaining = getSetting(`retry_state:${spec.name.toLowerCase()}`, null);
  check(
    "ретраи: recorder зарезервировал повтор (2 -> 1)",
    remaining === 1,
    `retry_state=${String(remaining)}`
  );
  deleteSetting(`retry_state:${spec.name.toLowerCase()}`);
}

// --- 5. list_tasks отдаёт timeoutSeconds ---
{
  saveTask({
    name: "Exec Hardening View",
    schedule: "0 9 * * *",
    prompt: "view",
    timeoutSeconds: 45,
  });

  const { default: plugin, createToolSpecs } = await import("./dist/index.js");
  const tools = new Map();
  const ctx = {
    location: { directory: process.cwd() },
    tool: {
      transform: (fn) =>
        fn({
          add: (tool) => {
            tools.set(tool.name, tool);
            return tool;
          },
        }),
    },
    skill: { transform: (fn) => fn({ add: () => {} }) },
    rpc: { register: () => {} },
  };
  await plugin.setup(ctx);

  const listSpec = createToolSpecs(null).find((spec) => spec.name === "list_tasks");
  check("list_tasks spec.output схема определена", Boolean(listSpec?.output));

  const listTool = tools.get("list_tasks");
  check("list_tasks зарегистрирован", Boolean(listTool));
  check("list_tasks output передан в V2-регистрацию", Boolean(listTool?.output));
  if (listTool) {
    const res = await listTool.execute({}, {});
    check(
      "list_tasks: output — объект с массивом tasks",
      Boolean(res.output && Array.isArray(res.output.tasks))
    );
    check(
      "list_tasks: output и content несут один payload",
      Boolean(res.output) && res.content === JSON.stringify(res.output)
    );
    const payload = JSON.parse(res.content);
    check(
      "list_tasks: content — валидный JSON",
      Boolean(payload && Array.isArray(payload.tasks))
    );
    const task = (payload.tasks ?? []).find((t) => t.name === "Exec Hardening View");
    check("list_tasks: задача найдена", Boolean(task));
    check(
      "list_tasks: timeoutSeconds = 45",
      task?.timeoutSeconds === 45,
      `timeoutSeconds=${task?.timeoutSeconds}`
    );
  }
}

// --- 6. Живой стриминг лога: строки появляются ДО завершения задачи ---
// Регрессия: обёртка копила весь вывод в $output и сбрасывала его одним куском
// только после выхода opencode. Проверяем, что первая строка видна в логе, пока
// процесс ещё работает.
if (process.platform === "win32") {
  const spec = {
    name: "Exec Hardening Streaming",
    sanitized: "exec-hardening-streaming",
    timeoutSeconds: 30,
  };
  const { wrapperPath, logFile } = await prepareTask(spec);
  const child = spawn("cmd.exe", ["/c", wrapperPath], {
    env: { ...process.env, FAKE_MODE: "sleep", FAKE_SLEEP: "6" },
    windowsHide: true,
    stdio: "ignore",
  });
  const exited = new Promise((resolve) => child.on("exit", () => resolve()));

  // Ждём появления первой строки, пока задача ещё выполняется (ping ~5 с).
  const sawFirstLineEarly = await new Promise((resolve) => {
    const deadline = Date.now() + 4000;
    const poll = () => {
      if (readLog(logFile).includes("FAKE-OPENCODE-SLEEP-START")) {
        resolve(true);
        return;
      }
      if (child.exitCode !== null || Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });

  await exited;

  check(
    "стриминг: первая строка видна до завершения задачи",
    sawFirstLineEarly,
    "лог не пополнился, пока задача ещё работала"
  );
  check(
    "стриминг: финальная строка лога записана",
    readLog(logFile).includes("FAKE-OPENCODE-SLEEP-DONE")
  );
}

// --- G-1.2: тест-атака — агент переписывает gate-хук на «всегда успешно» ---
try {
  const spec = {
    name: "hardening gate attack",
    sanitized: "hardening-gate-attack",
    timeoutSeconds: 30,
    qualityGate: "exit /b 0",
  };
  const { wrapperPath, logFile } = await prepareTask(spec);
  const hookFile = path.join(pluginDir, "wrappers", "hooks", `run-${spec.sanitized}-gate.cmd`);
  check("G-1.2: gate-хук создан", fs.existsSync(hookFile));
  check(
    "G-1.2: обёртка получила путь снимка гейта",
    fs.readFileSync(wrapperPath, "utf8").includes("GateSnapshotFile")
  );

  const control = runWrapper(wrapperPath, {});
  check("G-1.2: контрольный прогон с гейтом успешен", control.status === 0, `status=${control.status}`);

  fs.writeFileSync(hookFile, "@echo off\r\nexit /b 0\r\n", "utf8");
  const attack = runWrapper(wrapperPath, {});
  check("G-1.2: подмена gate-хука даёт ненулевой код", attack.status !== 0, `status=${attack.status}`);
  check(
    "G-1.2: лог содержит snapshot mismatch",
    readLog(logFile).includes("snapshot mismatch"),
    readLog(logFile).slice(-400)
  );
  const records = getHistory(spec.name, 10);
  check(
    "G-1.2: история фиксирует ошибку целостности гейта",
    records.some((r) => r.status === "error" && String(r.error ?? "").includes("snapshot mismatch"))
  );
} catch (err) {
  console.log("[diag] G-1.2 attack THREW:", err instanceof Error ? err.stack : String(err));
  check("G-1.2: тест-атака не выбросила исключение", false, "section threw");
}

// --- ARCH-4.1/4.2: отложенные внешние эффекты + saga-компенсация ---
try {
  const makePlan = async (suffix) => {
    const context = createAdHocRunContext(`ARCH-4 ${suffix} миссия`, {
      taskName: `arch4-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      taskType: "mission",
      // ARCH-4 проверяет эффекты, а не очередь одобрений: держим R0.
      riskClass: "R0",
    });
    return buildExecutionPlan(context);
  };
  const localExecutor = {
    id: "arch4-test",
    supports: () => true,
    execute: async () => ({ output: "ok" }),
  };

  // ARCH-4.1: намерения до гейта; fail → эффекты не применены; irreversible не вызван.
  {
    const plan = await makePlan("fail");
    const calls = [];
    const intentsAtGate = [];
    const intents = [
      {
        id: "rev-before-gate",
        description: "обратимый эффект",
        reversibility: "reversible",
        apply: () => calls.push("apply:rev"),
        compensate: () => calls.push("comp:rev"),
      },
      {
        id: "irr-before-gate",
        description: "необратимый эффект",
        reversibility: "irreversible",
        apply: () => calls.push("apply:irr"),
      },
    ];
    const gate = () => {
      intentsAtGate.push(
        ...listEffectIntents().filter((row) => row.stepName === plan.steps[0].stepName)
      );
      return { ok: false, reason: "ARCH-4 gate rejected" };
    };
    const result = await executeExecutionPlan(plan, {
      executors: [localExecutor],
      gate,
      effects: intents,
    });
    check(
      "ARCH-4.1: намерения записаны в ledger до прогона гейта",
      intentsAtGate.length === 1 &&
        intentsAtGate[0].status === "intent" &&
        intentsAtGate[0].intents.length === 2,
      JSON.stringify(intentsAtGate)
    );
    check(
      "ARCH-4.1: irreversible не вызван до вердикта pass",
      !calls.includes("apply:irr"),
      calls.join(",")
    );
    check(
      "ARCH-4.1: fail → ни один эффект не применён",
      result.status === "failed" && calls.length === 0,
      `status=${result.status}, calls=${calls.join(",")}`
    );
    const outcomeKey = result.effects?.[0]?.outcomeKey;
    const ledger = outcomeKey ? readEffectIntentLedger(outcomeKey) : null;
    check(
      "ARCH-4.1: отказ записан в ledger как aborted с причиной",
      ledger?.status === "aborted" && /ARCH-4 gate rejected/.test(ledger.reason ?? ""),
      JSON.stringify(ledger)
    );
  }

  // ARCH-4.1: вердикт pass → эффекты применяются, effects_applied_at проставлен.
  {
    const plan = await makePlan("pass");
    const calls = [];
    let callsAtGate = [];
    const intents = [
      {
        id: "rev-pass",
        reversibility: "reversible",
        apply: () => calls.push("apply:rev-pass"),
        compensate: () => calls.push("comp:rev-pass"),
      },
      {
        id: "irr-pass",
        reversibility: "irreversible",
        apply: () => calls.push("apply:irr-pass"),
      },
    ];
    const gate = () => {
      callsAtGate = [...calls];
      return { ok: true };
    };
    const result = await executeExecutionPlan(plan, {
      executors: [localExecutor],
      gate,
      effects: intents,
    });
    check(
      "ARCH-4.1: pass → эффекты применены в объявленном порядке",
      result.status === "passed" && calls.join(",") === "apply:rev-pass,apply:irr-pass",
      `status=${result.status}, calls=${calls.join(",")}`
    );
    check(
      "ARCH-4.1: irreversible не вызван до вердикта pass",
      callsAtGate.length === 0 && !callsAtGate.includes("apply:irr-pass"),
      callsAtGate.join(",")
    );
    const outcomeKey = result.effects?.[0]?.outcomeKey;
    const ledger = outcomeKey ? readEffectIntentLedger(outcomeKey) : null;
    check(
      "ARCH-4.1: effects_applied_at проставлен только после pass",
      Boolean(ledger?.effectsAppliedAt) &&
        ledger?.status === "applied" &&
        ledger.intents.every((intent) => Boolean(intent.appliedAt)),
      JSON.stringify(ledger)
    );
  }

  // ARCH-4.2: частичный apply → откат обратимых, статус и причина в ledger/аудит.
  {
    const plan = await makePlan("saga");
    const calls = [];
    const intents = [
      {
        id: "saga-a",
        reversibility: "reversible",
        apply: () => calls.push("apply:a"),
        compensate: () => calls.push("comp:a"),
      },
      {
        id: "saga-b",
        reversibility: "reversible",
        apply: () => {
          calls.push("apply:b");
          throw new Error("saga boom");
        },
        compensate: () => calls.push("comp:b"),
      },
      {
        id: "saga-c",
        reversibility: "reversible",
        apply: () => calls.push("apply:c"),
        compensate: () => calls.push("comp:c"),
      },
    ];
    const result = await executeExecutionPlan(plan, {
      executors: [localExecutor],
      gate: () => ({ ok: true }),
      effects: intents,
    });
    check(
      "ARCH-4.2: частичный apply → компенсация в обратном порядке",
      calls.join(",") === "apply:a,apply:b,comp:a",
      calls.join(",")
    );
    const saga = result.effects?.[0];
    check(
      "ARCH-4.2: статус compensated и причина в результате саги",
      saga?.status === "compensated" &&
        /saga boom/.test(saga.reason ?? "") &&
        saga.compensatedIds.join(",") === "saga-a",
      JSON.stringify(saga)
    );
    const ledger = saga ? readEffectIntentLedger(saga.outcomeKey) : null;
    check(
      "ARCH-4.2: ledger и аудит фиксируют статус/причину",
      ledger?.status === "compensated" &&
        ledger.intents.map((intent) => `${intent.id}:${intent.status}`).join(",") ===
          "saga-a:compensated,saga-b:failed,saga-c:pending" &&
        readAuditLog({ action: "effects.compensated", target: saga.outcomeKey }).total > 0,
      JSON.stringify(ledger)
    );
    check("ARCH-4.2: провал эффекта не оставляет шаг passed", result.status === "failed");
  }
} catch (err) {
  console.log("[diag] ARCH-4 section THREW:", err instanceof Error ? err.stack : String(err));
  check("ARCH-4: секция не выбросила исключение", false, "section threw");
}

// --- PL-58: атрибуция файлов коммита при параллельных задачах в одном worktree ---
try {
  const {
    commitFilesFromDiff,
    commitFilesForTask,
    createCommitAttributionGate,
  } = await import("./dist/core/execution.js");

  // Реальный diff: «параллельные задачи» меняют файлы в одном worktree.
  const sharedRepo = path.join(tempRoot, "pl58-shared-worktree");
  fs.mkdirSync(sharedRepo, { recursive: true });
  const git = (args) =>
    spawnSync("git", args, { cwd: sharedRepo, encoding: "utf8", windowsHide: true });
  check("PL-58: git доступен для воспроизведения", git(["init", "-q"]).status === 0);
  git(["config", "user.email", "pl58@example.invalid"]);
  git(["config", "user.name", "PL-58"]);
  fs.writeFileSync(path.join(sharedRepo, "baseline.txt"), "base\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  const arch1 = "src/arch1.ts";
  const arch2 = "src/arch2.ts";
  const arch3 = "src/arch3.ts";
  for (const file of [arch1, arch2, arch3]) {
    const absolute = path.join(sharedRepo, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `// ${file}\n`, "utf8");
  }
  git(["add", "-A"]);
  const diffOutput = git(["diff", "--name-only", "HEAD"]).stdout;
  check(
    "PL-58: реальный diff содержит файлы трёх задач",
    [arch1, arch2, arch3].every((file) => diffOutput.includes(file)),
    diffOutput
  );

  // ARCH-3 не должен коммитить файлы ARCH-1/ARCH-2 (14 чужих файлов в находке).
  const attribution = commitFilesForTask(diffOutput, [arch3]);
  check(
    "PL-58: список файлов коммита вычислен из фактического diff",
    attribution.commitFiles.join(",") === arch3,
    JSON.stringify(attribution)
  );
  check(
    "PL-58: чужие файлы ARCH-1/ARCH-2 обнаружены",
    [...attribution.foreignFiles].sort().join(",") === [arch1, arch2].sort().join(","),
    JSON.stringify(attribution.foreignFiles)
  );
  check(
    "PL-58: парсер diff нормализует CRLF/пустые строки/дубли",
    commitFilesFromDiff(`${arch3}\r\n\r\n${arch3}\n`).join(",") === arch3
  );

  // qualityGate: коммит с чужими файлами отклоняется, чистый — проходит.
  const makePlan = async (suffix) =>
    buildExecutionPlan(
      createAdHocRunContext(`PL-58 ${suffix} миссия`, {
        taskName: `pl58-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        taskType: "mission",
        riskClass: "R0",
      })
    );
  const localExecutor = { id: "pl58-test", supports: () => true, execute: async () => ({}) };

  const badResult = await executeExecutionPlan(await makePlan("bad"), {
    executors: [localExecutor],
    gate: createCommitAttributionGate({ manifest: [arch3], diff: () => diffOutput }),
  });
  check(
    "PL-58: qualityGate отклоняет коммит с чужими файлами",
    badResult.status === "failed" && /arch1|arch2/.test(badResult.error ?? ""),
    `status=${badResult.status}, error=${badResult.error}`
  );

  const goodResult = await executeExecutionPlan(await makePlan("good"), {
    executors: [localExecutor],
    gate: createCommitAttributionGate({
      manifest: [arch1, arch2, arch3],
      diff: () => diffOutput,
    }),
  });
  check(
    "PL-58: qualityGate пропускает коммит только со своими файлами",
    goodResult.status === "passed",
    `status=${goodResult.status}, error=${goodResult.error}`
  );

  // Усиление post-flight: список файлов берётся из diff, чужие — предупреждаются.
  const commitScript = fs.readFileSync(path.join("scripts", "pl-commit.ps1"), "utf8");
  check(
    "PL-58: pl-commit.ps1 вычисляет файлы коммита через git diff --name-only",
    /diff\s+--name-only/.test(commitScript)
  );
  check(
    "PL-58: pl-commit.ps1 предупреждает о файлах вне manifest",
    /PL-58/.test(commitScript) && /WARN/.test(commitScript)
  );
} catch (err) {
  console.log("[diag] PL-58 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-58: секция не выбросила исключение", false, "section threw");
}

// --- PL-59: причина пропуска worktree-snapshot и обязательность снимка ---
try {
  const {
    decideWorktreeSnapshot,
    enforceWorktreeSnapshot,
    worktreeSnapshotFileFor,
    createRegisteredRunContext,
    buildExecutionPlan,
    executeExecutionPlan,
  } = await import("./dist/core/execution.js");
  const { captureWorktreeSnapshot } = await import("./dist/core/gate-integrity.js");
  const { annotateHistoryWithSnapshotPolicy } = await import("./dist/server.js");

  // Настоящий git-репозиторий с guarded-путём src/ (как у семи ARCH-задач).
  const repo = path.join(tempRoot, "pl59-worktree");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "pl59.ts"), "// PL-59\n", "utf8");
  const git = (args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  check("PL-59: git доступен для воспроизведения", git(["init", "-q"]).status === 0);
  git(["config", "user.email", "pl59@example.invalid"]);
  git(["config", "user.name", "PL-59"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  const env = { ...process.env, AGENT_STEWARD_GATE_GUARD_PATHS: "src" };
  const taskName = `pl59-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const snapshotFile = worktreeSnapshotFileFor(taskName);
  fs.rmSync(snapshotFile, { force: true });

  // Без qualityGate снимок не нужен, но причина пропуска логируется.
  const logs = [];
  const noGate = decideWorktreeSnapshot({
    taskName,
    workdir: repo,
    env,
    log: (message) => logs.push(message),
  });
  check("PL-59: без qualityGate снимок не обязателен", noGate.required === false);
  check(
    "PL-59: причина пропуска без qualityGate записана",
    /qualityGate не задан/.test(noGate.skipReason) && logs.some((line) => line.includes("PL-59")),
    JSON.stringify({ reason: noGate.skipReason, logs })
  );

  // qualityGate + git-дерево с guarded-путями → снимок обязателен, но отсутствует.
  const missing = decideWorktreeSnapshot({
    taskName,
    qualityGate: "node -e \"process.exit(0)\"",
    workdir: repo,
    env,
    log: (message) => logs.push(message),
  });
  check("PL-59: qualityGate + guarded-путь делает снимок обязательным", missing.required === true);
  check("PL-59: отсутствующий снимок не считается снятым", missing.taken === false);
  check(
    "PL-59: причина пропуска объясняет отсутствие снимка",
    /обязательный worktree-snapshot отсутствует/.test(missing.skipReason),
    missing.skipReason
  );
  check("PL-59: причина пропуска залогирована", logs.some((line) => line.includes("отсутствует")), logs.join(" | "));
  let enforcedError = "";
  try {
    enforceWorktreeSnapshot(missing);
  } catch (err) {
    enforcedError = String(err?.message ?? err);
  }
  check(
    "PL-59: fail-closed — гейт не стартует без обязательного снимка",
    /обязательный worktree-snapshot отсутствует/.test(enforcedError),
    enforcedError
  );

  // Реальный снимок дерева снимаем той же командой, что и обёртка (PL-25).
  const snapshotPath = captureWorktreeSnapshot(repo, snapshotFile, env);
  check("PL-59: снимок дерева реально создан", Boolean(snapshotPath) && fs.existsSync(snapshotFile));
  const present = decideWorktreeSnapshot({
    taskName,
    qualityGate: "node -e \"process.exit(0)\"",
    workdir: repo,
    env,
  });
  check("PL-59: со снимком снимок обязателен и снят", present.required && present.taken);
  check("PL-59: со снимком причина пропуска пуста", present.skipReason === "", present.skipReason);
  let enforcedOk = true;
  try {
    enforceWorktreeSnapshot(present);
  } catch {
    enforcedOk = false;
  }
  check("PL-59: со снимком fail-closed не срабатывает", enforcedOk);

  // Не-git дерево с guarded-путём: причина — отсутствие git, не «skipped».
  const notRepo = path.join(tempRoot, "pl59-not-a-repo");
  fs.mkdirSync(path.join(notRepo, "src"), { recursive: true });
  const nonGit = decideWorktreeSnapshot({
    taskName,
    qualityGate: "node -e \"process.exit(0)\"",
    workdir: notRepo,
    env,
  });
  check(
    "PL-59: не-git дерево не создаёт ложной обязательности",
    nonGit.required === false && /git-репозиторием/.test(nonGit.skipReason),
    JSON.stringify(nonGit)
  );

  // Интеграция с execution loop: зарегистрированная задача с qualityGate.
  const localExecutor = { id: "pl59-test", supports: () => true, execute: async () => ({}) };
  const noSnapName = `pl59-exec-nosnap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.rmSync(worktreeSnapshotFileFor(noSnapName), { force: true });
  const registered = createRegisteredRunContext(
    {
      name: noSnapName,
      prompt: "PL-59 execution loop",
      workingDirectory: repo,
      qualityGate: "node -e \"process.exit(0)\"",
    },
    { riskClass: "R0" }
  );
  const plan = await buildExecutionPlan(registered);
  let loopError = "";
  try {
    await executeExecutionPlan(plan, { executors: [localExecutor] });
  } catch (err) {
    loopError = String(err?.message ?? err);
  }
  check(
    "PL-59: execution loop отклоняет прогон без обязательного снимка",
    /обязательный worktree-snapshot отсутствует/.test(loopError),
    loopError
  );

  captureWorktreeSnapshot(repo, worktreeSnapshotFileFor(noSnapName), env);
  const withSnap = await executeExecutionPlan(plan, { executors: [localExecutor] });
  check(
    "PL-59: execution loop допускает прогон со снимком и возвращает решение",
    withSnap.status === "passed" &&
      withSnap.snapshot?.required === true &&
      withSnap.snapshot?.taken === true,
    JSON.stringify({ status: withSnap.status, snapshot: withSnap.snapshot })
  );

  // История: причина пропуска доступна потребителям /api/history и дашборду.
  const annotated = annotateHistoryWithSnapshotPolicy(
    [
      { taskName: taskName.toLowerCase(), status: "success", preFlightStatus: "skipped" },
      { taskName: "pl59-no-definition", status: "success", preFlightStatus: "skipped" },
      { taskName: taskName.toLowerCase(), status: "success", preFlightStatus: "success" },
    ],
    [{ name: taskName, qualityGate: "node -e \"process.exit(0)\"", workingDirectory: repo }],
    env
  );
  check(
    "PL-59: skipped-запись истории несёт причину пропуска",
    /qualityGate|снимок/.test(annotated[0].preFlightReason) &&
      annotated[0].gateSnapshotRequired === true,
    JSON.stringify(annotated[0])
  );
  check(
    "PL-59: запись без definition объясняет неизвестную причину",
    /definition задачи не найден/.test(annotated[1].preFlightReason),
    annotated[1].preFlightReason
  );
  check(
    "PL-59: успешный pre-flight не получает лишней причины",
    annotated[2].preFlightReason === "",
    annotated[2].preFlightReason
  );
} catch (err) {
  console.log("[diag] PL-59 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-59: секция не выбросила исключение", false, "section threw");
}

// --- PL-62: код выхода процесса агента ≠ результат qualityGate ---
try {
  const {
    shouldRunQualityGate,
    resolveAgentExitVerdict,
  } = await import("./dist/core/execution.js");

  // Воспроизведение дефекта: exit=1, но агент оставил артефакт и гейт прошел.
  {
    const logs = [];
    const verdict = resolveAgentExitVerdict({
      agentExitCode: 1,
      gatePassed: true,
      taskName: "PL-62 divergence",
      log: (line) => logs.push(line),
    });
    check(
      "PL-62: exit=1 + gate=pass даёт success (код выхода не вердикт)",
      verdict.status === "success" && verdict.diverged === true,
      JSON.stringify(verdict)
    );
    check(
      "PL-62: причина кода 1 зафиксирована в логе и результате",
      /Код возврата 1/.test(verdict.reason ?? "") &&
        logs.some((line) => line.includes("PL-62") && line.includes("qualityGate=pass")),
      JSON.stringify({ reason: verdict.reason, logs })
    );
    check(
      "PL-62: при расхождении gate/afterScript остаются запущенными",
      verdict.runQualityGate === true && verdict.runAfterScript === true,
      JSON.stringify(verdict)
    );
  }

  // Обычные и аварийные комбинации не меняют прежнюю семантику.
  {
    const clean = resolveAgentExitVerdict({ agentExitCode: 0, gatePassed: true });
    check(
      "PL-62: exit=0 + gate=pass — чистый success без причины",
      clean.status === "success" && clean.diverged === false && clean.reason === null,
      JSON.stringify(clean)
    );
    const gateFail = resolveAgentExitVerdict({ agentExitCode: 1, gatePassed: false });
    check(
      "PL-62: exit=1 + gate=fail — error, расхождений нет",
      gateFail.status === "error" && gateFail.diverged === false,
      JSON.stringify(gateFail)
    );
    const inverted = resolveAgentExitVerdict({ agentExitCode: 0, gatePassed: false });
    check(
      "PL-62: exit=0 + gate=fail — error по вердикту гейта",
      inverted.status === "error" && inverted.diverged === true,
      JSON.stringify(inverted)
    );
    const noGate = resolveAgentExitVerdict({ agentExitCode: 1, gatePassed: null });
    check(
      "PL-62: без гейта код выхода остаётся источником статуса",
      noGate.status === "error" && /Код возврата 1/.test(noGate.reason ?? ""),
      JSON.stringify(noGate)
    );
  }

  // Решение о запуске гейта: ненулевой код не отменяет гейт при артефактах.
  {
    const logs = [];
    const withWork = shouldRunQualityGate({
      agentExitCode: 1,
      hasQualityGate: true,
      workCompleted: true,
      log: (line) => logs.push(line),
    });
    const crash = shouldRunQualityGate({
      agentExitCode: 1,
      hasQualityGate: true,
      workCompleted: false,
      log: (line) => logs.push(line),
    });
    const noGate = shouldRunQualityGate({ agentExitCode: 1, hasQualityGate: false });
    check(
      "PL-62: гейт запускается при exit=1 и артефактах работы",
      withWork === true && crash === false && noGate === false,
      JSON.stringify({ withWork, crash, noGate })
    );
    check(
      "PL-62: пропуск гейта при аварии до работы логируется",
      logs.some((line) => line.includes("PL-62") && line.includes("пропущен")),
      logs.join(" | ")
    );
  }

  // Интеграция в execution loop: executor сообщил exit=1, но гейт прошёл.
  {
    const makePlan = async (suffix) => {
      const context = createAdHocRunContext(`PL-62 ${suffix} миссия`, {
        taskName: `pl62-${suffix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        taskType: "mission",
        riskClass: "R0",
      });
      return buildExecutionPlan(context);
    };
    let gateCalls = 0;
    const gate = () => {
      gateCalls += 1;
      return { ok: true };
    };
    const executor = {
      id: "pl62-test",
      supports: () => true,
      execute: async () => ({
        output: "done",
        error: "Код возврата 1",
        exitCode: 1,
      }),
    };
    const plan = await makePlan("diverged");
    const result = await executeExecutionPlan(plan, { executors: [executor], gate });
    check(
      "PL-62: execution loop не помечает расхождение как failed",
      result.status === "passed" && gateCalls === 1,
      JSON.stringify({ status: result.status, gateCalls, steps: result.steps })
    );
    check(
      "PL-62: шаг с exit=1 и пройденным гейтом остаётся passed",
      result.steps[0]?.status === "passed",
      JSON.stringify(result.steps)
    );

    gateCalls = 0;
    const crashPlan = await makePlan("crash");
    const crashResult = await executeExecutionPlan(crashPlan, {
      executors: [{ id: "pl62-crash", supports: () => true, execute: async () => ({ error: "Код возврата 1", exitCode: 1 }) }],
      gate,
    });
    check(
      "PL-62: при аварии без артефактов гейт не запускается, шаг failed",
      crashResult.status === "failed" && gateCalls === 0,
      JSON.stringify({ status: crashResult.status, gateCalls })
    );
  }
} catch (err) {
  console.log("[diag] PL-62 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-62: секция не выбросила исключение", false, "section threw");
}

// --- PL-77 / PL-79 / PL-82 / PL-86 / PL-87 / PL-99: pre-flight guards ---
try {
  const {
    extractScopePaths,
    validateScopePaths,
    preflightScope,
    planParallelExecution,
    detectStaleTask,
  } = await import("./dist/core/scheduler/run-now.js");

  // PL-79 / PL-82: весь список SCOPE проверяется до создания/обновления задачи.
  const scopePrompt = [
    "GOAL: проверка pre-flight",
    "SCOPE: src/index.ts, src/core/ps-wrapper.ts, reports/new-report.md",
  ].join("\n");
  const extracted = extractScopePaths(scopePrompt);
  check(
    "PL-79: extractScopePaths забирает весь список SCOPE",
    JSON.stringify(extracted) ===
      JSON.stringify(["src/index.ts", "src/core/ps-wrapper.ts", "reports/new-report.md"]),
    JSON.stringify(extracted),
  );
  const missingCheck = validateScopePaths(
    ["src/index.ts", "test-not-exists-marker.zzz"],
    process.cwd(),
  );
  check(
    "PL-79: validateScopePaths ловит несуществующий путь",
    !missingCheck.ok && missingCheck.missing.includes("test-not-exists-marker.zzz"),
    JSON.stringify(missingCheck),
  );
  const okCheck = validateScopePaths(["src/index.ts", "package.json"], process.cwd());
  check(
    "PL-82: реальные SCOPE-пути проходят pre-flight",
    okCheck.ok && okCheck.missing.length === 0,
    JSON.stringify(okCheck),
  );
  check(
    "PL-82: preflightScope читает SCOPE из промпта",
    preflightScope("SCOPE: src/index.ts", process.cwd()).ok === true,
  );
  check(
    "PL-79: glob-путь SCOPE нормализуется до директории",
    JSON.stringify(extractScopePaths("SCOPE: src/core/scheduler/*")) ===
      JSON.stringify(["src/core/scheduler"]),
  );

  // PL-120: проза после последнего пути не попадает в paths.
  const proseScope = extractScopePaths(
    "SCOPE: src/index.ts, docs/FEATURES.md. Файл src/core/agents.ts — заглушка...",
  );
  check(
    "PL-120: проза после последнего пути не попадает в paths",
    JSON.stringify(proseScope) === JSON.stringify(["src/index.ts", "docs/FEATURES.md"]),
    JSON.stringify(proseScope),
  );
  const proseOnlyScope = extractScopePaths(
    "SCOPE: src/core/scheduler/* — каталог планировщика, дальше описание",
  );
  check(
    "PL-120: проза после glob не попадает в paths",
    JSON.stringify(proseOnlyScope) === JSON.stringify(["src/core/scheduler"]),
    JSON.stringify(proseOnlyScope),
  );
  const mixedScope = extractScopePaths(
    "SCOPE: src/index.ts, src\\core\\scheduler\\*, locales/tr.json",
  );
  check(
    "PL-120: корректные пути и glob по-прежнему разбираются",
    JSON.stringify(mixedScope) ===
      JSON.stringify(["src/index.ts", "src\\core\\scheduler", "locales/tr.json"]),
    JSON.stringify(mixedScope),
  );

  // PL-144: кириллическая проза — не путь. Раньше pathRun включал а-яёА-ЯЁ,
  // поэтому «SCOPE: только TEST-PLAN.md» отвергалось pre-flight как путь «только».
  const cyrillicOnlyScope = extractScopePaths("SCOPE: только TEST-PLAN.md");
  check(
    "PL-144: русская проза не распознаётся как SCOPE-путь",
    JSON.stringify(cyrillicOnlyScope) === JSON.stringify([]),
    JSON.stringify(cyrillicOnlyScope),
  );
  const cyrillicMixedScope = extractScopePaths(
    "SCOPE: TEST-PLAN.md, ещё немного описания задачи",
  );
  check(
    "PL-144: корректный путь после кириллической прозы разбирается",
    JSON.stringify(cyrillicMixedScope) === JSON.stringify(["TEST-PLAN.md"]),
    JSON.stringify(cyrillicMixedScope),
  );
  const cyrillicSourceCheck = fs.readFileSync(
    new URL("./src/core/scheduler/run-now.ts", import.meta.url),
    "utf8",
  );
  const pathRunLine = cyrillicSourceCheck.split("\n").find((line) => line.includes("const pathRun ="));
  check(
    "PL-144: алфавит SCOPE-пути не содержит кириллицу",
    !!pathRunLine && !/[а-яёА-ЯЁ]/.test(pathRunLine),
    pathRunLine ?? "pathRun не найден",
  );

  // PL-119: create-intent — SCOPE-пути создаваемых файлов не считаются missing.
  // Берём заведомо несуществующие маркеры, чтобы проверка не зависела от диска.
  const createIntentPaths = [
    "test-pl119-create-intent-a.zzz",
    "test-pl119-create-intent-b.zzz",
  ];
  const createIntentCheck = validateScopePaths(createIntentPaths, process.cwd(), {
    filesCreate: createIntentPaths,
  });
  check(
    "PL-119: create-intent проходит pre-flight для SCOPE-путей создаваемых файлов",
    createIntentCheck.ok === true && createIntentCheck.missing.length === 0,
    JSON.stringify(createIntentCheck),
  );
  const createIntentViaPreflight = preflightScope(
    `SCOPE: ${createIntentPaths.join(", ")}`,
    process.cwd(),
    { filesCreate: createIntentPaths },
  );
  check(
    "PL-119: preflightScope читает create-intent из opts.filesCreate",
    createIntentViaPreflight.ok === true &&
      createIntentViaPreflight.missing.length === 0,
    JSON.stringify(createIntentViaPreflight),
  );
  const unconfirmedCheck = validateScopePaths(
    ["test-not-exists-marker.zzz"],
    process.cwd(),
    { filesCreate: ["src/index.ts", "package.json"] },
  );
  check(
    "PL-119: неподтверждённый missing путь по-прежнему отклоняется",
    unconfirmedCheck.ok === false &&
      unconfirmedCheck.missing.includes("test-not-exists-marker.zzz"),
    JSON.stringify(unconfirmedCheck),
  );
  const emptyCreateCheck = validateScopePaths(
    ["test-not-exists-marker.zzz"],
    process.cwd(),
    { filesCreate: [] },
  );
  const emptyCreateOkCheck = validateScopePaths(["src/index.ts"], process.cwd(), {
    filesCreate: [],
  });
  check(
    "PL-119: пустой filesCreate не ломает проверку (back-compat)",
    emptyCreateCheck.ok === false &&
      emptyCreateCheck.missing.includes("test-not-exists-marker.zzz") &&
      emptyCreateOkCheck.ok === true,
    JSON.stringify({ emptyCreateCheck, emptyCreateOkCheck }),
  );

  // PL-77: параллельные агенты не делят worktree, maxConcurrent не нарушается.
  const sequential = planParallelExecution({ maxConcurrent: 1, taskName: "Agent One" });
  check(
    "PL-77: maxConcurrent=1 не форсирует worktree",
    sequential.allowed === true && sequential.worktree === false,
    JSON.stringify(sequential),
  );
  const parallel = planParallelExecution({ maxConcurrent: 4, taskName: "Agent Two" });
  check(
    "PL-77: параллель форсирует уникальный worktree",
    parallel.allowed === true && parallel.worktree === true,
    JSON.stringify(parallel),
  );
  const limited = planParallelExecution({
    maxConcurrent: 2,
    runningCount: 2,
    taskName: "Agent Three",
    worktree: true,
  });
  check(
    "PL-77: guard maxConcurrent блокирует новый запуск",
    limited.allowed === false && /maxConcurrent/.test(limited.reason ?? ""),
    JSON.stringify(limited),
  );
  check(
    "PL-77: ключ worktree уникален на задачу",
    parallel.worktreeKey !==
      planParallelExecution({ maxConcurrent: 4, taskName: "Agent Four" }).worktreeKey,
  );

  // PL-86/87: .cmd передаёт -Workdir, PS-обёртка не падает на Path-ошибке квоты.
  const spacedWorkdir = path.join(tempRoot, "workdir with spaces");
  fs.mkdirSync(spacedWorkdir, { recursive: true });
  const pl86Name = `pl86-${Date.now()}`;
  const pl86Prompt = await writePromptFile(pl86Name, "PL-86 probe");
  const pl86Wrapper = await writeWrapperCmd(
    pl86Name.replace(/[^a-zA-Z0-9_-]/g, "-"),
    pl86Name,
    pl86Prompt,
    60,
    lockFilePath(pl86Name),
    spacedWorkdir,
    path.join(pluginDir, "logs", `${pl86Name}.log`),
    recorder,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "new",
    undefined,
  );
  const pl86Cmd = fs.readFileSync(pl86Wrapper, "utf8");
  check(
    "PL-86: сгенерированный .cmd содержит -Workdir с путём задачи",
    pl86Cmd.includes("-Workdir") && pl86Cmd.includes(spacedWorkdir),
    pl86Cmd.slice(0, 400),
  );
  check(
    "PL-87: PS-обёртка подставляет Workdir, если старый .cmd его не передал",
    psWrapperScript.includes("if (-not $Workdir) { $Workdir = (Get-Location).Path }"),
  );
  check(
    "PL-87: формирование quota-diff точки обёрнуто в try/catch с фолбэком",
    psWrapperScript.includes("$quotaDiff = \"\"") &&
      psWrapperScript.includes("[System.IO.Path]::GetTempPath()"),
  );
  check(
    "PL-87: сообщение о квоте содержит путь diff и подсказку по модели",
    psWrapperScript.includes("Частичные правки сохранены в $quotaDiff") &&
      psWrapperScript.includes("$modelHint"),
  );

  // PL-99: закрытая находка отсекается до запуска задачи.
  const openFinding = detectStaleTask({
    id: "PL-73",
    roadmap: "- [ ] PL-73: ретраи логов",
    changelog: "- **PL-73 — исправлено.**",
    gitDiff: "+PL-73",
  });
  check(
    "PL-99: открытая в ROADMAP находка не считается stale",
    openFinding.stale === false,
    JSON.stringify(openFinding),
  );
  const closedFinding = detectStaleTask({
    id: "PL-73",
    roadmap: "- [ ] PL-99: другая находка",
    changelog: "- **PL-73 — уже исправлено коммитом 9f6c1c5.**",
    gitDiff: "+PL-73",
  });
  check(
    "PL-99: закрытая находка отключается до запуска",
    closedFinding.stale === true && closedFinding.action === "disable",
    JSON.stringify(closedFinding),
  );
} catch (err) {
  console.log("[diag] PL-77/79/82/86/87/99 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-77/79/82/86/87/99: секция не выбросила исключение", false, "section threw");
}

// --- PL-121: checkout-lock и причина gate-integrity (строковые регрессии) ---
// Без реального powershell: проверяем WRAPPER_SCRIPT из dist, чтобы не зависеть
// от OC-планировщика и параллельной нагрузки.
try {
  check(
    "PL-121: checkout-lock ключ — SHA256 от Workdir, первые 16 hex",
    psWrapperScript.includes("[System.Security.Cryptography.SHA256]::Create()") &&
      psWrapperScript.includes("[System.Text.Encoding]::UTF8.GetBytes($Workdir)") &&
      psWrapperScript.includes(".Substring(0, 16).ToLowerInvariant()") &&
      psWrapperScript.includes('"checkout-$checkoutHash.lock"')
  );
  check(
    "PL-121: checkout-lock захватывается атомарно (CreateNew) с PID-ISO",
    psWrapperScript.includes(
      "[System.IO.File]::Open($script:checkoutLockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)"
    ) && psWrapperScript.includes('"$PID-$startedAtIso"')
  );
  check(
    "PL-121: живой владелец checkout-lock пропускает задачу с причиной PL-121",
    psWrapperScript.includes("PL-121: в чек-ауте $Workdir уже идёт другая задача") &&
      psWrapperScript.includes("$script:skipMainTask = $true") &&
      psWrapperScript.includes("Get-LockOwnerPid -Content $checkoutHolderRaw") &&
      psWrapperScript.includes("Test-ProcessAlive -ProcessId $checkoutHolderPid")
  );
  check(
    "PL-121: checkout-lock освобождается в finally только своим владельцем",
    psWrapperScript.includes("Remove-Item $script:checkoutLockFile -Force") &&
      psWrapperScript.includes("$script:checkoutLockAcquired")
  );
  check(
    "PL-121: errorMessage гейта содержит причину gate-integrity (изменённые пути)",
    psWrapperScript.includes('$gateMarker = "gate-integrity:"') &&
      psWrapperScript.includes("$script:errorMessage = $worktreeDetail") &&
      psWrapperScript.includes('$worktreeDetail = "$worktreeDetail ($worktreeReason)"')
  );
} catch (err) {
  console.log("[diag] PL-121 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-121: секция не выбросила исключение", false, "section threw");
}

// --- PL-146: пропуск по PL-121 оставляет durable-запись skipped с причиной ---
try {
  const skipReasonAt = psWrapperScript.indexOf("$checkoutSkipReason = \"PL-121:");
  const skipB64At = psWrapperScript.indexOf("$checkoutSkipB64 = [Convert]::ToBase64String");
  const skipRecordAt = psWrapperScript.indexOf('--skip "$TaskName" "$checkoutSkipB64"');
  const skipExitAt = psWrapperScript.indexOf("$script:skipMainTask = $true", skipReasonAt);
  check(
    "PL-146: причина PL-121 кодируется в base64 и пишется в историю через --skip",
    skipReasonAt >= 0 &&
      skipB64At > skipReasonAt &&
      skipRecordAt > skipB64At &&
      psWrapperScript.includes("[Text.Encoding]::UTF8.GetBytes($checkoutSkipReason)") &&
      psWrapperScript.includes("if ($RecorderFile)"),
    `reason=${skipReasonAt}, b64=${skipB64At}, skip=${skipRecordAt}`
  );
  check(
    "PL-146: запись skipped выполняется до выхода с кодом 0",
    skipExitAt > skipRecordAt && psWrapperScript.slice(skipExitAt, skipExitAt + 400).includes("exit 0")
  );
} catch (err) {
  console.log("[diag] PL-146 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-146: секция не выбросила исключение", false, "section threw");
}

// --- PL-130: причина падения агента вместо «Код возврата 1» (строковые регрессии) ---
// Без реального powershell: проверяем WRAPPER_SCRIPT из dist, поэтому тест
// детерминирован и не зависит от OC-планировщика.
try {
  check(
    "PL-130: причина извлекается из хвоста лога агента (-Tail 80 -Encoding UTF8 + фильтр)",
    psWrapperScript.includes("Get-Content -LiteralPath $LogFile -Tail 80 -Encoding UTF8") &&
      psWrapperScript.includes(
        "error|ERROR|Error|ошибка|OOM|limit|quota|ENOTFOUND|ECONNRESET"
      ) &&
      psWrapperScript.includes("Select-Object -Last 1")
  );
  check(
    "PL-130: причина подставляется в errorMessage после «Код возврата N» и дублируется в Write-Log",
    psWrapperScript.includes('$script:errorMessage = "Код возврата $($script:exitCode)"') &&
      psWrapperScript.includes("$($script:errorMessage). Причина: $errorReason") &&
      psWrapperScript.includes("PL-130: причина ошибки агента: $errorReason")
  );
  check(
    "PL-130: причина санитизируется (ANSI/управляющие) и обрезается до 200 символов",
    psWrapperScript.includes(
      '$errorReason = [regex]::Replace($errorReason, "$esc\\[[0-9;?]*[A-Za-z]", "")'
    ) && psWrapperScript.includes("$errorReason.Substring(0, 200)")
  );
  check(
    "PL-130: ветка квоты PL-83 не переписана под общую причину",
    psWrapperScript.includes("PL-83: квота модели исчерпана ($quotaReason)") &&
      psWrapperScript.includes("$script:exitCode = 126")
  );
} catch (err) {
  console.log("[diag] PL-130 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-130: секция не выбросила исключение", false, "section threw");
}

// --- PL-140: причина провала Quality Gate в errorMessage и логе (строковые регрессии) ---
// Проверяем WRAPPER_SCRIPT из dist — без реального powershell и планировщика.
try {
  check(
    "PL-140: общий хелпер санитизации определён и вызывается и гейтом, и агентом",
    psWrapperScript.includes("function Get-SanitizedReason") &&
      psWrapperScript.includes("Get-SanitizedReason -ReasonLines $gateReasonLines") &&
      psWrapperScript.includes("Get-SanitizedReason -ReasonLines $reasonLines")
  );
  check(
    "PL-140: причина гейта извлекается из хвоста вывода (lastHookStdout/lastHookStderr)",
    psWrapperScript.includes(
      "foreach ($gateStream in @($script:lastHookStdout, $script:lastHookStderr))"
    ) && psWrapperScript.includes("$gateOutputLines | Select-Object -Last 1")
  );
  check(
    "PL-140: причина гейта форматируется в errorMessage и Write-Log, а не только «Код возврата N»",
    psWrapperScript.includes('$gateDetail = "Quality Gate провален. Код возврата: $gateCode"') &&
      psWrapperScript.includes('$gateDetail = "$gateDetail. Причина: $gateReason"') &&
      psWrapperScript.includes("$script:errorMessage = $gateDetail") &&
      psWrapperScript.includes('Write-Log "[agent-steward] ОШИБКА: $gateDetail"') &&
      !psWrapperScript.includes(
        'Write-Log "[agent-steward] ОШИБКА: Quality Gate провален. Код возврата: $gateCode"'
      )
  );
} catch (err) {
  console.log("[diag] PL-140 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-140: секция не выбросила исключение", false, "section threw");
}

// --- PL-150: в allow-пути гейта попадают SCOPE и filesCreate, а не только afterScript ---
try {
  check(
    "PL-150: SCOPE-пути разрешены без afterScript",
    gateAllowPathsFromScope(["src/core/ps-wrapper.ts", "test-execution-hardening.mjs"], []) ===
      "src/core/ps-wrapper.ts|test-execution-hardening.mjs"
  );
  check(
    "PL-150: filesCreate и afterScript объединяются с SCOPE без дублей",
    gateAllowPathsFromScope(
      ["src/core/ps-wrapper.ts"],
      ["reports/new.md"],
      '-Files "reports/new.md;scripts/pl-commit.ps1"'
    ) === "src/core/ps-wrapper.ts|reports/new.md|scripts/pl-commit.ps1"
  );
  check(
    "PL-150: пути нормализуются (слэши, ./, ведущий /, завершающий /)",
    gateAllowPathsFromScope(["./src\\core/", "/docs/FEATURES.md"], []) ===
      "src/core|docs/FEATURES.md"
  );
  check(
    "PL-150: пустые источники дают пустую строку",
    gateAllowPathsFromScope([], [], undefined) === ""
  );
  check(
    "PL-150: исходная gateAllowPathsFromAfterScript не изменена",
    gateAllowPathsFromAfterScript(
      'powershell.exe -File pl-commit.ps1 -Files "src/index.ts;ROADMAP.md" -Marker "m"',
    ) === "src/index.ts|ROADMAP.md" &&
      gateAllowPathsFromAfterScript("echo OK>m") === ""
  );
  check(
    "PL-150: null-входы и вложенные ./ нормализуются без дублей",
    gateAllowPathsFromScope(null, null, undefined) === "" &&
      gateAllowPathsFromScope(["src/core/./a.ts"], ["./src/core/a.ts"], undefined) ===
        "src/core/a.ts"
  );

  // Реальный post-flight: СОБСТВЕННАЯ правка в SCOPE проходит, чужая — нет.
  const wtRepo = path.join(tempRoot, "pl150-worktree-repo");
  fs.mkdirSync(path.join(wtRepo, "src"), { recursive: true });
  fs.mkdirSync(path.join(wtRepo, "docs"), { recursive: true });
  const ownFile = path.join(wtRepo, "src", "own.ts");
  const foreignFile = path.join(wtRepo, "docs", "foreign.md");
  fs.writeFileSync(ownFile, "clean\n", "utf8");
  fs.writeFileSync(foreignFile, "clean\n", "utf8");
  const git = (args) =>
    spawnSync("git", ["-C", wtRepo, ...args], { encoding: "utf8", windowsHide: true });
  git(["init", "-q"]);
  git(["config", "user.email", "qa@example.invalid"]);
  git(["config", "user.name", "QA"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "clean"]);
  const wtSnapshot = path.join(tempRoot, "pl150-worktree-snapshot.json");
  const { captureWorktreeSnapshot, verifyWorktreeSnapshot } = await import(
    "./dist/core/gate-integrity.js"
  );
  const guardEnv = {
    ...process.env,
    AGENT_STEWARD_GATE_GUARD_PATHS: "src|docs",
    AGENT_STEWARD_GATE_ALLOW_PATHS: gateAllowPathsFromScope(["src"], [], undefined),
  };
  captureWorktreeSnapshot(wtRepo, wtSnapshot, guardEnv);
  const noAllowEnv = { ...guardEnv, AGENT_STEWARD_GATE_ALLOW_PATHS: "" };

  fs.writeFileSync(ownFile, "agent edit\n", "utf8");
  check(
    "PL-150: без allowlist правка SCOPE выглядит посторонней (контроль false-positive)",
    verifyWorktreeSnapshot(wtRepo, wtSnapshot, noAllowEnv).ok === false
  );
  check(
    "PL-150: правка в SCOPE проходит worktree-verify с объединённым allowlist",
    verifyWorktreeSnapshot(wtRepo, wtSnapshot, guardEnv).ok === true
  );

  fs.writeFileSync(foreignFile, "foreign edit\n", "utf8");
  const foreignVerify = verifyWorktreeSnapshot(wtRepo, wtSnapshot, guardEnv);
  check(
    "PL-150: чужой путь вне SCOPE/filesCreate/afterScript всё ещё отклоняется",
    foreignVerify.ok === false && /защищённые пути/.test(foreignVerify.reason ?? ""),
    foreignVerify.reason
  );

  const indexSrc = fs.readFileSync(path.resolve("src/index.ts"), "utf8");
  check(
    "PL-150: оба вызова wrapper используют объединённый список путей",
    !indexSrc.includes("gateAllowPathsFromAfterScript(normalizedAfter)") &&
      (indexSrc.match(/gateAllowPathsFromScope\(scopeCheck\.paths, filesCreate, normalizedAfter\)/g) || [])
        .length === 2
  );
} catch (err) {
  console.log("[diag] PL-150 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-150: секция не выбросила исключение", false, "section threw");
}

// --- PL-80/81/101/104/105: регрессии коммит-хелперов и обёртки (B4) ---
try {
  const repoRoot = process.cwd();
  const parsePs = (abs) => {
    const escaped = abs.replace(/'/g, "''");
    const command =
      "$t=$null;$e=$null;" +
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$t,[ref]$e);` +
      "exit $e.Count";
    return spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
  };

  // PL-80: комментарии в .ps1 — только ASCII, иначе PS 5.1 читает их как ANSI.
  for (const rel of ["scripts/pl-commit.ps1", "scripts/steward-commit.ps1"]) {
    const abs = path.join(repoRoot, rel);
    const bytes = fs.readFileSync(abs);
    const nonAscii = [...bytes].filter((b) => b > 127).length;
    check(`PL-80: ${path.basename(rel)} содержит только ASCII`, nonAscii === 0, `nonAscii=${nonAscii}`);
    const parsed = parsePs(abs);
    check(
      `PL-80: ${path.basename(rel)} парсится Windows PowerShell`,
      parsed.status === 0,
      `exit=${parsed.status} ${parsed.stderr ?? ""}`
    );
  }

  // PL-81: код выхода агента — факт завершения, а не вердикт проверки.
  check(
    "PL-81: обёртка отделяет код агента от классификатора квоты",
    psWrapperScript.includes("$agentExitCode = $script:exitCode") &&
      psWrapperScript.includes("$quotaDetected = $true")
  );
  check(
    "PL-81: гейт запускается при exit!=0, если есть артефакты работы",
    psWrapperScript.includes("$runQualityGate = $QualityGate") &&
      psWrapperScript.includes("($script:exitCode -eq 0 -or $agentWorkCompleted)") &&
      !psWrapperScript.includes("if ($QualityGate -and $script:exitCode -eq 0)")
  );
  check(
    "PL-81: расхождение логируется, статус остаётся success",
    psWrapperScript.includes("PL-81: расхождение") &&
      psWrapperScript.includes("$script:errorMessage = $divergenceReason") &&
      psWrapperScript.includes("$script:exitCode = 0")
  );
  const { resolveAgentExitVerdict: resolveB4 } = await import("./dist/core/execution.js");
  const b4Verdict = resolveB4({
    agentExitCode: 1,
    gatePassed: true,
    taskName: "PL-81 regression",
    log: () => {},
  });
  check(
    "PL-81: exit=1 + gate=pass — success, post-flight разрешён",
    b4Verdict.status === "success" &&
      b4Verdict.runAfterScript === true &&
      b4Verdict.diverged === true,
    JSON.stringify(b4Verdict)
  );

  // PL-128: вердикт записи вычисляется в одном месте и проверяется без powershell.
  const { resolveWrapperRecordVerdict } = await import("./dist/core/ps-wrapper.js");
  const pl128Verdict = resolveWrapperRecordVerdict({
    timedOut: true,
    exitCode: 124,
    gatePassed: true,
  });
  check(
    "PL-128: gate=pass + watchdog exit=124 — success, причина PL-128, exit 0",
    pl128Verdict.status === "success" &&
      pl128Verdict.reason === "PL-128: завершено watchdog по таймауту, gate=pass" &&
      pl128Verdict.normalizedExitCode === 0,
    JSON.stringify(pl128Verdict)
  );
  const pl81CompatibleVerdict = resolveWrapperRecordVerdict({
    timedOut: false,
    exitCode: 1,
    gatePassed: true,
  });
  check(
    "PL-128: gate=pass + exit=1 остаётся success (PL-81)",
    pl81CompatibleVerdict.status === "success" &&
      pl81CompatibleVerdict.normalizedExitCode === 0,
    JSON.stringify(pl81CompatibleVerdict)
  );
  const noGateVerdict = resolveWrapperRecordVerdict({
    timedOut: true,
    exitCode: 124,
    gatePassed: false,
  });
  check(
    "PL-128: таймаут без гейта остаётся timeout",
    noGateVerdict.status === "timeout" && noGateVerdict.normalizedExitCode === 124,
    JSON.stringify(noGateVerdict)
  );
  const noGateSuccess = resolveWrapperRecordVerdict({
    timedOut: false,
    exitCode: 0,
    gatePassed: false,
    gateEvaluated: false,
  });
  check(
    "PL-128: exit=0 без гейта остаётся success",
    noGateSuccess.status === "success" && noGateSuccess.normalizedExitCode === 0,
    JSON.stringify(noGateSuccess)
  );
  const quotaVerdict = resolveWrapperRecordVerdict({
    timedOut: true,
    exitCode: 126,
    gatePassed: false,
    quotaDetected: true,
  });
  check(
    "PL-114: квота имеет приоритет над watchdog",
    quotaVerdict.status === "error" && quotaVerdict.normalizedExitCode === 126,
    JSON.stringify(quotaVerdict)
  );
  // PL-160: задача с нулевым результатом не должна быть success.
  const pl160IdleVerdict = resolveWrapperRecordVerdict({
    timedOut: false,
    exitCode: 0,
    gatePassed: true,
    agentExitCode: 1,
    idleCompleted: true,
    workCompleted: false,
  });
  check(
    "PL-160: idle-завершение без артефактов — error с причиной PL-160",
    pl160IdleVerdict.status === "error" &&
      pl160IdleVerdict.reason === "PL-160: агент завершён сторожем простоя без изменений" &&
      pl160IdleVerdict.normalizedExitCode === 1,
    JSON.stringify(pl160IdleVerdict)
  );
  const pl160WithWork = resolveWrapperRecordVerdict({
    timedOut: false,
    exitCode: 0,
    gatePassed: true,
    agentExitCode: 1,
    idleCompleted: true,
    workCompleted: true,
  });
  check(
    "PL-160: idle с артефактами остаётся success (PL-81)",
    pl160WithWork.status === "success" && pl160WithWork.normalizedExitCode === 0,
    JSON.stringify(pl160WithWork)
  );
  const pl160CleanExit = resolveWrapperRecordVerdict({
    timedOut: false,
    exitCode: 0,
    gatePassed: true,
    agentExitCode: 0,
    idleCompleted: true,
    workCompleted: false,
  });
  check(
    "PL-160: корректный выход агента без изменений остаётся success",
    pl160CleanExit.status === "success" && pl160CleanExit.normalizedExitCode === 0,
    JSON.stringify(pl160CleanExit)
  );
  check(
    "PL-160: PowerShell-вердикт получает код агента, idle и артефакты",
    psWrapperScript.includes("[int]$AgentExitCode = 0") &&
      psWrapperScript.includes("[bool]$IdleCompleted = $false") &&
      psWrapperScript.includes("[bool]$WorkCompleted = $false") &&
      psWrapperScript.includes("-AgentExitCode ([int]$agentExitCode)") &&
      psWrapperScript.includes("-IdleCompleted ([bool]$script:childIdleCompleted)") &&
      psWrapperScript.includes("-WorkCompleted ([bool]$script:agentArtifactPresent)") &&
      psWrapperScript.includes("git -C $Workdir status --porcelain --untracked-files=all") &&
      psWrapperScript.includes("-not ($script:childIdleCompleted -and -not $script:agentArtifactPresent)")
  );
  check(
    "PL-128: Get-RecordVerdict — единственное место вердикта в finally",
    psWrapperScript.includes("function Get-RecordVerdict") &&
      psWrapperScript.includes("Get-RecordVerdict -TimedOut") &&
      psWrapperScript.includes("PL-128: завершено watchdog по таймауту, gate=pass") &&
      !psWrapperScript.includes("elseif ($script:timedOut)")
  );
  check(
    "PL-124: completion/idle-watcher снимает дерево, --finish вызывается сразу",
    psWrapperScript.includes("AGENT_STEWARD_COMPLETION_IDLE_SEC") &&
      psWrapperScript.includes("$completionMarker") &&
      psWrapperScript.includes("PL-124: дочерний агент завершён/простаивает") &&
      psWrapperScript.includes('--finish "$script:runId"')
  );

  const wrapperAbs = path.join(tempRoot, "wrapper-parse-check.ps1");
  // ensureWrapper() пишет BOM — без него PS 5.1 читает кириллицу как ANSI.
  fs.writeFileSync(wrapperAbs, "\uFEFF" + psWrapperScript, "utf8");
  const wrapperParsed = parsePs(wrapperAbs);
  check("PL-81: сгенерированный run-task.ps1 парсится PowerShell", wrapperParsed.status === 0, `exit=${wrapperParsed.status}`);

  // PL-101/PL-104: коммит-хелпер переживает non-fast-forward и чужие правки.
  const helper = fs.readFileSync(path.join(repoRoot, "scripts/steward-commit.ps1"), "utf8");
  check(
    "PL-104: rebase использует --autostash вместо обычного rebase",
    helper.includes("@('rebase', '--autostash', 'origin/dev')") &&
      !helper.includes("@('rebase', 'origin/dev')")
  );
  check(
    "PL-104: rebase --quit защищён проверкой активного rebase",
    helper.includes("$rebaseInProgress") &&
      helper.indexOf("$rebaseInProgress") < helper.indexOf("@('rebase', '--quit')") &&
      helper.includes("no rebase in progress - skipped 'rebase --quit'")
  );
  check(
    "PL-101/PL-116: конфликт сохраняется, помечается needs-resolution и не маскируется под success",
    helper.includes("merge-conflicts") &&
      helper.includes("merge-conflict-pending.md") &&
      helper.includes("PL-101: conflict files preserved") &&
      helper.includes("STATUS: needs-resolution") &&
      helper.includes("exit 2")
  );

  // PL-105: pre-flight проверяет, что WorkingDirectory задачи — git worktree.
  check(
    "PL-105: pre-flight проверяет git-дерево и логирует статус snapshot/isolation",
    psWrapperScript.includes("PL-105:") &&
      psWrapperScript.includes("rev-parse --is-inside-work-tree") &&
      psWrapperScript.includes("snapshot/isolation active") &&
      psWrapperScript.includes("snapshot/isolation disabled")
  );
  const { decideWorktreeSnapshot: decideB4 } = await import("./dist/core/execution.js");
  const wtDir = path.join(tempRoot, "pl105-worktree");
  fs.mkdirSync(path.join(wtDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(wtDir, ".git"), "gitdir: /nowhere\n", "utf8");
  fs.writeFileSync(path.join(wtDir, "src", "x.ts"), "// x\n", "utf8");
  const wtDecision = decideB4({
    taskName: "pl105-probe",
    qualityGate: 'node -e "process.exit(0)"',
    workdir: wtDir,
    env: { ...process.env, AGENT_STEWARD_GATE_GUARD_PATHS: "src" },
  });
  check(
    "PL-105: git-worktree (.git — файл) распознаётся как репозиторий",
    wtDecision.required === true && !/git-репозиторием/.test(wtDecision.skipReason),
    JSON.stringify(wtDecision)
  );
} catch (err) {
  console.log("[diag] PL-80/81/101/104/105 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-80/81/101/104/105: секция не выбросила исключение", false, "section threw");
}

// --- PL-127/PL-132: non-FF push path in pl-commit.ps1 (string-only regressions) ---
// No real git, fetch or push: we assert the helper source so a regression to a
// whole-branch rebase, or a lost cherry-pick/abort path, fails deterministically.
try {
  const helper = fs.readFileSync(path.resolve("scripts/pl-commit.ps1"), "utf8");
  const nonFf = helper.slice(helper.lastIndexOf("PL-127/PL-132:"));
  const hasNonFf = nonFf.length > 0;
  const fetchCall = "@('fetch', 'origin', 'dev')";
  const pickCall = "@('cherry-pick', $local)";
  const abortCall = "@('cherry-pick', '--abort')";
  const cleanCall = "@('reset', '--hard', 'HEAD')";

  check(
    "PL-127: non-FF путь делает fetch origin dev перед повторным push",
    hasNonFf &&
      nonFf.includes(fetchCall) &&
      nonFf.includes("fetch origin dev") &&
      nonFf.indexOf(fetchCall) < nonFf.indexOf(pickCall),
    `fetch@${nonFf.indexOf(fetchCall)}, pick@${nonFf.indexOf(pickCall)}`
  );
  check(
    "PL-132: non-FF путь НЕ переигрывает ветку rebase --autostash",
    hasNonFf &&
      !nonFf.includes("rebase --autostash") &&
      !nonFf.includes("@('rebase',") &&
      !nonFf.includes("@('rebase', '--quit')"),
    nonFf.slice(0, 500)
  );
  check(
    "PL-132: запоминается HEAD и накатывается ОДИН коммит cherry-pick поверх origin/dev",
    hasNonFf &&
      nonFf.includes("git rev-parse HEAD") &&
      nonFf.includes("@('reset', '--hard', 'origin/dev')") &&
      nonFf.includes(pickCall) &&
      nonFf.indexOf("@('reset', '--hard', 'origin/dev')") < nonFf.indexOf(pickCall) &&
      nonFf.indexOf(pickCall) < nonFf.indexOf("@('push', 'origin', 'HEAD:dev')"),
    `reset@${nonFf.indexOf("@('reset', '--hard', 'origin/dev')")}, pick@${nonFf.indexOf(pickCall)}`
  );
  check(
    "PL-132: конфликт cherry-pick --abort оставляет дерево чистым и exit 2",
    hasNonFf &&
      nonFf.includes("cherry-pick --abort") &&
      nonFf.includes(abortCall) &&
      nonFf.includes(cleanCall) &&
      nonFf.indexOf(abortCall) < nonFf.indexOf(cleanCall) &&
      nonFf.indexOf(cleanCall) < nonFf.indexOf("exit 2"),
    `abort@${nonFf.indexOf(abortCall)}, clean@${nonFf.indexOf(cleanCall)}`
  );
  check(
    "PL-132: при конфликте не остаётся отсоединённого HEAD / UU-индекса",
    hasNonFf &&
      nonFf.includes("CHERRY_PICK_HEAD") &&
      nonFf.includes("Test-Path -LiteralPath $cpHead") &&
      nonFf.includes("UU index") &&
      nonFf.includes("tree clean, no push")
  );
  check(
    "PL-127/PL-132: origin — имя remote, а не hard-coded путь (GitHub или mirror)",
    hasNonFf &&
      nonFf.includes("origin/dev") &&
      !/https?:\/\//.test(nonFf) &&
      !/file:\/\//.test(nonFf) &&
      !/[A-Za-z]:\\/.test(nonFf)
  );
  check(
    "PL-41/PL-58: pathspec-коммит только своих файлов и проверка маркера сохранены",
    helper.includes("@('commit', '-m', $Message, '--')") &&
      helper.includes("Test-Path -LiteralPath $markerPath") &&
      helper.includes("git diff --name-only") &&
      helper.includes("PL-41") &&
      helper.includes("PL-58") &&
      helper.includes("WARN PL-58")
  );
} catch (err) {
  console.log("[diag] PL-127/PL-132 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-127/PL-132: секция не выбросила исключение", false, "section threw");
}

// --- PL-131/PL-135: self-exec real-path guard + build-before-commit (source-only) ---
// No real gate, git or push: we assert the two helper sources so a regression
// to symlink-blind self-exec or to commit-without-build fails deterministically.
try {
  const gateSrc = fs.readFileSync(path.resolve("src/core/gate-integrity.ts"), "utf8");
  const gateTail = gateSrc.slice(-1200);
  check(
    "PL-131: self-exec-ветка нормализует реальные пути через fs.realpathSync",
    gateTail.includes("fs.realpathSync(p)") &&
      gateTail.includes("realPathWithFallback(process.argv[1])") &&
      gateTail.includes("realPathWithFallback(fileURLToPath(import.meta.url))"),
    `tail@${gateSrc.length - 1200}`
  );
  check(
    "PL-131: safe-fallback на path.resolve и выставление exitCode сохранены",
    gateTail.includes("path.resolve(p)") && /process\.exitCode\s*=\s*await main\(\)/.test(gateTail)
  );
  check(
    "PL-131: CLI-контракт не сломан — неверные аргументы дают return 2",
    gateSrc.includes("process.exitCode = await main()") &&
      gateSrc.includes("return 2;") &&
      gateSrc.includes("поддерживаются verify, worktree-snapshot, worktree-verify")
  );

  const helper = fs.readFileSync(path.resolve("scripts/pl-commit.ps1"), "utf8");
  const buildPos = helper.indexOf("& npm run build 2>&1");
  const commitPos = helper.indexOf("@('commit', '-m', $Message, '--')");
  const pushPos = helper.indexOf("@('push', 'origin', 'HEAD:dev')");
  const failPos = helper.indexOf("FAIL build (npm run build exit");
  check(
    "PL-135: npm run build вызывается до commit и push",
    buildPos >= 0 && commitPos > buildPos && pushPos > buildPos,
    `build@${buildPos}, commit@${commitPos}, push@${pushPos}`
  );
  check(
    "PL-135: провал сборки пишет лог и выходит с кодом 2 до commit/push",
    failPos > buildPos && failPos < commitPos && /exit 2/.test(helper.slice(failPos, failPos + 160)),
    `fail@${failPos}`
  );
  check(
    "PL-135: сохранены cherry-pick, проверка маркера и pathspec-коммит",
    helper.includes("@('cherry-pick', $local)") &&
      helper.includes("Test-Path -LiteralPath $markerPath") &&
      helper.includes("@('commit', '-m', $Message, '--')") &&
      helper.includes("PL-127/PL-132:")
  );
} catch (err) {
  console.log("[diag] PL-131/PL-135 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-131/PL-135: секция не выбросила исключение", false, "section threw");
}

// --- PL-142: verify build+lint before burning the gate marker ---
// A stale/forged marker must not push broken code. String-only regressions on
// scripts/pl-commit.ps1 pin the ordering: read marker -> verify all commands ->
// remove marker -> commit/push, with a fail-closed exit 2 that keeps the marker.
try {
  const helper = fs.readFileSync(path.resolve("scripts/pl-commit.ps1"), "utf8");
  const markerTest = helper.indexOf("Test-Path -LiteralPath $markerPath");
  const markerRead = helper.indexOf("Get-Content -LiteralPath $markerPath -Raw");
  const markerRemove = helper.indexOf("Remove-Item -LiteralPath $markerPath -Force");
  const verifyLoop = helper.indexOf("foreach ($cmd in $verifyList)");
  const buildAnchor = helper.indexOf("& npm run build 2>&1");
  const lintAnchor = helper.indexOf("'& npm run lint 2>&1'");
  const commitPos = helper.indexOf("@('commit', '-m', $Message, '--')");
  const pushPos = helper.indexOf("@('push', 'origin', 'HEAD:dev')");
  const failGate = helper.indexOf("FAIL build (npm run build exit");

  check(
    "PL-142: маркер читается до верификации и НЕ удаляется сразу",
    markerTest >= 0 && markerRead > markerTest && markerRemove > markerRead,
    `test@${markerTest}, read@${markerRead}, remove@${markerRemove}`
  );
  check(
    "PL-142: build и lint присутствуют в явном списке проверок по умолчанию",
    buildAnchor >= 0 && lintAnchor >= 0 && lintAnchor > buildAnchor,
    `build@${buildAnchor}, lint@${lintAnchor}`
  );
  check(
    "PL-142: верификация (build+lint) выполняется до commit и push",
    verifyLoop >= 0 && commitPos > verifyLoop && pushPos > verifyLoop,
    `verify@${verifyLoop}, commit@${commitPos}, push@${pushPos}`
  );
  check(
    "PL-142: маркер удаляется только после успешной верификации и до commit",
    markerRemove > verifyLoop && markerRemove < commitPos,
    `verify@${verifyLoop}, remove@${markerRemove}, commit@${commitPos}`
  );
  check(
    "PL-142: провал гейта — exit 2, маркер остаётся, commit/push не выполняется",
    failGate > verifyLoop &&
      failGate < commitPos &&
      /exit 2/.test(helper.slice(failGate, failGate + 160)) &&
      helper.includes("gate marker kept (verification failed)"),
    `fail@${failGate}`
  );
  check(
    "PL-142: параметр -VerifyCommands задаёт явный список проверок",
    helper.includes("[string[]]$VerifyCommands") &&
      helper.includes("foreach ($entry in @($VerifyCommands))") &&
      helper.includes("@($entry) -split ';'"),
    "VerifyCommands param"
  );
  check(
    "PL-142: сохранены PL-41/PL-58/PL-127/PL-132 маркеры без регрессий",
    helper.includes("@('commit', '-m', $Message, '--')") &&
      helper.includes("@('cherry-pick', $local)") &&
      helper.includes("WARN PL-58") &&
      helper.includes("PL-127/PL-132:")
  );
} catch (err) {
  console.log("[diag] PL-142 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-142: секция не выбросила исключение", false, "section threw");
}

// --- PL-112: prompt destructive-command guard ---
try {
  const { inspectPromptSafety } = await import("./dist/core/guard.js");
  check(
    "PL-112: inspectPromptSafety пропускает обычный промпт с абсолютным workdir",
    inspectPromptSafety("WORKDIR: C:\\repo\\project. Nicely ask the agent to edit files.").safe === true
  );
  check(
    "PL-112: Remove-Item -Recurse в промпте отклоняется",
    inspectPromptSafety("Remove-Item -Recurse -Force C:\\repo").safe === false
  );
  check(
    "PL-112: rm -rf в промпте отклоняется",
    inspectPromptSafety("rm -rf /repo").safe === false
  );
  check(
    "PL-112: del /s в промпте отклоняется",
    inspectPromptSafety("del /s /q C:\\repo\\*.md").safe === false
  );
  check(
    "PL-112: абсолютная цель удаления отклоняется",
    inspectPromptSafety("Remove-Item C:\\Windows\\System32").safe === false
  );
  check(
    "PL-112: обход .. в цели удаления отклоняется",
    inspectPromptSafety("rm -rf ..\\..\\repo").safe === false
  );
  check(
    "PL-112: упоминание в прозе не считается командой",
    inspectPromptSafety("В отчёте описано, как Remove-Item повредил файлы в прошлый раз.").safe === true
  );
} catch (err) {
  console.log("[diag] PL-112 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-112: секция не выбросила исключение", false, "section threw");
}

// --- D-1.1/D-1.2/D-1.3/D-2.1/D-3.1: runner-интерфейс и детерминированный вердикт ---
// Здесь проверяется только чистое построение команды и флаг доступности:
// никаких docker/ssh-процессов, сети и реальных бинарников не вызывается.
try {
  const { resolveRunner, binaryAvailable, createLocalRunner } = await import(
    "./dist/core/runner.js"
  );
  const { createDockerRunner } = await import("./dist/core/runner-docker.js");
  const { createSSHRunner, buildRemoteCommand, quoteRemoteArg } = await import(
    "./dist/core/runner-ssh.js"
  );

  const dependencyDir = path.join(tempRoot, "fakebin");
  const deps = {
    env: { PATH: dependencyDir },
    exists: (file) => file.includes("fakebin"),
    dockerBinary: "docker",
    sshBinary: "ssh",
  };
  const launch = {
    command: "opencode",
    args: ["run", 'task "x"'],
    workdir: "/work dir",
    env: { Z_VAR: "2", A_VAR: "1" },
  };

  // D-1.1: минимальный интерфейс — имя, доступность, buildCommand, execute.
  const local = createLocalRunner();
  check(
    "D-1.1: Runner открывает имя, доступность, построение и выполнение",
    local.name === "local" &&
      local.available() === true &&
      typeof local.buildCommand === "function" &&
      typeof local.execute === "function",
  );
  const localCmd = local.buildCommand(launch);
  check(
    "D-1.1: local.buildCommand — копия описания запуска без выполнения",
    localCmd.command === "opencode" &&
      localCmd.args.join("|") === 'run|task "x"' &&
      localCmd.args !== launch.args,
    JSON.stringify(localCmd),
  );

  // D-2.1: по умолчанию local; docker/ssh даже не проверяются.
  const probingExists = () => {
    throw new Error("local runner must not probe docker/ssh binaries");
  };
  const defaultResolved = resolveRunner({ deps: { ...deps, exists: probingExists } });
  const defaultVerdict = defaultResolved.verdict(launch);
  check(
    "D-2.1: resolveRunner() по умолчанию возвращает local",
    defaultResolved.runner.name === "local" &&
      defaultVerdict.requested === "local" &&
      defaultVerdict.runner === "local" &&
      defaultVerdict.fallback === false &&
      defaultVerdict.reason === "",
    JSON.stringify(defaultVerdict),
  );

  // D-1.2: docker CLI — детерминированный argv, без выполнения при сборке.
  const docker = createDockerRunner({ image: "alpine:3.20", deps });
  const dockerCmd = docker.buildCommand(launch);
  const expectedDockerArgs = [
    "run",
    "--rm",
    "--workdir",
    "/work dir",
    "--env",
    "A_VAR=1",
    "--env",
    "Z_VAR=2",
    "alpine:3.20",
    "opencode",
    "run",
    'task "x"',
  ];
  check(
    "D-1.2: docker-команда собирается из docker CLI без выполнения",
    dockerCmd.command === "docker" &&
      JSON.stringify(dockerCmd.args) === JSON.stringify(expectedDockerArgs),
    JSON.stringify(dockerCmd),
  );
  check(
    "D-1.2: docker.available — чистый флаг из бинарника",
    docker.available() === true && docker.name === "docker",
  );

  // D-1.3: ssh CLI — BatchMode, user@host и экранирование удалённой команды.
  const ssh = createSSHRunner({ host: "build.example", user: "ci", deps });
  const sshCmd = ssh.buildCommand(launch);
  const expectedRemote =
    "cd '/work dir' && A_VAR='1' Z_VAR='2' 'opencode' 'run' 'task \"x\"'";
  check(
    "D-1.3: ssh-команда содержит BatchMode, user@host и quoted remote",
    sshCmd.command === "ssh" &&
      JSON.stringify(sshCmd.args.slice(0, 3)) ===
        JSON.stringify(["-o", "BatchMode=yes", "ci@build.example"]) &&
      sshCmd.args[3] === expectedRemote &&
      buildRemoteCommand(launch) === expectedRemote,
    JSON.stringify(sshCmd),
  );
  check(
    "D-1.3: ssh экранирует одинарные кавычки детерминированно",
    quoteRemoteArg("it's") === "'it'\\''s'",
    quoteRemoteArg("it's"),
  );
  check("D-1.3: ssh.available — чистый флаг из бинарника", ssh.available() === true);

  // D-3.1: та же спека и та же спецификация запуска → байт-в-байт вердикт.
  const spec = { kind: "docker", image: "alpine:3.20", deps };
  const verdictA = resolveRunner(spec).verdict(launch);
  const verdictB = resolveRunner({ ...spec, deps: { ...deps } }).verdict({
    ...launch,
    env: { A_VAR: "1", Z_VAR: "2" },
  });
  check(
    "D-3.1: одинаковая спека даёт байт-в-байт одинаковый вердикт",
    JSON.stringify(verdictA) === JSON.stringify(verdictB) &&
      verdictA.runner === "docker" &&
      verdictA.fallback === false,
    `${JSON.stringify(verdictA)} != ${JSON.stringify(verdictB)}`,
  );
  const runnerSource = ["runner.ts", "runner-docker.ts", "runner-ssh.ts"]
    .map((name) => fs.readFileSync(path.join("src", "core", name), "utf8"))
    .join("\n");
  check(
    "D-3.1: runner-исходники не читают часы и не используют random",
    !/Date\.now|new Date\(|Math\.random|performance\.now/.test(runnerSource),
  );

  // D-2.1: fail-open при отсутствии бинарника и при явном opt-out.
  const noDocker = resolveRunner({
    kind: "docker",
    image: "alpine:3.20",
    deps: { ...deps, exists: () => false },
  });
  check(
    "D-2.1: docker без бинарника → local fail-open",
    noDocker.runner.name === "local" &&
      noDocker.fallback === true &&
      /binary/.test(noDocker.reason),
    JSON.stringify({ name: noDocker.runner.name, reason: noDocker.reason }),
  );
  const noSsh = resolveRunner({
    kind: "ssh",
    host: "build.example",
    deps: { ...deps, exists: () => false },
  });
  check(
    "D-2.1: ssh без бинарника → local fail-open",
    noSsh.runner.name === "local" &&
      noSsh.fallback === true &&
      /binary/.test(noSsh.reason),
    JSON.stringify({ name: noSsh.runner.name, reason: noSsh.reason }),
  );
  const optedOut = resolveRunner({
    kind: "ssh",
    host: "build.example",
    optOut: true,
    deps: { ...deps, exists: probingExists },
  });
  check(
    "D-2.1: opt-out → local без проверки бинарника",
    optedOut.runner.name === "local" &&
      optedOut.fallback === true &&
      /opt-out/.test(optedOut.reason),
    JSON.stringify({ name: optedOut.runner.name, reason: optedOut.reason }),
  );
  check(
    "D-2.1: binaryAvailable(absence) даёт false, найденный бинарник — true",
    binaryAvailable("missing-tool", { env: { PATH: dependencyDir }, exists: () => false }) ===
      false && binaryAvailable("docker", deps) === true,
  );
  const dockerResolved = resolveRunner(spec);
  check(
    "D-1.2: resolveRunner выбирает docker при наличии бинарника",
    dockerResolved.runner.name === "docker" &&
      dockerResolved.fallback === false &&
      dockerResolved.verdict(launch).command === "docker",
    JSON.stringify(dockerResolved.verdict(launch)),
  );
} catch (err) {
  console.log("[diag] Runner section THREW:", err instanceof Error ? err.stack : String(err));
  check("D-1/D-2/D-3: runner-секция не выбросила исключение", false, "section threw");
}

// --- M-1..M-4: детерминированная мульти-агентная оркестрация ---
try {
  const {
    buildContextArtifact,
    assignRole,
    postmortem,
    retryWithPostmortem,
    fallbackModel,
    redactSecrets,
  } = await import("./dist/core/agents.js");
  const executionExports = await import("./dist/core/execution.js");

  const orchestrationSteps = [
    { stepName: "collect", output: ["alpha", "beta"] },
    { stepName: "verify", output: "beta", error: "incorrect result" },
    { stepName: "fix", result: ["gamma"] },
  ];
  const ctx = buildContextArtifact(orchestrationSteps);
  check(
    "M-1.1: сквозной контекст собран из результатов шагов по порядку",
    JSON.stringify(ctx) === JSON.stringify(["alpha", "beta", "incorrect result", "gamma"]),
    JSON.stringify(ctx),
  );
  check(
    "M-1.1: дубликаты результатов отбрасываются",
    ctx.filter((item) => item === "beta").length === 1,
    JSON.stringify(ctx),
  );
  check(
    "M-1.1: лимит ограничивает число артефактов",
    JSON.stringify(buildContextArtifact(orchestrationSteps, 2)) === JSON.stringify(["alpha", "beta"])
  );
  check(
    "M-1.1: пустой вход и нулевой лимит дают пустой список",
    JSON.stringify(buildContextArtifact([])) === "[]" &&
      JSON.stringify(buildContextArtifact(orchestrationSteps, 0)) === "[]"
  );
  check(
    "M-1.1: контекст детерминирован при повторном вызове",
    JSON.stringify(buildContextArtifact(orchestrationSteps)) ===
      JSON.stringify(buildContextArtifact(orchestrationSteps))
  );
  const secretArtifacts = buildContextArtifact([
    { output: "Authorization: Bearer sk-abcdefgh12345678" },
    { output: "API_KEY=sk-abcdefgh12345678" },
    { error: "token: supersecretvalue123" },
  ]);
  check(
    "M-1.1: секреты вырезаются до попадания в контекст",
    secretArtifacts.every((item) => !/sk-abcdefgh|supersecretvalue/.test(item)) &&
      secretArtifacts.some((item) => item.includes("[REDACTED]")),
    JSON.stringify(secretArtifacts)
  );
  check(
    "M-1.1: redactSecrets не зависит от окружения",
    redactSecrets("password: hunter2") === "password: [REDACTED]" &&
      redactSecrets("plain text") === "plain text"
  );

  check("M-2.1: первый шаг без предыдущей роли — worker", assignRole({ stepName: "a" }) === "worker");
  check(
    "M-2.1: после worker назначается reviewer",
    assignRole({ stepName: "b" }, "worker") === "reviewer"
  );
  check(
    "M-2.1: после reviewer снова worker (чередование)",
    assignRole({ stepName: "c" }, "reviewer") === "worker"
  );
  check(
    "M-2.1: reviewer без предыдущего worker запрещён",
    assignRole({ stepName: "b", role: "reviewer" }, null) === "worker"
  );
  check(
    "M-2.1: явный reviewer после worker разрешён",
    assignRole({ stepName: "b", role: "reviewer" }, "worker") === "reviewer"
  );
  check(
    "M-2.1: роли детерминированы",
    assignRole({ role: "reviewer" }, "worker") === assignRole({ role: "reviewer" }, "worker")
  );

  const timeoutPm = postmortem({ error: "ETIMEDOUT: step exceeded timeout", exitCode: 1 });
  check(
    "M-3.1: postmortem извлекает причину и предлагает исправление",
    timeoutPm.kind === "timeout" && /ETIMEDOUT/.test(timeoutPm.cause) &&
      timeoutPm.correction.length > 0 && timeoutPm.correctable === true,
    JSON.stringify(timeoutPm)
  );
  const secretPm = postmortem("API_KEY=sk-abcdefgh12345678 leaked");
  check(
    "M-3.1: ошибка с секретом не корректируема, секрет вырезан",
    secretPm.correctable === false && !/sk-abcdefgh/.test(secretPm.cause),
    JSON.stringify(secretPm)
  );
  const successPm = postmortem({ status: "passed", output: "ok" });
  check(
    "M-3.1: успешный шаг не даёт причины и повтора",
    successPm.cause === "" && successPm.correctable === false,
    JSON.stringify(successPm)
  );
  const originalSpec = { stepName: "verify", prompt: "fix it", attempt: 1 };
  const retryDecision = retryWithPostmortem({ error: "timeout" }, originalSpec);
  check(
    "M-3.1: retry инкрементит attempt и проставляет лимит",
    retryDecision.retry === true && retryDecision.spec.attempt === 2 &&
      retryDecision.spec.maxAttempts === 3 && retryDecision.spec.prompt === "fix it",
    JSON.stringify(retryDecision)
  );
  check(
    "M-3.1: исходный spec не мутирует",
    originalSpec.attempt === 1 && !("maxAttempts" in originalSpec),
    JSON.stringify(originalSpec)
  );
  const blockedRetry = retryWithPostmortem({ error: "API_KEY=sk-abcdefgh12345678" }, originalSpec);
  check(
    "M-3.1: повтор только на корректируемую ошибку",
    blockedRetry.retry === false && blockedRetry.spec.attempt === 1 &&
      blockedRetry.postmortem.kind === "secret",
    JSON.stringify(blockedRetry)
  );
  const exhausted = retryWithPostmortem({ error: "timeout" }, { ...originalSpec, attempt: 3 });
  check(
    "M-3.1: лимит попыток останавливает повтор",
    exhausted.retry === false && exhausted.spec.attempt === 3 && exhausted.spec.maxAttempts === 3,
    JSON.stringify(exhausted)
  );
  check(
    "M-3.1: retry детерминирован",
    JSON.stringify(retryWithPostmortem({ error: "timeout" }, originalSpec)) ===
      JSON.stringify(retryWithPostmortem({ error: "timeout" }, originalSpec))
  );

  check(
    "M-4.1: высокая уверенность оставляет primary",
    fallbackModel("primary/model", ["backup/model"], 0.9) === "primary/model"
  );
  check(
    "M-4.1: низкая уверенность выбирает запасную модель",
    fallbackModel("primary/model", ["primary/model", "backup/model"], 0.2) === "backup/model"
  );
  check(
    "M-4.1: нет доступных моделей — fail-open на primary",
    fallbackModel("primary/model", [], 0.1) === "primary/model" &&
      fallbackModel("primary/model", null, 0) === "primary/model"
  );
  check(
    "M-4.1: только primary в списке — fail-open",
    fallbackModel("primary/model", ["primary/model"], 0.1) === "primary/model"
  );
  check(
    "M-4.1: невалидный confidence не вызывает фолбэк",
    fallbackModel("primary/model", ["backup/model"], Number.NaN) === "primary/model"
  );
  check(
    "M-4.1: порог настраивается и выбор детерминирован",
    fallbackModel("a", ["b"], 0.5, { threshold: 0.8 }) === "b" &&
      JSON.stringify(fallbackModel("a", ["b", "c"], 0.1)) ===
        JSON.stringify(fallbackModel("a", ["b", "c"], 0.1))
  );
  check(
    "M-1..M-4: execution.ts реэкспортирует оркестрационные функции",
    typeof executionExports.buildContextArtifact === "function" &&
      typeof executionExports.assignRole === "function" &&
      typeof executionExports.postmortem === "function" &&
      typeof executionExports.retryWithPostmortem === "function" &&
      typeof executionExports.fallbackModel === "function"
  );
} catch (err) {
  console.log("[diag] M-1..M-4 section THREW:", err instanceof Error ? err.stack : String(err));
  check("M-1..M-4: секция не выбросила исключение", false, "section threw");
}





// --- PL-106: run-time isolation guard ---
check(
  "PL-106 first non-isolated run allowed",
  planRuntimeIsolation({ activeNonIsolated: 0, worktree: false, taskName: "a" }).allowed === true
);
check(
  "PL-106 second non-isolated run rejected",
  planRuntimeIsolation({ activeNonIsolated: 1, worktree: false, taskName: "b" }).allowed === false
);
check(
  "PL-106 isolated run allowed while another is active",
  planRuntimeIsolation({ activeNonIsolated: 2, worktree: true, taskName: "c" }).allowed === true
);
check(
  "PL-106 many active non-isolated runs blocked",
  planRuntimeIsolation({ activeNonIsolated: 4, worktree: false, taskName: "d" }).allowed === false
);

// --- PL-116: conflict post-flight must not report success ---
{
  const commitScript = fs.readFileSync(path.resolve("scripts/steward-commit.ps1"), "utf8");
  const historySource = fs.readFileSync(path.resolve("src/history.ts"), "utf8");
  const jobsView = fs.readFileSync(path.resolve("src/shared/jobs-view.ts"), "utf8");
  check("PL-116 conflict marker persisted", commitScript.includes("STATUS: needs-resolution"));
  check(
    "PL-116 conflict exits nonzero",
    /STATUS: needs-resolution - post-flight MUST NOT be reported as success[\s\S]{0,60}exit 2/.test(commitScript)
  );
  check(
    "PL-116 history status additive",
    historySource.includes('"needs-resolution"') && jobsView.includes("needs-resolution")
  );
  check(
    "PL-116 successful push unchanged",
    /Log "OK \(rebased\): \$Message"[\s\S]{0,30}?exit 0/.test(commitScript)
  );
}

// --- PL-114: quota reason normalization ---
{
  const { normalizeQuotaReason } = await import("./dist/core/ps-wrapper.js");
  const wrapperSrc = fs.readFileSync(path.resolve("src/core/ps-wrapper.ts"), "utf8");
  const bashSrc = fs.readFileSync(path.resolve("src/core/wrappers/bash.ts"), "utf8");
  check(
    "PL-114 ANSI and mojibake stripped",
    normalizeQuotaReason("\u001b[31mÐ¡Ð²Ð¾Ð±Ð¾Ð´Ð½Ñ‹Ð¹ Free usage limit reached\u001b[0m").startsWith("Free quota exhausted:")
  );
  check(
    "PL-114 long reason truncated",
    normalizeQuotaReason("x".repeat(500)).length <= 164
  );
  check(
    "PL-114 unknown reason stays readable",
    normalizeQuotaReason("ECONNRESET\nretry") === "ECONNRESET retry"
  );
  check(
    "PL-114 quota wins over timeout status",
    wrapperSrc.includes("PL-114: quota is the root cause") &&
      /if \(\$quotaDetected\) \{[\s\S]{0,80}\$status = "error"/.test(wrapperSrc)
  );
  check(
    "PL-114 bash reason capped",
    bashSrc.includes("cut -c1-160")
  );
}

// --- PL-118: CLIXML/ANSI-шум stderr дочернего powershell.exe ---
// Реальный powershell здесь НЕ вызывается: фикс проверяется на синтетическом
// потоке, какого раньше было достаточно, чтобы PS 5.1 выдал «Не удалось
// обработать XML ... 0x1B ... недопустимым знаком».
{
  const { sanitizeChildStderr } = await import("./dist/core/ps-wrapper.js");
  const synthetic = [
    "#< CLIXML",
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
    `  <S S="Error">\u001b[31mНе удалось обработать XML в потоке "Error" файла powershell.exe: 0x1B, шестнадцатеричное значение 0x1B, является недопустимым знаком., строка 1, позиция 1.\u001b[0m_x000D__x000A_</S>`,
    `  <S S="Error">Cannot find path 'C:\\missing' because it does not exist.</S>`,
    "</Objs>",
  ].join("\r\n");

  const cleaned = sanitizeChildStderr(synthetic);
  check(
    "PL-118: ошибка десериализации XML вырезана из stderr",
    !cleaned.includes("Не удалось обработать XML"),
    cleaned
  );
  check(
    "PL-118: ANSI ESC и CLIXML-преамбула вырезаны",
    !cleaned.includes("\u001b") &&
      !cleaned.includes("#< CLIXML") &&
      !cleaned.includes("<Objs") &&
      !cleaned.includes("_x001B_"),
    JSON.stringify(cleaned)
  );
  check(
    "PL-118: нормальное сообщение об ошибке сохранено",
    cleaned.includes("Cannot find path") && cleaned.includes("does not exist"),
    cleaned
  );
  check(
    "PL-118: очистка идемпотентна и безопасна на пустом вводе",
    sanitizeChildStderr(cleaned) === cleaned && sanitizeChildStderr("") === "",
    JSON.stringify(sanitizeChildStderr(cleaned))
  );
  check(
    "PL-118: обёртка гасит CLIXML до десериализации (2>&1 в ребёнке и фильтр лога)",
    psWrapperScript.includes("@a 2>&1; exit $LASTEXITCODE") &&
      psWrapperScript.includes("#< CLIXML") &&
      psWrapperScript.includes("PL-118:"),
    "Invoke-ChildWithArgs/Format-LogLine не содержат фикс"
  );
}

// --- PL-115: Windows PowerShell 5.1 parser regression ---
try {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "steward-pl115-"));
  const writePs = (name, body) => {
    const file = path.join(tmpDir, name);
    fs.writeFileSync(file, body, "utf8");
    return file;
  };
  const parsePsFile = (abs) => {
    const escaped = abs.replace(/'/g, "''");
    const command =
      "$t=$null;$e=$null;" +
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$t,[ref]$e);` +
      "exit $e.Count";
    return spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    });
  };
  const commaFile = writePs("trailing-comma.ps1", "$a = @('x',)\nWrite-Output 'ok'\n");
  const cleanFile = writePs("clean.ps1", "$a = @('x')\nWrite-Output 'ok'\n");
  const cyrillicFile = writePs("cyrillic-no-bom.ps1", "# кириллица\nWrite-Output 'ok'\n");
  check("PL-115: trailing comma rejected by PS 5.1 parser", parsePsFile(commaFile).status !== 0);
  check("PL-115: clean ASCII helper parses", parsePsFile(cleanFile).status === 0);
  check(
    "PL-115: Cyrillic without BOM parses (premise refined empirically)",
    parsePsFile(cyrillicFile).status === 0
  );
  for (const rel of ["scripts/pl-commit.ps1", "scripts/steward-commit.ps1"]) {
    const bytes = fs.readFileSync(path.resolve(rel));
    check(`PL-115: ${rel} ASCII-only`, [...bytes].every((b) => b < 128));
  }
} catch (err) {
  check("PL-115: секция не выбросила исключение", false, String(err));
}

// --- A-2.1/A-2.2/A-3.1: env-профили, изоляция и артефакты запуска ---
// Все проверки чистые: файлы не создаются, пути приходят вместе с содержимым.
try {
  const envMod = await import("./dist/core/environment.js");
  const execMod = await import("./dist/core/execution.js");
  const { getRun } = await import("./dist/db/runs-repo.js");
  const { readAuditLog } = await import("./dist/core/audit.js");
  const {
    ENVIRONMENT_PROFILES,
    DEFAULT_ENVIRONMENT,
    CROSS_ENV_DENY,
    resolveEnvironmentName,
    environmentVariables,
    crossEnvViolations,
    checkEnvironmentCompatibility,
    isRunArtifactPath,
    registerRunArtifacts,
  } = envMod;

  // A-2.1: ровно три профиля с собственными переменными.
  check(
    "A-2.1: определены ровно профили dev/staging/prod",
    Object.keys(ENVIRONMENT_PROFILES).sort().join(",") === "dev,prod,staging"
  );
  check(
    "A-2.1: без явного выбора используется dev",
    DEFAULT_ENVIRONMENT === "dev" &&
      resolveEnvironmentName() === "dev" &&
      resolveEnvironmentName(null) === "dev" &&
      resolveEnvironmentName("unknown") === "dev"
  );
  check(
    "A-2.1: профили изолированы (свои APP_ENV и уникальные ключи)",
    ENVIRONMENT_PROFILES.dev.variables.APP_ENV === "dev" &&
      ENVIRONMENT_PROFILES.staging.variables.APP_ENV === "staging" &&
      ENVIRONMENT_PROFILES.prod.variables.APP_ENV === "prod" &&
      "DEV_HOT_RELOAD" in ENVIRONMENT_PROFILES.dev.variables &&
      "STAGING_GATEWAY" in ENVIRONMENT_PROFILES.staging.variables &&
      "PROD_REGION" in ENVIRONMENT_PROFILES.prod.variables &&
      !("STAGING_GATEWAY" in ENVIRONMENT_PROFILES.dev.variables)
  );
  check(
    "A-2.1: environmentVariables возвращает только переменные выбранного профиля",
    JSON.stringify(environmentVariables("dev")) ===
      JSON.stringify(ENVIRONMENT_PROFILES.dev.variables) &&
      !("PROD_REGION" in environmentVariables("dev"))
  );
  check(
    "A-2.1: CROSS-ENV deny-список обязателен для каждого профиля",
    CROSS_ENV_DENY.length > 0 &&
      ["dev", "staging", "prod"].every(
        (name) => ENVIRONMENT_PROFILES[name].deny.join("|") === CROSS_ENV_DENY.join("|")
      )
  );
  check(
    "A-2.1: deny-ключ и чужой ключ отклоняются, свои — принимаются",
    crossEnvViolations("prod", { DEV_HOT_RELOAD: "true" }).length > 0 &&
      crossEnvViolations("dev", { API_TOKEN: "x" }).some((line) => line.includes("deny")) &&
      crossEnvViolations("dev", { APP_ENV: "dev" }).length === 0
  );

  // A-2.2: вердикт несовпадения содержит причину и оба env-профиля.
  const sameEnv = checkEnvironmentCompatibility("prod", "prod");
  const mismatchEnv = checkEnvironmentCompatibility("prod", "dev");
  check("A-2.2: совпадение профилей разрешено", sameEnv.ok === true && sameEnv.reason === "");
  check(
    "A-2.2: несовпадение блокируется, вердикт содержит env и причину",
    mismatchEnv.ok === false &&
      mismatchEnv.reason.includes("prod") &&
      mismatchEnv.reason.includes("dev") &&
      mismatchEnv.env.task.name === "prod" &&
      mismatchEnv.env.run.name === "dev" &&
      mismatchEnv.env.task.variables.APP_ENV === "prod"
  );
  check(
    "A-2.2: без явного выбора задача и запуск оба в dev",
    checkEnvironmentCompatibility(undefined, undefined).ok === true
  );

  // A-2.2: execution loop блокирует прогон до создания запуска и пишет аудит.
  const mismatchName = `a2-mismatch-${Date.now()}`;
  const mismatchContext = execMod.createRegisteredRunContext(
    { name: mismatchName, prompt: "A-2.2 probe", environment: "prod" },
    { environment: "dev", riskClass: "R0", taskType: "mission" }
  );
  let mismatchCalls = 0;
  const mismatchExecutor = {
    id: "a2-mismatch",
    supports: () => true,
    execute: async () => {
      mismatchCalls += 1;
      return { output: "must not run" };
    },
  };
  const mismatchResult = await execMod.executeExecutionPlan(
    await execMod.buildExecutionPlan(mismatchContext),
    { executors: [mismatchExecutor] }
  );
  check(
    "A-2.2: execution loop блокирует прогон при несовпадении профилей",
    mismatchResult.status === "blocked" &&
      mismatchResult.runId === null &&
      mismatchCalls === 0 &&
      /Профиль задачи/.test(mismatchResult.error ?? "")
  );
  check(
    "A-2.2: вердикт blocked-результата содержит оба env",
    mismatchResult.environment?.taskEnvironment === "prod" &&
      mismatchResult.environment?.runEnvironment === "dev" &&
      mismatchResult.environment?.env?.run?.name === "dev"
  );
  const envAudit = readAuditLog({ action: "execution.environment.mismatch" });
  const envAuditDetails = JSON.stringify(envAudit.records[0]?.details ?? {});
  check(
    "A-2.2: аудит блокировки содержит env и причину",
    envAudit.total > 0 &&
      envAuditDetails.includes("prod") &&
      envAuditDetails.includes("dev") &&
      envAuditDetails.includes("заблокировано")
  );

  // A-3.1: артефакты без реальных файлов — путь и содержимое приходят вместе.
  const artifactInputs = [
    { path: "reports\\A2-final.md", content: "hello" },
    { path: "./coverage/lcov.info", content: "TK:1" },
    { path: "reports/A2-final.md", content: "hello" },
  ];
  const artifacts = registerRunArtifacts(artifactInputs);
  check(
    "A-3.1: список артефактов детерминированно отсортирован и дедуплицирован",
    artifacts.map((item) => item.path).join(",") === "coverage/lcov.info,reports/A2-final.md"
  );
  check(
    "A-3.1: хэш — SHA-256 содержимого, размер — байты UTF-8",
    artifacts[1].sha256 === createHash("sha256").update("hello").digest("hex") &&
      artifacts[1].size === 5 &&
      artifacts[0].size === 4
  );
  check(
    "A-3.1: кириллица считается в байтах, а не в символах",
    registerRunArtifacts([{ path: "reports/ю.md", content: "привет" }])[0].size ===
      Buffer.byteLength("привет", "utf8")
  );
  check(
    "A-3.1: повторный вызов байт-в-байт одинаков",
    JSON.stringify(registerRunArtifacts(artifactInputs)) === JSON.stringify(artifacts)
  );
  check(
    "A-3.1: report/coverage-пути распознаются, исходные — нет",
    isRunArtifactPath("reports/x.md") &&
      isRunArtifactPath("coverage/lcov.info") &&
      isRunArtifactPath("src/x.ts") === false
  );
  const envSource = fs.readFileSync(path.join("src", "core", "environment.ts"), "utf8");
  check(
    "A-3.1: регистратор артефактов не читает часы и файлы",
    !/Date\.now|new Date\(|performance\.now|Math\.random|readFileSync|writeFileSync/.test(envSource)
  );

  // A-3.1: артефакты и env попадают в запись запуска.
  const artifactName = `a3-artifacts-${Date.now()}`;
  const artifactContext = execMod.createAdHocRunContext(`A-3.1 ${artifactName}`, {
    taskName: artifactName,
    taskType: "mission",
    riskClass: "R0",
  });
  const artifactResult = await execMod.executeExecutionPlan(
    await execMod.buildExecutionPlan(artifactContext),
    {
      executors: [{ id: "a3-test", supports: () => true, execute: async () => ({}) }],
      artifacts: artifactInputs,
    }
  );
  const runRecord = artifactResult.runId ? getRun(artifactResult.runId) : undefined;
  check(
    "A-3.1: запуск создан и вернул те же артефакты",
    artifactResult.status === "passed" &&
      JSON.stringify(artifactResult.artifacts) === JSON.stringify(artifacts)
  );
  check(
    "A-3.1: артефакты и env записаны в запись запуска",
    Boolean(runRecord) &&
      JSON.stringify(runRecord.metadata.artifacts) === JSON.stringify(artifacts) &&
      runRecord.metadata.environment.task === "dev" &&
      runRecord.metadata.environment.run === "dev" &&
      runRecord.metadata.environment.verdict === true
  );
} catch (err) {
  console.log("[diag] A-2/A-3 section THREW:", err instanceof Error ? err.stack : String(err));
  check("A-2.1/A-2.2/A-3.1: секция не выбросила исключение", false, "section threw");
}

// ---------------------------------------------------------------------------
// A-6.1 / A-6.2 — команды бота pause/resume и привязка к запускам.
// ---------------------------------------------------------------------------
try {
  const enabledTg = { notifications: { telegram: { enabled: true } } };
  const disabledTg = { notifications: { telegram: { enabled: false } } };
  const delay = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  // Парсер чистый: только тип/runId/ошибка, без сети и БД.
  const paused = parseTelegramCommand("/pause");
  check(
    "A-6.1: парсер /pause без runId",
    paused.type === "pause" && paused.runId === null && paused.error === null
  );
  const runIdProbe = "11111111-2222-4333-8444-555555555555";
  const resumed = parseTelegramCommand(`  /RESUME ${runIdProbe}  `);
  check(
    "A-6.1: парсер /resume с runId, регистронезависимо и с пробелами",
    resumed.type === "resume" && resumed.runId === runIdProbe && resumed.error === null
  );
  check(
    "A-6.1: aliases pause и resume",
    ["pause", "p", "hold"].every((name) => parseTelegramCommand(`/${name}`).type === "pause") &&
      ["resume", "r", "unpause", "continue", "play"].every(
        (name) => parseTelegramCommand(`/${name}`).type === "resume"
      )
  );
  const mentioned = parseTelegramCommand("/pause@MyBot run_42");
  check(
    "A-6.1: синтаксис /pause@Bot <runId>",
    mentioned.type === "pause" && mentioned.runId === "run_42" && mentioned.error === null
  );
  check(
    "A-6.1: невалидный runId отвергается парсером",
    parseTelegramCommand("/pause bad/id!").type === "pause" &&
      parseTelegramCommand("/pause bad/id!").runId === null &&
      parseTelegramCommand("/pause bad/id!").error !== null &&
      parseTelegramCommand("/pause a b").error !== null
  );
  check(
    "A-6.1: не-команда даёт unknown без ошибки",
    parseTelegramCommand("pause").type === "unknown" &&
      parseTelegramCommand("hello /pause").type === "unknown"
  );

  // Выключенный telegram: зависимости не вызываются вообще.
  let spyCalls = 0;
  const spyDeps = {
    listActiveRuns: () => {
      spyCalls += 1;
      return [];
    },
    getRunStatus: () => {
      spyCalls += 1;
      return null;
    },
    pauseRun: () => {
      spyCalls += 1;
      return { success: true };
    },
    resumeRun: () => {
      spyCalls += 1;
      return { success: true };
    },
  };
  const offline = handleTelegramCommand("/pause", disabledTg, spyDeps);
  check(
    "A-6.1: команда доступна только при включённом telegram",
    offline.ok === false && spyCalls === 0 && /отключен/i.test(offline.text)
  );
  const unknown = handleTelegramCommand("/status", enabledTg, spyDeps);
  check(
    "A-6.1: неизвестная команда возвращает подсказку",
    unknown.ok === false &&
      unknown.type === "unknown" &&
      /\/pause/.test(unknown.text) &&
      /\/resume/.test(unknown.text)
  );
  const badId = handleTelegramCommand("/pause bad/id!", enabledTg, spyDeps);
  check(
    "A-6.1: невалидный runId отвергается обработчиком",
    badId.ok === false && badId.runId === null && /runId/i.test(badId.text)
  );
  const missing = handleTelegramCommand(`/pause ${runIdProbe}`, enabledTg, {
    getRunStatus: () => null,
  });
  check(
    "A-6.2: несуществующий runId не создаёт действие",
    missing.ok === false && missing.runId === runIdProbe && /не найден/i.test(missing.text)
  );
  const noActive = handleTelegramCommand("/pause", enabledTg, {
    listActiveRuns: () => [],
    getRunStatus: () => null,
  });
  check(
    "A-6.2: без активных запусков команда возвращает понятный отказ",
    noActive.ok === false && /активных запусков/i.test(noActive.text)
  );

  // Реальные запуски через существующий API паузы/возобновления.
  let pauseCalls = 0;
  let resumeCalls = 0;
  const realDeps = {
    listActiveRuns: () => {
      const listed = listRunPanel({ filter: "active", limit: 100 });
      return listed.success
        ? listed.runs.map((run) => ({ id: run.id, status: run.status }))
        : [];
    },
    getRunStatus: (id) => getRunRecord(id)?.status ?? null,
    pauseRun: (id) => {
      pauseCalls += 1;
      return pauseRunPanel(id);
    },
    resumeRun: (id) => {
      resumeCalls += 1;
      return resumeRunPanel(id);
    },
  };
  const makeRun = (suffix) =>
    createRun({
      taskName: `a6-${suffix}-${Date.now()}`,
      steps: [{ stepName: "step" }],
    });
  const runA = makeRun("other");
  delay(5);
  const runB = makeRun("target");

  const pausedB = handleTelegramCommand(`/pause ${runB.id}`, enabledTg, realDeps);
  check(
    "A-6.2: /pause <runId> меняет статус только этого запуска",
    pausedB.ok === true &&
      pausedB.runId === runB.id &&
      getRunRecord(runB.id).status === "paused" &&
      getRunRecord(runA.id).status === "pending" &&
      pauseCalls === 1
  );
  check(
    "A-6.1: результат содержит понятный текст с id запуска",
    pausedB.text.length > 0 && pausedB.text.includes(runB.id)
  );
  const pausedAgain = handleTelegramCommand(`/PAUSE ${runB.id}`, enabledTg, realDeps);
  check(
    "A-6.2: повторный pause идемпотентен (API не вызывается)",
    pausedAgain.ok === true &&
      pausedAgain.status === "paused" &&
      /уже на паузе/i.test(pausedAgain.text) &&
      pauseCalls === 1
  );
  const resumedB = handleTelegramCommand(`/resume ${runB.id}`, enabledTg, realDeps);
  check(
    "A-6.2: /resume <runId> возвращает запуск в running",
    resumedB.ok === true &&
      resumedB.runId === runB.id &&
      getRunRecord(runB.id).status === "running" &&
      getRunRecord(runA.id).status === "pending" &&
      resumeCalls === 1
  );
  const resumedAgain = handleTelegramCommand(`/resume ${runB.id}`, enabledTg, realDeps);
  check(
    "A-6.2: повторный resume идемпотентен (API не вызывается)",
    resumedAgain.ok === true &&
      resumedAgain.status === "running" &&
      /уже запущен/i.test(resumedAgain.text) &&
      resumeCalls === 1
  );
  const pendingRefusal = handleTelegramCommand(`/resume ${runA.id}`, enabledTg, realDeps);
  check(
    "A-6.2: resume запуска в pending отвергается без вызова API",
    pendingRefusal.ok === false &&
      /нельзя возобновить/i.test(pendingRefusal.text) &&
      resumeCalls === 1
  );

  // Без runId берётся последний активный запуск.
  const runC = makeRun("older");
  delay(5);
  const runD = makeRun("newest");
  const newest = handleTelegramCommand("/p", enabledTg, realDeps);
  check(
    "A-6.2: без runId выбирается последний активный запуск",
    newest.ok === true &&
      newest.runId === runD.id &&
      getRunRecord(runD.id).status === "paused" &&
      getRunRecord(runC.id).status === "pending" &&
      pauseCalls === 2
  );
  const newestResume = handleTelegramCommand("/r", enabledTg, realDeps);
  check(
    "A-6.2: /r без runId возобновляет последний активный запуск",
    newestResume.ok === true &&
      newestResume.runId === runD.id &&
      getRunRecord(runD.id).status === "running" &&
      resumeCalls === 2
  );
} catch (err) {
  console.log("[diag] A-6 section THREW:", err instanceof Error ? err.stack : String(err));
  check("A-6.1/A-6.2: секция не выбросила исключение", false, "section threw");
}

// --- M-5.1..M-8.1: расширенная мульти-агентная оркестрация ---
try {
  const advanced = await import("./dist/core/agents-advanced.js");
  const execAdvanced = await import("./dist/core/execution.js");
  const {
    tournament,
    matchEventPattern,
    rememberRun,
    suggestRecipe,
    DEFAULT_MEMORY_LIMIT,
    MEMORY_DECAY_FACTOR,
    DEFAULT_RECIPE,
  } = advanced;

  // M-5.1: турнир моделей/промптов.
  const candidates = ["model-a", "model-b", "model-c"];
  const byScore = { "model-a": 0.4, "model-b": 0.9, "model-c": 0.7 };
  const duel = tournament(candidates, (candidate) => byScore[candidate]);
  check(
    "M-5.1: победитель определяется внешней оценкой",
    duel.winner === "model-b",
    JSON.stringify(duel)
  );
  check(
    "M-5.1: таблица результатов отсортирована и проранжирована",
    JSON.stringify(duel.results) ===
      JSON.stringify([
        { id: "model-b", score: 0.9, rank: 1 },
        { id: "model-c", score: 0.7, rank: 2 },
        { id: "model-a", score: 0.4, rank: 3 },
      ]),
    JSON.stringify(duel.results)
  );
  check(
    "M-5.1: повторный турнир байт-в-байт одинаков",
    JSON.stringify(tournament(candidates, (c) => byScore[c])) === JSON.stringify(duel)
  );
  check(
    "M-5.1: equal-score разрешается лексикографически",
    tournament(["zeta", "alpha"], () => 1).winner === "alpha"
  );
  check(
    "M-5.1: пустые входы и отсутствие scoreFn дают пустой результат",
    tournament([], () => 1).winner === null &&
      JSON.stringify(tournament(null, () => 1).results) === "[]" &&
      JSON.stringify(tournament(candidates, null).results) === "[]"
  );
  check(
    "M-5.1: нечисловая оценка и исключение scoreFn не ломают турнир",
    tournament(["bad", "ok"], (c) => (c === "bad" ? Number.NaN : 1)).winner === "ok" &&
      tournament(["x", "y"], () => {
        throw new Error("score failed");
      }).results.every((row) => row.score === 0)
  );
  check(
    "M-5.1: объекты-кандидаты и дубликаты обрабатываются детерминированно",
    JSON.stringify(
      tournament([{ id: "b" }, { id: "a" }, { id: "b" }], (c) => (c.id === "a" ? 5 : 1)).results
    ) === JSON.stringify([
      { id: "a", score: 5, rank: 1 },
      { id: "b", score: 1, rank: 2 },
    ])
  );

  // M-6.1: минимальный CEP.
  const events = [
    { type: "start", value: 1 },
    { type: "cpu", value: 10 },
    { type: "cpu", value: 20 },
    { type: "finish", value: 3 },
  ];
  const seq = matchEventPattern(events, { kind: "sequence", sequence: ["cpu", "finish"] });
  check(
    "M-6.1: последовательность находится по подряд идущим типам",
    seq.matched === true && JSON.stringify(seq.indices) === "[2,3]" && seq.aggregate === null,
    JSON.stringify(seq)
  );
  check(
    "M-6.1: отсутствующая последовательность не совпадает",
    matchEventPattern(events, { kind: "sequence", sequence: ["finish", "cpu"] }).matched === false
  );
  const windowHit = matchEventPattern(events, {
    kind: "window",
    sequence: ["start", "cpu"],
    window: 2,
  });
  check(
    "M-6.1: окно находит типы с разрывом в пределах лимита",
    windowHit.matched === true && JSON.stringify(windowHit.indices) === "[0,1]",
    JSON.stringify(windowHit)
  );
  check(
    "M-6.1: окно отклоняет слишком далёкие события",
    matchEventPattern(events, { kind: "window", sequence: ["start", "finish"], window: 2 }).matched ===
      false
  );
  const sum = matchEventPattern(events, {
    kind: "aggregate",
    types: ["cpu"],
    field: "value",
    aggregate: "sum",
    min: 25,
  });
  check(
    "M-6.1: агрегат sum с порогом считается по отфильтрованным событиям",
    sum.matched === true && sum.aggregate === 30 && JSON.stringify(sum.indices) === "[1,2]",
    JSON.stringify(sum)
  );
  check(
    "M-6.1: агрегат с порогом выше значения не совпадает",
    matchEventPattern(events, {
      kind: "aggregate",
      types: ["cpu"],
      aggregate: "sum",
      min: 100,
    }).matched === false
  );
  check(
    "M-6.1: пустые входы и шаблон fail-open",
    matchEventPattern([], { sequence: ["cpu"] }).matched === false &&
      matchEventPattern(null, { sequence: ["cpu"] }).matched === false &&
      matchEventPattern(events, null).matched === false &&
      matchEventPattern(events, { kind: "aggregate", types: ["cpu"], aggregate: "avg" }).aggregate ===
        15
  );

  // M-7.1: память между прогонами.
  let memory = null;
  for (const id of ["run-a", "run-b", "run-c"]) {
    memory = rememberRun(memory, { runId: id, metrics: { score: 0.5, retries: 1 } });
  }
  check(
    "M-7.1: записи упорядочены по свежести и содержат только хеш и метрики",
    memory.entries.length === 3 &&
      memory.entries[0].runsAgo === 0 &&
      /^h[0-9a-f]{8}$/.test(memory.entries[0].hash) &&
      memory.entries[0].hash !== "run-c" &&
      JSON.stringify(memory.entries[0].metrics) === JSON.stringify({ retries: 1, score: 0.5 }),
    JSON.stringify(memory)
  );
  check(
    "M-7.1: затухание по числу прогонов детерминировано",
    MEMORY_DECAY_FACTOR === 0.5 &&
      memory.entries[1].runsAgo === 1 &&
      memory.entries[1].weight === 0.5 &&
      memory.entries[2].runsAgo === 2 &&
      memory.entries[2].weight === 0.25,
    JSON.stringify(memory.entries)
  );
  let bounded = null;
  for (const id of ["1", "2", "3"]) bounded = rememberRun(bounded, { runId: id }, 2);
  check(
    "M-7.1: лимит отбрасывает старые записи, totalRuns растёт",
    bounded.entries.length === 2 &&
      bounded.limit === 2 &&
      bounded.totalRuns === 3 &&
      bounded.entries[1].runsAgo === 1,
    JSON.stringify(bounded)
  );
  const secretRun = rememberRun(null, {
    runId: "run with API_KEY=sk-secret12345",
    metrics: { password: "hunter2", score: 0.9, success: true },
  });
  const secretJson = JSON.stringify(secretRun);
  check(
    "M-7.1: секреты и произвольные поля в память не попадают",
    !/sk-secret12345|hunter2|API_KEY|password/.test(secretJson) &&
      secretRun.entries[0].metrics.success === 1,
    secretJson
  );
  check(
    "M-7.1: повторный вызов на тех же входах идентичен и не мутирует вход",
    JSON.stringify(rememberRun(memory, { runId: "run-d", metrics: { score: 0.5 } })) ===
      JSON.stringify(rememberRun(memory, { runId: "run-d", metrics: { score: 0.5 } })) &&
      memory.entries.length === 3 &&
      DEFAULT_MEMORY_LIMIT === 8
  );

  // M-8.1: само настраивающиеся конвейеры.
  check(
    "M-8.1: пустая и невалидная история fail-open",
    JSON.stringify(suggestRecipe([])) === JSON.stringify(DEFAULT_RECIPE) &&
      JSON.stringify(suggestRecipe(null)) === JSON.stringify(DEFAULT_RECIPE) &&
      JSON.stringify(suggestRecipe(undefined)) === JSON.stringify(DEFAULT_RECIPE)
  );
  const badHistory = [
    { metrics: { success: false, retries: 3, errors: 2, score: 0.1, durationMs: 9000 } },
    { metrics: { success: false, retries: 2, score: 0.2, durationMs: 8000 } },
  ];
  check(
    "M-8.1: высокая аварийность даёт thorough-конфиг",
    JSON.stringify(suggestRecipe(badHistory)) ===
      JSON.stringify({
        strategy: "thorough",
        model: "fallback",
        maxAttempts: 4,
        confidenceThreshold: 0.75,
        parallelism: 1,
      }),
    JSON.stringify(suggestRecipe(badHistory))
  );
  const goodHistory = [
    { metrics: { success: true, score: 0.95, durationMs: 1200 } },
    { metrics: { success: true, score: 0.85, durationMs: 1800 } },
  ];
  check(
    "M-8.1: быстрые успешные прогоны дают fast-конфиг",
    suggestRecipe(goodHistory).strategy === "fast" &&
      suggestRecipe(goodHistory).maxAttempts === 2 &&
      suggestRecipe(goodHistory).parallelism === 2
  );
  check(
    "M-8.1: средние метрики оставляют сбалансированный конфиг",
    JSON.stringify(
      suggestRecipe([{ metrics: { success: true, score: 0.6, durationMs: 2000 } }])
    ) === JSON.stringify(DEFAULT_RECIPE)
  );
  check(
    "M-8.1: рецепт детерминирован и принимает RunMemory",
    JSON.stringify(suggestRecipe(goodHistory)) === JSON.stringify(suggestRecipe(goodHistory)) &&
      suggestRecipe(rememberRun(null, { metrics: { success: true, score: 0.9 } })).strategy ===
        "fast"
  );
  check(
    "M-5..M-8: execution.ts реэкспортирует все новые функции",
    ["tournament", "matchEventPattern", "rememberRun", "suggestRecipe"].every(
      (name) => typeof execAdvanced[name] === "function"
    ) &&
      execAdvanced.DEFAULT_MEMORY_LIMIT === DEFAULT_MEMORY_LIMIT &&
      JSON.stringify(execAdvanced.DEFAULT_RECIPE) === JSON.stringify(DEFAULT_RECIPE)
  );
} catch (err) {
  console.log("[diag] M-5..M-8 section THREW:", err instanceof Error ? err.stack : String(err));
  check("M-5..M-8: секция не выбросила исключение", false, "section threw");
}

// PL-126: детерминированный прогон сгенерированного .cmd с ошибкой create.
// Реальные git/powershell не нужны: помощник и recorder — заглушки. Проверяем
// fail-closed, понятную причину в логе/истории и очистку созданного worktree.
{
  const wtDir = path.join(tempRoot, "pl126");
  fs.mkdirSync(wtDir, { recursive: true });
  const wtLog = path.join(wtDir, "run.log");
  const helperCalls = path.join(wtDir, "helper-calls.txt");
  const recorderCalls = path.join(wtDir, "recorder-calls.txt");
  const emittedPath = path.join(wtDir, "emitted-worktree");
  const fakeHelper = path.join(wtDir, "fake-worktree-run.cjs");
  const fakeRecorder = path.join(wtDir, "fake-record-history.cjs");
  fs.writeFileSync(
    fakeHelper,
    [
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(helperCalls)}, JSON.stringify(args) + "\\n", "utf8");`,
      'if (args[0] === "cleanup") process.exit(0);',
      'process.stderr.write("fake helper: git worktree add failed\\n");',
      `process.stdout.write(${JSON.stringify(emittedPath)} + "\\n");`,
      "process.exit(1);",
      "",
    ].join("\r\n"),
    "utf8",
  );
  fs.writeFileSync(
    fakeRecorder,
    [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(recorderCalls)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");`,
      "",
    ].join("\r\n"),
    "utf8",
  );
  const cmd = await writeWrapperCmd(
    "pl126-probe",
    "pl126 task",
    path.join(wtDir, "prompt.txt"),
    60,
    path.join(wtDir, "lock"),
    wtDir,
    wtLog,
    fakeRecorder,
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, // qualityGate..envFile (9)
    "new",
    undefined, undefined, undefined, undefined, undefined,
    true,
    fakeHelper,
  );
  const run = spawnSync("cmd.exe", ["/c", cmd], {
    encoding: "utf8",
    windowsHide: true,
    cwd: wtDir,
  });
  const readCalls = (file) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const helperArgs = readCalls(helperCalls);
  const recorderArgs = readCalls(recorderCalls);
  const logText = fs.existsSync(wtLog) ? fs.readFileSync(wtLog, "utf8") : "";

  check("PL-126: .cmd с ошибкой create завершается кодом 1", run.status === 1, String(run.status));
  check(
    "PL-126: причина create и stderr помощника попадают в лог",
    logText.includes("PL-126") &&
      logText.includes(WORKTREE_CREATE_FAILURE_REASON) &&
      logText.includes("fake helper: git worktree add failed"),
    logText.slice(0, 400),
  );
  check(
    "PL-126: помощник вызван с явной подкомандой create и реальными аргументами",
    Array.isArray(helperArgs[0]) &&
      JSON.stringify(helperArgs[0]) ===
        JSON.stringify(["create", "--repo", wtDir, "--task", "pl126 task"]),
    JSON.stringify(helperArgs[0]),
  );
  check(
    "PL-126: при ошибке create очищается созданный worktree",
    helperArgs.some((a) => a[0] === "cleanup" && a.includes("--path") && a.includes(emittedPath)),
    JSON.stringify(helperArgs),
  );
  const skip = recorderArgs.find((a) => a[0] === "--skip");
  check(
    "PL-126: причина пишется в историю через --skip",
    Array.isArray(skip) &&
      skip[1] === "pl126 task" &&
      Buffer.from(skip[2] ?? "", "base64").toString("utf8").includes("PL-126"),
    JSON.stringify(skip),
  );
}

// --- PL-138 / PL-134: репер осиротевших запусков и причина простоя (строковые регрессии) ---
// Реальные kill не нужны: проверяем контракт исходников и сгенерированный обёрткой скрипт.
try {
  const indexSrc = fs.readFileSync(path.resolve("src/index.ts"), "utf8");
  const psWrapperSrc = fs.readFileSync(path.resolve("src/core/ps-wrapper.ts"), "utf8");
  const entryAt = indexSrc.indexOf("async function runTaskEntry(");
  const entrySrc = indexSrc.slice(entryAt, entryAt + 4000);
  const reapAt = entrySrc.indexOf("await reapStaleRuns()");
  const isolationAt = entrySrc.indexOf("planRuntimeIsolation({");

  check(
    "PL-138: reapStaleRuns() вызывается в начале runTaskEntry до planRuntimeIsolation",
    reapAt >= 0 && isolationAt > reapAt,
    `reapAt=${reapAt}, isolationAt=${isolationAt}`,
  );
  check(
    "PL-138: причина осиротевшего запуска и порог из env присутствуют в исходнике",
    indexSrc.includes("PL-138: осиротевший запуск") &&
      indexSrc.includes("AGENT_STEWARD_STALE_RUN_LOG_SEC") &&
      indexSrc.includes("resolveTaskLogPath") &&
      indexSrc.includes("fs.stat") &&
      indexSrc.includes("os.hostname()") &&
      indexSrc.includes('spawnSync("taskkill", ["/F", "/T", "/PID"')
  );
  check(
    "PL-138: финализация записи и снятие счётчика PL-106 не ниже нуля",
    indexSrc.includes('finishRun(rec.id, "error", durationMs, reason, null, 0, 0, undefined, "skipped", "skipped")') &&
      indexSrc.includes("activeNonIsolatedRuns = Math.max(0, activeNonIsolatedRuns - 1)")
  );
  check(
    "PL-134: idle-сторож пишет осмысленную причину в маркер вместо \"idle\"",
    psWrapperSrc.includes(
      'PL-134: агент не отвечает (простой $IdleSec с, лог и CPU без изменений)'
    ) &&
      psWrapperSrc.includes("Set-Content -Path $Marker -Value $reason -Encoding UTF8") &&
      !psWrapperSrc.includes('Set-Content -Path $Marker -Value "idle"')
  );
  check(
    "PL-134: причина из маркера читается в $script:idleReason и пишется в лог",
    psWrapperSrc.includes("$script:idleReason = (Get-Content -LiteralPath $completionMarker -Raw") &&
      psWrapperSrc.includes("PL-134: причина завершения по простою: $script:idleReason") &&
      psWrapperSrc.includes("PL-124: дочерний агент завершён/простаивает") &&
      psWrapperSrc.includes("return 0")
  );
  check(
    "PL-134: причина доходит до сгенерированной PowerShell-обёртки",
    psWrapperScript.includes("PL-134: агент не отвечает") &&
      psWrapperScript.includes("$script:idleReason")
  );
} catch (err) {
  console.log("[diag] PL-138/PL-134 section THREW:", err instanceof Error ? err.stack : String(err));
  check("PL-138/PL-134: секция не выбросила исключение", false, "section threw");
}

const failed = results.filter((r) => !r.ok);
console.log(`\nExecution hardening: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята дочерним процессом — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
