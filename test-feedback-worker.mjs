/**
 * Деталь 3.8 (F-4.2): unit-тесты Cloudflare Worker — валидация, дедуп,
 * rate-limit, honeypot и создание GitHub Issue.
 * Запуск: node test-feedback-worker.mjs
 */
import {
  ISSUE_LABELS,
  handleReport,
  issueBody,
  issueTitle,
  validatePayload,
} from "./infra/feedback-worker/worker.js";

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

const valid = {
  schemaVersion: 1,
  reportId: "unit-test-report-0001",
  createdAt: "2026-11-20T10:00:00.000Z",
  pluginVersion: "0.0.5",
  os: { platform: "win32", release: "10.0", arch: "x64" },
  node: "v22.0.0",
  locale: "ru",
  profile: "default",
  description: "Кнопка не работает\nподробности",
  contactEmail: "user@example.com",
  redactedLogs: "line [REDACTED:openai]",
  metrics: { total: 5, success: 4, error: 1 },
};

const env = { GITHUB_TOKEN: "fake-token" };
let githubCalls = [];
const fakeFetch = async (url, init) => {
  githubCalls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ html_url: "https://github.com/DeadSno/agent-steward/issues/42" }), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
};
const post = (payload, headers = {}) =>
  new Request("https://feedback.example.workers.dev/report", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...headers },
    body: JSON.stringify(payload),
  });

/* Валидация */
check("F-2.1 validate: корректный payload проходит", validatePayload(valid).ok);
check(
  "F-2.1 validate: неверная версия схемы отклоняется",
  validatePayload({ ...valid, schemaVersion: 2 }).status === 400,
);
check(
  "F-2.1 validate: неверный email отклоняется",
  validatePayload({ ...valid, contactEmail: "not-an-email" }).status === 400,
);
check(
  "F-2.1 validate: слишком длинное описание → 413/400",
  validatePayload({ ...valid, description: "x".repeat(5000) }).ok === false,
);
check(
  "F-2.1 validate: нечисловые метрики отклоняются",
  validatePayload({ ...valid, metrics: { total: "many" } }).status === 400,
);

/* Заголовок/тело issue */
check(
  "F-2.3 title: префикс [user-report] и первая строка описания",
  issueTitle(valid).startsWith("[user-report] Кнопка не работает"),
);
check(
  "F-2.3 body: метаданные и отредактированные логи",
  issueBody(valid).includes(valid.reportId) &&
    issueBody(valid).includes("[REDACTED:openai]") &&
    issueBody(valid).includes("user@example.com"),
);

/* Создание issue */
const first = await handleReport(post(valid), env, null, fakeFetch);
const firstBody = await first.json();
check(
  "F-2.3/2.4 POST /report создаёт issue и возвращает issueUrl",
  first.status === 200 && firstBody.ok && firstBody.issueUrl.includes("/issues/42") && githubCalls.length === 1,
);
const sent = githubCalls[0].body;
check(
  "F-2.2 токен в Authorization, метки user-report/needs-triage",
  ISSUE_LABELS.every((label) => sent.labels.includes(label)),
);

/* Дедуп */
const second = await handleReport(post(valid), env, null, fakeFetch);
const secondBody = await second.json();
check(
  "F-2.3 дедуп по reportId: повтор не создаёт issue",
  second.status === 200 && secondBody.duplicate === true && githubCalls.length === 1,
);

/* Honeypot */
const bot = await handleReport(post({ ...valid, reportId: "bot-00000001", website: "https://spam.example" }), env, null, fakeFetch);
const botBody = await bot.json();
check(
  "F-2.1 honeypot: заполненное website даёт молчаливый 200 без issue",
  bot.status === 200 && botBody.ok && !botBody.issueUrl && githubCalls.length === 1,
);

/* Маршруты и методы */
const health = await handleReport(new Request("https://feedback.example.workers.dev/health"), env, null, fakeFetch);
check("F-2.1 GET /health → 200", health.status === 200);
const wrongMethod = await handleReport(
  new Request("https://feedback.example.workers.dev/report", { method: "DELETE" }),
  env,
  null,
  fakeFetch,
);
check("F-2.1 не-POST → 405", wrongMethod.status === 405);
const wrongPath = await handleReport(
  new Request("https://feedback.example.workers.dev/other", { method: "POST", body: "{}" }),
  env,
  null,
  fakeFetch,
);
check("F-2.1 неизвестный путь → 404", wrongPath.status === 404);

/* Rate-limit: 11-й запрос с того же IP получает 429 */
let limited = 0;
for (let i = 0; i < 11; i++) {
  const response = await handleReport(
    post({ ...valid, reportId: `rate-test-${String(i).padStart(4, "0")}` }),
    env,
    null,
    fakeFetch,
  );
  if (response.status === 429) limited++;
}
check("F-2.1 rate-limit по IP: 429 после лимита", limited > 0);

const noToken = await handleReport(
  post({ ...valid, reportId: "no-token-0001" }, { "cf-connecting-ip": "9.9.9.9" }),
  {},
  null,
  fakeFetch,
);
check("F-2.4 без GITHUB_TOKEN → 500 с понятным телом", noToken.status === 500);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
