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

const failed = results.filter((r) => !r.ok);
console.log(`\nExecution hardening: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята дочерним процессом — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
