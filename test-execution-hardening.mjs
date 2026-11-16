// Тест исполнения: hotfix 1.5.3.1.
// Проверяем то, что раньше не работало:
//   1. TimeoutSeconds реально убивает задачу, статус = "timeout"
//   2. Повторный запуск при активной блокировке пропускается (нет второго запуска)
//   3. retryCount из схемы действительно даёт N+1 попыток
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
    undefined,
    spec.retryCount,
    spec.retryDelay
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

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

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

// --- 4. retryCount: N+1 попыток ---
{
  const spec = {
    name: "Exec Hardening Retry",
    sanitized: "exec-hardening-retry",
    timeoutSeconds: 30,
    retryCount: 2,
    retryDelay: 0,
  };
  fs.rmSync(counterFile, { force: true });
  const { wrapperPath } = await prepareTask(spec);
  const run = runWrapper(wrapperPath, { FAKE_MODE: "fail" });

  const calls = fs.existsSync(counterFile)
    ? fs.readFileSync(counterFile, "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  check("ретраи: ровно 3 попытки (1 + retryCount 2)", calls === 3, `calls=${calls}`);
  check("ретраи: итоговый код не 0", run.status !== 0, `status=${run.status}`);
  const [record] = getHistory(spec.name, 5);
  check("ретраи: статус error", record?.status === "error", record?.status);
}

// --- 5. list_tasks отдаёт timeoutSeconds ---
{
  saveTask({
    name: "Exec Hardening View",
    schedule: "0 9 * * *",
    prompt: "view",
    timeoutSeconds: 45,
  });

  const plugin = (await import("./dist/index.js")).default;
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

  const listTool = tools.get("list_tasks");
  check("list_tasks зарегистрирован", Boolean(listTool));
  if (listTool) {
    const res = await listTool.execute({}, {});
    const payload = JSON.parse(res.content);
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

const failed = results.filter((r) => !r.ok);
console.log(`\nExecution hardening: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята дочерним процессом — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
