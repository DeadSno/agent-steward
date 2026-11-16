/**
 * Тесты Спринта 20: уведомления v2.
 * Запуск: node test-notifications-v2.mjs (после npm run build).
 * Чистые функции + локальный HTTP-сервер для webhook; планировщик ОС не нужен.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Временный конфиг-домен — до динамического импорта dist, чтобы PLUGIN_DIR
// вычислился уже с подменённым OPENCODE_SCHEDULER_HOME.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-notify-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

const notifications = await import("./dist/notifications.js");
const settingsModule = await import("./dist/settings.js");
const analytics = await import("./dist/core/analytics.js");
const { t, setLocale, resetI18n, messageIn } = await import("./dist/i18n.js");

const {
  buildDigestSummary,
  findStuckMatrixClones,
  formatDigestMessage,
  formatMatrixMessage,
  formatNotificationMessage,
  formatStuckMatrixMessage,
  isDigestDue,
  isTaskAllowed,
  renderTemplate,
  sendWebhook,
  wildcardMatch,
} = notifications;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const iso = (date) => date.toISOString();
const minutesAgo = (minutes) => iso(new Date(Date.now() - minutes * 60_000));

// --- 1. Фильтры задач: маски include/exclude ------------------------------
check("wildcardMatch: '*' совпадает с любым именем", wildcardMatch("*", "deploy-api"));
check("wildcardMatch: 'regen-*' совпадает с 'regen-api'", wildcardMatch("regen-*", "regen-api"));
check("wildcardMatch: 'regen-*' не совпадает с 'deploy'", !wildcardMatch("regen-*", "deploy"));
check("wildcardMatch: регистронезависимость", wildcardMatch("REGEN-*", "regen-api"));
check("wildcardMatch: '*-prod' в середине не матчится", !wildcardMatch("*-prod", "api-prod-x"));

check(
  "isTaskAllowed: пустой include = все задачи",
  isTaskAllowed("any-task", { include: [], exclude: [] })
);
check(
  "isTaskAllowed: include ограничивает набор",
  isTaskAllowed("deploy-api", { include: ["deploy-*"], exclude: [] }) &&
    !isTaskAllowed("cleanup", { include: ["deploy-*"], exclude: [] })
);
check(
  "isTaskAllowed: exclude важнее include",
  !isTaskAllowed("deploy-api", { include: ["deploy-*"], exclude: ["*-api"] })
);

// --- 2. Шаблоны сообщений ------------------------------------------------
check(
  "renderTemplate подставляет известные плейсхолдеры",
  renderTemplate("{task}: {status}", { task: "T", status: "success" }) === "T: success"
);
check(
  "renderTemplate оставляет неизвестные плейсхолдеры",
  renderTemplate("{task} {unknown}", { task: "T" }) === "T {unknown}"
);

const successPayload = { taskName: "Test", status: "success", durationMs: 2300 };
const errorPayload = {
  taskName: "Test",
  status: "error",
  durationMs: 2300,
  error: "Quality Gate провален",
};

check(
  "formatNotificationMessage: дефолтный успех",
  formatNotificationMessage(successPayload) ===
    t("notify.task.success", { task: "Test", duration: "2.3s", cost: "" })
);
check(
  "formatNotificationMessage: дефолтная ошибка",
  formatNotificationMessage(errorPayload) ===
    t("notify.task.error", {
      task: "Test",
      duration: "2.3s",
      error: t("notify.reason", { error: "Quality Gate провален" }),
      cost: "",
    })
);
check(
  "formatNotificationMessage: кастомные шаблоны",
  formatNotificationMessage(successPayload, {
    success: "[{emoji}] {task} ok за {duration}",
    error: "[{emoji}] {task} fail{error}",
  }) === "[✅] Test ok за 2.3s"
);

setLocale("en");
check(
  "formatNotificationMessage: текст следует за локалью",
  formatNotificationMessage(successPayload) ===
    t("notify.task.success", { task: "Test", duration: "2.3s", cost: "" })
);
resetI18n();

// --- 3. Уведомления о матрицах -------------------------------------------
check(
  "formatMatrixMessage: успех",
  formatMatrixMessage({ parentName: "M", status: "success", total: 3, success: 3, error: 0 }) ===
    t("notify.matrix.success", { parent: "M", total: 3, success: 3, error: 0 })
);
check(
  "formatMatrixMessage: partial",
  formatMatrixMessage({ parentName: "M", status: "partial", total: 3, success: 2, error: 1 }) ===
    t("notify.matrix.partial", { parent: "M", total: 3, success: 2, error: 1 })
);
check(
  "formatMatrixMessage: все клоны упали",
  formatMatrixMessage({ parentName: "M", status: "error", total: 2, success: 0, error: 2 }) ===
    t("notify.matrix.failedAll", { parent: "M", total: 2, success: 0, error: 2 })
);

// --- 4. Детектор зависших клонов -----------------------------------------
const running = [
  { id: 1, taskName: "m-matrix-a", startedAt: minutesAgo(90) },
  { id: 2, taskName: "m-matrix-b", startedAt: minutesAgo(10) },
  { id: 3, taskName: "plain-task", startedAt: minutesAgo(120) },
];
const parentByClone = new Map([
  ["m-matrix-a", "m"],
  ["m-matrix-b", "m"],
]);

const stuck = findStuckMatrixClones(running, parentByClone, new Date(), 60);
check("findStuckMatrixClones: порог 60 мин → только 90-минутный клон", stuck.length === 1 && stuck[0].id === 1);
check("findStuckMatrixClones: parentName взят из карты", stuck.length === 1 && stuck[0].parentName === "m");
check(
  "findStuckMatrixClones: порог 0 = выключено",
  findStuckMatrixClones(running, parentByClone, new Date(), 0).length === 0
);
const stuckStartedAt = minutesAgo(90);
check(
  "formatStuckMatrixMessage: содержит родителя, клона и минуты",
  formatStuckMatrixMessage({
    id: 1,
    cloneName: "m-matrix-a",
    parentName: "m",
    startedAt: stuckStartedAt,
    minutes: 90,
  }) ===
    t("notify.stuck", {
      parent: "m",
      clone: "m-matrix-a",
      startedAt: stuckStartedAt,
      minutes: 90,
    })
);

// --- 5. Дайджест: сводка и текст -----------------------------------------
const now = new Date("2026-11-13T12:00:00");
const digestRecords = [
  {
    taskName: "deploy",
    status: "success",
    startedAt: iso(new Date("2026-11-13T09:00:00")),
    tokens: 1000,
    costUsd: 0.01,
  },
  {
    taskName: "deploy",
    status: "error",
    startedAt: iso(new Date("2026-11-13T10:00:00")),
    error: "Quality Gate провален",
    tokens: 500,
    costUsd: 0.005,
  },
  {
    taskName: "deploy",
    status: "error",
    startedAt: iso(new Date("2026-11-13T11:00:00")),
    error: "Quality Gate провален",
    tokens: 500,
    costUsd: 0.005,
  },
];

const daily = buildDigestSummary(digestRecords, { frequency: "daily", now });
check("buildDigestSummary: total/success/error за сутки", daily.total === 3 && daily.success === 1 && daily.error === 2);
check("buildDigestSummary: период daily, окно 1 день", daily.period === "daily" && daily.windowDays === 1);
check("buildDigestSummary: топ ошибок агрегирован", daily.topErrors.length === 1 && daily.topErrors[0].count === 2);

const weekly = buildDigestSummary(digestRecords, { frequency: "weekly", now });
check("buildDigestSummary: weekly окно 7 дней", weekly.period === "weekly" && weekly.windowDays === 7);

const dailyText = formatDigestMessage(daily, now);
check(
  "formatDigestMessage: заголовок «за сутки»",
  dailyText.includes(
    t("notify.digest.title", {
      period: t("notify.digest.period.daily"),
      date: "13.11.2026",
    })
  )
);
check(
  "formatDigestMessage: строка запусков",
  dailyText.includes(
    t("notify.digest.runs", {
      total: 3,
      success: 1,
      error: 2,
      partial: 0,
      rate: daily.successRate,
    })
  )
);
check(
  "formatDigestMessage: стоимость и токены",
  dailyText.includes(
    t("notify.digest.cost", { cost: "$0.0200", tokens: 2000 })
  )
);
check(
  "formatDigestMessage: топ ошибок в тексте",
  dailyText.includes(
    t("notify.digest.topErrorRow", {
      message: "Quality Gate провален",
      count: 2,
    })
  )
);

const emptyText = formatDigestMessage(
  {
    period: "weekly",
    windowDays: 7,
    total: 2,
    success: 2,
    error: 0,
    partial: 0,
    successRate: 100,
    tokens: 10,
    costUsd: 0,
    topErrors: [],
  },
  now
);
check(
  "formatDigestMessage: «за неделю» и «Ошибок нет»",
  emptyText.includes(t("notify.digest.period.weekly")) &&
    emptyText.includes(t("notify.digest.noErrors"))
);

// --- 6. Расписание дайджеста ---------------------------------------------
const digestBase = { enabled: true, frequency: "daily", time: "09:00", lastSentAt: null };
check("isDigestDue: выключен → false", isDigestDue({ ...digestBase, enabled: false }, new Date("2026-11-13T12:00:00")) === false);
check(
  "isDigestDue: кривое время → false",
  isDigestDue({ ...digestBase, time: "25:99" }, new Date("2026-11-13T12:00:00")) === false
);
check(
  "isDigestDue: daily до времени → false",
  isDigestDue(digestBase, new Date("2026-11-13T08:00:00")) === false
);
check(
  "isDigestDue: daily после времени → true",
  isDigestDue(digestBase, new Date("2026-11-13T12:00:00")) === true
);
check(
  "isDigestDue: уже отправляли после цели → false",
  isDigestDue(
    { ...digestBase, lastSentAt: iso(new Date("2026-11-13T10:00:00")) },
    new Date("2026-11-13T12:00:00")
  ) === false
);
check(
  "isDigestDue: weekly после понедельника — догоняющая отправка",
  isDigestDue({ ...digestBase, frequency: "weekly" }, new Date("2026-11-13T12:00:00")) === true &&
    isDigestDue(
      { ...digestBase, frequency: "weekly", lastSentAt: iso(new Date("2026-11-09T10:00:00")) },
      new Date("2026-11-13T12:00:00")
    ) === false
);
check(
  "isDigestDue: weekly до понедельничного времени → false",
  isDigestDue({ ...digestBase, frequency: "weekly" }, new Date("2026-11-09T08:00:00")) === false
);

// --- 7. Настройки: дефолты и обратная совместимость ----------------------
const defaults = settingsModule.defaultNotifications();
check(
  "defaultNotifications: webhook с таймаутом и ретраями",
  defaults.webhook?.timeoutMs === 10000 &&
    defaults.webhook?.retryCount === 2 &&
    defaults.webhook?.retryDelayMs === 1000
);
check(
  "defaultNotifications: матрицы включены, порог 60 мин",
  defaults.matrix?.enabled === true && defaults.matrix?.stuckAfterMinutes === 60
);
check(
  "defaultNotifications: дайджест выключен, 09:00",
  defaults.digest?.enabled === false && defaults.digest?.time === "09:00"
);
const settingsFile = path.join(process.env.OPENCODE_SCHEDULER_HOME, "settings.json");
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    maxConcurrent: 1,
    winterMode: false,
    notifications: {
      enabled: true,
      onlyOnError: false,
      webhook: { enabled: true, url: "http://127.0.0.1:9/hook" },
    },
  }),
  "utf8"
);
const loaded = await settingsModule.loadSettings();
check(
  "loadSettings: старый settings.json получает новые поля",
  loaded.notifications.webhook?.timeoutMs === 10000 &&
    loaded.notifications.templates?.success.includes("{task}") === true &&
    Array.isArray(loaded.notifications.filters?.include) &&
    loaded.notifications.matrix?.stuckAfterMinutes === 60 &&
    loaded.notifications.digest?.frequency === "daily"
);
// Шаблоны, сохранённые как встроенные дефолты, не должны застывать на языке
// установки: при смене локали они берутся из текущего каталога.
setLocale("en");
fs.writeFileSync(
  settingsFile,
  JSON.stringify({
    notifications: {
      enabled: true,
      templates: {
        success: messageIn("ru", "notify.task.success"),
        error: messageIn("ru", "notify.task.error"),
      },
    },
  }),
  "utf8"
);
const migrated = await settingsModule.loadSettings();
check(
  "loadSettings: встроенные шаблоны переводятся на текущую локаль",
  migrated.notifications.templates?.success === t("notify.task.success") &&
    migrated.notifications.templates?.error === t("notify.task.error")
);
resetI18n();

// --- 8. Webhook: повторы и backoff ---------------------------------------
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/hook`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

let attempts = 0;
let retryResolved = false;
let retryError = null;
await withServer(
  (_req, res) => {
    attempts += 1;
    if (attempts < 3) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  },
  async (url) => {
    try {
      await sendWebhook(url, "hello", { retryCount: 2, retryDelayMs: 5 });
      retryResolved = true;
    } catch (err) {
      retryError = err;
    }
  }
);
check("sendWebhook: 500,500,200 → 3 попытки и успех", retryResolved && attempts === 3);

attempts = 0;
let clientError = null;
await withServer(
  (_req, res) => {
    attempts += 1;
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
  },
  async (url) => {
    try {
      await sendWebhook(url, "hello", { retryCount: 3, retryDelayMs: 5 });
    } catch (err) {
      clientError = err;
    }
  }
);
check("sendWebhook: 400 без повторов (1 попытка, ошибка)", attempts === 1 && clientError !== null);

// --- 9. Аналитика: топ ошибок -------------------------------------------
const errorReport = analytics.buildAnalytics(digestRecords, { days: 1, now, topLimit: 5 });
check(
  "buildAnalytics: errors агрегированы по тексту",
  errorReport.errors.length === 1 && errorReport.errors[0].count === 2
);
check(
  "buildAnalytics: topErrors отсортированы по количеству",
  errorReport.errors[0].message === "Quality Gate провален"
);

// --- Итог ----------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nNotifications v2: ${results.length - failures.length}/${results.length} проверок пройдено.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
