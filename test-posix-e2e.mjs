// E2E для POSIX-обёртки (bash): успех, таймаут с убийством дерева (T-10),
// блокировка запуска и рекордер истории. На Windows — пропуск (там свой
// стаб opencode.cmd в test-execution-hardening.mjs).
//
// Запуск: node test-posix-e2e.mjs (после npm run build, только не на Windows).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  console.log("POSIX e2e: пропуск на Windows (bash-обёртка не используется).");
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-posix-e2e-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
// Явно задаём путь к БД, чтобы не зависеть от закешированного PLUGIN_DIR
// из types.js (мог быть вычислен предыдущим тестом в цепочке npm test с
// другим профилем/окружением).
process.env.OPENCODE_SCHEDULER_DB = path.join(tempRoot, "scheduler.db");

const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
fs.mkdirSync(pluginDir, { recursive: true });

const fakeBin = path.join(tempRoot, "fakebin");
fs.mkdirSync(fakeBin, { recursive: true });
const counterFile = path.join(tempRoot, "fake-opencode-calls.txt");
const childPidFile = path.join(tempRoot, "fake-opencode-child.pid");
const fakeOpencode = path.join(fakeBin, "opencode");
fs.writeFileSync(
  fakeOpencode,
  [
    "#!/usr/bin/env bash",
    'echo call >> "$FAKE_COUNTER"',
    'case "$FAKE_MODE" in',
    "  sleep)",
    '    echo FAKE-OPENCODE-SLEEP-START',
    '    sleep 60 &',
    '    echo $! > "$FAKE_CHILD_PID"',
    "    wait $!",
    '    echo FAKE-OPENCODE-SLEEP-DONE',
    "    ;;",
    "  fail)",
    "    echo FAKE-OPENCODE-FAIL",
    "    exit 1",
    "    ;;",
    "  *)",
    '    echo FAKE-OPENCODE-OK "$@"',
    "    ;;",
    "esac",
    "",
  ].join("\n"),
  "utf8"
);
fs.chmodSync(fakeOpencode, 0o755);
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
process.env.FAKE_COUNTER = counterFile;
process.env.FAKE_CHILD_PID = childPidFile;

// Диагностика окружения (полезно на CI, где нет доступа к job логам).
console.log(`[diag] platform=${process.platform} node=${process.versions.node}`);
console.log(`[diag] APPDATA=${process.env.APPDATA}`);
console.log(`[diag] OPENCODE_SCHEDULER_HOME=${process.env.OPENCODE_SCHEDULER_HOME}`);
console.log(`[diag] OPENCODE_SCHEDULER_DB=${process.env.OPENCODE_SCHEDULER_DB}`);
console.log(`[diag] tempRoot=${tempRoot}`);
console.log(`[diag] pluginDir=${pluginDir}`);

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

// dist-модули импортируем ТОЛЬКО после настройки env.
const { initDb } = await import("./dist/db/index.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { getHistory } = await import("./dist/db/history-repo.js");
const { writePromptFile } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");

initDb();

const recorder = path.resolve("dist/core/record-history.js");

function writeWrapper(spec) {
  const script = buildBashWrapperScript({
    sanitizedName: spec.sanitized,
    taskName: spec.name,
    promptFile: spec.promptFile,
    timeoutSeconds: spec.timeoutSeconds ?? 0,
    lockFile: spec.lockFile,
    workdir: tempRoot,
    logFile: spec.logFile,
    recorderFile: recorder,
    beforeScript: spec.beforeScript,
    afterScript: spec.afterScript,
    qualityGate: spec.qualityGate,
    sessionMode: "new",
  });
  const wrapperPath = path.join(tempRoot, `run-${spec.sanitized}.sh`);
  fs.writeFileSync(wrapperPath, script, "utf8");
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

async function prepareTask(spec) {
  saveTask({
    name: spec.name,
    schedule: "0 9 * * *",
    prompt: spec.prompt,
    timeoutSeconds: spec.timeoutSeconds,
  });
  spec.promptFile = await writePromptFile(spec.sanitized, spec.prompt);
  fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
  return writeWrapper(spec);
}

const runWrapper = (wrapperPath, env) =>
  spawnSync("bash", [wrapperPath], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 120000,
  });

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

// --- 1. Успешный запуск: лог, история, pre/post-хуки с пробелами в пути ---
try {
  const spacesDir = path.join(tempRoot, "hooks with spaces");
  fs.mkdirSync(spacesDir, { recursive: true });
  const beforeMarker = path.join(spacesDir, "before-marker.txt");
  const afterMarker = path.join(spacesDir, "after-marker.txt");
  const spec = {
    name: "posix e2e success",
    sanitized: "posix-e2e-success",
    prompt: "Скажи hello",
    logFile: path.join(pluginDir, "logs", "posix-e2e-success.log"),
    lockFile: path.join(pluginDir, "locks", "posix-e2e-success.lock"),
    timeoutSeconds: 30,
    beforeScript: `echo before>"${beforeMarker}"`,
    afterScript: `echo after>"${afterMarker}"`,
  };
  const wrapperPath = await prepareTask(spec);
  const run = runWrapper(wrapperPath, {});

  if (run.status !== 0) {
    console.log("[diag] section 1 run.status:", run.status, "error:", run.error?.message, "signal:", run.signal);
    console.log("[diag] section 1 stderr:", run.stderr);
    console.log("[diag] section 1 stdout:", run.stdout);
    console.log("[diag] section 1 LOG:", readLog(spec.logFile));
    console.log("[diag] section 1 WRAPPER:", fs.readFileSync(wrapperPath, "utf8"));
  }

  check("успешный запуск: код 0", run.status === 0, `status=${run.status}`);
  const [record] = getHistory(spec.name, 5);
  check("успешный запуск: запись истории есть", Boolean(record));
  check("успешный запуск: статус success", record?.status === "success", record?.status);
  check(
    "кавычки в before/after-скриптах не ломают хуки",
    fs.existsSync(beforeMarker) && fs.existsSync(afterMarker)
  );
  check("лог содержит вывод opencode", readLog(spec.logFile).includes("FAKE-OPENCODE-OK"));
  check(
    "рекордер: модель не сдвинута в preFlight",
    record?.model !== "success" && record?.model !== "skipped",
    `model=${record?.model}`
  );
} catch (err) {
  console.log("[diag] section 1 THREW:", err instanceof Error ? err.stack : String(err));
  check("успешный запуск: код 0", false, "section threw");
  check("успешный запуск: запись истории есть", false, "section threw");
  check("успешный запуск: статус success", false, "section threw");
  check("кавычки в before/after-скриптах не ломают хуки", false, "section threw");
  check("лог содержит вывод opencode", false, "section threw");
  check("рекордер: модель не сдвинута в preFlight", false, "section threw");
}

// --- 2. Таймаут убивает всё дерево: внук (sleep) не переживает (T-10) ---
try {
  const spec = {
    name: "posix e2e timeout",
    sanitized: "posix-e2e-timeout",
    prompt: "Спи",
    logFile: path.join(pluginDir, "logs", "posix-e2e-timeout.log"),
    lockFile: path.join(pluginDir, "locks", "posix-e2e-timeout.lock"),
    timeoutSeconds: 2,
  };
  const wrapperPath = await prepareTask(spec);
  const started = Date.now();
  const run = runWrapper(wrapperPath, { FAKE_MODE: "sleep" });
  const elapsedMs = Date.now() - started;

  if (run.status !== 0) {
    console.log("[diag] section 2 run.status:", run.status, "error:", run.error?.message, "signal:", run.signal);
    console.log("[diag] section 2 stderr:", run.stderr);
    console.log("[diag] section 2 stdout:", run.stdout);
    console.log("[diag] section 2 LOG:", readLog(spec.logFile));
  }

  check(
    "таймаут: задача убита раньше 15 с",
    run.status !== null && elapsedMs < 15000,
    `elapsedMs=${elapsedMs}`
  );
  const [record] = getHistory(spec.name, 5);
  check("таймаут: запись истории есть со статусом timeout", record?.status === "timeout", record?.status);
  check(
    "таймаут: в логе причина — таймаут",
    readLog(spec.logFile).includes("прервана по таймауту")
  );

  // Внук должен умереть вместе с группой процессов.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const grandchildPid = () => {
    try {
      const pid = Number(fs.readFileSync(childPidFile, "utf8").trim());
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };
  let grandchildAlive = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(400);
    const pid = grandchildPid();
    if (pid === null) {
      grandchildAlive = null;
      break;
    }
    try {
      process.kill(pid, 0);
      grandchildAlive = true; // пока жив — повторим после реапа zombie
    } catch (err) {
      if (err?.code === "EPERM") grandchildAlive = true;
      else {
        grandchildAlive = false;
        break;
      }
    }
  }
  check("таймаут: внук (sleep) не переживает убийство дерева", grandchildAlive === false);
} catch (err) {
  console.log("[diag] section 2 THREW:", err instanceof Error ? err.stack : String(err));
  check("таймаут: задача убита раньше 15 с", false, "section threw");
  check("таймаут: запись истории есть со статусом timeout", false, "section threw");
  check("таймаут: в логе причина — таймаут", false, "section threw");
  check("таймаут: внук (sleep) не переживает убийство дерева", false, "section threw");
}

// --- 3. Блокировка: второй запуск тихо пропускается ---
try {
  const spec = {
    name: "posix e2e lock",
    sanitized: "posix-e2e-lock",
    prompt: "Двойной",
    logFile: path.join(pluginDir, "logs", "posix-e2e-lock.log"),
    lockFile: path.join(pluginDir, "locks", "posix-e2e-lock.lock"),
    timeoutSeconds: 30,
  };
  const wrapperPath = await prepareTask(spec);
  // mkdir-блокировка bash-обёртки — создаём каталог <lock>.d.
  fs.mkdirSync(`${spec.lockFile}.d`, { recursive: true });

  const run = runWrapper(wrapperPath, {});
  const log = readLog(spec.logFile);

  if (run.status !== 0) {
    console.log("[diag] section 3 run.status:", run.status, "error:", run.error?.message, "signal:", run.signal);
    console.log("[diag] section 3 stderr:", run.stderr);
    console.log("[diag] section 3 stdout:", run.stdout);
    console.log("[diag] section 3 LOG:", readLog(spec.logFile));
  }

  check("блокировка: код 0 (тихий пропуск)", run.status === 0, `status=${run.status}`);
  check("блокировка: в логе сообщение о пропуске", log.includes("уже выполняется"));
  check("блокировка: история не создавалась", getHistory(spec.name, 5).length === 0);

  fs.rmSync(`${spec.lockFile}.d`, { recursive: true, force: true });
} catch (err) {
  console.log("[diag] section 3 THREW:", err instanceof Error ? err.stack : String(err));
  check("блокировка: код 0 (тихий пропуск)", false, "section threw");
  check("блокировка: в логе сообщение о пропуске", false, "section threw");
  check("блокировка: история не создавалась", false, "section threw");
}

// --- 4. T-09 backstop: проверка размера промпта присутствует в скрипте ---
try {
  const spec = {
    name: "posix e2e promptsize",
    sanitized: "posix-e2e-promptsize",
    prompt: "x",
    promptFile: path.join(tempRoot, "prompt-posix-e2e-promptsize.txt"),
    logFile: path.join(pluginDir, "logs", "posix-e2e-promptsize.log"),
    lockFile: path.join(pluginDir, "locks", "posix-e2e-promptsize.lock"),
  };
  const wrapperPath = writeWrapper(spec);
  const script = fs.readFileSync(wrapperPath, "utf8");
  check("backstop: в обёртке есть проверка PROMPT_BYTES", script.includes("PROMPT_BYTES"));
  check("backstop: лимит 131072 байта", script.includes("131072"));
  // Регресс: без создания каталога lock `mkdir` падал с ENOENT и обёртка
  // молча уходила в ветку «уже выполняется».
  check(
    "lock: обёртка создаёт каталог для lock-файла",
    script.includes('mkdir -p "$(dirname "$LOCK_FILE")"')
  );
  check(
    "lock: ошибка создания lock не выдаётся за «уже выполняется»",
    script.includes('[ ! -d "$LOCK_FILE.d" ]')
  );
  // B2: повторы принадлежат recorder'у. POSIX-обёртка запускает opencode один
  // раз (`exec`), своего retry-цикла у неё нет — иначе получилось бы (1+N)^2.
  check("ретраи: POSIX-обёртка не содержит retry-цикла", !/retry/i.test(script));
  check("ретраи: POSIX-обёртка делает один запуск через exec", script.includes("exec opencode run"));
} catch (err) {
  console.log("[diag] section 4 THREW:", err instanceof Error ? err.stack : String(err));
  check("backstop: в обёртке есть проверка PROMPT_BYTES", false, "section threw");
  check("backstop: лимит 131072 байта", false, "section threw");
}

// --- 5. G-1.2: тест-атака — агент подменяет команду Quality Gate в обёртке ---
try {
  const spec = {
    name: "posix e2e gate attack",
    sanitized: "posix-e2e-gate-attack",
    prompt: "Скажи hello",
    logFile: path.join(pluginDir, "logs", "posix-e2e-gate-attack.log"),
    lockFile: path.join(pluginDir, "locks", "posix-e2e-gate-attack.lock"),
    timeoutSeconds: 30,
    qualityGate: "test -d .",
  };
  const wrapperPath = await prepareTask(spec);
  const original = fs.readFileSync(wrapperPath, "utf8");
  check("G-1.2: обёртка содержит путь снимка гейта", original.includes("GATE_SNAPSHOT="));

  const control = runWrapper(wrapperPath, {});
  check("G-1.2: контрольный прогон с гейтом успешен", control.status === 0, `status=${control.status}`);

  // Агент меняет гейт-команду на «всегда успешно» — снимок должен это поймать.
  const attacked = original.replace(/^QUALITY_GATE=.*$/m, "QUALITY_GATE='exit 0'");
  check("G-1.2: команда гейта подменена", attacked !== original);
  fs.writeFileSync(wrapperPath, attacked, "utf8");
  const attack = runWrapper(wrapperPath, {});
  check("G-1.2: подмена гейта даёт ненулевой код", attack.status !== 0, `status=${attack.status}`);
  check(
    "G-1.2: лог содержит snapshot mismatch",
    readLog(spec.logFile).includes("snapshot mismatch"),
    readLog(spec.logFile).slice(-400)
  );
  const records = getHistory(spec.name, 10);
  check(
    "G-1.2: история фиксирует ошибку целостности гейта",
    records.some((r) => r.status === "error" && String(r.error ?? "").includes("snapshot mismatch"))
  );
} catch (err) {
  console.log("[diag] section 5 THREW:", err instanceof Error ? err.stack : String(err));
  check("G-1.2: тест-атака не выбросила исключение", false, "section threw");
}

const failed = results.filter((r) => !r.ok);
console.log(`\nPOSIX e2e: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // Временная папка может быть занята — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
