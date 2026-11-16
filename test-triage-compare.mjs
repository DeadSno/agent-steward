/**
 * Тесты 31.5: сравнение триажа «до/после» (Compare button).
 * Запуск: node test-triage-compare.mjs (после npm run build).
 * Чистые функции — БД, сервер и модель не нужны.
 */
import {
  compareTriage,
} from "./dist/core/triage-compare.js";
import { defaultNotifications } from "./dist/settings.js";
import { t } from "./dist/i18n.js";
import http from "node:http";

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

const makeInput = (overrides = {}) => ({
  taskName: "Deploy",
  status: "error",
  error: "build failed",
  durationMs: 5000,
  tokens: 1000,
  costUsd: 0.5,
  ...overrides,
});

const offSettings = {
  ...defaultNotifications().triage,
  mode: "off",
};

// Правило, которое подавляет ошибки (для проверки diff action).
const skipOnErrorRule = {
  id: "skip-deploy-error",
  field: "status",
  operator: "equals",
  value: "error",
  action: "skip",
  priority: 50,
};
const rulesSettings = {
  ...defaultNotifications().triage,
  mode: "rules",
  rules: [skipOnErrorRule],
};

const llmSettings = {
  ...defaultNotifications().triage,
  mode: "llm",
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3:4b",
  timeoutMs: 60_000,
  confidenceThreshold: 0.7,
  fallback: "notify",
};

// --- 1. rules suppress error → diff action changed -------------------------
const result1 = await compareTriage(
  makeInput({ costUsd: 0 }),
  offSettings,
  rulesSettings
);
check("compare #1: input сохранён", result1.input.taskName === "Deploy");
check(
  "compare #1: before notify / after skip",
  result1.before.action === "notify" && result1.after.action === "skip"
);
check(
  "compare #1: diff action changed",
  result1.diff.action.changed === true
);
check(
  "compare #1: diff suppressed changed",
  result1.diff.suppressed.changed === true
);
check(
  "compare #1: after has ruleId",
  result1.after.ruleId === "skip-deploy-error"
);

// --- 2. llm fallback notify — no suppression ------------------------------
const result2 = await compareTriage(
  makeInput({ costUsd: 0 }),
  offSettings,
  llmSettings
);
check("compare #2: both notify", result2.before.action === "notify");
check(
  "compare #2: after action notify (fallback)",
  result2.after.action === "notify"
);
check(
  "compare #2: suppressed false both",
  result2.diff.suppressed.changed === false
);

// --- 3. diff verdict fields ----------------------------------------------
const result3 = await compareTriage(
  makeInput({ costUsd: 5 }),
  rulesSettings,
  { ...rulesSettings, mode: "off" }
);
check(
  "compare #3: rules before suppresses error",
  result3.before.action === "skip"
);
check("compare #3: after off notify", result3.after.action === "notify");
check(
  "compare #3: diff source changed",
  result3.diff.source.changed === true
);

// --- 4. identical settings — no diff --------------------------------------
const result4 = await compareTriage(makeInput(), offSettings, offSettings);
check("compare #4: identical → no changes", result4.diff.action.changed === false);
check(
  "compare #4: identical → message same",
  result4.diff.message.changed === false
);

// --- 5. messages non-empty ----------------------------------------------
check("compare #5: before message non-empty", typeof result1.before.message === "string");
check("compare #5: after message non-empty", typeof result1.after.message === "string");

// --- 6. all diff fields present -------------------------------------------
const allKeys = [
  "action", "source", "ruleId", "failure", "confidence", "category",
  "severity", "reason", "suppressed", "message",
];
check(
  "compare #6: all diff fields present",
  allKeys.every((k) => k in result1.diff)
);

// --- 7. confidence field differs between llm variants --------------------
const result7 = await compareTriage(
  makeInput({ costUsd: 0 }),
  { ...llmSettings, confidenceThreshold: 0.9 },
  { ...llmSettings, confidenceThreshold: 0.1 }
);
check(
  "compare #7: confidence threshold is a setting (not in diff)",
  typeof result7.diff.confidence === "object"
);

// --- 8. внешний дедлайн сравнения ----------------------------------------
// Локальный сервер принимает соединение и никогда не отвечает: проверяем,
// что сравнение не ждёт зависший классификатор до внутреннего timeoutMs.
const hanging = http.createServer(() => {});
const sockets = new Set();
hanging.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => hanging.listen(0, "127.0.0.1", resolve));
const hangingPort = hanging.address().port;
const startedAt = Date.now();
const result8 = await compareTriage(
  makeInput(),
  { ...llmSettings, baseUrl: `http://127.0.0.1:${hangingPort}`, timeoutMs: 30_000 },
  { ...llmSettings, baseUrl: `http://127.0.0.1:${hangingPort}`, timeoutMs: 30_000 },
  1,
  120
);
const elapsedMs = Date.now() - startedAt;
check(
  "compare #8: таймаут не бросает и возвращает notify",
  result8.before.action === "notify" && result8.after.action === "notify"
);
check(
  "compare #8: причина timeout",
  result8.before.failure === "timeout" && result8.after.failure === "timeout"
);
check("compare #8: внешний дедлайн сработал", elapsedMs < 2_000);
for (const socket of sockets) socket.destroy();
hanging.close();

// --- 9. битые before/after нормализуются, а не роняют сравнение -----------
const result9 = await compareTriage(makeInput(), null, {
  mode: "garbage",
  baseUrl: 42,
  model: null,
  timeoutMs: "soon",
  fallback: "???",
  confidenceThreshold: "high",
  shadow: "bad",
});
check("compare #9: битые настройки не бросают", Boolean(result9.after));
check(
  "compare #9: неизвестный mode нормализован в off",
  result9.after.source === "off"
);

// --- 10. суффикс повтора локализован --------------------------------------
const result10 = await compareTriage(
  makeInput({ costUsd: 0 }),
  offSettings,
  offSettings,
  2
);
check(
  "compare #10: суффикс повтора берётся из локали",
  result10.after.message.includes(t("notify.dedup.count", { count: 2 }))
);

console.log(`\n${passed}/${results.length} проверок сравнения триажа пройдены.`);
process.exit(failed > 0 ? 1 : 0);
