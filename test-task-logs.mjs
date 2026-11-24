/**
 * PL-67 — регрессия поиска лога задачи по короткому/префиксному имени.
 *
 * get_task_logs должен находить лог и по полному имени задачи, и по короткому
 * (ARCH-7 → arch-7-approval-queue.log): через реестр задач или по шаблону
 * <slug>*.log в LOG_DIR. Публичный контракт {logs, error?} не меняется.
 *
 * Запуск: node test-task-logs.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-task-logs-"));
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "home");

const { LOG_DIR, sanitizeName } = await import("./dist/types.js");
const { getTaskLogs } = await import("./dist/core/scheduler/logs.js");
const {
  readTaskLogTail,
  readTaskLogTailSync,
  TASK_LOG_MAX_BYTES,
  TASK_LOG_TAIL_BYTES,
  TASK_LOG_TRIM_MARKER,
} = await import("./dist/core/mission.js");
const { saveTask, deleteTask } = await import("./dist/db/tasks-repo.js");
const { STAGE_NAMES, stageMarker, formatStageLog, parseStageLog } = await import(
  "./dist/shared/stage-log.js"
);

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const MARKER = "PL67-REGRESSION-MARKER";
const FULL_NAME = "ARCH-7 - Approval queue";
const FULL_BASE = sanitizeName(FULL_NAME); // arch-7-approval-queue

function writeLog(base, marker) {
  fs.writeFileSync(
    path.join(LOG_DIR, `${base}.log`),
    `[agent-steward] === Run started 2026-11-23\n${marker}\n`,
    "utf8",
  );
}

// Реальный сценарий из находки: файл arch-7-approval-queue.log, задача в реестре.
writeLog(FULL_BASE, MARKER);
saveTask({ name: FULL_NAME, schedule: "0 3 * * *", prompt: "PL-67 regression" });

// 1. Короткое имя ARCH-7 (главная регрессия PL-67).
const short = await getTaskLogs("ARCH-7");
check(
  "PL-67: короткое имя ARCH-7 находит лог полной задачи",
  short.error === undefined && short.logs.includes(MARKER),
);

// 2. Сравнение регистронезависимое и не зависит от дефисов/пробелов.
const lower = await getTaskLogs("arch-7");
check(
  "PL-67: регистронезависимый поиск по slug",
  lower.error === undefined && lower.logs.includes(MARKER),
);

// 3. Полное имя работает как раньше (сохранение текущего поведения).
const full = await getTaskLogs(FULL_NAME);
check(
  "PL-67: полное имя задачи по-прежнему возвращает лог",
  full.error === undefined && full.logs.includes(MARKER),
);

// 4. Действительно отсутствующий лог даёт прежнюю понятную ошибку.
const missing = await getTaskLogs("totally-unknown-task");
check(
  "PL-67: неизвестное имя даёт ошибку «не найден» с путём",
  missing.logs === "" &&
    typeof missing.error === "string" &&
    missing.error.includes("не найден") &&
    missing.error.includes("totally-unknown-task.log"),
);

// 5. Несколько кандидатов: реестр выбирает записанную задачу (приоритет).
writeLog("arch-7-r2-gate", "PL67-R2-GATE");
const multi = await getTaskLogs("ARCH-7");
check(
  "PL-67: несколько кандидатов — приоритет у задачи из реестра",
  multi.error === undefined &&
    multi.logs.includes(MARKER) &&
    !multi.logs.includes("PL67-R2-GATE"),
);

// 6. Несколько кандидатов без реестра — детерминированный выбор (самый короткий slug).
deleteTask(FULL_NAME);
const multiNoRegistry = await getTaskLogs("ARCH-7");
const repeat = await getTaskLogs("ARCH-7");
check(
  "PL-67: без реестра несколько <slug>*.log дают детерминированный результат",
  multiNoRegistry.error === undefined &&
    (multiNoRegistry.logs.includes(MARKER) ||
      multiNoRegistry.logs.includes("PL67-R2-GATE")) &&
    multiNoRegistry.logs === repeat.logs,
);

// 7. Fallback по единственному файлу <slug>*.log без записи в реестре.
fs.unlinkSync(path.join(LOG_DIR, "arch-7-r2-gate.log"));
const single = await getTaskLogs("ARCH-7");
check(
  "PL-67: единственный <slug>*.log находится без записи в реестре",
  single.error === undefined && single.logs.includes(MARKER),
);

// 8. Публичный контракт результата не расширялся.
check(
  "PL-67: контракт результата {logs, error?} сохранён",
  Object.keys(short).every((key) => key === "logs" || key === "error") &&
    typeof short.logs === "string",
);

// --- BN-3: рост лога длинных запусков ограничен чтением хвоста и ротацией ---
const BN3_HEAD = "BN3-OLD-RECORD";
const BN3_TAIL = "BN3-LAST-RUN-RECORD";
const bigLog = path.join(LOG_DIR, "bn3-bounded.log");
const filler = `L${"x".repeat(1023)}`;
const chunks = [];
for (let i = 0; i < Math.ceil((TASK_LOG_TAIL_BYTES * 1.5) / (filler.length + 1)); i++) {
  chunks.push(filler);
}
fs.writeFileSync(bigLog, `${BN3_HEAD}\n${chunks.join("\n")}\n[agent-steward] === Run started 2026-11-24T10:00:00.000Z (BN3) ===\n${BN3_TAIL}\n`, "utf8");

const tailText = await readTaskLogTail(bigLog);
check(
  "BN-3: readTaskLogTail возвращает только хвост, а не весь файл",
  tailText.includes(BN3_TAIL) && !tailText.includes(BN3_HEAD) &&
    tailText.length <= TASK_LOG_TAIL_BYTES + 200,
);
const firstTailLine = tailText.split("\n")[0];
check(
  "BN-3: хвост начинается с целой строки, а не с середины",
  firstTailLine.startsWith("L") && firstTailLine.length === 1024,
);
const tailSync = readTaskLogTailSync(bigLog);
check(
  "BN-3: синхронный reader для recorder тоже ограничен хвостом",
  tailSync.includes(BN3_TAIL) && !tailSync.includes(BN3_HEAD),
);
const tailLogs = await getTaskLogs("bn3-bounded");
check(
  "BN-3: get_task_logs сопротивляется многомегабайтному логу",
  tailLogs.error === undefined && tailLogs.logs.includes(BN3_TAIL) &&
    !tailLogs.logs.includes(BN3_HEAD),
);

const logsSource = fs.readFileSync(path.join(process.cwd(), "src/core/scheduler/logs.ts"), "utf8");
const recorderSource = fs.readFileSync(path.join(process.cwd(), "src/core/record-history.ts"), "utf8");
const psSource = fs.readFileSync(path.join(process.cwd(), "src/core/ps-wrapper.ts"), "utf8");
const bashSource = fs.readFileSync(path.join(process.cwd(), "src/core/wrappers/bash.ts"), "utf8");
check(
  "BN-3: get_task_logs и recorder используют чтение хвоста",
  logsSource.includes("readLogTailWithRetry(") &&
    recorderSource.includes("readTaskLogTailSync("),
);
check(
  "BN-3: лимит размера согласован между reader и writer",
  TASK_LOG_MAX_BYTES === 10 * 1024 * 1024 &&
    TASK_LOG_TAIL_BYTES === 2 * 1024 * 1024 &&
    psSource.includes("-MaxBytes 10485760 -KeepBytes 2097152") &&
    bashSource.includes("-gt 10485760") && bashSource.includes("tail -c 2097152"),
);
check(
  "BN-3: обе обёртки ротируют лог перед маркером Run started",
  psSource.includes("Invoke-TaskLogRotation") &&
    // QW-7 добавил комментарий со строкой «=== Run started» раньше ротации —
    // ищем именно место записи маркера, а не первое упоминание в комментарии.
    psSource.indexOf("Invoke-TaskLogRotation -Path") <
      psSource.indexOf('Add-Content -Path $LogFile -Value ("[agent-steward] === Run started') &&
    bashSource.indexOf("Log rotated (size limit)") <
      bashSource.indexOf("=== Run started %s (%s)") &&
    psSource.includes(TASK_LOG_TRIM_MARKER),
);

// IM-3 / D03: метки этапов [stage:*] — формат, парсер и обратная совместимость.
check(
  "IM-3: четыре этапа имеют machine-readable метки",
  STAGE_NAMES.join(",") === "preFlight,run,postFlight,gate" &&
    stageMarker("gate") === "[stage:gate]",
);
check(
  "IM-3: форматирование и разбор метки обратимы",
  STAGE_NAMES.every((stage) => {
    const line = formatStageLog(stage, `сообщение ${stage}`);
    const parsed = parseStageLog(line);
    return parsed.stage === stage && parsed.message === `сообщение ${stage}`;
  }),
);
check(
  "IM-3: старые строки без метки разбираются как stage=null",
  parseStageLog("[agent-steward] Pre-flight: npm test").stage === null &&
    parseStageLog("[stage:unknown] текст").stage === null,
);
check(
  "IM-3: PS-обёртка пишет метки всех этапов",
  psSource.includes('Write-Stage -Stage "preFlight"') &&
    psSource.includes('Write-Stage -Stage "run"') &&
    psSource.includes('Write-Stage -Stage "postFlight"') &&
    psSource.includes('Write-Stage -Stage "gate"') &&
    psSource.includes("function Write-Stage {"),
);

// IM-12 / D13: сквозной runId в метках этапов.
check(
  "D13: метка этапа несёт runId и разбирается обратно",
  (() => {
    const line = formatStageLog("run", "запуск агента", 4242);
    const parsed = parseStageLog(line);
    return line === "[stage:run][run:4242] запуск агента" && parsed.stage === "run" && parsed.runId === 4242 && parsed.message === "запуск агента";
  })(),
);
check(
  "D13: старые метки этапов без runId остаются совместимыми",
  parseStageLog("[stage:gate] проверка").runId === undefined &&
    parseStageLog("[stage:gate] проверка").message === "проверка" &&
    formatStageLog("gate", "проверка") === "[stage:gate] проверка",
);
check(
  "D13: PS-обёртка добавляет runId в метки этапов",
  psSource.includes('Write-Log "[stage:$Stage][run:$script:runId] $Message"'),
);

const failed = results.filter((r) => !r.ok);
console.log(`\nTask logs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
