import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_DIR, LOCK_DIR, WRAPPER_DIR, STALE_LOCK_MAX_AGE_MS, sanitizeName } from "../types.js";
import type { ScheduleGateSpec } from "./schedule-v2.js";
import type { TaskGuards } from "./guard.js";
import { createGateSnapshot } from "./gate-integrity.js";

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

/**
 * B6: разбор PID из lock-файла для PowerShell-обёртки.
 *
 * Формат общий с Node: `<pid>-<iso>`. Legacy-файлы тоже читаются:
 * `<iso>|<pid>` (прошлый PS) и голый `<pid>` (pid-файл bash-обёртки).
 * Обратные слэши в regex удвоены — так же, как в остальном WRAPPER_SCRIPT.
 */
export const PS_LOCK_PID_FUNCTION = `# B6: PID владельца lock-файла в любом формате (Node/PS/bash).
function Get-LockOwnerPid {
    param([string]$Content)
    $text = "$Content".Trim()
    if (-not $text) { return 0 }
    # Legacy PS: <iso>|<pid>. Проверяем ДО разбора по дефису, иначе год
    # из ISO (2026) был бы принят за PID.
    if ($text.Contains("|")) {
        $parts = $text.Split([char]124)
        $parsed = 0
        if ($parts.Count -ge 2 -and [int]::TryParse($parts[1].Trim(), [ref]$parsed) -and $parsed -gt 0) {
            return $parsed
        }
        return 0
    }
    # Голый ISO без PID (старый чужой lock) не должен давать год как PID:
    # для свежего файла это означало бы вытеснение активной блокировки.
    if ($text -match '^\\d{4}-\\d{2}-\\d{2}T') { return 0 }
    # Единый формат <pid>-<iso> и старый Node <pid>-<epoch>-<uuid>.
    if ($text -match '^(\\d+)-') { return [int]$matches[1] }
    # Голый PID (pid-файл bash-обёртки).
    if ($text -match '^\\d+$') {
        $parsed = 0
        if ([int]::TryParse($text, [ref]$parsed) -and $parsed -gt 0) { return $parsed }
        return 0
    }
    return 0
}`;

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
    # G-1.2: snapshot входов гейта, снятый при создании обёртки.
    [string]$GateSnapshotFile = "",
    # PL-47: пути, которые задача вправе изменить (из -Files afterScript).
    [string]$GateAllowPaths = "",
    [string]$BeforeScript,
    [string]$AfterScript,
    [string]$EnvFile,
    [string]$SessionMode,
    [string]$SessionId,
    [string]$SessionFile,
    # B2: параметры оставлены только для совместимости со старыми .cmd.
    # Ретраи принадлежат recorder'у — обёртка делает ровно одну попытку.
    [int]$RetryCount = 0,
    [int]$RetryDelaySeconds = 0,
    [int]$GateTimeoutSeconds = 300,
    [int]$StaleLockMaxAgeMs = 86400000,
    [string]$PermissionsB64 = "",
    [string]$PolicyB64 = "",
    [string]$ModelB64 = "",
    [string]$WorkspaceNameB64 = "",
    [string]$AllowedToolsB64 = "",
    [string]$DeniedToolsB64 = ""
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# PL-86/87: old .cmd files may not pass -Workdir. Fall back to the current
# directory so quota partial-diff never fails with a Path binding error.
if (-not $Workdir) { $Workdir = (Get-Location).Path }

$ErrorActionPreference = "Continue"

# P2-11: свободный текст (модель, имя workspace, списки инструментов) приходит
# в base64, чтобы символы подстановки PowerShell/cmd не разворачивались.
function ConvertFrom-B64Text {
    param([string]$Value)
    if (-not $Value) { return "" }
    try {
        return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Value))
    } catch {
        return ""
    }
}

if ($ModelB64) { $Model = ConvertFrom-B64Text $ModelB64 }
if ($WorkspaceNameB64) { $WorkspaceName = ConvertFrom-B64Text $WorkspaceNameB64 }
if ($AllowedToolsB64) { $AllowedTools = ConvertFrom-B64Text $AllowedToolsB64 }
if ($DeniedToolsB64) { $DeniedTools = ConvertFrom-B64Text $DeniedToolsB64 }

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


# Проверяет, что процесс с указанным PID ещё существует. Нужно для stale-lock:
# возраст файла сам по себе не говорит, что владелец мёртв (задача может идти долго).
function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { return $false }
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

${PS_LOCK_PID_FUNCTION}

# Гарантируем существование папки для лога (на случай прямого вызова обёртки).
if ($LogFile) {
    try {
        $logDir = Split-Path -Parent $LogFile
        if ($logDir -and -not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
    } catch {}
}

Write-Log "[agent-steward] Запуск задачи '$TaskName'..."

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
# PL-7.2: разделённые потоки последнего хука для структурированного журнала.
$script:lastHookStdout = ""
$script:lastHookStderr = ""
# PL-25: помощник целостности гейта и файл snapshot'а рабочего дерева.
$gateIntegrityFile = ""
if ($RecorderFile) {
    $gateIntegrityFile = Join-Path (Split-Path $RecorderFile -Parent) "gate-integrity.js"
}
$worktreeSnapshotFile = ""

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
            # B6: единый формат <pid>-<iso> — его читают Node и bash.
            # По PID отличаем живой долгий запуск от осиротевшего после kill -9.
            $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
            $lockStream.Write($lockBytes, 0, $lockBytes.Length)
        } finally {
            $lockStream.Dispose()
        }
        $script:lockAcquired = $true
    } catch [System.IO.IOException] {
        # Зависший lock снимаем только если владелец мёртв (или файл старше
        # StaleLockMaxAgeMs и PID в нём отсутствует — lock от старой версии).
        $stale = $false
        $holderPid = 0
        try {
            $holderRaw = "$(Get-Content -LiteralPath $LockFile -Raw -ErrorAction Stop)".Trim()
            # B6: понимаем и новый <pid>-<iso>, и legacy <iso>|<pid>,
            # и голый PID — иначе живой чужой lock вытеснялся по возрасту.
            $holderPid = Get-LockOwnerPid -Content $holderRaw
        } catch {}
        if ($holderPid -gt 0) {
            $stale = -not (Test-ProcessAlive -ProcessId $holderPid)
        } else {
            try {
                $ageMs = ((Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime).TotalMilliseconds
                if ($ageMs -gt $StaleLockMaxAgeMs) { $stale = $true }
            } catch {}
        }
        if ($stale) {
            # T-03: не удаляем lock напрямую. Remove-Item + CreateNew давал
            # гонку: второй воркер мог снести lock, который первый только что
            # создал, и запустить ту же задачу повторно. Атомарно уводим старый
            # файл в уникальное имя; если rename не удался — чужой lock не трогаем.
            $staleLockPath = "$LockFile.stale-$PID-$([DateTime]::UtcNow.Ticks)"
            $staleMoved = $false
            try {
                Move-Item -LiteralPath $LockFile -Destination $staleLockPath -Force -ErrorAction Stop
                $staleMoved = $true
            } catch {}
            if ($staleMoved) {
                try {
                    $lockStream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                    try {
                        $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID-$startedAtIso")
                        $lockStream.Write($lockBytes, 0, $lockBytes.Length)
                    } finally {
                        $lockStream.Dispose()
                    }
                    $script:lockAcquired = $true
                } catch {}
                try { Remove-Item -LiteralPath $staleLockPath -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
        if (-not $script:lockAcquired) {
            Write-Log "[agent-steward] Запуск задачи '$TaskName' пропущен: удерживается активная блокировка."
            exit 0
        }
    } catch {
        Write-Log "[agent-steward] Не удалось захватить блокировку задачи '$TaskName': $_"
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
# GateTimeoutSeconds ограничивает время хука: зависший pre-flight/Quality Gate
# раньше держал lock до истечения общего таймаута задачи (до 24 ч).
function Invoke-HookScript {
    param([string]$Command)
    $timeout = $GateTimeoutSeconds

    if (-not $timeout -or $timeout -le 0) {
        $output = & cmd.exe /c $Command 2>&1
        $code = $LASTEXITCODE
        # Без таймаута потоки.cmd объединены — сохраняем как stdout, stderr пуст.
        $script:lastHookStdout = (@($output) -join "\`n")
        $script:lastHookStderr = ""
        foreach ($line in @($output)) {
            Write-Log "[hook] $line"
        }
        return $code
    }

    # ВАЖНО: расширение должно быть .cmd. GetTempFileName() даёт .tmp, а
    # запуск файла .tmp через cmd.exe /c может зависнуть вместо быстрого выполнения.
    $hookFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-" + [guid]::NewGuid().ToString("N") + ".cmd")
    try {
        # Команду кладём в .cmd, чтобы кавычки/пайпы не ломали аргументы.
        $lines = @('@echo off', 'chcp 65001 >nul', $Command)
        Set-Content -LiteralPath $hookFile -Value $lines -Encoding Default
        # Не используем Start-Process с -RedirectStandardOutput/-RedirectStandardError:
        # в Windows PowerShell 5.1 такой вызов может зависнуть на закрытии потоков,
        # даже если сам хук уже завершился. Запускаем процесс напрямую и читаем
        # stdout/stderr асинхронно — это не блокирует WaitForExit(timeout).
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "cmd.exe"
        $psi.Arguments = '/c "' + $hookFile + '"'
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
        $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        $null = $proc.Start()
        $outTask = $proc.StandardOutput.ReadToEndAsync()
        $errTask = $proc.StandardError.ReadToEndAsync()
        $finished = $proc.WaitForExit([int]($timeout * 1000))
        if (-not $finished) {
            try { & taskkill.exe /F /T /PID $proc.Id 2>$null | Out-Null } catch {}
            try { $proc.WaitForExit(5000) | Out-Null } catch {}
            $code = 124
            Write-Log "[agent-steward] Таймаут хука ($timeout с): $Command"
        } else {
            try { $proc.WaitForExit() } catch {}
            $code = $proc.ExitCode
        }
        $outText = ""
        $errText = ""
        if ($outTask.Wait(5000)) { try { $outText = $outTask.Result } catch {} }
        if ($errTask.Wait(5000)) { try { $errText = $errTask.Result } catch {} }
        $script:lastHookStdout = $outText
        $script:lastHookStderr = $errText
        foreach ($text in @($outText, $errText)) {
            foreach ($line in @($text -split "\r?\n")) {
                if ($line -ne "") {
                    Write-Log "[hook] $line"
                }
            }
        }
        return $code
    } catch {
        Write-Log "[agent-steward] Не удалось выполнить хук: $_"
        return 1
    } finally {
        Remove-Item -LiteralPath $hookFile -Force -ErrorAction SilentlyContinue
    }
}

# PL-7.2: пишет отдельное событие hook.output с реальным exit code и
# разделёнными stdout/stderr. Наблюдаемость не должна ломать задачу.
function Write-HookStructuredOutput {
    param([string]$Phase, [int]$ExitCode)
    if (-not $RecorderFile) { return }
    $helper = Join-Path (Split-Path $RecorderFile -Parent) "hook-output.js"
    if (-not (Test-Path -LiteralPath $helper)) { return }
    $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-out-" + [guid]::NewGuid().ToString("N") + ".txt")
    $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-hook-err-" + [guid]::NewGuid().ToString("N") + ".txt")
    try {
        Set-Content -LiteralPath $outFile -Value ([string]$script:lastHookStdout) -Encoding UTF8
        Set-Content -LiteralPath $errFile -Value ([string]$script:lastHookStderr) -Encoding UTF8
        & node "$helper" $Phase $TaskName $ExitCode $outFile $errFile "$script:runId" 2>$null | Out-Null
    } catch {
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
}

# Hotfix 1.5.3.1: запуск opencode с реальным таймаутом.
# Раньше TimeoutSeconds принимался, но нигде не использовался — задача работала
# до конца, а статус 'timeout' не выставлялся никогда. Теперь параллельно
# стартует сторожевой job: по истечении лимита он помечает маркер и убивает
# дерево процессов задачи (taskkill /T), а обёртка переводит статус в 'timeout'.
# B8: снимок дерева процессов. CIM — основной источник; при его сбое
# пробуем старый WMI, а если и он недоступен — Get-Process/tasklist.
# Иерархию Get-Process и tasklist не отдают, поэтому при отсутствии данных
# сторож переходит в fail-closed и убивает дерево по корневому PID.
function Invoke-OpenCodeOnce {
    param([string]$CommandPath, [string[]]$Arguments)

    $watch = $null
    $timeoutMarker = ""
    # PL-51: состояние health-check лога (отдельный сторожевой job).
    $healthWatch = $null
    $healthMarker = ""
    $healthFailure = ""
    if ($TimeoutSeconds -gt 0) {
        $timeoutMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-timeout-" + [guid]::NewGuid().ToString("N") + ".flag")
        $watch = Start-Job -ScriptBlock {
            param([int]$RootId, [int]$Seconds, [string]$Marker)
            Start-Sleep -Seconds $Seconds
            $selfId = $PID
            $all = @()
            try { $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { $all = @() }
            if ($all.Count -eq 0) {
                try { $all = @(Get-WmiObject Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop) } catch { $all = @() }
            }
            $dataAvailable = $all.Count -gt 0
            $targets = New-Object System.Collections.Generic.List[int]
            if ($dataAvailable) {
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
            }
            if ($targets.Count -gt 0) {
                try { Set-Content -Path $Marker -Value "timeout" -Encoding UTF8 } catch {}
                foreach ($targetId in @($targets)) {
                    try { & taskkill.exe /F /T /PID $targetId 2>$null | Out-Null } catch {}
                }
            } elseif (-not $dataAvailable) {
                # Fail-closed: дерево построить нельзя (CIM/WMI упали, Get-Process
                # и tasklist не дают родительских связей). Помечаем таймаут и
                # убиваем всё дерево от корня, иначе задача переживёт лимит.
                try { Set-Content -Path $Marker -Value "timeout" -Encoding UTF8 } catch {}
                $listing = $false
                try {
                    if (@(tasklist.exe /FO CSV /NH 2>$null).Count -gt 0) { $listing = $true }
                } catch {}
                if (-not $listing) {
                    try {
                        if (@(Get-Process -ErrorAction Stop).Count -gt 0) { $listing = $true }
                    } catch {}
                }
                try {
                    Start-Process -FilePath "taskkill.exe" -ArgumentList @("/F", "/T", "/PID", [string]$RootId) -WindowStyle Hidden -ErrorAction Stop
                } catch {
                    if ($listing) {
                        try { & taskkill.exe /F /T /PID $RootId 2>$null | Out-Null } catch {}
                    }
                }
            }
        } -ArgumentList $PID, $TimeoutSeconds, $timeoutMarker
    }

    # PL-51: health-check лога. Некоторые модели уходят в бесконечный retry
    # (ECONNRESET / Free usage limit reached / Insufficient Balance) и висят
    # до самого TimeoutSeconds, не делая полезной работы. Сторожевой job читает
    # хвост лога и при повторяющейся ошибке пишет причину в лог, маркер и
    # завершает дерево процесса задачи — как сторож таймаута.
    # Пороги настраиваются env, по умолчанию: 15 с, 3 повтора, 40 строк.
    if ($env:AGENT_STEWARD_HEALTH_CHECK -ne "0" -and $LogFile) {
        $healthInterval = 15
        $healthThreshold = 3
        $healthTail = 40
        try {
            if ($env:AGENT_STEWARD_HEALTH_INTERVAL_SEC -match '^\\d+$') { $healthInterval = [Math]::Max(2, [int]$env:AGENT_STEWARD_HEALTH_INTERVAL_SEC) }
            if ($env:AGENT_STEWARD_HEALTH_REPEAT_THRESHOLD -match '^\\d+$') { $healthThreshold = [Math]::Max(1, [int]$env:AGENT_STEWARD_HEALTH_REPEAT_THRESHOLD) }
            if ($env:AGENT_STEWARD_HEALTH_TAIL_LINES -match '^\\d+$') { $healthTail = [Math]::Max(5, [int]$env:AGENT_STEWARD_HEALTH_TAIL_LINES) }
        } catch {}
        $healthMarker = Join-Path ([System.IO.Path]::GetTempPath()) ("sched-health-" + [guid]::NewGuid().ToString("N") + ".flag")
        $healthWatch = Start-Job -ScriptBlock {
            param([int]$RootId, [string]$Marker, [string]$LogPath, [int]$IntervalSec, [int]$Threshold, [int]$TailLines)
            $pattern = 'ECONNRESET|Free usage limit reached|Insufficient Balance|ECONNREFUSED|ETIMEDOUT'
            # Базовая линия: старые ошибки из предыдущих попыток не должны
            # убивать здоровый запуск — реагируем только на рост числа ошибок.
            $baseline = -1
            while ($true) {
                Start-Sleep -Seconds $IntervalSec
                if (-not $LogPath -or -not (Test-Path -LiteralPath $LogPath)) { continue }
                try { $tail = @(Get-Content -LiteralPath $LogPath -Tail $TailLines -ErrorAction Stop) } catch { continue }
                $bad = @($tail | Where-Object { $_ -match $pattern })
                if ($baseline -lt 0 -or $bad.Count -lt $baseline) { $baseline = $bad.Count; continue }
                if ($bad.Count -ge $baseline + $Threshold) {
                    $reason = "PL-51: модель повторяет ошибку ($($bad.Count) за последние $TailLines строк): $($bad[-1])"
                    try { Add-Content -LiteralPath $LogPath -Value "[agent-steward] $reason" -Encoding UTF8 } catch {}
                    try { Set-Content -LiteralPath $Marker -Value $reason -Encoding UTF8 } catch {}
                    try { & taskkill.exe /F /T /PID $RootId 2>$null | Out-Null } catch {}
                    break
                }
            }
        } -ArgumentList $PID, $healthMarker, $LogFile, $healthInterval, $healthThreshold, $healthTail
    }

    # QV-8: дочерний opencode run не должен загружать инструменты планировщика
    # (иначе ребёнок видит все 30 инструментов и может рекурсивно создавать задачи).
    # Маркер живёт только время запуска ИИ и восстанавливается в finally.
    $previousChildRun = $env:AGENT_STEWARD_CHILD_RUN
    $env:AGENT_STEWARD_CHILD_RUN = "1"

    $script:timedOut = $false
    $script:attemptExitCode = 0
    # Состояние фильтра лога сбрасываем на каждой попытке: иначе незакрытый
    # служебный блок из упавшего запуска «съедал» бы весь лог следующей попытки.
    $script:inServiceBlock = $false
    $script:inComment = $false
    try {
        # Живой стриминг: вывод opencode проходит через конвейер и пишется в лог
        # (Out-File -Append) или консоль (Out-Host) построчно, по мере поступления.
        # Раньше вывод сначала копился в $output и сбрасывался одним куском только
        # после завершения процесса: дашборд/get_task_logs были слепы во время
        # долгих запусков, росла память, а при kill обёртки лог терялся целиком.
        # $LASTEXITCODE после конвейера сохраняет код последней нативной команды.
        if ($LogFile) {
            if ($CommandPath -like "*.ps1") {
                & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-File -FilePath $LogFile -Append -Encoding utf8
                $script:attemptExitCode = $LASTEXITCODE
            } else {
                & $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-File -FilePath $LogFile -Append -Encoding utf8
                $script:attemptExitCode = $LASTEXITCODE
            }
        } else {
            if ($CommandPath -like "*.ps1") {
                & powershell.exe -ExecutionPolicy Bypass -NoProfile -File $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-Host
                $script:attemptExitCode = $LASTEXITCODE
            } else {
                & $CommandPath @Arguments *>&1 | ForEach-Object { Format-LogLine $_ } | Out-Host
                $script:attemptExitCode = $LASTEXITCODE
            }
        }
    } finally {
        if ($null -eq $previousChildRun) {
            Remove-Item Env:\AGENT_STEWARD_CHILD_RUN -ErrorAction SilentlyContinue
        } else {
            $env:AGENT_STEWARD_CHILD_RUN = $previousChildRun
        }
        if ($timeoutMarker -and (Test-Path -LiteralPath $timeoutMarker)) {
            $script:timedOut = $true
        }
        if ($healthMarker -and (Test-Path -LiteralPath $healthMarker)) {
            try { $healthFailure = (Get-Content -LiteralPath $healthMarker -Raw -ErrorAction Stop).Trim() } catch { $healthFailure = "модель повторяет ошибку подряд" }
        }
        if ($watch) {
            Stop-Job -Job $watch -ErrorAction SilentlyContinue
            Remove-Job -Job $watch -Force -ErrorAction SilentlyContinue
        }
        if ($healthWatch) {
            Stop-Job -Job $healthWatch -ErrorAction SilentlyContinue
            Remove-Job -Job $healthWatch -Force -ErrorAction SilentlyContinue
        }
        if ($timeoutMarker) {
            Remove-Item -LiteralPath $timeoutMarker -Force -ErrorAction SilentlyContinue
        }
        if ($healthMarker) {
            Remove-Item -LiteralPath $healthMarker -Force -ErrorAction SilentlyContinue
        }
    }

    if ($script:timedOut) {
        Write-Log "[agent-steward] Таймаут: задача '$TaskName' превысила лимит $TimeoutSeconds с — процесс остановлен."
        $script:errorMessage = "Таймаут: превышено $TimeoutSeconds с"
        return 124
    }
    if ($healthFailure) {
        Write-Log "[agent-steward] PL-51: задача '$TaskName' остановлена health-check: $healthFailure"
        $script:errorMessage = "Ошибка модели при запуске: $healthFailure"
        return 125
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

# Пытается вытащить из лога задачи информацию о расходе токенов и стоимости.
# OpenCode может печатать строки вида "Tokens: 1234", "Usage: 1234 tokens",
# "cost: $0.012" и т.п. Если данные не найдены — возвращает пустые строки,
# чтобы recorder записал поля как отсутствующие.
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

    # Шаблоны намеренно «якорные»: метка должна стоять в начале строки
    # (допускается префикс времени лога). Раньше подходило любое "token=" или
    # "cost:" внутри текста — конфиг-дампы и проза ИИ давали ложный расход.
    $prefix = '^\\s*(?:\\[[^\\]]{4,40}\\]\\s*)?'
    $tokenPatterns = @(
        ($prefix + '(?i)(?:tokens?|token\\s+usage|usage)\\s*[:=]\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b'),
        ($prefix + '(?i)(?:input|output|total)\\s+tokens?\\s*[:=]?\\s*([0-9][0-9.,]*)\\s*([kKmM])?\\b')
    )
    $costPatterns = @(
        ($prefix + '(?i)(?:cost|total\\s+cost)\\s*[:=]?\\s*\\$\\s*([0-9]+(?:[.,][0-9]+)?)'),
        ($prefix + '(?i)(?:cost|total\\s+cost)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)'),
        # QA-F.1: OpenCode печатает costUsd=0.1 / cost_usd=0.75 / cost=0.25 без
        # валютного знака. Без этих шаблонов PS-обёртка теряла стоимость, тогда
        # как TS-парсер (src/core/record-history.ts) её уже распознавал.
        ($prefix + '(?i)(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*\\$?\\s*([0-9]+(?:[.,][0-9]+)?)'),
        ($prefix + '(?i)(?:costUsd|cost_usd|cost(?:\\s*usd)?)\\s*[:=]\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:usd|\\$)')
    )

    # Идём с конца: OpenCode печатает итог последним, а более ранние строки
    # могут быть эхом промпта или промежуточной статистикой.
    for ($i = $tail.Count - 1; $i -ge 0; $i--) {
        $text = "$($tail[$i])"
        if ($text -match '(?i)opencode\\.json|OPENCODE_CONFIG') { continue }

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

        if ($result.Tokens -and $result.Cost) { break }
    }

    return $result
}

try {
    # Рабочая директория нужна и хукам, и основной задаче.
    if ($Workdir) {
        Set-Location $Workdir
    }

    # PL-25: фиксируем состояние рабочего дерева до запуска ИИ. Перед гейтом
    # сверяем его, чтобы чужие незакоммиченные правки src/ не давали ложный зелёный.
    if ($QualityGate -and $GateSnapshotFile -and $Workdir -and $gateIntegrityFile -and (Test-Path -LiteralPath $gateIntegrityFile)) {
        $worktreeSnapshotFile = [System.IO.Path]::ChangeExtension($GateSnapshotFile, ".worktree.json")
        $snapAllowArgs = @()
        if ($GateAllowPaths) { $snapAllowArgs = @("--allow", $GateAllowPaths) }
        $snapOut = & node $gateIntegrityFile worktree-snapshot --dir "$Workdir" --out "$worktreeSnapshotFile" @snapAllowArgs 2>&1
        foreach ($line in $snapOut) { Write-Log "[agent-steward] $line" }
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

    # Спринт 32 / релиз 1.6: политика прав вычисляется в TypeScript
    # (src/core/permissions.ts) и передаётся готовым JSON в base64.
    # Старые .cmd, созданные до 1.6, параметр не передают — для них остаётся
    # прежнее поведение «разрешено всё» (fallback ниже).
    $toolToAction = @{
        "read" = "read"; "write" = "edit"; "edit" = "edit"; "apply_patch" = "edit"; "remove" = "edit"
        "bash" = "shell"; "shell" = "shell"; "glob" = "glob"; "grep" = "grep"
        "webfetch" = "webfetch"; "websearch" = "websearch"; "question" = "question"
        "subagent" = "subagent"; "skill" = "skill"
    }
    if ($PermissionsB64) {
        try {
            $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PermissionsB64))
            $config = $decoded | ConvertFrom-Json
            $env:OPENCODE_CONFIG_CONTENT = ($config | ConvertTo-Json -Depth 5 -Compress)
            Write-Log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT"
        } catch {
            Write-Log "[policy] ERROR: cannot decode PermissionsB64 ($($_.Exception.Message)); falling back to legacy permissions"
            $PermissionsB64 = ""
        }
    }
    if ($PolicyB64) {
        try {
            $policyJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PolicyB64)) | ConvertFrom-Json
            $legacyFlag = ""
            if ($policyJson.legacyShell) { $legacyFlag = ", legacyShell=true" }
            Write-Log "[policy] policy=$($policyJson.policy)$legacyFlag"
            foreach ($denied in @($policyJson.denied)) {
                if ($denied.action) {
                    Write-Log "[policy] deny $($denied.action): $($denied.hint)"
                }
            }
        } catch {
            Write-Log "[policy] WARN: cannot decode PolicyB64 ($($_.Exception.Message))"
        }
    }
    if (-not $PermissionsB64) {
        # Legacy fallback для обёрток, созданных до 1.6: все action разрешены,
        # DeniedTools/AllowedTools применяются как раньше.
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
        Write-Log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT (legacy fallback)"
    }

    # Pre-flight: выполняется ДО основной задачи. Ненулевой код отменяет запуск.
    if ($BeforeScript) {
        Write-Log "[agent-steward] Pre-flight: $BeforeScript"
        $preCode = Invoke-HookScript -Command $BeforeScript
        # PL-69: Invoke-HookScript складывает потоки в $script:lastHookStderr/$script:lastHookStdout.
        $preErrorLines = @($script:lastHookStderr -split "\r?\n") | Where-Object { $_ -ne "" }
        $preStdoutLines = @($script:lastHookStdout -split "\r?\n") | Where-Object { $_ -ne "" }
        $preStderrText = (@($preErrorLines) -join " | ")
        Write-HookStructuredOutput -Phase "preFlight" -ExitCode $preCode
        if ($preCode -ne 0) {
            # PL-6.1: SilentlyContinue не гарантирует код 0 — подсказываем явный exit 0.
            Write-Log "[agent-steward] ОШИБКА: Pre-flight script failed (код $preCode). Завершите хук явным 'exit 0' (например: if (Test-Path -LiteralPath '<path>') { Remove-Item -LiteralPath '<path>' -Force }; exit 0)."
            # PL-69: реальная причина должна быть видна в get_task_logs, а не только общая фраза.
            Write-Log "[agent-steward] Pre-flight причина: command=$BeforeScript; exitCode=$preCode"
            foreach ($line in $preErrorLines) {
                Write-Log "[agent-steward] Pre-flight stderr: $line"
            }
            foreach ($line in $preStdoutLines) {
                Write-Log "[agent-steward] Pre-flight stdout: $line"
            }
            $script:preFlightStatus = "error"
            $script:errorMessage = "Pre-flight script failed (command=$BeforeScript, exitCode=$preCode; stderr=$preStderrText)"
            $script:exitCode = 1
            $script:skipMainTask = $true
        } else {
            $script:preFlightStatus = "success"
            Write-Log "[agent-steward] Pre-flight успешно завершён."
        }
    }

    if (-not $script:skipMainTask) {
    # QA-P0.2: граница реального прогона для extractLastRunLog(). Маркер пишется
    # без префикса времени и только после guard/pre-flight — отменённый запуск
    # не должен выглядеть как реальный. Лог дописывается, показываем последний сегмент.
    if ($LogFile) {
        try {
            Add-Content -Path $LogFile -Value ("[agent-steward] === Run started " + $startedAtIso + " (" + $TaskName + ") ===") -Encoding utf8
        } catch {}
    }
    $prompt = Get-Content -Path $PromptFile -Raw -Encoding UTF8

    # W-1: запуск в одноразовом git worktree — сообщаем путь агенту.
    # Переменную выставляет .cmd-обёртка после успешного создания копии.
    if ($env:AGENT_STEWARD_WORKTREE) {
        Write-Log "[agent-steward] Git worktree: $env:AGENT_STEWARD_WORKTREE (repo: $env:AGENT_STEWARD_WORKTREE_REPO)"
        $worktreeContext = "[agent-steward] Рабочая директория запуска - одноразовый git worktree: " + $env:AGENT_STEWARD_WORKTREE + [Environment]::NewLine
        $prompt = $worktreeContext + $prompt
    }

    # CreateProcess ограничивает командную строку 32767 символами, а промпт
    # передаётся opencode аргументом ($opencodeArgs += $prompt). Явная ошибка
    # понятнее, чем обрезанный/отвергнутый запуск. Основная валидация — в schedule_task.
    if ($prompt -and $prompt.Length -gt 30000) {
        throw "Промпт слишком длинный для командной строки Windows: $($prompt.Length) символов (максимум 30000). Сократите промпт."
    }

    # Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.
    if ($EnvFile -and (Test-Path -LiteralPath $EnvFile)) {
        try {
            Get-Content -Path $EnvFile -Encoding UTF8 | ForEach-Object {
                $line = $_.Trim()
                if ($line -and -not $line.StartsWith("#") -and $line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
                    $envKey = $matches[1]
                    $envValue = $matches[2]
                    # P2-21: секрет удалён/переименован — не подставляем литерал
                    # \${secret:...} агенту, а прерываем запуск с понятной ошибкой.
                    if ($envValue -match '\$\{secret:[^}]+\}') {
                        throw "Workspace '$WorkspaceName': переменная $envKey содержит неразрешённый секрет. Запуск отменён."
                    }
                    Set-Item -Path ("env:" + $envKey) -Value $envValue
                }
            }
            Write-Log "[agent-steward] Переменные окружения workspace загружены."
        } catch {
            Write-Log "[agent-steward] Не удалось загрузить env-файл workspace: $($_.Exception.Message)"
            # P2-21: ошибка конфигурации секретов должна валить задачу,
            # а не оставлять её работать без переменной окружения.
            throw
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
    if ($SessionMode -eq 'reuse') {
        # Спринт 24: актуальный id читаем из sidecar-файла — ротация сессии
        # обновляет файл, и обёртку не нужно пересоздавать.
        $effectiveSessionId = $SessionId
        if ($SessionFile -and (Test-Path -LiteralPath $SessionFile)) {
            try {
                $fromFile = (Get-Content -LiteralPath $SessionFile -Raw -ErrorAction Stop).Trim()
                if ($fromFile) { $effectiveSessionId = $fromFile }
            } catch {
                Write-Log "[agent-steward] Не удалось прочитать файл сессии: $($_.Exception.Message)"
            }
        }
        if ($effectiveSessionId) {
            $opencodeArgs += @("--session", $effectiveSessionId)
        }
    } elseif ($SessionMode -eq 'last') {
        $opencodeArgs += @("--continue")
    }
    if ($prompt) {
        # B11.1: «--» завершает разбор флагов opencode. Без него промпт,
        # начинающийся с «-», CLI принял бы за неизвестный флаг.
        $opencodeArgs += @("--", $prompt)
    }

    # Запускаем opencode и НАПРЯМУЮ направляем весь вывод (stdout + stderr) в лог.
    # Out-File -Append -Encoding utf8 пишет по мере поступления строк, поэтому
    # ответ ИИ появляется в GUI ещё до завершения задачи.
    # B2: обёртка делает РОВНО одну попытку. Повторы — зона recorder'а
    # (retryCount/retryDelay в БД), иначе на Windows получалось (1+N)^2
    # запусков: N попыток внутри обёртки × N+1 запуск из recorder'а.
    # Параметры -RetryCount/-RetryDelaySeconds принимаются, но игнорируются.
    $script:exitCode = Invoke-OpenCodeOnce -CommandPath $opencodeCmd -Arguments $opencodeArgs

    # PL-83: исчерпание квоты/баланса модели — отдельный класс ошибки, а не
    # обычный «Код возврата 1». Иначе гейт и afterScript пропускаются, а частично
    # изменённое дерево остаётся без артефакта и без понятной подсказки.
    if ($script:exitCode -ne 0 -and $LogFile -and (Test-Path -LiteralPath $LogFile)) {
        $quotaLine = @()
        try {
            $quotaLine = @(Get-Content -LiteralPath $LogFile -Tail 80 -ErrorAction Stop |
                Where-Object { $_ -match 'Free usage limit reached|Insufficient Balance|free usage limit' } |
                Select-Object -Last 1)
        } catch {}
        if ($quotaLine.Count -gt 0) {
            $quotaReason = [string]$quotaLine[0]
            $quotaSlug = $TaskName -replace '[^a-zA-Z0-9_-]', '-'
            $quotaDiff = ""
            try {
                $quotaBase = $Workdir
                if (-not $quotaBase) { $quotaBase = (Get-Location).Path }
                $quotaDiff = Join-Path $quotaBase ("reports/quota-" + $quotaSlug + ".diff")
            } catch {}
            if (-not $quotaDiff) {
                $quotaDiff = Join-Path ([System.IO.Path]::GetTempPath()) ("quota-" + $quotaSlug + ".diff")
            }
            try {
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $quotaDiff) | Out-Null
                & git -C $Workdir diff > $quotaDiff 2>&1
            } catch {}
            Write-Log "[agent-steward] PL-83: квота модели исчерпана: $quotaReason"
            $modelHint = ""
            if ($Model) { $modelHint = " Текущая модель задачи: $Model." }
            $script:errorMessage = "PL-83: квота модели исчерпана ($quotaReason). Частичные правки сохранены в $quotaDiff. Перезапустите задачу с другой моделью: update_task name=$TaskName model=provider/model$modelHint"
            $script:exitCode = 126
        }
    }

    # Quality Gate: проверочная команда выполняется ТОЛЬКО после успешного
    # завершения opencode run. Если ИИ упал — шлюз не запускаем.
    if ($QualityGate -and $script:exitCode -eq 0) {
        # G-1.2: перед запуском гейта сверяем его входы со snapshot'ом,
        # снятым при создании задачи. При расхождении гейт НЕ выполняется.
        $gateIntegrityOk = $false
        if ($GateSnapshotFile -and (Test-Path -LiteralPath $GateSnapshotFile)) {
            if (Test-Path -LiteralPath $gateIntegrityFile) {
                $verifyOutput = & node $gateIntegrityFile verify --snapshot "$GateSnapshotFile" --gate-file "$QualityGate" --prompt-file "$PromptFile" --timeout $GateTimeoutSeconds 2>&1
                $verifyCode = $LASTEXITCODE
                foreach ($line in $verifyOutput) { Write-Log "[agent-steward] $line" }
                if ($verifyCode -eq 0) {
                    $gateIntegrityOk = $true
                } else {
                    Write-Log "[agent-steward] ОШИБКА: целостность входов Quality Gate нарушена (snapshot mismatch)."
                    $script:errorMessage = "Quality Gate: целостность входов нарушена (snapshot mismatch)"
                    $script:exitCode = 1
                }
            } else {
                Write-Log "[agent-steward] ОШИБКА: не найден помощник проверки целостности гейта."
                $script:errorMessage = "Quality Gate: помощник проверки целостности не найден"
                $script:exitCode = 1
            }
        } else {
            Write-Log "[agent-steward] ОШИБКА: snapshot гейта отсутствует — запуск с гейтом невозможен."
            $script:errorMessage = "Quality Gate: snapshot входов отсутствует"
            $script:exitCode = 1
        }

        if ($gateIntegrityOk -and $worktreeSnapshotFile -and (Test-Path -LiteralPath $worktreeSnapshotFile)) {
            $verifyAllowArgs = @()
            if ($GateAllowPaths) { $verifyAllowArgs = @("--allow", $GateAllowPaths) }
            $worktreeOut = & node $gateIntegrityFile worktree-verify --dir "$Workdir" --snapshot "$worktreeSnapshotFile" @verifyAllowArgs 2>&1
            $worktreeCode = $LASTEXITCODE
            foreach ($line in $worktreeOut) { Write-Log "[agent-steward] $line" }
            if ($worktreeCode -ne 0) {
                $gateIntegrityOk = $false
                Write-Log "[agent-steward] ОШИБКА: рабочее дерево изменилось во время прогона — гейт не доверяем."
                $script:errorMessage = "Quality Gate: рабочее дерево изменилось во время прогона"
                $script:exitCode = 1
            }
        }

        if ($gateIntegrityOk) {
            Write-Log "[agent-steward] Запуск Quality Gate: $QualityGate"
            # Тот же таймаут, что у хуков: зависший gate не должен держать lock.
            $gateCode = Invoke-HookScript -Command $QualityGate

            if ($gateCode -eq 124) {
                Write-Log "[agent-steward] ОШИБКА: Quality Gate превысил таймаут $GateTimeoutSeconds с и был остановлен."
                $script:errorMessage = "Quality Gate: превышен таймаут $GateTimeoutSeconds с"
                $script:exitCode = 1
            } elseif ($gateCode -ne 0) {
                Write-Log "[agent-steward] ОШИБКА: Quality Gate провален. Код возврата: $gateCode"
                $script:errorMessage = "Quality Gate провален. Код возврата: $gateCode"
                $script:exitCode = 1
            } else {
                Write-Log "[agent-steward] Quality Gate пройден."
            }
        }
    }

    if ($script:exitCode -ne 0) {
        # Раньше пустое errorMessage превращалось в "-" в истории: причина
        # падения терялась (например, при отказе модели до вывода в лог).
        if (-not $script:errorMessage) {
            $script:errorMessage = "Код возврата $($script:exitCode)"
        }
        Write-Log "[agent-steward] ОШИБКА: задача '$TaskName' завершилась с кодом $($script:exitCode). $script:errorMessage"
    } else {
        Write-Log "[agent-steward] Задача '$TaskName' успешно завершена."
    }
    } # конец блока основной задачи
} catch {
    Write-Log "[agent-steward] Ошибка выполнения задачи '$TaskName': $_"
    $script:errorMessage = "Ошибка выполнения задачи: $_"
    $script:exitCode = 1
} finally {
    # Post-flight: выполняется ВСЕГДА, даже если основная задача упала.
    if ($AfterScript) {
        Write-Log "[agent-steward] Post-flight: $AfterScript"
        $postCode = Invoke-HookScript -Command $AfterScript
        Write-HookStructuredOutput -Phase "postFlight" -ExitCode $postCode
        if ($postCode -ne 0) {
            Write-Log "[agent-steward] ОШИБКА: Post-flight script failed (код $postCode)."
            $script:postFlightStatus = "error"
            if ($script:exitCode -eq 0) {
                $script:errorMessage = "Post-flight script failed"
                $script:exitCode = 1
            }
        } else {
            $script:postFlightStatus = "success"
            Write-Log "[agent-steward] Post-flight успешно завершён."
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
                & node "$RecorderFile" --finish "$script:runId" "$TaskName" "$status" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus" "$LogFile"
            } else {
                # Fallback: --start не удался (например, старая установка) —
                # пишем завершённую запись старым способом, без потери истории.
                & node "$RecorderFile" "$TaskName" "$status" "$startedAtIso" $durationMs "$errorArg" $tokensArg $costArg "$modelArg" "$script:preFlightStatus" "$script:postFlightStatus" "$LogFile"
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
 *
 * Имя санитизируется внутри функции, а не только у вызывающей стороны:
 * defence-in-depth против path traversal, если taskName когда-либо придёт
 * из недоверенного источника (импорт, шаблон, RPC).
 */
export async function writePromptFile(taskName: string, prompt: string): Promise<string> {
  const promptDir = path.join(PLUGIN_DIR, "prompts");
  await fs.mkdir(promptDir, { recursive: true });
  const promptPath = path.join(promptDir, `${sanitizeName(taskName)}.txt`);
  // BOM помогает Windows PowerShell 5.1 правильно прочитать кириллицу.
  // На POSIX BOM попал бы в промпт как мусорный символ — не пишем его.
  const content = process.platform === "win32" ? "\uFEFF" + prompt : prompt;
  await fs.writeFile(promptPath, content, "utf8");
  return promptPath;
}

/**
 * Возвращает путь к lock-файлу задачи.
 *
 * Как и writePromptFile, санитизирует имя внутри: без этого значение с `../`
 * могло бы создать lock вне каталога locks.
 */
export function lockFilePath(taskName: string): string {
  return path.join(PLUGIN_DIR, "locks", `${sanitizeName(taskName)}.lock`);
}

/**
 * PL-47: извлекает список `-Files "a;b"` из PowerShell afterScript; возвращает
 * строку `a|b` для gate-integrity. Возвращает "", если afterScript не коммитит
 * через pl-commit.ps1 (тогда гейт работает по старой схеме).
 */
export function gateAllowPathsFromAfterScript(afterScript?: string): string {
  if (!afterScript) return "";
  const match = /-Files\s+"([^"]+)"/i.exec(afterScript);
  if (!match) return "";
  return match[1]
    .split(";")
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean)
    .join("|");
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
  command: string,
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
  gateTimeoutSeconds?: number,
  permissionsConfig?: string,
  policyMeta?: unknown,
  sessionFile?: string,
  /** W-1: запустить задачу в одноразовом git worktree. */
  worktree?: boolean,
  /** Путь к dist/core/worktree-run.js (обязателен при worktree=true). */
  worktreeHelperFile?: string,
  /** W-3: guard-условия перед запуском opencode. */
  guards?: TaskGuards,
  /** Путь к dist/core/guard-run.js (обязателен при guards). */
  guardHelperFile?: string,
  /** PL-47: RELATIVE-пути, которые задача вправе изменить (из -Files). */
  gateAllowPaths?: string,
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const cmdPath = path.join(WRAPPER_DIR, `run-${sanitizedName}.cmd`);
  const ps1Path = path.join(WRAPPER_DIR, WRAPPER_FILENAME);

  // ВАЖНО: команда powershell.exe должна быть ОДНОЙ строкой.
  // Раньше -LogFile и -RecorderFile добавлялись отдельными строками .cmd,
  // из-за чего PowerShell их не получал, а cmd пытался выполнить их как
  // самостоятельные команды: логи оставались пустыми, история не писалась.
  // PL-86: рабочая директория нужна и .cmd (cd /d), и PowerShell-обёртке
  // (-Workdir): без неё квота/partial-diff не знает, где искать reports/ и git.
  // Вычисляем заранее и экранируем так же, как остальные пути-аргументы.
  const effectiveWorkdir = workdir?.trim() || process.cwd();
  const safeWorkdir = effectiveWorkdir.replace(/[\r\n\0"]+/g, "").trim();

  const psArgs: string[] = [
    `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "${ps1Path}"`,
    `-TaskName "${taskName}"`,
    `-PromptFile "${promptFile}"`,
    `-TimeoutSeconds ${timeoutSeconds}`,
    `-LockFile "${lockFile}"`,
    `-StaleLockMaxAgeMs ${STALE_LOCK_MAX_AGE_MS}`,
    `-Workdir "${safeWorkdir}"`,
  ];

  // Таймаут хуков/Quality Gate: 300 с по умолчанию, 0 — без ограничения.
  const safeGateTimeout =
    typeof gateTimeoutSeconds === "number" && Number.isFinite(gateTimeoutSeconds)
      ? Math.max(0, Math.floor(gateTimeoutSeconds))
      : 300;
  psArgs.push(`-GateTimeoutSeconds ${safeGateTimeout}`);

  // B2: ретраи сознательно не передаются в обёртку — единственный владелец
  // повторов это recorder (retryCount/retryDelay), иначе на Windows получается
  // (1+N)^2 запусков. Старые .cmd с -RetryCount продолжают работать: параметр
  // принимается, но игнорируется.

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

    // G-1.2: фиксируем входы гейта до первого запуска. Snapshot лежит в
    // PLUGIN_DIR, вне рабочей директории задачи.
    let prompt = "";
    let hook = qualityGate;
    try {
      prompt = await fs.readFile(promptFile, "utf8");
    } catch {
      // Промпт мог быть уже удалён — уникальность snapshot от этого не страдает.
    }
    try {
      hook = await fs.readFile(gateFile, "utf8");
    } catch {
      // Используем исходную команду, если прочитать хук не удалось.
    }
    const snapshotFile = createGateSnapshot(taskName, {
      gate: hook,
      prompt,
      gateTimeoutSeconds: safeGateTimeout,
    });
    psArgs.push(`-GateSnapshotFile "${snapshotFile}"`);
    const safeAllow = (gateAllowPaths ?? "").replace(/[\r\n"]+/g, "").trim();
    if (safeAllow) psArgs.push(`-GateAllowPaths "${safeAllow}"`);
  }

  if (model?.trim()) {
    const safeModel = model.replace(/[\r\n"]+/g, "").trim();
    if (safeModel) {
      const modelB64 = Buffer.from(safeModel, "utf8").toString("base64");
      psArgs.push(`-ModelB64 "${modelB64}"`);
    }
  }

  if (workspaceName?.trim()) {
    const workspaceB64 = Buffer.from(workspaceName.trim(), "utf8").toString("base64");
    psArgs.push(`-WorkspaceNameB64 "${workspaceB64}"`);
  }

  // Role-scoped tools (спринт 14): передаём списки одной строкой через запятую.
  for (const [flag, list] of [
    ["-AllowedToolsB64", allowedTools],
    ["-DeniedToolsB64", deniedTools],
  ] as const) {
    const joined = (Array.isArray(list) ? list : [])
      .map((item) => String(item).trim())
      .filter(Boolean)
      .join(",");
    if (joined) {
      const b64 = Buffer.from(joined, "utf8").toString("base64");
      psArgs.push(`${flag} "${b64}"`);
    }
  }

  // Спринт 32: готовый JSON политики и метаданные для лога — в base64.
  // Base64 не содержит кавычек и переводов строк, поэтому безопасен для .cmd.
  if (permissionsConfig) {
    const b64 = Buffer.from(permissionsConfig, "utf8").toString("base64");
    psArgs.push(`-PermissionsB64 "${b64}"`);
  }
  if (policyMeta) {
    const b64 = Buffer.from(JSON.stringify(policyMeta), "utf8").toString("base64");
    psArgs.push(`-PolicyB64 "${b64}"`);
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
      if (sessionFile?.trim()) {
        const safeSessionFile = sessionFile.replace(/[\r\n"]+/g, "").trim();
        if (safeSessionFile) {
          psArgs.push(`-SessionFile "${safeSessionFile}"`);
        }
      }
    }
  }

  const lines: string[] = ["@echo off", "chcp 65001 >nul"];

  // Рабочая директория: всегда переходим в неё ДО запуска PowerShell.
  // По умолчанию — текущая папка проекта (process.cwd()). Это критично для
  // MCP: opencode run подхватывает opencode.json из рабочей директории.
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
    lines.push("if \"%errorlevel%\"==\"3\" exit /b 0");
  }

  // W-1 (0.0.6): одноразовый git worktree. Создаётся после гейта расписания,
  // чтобы пропущенный тик не плодил рабочие копии. Ошибка создания — fail-closed:
  // задача не должна молча работать в основном дереве.
  let wtHelper = "";
  let wtRepo = "";
  let wtLogRedirect = "";
  if (worktree) {
    wtHelper = (worktreeHelperFile ?? "").replace(/[\r\n"]+/g, "").trim();
    wtRepo = effectiveWorkdir.replace(/[\r\n"]+/g, "").trim();
    const safeTaskName = taskName.replace(/[\r\n"]+/g, "").trim();
    wtLogRedirect = logFile?.trim() ? `>> "${logFile.trim()}" 2>&1` : "";
    const helperErr = logFile?.trim() ? `2>> "${logFile.trim()}"` : "";
    lines.push('set "AGENT_STEWARD_WORKTREE="');
    lines.push(
      `for /f "usebackq delims=" %%W in (\`node "${wtHelper}" --repo "${wtRepo}" --task "${safeTaskName}" ${helperErr}\`) do set "AGENT_STEWARD_WORKTREE=%%W"`,
    );
    lines.push("if not defined AGENT_STEWARD_WORKTREE (");
    lines.push(`  echo [agent-steward] ERROR: git worktree creation failed ${wtLogRedirect}`);
    lines.push("  exit /b 1");
    lines.push(")");
    lines.push('cd /d "%AGENT_STEWARD_WORKTREE%"');
    lines.push(`set "AGENT_STEWARD_WORKTREE_REPO=${wtRepo}"`);
  }

  // W-3 (0.0.6): guard-условия до запуска opencode. Код 4 — штатный skip,
  // любой другой ненулевой код — ошибка проверки; в обоих случаях opencode
  // не запускается. Созданный worktree сразу убираем, чтобы не оставлять мусор.
  if (guards) {
    const guardHelper = (guardHelperFile ?? "").replace(/[\r\n"]+/g, "").trim();
    const guardB64 = Buffer.from(JSON.stringify(guards), "utf8").toString("base64");
    const skipTaskName = taskName.replace(/[\r\n"]+/g, "").trim();
    const skipRecorder = (recorderFile ?? "").replace(/[\r\n"]+/g, "").trim();
    const skipReasonB64 = Buffer.from("guard conditions not met", "utf8").toString("base64");
    const guardLog = logFile?.trim() ? `1>> "${logFile.trim()}" 2>&1` : "";
    const guardLogAppend = logFile?.trim() ? `>> "${logFile.trim()}" 2>&1` : "";
    const pushWorktreeCleanup = () => {
      if (!worktree) return;
      lines.push(`  cd /d "${wtRepo}"`);
      lines.push(
        `  node "${wtHelper}" cleanup --path "%AGENT_STEWARD_WORKTREE%" --repo "${wtRepo}" ${wtLogRedirect}`,
      );
    };
    lines.push(`node "${guardHelper}" --cwd "%CD%" --guards-b64 "${guardB64}" ${guardLog}`);
    lines.push('set "AGENT_STEWARD_GUARD_STATUS=%errorlevel%"');
    lines.push('if "%AGENT_STEWARD_GUARD_STATUS%"=="4" (');
    lines.push(`  echo [agent-steward] guard: run skipped ${guardLogAppend}`);
    // W-4: пишем skipped в историю/метрики. Причина фиксированная (в базе),
    // подробности guard-проверки остаются в логе задачи.
    if (skipRecorder) {
      lines.push(
        `  node "${skipRecorder}" --skip "${skipTaskName}" "${skipReasonB64}" ${guardLogAppend}`,
      );
    }
    pushWorktreeCleanup();
    lines.push("  exit /b 0");
    lines.push(")");
    lines.push('if not "%AGENT_STEWARD_GUARD_STATUS%"=="0" (');
    lines.push(
      `  echo [agent-steward] ERROR: guard failed with code %AGENT_STEWARD_GUARD_STATUS% ${guardLogAppend}`,
    );
    pushWorktreeCleanup();
    lines.push("  exit /b 1");
    lines.push(")");
  }

  lines.push(psArgs.join(" "));

  // W-2.1: удаляем одноразовый worktree после прогона при любом коде возврата.
  // Сначала выходим из него (Windows не даёт удалить текущий каталог), затем
  // возвращаем исходный код задачи — ошибка очистки не маскирует результат.
  if (worktree) {
    lines.push('set "AGENT_STEWARD_EXIT_CODE=%errorlevel%"');
    lines.push(`cd /d "${wtRepo}"`);
    lines.push(
      `node "${wtHelper}" cleanup --path "%AGENT_STEWARD_WORKTREE%" --repo "${wtRepo}" ${wtLogRedirect}`,
    );
    lines.push("exit /b %AGENT_STEWARD_EXIT_CODE%");
  }

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
  return `${lockFilePath(taskName)}.force`;
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

