import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR, LOG_DIR, LOCK_DIR, WRAPPER_DIR, sanitizeName } from "../types.js";
import type { ScheduleGateSpec } from "./schedule-v2.js";

/**
 * Путь к единому generic-обёртке PowerShell, которая реализует запуск opencode run
 * с таймаутом и lock-логикой.
 */
const WRAPPER_FILENAME = "run-task.ps1";

/**
 * Текст PowerShell-обёртки.
 *
 * Параметры:
 *   TaskName       — имя задачи (для логов)
 *   PromptFile     — путь к файлу с промптом (читается через Get-Content -Raw)
 *   TimeoutSeconds — таймаут в секундах
 *   Model          — LLM-модель для `opencode run --model` (опционально)
 *   Workdir        — рабочая директория (опционально)
 *   WorkspaceName  — имя multi-repo workspace для git-контекста в логе
 *   LockFile       — путь к lock-файлу (удаляется в finally)
 *   BeforeScript   — pre-flight команда (ненулевой код отменяет задачу)
 *   AfterScript    — post-flight команда (выполняется даже при ошибке)
 *
 * Логика:
 *   1. Выполняет pre-flight (если задан); при ошибке задача не запускается.
 *   2. Читает промпт из файла.
 *   3. Запускает opencode run <промпт> через Start-Process (без окна консоли).
 *   4. Ждёт завершения с таймаутом.
 *   5. При таймауте — убивает процесс и дочерние процессы.
 *   6. В finally выполняет post-flight и удаляет lock-файл.
 */
export const WRAPPER_SCRIPT = `param(
    [string]$TaskName,
    [string]$PromptFile,
    [int]$TimeoutSeconds,
    [string]$Model,
    [string]$Workdir,
    [string]$WorkspaceName,
    [string]$AllowedTools,
    [string]$DeniedTools,
    [string]$LockFile,
    [string]$LogFile,
    [string]$RecorderFile,
    [string]$QualityGate,
    [string]$BeforeScript,
    [string]$AfterScript,
    [string]$EnvFile,
    [string]$SessionMode,
    [string]$SessionId,
    [int]$RetryCount = 0,
    [int]$RetryDelaySeconds = 0
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ErrorActionPreference = "Continue"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    if ($LogFile) {
        try {
            Add-Content -Path $LogFile -Value $line -Encoding utf8
        } catch {}
    }
    Write-Host $line
}

# Гарантируем существование папки для лога (на случай прямого вызова обёртки).
if ($LogFile) {
    try {
        $logDir = Split-Path -Parent $LogFile
        if ($logDir -and -not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
    } catch {}
}

Write-Log "[windows-scheduler] Запуск задачи '$TaskName'..."

$startTime = Get-Date
$script:exitCode = 0
$script:errorMessage = ""
$script:preFlightStatus = "skipped"
$script:postFlightStatus = "skipped"
$script:skipMainTask = $false
$script:lockAcquired = $false
$script:timedOut = $false
$script:attemptExitCode = 0
$startedAtIso = $startTime.ToUniversalTime().ToString("o")
$script:runId = ""

# Hotfix 1.5.3.1: блокировка ДО записи в историю. Раньше lock существовал только
# в in-process пути (LockManager/withLock), а schtasks-запуск обёртки его не
# проверял: два одновременных запуска дублировали задачу и дрались за лог.
# Атомарное создание файла (CreateNew) даёт ту же гарантию, что и Node-лок.
if ($LockFile) {
    try {
        $lockDir = Split-Path -Parent $LockFile
        if ($lockDir -and -not (Test-Path -LiteralPath $lockDir)) {
            New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
        }
        $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $lockBytes = [System.Text.Encoding]::UTF8.GetBytes($startedAtIso)
            $lockStream.Write($lockBytes, 0, $lockBytes.Length)
        } finally {
            $lockStream.Dispose()
        }
        $script:lockAcquired = $true
    } catch [System.IO.IOException] {
        # Зависший lock (старше 24 ч — как STALE_LOCK_MAX_AGE_MS) снимаем один раз,
        # иначе после аварийного завершения задача залипла бы навсегда.
        $stale = $false
        try {
            $ageMs = ((Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime).TotalMilliseconds
            if ($ageMs -gt 86400000) { $stale = $true }
        } catch {}
        if ($stale) {
            try { Remove-Item -LiteralPath $LockFile -Force } catch {}
            try {
                $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                $lockStream.Dispose()
                $script:lockAcquired = $true
            } catch {}
        }
        if (-not $script:lockAcquired) {
            Write-Log "[windows-scheduler] Запуск задачи '$TaskName' пропущен: удерживается активная блокировка."
            exit 0
        }
    } catch {
        Write-Log "[windows-scheduler] Не удалось захватить блокировку задачи '$TaskName': $_"
        exit 0
    }
}

# Crash recovery: фиксируем начало ДО pre-flight и основной задачи.
# Если процесс убьют (таймаут/KILL/перезагрузка), останется finished_at = NULL,
# и при следующем старте плагина recovery пометит запись как error.
if ($RecorderFile) {
    try {
        $startOutput = & node "$RecorderFile" --start "$TaskName" "$startedAtIso" 2>$null
        if ($LASTEXITCODE -eq 0) {
            $candidate = @($startOutput) | Select-Object -Last 1
            if ($candidate) { $script:runId = "$candidate".Trim() }
        }
    } catch {}
}

# Выполняет команду оболочки и построчно пишет её вывод в лог.
function Invoke-HookScript {
    param([string]$Command)
    $output = & cmd.exe /c $Command 2>&1
    $code = $LASTEXITCODE
    foreach ($line in @($output)) {
        Write-Log "[hook] $line"
    }
    return $code
}

# Hotfix 1.5.3.1: запуск opencode с реальным таймаутом.
# Раньше TimeoutSeconds принимался, но нигде не использовался — задача работала
# до конца, а статус 'timeout' не выставлялся никогда. Теперь параллельно
# стартует сторожевой job: по истечении лимита он помечает маркер и убивает
# дерево процессов задачи (taskkill /T), а обёртка переводит статус в 'timeout'.
function Invoke-OpenCodeOnce {
    param([string]$CommandPath, [string[]]$Arguments)

    $watch = $null
    $timeoutMarker = ""
    if ($TimeoutSeconds -gt 0) {
        $timeoutMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-timeout-" + [guid]::NewGuid().ToString("N") + ".flag")
        $watch = Start-Job -ScriptBlock {
            param([int]$RootId, [int]$Seconds, [string]$Marker)
            Start-Sleep -Seconds $Seconds
            $selfId = $PID
            $all = @()
            try { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) } catch { $all = @() }
            $targets = New-Object System.Collections.Generic.List[int]
            $queue = New-Object System.Collections.Generic.Queue[int]
            $queue.Enqueue($RootId)
            $guard = 0
            while ($queue.Count -gt 0 -and $guard -lt 2000) {
                $guard++
                $current = $queue.Dequeue()
                foreach ($p in $all) {
                    $childId = [int]$p.ProcessId
                    if ([int]$p.ParentProcessId -eq $current -and $childId -ne $selfId -and -not $targets.Contains($childId)) {
                        $targets.Add($childId)
                        $queue.Enqueue($childId)
                    }
                }
            }
            if ($targets.Count -gt 0) {
                try { Set-Content -Path $Marker -Value "timeout" -Encoding UTF8 } catch {}
                foreach ($targetId in @($targets)) {
                    try { & taskkill.exe /F /T /PID $targetId 2>$null | Out-Null } catch {}
                }
            }
        } -ArgumentList $PID, $TimeoutSeconds, $timeoutMarker
    }

    $script:timedOut = $false
    $script:attemptExitCode = 0
    try {
        if ($LogFile) {
            if ($CommandPath -like "*.ps1") {
                & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $CommandPath @Arguments *>&1 |
                    ForEach-Object { Format-LogLine $_ } |
                    Out-File -FilePath $LogFile -Append -Encoding utf8
            } else {
                & $CommandPath @Arguments *>&1 |
                    ForEach-Object { Format-LogLine $_ } |
                    Out-File -FilePath $LogFile -Append -Encoding utf8
            }
        } else {
            if ($CommandPath -like "*.ps1") {
                & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $CommandPath @Arguments *>&1 |
                    ForEach-Object { Format-LogLine $_ } |
                    Out-Host
            } else {
                & $CommandPath @Arguments *>&1 |
                    ForEach-Object { Format-LogLine $_ } |
                    Out-Host
            }
        }
        $script:attemptExitCode = $LASTEXITCODE
    } finally {
        if ($timeoutMarker -and (Test-Path -LiteralPath $timeoutMarker)) {
            $script:timedOut = $true
        }
        if ($watch) {
            Stop-Job -Job $watch -ErrorAction SilentlyContinue
            Remove-Job -Job $watch -Force -ErrorAction SilentlyContinue
        }
        if ($timeoutMarker) {
            Remove-Item -LiteralPath $timeoutMarker -Force -ErrorAction SilentlyContinue
        }
    }

    if ($script:timedOut) {
        Write-Log "[windows-scheduler] Таймаут: задача '$TaskName' превысила лимит $TimeoutSeconds с — процесс остановлен."
        $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с"
        return 124
    }
    return $script:attemptExitCode
}

# Фильтр технического шума и служебных блоков OpenCode.
# Строки ответа ИИ проходят без изменений.
#
# В TS-шаблоне обратные слэши удвоены, иначе JS съедает \s и regex ломается.
$esc = [char]27
$script:inServiceBlock = $false
$script:inComment = $false

$serviceOpen = '<\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'
$serviceClose = '<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>'
$serviceTag = '<\\s*/?\\s*(?:dcp-)?system[-_](?:reminder|update)\\b[^>]*>'

function Format-LogLine {
    param($Line)
    $text = "$Line"

    # ANSI-последовательности (цвета, управление курсором), например ESC[0m.
    $text = $text -replace "$esc\\[[0-9;?]*[A-Za-z]", ""

    # Служебные блоки, целиком уместившиеся в одной строке.
    $text = [regex]::Replace($text, "$serviceOpen.*?$serviceClose", "", "IgnoreCase")
    $text = [regex]::Replace($text, '<!--.*?-->', "", "IgnoreCase")

    # Начало многострочного служебного блока OpenCode:
    # <dcp-system-reminder> ... </dcp-system-reminder> (и <system-reminder>).
    # Блоком считаем только тег в начале строки: одиночный тег внутри текста
    # (например, ИИ упомянул его в объяснении) не должен съедать следующие строки.
    if ($text -match "^\\s*$serviceOpen") { $script:inServiceBlock = $true }
    if ($text -match '^\\s*<!--') { $script:inComment = $true }

    if ($script:inServiceBlock -or $script:inComment) {
        $closed = $false
        if ($script:inServiceBlock -and $text -match $serviceClose) {
            $script:inServiceBlock = $false
            $closed = $true
        }
        if ($script:inComment -and $text -match '-->') {
            $script:inComment = $false
            $closed = $true
        }

        if ($closed) {
            # Блок закончился в этой строке — сохраняем только хвост после тега.
            $text = ($text -split '-->|<\\s*/\\s*(?:dcp-)?system[-_](?:reminder|update)\\s*>')[-1]
        } else {
            # Внутри служебного блока — строку не пишем.
            return
        }
    }

    # Одиночные теги, оставшиеся после вывода ИИ.
    $text = [regex]::Replace($text, $serviceTag, "", "IgnoreCase")
    $text = $text.TrimEnd()

    # Технический шум вложенного powershell.exe.
    if ($text -match "NativeCommandError|CategoryInfo|FullyQualifiedErrorId|RemoteException") { return }
    if ($text -match "^At [A-Za-z]:.*:") { return }
    if ($text -match "^\\s*\\+\\s*~+\\s*$") { return }
    if (-not $text.Trim()) { return }

    return $text
}

/**
 * Пытается вытащить из лога задачи информацию о расходе токенов и стоимости.
 * OpenCode может печатать строки вида "Tokens: 1234", "Usage: 1234 tokens",
 * "cost: $0.012" и т.п. Если данные не найдены — возвращает пустые строки,
 * чтобы recorder записал поля как отсутствующие.
 */
function Get-UsageFromLog {
    param([string]$File)

    $result = @{ Tokens = ""; Cost = "" }
    if (-not $File) { return $result }

    $tail = @()
    try {
        if (Test-Path $File) {
            $tail = Get-Content -Path $File -Tail 500 -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    } catch { return $result }
    if (-not $tail) { return $result }

    $tokenPatterns = @(
        '(?i)tokens?\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*([kKmM])?',
        '(?i)(?:input|output|total)\\s+tokens?\\s*[:=]?\\s*([0-9]+(?:[.,][0-9]+)?)\\s*([kKmM])?',
        '(?i)usage[^\\r\\n]*?([0-9]+)\\s+tokens?'
    )
    $costPatterns = @(
        '(?i)(?:cost|price|стоимость)\\s*[:=]?\\s*\\$\\s*([0-9]+(?:[.,][0-9]+)?)',
        '(?i)(?:cost|price|стоимость)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)'
    )

    foreach ($line in $tail) {
        $text = "$line"

        if (-not $result.Tokens) {
            foreach ($pattern in $tokenPatterns) {
                if ($text -match $pattern) {
                    $raw = $matches[1] -replace ',', '.'
                    $value = 0.0
                    if ([double]::TryParse($raw, [ref]$value)) {
                        $suffix = ""
                        if ($matches.Count -gt 2 -and $matches[2]) {
                            $suffix = $matches[2].ToString().ToLower()
                        }
                        if ($suffix -eq 'k') { $value = $value * 1000 }
                        elseif ($suffix -eq 'm') { $value = $value * 1000000 }
                        $result.Tokens = [string]([int64][Math]::Round($value))
                    }
                    break
                }
            }
        }

        if (-not $result.Cost) {
            foreach ($pattern in $costPatterns) {
                if ($text -match $pattern) {
                    $result.Cost = $matches[1] -replace ',', '.'
                    break
                }
            }
        }
    }

    return $result
}

try {
    # Рабочая директория нужна и хукам, и основной задаче.
    if ($Workdir) {
        Set-Location $Workdir
    }

    if ($WorkspaceName) {
        $gitBranch = "-"
        $gitRemote = "-"
        try {
            $branchOut = & git -C "$Workdir" rev-parse --abbrev-ref HEAD 2>$null
            if ($LASTEXITCODE -eq 0 -and $branchOut) { $gitBranch = "$branchOut".Trim() }
        } catch {}
        try {
            $remoteOut = & git -C "$Workdir" remote get-url origin 2>$null
            if ($LASTEXITCODE -eq 0 -and $remoteOut) { $gitRemote = "$remoteOut".Trim() }
        } catch {}
        Write-Log "[workspace] name=$WorkspaceName, cwd=$Workdir, branch=$gitBranch, remote=$gitRemote"
    }

    # Спринт 29.2: права задачи передаются через OPENCODE_CONFIG_CONTENT.
    # opencode run CLI (v2.2.3) не поддерживает --allow-tool/--deny-tool, а файл
    # opencode.jsonc в Workdir мог бы перезаписать проектный конфиг.
    $toolToAction = @{
        "read" = "read"; "write" = "edit"; "edit" = "edit"; "apply_patch" = "edit"; "remove" = "edit"
        "bash" = "shell"; "shell" = "shell"; "glob" = "glob"; "grep" = "grep"
        "webfetch" = "webfetch"; "websearch" = "websearch"; "question" = "question"
        "subagent" = "subagent"; "skill" = "skill"
    }
    $defaultPermissions = @(
        @{ action = "read"; resource = "*"; effect = "allow" },
        @{ action = "edit"; resource = "*"; effect = "allow" },
        @{ action = "glob"; resource = "*"; effect = "allow" },
        @{ action = "grep"; resource = "*"; effect = "allow" },
        @{ action = "shell"; resource = "*"; effect = "allow" },
        @{ action = "subagent"; resource = "*"; effect = "allow" },
        @{ action = "skill"; resource = "*"; effect = "allow" },
        @{ action = "question"; resource = "*"; effect = "allow" },
        @{ action = "webfetch"; resource = "*"; effect = "allow" },
        @{ action = "websearch"; resource = "*"; effect = "allow" }
    )
    $permissions = @()
    foreach ($p in $defaultPermissions) { $permissions += $p }
    if ($DeniedTools) {
        $deniedList = @($DeniedTools -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
        foreach ($tool in $deniedList) {
            $action = $toolToAction[$tool]
            if ($action) {
                $idx = $permissions | Where-Object { $_.action -eq $action }
                if ($idx) { $idx.effect = "deny" }
            }
        }
    }
    if ($AllowedTools) {
        $allowedList = @($AllowedTools -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
        $allowedActions = @{}
        foreach ($tool in $allowedList) {
            $action = $toolToAction[$tool]
            if ($action) { $allowedActions[$action] = $true }
        }
        foreach ($p in $permissions) {
            if (-not $allowedActions.ContainsKey($p.action)) { $p.effect = "deny" }
        }
    }
    $config = @{ "$schema" = "https://opencode.ai/config.json"; "permissions" = $permissions }
    $env:OPENCODE_CONFIG_CONTENT = ($config | ConvertTo-Json -Depth 3 -Compress)
    Write-Log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT"

    # Pre-flight: выполняется ДО основной задачи. Ненулевой код отменяет запуск.
    if ($BeforeScript) {
        Write-Log "[windows-scheduler] Pre-flight: $BeforeScript"
        $preCode = Invoke-HookScript -Command $BeforeScript
        if ($preCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Pre-flight script failed (код $preCode)."
            $script:preFlightStatus = "error"
            $script:errorMessage = "Pre-flight script failed"
            $script:exitCode = 1
            $script:skipMainTask = $true
        } else {
            $script:preFlightStatus = "success"
            Write-Log "[windows-scheduler] Pre-flight успешно завершён."
        }
    }

    if (-not $script:skipMainTask) {
    $prompt = Get-Content -Path $PromptFile -Raw -Encoding UTF8

    # Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.
    if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
        try {
            Get-Content -Path $EnvFile -Encoding UTF8 | ForEach-Object {
                $line = $_.Trim()
                if ($line -and -not $line.StartsWith("#") -and $line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
                    Set-Item -Path ("env:" + $matches[1]) -Value $matches[2]
                }
            }
            Write-Log "[windows-scheduler] Переменные окружения workspace загружены."
        } catch {
            Write-Log "[windows-scheduler] Не удалось загрузить env-файл workspace: $($_.Exception.Message)"
        }
    }

    # Получаем путь к скрипту opencode (.ps1 или .cmd)
    $opencodeCmd = Get-Command opencode | Select-Object -ExpandProperty Source

    # Формируем аргументы для opencode run (Спринт 24: сессия).
    # Спринт 29.2: --auto автоодобряет не запрещённые права, а ограничения
    # берутся из сгенерированного opencode.jsonc в Workdir.
    $opencodeArgs = @("run", "--auto")
    if ($Model) {
        $opencodeArgs += @("--model", $Model)
    }
    if ($SessionMode -eq 'reuse' -and $SessionId) {
        $opencodeArgs += @("--session", $SessionId)
    } elseif ($SessionMode -eq 'last') {
        $opencodeArgs += @("--continue")
    }
    if ($prompt) {
        $opencodeArgs += $prompt
    }

    # Запускаем opencode и НАПРЯМУЮ направляем весь вывод (stdout + stderr) в лог.
    # Out-File -Append -Encoding utf8 пишет по мере поступления строк, поэтому
    # ответ ИИ появляется в GUI ещё до завершения задачи.
    # Hotfix 1.5.3.1: retryCount из схемы раньше нигде не применялся — теперь
    # неудачная попытка повторяется до RetryCount раз с паузой RetryDelaySeconds.
    $maxAttempts = 1 + [Math]::Max(0, $RetryCount)
    $attempt = 0
    while ($attempt -lt $maxAttempts) {
        $attempt++
        if ($attempt -gt 1) {
            $waitSeconds = [Math]::Max(0, $RetryDelaySeconds)
            Write-Log "[windows-scheduler] Повтор $($attempt - 1) из $($maxAttempts - 1) через $waitSeconds с..."
            if ($waitSeconds -gt 0) { Start-Sleep -Seconds $waitSeconds }
            $script:errorMessage = ""
        }
        $script:exitCode = Invoke-OpenCodeOnce -CommandPath $opencodeCmd -Arguments $opencodeArgs
        if ($script:exitCode -eq 0) { break }
        # Таймаут повторять бессмысленно: каждая попытка снова съест весь лимит.
        if ($script:timedOut) { break }
        if ($attempt -lt $maxAttempts) {
            Write-Log "[windows-scheduler] Попытка $attempt завершилась с кодом $($script:exitCode)."
        }
    }

    # Quality Gate: проверочная команда выполняется ТОЛЬКО после успешного
    # завершения opencode run. Если ИИ упал — шлюз не запускаем.
    if ($QualityGate -and $script:exitCode -eq 0) {
        Write-Log "[windows-scheduler] Запуск Quality Gate: $QualityGate"
        $gateOutput = & cmd.exe /c $QualityGate 2>&1
        $gateCode = $LASTEXITCODE

        if ($LogFile) {
            try {
                $gateOutput | ForEach-Object { Add-Content -Path $LogFile -Value "$_" -Encoding utf8 }
            } catch {}
        } else {
            $gateOutput | Out-Host
        }

        if ($gateCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Quality Gate провален. Код возврата: $gateCode"
            $script:errorMessage = "Quality Gate провален. Код возврата: $gateCode"
            $script:exitCode = 1
        } else {
            Write-Log "[windows-scheduler] Quality Gate пройден."
        }
    }

    if ($script:exitCode -ne 0) {
        Write-Log "[windows-scheduler] Задача '$TaskName' завершилась с кодом $script:exitCode."
    } else {
        Write-Log "[windows-scheduler] Задача '$TaskName' успешно завершена."
    }
    } # конец блока основной задачи
} catch {
    Write-Log "[windows-scheduler] Ошибка выполнения задачи '$TaskName': $_"
    $script:errorMessage = "Ошибка выполнения задачи: $_"
    $script:exitCode = 1
} finally {
    # Post-flight: выполняется ВСЕГДА, даже если основная задача упала.
    if ($AfterScript) {
        Write-Log "[windows-scheduler] Post-flight: $AfterScript"
        $postCode = Invoke-HookScript -Command $AfterScript
        if ($postCode -ne 0) {
            Write-Log "[windows-scheduler] ОШИБКА: Post-flight script failed (код $postCode)."
            $script:postFlightStatus = "error"
            if ($script:exitCode -eq 0) {
                $script:errorMessage = "Post-flight script failed"
                $script:exitCode = 1
            }
        } else {
            $script:postFlightStatus = "success"
            Write-Log "[windows-scheduler] Post-flight успешно завершён."
        }
    }

    # Фиксируем факт выполнения в историю и метрики (независимо от того, кто запустил: GUI или Windows)
    $endTime = Get-Date
    $durationMs = [int](($endTime - $startTime).TotalMilliseconds)
    # Hotfix 1.5.3.1: статус timeout теперь реально выставляется (см. Invoke-OpenCodeOnce).
    if ($script:timedOut) {
        $status = "timeout"
    } elseif ($script:exitCode -eq 0) {
        $status = "success"
    } else {
        $status = "error"
    }
    $usage = Get-UsageFromLog -File $LogFile
    $tokensArg = "-"
    if ($usage.Tokens) { $tokensArg = $usage.Tokens }
    $costArg = "-"
    if ($usage.Cost) { $costArg = $usage.Cost }
    $modelArg = "-"
    if ($Model) { $modelArg = $Model }
    # Hotfix 1.5.3.1: пустая строка ошибки раньше «съедалась» PowerShell и
    # сдвигала все следующие аргументы recorder (model получал preFlight,
    # postFlight терялся). Теперь всегда передаём непустое значение.
    $errorArg = "-"
    if ($script:errorMessage) { $errorArg = $script:errorMessage }
    if ($RecorderFile) {
        try {
            if ($script:runId) {
                & node "$RecorderFile" --finish "$script:runId" "$TaskName" "$status" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus"
            } else {
                # Fallback: --start не удался (например, старая установка) —
                # пишем завершённую запись старым способом, без потери истории.
                & node "$RecorderFile" "$TaskName" "$status" "$startedAtIso" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus"
            }
        } catch {}
    }

    # Снимаем блокировку только если мы её захватили: иначе пропущенный
    # параллельный запуск удалял бы lock активной задачи.
    if ($script:lockAcquired -and $LockFile -and (Test-Path $LockFile)) {
        try {
            Remove-Item $LockFile -Force
        } catch {}
    }
}

exit $script:exitCode
`;

/**
 * Гарантирует existence директорий плагина и записывает generic-обёртку.
 * Возвращает путь к обёртке.
 */
export async function ensureWrapper(): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const wrapperPath = path.join(WRAPPER_DIR, WRAPPER_FILENAME);
  // BOM обязателен: Windows PowerShell 5.1 читает .ps1 без BOM как ANSI,
  // из-за чего кириллица в сообщениях Write-Log превращается в мусор.
  await fs.writeFile(wrapperPath, "\uFEFF" + WRAPPER_SCRIPT, "utf8");
  return wrapperPath;
}

/**
 * Записывает промпт задачи во временный файл и возвращает его путь.
 */
export async function writePromptFile(taskName: string, prompt: string): Promise<string> {
  const promptDir = path.join(PLUGIN_DIR, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `${taskName}.txt`);
  // BOM помогает Windows PowerShell 5.1 правильно прочитать кириллицу.
  // На POSIX BOM попал бы в промпт как мусорный символ — не пишем его.
  const content = process.platform === "win32" ? "\uFEFF" + prompt : prompt;
  await fs.writeFile(promptPath, content, "utf8");
  return promptPath;
}

/**
 * Возвращает путь к lock-файлу задачи.
 */
export function lockFilePath(taskName: string): string {
  return path.join(PLUGIN_DIR, "locks", `${taskName}.lock`);
}

/**
 * Генерирует per-task .cmd-обёртку, которую schtasks вызывает через /tr.
 * Внутри .cmd — жёстко заданный вызов run-task.ps1 с задачей, промптом,
 * таймаутом и lock-файлом. schtasks получает только один путь (в кавычках),
 * поэтому спецсимволы и кириллица в аргументах больше не ломают парсинг.
 *
 * @param sanitizedName  безопасное имя для файла (латиница, цифры, -, _)
 * @param taskName       отображаемое имя задачи в taskschd.msc (как есть, может быть кириллицей)
 * @param promptFile     абсолютный путь к файлу с промптом
 * @param timeoutSeconds таймаут в секундах
 * @param lockFile       абсолютный путь к lock-файлу
 * @param workdir        рабочая директория (опционально; по умолчанию — process.cwd())
 * @param logFile        путь к файлу лога
 * @param recorderFile   путь к record-history.js (история/метрики)
 * @param qualityGate    проверочная команда Quality Gate
 * @param model          LLM-модель для `opencode run --model` (опционально)
 * @param beforeScript   pre-flight команда (опционально)
 * @param afterScript    post-flight команда (опционально)
 * @param workspaceName  имя workspace для git-контекста в логе (опционально)
 * @param allowedTools   список разрешённых инструментов (спринт 14, опционально)
 * @param deniedTools    список запрещённых инструментов (спринт 14, опционально)
 * @param scheduleGate   гейт расписания (спринт 19): проверка cron в таймзоне
 *                       и окна запуска перед стартом PowerShell-обёртки.
 * @param envFile        env-файл workspace (спринт 21, опционально)
 * @param sessionMode    режим сессии OpenCode (спринт 24): "new" (по умолчанию,
 *                       без флагов), "reuse" (--session $SessionId), "last" (--continue)
 * @param sessionId      идентификатор сессии для режима "reuse" (спринт 24, опционально)
 */
/**
 * Hotfix 1.5.3.1: хуки и Quality Gate пишутся в отдельные .cmd-файлы.
 *
 * Раньше команда передавалась аргументом в однострочный вызов powershell.exe,
 * а кавычки внутри неё заменялись на апострофы: `echo x > "C:\Program Files\out.txt"`
 * превращался в нерабочий `echo x > 'C:\Program Files\out.txt'`. Файл снимает
 * проблему целиком — внутри .cmd можно использовать любые кавычки и пайпы.
 */
async function writeHookFile(
  sanitizedName: string,
  kind: "before" | "after" | "gate",
  command: string
): Promise<string> {
  const dir = path.join(WRAPPER_DIR, "hooks");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `run-${sanitizedName}-${kind}.cmd`);
  await fs.writeFile(file, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, "utf8");
  return file;
}

export async function writeWrapperCmd(
  sanitizedName: string,
  taskName: string,
  promptFile: string,
  timeoutSeconds: number,
  lockFile: string,
  workdir?: string,
  logFile?: string,
  recorderFile?: string,
  qualityGate?: string,
  model?: string,
  beforeScript?: string,
  afterScript?: string,
  workspaceName?: string,
  allowedTools?: string[],
  deniedTools?: string[],
  scheduleGate?: ScheduleGateSpec & {
    gateFile: string;
    deferFile?: string;
    forceFile?: string;
    forceTtlMs?: number;
  },
  envFile?: string,
  sessionMode?: "new" | "reuse" | "last",
  sessionId?: string,
  retryCount?: number,
  retryDelaySeconds?: number
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const cmdPath = path.join(WRAPPER_DIR, `run-${sanitizedName}.cmd`);
  const ps1Path = path.join(WRAPPER_DIR, WRAPPER_FILENAME);

  // ВАЖНО: команда powershell.exe должна быть ОДНОЙ строкой.
  // Раньше -LogFile и -RecorderFile добавлялись отдельными строками .cmd,
  // из-за чего PowerShell их не получал, а cmd пытался выполнить их как
  // самостоятельные команды: логи оставались пустыми, история не писалась.
  const psArgs: string[] = [
    `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "${ps1Path}"`,
    `-TaskName "${taskName}"`,
    `-PromptFile "${promptFile}"`,
    `-TimeoutSeconds ${timeoutSeconds}`,
    `-LockFile "${lockFile}"`,
  ];

  // Hotfix 1.5.3.1: ретраи. Параметр не передаём при 0 — обёртка по умолчанию
  // делает ровно одну попытку, как раньше.
  const safeRetryCount = Math.max(0, Math.floor(retryCount ?? 0));
  if (safeRetryCount > 0) {
    psArgs.push(`-RetryCount ${safeRetryCount}`);
    psArgs.push(`-RetryDelaySeconds ${Math.max(0, Math.floor(retryDelaySeconds ?? 0))}`);
  }

  if (logFile) {
    psArgs.push(`-LogFile "${logFile}"`);
  }

  if (recorderFile) {
    psArgs.push(`-RecorderFile "${recorderFile}"`);
  }

  if (qualityGate?.trim()) {
    // Hotfix 1.5.3.1: команда пишется в отдельный .cmd — кавычки и пайпы
    // внутри неё больше не ломают однострочный вызов powershell.exe.
    const gateFile = await writeHookFile(sanitizedName, "gate", qualityGate);
    psArgs.push(`-QualityGate "${gateFile}"`);
  }

  if (model?.trim()) {
    const safeModel = model.replace(/[\r\n"]+/g, "").trim();
    if (safeModel) {
      psArgs.push(`-Model "${safeModel}"`);
    }
  }

  if (workspaceName?.trim()) {
    const safeWorkspace = workspaceName.replace(/[\r\n"]+/g, "'").trim();
    if (safeWorkspace) {
      psArgs.push(`-WorkspaceName "${safeWorkspace}"`);
    }
  }

  // Role-scoped tools (спринт 14): передаём списки одной строкой через запятую.
  for (const [flag, list] of [
    ["-AllowedTools", allowedTools],
    ["-DeniedTools", deniedTools],
  ] as const) {
    const joined = (Array.isArray(list) ? list : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(",");
    if (joined) {
      const safe = joined.replace(/[\r\n"]+/g, "'");
      psArgs.push(`${flag} "${safe}"`);
    }
  }

  // Hotfix 1.5.3.1: хуки — в отдельные .cmd-файлы (см. writeHookFile).
  // Раньше кавычки заменялись на апострофы, из-за чего хуки с путями в кавычках
  // (например, "C:\Program Files\...") падали.
  for (const [flag, script, kind] of [
    ["-BeforeScript", beforeScript, "before"],
    ["-AfterScript", afterScript, "after"],
  ] as const) {
    if (script?.trim()) {
      const hookFile = await writeHookFile(sanitizedName, kind, script);
      psArgs.push(`${flag} "${hookFile}"`);
    }
  }

  // Спринт 21: env-файл workspace (пары KEY=VALUE). Значения не логируются.
  if (envFile?.trim()) {
    const safeEnvFile = envFile.replace(/[\r\n"]+/g, "").trim();
    if (safeEnvFile) {
      psArgs.push(`-EnvFile "${safeEnvFile}"`);
    }
  }

  // Спринт 24: режим сессии OpenCode. sessionId передаём только для reuse.
  const safeSessionMode =
    sessionMode === "reuse" || sessionMode === "last" ? sessionMode : "new";
  if (safeSessionMode !== "new") {
    psArgs.push(`-SessionMode "${safeSessionMode}"`);
    if (safeSessionMode === "reuse") {
      const safeSessionId = (sessionId ?? "").replace(/[\r\n"]+/g, "").trim();
      if (safeSessionId) {
        psArgs.push(`-SessionId "${safeSessionId}"`);
      }
    }
  }

  const lines: string[] = ["@echo off", "chcp 65001 >nul"];

  // Рабочая директория: всегда переходим в неё ДО запуска PowerShell.
  // По умолчанию — текущая папка проекта (process.cwd()). Это критично для
  // MCP: opencode run подхватывает opencode.json из рабочей директории.
  const effectiveWorkdir = workdir?.trim() || process.cwd();
  lines.push(`cd /d "${effectiveWorkdir}"`);

  // Спринт 19: гейт расписания ДО PowerShell. Проверяет, что cron реально
  // сработал сейчас (для poll-режима и чужих таймзон), и при необходимости
  // переносит запуск до открытия окна notBefore..notAfter.
  // Exit 3 — «не сейчас», выходим тихо, не считая это запуском задачи.
  if (scheduleGate?.gateFile) {
    const gateArgs = [`node "${scheduleGate.gateFile}"`];
    if (scheduleGate.cron?.trim()) {
      gateArgs.push(`--cron "${scheduleGate.cron.replace(/[\r\n"]+/g, " ").trim()}"`);
    }
    if (scheduleGate.tz?.trim()) {
      gateArgs.push(`--tz "${scheduleGate.tz.trim()}"`);
    }
    if (scheduleGate.notBefore?.trim()) {
      gateArgs.push(`--not-before ${scheduleGate.notBefore.trim()}`);
    }
    if (scheduleGate.notAfter?.trim()) {
      gateArgs.push(`--not-after ${scheduleGate.notAfter.trim()}`);
    }
    // Спринт 27: дни недели и политика окна.
    if (Array.isArray(scheduleGate.days) && scheduleGate.days.length > 0) {
      gateArgs.push(`--days ${scheduleGate.days.join(",")}`);
    }
    if (scheduleGate.windowPolicy) {
      gateArgs.push(`--window-policy ${scheduleGate.windowPolicy}`);
    }
    if (scheduleGate.deferFile?.trim()) {
      gateArgs.push(`--defer-file "${scheduleGate.deferFile.trim()}"`);
    }
    // Маркер ручного запуска: run_task_now/файловый триггер/MCP-событие
    // создают его перед вызовом schtasks /run, чтобы gate не отсекал запуск
    // по cron. Без этого run_task_now был тихим no-op для poll-режима.
    if (scheduleGate.forceFile?.trim()) {
      gateArgs.push(`--force-file "${scheduleGate.forceFile.trim()}"`);
    }
    // append к логу задачи, чтобы перенос/пропуск был виден в истории запусков
    if (logFile?.trim()) {
      gateArgs.push(`>> "${logFile.trim()}" 2>&1`);
    }
    lines.push(gateArgs.join(" "));
    lines.push(`if "%errorlevel%"=="3" exit /b 0`);
  }

  lines.push(psArgs.join(" "));

  await fs.writeFile(cmdPath, lines.join("\r\n"), "utf8");
  return cmdPath;
}

// ---------------------------------------------------------------------------
// Маркер ручного запуска.

/** Сколько живёт маркер ручного запуска (должно совпадать с schedule-gate.ts). */
export const FORCE_FILE_TTL_MS = 2 * 60 * 1000;

/**
 * Путь к маркеру немедленного запуска задачи.
 *
 * Лежит рядом с lock-файлом и вычисляется из того же санитизированного имени,
 * поэтому обёртка (--force-file) и агент указывают на один и тот же файл.
 */
export function forceFilePath(taskName: string): string {
  return `${lockFilePath(sanitizeName(taskName))}.force`;
}

/**
 * Создаёт маркер «запустить сейчас» перед вызовом планировщика ОС.
 *
 * Зачем: для poll-режима (нестандартный cron/чужая таймзона/окно запуска)
 * обёртка всегда прогоняет schedule-gate, и ручной запуск вне cron-окна
 * молча завершался с exit 3 — инструмент рапортовал success, но задача не
 * выполнялась. Gate поглощает свежий маркер и пропускает проверку расписания.
 *
 * Маркер самоуничтожается через FORCE_FILE_TTL_MS, если задача так и не
 * стартовала (например, отключена в планировщике), чтобы не влиять на
 * последующие плановые запуски.
 */
export async function requestImmediateRun(taskName: string): Promise<string> {
  const file = forceFilePath(taskName);
  await fs.mkdir(LOCK_DIR, { recursive: true });
  await fs.writeFile(file, new Date().toISOString(), "utf8");

  const timer = setTimeout(() => {
    void fs.unlink(file).catch(() => {
      /* маркер уже поглощён gate'ом или удалён вручную */
    });
  }, FORCE_FILE_TTL_MS);
  // Таймер не должен удерживать процесс хоста.
  if (typeof timer.unref === "function") timer.unref();

  return file;
}

