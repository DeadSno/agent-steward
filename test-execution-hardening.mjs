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
const { writeWrapperCmd, writePromptFile, lockFilePath, ensureWrapper } = await import(
  "./dist/core/ps-wrapper.js"
);
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

const failed = results.filter((r) => !r.ok);
console.log(`\nExecution hardening: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята дочерним процессом — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
