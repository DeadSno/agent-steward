/**
 * Деталь 3.8 (F-4.1): тесты клиентской части обратной связи.
 * Запуск: npm run build && node test-feedback.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "as-feedback-"));
process.env.OPENCODE_SCHEDULER_HOME = tmp;

const {
  FEEDBACK_SCHEMA_VERSION,
  buildFeedbackPayload,
  buildReportPreview,
  descriptionHash,
  enqueueOutbox,
  evaluateAntispam,
  flushOutbox,
  listOutbox,
  redactText,
  reportFeedback,
  sendFeedbackWithRetry,
  validateFeedbackEndpoint,
} = await import("./dist/core/feedback.js");
const { closeDb } = await import("./dist/db/index.js");

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}
function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}
function okResponse(body = {}) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function errResponse(status, body = {}) {
  return { ok: false, status, text: async () => JSON.stringify(body) };
}
const settings = {
  enabled: true,
  endpoint: "https://feedback.example.workers.dev/report",
  includeLogs: false,
  contactEmail: "",
  maxPerHour: 6,
};

/* F-1.4 — редакция */
const redacted = redactText(
  "key sk-abcdefghijklmnopqrst ghpat ghp_abcdefghijklmnopqrst token 123456789:ABCdefGHIjklMNOpqrsTUVwxyzABCDEF " +
    "home C:\\Users\\Alice\\project mail alice@example.com secret SUPERSECRETVALUE",
  { secrets: ["SUPERSECRETVALUE"], home: "C:\\Users\\Alice", redactEmails: true },
);
check(
  "F-1.4 redaction: OpenAI/GitHub/bot tokens, manage_secrets, home, email",
  redacted.includes("[REDACTED:openai]") &&
    redacted.includes("[REDACTED:github]") &&
    redacted.includes("[REDACTED:bot]") &&
    redacted.includes("[REDACTED:secret]") &&
    (redacted.includes("~/project") || redacted.includes("~\\project")) &&
    redacted.includes("[EMAIL]") &&
    !redacted.includes("SUPERSECRETVALUE") &&
    !redacted.includes("alice@example.com"),
);

/* F-1.1 — payload */
const payload = buildFeedbackPayload(
  {
    description: "тест",
    reportId: "report-fixed-0001",
    taskName: "task",
    now: new Date("2026-11-20T10:00:00.000Z"),
  },
  { platform: "win32", release: "10.0", arch: "x64", node: "v22.0.0", pluginVersion: "0.0.5" },
);
check(
  "F-1.1 payload: schemaVersion/identifiers/OS/createdAt",
  payload.schemaVersion === FEEDBACK_SCHEMA_VERSION &&
    payload.reportId === "report-fixed-0001" &&
    payload.os.platform === "win32" &&
    payload.createdAt === "2026-11-20T10:00:00.000Z",
);
check(
  "F-1.1 payload: логи не попадают без явной передачи",
  payload.redactedLogs === undefined && payload.contactEmail === undefined,
);
check(
  "F-1.1 payload: описание ограничено по длине",
  buildFeedbackPayload({ description: "x".repeat(9000) }).description.length <= 4000,
);

/* F-1.3 — валидация endpoint */
check(
  "F-1.3 endpoint: https и localhost http принимаются",
  validateFeedbackEndpoint("https://example.com/report").ok &&
    validateFeedbackEndpoint("http://127.0.0.1:8787/report").ok,
);
check(
  "F-1.3 endpoint: удалённый http / учётные данные / javascript отклоняются",
  !validateFeedbackEndpoint("http://example.com/report").ok &&
    !validateFeedbackEndpoint("https://user:pass@example.com/report").ok &&
    !validateFeedbackEndpoint("javascript:alert(1)").ok &&
    !validateFeedbackEndpoint("").ok,
);

/* F-3.1 — preview */
const preview = buildReportPreview(payload);
check(
  "F-3.1 preview: показывает поля и reportId",
  preview.includes("schemaVersion: 1") && preview.includes("report-fixed-0001") && preview.includes("dryRun"),
);

/* F-1.2 — ретраи */
let attempts = 0;
const retried = await sendFeedbackWithRetry(
  payload,
  settings.endpoint,
  {
    retries: 2,
    baseDelayMs: 1,
    sleepFn: async () => {},
    fetchImpl: fakeFetch(() => {
      attempts++;
      return Promise.resolve(attempts < 3 ? errResponse(500) : okResponse({ issueUrl: "https://github.com/x/issues/1" }));
    }),
  },
);
check("F-1.2 retry: 2 ретрая после 500, затем успех", retried.ok && retried.attempts === 3 && !!retried.issueUrl);

let badRequestAttempts = 0;
const badRequest = await sendFeedbackWithRetry(payload, settings.endpoint, {
  retries: 2,
  baseDelayMs: 1,
  sleepFn: async () => {},
  fetchImpl: fakeFetch(() => {
    badRequestAttempts++;
    return Promise.resolve(errResponse(400, { error: "bad schema" }));
  }),
});
check("F-1.2 retry: 4xx не ретраится", !badRequest.ok && badRequestAttempts === 1);

const timeoutResult = await sendFeedbackWithRetry(payload, settings.endpoint, {
  retries: 0,
  sleepFn: async () => {},
  fetchImpl: fakeFetch(() => new Promise((_resolve, reject) => reject(new Error("aborted")))),
});
check("F-1.2 timeout/abort: ошибка не роняет процесс", !timeoutResult.ok && !!timeoutResult.error);

/* F-1.5 — dryRun и fail-open */
let networkCalls = 0;
const dry = await reportFeedback({
  settings,
  destination: "author",
  dryRun: true,
  description: "dry run check",
  fetchImpl: fakeFetch(() => {
    networkCalls++;
    return Promise.resolve(okResponse());
  }),
});
check(
  "F-1.5 dryRun: payload показан, сеть не вызвана",
  dry.mode === "dryRun" && !!dry.preview && networkCalls === 0,
);

const offline = await reportFeedback({
  settings: { ...settings, endpoint: "https://down.example/report" },
  destination: "author",
  description: `offline-${Date.now()}`,
  fetchImpl: fakeFetch(() => Promise.resolve(errResponse(503))),
  sleepFn: async () => {},
});
check(
  "F-1.6 outbox: при недоступном приёмнике отчёт сохраняется",
  offline.mode === "outbox" && listOutbox().some((row) => row.report_id === offline.reportId),
);

const before = listOutbox().length;
const flushed = await flushOutbox(settings, {
  fetchImpl: fakeFetch(() => Promise.resolve(okResponse({ issueUrl: "https://github.com/x/issues/2" }))),
  sleepFn: async () => {},
});
check(
  "F-1.6 outbox: повтор при старте доставляет и очищает очередь",
  flushed.processed === before && flushed.sent === before && listOutbox().length === 0,
);

/* F-1.7 — антиспам */
const base = new Date("2026-11-20T12:00:00.000Z");
const desc = "duplicate report";
const spamRows = [
  { at: "2026-11-20T11:58:00.000Z", hash: descriptionHash(desc) },
  { at: "2026-11-20T11:00:00.000Z", hash: "other" },
];
check(
  "F-1.7 antispam: дубль в окне 5 минут блокируется",
  evaluateAntispam(spamRows, desc, base).reason === "duplicate",
);
const many = Array.from({ length: 6 }, (_, i) => ({
  at: "2026-11-20T11:30:00.000Z",
  hash: `h${i}`,
}));
check(
  "F-1.7 antispam: лимит N отчётов в час",
  evaluateAntispam(many, "new report", base, 6).reason === "rate_limited",
);

/* F-3.2 — GUI/RPC/агент должны пробрасывать секцию feedback (регресс: чекбокс сбрасывался). */
const { manageSettingsSchema } = await import("./dist/index.js");
const { SchedulerRpc } = await import("./dist/rpc.js");
const rpcMethods = SchedulerRpc.methods;
check(
  "F-3.2 RPC-схемы: feedback есть в get_settings/save_settings (input и output)",
  Boolean(rpcMethods.get_settings.output.properties.feedback) &&
    Boolean(rpcMethods.save_settings.input.properties.feedback) &&
    Boolean(rpcMethods.save_settings.output.properties.feedback) &&
    rpcMethods.save_settings.input.additionalProperties === false,
);

const parsedFeedbackPatch = manageSettingsSchema.parse({
  action: "update",
  feedback: {
    enabled: true,
    endpoint: "https://feedback.example.workers.dev/report",
    includeLogs: false,
    contactEmail: "",
    maxPerHour: 6,
  },
});
check(
  "F-3.2 manage_settings: секция feedback проходит схему",
  parsedFeedbackPatch.feedback?.enabled === true &&
    parsedFeedbackPatch.feedback?.endpoint === "https://feedback.example.workers.dev/report",
);

const indexSource = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
const rpcStart = indexSource.indexOf("save_settings: async");
const rpcBlock = indexSource.slice(rpcStart, rpcStart + 3000);
check(
  "F-3.2 RPC save_settings: feedback принимается и возвращается в ответе",
  rpcStart !== -1 && (rpcBlock.match(/feedback/g) ?? []).length >= 4,
);

const settingsModule = await import("./dist/settings.js");
await settingsModule.saveSettings({
  feedback: {
    enabled: true,
    endpoint: "https://feedback.example.workers.dev/report",
    includeLogs: false,
    contactEmail: "",
    maxPerHour: 7,
  },
});
const loadedFeedback = (await settingsModule.loadSettings()).feedback;
check(
  "F-3.2 saveSettings/loadSettings: feedback сохраняется",
  loadedFeedback.enabled === true &&
    loadedFeedback.endpoint === "https://feedback.example.workers.dev/report" &&
    loadedFeedback.maxPerHour === 7,
);

closeDb();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // На Windows файл БД может ещё держаться — не критично для теста.
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
