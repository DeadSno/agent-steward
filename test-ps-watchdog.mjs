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

const { WRAPPER_SCRIPT } = await import("./dist/core/ps-wrapper.js");

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

// Синтаксис сгенерированного скрипта: powershell.exe должен разобрать его без ошибок.
if (process.platform === "win32") {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-watchdog-"));
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

console.log(`\n${passed}/${results.length} проверок сторожа пройдено.`);
process.exit(failed === 0 ? 0 : 1);
