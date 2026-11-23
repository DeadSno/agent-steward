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
  writePromptFile,
  lockFilePath,
  ensureWrapper,
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
    "PL-101: конфликт сохраняется и помечается без падения задачи",
    helper.includes("merge-conflicts") &&
      helper.includes("merge-conflict-pending.md") &&
      helper.includes("PL-101: conflict files preserved") &&
      !helper.includes("exit 2")
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

const failed = results.filter((r) => !r.ok);
console.log(`\nExecution hardening: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята дочерним процессом — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
