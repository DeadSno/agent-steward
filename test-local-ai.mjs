/**
 * Тесты Спринта 30.7: инструмент `manage_local_ai` и настройки локального
 * ассистента. Запуск: node test-local-ai.mjs (после npm run build).
 *
 * Сеть не используется: проверяются схема инструмента, чистые функции
 * слияния/сводки и сохранение настроек в изолированной temp-директории.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-local-ai-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { manageLocalAiSchema, runLocalAiTest } = await import("./dist/index.js");
const { applyLocalAiPatch, summarizeLocalAi, protocolFor } = await import(
  "./dist/core/local-ai.js"
);
const { saveSettings, loadSettings, defaultNotifications } = await import("./dist/settings.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const rejects = (value) => manageLocalAiSchema.safeParse(value).success === false;

// --- 1. Схема инструмента ----------------------------------------------------
check("get без полей валиден", manageLocalAiSchema.safeParse({ action: "get" }).success);
check(
  "test с полями модели валиден",
  manageLocalAiSchema.safeParse({
    action: "test",
    mode: "auto",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3:4b",
  }).success
);
check(
  "update с порогом и shadow валиден",
  manageLocalAiSchema.safeParse({
    action: "update",
    mode: "llm",
    timeoutMs: 60000,
    fallback: "rules",
    confidenceThreshold: 0.7,
    shadow: { enabled: true, days: 7 },
  }).success
);
check("неизвестный action отклонён", rejects({ action: "delete" }));
check("неизвестный mode отклонён", rejects({ action: "update", mode: "ml" }));
check("timeoutMs ниже 1000 отклонён", rejects({ action: "update", timeoutMs: 500 }));
check("timeoutMs выше 120000 отклонён", rejects({ action: "update", timeoutMs: 200000 }));
check("confidenceThreshold > 1 отклонён", rejects({ action: "update", confidenceThreshold: 1.5 }));
check("fallback notify валиден", !rejects({ action: "update", fallback: "notify" }));
check("устаревший fallback skip валиден", !rejects({ action: "update", fallback: "skip" }));
check("fallback вне перечня отклонён", rejects({ action: "update", fallback: "sometimes" }));
check("shadow.days = 0 отклонён", rejects({ action: "update", shadow: { days: 0 } }));

// --- 2. Протокол по baseUrl --------------------------------------------------
check(
  "Ollama-адрес даёт протокол ollama",
  protocolFor("http://127.0.0.1:11434") === "ollama"
);
check(
  "адрес с /v1 даёт протокол openai",
  protocolFor("http://localhost:1234/v1/") === "openai"
);

// --- 3. Слияние патча --------------------------------------------------------
const base = {
  ...defaultNotifications().triage,
  rules: [{ field: "status", operator: "equals", value: "error" }],
};

const trimmed = applyLocalAiPatch(base, { baseUrl: " http://127.0.0.1:8080// " });
check("baseUrl обрезается по пробелам и слешам", trimmed.settings.baseUrl === "http://127.0.0.1:8080");
check("изменённые поля перечислены", trimmed.changed.join(",") === "baseUrl");

const clamped = applyLocalAiPatch(base, { timeoutMs: 999999, confidenceThreshold: -1 });
check("timeoutMs зажимается в 120000", clamped.settings.timeoutMs === 120000);
check("confidenceThreshold зажимается в 0", clamped.settings.confidenceThreshold === 0);

// QA-P2.2: confidenceThreshold дробный (0..1), CLAMP НЕ должен округлять.
// Базовый порог по умолчанию — 0.6, поэтому для проверки changed берём 0.3.
const fractionalBase = { ...base, confidenceThreshold: 0.3 };
for (const value of [0.4, 0.5, 0.6, 0.75, 0.99]) {
  const patched = applyLocalAiPatch(fractionalBase, { confidenceThreshold: value });
  check(
    `QA-P2.2: confidenceThreshold ${value} сохраняется без округления`,
    patched.settings.confidenceThreshold === value && patched.changed.includes("confidenceThreshold"),
  );
}
const intsKept = applyLocalAiPatch(base, {
  timeoutMs: 12345.9,
  shadow: { enabled: true, days: 7.9 },
});
check(
  "QA-P2.2: timeoutMs и shadow.days остаются целыми",
  Number.isInteger(intsKept.settings.timeoutMs) && Number.isInteger(intsKept.settings.shadow.days),
);

const noChange = applyLocalAiPatch(base, {
  mode: base.mode,
  model: base.model,
  timeoutMs: base.timeoutMs,
});
check("патч без изменений даёт пустой changed", noChange.changed.length === 0);

const shadowPatched = applyLocalAiPatch(base, { shadow: { enabled: false, days: 30 } });
check("shadow.enabled меняется", shadowPatched.settings.shadow.enabled === false);
check("shadow.days меняются", shadowPatched.settings.shadow.days === 30);
check(
  "shadow-изменения попадают в changed",
  shadowPatched.changed.includes("shadow.enabled") && shadowPatched.changed.includes("shadow.days")
);

const rulesKept = applyLocalAiPatch(base, { model: "qwen3:8b" });
check("пользовательские правила не теряются", rulesKept.settings.rules?.length === 1);

// --- 4. Сводка ---------------------------------------------------------------
const summaryOff = summarizeLocalAi({ ...base, mode: "off" });
check("mode off → llmReady false", summaryOff.llmReady === false);

const summaryAuto = summarizeLocalAi({ ...base, mode: "auto", model: "qwen3:4b" });
check("mode auto с моделью → llmReady true", summaryAuto.llmReady === true);
check("сводка считает правила", summaryAuto.rules === 1);
check("сводка отдаёт протокол", summaryAuto.protocol === "ollama");
check("shadow без даты старта не активен", summaryAuto.shadowActive === false);

const summaryExpired = summarizeLocalAi({
  ...base,
  shadow: { enabled: true, days: 1, startedAt: new Date(Date.now() - 5 * 86400000).toISOString() },
});
check("истёкший shadow не активен", summaryExpired.shadowActive === false);

// --- 5. Сохранение настроек --------------------------------------------------
const current = await loadSettings();
const saved = await saveSettings({
  notifications: {
    ...current.notifications,
    triage: {
      ...current.notifications.triage,
      mode: "rules",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:4b",
      confidenceThreshold: 0.75,
    },
  },
});
check("сохранённый mode читается обратно", saved.notifications.triage.mode === "rules");
check("сохранённый порог читается обратно", saved.notifications.triage.confidenceThreshold === 0.75);

const reloaded = await loadSettings();
check("настройки триажа переживают перезагрузку", reloaded.notifications.triage.mode === "rules");
check(
  "shadow получает дату старта при сохранении",
  typeof reloaded.notifications.triage.shadow?.startedAt === "string"
);

const dataAfterSave = JSON.stringify(reloaded.notifications.triage);
check("в конфиг не попадает ничего лишнего", !dataAfterSave.includes("undefined"));

// --- 6. Статус подключения (Спринт 31.13) -----------------------------------
const offline = await runLocalAiTest({
  mode: "llm",
  baseUrl: "http://127.0.0.1:1",
  model: "qwen3:4b",
  timeoutMs: 1000,
});
check("недоступный провайдер: success=false", offline.success === false);
check(
  "недоступный провайдер: причина сеть/таймаут",
  ["network", "timeout", "http"].includes(String(offline.result.failure))
);
check("недоступный провайдер: протокол ollama", offline.result.protocol === "ollama");

// --- Итог --------------------------------------------------------------------
fs.rmSync(tempRoot, { recursive: true, force: true });
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
