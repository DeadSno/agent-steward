/**
 * B8: сторож таймаута PowerShell-обёртки.
 * Запуск: node test-ps-watchdog.mjs (после npm run build).
 *
 * Проверяем статический контракт сгенерированного скрипта: основной путь
 * через CIM, фолбэки WMI → tasklist/Get-Process и fail-closed kill дерева,
 * когда иерархию процессов получить не удалось.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// QA-D316-4: env должны быть выставлены до импорта dist-модулей — PLUGIN_DIR
// и WRAPPER_DIR фиксируются на этапе загрузки модуля.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-watchdog-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
delete process.env.AGENT_STEWARD_CHILD_RUN;

const {
  WRAPPER_SCRIPT,
  writeWrapperCmd,
  writePromptFile,
  lockFilePath,
  ensureWrapper,
  resolveWrapperRecordVerdict,
  resolveCompletionIdleWindow,
} = await import("./dist/core/ps-wrapper.js");

const results = [];
let passed = 0;
let failed = 0;
function check(name, cond) {
  const ok = !!cond;
  results.push({ name, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

check(
  "B8: основной снимок через Get-CimInstance в try/catch",
  /try\s*{\s*\$all\s*=\s*@\(Get-CimInstance Win32_Process[^)]*-ErrorAction Stop\)/.test(
    WRAPPER_SCRIPT
  )
);
check(
  "B8: фолбэк Get-WmiObject Win32_Process",
  /Get-WmiObject Win32_Process -Property ProcessId, ParentProcessId/.test(
    WRAPPER_SCRIPT
  )
);
check(
  "B8: фолбэк tasklist",
  /tasklist\.exe \/FO CSV \/NH/.test(WRAPPER_SCRIPT)
);
check(
  "B8: фолбэк Get-Process",
  /Get-Process -ErrorAction Stop/.test(WRAPPER_SCRIPT)
);
check(
  "B8: признак доступности иерархии dataAvailable",
  /\$dataAvailable\s*=\s*\$all\.Count -gt 0/.test(WRAPPER_SCRIPT)
);
check(
  "B8: fail-closed ветка при отсутствии данных",
  /elseif \(-not \$dataAvailable\)/.test(WRAPPER_SCRIPT)
);
check(
  "B8: fail-closed убивает дерево по корневому PID",
  /taskkill\.exe" -ArgumentList @\("\/F", "\/T", "\/PID", \[string\]\$RootId\)/.test(
    WRAPPER_SCRIPT
  )
);
check(
  "B8: маркер таймаута ставится до kill",
  WRAPPER_SCRIPT.indexOf('Set-Content -Path $Marker -Value "timeout"') <
    WRAPPER_SCRIPT.indexOf('"taskkill.exe" -ArgumentList')
);

// PL-51: health-check лога против зависших моделей (бесконечный retry).
check(
  "PL-51: health-check включается для задач с LogFile и отключается env",
  /AGENT_STEWARD_HEALTH_CHECK -ne "0" -and \$LogFile/.test(WRAPPER_SCRIPT)
);
check(
  "PL-51: пороги health-check настраиваются env",
  ["AGENT_STEWARD_HEALTH_INTERVAL_SEC", "AGENT_STEWARD_HEALTH_REPEAT_THRESHOLD", "AGENT_STEWARD_HEALTH_TAIL_LINES"].every(
    (name) => WRAPPER_SCRIPT.includes(name)
  )
);
check(
  "PL-51: сторож ищет известные повторяющиеся ошибки моделей",
  /ECONNRESET\|Free usage limit reached\|Insufficient Balance\|ECONNREFUSED\|ETIMEDOUT/.test(
    WRAPPER_SCRIPT
  )
);
check(
  "PL-51: старые ошибки не убивают запуск (базовая линия)",
  /\$baseline\s*=\s*-1/.test(WRAPPER_SCRIPT) &&
    /\$bad\.Count\s*-ge\s*\$baseline\s*\+\s*\$Threshold/.test(WRAPPER_SCRIPT)
);
const healthSection = WRAPPER_SCRIPT.slice(
  WRAPPER_SCRIPT.indexOf("PL-51: health-check")
);
check(
  "PL-51: причина пишется в лог и маркер до kill дерева",
  healthSection.indexOf("Add-Content -LiteralPath $LogPath") >= 0 &&
    healthSection.indexOf("Add-Content -LiteralPath $LogPath") <
      healthSection.indexOf("Set-Content -LiteralPath $Marker") &&
    healthSection.indexOf("Set-Content -LiteralPath $Marker") <
      healthSection.indexOf("taskkill.exe /F /T /PID $RootId")
);
check(
  "PL-51: отдельный код возврата и cleaned-up маркер",
  WRAPPER_SCRIPT.includes("$healthFailure") &&
    WRAPPER_SCRIPT.includes("return 125") &&
    /Remove-Item -LiteralPath \$healthMarker -Force/.test(WRAPPER_SCRIPT)
);

// Синтаксис сгенерированного скрипта: powershell.exe должен разобрать его без ошибок.
if (process.platform === "win32") {
  const scriptFile = path.join(tempRoot, "wrapper.ps1");
  fs.writeFileSync(scriptFile, "\uFEFF" + WRAPPER_SCRIPT, "utf8");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  // QA-CI-2: ParseFile + путь в -Command оказались чувствительны к кодировке и
  // экранированию кавычек на Windows-раннерах Node22. Читаем файл как UTF-8
  // средствами .NET и передаём путь через env, чтобы исключить обе причины.
  const parse = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = "Stop"; $p = $env:QA_WATCHDOG_SCRIPT; ` +
        `$text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF); ` +
        `$tokens = $null; $errors = $null; ` +
        `[void][System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors); ` +
        `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }`,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, QA_WATCHDOG_SCRIPT: scriptFile },
    }
  );
  check(
    "B8: сгенерированный скрипт разбирается PowerShell",
    parse.status === 0
  );
  if (parse.status !== 0) {
    console.error(
      `B8 parse: status=${parse.status} spawnError=${parse.error?.message ?? "none"}`,
    );
    console.error((parse.stdout || "") + (parse.stderr || ""));
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// QA-D316-4: реальный прогон — хуки с PowerShell-синтаксисом должны запускаться.
// before использует '$m = ...', after — оператор '& { ... }'; оба ломались,
// пока тело писалось прямо в .cmd и разбиралось cmd.exe.
if (process.platform === "win32") {
  const hookRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qa-d316-4-hooks-"));
  const fakeBin = path.join(hookRoot, "fakebin");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "opencode.cmd"),
    "@echo off\r\nexit /b 0\r\n",
    "utf8",
  );
  const savedPath = process.env.PATH;
  process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
  try {
    await ensureWrapper();
    const taskName = "QA-D316-4 PS Hooks";
    const sanitized = "qa-d316-4-ps-hooks";
    const promptFile = await writePromptFile(taskName, "Скажи hello");
    const logFile = path.join(hookRoot, "logs", `${sanitized}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const beforeMarker = path.join(hookRoot, "before.txt");
    const afterMarker = path.join(hookRoot, "after.txt");
    const beforeScript = `$m = '${beforeMarker}'; 'before-ps' | Set-Content -LiteralPath $m`;
    const afterScript = `& { 'after-ps' | Set-Content -LiteralPath '${afterMarker}' }`;
    const wrapperPath = await writeWrapperCmd(
      sanitized,
      taskName,
      promptFile,
      60,
      lockFilePath(taskName),
      hookRoot,
      logFile,
      undefined,
      undefined,
      undefined,
      beforeScript,
      afterScript,
    );
    const run = spawnSync("cmd.exe", ["/c", wrapperPath], {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
      windowsHide: true,
    });
    check(
      "QA-D316-4: before-хук с PS-синтаксисом создал маркер",
      fs.existsSync(beforeMarker),
      `status=${run.status}`
    );
    check(
      "QA-D316-4: after-хук с оператором & создал маркер",
      fs.existsSync(afterMarker),
      `status=${run.status}`
    );
    check(
      "QA-D316-4: обёртка с PS-хуками завершилась exit 0",
      run.status === 0,
      `status=${run.status}; stderr=${(run.stderr || "").slice(-300)}`
    );
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(hookRoot, { recursive: true, force: true });
  }
}

// QA-D316-5: таблица вердиктов записи — idle-финализация с артефактами больше
// не error, но полностью пустой прогон остаётся error (PL-160).
const verdictCases = [
  {
    name: "idle + артефакты без гейта → partial (PL-134)",
    input: {
      timedOut: false,
      exitCode: 1,
      gatePassed: false,
      gateEvaluated: false,
      agentExitCode: 1,
      idleCompleted: true,
      workCompleted: true,
    },
    expect: (v) =>
      v.status === "partial" &&
      v.reason.startsWith("PL-134:") &&
      v.normalizedExitCode === 0,
  },
  {
    name: "idle без артефактов с гейтом → error (PL-160)",
    input: {
      timedOut: false,
      exitCode: 0,
      gatePassed: true,
      agentExitCode: 1,
      idleCompleted: true,
      workCompleted: false,
    },
    expect: (v) => v.status === "error" && v.reason.startsWith("PL-160:"),
  },
  {
    name: "idle без артефактов без гейта → error",
    input: {
      timedOut: false,
      exitCode: 1,
      gatePassed: false,
      gateEvaluated: false,
      agentExitCode: 1,
      idleCompleted: true,
      workCompleted: false,
    },
    expect: (v) => v.status === "error",
  },
  {
    name: "gate=pass после watchdog → success (PL-128)",
    input: { timedOut: false, exitCode: 124, gatePassed: true },
    expect: (v) =>
      v.status === "success" &&
      v.reason.startsWith("PL-128:") &&
      v.normalizedExitCode === 0,
  },
  {
    name: "idle + артефакты + gate=pass → partial (QA-D316-10)",
    input: {
      timedOut: false,
      exitCode: 0,
      gatePassed: true,
      agentExitCode: 1,
      idleCompleted: true,
      workCompleted: true,
    },
    expect: (v) =>
      v.status === "partial" &&
      v.reason.startsWith("PL-134:") &&
      v.normalizedExitCode === 0,
  },
];
for (const item of verdictCases) {
  const verdict = resolveWrapperRecordVerdict(item.input);
  check(`QA-D316-5: ${item.name}`, item.expect(verdict), JSON.stringify(verdict));
}

// QA-D316-5: grace-окно применяется только при изменённых артефактах.
const winPlain = resolveCompletionIdleWindow({
  idleSec: 60,
  graceSec: 0,
  artifactsChangedRecently: true,
});
const winGrace = resolveCompletionIdleWindow({
  idleSec: 60,
  graceSec: 30,
  artifactsChangedRecently: true,
});
const winNoArtifacts = resolveCompletionIdleWindow({
  idleSec: 60,
  graceSec: 30,
  artifactsChangedRecently: false,
});
const winNegative = resolveCompletionIdleWindow({
  idleSec: 60,
  graceSec: -5,
  artifactsChangedRecently: true,
});
check(
  "QA-D316-5: grace=0 не меняет окно простоя",
  winPlain.effectiveWindowSec === 60 && winPlain.idleFrozen === false
);
check(
  "QA-D316-5: grace>0 увеличивает окно при изменённых артефактах",
  winGrace.effectiveWindowSec === 90 && winGrace.idleFrozen === true
);
check(
  "QA-D316-5: grace не применяется без изменения артефактов",
  winNoArtifacts.effectiveWindowSec === 60 && winNoArtifacts.idleFrozen === false
);
check(
  "QA-D316-5: отрицательный grace ограничен минимумом 0",
  winNegative.effectiveWindowSec === 60 && winNegative.graceSec === 0
);

check(
  "QA-D316-5: переменная AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC читается с минимумом 0",
  WRAPPER_SCRIPT.includes("AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC") &&
    /\[Math\]::Max\(0, \[int\]\$env:AGENT_STEWARD_COMPLETION_IDLE_GRACE_SEC\)/.test(
      WRAPPER_SCRIPT
    )
);
check(
  "QA-D316-5: grace и рабочая папка передаются в idle-watcher",
  WRAPPER_SCRIPT.includes(
    "-ArgumentList $PID, $completionMarker, $idlePoll, $idleWindow, $idleGrace, $Workdir"
  )
);
check(
  "QA-D316-5: watcher сравнивает git status/diff и файлы reports",
  WRAPPER_SCRIPT.includes("Get-CompletionArtifactStamp") &&
    WRAPPER_SCRIPT.includes("status --porcelain --untracked-files=all") &&
    WRAPPER_SCRIPT.includes("diff --stat") &&
    WRAPPER_SCRIPT.includes("Get-ChildItem -LiteralPath $reportDir")
);
check(
  "QA-D316-5: счётчик простоя замораживается, окно растёт на graceTicks",
  WRAPPER_SCRIPT.includes("if ($recentArtifacts) {") &&
    WRAPPER_SCRIPT.includes(
      "$maxIdle = $baseMaxIdle + $(if ($recentArtifacts) { $graceTicks } else { 0 })"
    )
);
check(
  "QA-D316-5: PowerShell-вердикт возвращает partial с причиной PL-134",
  WRAPPER_SCRIPT.includes('Status = "partial"') &&
    WRAPPER_SCRIPT.includes(
      "PL-134: артефакты сохранены, финализация прервана сторожем простоя"
    )
);
check(
  "QA-D316-10: пройденный гейт при PL-134 объявляется недоверенным",
  WRAPPER_SCRIPT.includes(
    "$script:childIdleCompleted -and $script:agentArtifactPresent -and $gatePassed -eq $true"
  ) &&
    WRAPPER_SCRIPT.includes("$gatePassed = $false") &&
    WRAPPER_SCRIPT.includes("QA-D316-10: PL-134 прервал финализацию")
);

console.log(`\n${passed}/${results.length} проверок сторожа пройдено.`);
process.exit(failed === 0 ? 0 : 1);
