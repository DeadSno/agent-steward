import fs from "node:fs/promises";
import path from "node:path";
import { WRAPPER_DIR } from "../../types.js";
import { shellQuote } from "../scheduler/posix.js";
import type { ScheduleGateSpec } from "../schedule-v2.js";

/** Параметры генерации bash-обёртки. */
export interface BashWrapperOptions {
  /** Безопасное имя для файла (латиница, цифры, -, _). */
  sanitizedName: string;
  /** Отображаемое имя задачи (может быть кириллицей). */
  taskName: string;
  /** Абсолютный путь к файлу с промптом. */
  promptFile: string;
  /** Таймаут в секундах (0 — без таймаута). */
  timeoutSeconds: number;
  /** Абсолютный путь к lock-файлу (рядом создаётся каталог <lock>.d). */
  lockFile: string;
  /** Рабочая директория задачи. */
  workdir?: string;
  /** Имя multi-repo workspace (для git-контекста в логе). */
  workspaceName?: string;
  /** Разрешённые инструменты (спринт 14, metadata-only). */
  allowedTools?: string[];
  /** Запрещённые инструменты (спринт 14, metadata-only). */
  deniedTools?: string[];
  /** Путь к файлу лога. */
  logFile?: string;
  /** Путь к скомпилированному record-history.js. */
  recorderFile?: string;
  /** Проверочная команда Quality Gate. */
  qualityGate?: string;
  /** LLM-модель для `opencode run --model` (если не задана — модель по умолчанию). */
  model?: string;
  /** Спринт 24: режим сессии — "new" | "reuse" | "last". */
  sessionMode?: import("../session.js").SessionMode;
  /** Спринт 24: id сессии для режима "reuse". */
  sessionId?: string;
  /** Pre-flight команда: ненулевой код отменяет запуск задачи. */
  beforeScript?: string;
  /** Post-flight команда: выполняется даже при ошибке основной задачи. */
  afterScript?: string;
  /**
   * Команда самоочистки one-shot (например, выгрузка launchd-агента).
   * Запускается в фоне после записи истории и не влияет на код возврата.
   */
  oneShotCleanupCommand?: string;
  /**
   * Гейт расписания (спринт 19): проверка cron в таймзоне задачи и окна
   * запуска выполняется до lock и запуска opencode.
   */
  scheduleGate?: ScheduleGateSpec & {
    gateFile: string;
    deferFile?: string;
    forceFile?: string;
  };
  /**
   * Спринт 21: путь к env-файлу workspace (пары KEY=VALUE). Значения
   * подгружаются перед запуском opencode и никогда не пишутся в лог.
   */
  envFile?: string;
  /**
   * Таймаут pre-flight/Quality Gate/post-flight в секундах (по умолчанию 300).
   * 0 — без таймаута. Зависший хук не должен держать lock.
   */
  gateTimeoutSeconds?: number;
}

/**
 * Собирает текст bash-обёртки.
 *
 * Скрипт:
 *  1. выставляет PATH (важно для cron, где окружение минимальное);
 *  2. берёт атомарный lock через `mkdir` (аналог 'wx' в Node);
 *  3. переходит в рабочую директорию проекта;
 *  4. выполняет pre-flight (если задан) — при ошибке задача отменяется;
 *  5. запускает `opencode run <промпт>` с перенаправлением вывода в лог;
 *  6. по таймауту завершает процесс;
 *  7. выполняет Quality Gate (если задан);
 *  8. выполняет post-flight (если задан) — даже при ошибке задачи;
 *  9. пишет историю/метрики через `node record-history.js`.
 *
 * Если задана модель, вызов превращается в `opencode run --model "<model>" <промпт>`.
 */
export function buildBashWrapperScript(options: BashWrapperOptions): string {
  const {
    taskName,
    promptFile,
    timeoutSeconds,
    lockFile,
    workdir,
    workspaceName,
    logFile,
    recorderFile,
    qualityGate,
    model,
    beforeScript,
    afterScript,
    sessionMode,
    sessionId,
    oneShotCleanupCommand,
    allowedTools,
    deniedTools,
    scheduleGate,
    envFile,
    gateTimeoutSeconds,
  } = options;

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "# Сгенерировано opencode-windows-scheduler. Не редактируйте вручную:",
    "# файл перезаписывается при каждом обновлении задачи.",
    "set -u",
    "",
    `TASK_NAME=${shellQuote(taskName)}`,
    `PROMPT_FILE=${shellQuote(promptFile ?? "")}`,
    `LOG_FILE=${shellQuote(logFile ?? path.join(WRAPPER_DIR, "task.log"))}`,
    `LOCK_FILE=${shellQuote(lockFile)}`,
    `WORKDIR=${shellQuote(workdir || process.cwd())}`,
    `WORKSPACE_NAME=${shellQuote(workspaceName ?? "")}`,
    `TIMEOUT_SECONDS=${Number.isFinite(timeoutSeconds) ? Math.max(0, Math.floor(timeoutSeconds)) : 3600}`,
    `RECORDER_FILE=${shellQuote(recorderFile ?? "")}`,
    `QUALITY_GATE=${shellQuote(qualityGate ?? "")}`,
    `MODEL=${shellQuote(model ?? "")}`,
    // Спринт 24: режим сессии — "new" (по умолчанию), "reuse" (--session <id>), "last" (--continue).
    `SESSION_MODE=${shellQuote(sessionMode ?? "new")}`,
    `SESSION_ID=${shellQuote(sessionId ?? "")}`,
    `BEFORE_SCRIPT=${shellQuote(beforeScript ?? "")}`,
    `AFTER_SCRIPT=${shellQuote(afterScript ?? "")}`,
    `ALLOWED_TOOLS=${shellQuote((allowedTools ?? []).join(","))}`,
    `DENIED_TOOLS=${shellQuote((deniedTools ?? []).join(","))}`,
    `SCHEDULE_GATE_FILE=${shellQuote(scheduleGate?.gateFile ?? "")}`,
    `SCHEDULE_CRON=${shellQuote(scheduleGate?.cron ?? "")}`,
    `SCHEDULE_TZ=${shellQuote(scheduleGate?.tz ?? "")}`,
    `SCHEDULE_NOT_BEFORE=${shellQuote(scheduleGate?.notBefore ?? "")}`,
    `SCHEDULE_NOT_AFTER=${shellQuote(scheduleGate?.notAfter ?? "")}`,
    `SCHEDULE_DAYS=${shellQuote((scheduleGate?.days ?? []).join(","))}`,
    `SCHEDULE_WINDOW_POLICY=${shellQuote(scheduleGate?.windowPolicy ?? "")}`,
    `SCHEDULE_DEFER_FILE=${shellQuote(scheduleGate?.deferFile ?? "")}`,
    `SCHEDULE_FORCE_FILE=${shellQuote(scheduleGate?.forceFile ?? "")}`,
    `ENV_FILE=${shellQuote(envFile ?? "")}`,
    // Спринт 29.2: права задачи передаются в opencode через переменную окружения.
    // opencode run CLI не поддерживает --allow-tool/--deny-tool, а файл
    // opencode.jsonc в Workdir мог бы перезаписать проектный конфиг.
    `export OPENCODE_CONFIG_CONTENT=${shellQuote(buildOpencodeConfig(allowedTools, deniedTools))}`,
    '',
    "# cron запускает задачи с минимальным PATH — добавляем типовые каталоги.",
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
    "",
    'mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true',
    "",
    "log() {",
    '  printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$*" >> "$LOG_FILE" 2>/dev/null || true',
    "}",
    "",
    'log "[role-scoped] opencode config passed via OPENCODE_CONFIG_CONTENT"',
    "",
    "# Таймаут для gate/хуков: зависший скрипт не должен держать lock до истечения",
    "# STALE_LOCK_MAX_AGE_MS. 0 — без таймаута (не рекомендуется).",
    `GATE_TIMEOUT_SECONDS=${Math.max(0, Math.floor(gateTimeoutSeconds ?? 300))}`,
    'run_with_timeout() {',
    '  GATE_LIMIT="$1"; shift',
    '  if [ "$GATE_LIMIT" -le 0 ] 2>/dev/null; then',
    '    "$@"',
    '    return $?',
    '  fi',
    '  # T-10: потомок получает собственную группу процессов (job control), чтобы',
    '  # watchdog убивал всё дерево (bash -c и его детей), а не только прямого ребёнка.',
    '  set -m 2>/dev/null || true',
    '  "$@" &',
    '  GATE_CHILD=$!',
    '  set +m 2>/dev/null || true',
    '  ( sleep "$GATE_LIMIT"; kill -TERM -- "-$GATE_CHILD" 2>/dev/null || kill -TERM "$GATE_CHILD" 2>/dev/null; sleep 5; kill -KILL -- "-$GATE_CHILD" 2>/dev/null || kill -KILL "$GATE_CHILD" 2>/dev/null ) >/dev/null 2>&1 &',
    '  GATE_WATCHDOG=$!',
    '  wait "$GATE_CHILD"',
    '  GATE_CODE=$?',
    '  kill "$GATE_WATCHDOG" 2>/dev/null || true',
    '  wait "$GATE_WATCHDOG" 2>/dev/null || true',
    '  return "$GATE_CODE"',
    "}",
    "",
    "# Спринт 19: гейт расписания — до lock, чтобы ожидание окна не держало блокировку.",
    'if [ -n "$SCHEDULE_GATE_FILE" ]; then',
    '  SCHED_GATE_ARGS=()',
    '  [ -n "$SCHEDULE_CRON" ] && SCHED_GATE_ARGS+=(--cron "$SCHEDULE_CRON")',
    '  [ -n "$SCHEDULE_TZ" ] && SCHED_GATE_ARGS+=(--tz "$SCHEDULE_TZ")',
    '  [ -n "$SCHEDULE_NOT_BEFORE" ] && SCHED_GATE_ARGS+=(--not-before "$SCHEDULE_NOT_BEFORE")',
    '  [ -n "$SCHEDULE_NOT_AFTER" ] && SCHED_GATE_ARGS+=(--not-after "$SCHEDULE_NOT_AFTER")',
    '  [ -n "$SCHEDULE_DAYS" ] && SCHED_GATE_ARGS+=(--days "$SCHEDULE_DAYS")',
    '  [ -n "$SCHEDULE_WINDOW_POLICY" ] && SCHED_GATE_ARGS+=(--window-policy "$SCHEDULE_WINDOW_POLICY")',
    '  [ -n "$SCHEDULE_DEFER_FILE" ] && SCHED_GATE_ARGS+=(--defer-file "$SCHEDULE_DEFER_FILE")',
    '  [ -n "$SCHEDULE_FORCE_FILE" ] && SCHED_GATE_ARGS+=(--force-file "$SCHEDULE_FORCE_FILE")',
    '  if ! command -v node >/dev/null 2>&1; then',
    '    log "[scheduler] Гейт расписания пропущен: node не найден в PATH."',
    "  else",
    '    run_with_timeout "$GATE_TIMEOUT_SECONDS" node "$SCHEDULE_GATE_FILE" ${SCHED_GATE_ARGS[@]+"${SCHED_GATE_ARGS[@]}"} >> "$LOG_FILE" 2>&1',
    "    SCHED_GATE_CODE=$?",
    '    if [ "$SCHED_GATE_CODE" -eq 3 ]; then',
    '      log "[scheduler] Гейт расписания: запуск не требуется (cron/окно). Перенос или пропуск тика."',
    "      exit 0",
    "    fi",
    "  fi",
    "fi",
    "",
    "# Атомарная блокировка: mkdir завершается ошибкой, если каталог уже есть.",
    "# В каталог пишем PID: после kill -9 осиротевший lock снимается, а не",
    "# блокирует задачу до истечения STALE_LOCK_MAX_AGE_MS.",
    'if ! mkdir "$LOCK_FILE.d" 2>/dev/null; then',
    '  LOCK_PID=""',
    '  if [ -f "$LOCK_FILE.d/pid" ]; then',
    '    LOCK_PID="$(cat "$LOCK_FILE.d/pid" 2>/dev/null || true)"',
    "  fi",
    '  LOCK_ALIVE=1',
    '  if [ -n "$LOCK_PID" ]; then',
    '    if kill -0 "$LOCK_PID" 2>/dev/null; then LOCK_ALIVE=1; else LOCK_ALIVE=0; fi',
    '  fi',
    '  if [ "$LOCK_ALIVE" -eq 1 ]; then',
    '    log "[scheduler] Задача \'$TASK_NAME\' уже выполняется (pid ${LOCK_PID:-неизвестен}) — пропуск запуска."',
    "    exit 0",
    "  fi",
    '  log "[scheduler] Вытесняю осиротевший lock \'$LOCK_FILE.d\' (pid ${LOCK_PID:-неизвестен})."',
    '  # T-03: атомарно уводим каталог в уникальное имя вместо rm -rf, чтобы не',
    '  # удалить свежий lock, созданный другим воркером после нашей проверки.',
    '  STALE_LOCK_DIR="$LOCK_FILE.d.stale-$$"',
    '  if mv "$LOCK_FILE.d" "$STALE_LOCK_DIR" 2>/dev/null; then',
    '    rm -rf "$STALE_LOCK_DIR" 2>/dev/null || true',
    '  else',
    '    log "[scheduler] Не удалось вытеснить осиротевший lock — пропуск запуска."',
    '    exit 0',
    '  fi',
    '  if ! mkdir "$LOCK_FILE.d" 2>/dev/null; then',
    '    log "[scheduler] Не удалось взять lock \'$LOCK_FILE.d\' — пропуск запуска."',
    "    exit 0",
    "  fi",
    "fi",
    'printf \'%s\\n\' "$$" > "$LOCK_FILE.d/pid" 2>/dev/null || true',
    'cleanup() { rmdir "$LOCK_FILE.d" 2>/dev/null || rm -rf "$LOCK_FILE.d" 2>/dev/null; }',
    "trap cleanup EXIT INT TERM",
    "",
    'if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then',
    '  cd "$WORKDIR" || { log "[scheduler] Не удалось перейти в $WORKDIR"; exit 1; }',
    "fi",
    "",
    "# Спринт 21: env-переменные workspace. Файл пишет плагин, значения не логируются.",
    'if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then',
    '  while IFS= read -r env_line || [ -n "$env_line" ]; do',
    "    env_line=\"${env_line%$'\\r'}\"",
    "    case \"$env_line\" in ''|'#'*) continue ;; esac",
    '    env_key="${env_line%%=*}"',
    '    env_value="${env_line#*=}"',
    '    case "$env_key" in *[!A-Za-z0-9_]*) continue ;; esac',
    '    case "$env_key" in [A-Za-z_]*) ;; *) continue ;; esac',
    '    export "$env_key=$env_value"',
    '  done < "$ENV_FILE"',
    '  log "[scheduler] Переменные окружения workspace загружены."',
    "fi",
    "",
    'if [ -n "$WORKSPACE_NAME" ]; then',
    '  GIT_BRANCH="$(git -C "$WORKDIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"',
    '  GIT_REMOTE="$(git -C "$WORKDIR" remote get-url origin 2>/dev/null || true)"',
    '  [ -n "$GIT_BRANCH" ] || GIT_BRANCH="-"',
    '  [ -n "$GIT_REMOTE" ] || GIT_REMOTE="-"',
    '  log "[workspace] name=$WORKSPACE_NAME, cwd=$WORKDIR, branch=$GIT_BRANCH, remote=$GIT_REMOTE"',
    "fi",
    "",
    "# Role-scoped tools: права переданы в opencode через OPENCODE_CONFIG_CONTENT",
    "# (реальные allow/deny permissions, не metadata-only). Здесь только лог.",
    'if [ -n "$ALLOWED_TOOLS" ] || [ -n "$DENIED_TOOLS" ]; then',
    '  log "[role-scoped] allowed=[$ALLOWED_TOOLS], denied=[$DENIED_TOOLS]"',
    "fi",
    "",
    'if ! command -v opencode >/dev/null 2>&1; then',
    '  log "[scheduler] ОШИБКА: opencode не найден в PATH ($PATH)."',
    "  exit 127",
    "fi",
    "",
    'PROMPT="$(cat "$PROMPT_FILE" 2>/dev/null || true)"',
    "# T-09: backstop размера промпта на POSIX (argv ограничен MAX_ARG_STRLEN",
    "# 128 КиБ на аргумент в Linux). Считаем байты, а не символы.",
    'PROMPT_BYTES="$(printf %s "$PROMPT" | wc -c | tr -d \' \')"',
    'if [ "$PROMPT_BYTES" -gt 131072 ] 2>/dev/null; then',
    '  log "[scheduler] ОШИБКА: промпт слишком длинный для argv POSIX: ${PROMPT_BYTES} байт (максимум 131072)."',
    '  exit 1',
    'fi',
    'START_EPOCH="$(date +%s)"',
    'STARTED_AT="$(date -u \'+%Y-%m-%dT%H:%M:%SZ\')"',
    'EXIT_CODE=0',
    'ERROR_MESSAGE=""',
    'PRE_FLIGHT_STATUS="skipped"',
    'POST_FLIGHT_STATUS="skipped"',
    'SKIP_MAIN=0',
    "",
    `log "[scheduler] Запуск задачи '$TASK_NAME'..."`,
    "",
    "# Crash recovery: фиксируем начало до pre-flight. Если процесс убьют,",
    "# останется finished_at = NULL и recovery при следующем старте пометит error.",
    'RUN_ID=""',
    'if [ -n "$RECORDER_FILE" ] && command -v node >/dev/null 2>&1; then',
    '  RUN_ID="$(node "$RECORDER_FILE" --start "$TASK_NAME" "$STARTED_AT" 2>> "$LOG_FILE" | tail -n 1)"',
    "fi",
    "",
    "# Pre-flight: выполняется до основной задачи. Ненулевой код отменяет запуск.",
    'if [ -n "$BEFORE_SCRIPT" ]; then',
    '  log "[scheduler] Pre-flight: $BEFORE_SCRIPT"',
    '  run_with_timeout "$GATE_TIMEOUT_SECONDS" bash -c "$BEFORE_SCRIPT" >> "$LOG_FILE" 2>&1',
    "  PRE_CODE=$?",
    '  if [ "$PRE_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Pre-flight script failed (код $PRE_CODE)."',
    '    PRE_FLIGHT_STATUS="error"',
    '    ERROR_MESSAGE="Pre-flight script failed"',
    "    EXIT_CODE=1",
    "    SKIP_MAIN=1",
    "  else",
    '    PRE_FLIGHT_STATUS="success"',
    '    log "[scheduler] Pre-flight успешно завершён."',
    "  fi",
    "fi",
    "",
    'if [ "$SKIP_MAIN" -eq 0 ]; then',
    "",
    "# Модель указывается только если задана — иначе OpenCode берёт свою по умолчанию.",
    "# exec важен: в фоновом режиме он заменяет подоболочку процессом opencode,",
    "# поэтому $! — это PID самого opencode, и watchdog убивает именно его.",
    "# Ветвление вместо массива: bash 3.2 (macOS) с set -u падает на пустом",
    '# "${ARR[@]}".',
    "run_opencode() {",
    '  if [ "$SESSION_MODE" = "reuse" ] && [ -n "$SESSION_ID" ]; then',
    '    if [ -n "$MODEL" ]; then',
    '      exec opencode run --auto --session "$SESSION_ID" --model "$MODEL" "$PROMPT"',
    "    else",
    '      exec opencode run --auto --session "$SESSION_ID" "$PROMPT"',
    "    fi",
    '  elif [ "$SESSION_MODE" = "last" ]; then',
    '    if [ -n "$MODEL" ]; then',
    '      exec opencode run --auto --continue --model "$MODEL" "$PROMPT"',
    "    else",
    '      exec opencode run --auto --continue "$PROMPT"',
    "    fi",
    "  else",
    '    if [ -n "$MODEL" ]; then',
    '      exec opencode run --auto --model "$MODEL" "$PROMPT"',
    "    else",
    '      exec opencode run --auto "$PROMPT"',
    "    fi",
    "  fi",
    "}",
    "",
    "# Всегда запускаем в фоне, чтобы watchdog мог завершить процесс по таймауту.",
    "# TIMEOUT_SECONDS=0 — ждём без watchdog.",
    "# T-10: как и в run_with_timeout, opencode запускается в собственной группе",
    "# процессов (exec внутри run_opencode сохраняет лидера группы), поэтому",
    "# watchdog убивает всё дерево, а внуки не переживают таймаут.",
    'set -m 2>/dev/null || true',
    'run_opencode >> "$LOG_FILE" 2>&1 &',
    "CHILD=$!",
    'set +m 2>/dev/null || true',
    'if [ "$TIMEOUT_SECONDS" -gt 0 ] 2>/dev/null; then',
    '  ( sleep "$TIMEOUT_SECONDS"; kill -TERM -- "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null; sleep 5; kill -KILL -- "-$CHILD" 2>/dev/null || kill -KILL "$CHILD" 2>/dev/null ) &',
    "  WATCHDOG=$!",
    "fi",
    'wait "$CHILD"',
    "EXIT_CODE=$?",
    'if [ -n "${WATCHDOG:-}" ]; then',
    '  kill "$WATCHDOG" 2>/dev/null || true',
    '  wait "$WATCHDOG" 2>/dev/null || true',
    "fi",
    '',
    '# Конфиг прав живёт только в переменной окружения — файл не создаётся.',
    '',
    'if [ "$EXIT_CODE" -ne 0 ]; then',
    '  log "[scheduler] Задача \'$TASK_NAME\' завершилась с кодом $EXIT_CODE."',
    '  ERROR_MESSAGE="Код возврата $EXIT_CODE"',
    "else",
    '  log "[scheduler] Задача \'$TASK_NAME\' успешно завершена."',
    "fi",
    "",
    'if [ -n "$QUALITY_GATE" ] && [ "$EXIT_CODE" -eq 0 ]; then',
    '  log "[scheduler] Запуск Quality Gate: $QUALITY_GATE"',
    '  run_with_timeout "$GATE_TIMEOUT_SECONDS" bash -c "$QUALITY_GATE" >> "$LOG_FILE" 2>&1',
    "  GATE_CODE=$?",
    '  if [ "$GATE_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Quality Gate провален. Код возврата: $GATE_CODE"',
    '    ERROR_MESSAGE="Quality Gate провален. Код возврата: $GATE_CODE"',
    "    EXIT_CODE=1",
    "  else",
    '    log "[scheduler] Quality Gate пройден."',
    "  fi",
    "fi",
    "",
    "fi # конец блока основной задачи",
    "",
    "# Post-flight: выполняется ВСЕГДА, даже если основная задача упала.",
    'if [ -n "$AFTER_SCRIPT" ]; then',
    '  log "[scheduler] Post-flight: $AFTER_SCRIPT"',
    '  run_with_timeout "$GATE_TIMEOUT_SECONDS" bash -c "$AFTER_SCRIPT" >> "$LOG_FILE" 2>&1',
    "  POST_CODE=$?",
    '  if [ "$POST_CODE" -ne 0 ]; then',
    '    log "[scheduler] ОШИБКА: Post-flight script failed (код $POST_CODE)."',
    '    POST_FLIGHT_STATUS="error"',
    '    if [ "$EXIT_CODE" -eq 0 ]; then',
    '      ERROR_MESSAGE="Post-flight script failed"',
    "      EXIT_CODE=1",
    "    fi",
    "  else",
    '    POST_FLIGHT_STATUS="success"',
    '    log "[scheduler] Post-flight успешно завершён."',
    "  fi",
    "fi",
    "",
    'END_EPOCH="$(date +%s)"',
    'DURATION_MS=$(( (END_EPOCH - START_EPOCH) * 1000 ))',
    'STATUS="error"',
    'if [ "$EXIT_CODE" -eq 0 ]; then STATUS="success"; fi',
    "",
    'if [ -n "$RECORDER_FILE" ] && command -v node >/dev/null 2>&1; then',
    '  if [ -n "$RUN_ID" ]; then',
    '    node "$RECORDER_FILE" --finish "$RUN_ID" "$TASK_NAME" "$STATUS" "$DURATION_MS" "$ERROR_MESSAGE" "-" "-" "$MODEL" "$PRE_FLIGHT_STATUS" "$POST_FLIGHT_STATUS" "$LOG_FILE" >> "$LOG_FILE" 2>&1 || true',
    "  else",
    '    node "$RECORDER_FILE" "$TASK_NAME" "$STATUS" "$STARTED_AT" "$DURATION_MS" "$ERROR_MESSAGE" "-" "-" "$MODEL" "$PRE_FLIGHT_STATUS" "$POST_FLIGHT_STATUS" "$LOG_FILE" >> "$LOG_FILE" 2>&1 || true',
    "  fi",
    "fi",
    "",
    // One-shot: снимаем задание с расписания после единственного запуска.
    // История уже записана, поэтому фоновая очистка не влияет на результат.
    ...(oneShotCleanupCommand
      ? [
          `(sleep 2; ${oneShotCleanupCommand}) >/dev/null 2>&1 &`,
          "",
        ]
      : []),
    'exit "$EXIT_CODE"',
    "",
  ];

  return lines.join("\n");
}

/**
 * Записывает per-task bash-обёртку и делает её исполняемой.
 * Возвращает абсолютный путь к .sh-файлу.
 */
export async function writeBashWrapper(
  options: BashWrapperOptions
): Promise<string> {
  await fs.mkdir(WRAPPER_DIR, { recursive: true });
  const scriptPath = path.join(
    WRAPPER_DIR,
    `run-${options.sanitizedName}.sh`
  );
  const script = buildBashWrapperScript(options);
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

/** Путь к bash-обёртке задачи (для диагностики/тестов). */
export function bashWrapperPath(sanitizedName: string): string {
  return path.join(WRAPPER_DIR, `run-${sanitizedName}.sh`);
}

// Спринт 29.2: генерация содержимого opencode.jsonc с правами для задачи.
// opencode run CLI (v2.2.3) не поддерживает --allow-tool/--deny-tool, поэтому
// права задаются через временный opencode.jsonc в WORKDIR.
//
// Actions OpenCode v2: read, edit, glob, grep, shell, subagent, skill, question,
// webfetch, websearch. deny для shell покрывает bash/Shell, deny для edit покрывает
// write/edit/apply_patch/remove.
//
// Политика: всё разрешено по умолчанию (как в OpenCode), deniedTools добавляют
// deny-правила, allowedTools (если задан) запрещает всё, чего нет в списке.
// Задаёт только допустимые/actions из известного набора — неизвестные игнорируются.
export function buildOpencodeConfig(
  allowedTools?: string[],
  deniedTools?: string[]
): string {
  const actions: Array<{ action: string; effect: "allow" | "deny" }> = [
    { action: "read", effect: "allow" },
    { action: "edit", effect: "allow" },
    { action: "glob", effect: "allow" },
    { action: "grep", effect: "allow" },
    { action: "shell", effect: "allow" },
    { action: "subagent", effect: "allow" },
    { action: "skill", effect: "allow" },
    { action: "question", effect: "allow" },
    { action: "webfetch", effect: "allow" },
    { action: "websearch", effect: "allow" },
  ];

  const deniedSet = new Set(
    (deniedTools ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
  const allowedSet = new Set(
    (allowedTools ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );

  const toolToAction = new Map<string, string>([
    ["read", "read"],
    ["write", "edit"],
    ["edit", "edit"],
    ["apply_patch", "edit"],
    ["remove", "edit"],
    ["bash", "shell"],
    ["shell", "shell"],
    ["glob", "glob"],
    ["grep", "grep"],
    ["webfetch", "webfetch"],
    ["websearch", "websearch"],
    ["question", "question"],
    ["subagent", "subagent"],
    ["skill", "skill"],
  ]);

  // Для каждого action — все его алиасы: allowedTools может содержать любой.
  const aliasesByAction = new Map<string, string[]>();
  for (const [tool, action] of toolToAction) {
    const list = aliasesByAction.get(action) ?? [];
    list.push(tool);
    aliasesByAction.set(action, list);
  }

  // Применяем deniedTools.
  for (const [tool, action] of toolToAction) {
    if (deniedSet.has(tool)) {
      const idx = actions.findIndex((a) => a.action === action);
      if (idx >= 0) actions[idx].effect = "deny";
    }
  }

  // Если задан allowedTools — всё, чего нет в списке, запрещаем.
  // deniedTools имеет приоритет (последнее правило выигрывает в OpenCode),
  // поэтому применяем allowedTools ПОСЛЕ deniedTools — denied не перебивается.
  if (allowedSet.size > 0) {
    for (const entry of actions) {
      // Если действие уже запрещено deniedTools, оставляем deny.
      if (entry.effect === "deny") continue;
      const aliases = aliasesByAction.get(entry.action) ?? [];
      // Действие разрешено, если в allowedTools есть ХОТЯ БЫ ОДИН его алиас.
      // Раньше проверялся только первый алиас, поэтому "shell" не разрешал bash.
      const allowed = aliases.some((alias) => allowedSet.has(alias));
      if (aliases.length > 0 && !allowed) entry.effect = "deny";
    }
  }

  // Убираем дубликаты actions (оставляем последний эффект).
  const deduped = new Map<string, "allow" | "deny">();
  for (const { action, effect } of actions) deduped.set(action, effect);

  const permissions = [...deduped.entries()].map(
    ([action, effect]) =>
      `    { "action": "${action}", "resource": "*", "effect": "${effect}" }`
  );

  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      permissions: permissions.map((p) => JSON.parse(p)),
    },
    null,
    2
  );
}
