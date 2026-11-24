/**
 * Тесты Спринта 26: журнал аудита.
 * Запуск: node test-audit.mjs (после npm run build).
 * Конфиг-домен подменяется temp-ди렉торией.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-audit-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const audit = await import("./dist/core/audit.js");
const permissions = await import("./dist/core/permissions.js");
const dbModule = await import("./dist/db/index.js");

const { recordAudit, readAuditLog, cleanupAuditLog, clearAuditLog, resetAuditCleanupThrottle, recordToolBlocked, recordTaskToolBlocks, recordEgressAttempt, runEgressGuardedWithAudit, summarizeEgressRun, EGRESS_ALLOWED_ACTION, EGRESS_BLOCKED_ACTION } = audit;
const { appendStructuredLog, clearStructuredLogs, readStructuredLogs } = await import("./dist/core/structured-log.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

// Инициализируем БД (создаёт таблицы включая audit_log).
const db = dbModule.getDb();

// --- 1. Схема audit_log существует ------------------------------------------
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").all();
check("таблица audit_log создана", tables.length === 1);

const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'").all();
check("индекс idx_audit_ts существует", indexes.some((i) => i.name === "idx_audit_ts"));
check("индекс idx_audit_action существует", indexes.some((i) => i.name === "idx_audit_action"));

// --- 2. Запись и чтение -------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const id1 = recordAudit({ action: "task.create", targetType: "task", target: "deploy", actor: "mcp", source: "schedule_task", details: { cron: "0 9 * * *" }, remote: null });
const id2 = recordAudit({ action: "task.update", targetType: "task", target: "deploy", actor: "gui", source: "update_task", details: { field: "timeout" }, remote: "127.0.0.1" });
const id3 = recordAudit({ action: "secret.set", targetType: "secret", target: "bot_token", actor: "mcp", source: "manage_secrets", details: { name: "bot_token" }, remote: null });

check("recordAudit возвращает id", typeof id1 === "number" && id1 > 0);
check("id растут", id2 > id1 && id3 > id2);

const all = readAuditLog({});
check("readAuditLog возвращает все записи", all.records.length === 3);
check("readAuditLog total", all.total === 3);
check("записи отсортированы по убыванию id", all.records[0].id === id3 && all.records[1].id === id2 && all.records[2].id === id1);

// --- 3. Фильтры ---------------------------------------------------------------
const byAction = readAuditLog({ action: "task.create" });
check("фильтр по action", byAction.records.length === 1 && byAction.records[0].action === "task.create");

const byActor = readAuditLog({ actor: "gui" });
check("фильтр по actor", byActor.records.length === 1 && byActor.records[0].actor === "gui");

const byTarget = readAuditLog({ target: "deploy" });
check("фильтр по target", byTarget.records.length === 2);

const limited = readAuditLog({ limit: 1 });
check("лимит записей", limited.records.length === 1 && limited.total === 3);

// --- 4. Редакция деталей -------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const secretId = recordAudit({
  action: "task.run",
  targetType: "task",
  target: "backup",
  actor: "http",
  source: "POST /api/run/:name",
  details: { token: "sk-1234567890abcdef", password: "hunter2", safe: "visible" },
  remote: "10.0.0.1",
});

const secretRec = readAuditLog({}).records.find((r) => r.id === secretId);
check("редакция токена в деталях", typeof secretRec.details.token === "string" && secretRec.details.token === "***");
check("редакция пароля в деталях", typeof secretRec.details.password === "string" && secretRec.details.password === "***");
check("несекретное поле не маскируется", secretRec.details.safe === "visible");

// ${secret:NAME} в деталях не маскируется как значение.
resetAuditCleanupThrottle();
clearAuditLog();
const refId = recordAudit({
  action: "task.create",
  targetType: "task",
  target: "deploy",
  actor: "mcp",
  source: "schedule_task",
  details: { env: { DB_URL: "${secret:db_pass}" } },
  remote: null,
});
const refRec = readAuditLog({}).records.find((r) => r.id === refId);
check("${secret:NAME} в деталях не маскируется", refRec.details.env.DB_URL === "${secret:db_pass}");

// --- 5. Ретеншн и очистка -----------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const now = new Date();
const oldDate = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString();
const recentDate = now.toISOString();

recordAudit({ action: "task.create", targetType: "task", target: "old", actor: "mcp", source: "t", details: {}, remote: null, ts: oldDate });
recordAudit({ action: "task.create", targetType: "task", target: "recent", actor: "mcp", source: "t", details: {}, remote: null, ts: recentDate });
const before = readAuditLog({}).records.length;
check("2 записи перед очисткой", before === 2);

const deleted = cleanupAuditLog({ retentionDays: 30, maxRecords: 10000 });
check("cleanupAuditLog удалила старую запись", deleted === 1);
const after = readAuditLog({}).records.length;
check("осталась 1 недавняя запись", after === 1);
check("оставшаяся запись — недавняя", readAuditLog({}).records[0].target === "recent");

// --- 6. clearAuditLog ---------------------------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();
check("clearAuditLog удаляет все", readAuditLog({}).records.length === 0);

// --- 7. Аудит блокировок инструментов -----------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

const blocksWritten = recordTaskToolBlocks("scraper", ["read"], ["write", "bash"], "mcp", "schedule_task");
check("recordTaskToolBlocks пишет событие на каждый denied-инструмент", blocksWritten === 2);

const blocked = readAuditLog({ action: "tool.blocked" });
check("tool.blocked виден в аудите", blocked.records.length === 2 && blocked.total === 2);
check("tool.blocked привязан к задаче", blocked.records.every((r) => r.targetType === "task" && r.target === "scraper"));
check("tool.blocked хранит инструмент", blocked.records.map((r) => r.details.tool).sort().join(",") === "bash,write");
const blockedDetails = blocked.records[0].details;
check("tool.blocked хранит причину", blockedDetails.reason === "deniedTools");
check("tool.blocked хранит allowedTools", Array.isArray(blockedDetails.allowedTools) && blockedDetails.allowedTools.join(",") === "read");
check("tool.blocked хранит deniedTools", Array.isArray(blockedDetails.deniedTools) && blockedDetails.deniedTools.length === 2);

const directId = recordToolBlocked({ task: "deploy", tool: "shell", details: { reason: "nested", attempt: 1 } });
const direct = readAuditLog({}).records.find((r) => r.id === directId);
check("recordToolBlocked пишет отдельное событие", direct?.action === "tool.blocked" && direct.details.attempt === 1);
check("recordToolBlocked не перетирает tool", direct?.details.tool === "shell");

clearAuditLog();
const allowedOnly = recordTaskToolBlocks("report", ["read", "grep"], [], "system", "policy");
const allowedRecords = readAuditLog({ action: "tool.blocked" }).records;
check("allowedTools без deniedTools не даёт ложного события", allowedOnly === 0 && allowedRecords.length === 0);
check("в журнале нет подмены имени инструмента звёздочкой", !allowedRecords.some((r) => r.details.tool === "*" || r.details.reason === "allowedTools"));

// --- PL-60: ложные tool.blocked с tool: "*" при task.create/task.update --------
// Регрессия: внутренний вызов рекордера/MCP при сохранении ARCH-задачи с
// allow-list политикой. task.create/task.update успешно выполняются, поэтому
// событие tool.blocked с tool: "*"/reason: allowedTools писать нельзя — в
// журнале должны оставаться только реальные имена инструментов.
resetAuditCleanupThrottle();
clearAuditLog();
const pl60Created = recordTaskToolBlocks(
  "PL60-arch",
  ["read", "grep"],
  [],
  "mcp",
  "schedule_task",
  "hybrid",
);
const pl60CreateRecords = readAuditLog({ action: "tool.blocked" }).records;
check(
  "PL-60: allow-list при task.create через MCP не пишет tool.blocked",
  pl60Created === 0 && pl60CreateRecords.length === 0,
);

const pl60Updated = recordTaskToolBlocks(
  "PL60-arch",
  ["read", "grep"],
  [],
  "mcp",
  "update_task",
  "hybrid",
);
const pl60UpdateRecords = readAuditLog({ action: "tool.blocked" }).records;
check(
  "PL-60: allow-list при task.update через MCP не пишет tool.blocked",
  pl60Updated === 0 && pl60UpdateRecords.length === 0,
);
check(
  "PL-60: нет записей с tool: \"*\" / reason: allowedTools",
  ![...pl60CreateRecords, ...pl60UpdateRecords].some(
    (r) => r.details.tool === "*" || r.details.reason === "allowedTools",
  ),
);

// Легитимные блокировки с реальным именем инструмента должны сохраниться.
clearAuditLog();
const pl60Denied = recordTaskToolBlocks(
  "PL60-arch",
  ["read"],
  ["shell"],
  "mcp",
  "schedule_task",
  "hybrid",
);
const pl60DeniedRecords = readAuditLog({ action: "tool.blocked" }).records;
check(
  "PL-60: deniedTools по-прежнему пишутся с реальным именем инструмента",
  pl60Denied === 1 &&
    pl60DeniedRecords.length === 1 &&
    pl60DeniedRecords[0].details.tool === "shell" &&
    pl60DeniedRecords[0].details.reason === "deniedTools" &&
    !pl60DeniedRecords.some((r) => r.details.tool === "*"),
);

clearAuditLog();
check("пустая политика не пишет событий", recordTaskToolBlocks("plain", [], []) === 0);

// --- QA-P3.1: валидация ISO-дат в фильтрах аудита -----------------------------
check(
  "auditDateFilterError: невалидный since даёт ошибку",
  (audit.auditDateFilterError("not-a-date", "since") ?? "").includes("since")
);
check(
  "auditDateFilterError: невалидный until даёт ошибку",
  (audit.auditDateFilterError("25:99", "until") ?? "").includes("until")
);
check(
  "auditDateFilterError: валидная ISO-дата проходит",
  audit.auditDateFilterError(new Date().toISOString(), "since") === null
);
let invalidSinceThrew = false;
try {
  readAuditLog({ since: "not-a-date" });
} catch (err) {
  invalidSinceThrew = String(err instanceof Error ? err.message : err).includes("since");
}
check("readAuditLog: невалидный since бросает ошибку", invalidSinceThrew);
let invalidUntilThrew = false;
try {
  readAuditLog({ until: "not-a-date" });
} catch (err) {
  invalidUntilThrew = String(err instanceof Error ? err.message : err).includes("until");
}
check("readAuditLog: невалидный until бросает ошибку", invalidUntilThrew);

// --- 7b. ARCH-6.1 / ARCH-6.2: аудит egress-попыток и деградация ----------------
resetAuditCleanupThrottle();
clearAuditLog();
const egressPolicy = { allowedHosts: ["api.github.com"], allowedApis: [] };

const egressAllowed = recordEgressAttempt({
  task: "scraper",
  destination: "https://api.github.com/repos",
  policy: egressPolicy,
  actor: "mcp",
  source: "execute-path",
});
check(
  "egress: разрешённая попытка возвращает решение и аудируется",
  egressAllowed.allowed === true &&
    egressAllowed.reason === "allowed-host" &&
    egressAllowed.degraded === false &&
    typeof egressAllowed.auditId === "number" &&
    egressAllowed.auditId > 0,
);

const egressBlocked = recordEgressAttempt({
  task: "scraper",
  destination: "https://evil.example/exfiltrate",
  policy: egressPolicy,
  actor: "mcp",
  source: "execute-path",
});
check(
  "egress: заблокированная попытка возвращает отказ с причиной",
  egressBlocked.allowed === false &&
    egressBlocked.reason === "blocked-host" &&
    egressBlocked.degraded === true &&
    egressBlocked.detail.includes("evil.example"),
);

const egressRecords = readAuditLog({}).records;
check(
  "egress: КАЖДАЯ попытка попала в аудит (разрешённая и заблокированная)",
  egressRecords.length === 2,
);
const allowedRec = egressRecords.find((r) => r.id === egressAllowed.auditId);
const blockedRec = egressRecords.find((r) => r.id === egressBlocked.auditId);
check(
  "egress: egress.allowed хранит причину",
  allowedRec?.action === EGRESS_ALLOWED_ACTION &&
    allowedRec.details.allowed === true &&
    allowedRec.details.reason === "allowed-host" &&
    allowedRec.details.degraded === false &&
    allowedRec.details.policyConfigured === true,
);
check(
  "egress: egress.blocked хранит причину",
  blockedRec?.action === EGRESS_BLOCKED_ACTION &&
    blockedRec.details.allowed === false &&
    blockedRec.details.reason === "blocked-host" &&
    blockedRec.details.degraded === true,
);
check(
  "egress: аудит хранит адрес, хост и whitelist",
  blockedRec?.details.destination === "https://evil.example/exfiltrate" &&
    blockedRec.details.host === "evil.example" &&
    Array.isArray(blockedRec.details.allowedHosts) &&
    blockedRec.details.allowedHosts.join(",") === "api.github.com",
);
check(
  "egress: аудит привязан к задаче",
  egressRecords.every((r) => r.targetType === "task" && r.target === "scraper"),
);

clearAuditLog();
const noPolicyAttempt = recordEgressAttempt({ task: "plain", destination: "https://evil.example/x" });
check(
  "egress: без политики fail-open, но попытка всё равно аудируется",
  noPolicyAttempt.allowed === true &&
    noPolicyAttempt.reason === "no-policy" &&
    noPolicyAttempt.degraded === false &&
    noPolicyAttempt.policyConfigured === false,
);
const noPolicyRec = readAuditLog({}).records[0];
check(
  "egress: запись no-policy помечена как fail-open",
  noPolicyRec?.action === EGRESS_ALLOWED_ACTION &&
    noPolicyRec.details.reason === "no-policy" &&
    noPolicyRec.details.policyConfigured === false,
);

// Execute-path guard с аудитом.
clearAuditLog();
let networkCalls = 0;
const network = () => {
  networkCalls++;
  return "payload";
};
const okGuarded = await runEgressGuardedWithAudit(
  { task: "guarded", destination: "https://api.github.com/x", policy: egressPolicy },
  network,
);
check(
  "egress: guard с аудитом разрешает и выполняет действие",
  okGuarded.ok === true &&
    okGuarded.status === "ok" &&
    okGuarded.value === "payload" &&
    networkCalls === 1 &&
    typeof okGuarded.auditId === "number",
);
const blockedGuarded = await runEgressGuardedWithAudit(
  { task: "guarded", destination: "https://evil.example/x", policy: egressPolicy },
  network,
);
check(
  "egress: guard с аудитом блокирует без вызова действия",
  blockedGuarded.ok === false &&
    blockedGuarded.status === "degraded" &&
    blockedGuarded.degraded === true &&
    networkCalls === 1,
);
check("egress: guard auditing — 2 записи на 2 попытки", readAuditLog({}).records.length === 2);

// ARCH-6.2: сеть закрыта → деградация без тихого успеха.
const degraded = summarizeEgressRun([egressAllowed, egressBlocked]);
check(
  "egress: ARCH-6.2 success=false, status=degraded при блоке",
  degraded.success === false &&
    degraded.status === "degraded" &&
    degraded.degraded === true &&
    degraded.blocked === 1 &&
    degraded.allowed === 1 &&
    degraded.attempts === 2,
);
check(
  "egress: ARCH-6.2 отчёт отражает деградацию, а не тихий успех",
  degraded.report.includes("деградация") &&
    degraded.report.includes("evil.example") &&
    !/успех|success/i.test(degraded.report),
);
const healthy = summarizeEgressRun([egressAllowed]);
check(
  "egress: ARCH-6.2 без отказов — обычный успех",
  healthy.success === true &&
    healthy.status === "ok" &&
    healthy.degraded === false &&
    healthy.blocked === 0 &&
    healthy.report.includes("разрешены"),
);

// --- 8. ARCH-7.1: очередь ручных одобрений ------------------------------------
resetAuditCleanupThrottle();
clearAuditLog();

check(
  "ARCH-7.1: R2/R3 требуют одобрения, R0/R1 — нет",
  permissions.requiresApproval("R2") &&
    permissions.requiresApproval("R3") &&
    !permissions.requiresApproval("R0") &&
    !permissions.requiresApproval("R1") &&
    !permissions.requiresApproval("R9") &&
    !permissions.requiresApproval(undefined) &&
    permissions.APPROVAL_REQUIRED_RISK_CLASSES.join(",") === "R2,R3",
);

const approvalRequest = audit.requestApproval({
  requestId: "arch7-approve-1",
  taskName: "deploy-prod",
  riskClass: "R2",
  runRef: "run-ref-1",
  reason: "внешние эффекты",
  actor: "mcp",
  source: "test-audit",
});
check(
  "ARCH-7.1: запрос создан в статусе pending с полными полями",
  approvalRequest.requestId === "arch7-approve-1" &&
    approvalRequest.status === "pending" &&
    approvalRequest.decision === null &&
    approvalRequest.riskClass === "R2" &&
    approvalRequest.runRef === "run-ref-1" &&
    approvalRequest.reason === "внешние эффекты" &&
    approvalRequest.requestedBy === "mcp" &&
    !!approvalRequest.createdAt,
);

const duplicateRequest = audit.requestApproval({
  requestId: "arch7-approve-1",
  taskName: "deploy-prod",
  riskClass: "R2",
  runRef: "run-ref-1",
  reason: "другой текст — должен быть проигнорирован",
  actor: "gui",
});
check(
  "ARCH-7.1: повторный запрос не дублируется",
  duplicateRequest.requestId === approvalRequest.requestId &&
    duplicateRequest.status === "pending" &&
    duplicateRequest.reason === "внешние эффекты" &&
    readAuditLog({ action: audit.APPROVAL_REQUESTED_ACTION }).total === 1,
);
check(
  "ARCH-7.1: ожидающий запрос виден в очереди",
  audit.listPendingApprovals().some((item) => item.requestId === "arch7-approve-1"),
);

const approved = audit.decideApproval("arch7-approve-1", "approve", {
  actor: "gui",
  reason: "проверено вручную",
  source: "test-audit",
});
check(
  "ARCH-7.1: решение approve записано (кто/когда/решение/причина/ссылка)",
  approved.status === "approved" &&
    approved.decision === "approve" &&
    approved.decidedBy === "gui" &&
    !!approved.decidedAt &&
    approved.reason === "проверено вручную" &&
    approved.runRef === "run-ref-1",
);

const approvalDecisionRows = readAuditLog({ action: audit.APPROVAL_APPROVED_ACTION });
const approvalDecisionEvent = approvalDecisionRows.records[0] ?? {};
const approvalDecisionDetails = approvalDecisionEvent.details ?? {};
check(
  "ARCH-7.1: событие approval.approved содержит полный аудит решения",
  approvalDecisionRows.total === 1 &&
    approvalDecisionEvent.target === "arch7-approve-1" &&
    approvalDecisionEvent.actor === "gui" &&
    typeof approvalDecisionEvent.ts === "string" &&
    approvalDecisionDetails.decision === "approve" &&
    approvalDecisionDetails.reason === "проверено вручную" &&
    approvalDecisionDetails.runRef === "run-ref-1" &&
    approvalDecisionDetails.riskClass === "R2" &&
    approvalDecisionDetails.taskName === "deploy-prod",
);

const secondDecision = audit.decideApproval("arch7-approve-1", "reject", {
  actor: "http",
  reason: "передумали",
});
check(
  "ARCH-7.1: решения идемпотентны — первое побеждает, строк не добавляется",
  secondDecision.status === "approved" &&
    secondDecision.decidedBy === "gui" &&
    secondDecision.decision === "approve" &&
    readAuditLog({ action: audit.APPROVAL_APPROVED_ACTION }).total === 1 &&
    readAuditLog({ action: audit.APPROVAL_REJECTED_ACTION }).total === 0,
);
check(
  "ARCH-7.1: одобренный запрос ушёл из очереди ожидания",
  !audit.listPendingApprovals().some((item) => item.requestId === "arch7-approve-1") &&
    audit.listApprovals().some((item) => item.requestId === "arch7-approve-1" && item.status === "approved"),
);

audit.requestApproval({
  requestId: "arch7-reject-1",
  taskName: "destructive-cleanup",
  riskClass: "R3",
  runRef: "run-ref-2",
  actor: "mcp",
});
const rejected = audit.decideApproval("arch7-reject-1", "reject", {
  actor: "http",
  reason: "нет разрешения",
  source: "test-audit",
});
check(
  "ARCH-7.1: reject фиксируется со всеми атрибутами",
  rejected.status === "rejected" &&
    rejected.decision === "reject" &&
    rejected.decidedBy === "http" &&
    !!rejected.decidedAt &&
    rejected.reason === "нет разрешения" &&
    rejected.runRef === "run-ref-2" &&
    readAuditLog({ action: audit.APPROVAL_REJECTED_ACTION }).total === 1,
);

audit.requestApproval({
  requestId: "arch7-block-1",
  taskName: "blocked-mission",
  riskClass: "R2",
  runRef: "blocked-run-ref",
  actor: "cron",
});
audit.recordApprovalGateBlock({
  requestId: "arch7-block-1",
  taskName: "blocked-mission",
  riskClass: "R2",
  runRef: "blocked-run-ref",
  status: "pending",
  actor: "cron",
});
const waitingRows = readAuditLog({ action: audit.RUN_AWAITING_APPROVAL_ACTION });
check(
  "ARCH-7.2: аудит показывает ожидание одобрения до запуска",
  waitingRows.total === 1 &&
    waitingRows.records[0].target === "arch7-block-1" &&
    waitingRows.records[0].details.status === "pending" &&
    waitingRows.records[0].details.runRef === "blocked-run-ref" &&
    waitingRows.records[0].details.decision === null,
);
audit.recordApprovalGateBlock({
  requestId: "arch7-reject-1",
  taskName: "destructive-cleanup",
  riskClass: "R3",
  runRef: "run-ref-2",
  status: "rejected",
  reason: "нет разрешения",
});
const rejectedRows = readAuditLog({ action: audit.RUN_APPROVAL_REJECTED_ACTION });
check(
  "ARCH-7.2: аудит показывает отказ запуска по одобрению",
  rejectedRows.total === 1 &&
    rejectedRows.records[0].details.decision === "reject" &&
    rejectedRows.records[0].details.runRef === "run-ref-2",
);
check("ARCH-7.1: неизвестный запрос возвращает null", audit.getApproval("arch7-missing") === null);

// --- 8b. BN-5: гарантированный сброс буфера при выходе дочернего процесса -----
clearStructuredLogs();
const structuredLogUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "core", "structured-log.js"),
).href;
const exitFlushChild = spawnSync(
  process.execPath,
  [
    "-e",
    `(async () => {
       const m = await import(${JSON.stringify(structuredLogUrl)});
       m.appendStructuredLog({ event: "bn5.exit.flush", ts: "2026-01-06T00:00:00.000Z" });
       process.exit(0);
     })();`,
  ],
  { cwd: process.cwd(), env: process.env, encoding: "utf8" },
);
check(
  "BN-5: дочерний процесс с process.exit сбрасывает буфер структурированного лога",
  exitFlushChild.status === 0 &&
    readStructuredLogs({ event: "bn5.exit.flush" }).total === 1,
);
clearStructuredLogs();

// --- 8c. D13 (IM-12): корреляция логов по runId --------------------------------
appendStructuredLog({ event: "im12.started", runId: 4242, task: "corr", ts: "2026-01-07T00:00:00.000Z" });
appendStructuredLog({ event: "im12.hook", runId: 4242, task: "corr", ts: "2026-01-07T00:00:01.000Z" });
appendStructuredLog({ event: "im12.other", runId: 4243, task: "corr", ts: "2026-01-07T00:00:02.000Z" });
appendStructuredLog({ event: "im12.legacy", task: "corr", ts: "2026-01-07T00:00:03.000Z" });
const byRun = readStructuredLogs({ runId: 4242, event: "im12.started" });
check(
  "D13: фильтр /api/logs по runId возвращает только события запуска",
  byRun.total === 1 && byRun.records[0].runId === 4242,
);
check(
  "D13: записи без runId не попадают в выборку запуска",
  readStructuredLogs({ runId: 4242 }).records.every((r) => r.runId === 4242) &&
    readStructuredLogs({ runId: 9999 }).total === 0,
);
check(
  "D13: строковый runId из query-параметра работает так же",
  readStructuredLogs({ runId: "4242" }).total === 2,
);
const serverSourceIm12 = fs.readFileSync(new URL("./src/server.ts", import.meta.url), "utf8");
check(
  "D13: /api/logs принимает и возвращает runId в filters",
  serverSourceIm12.includes('runIdRaw = url.searchParams.get("runId")') &&
    serverSourceIm12.includes("runId: runIdRaw"),
);
clearStructuredLogs();

// --- 9. D10 (IM-9): экспорт аудита в CSV ---------------------------------------
const csv = await import("./dist/shared/audit-csv.js");
check("D10: escapeCsvCell экранирует кавычки и переводы строк", csv.escapeCsvCell('a,"b\nc"') === '"a,""b\nc"""');
check("D10: escapeCsvCell нейтрализует формулы", csv.escapeCsvCell("=SUM(A1)") === "'=SUM(A1)" && csv.escapeCsvCell("@cmd") === "'@cmd");
const csvText = csv.formatAuditCsv([
  { ts: "2026-11-24T10:00:00Z", action: "task.create", target: "deploy", actor: "mcp", details: { token: "SUPERSECRET", cron: "0 9 * * *" } },
]);
check("D10: CSV начинается с BOM и CRLF-заголовка", csvText.startsWith("\uFEFFtimestamp,action,targetType,target,actor,source,remote,details\r\n"));
check("D10: секреты в details маскируются", csvText.includes("token: ****") && !csvText.includes("SUPERSECRET"));
check("D10: имя файла содержит дату", /^audit-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.buildAuditFilename(new Date("2026-11-24T10:00:00Z"))));
const indexSource = fs.readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
const guiSourceAudit = fs.readFileSync(new URL("./src/gui.tsx", import.meta.url), "utf8");
check("D10: get_audit_log поддерживает format csv", indexSource.includes('format: z') && indexSource.includes('args.format === "csv"'));
check("D10: GUI выгружает CSV по кнопке", guiSourceAudit.includes('data-audit-export="csv"') && guiSourceAudit.includes("exportAuditCsvGui()"));

// --- 10. Итог ------------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nAudit: ${results.length - failures.length}/${results.length} проверок пройдено.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
