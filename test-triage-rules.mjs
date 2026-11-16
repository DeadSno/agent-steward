import {
  DEFAULT_TRIAGE_RULES,
  evaluateTriageRules,
} from "./dist/core/triage-rules.js";

let passed = 0;
let failed = 0;

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` — ${details}` : ""}`);
  }
}

const errorInput = {
  taskName: "nightly",
  status: "error",
  error: "Process exited with code 1",
  costUsd: 0.02,
};

// 1. Статус: встроенное правило error
const byStatus = evaluateTriageRules(errorInput);
check(
  "статус error: high",
  byStatus.matched === true && byStatus.ruleId === "status-error" && byStatus.verdict.severity === "high"
);

const byQuality = evaluateTriageRules({ ...errorInput, error: "Quality Gate failed: 3 tests" });
check(
  "ошибка Quality Gate: категория quality",
  byQuality.ruleId === "error-quality" && byQuality.verdict.category === "quality"
);

// 2. Статус: success даёт low
const bySuccess = evaluateTriageRules({ taskName: "nightly", status: "success" });
check(
  "статус success: low",
  bySuccess.ruleId === "status-success" && bySuccess.verdict.severity === "low"
);

// 3. Текст ошибки важнее статуса
const byError = evaluateTriageRules({ ...errorInput, error: "Request timeout after 30s" });
check(
  "ошибка timeout: категория и приоритет",
  byError.ruleId === "error-timeout" && byError.verdict.category === "timeout" && byError.action === "notify"
);

// 4. Задача: equals + skip
const taskRules = [
  {
    id: "skip-noisy",
    field: "task",
    operator: "equals",
    value: "Noisy Task",
    action: "skip",
    severity: "low",
    confidence: 0.95,
    reason: "Шумная задача.",
  },
];
const byTask = evaluateTriageRules({ taskName: "noisy task", status: "error" }, taskRules);
check(
  "задача equals без учёта регистра: skip",
  byTask.matched && byTask.action === "skip" && byTask.verdict.reason === "Шумная задача."
);

// 5. Задача: contains
const byContains = evaluateTriageRules(
  { taskName: "deploy-production", status: "success" },
  [{ field: "task", operator: "contains", value: "prod", severity: "medium" }]
);
check("задача contains: medium", byContains.matched && byContains.verdict.severity === "medium");

// 6. Ошибка: regex
const byRegex = evaluateTriageRules(
  { taskName: "test", status: "error", error: "HTTP 403 Forbidden" },
  [{ field: "error", operator: "regex", value: "http 40[13]", category: "permission" }]
);
check("ошибка regex: permission", byRegex.matched && byRegex.verdict.category === "permission");

// 7. Стоимость: gt
const byCost = evaluateTriageRules(
  { taskName: "expensive", status: "success", costUsd: 2.5 },
  [{ field: "cost", operator: "gt", value: 1, severity: "medium", reason: "Дорогой запуск." }]
);
check("стоимость gt: совпало", byCost.matched && byCost.verdict.severity === "medium");

// 8. Приоритет важнее порядка массива
// 7a. Встроенное правило стоимости
const byDefaultCost = evaluateTriageRules({
  taskName: "nightly",
  status: "success",
  costUsd: 2.5,
});
check(
  "встроенное правило cost: high",
  byDefaultCost.ruleId === "cost-high" &&
    byDefaultCost.verdict.severity === "high" &&
    byDefaultCost.action === "notify"
);

const byCostThreshold = evaluateTriageRules({
  taskName: "nightly",
  status: "success",
  costUsd: 1,
});
check("встроенное cost: порог $1 включён (gte)", byCostThreshold.ruleId === "cost-high");

const byCheapRun = evaluateTriageRules({
  taskName: "nightly",
  status: "success",
  costUsd: 0.01,
});
check(
  "встроенное cost: дешёвый запуск остаётся low",
  byCheapRun.ruleId === "status-success" && byCheapRun.verdict.severity === "low"
);

// 7b. Встроенное правило важного имени задачи
const byDefaultTask = evaluateTriageRules({ taskName: "Deploy-Production", status: "success" });
check(
  "встроенное правило task: high",
  byDefaultTask.ruleId === "task-important" &&
    byDefaultTask.verdict.severity === "high" &&
    byDefaultTask.action === "notify"
);

const byRoutineTask = evaluateTriageRules({ taskName: "nightly", status: "success" });
check("встроенное task: обычная задача остаётся low", byRoutineTask.ruleId === "status-success");

const allNotify = DEFAULT_TRIAGE_RULES.every((rule) => rule.action !== "skip");
check("встроенные правила не подавляют уведомления", allNotify);

// 8. Приоритет: большее значение важнее
const byPriority = evaluateTriageRules(
  { taskName: "deploy", status: "error" },
  [
    { id: "low", field: "status", operator: "equals", value: "error", severity: "low", priority: 1 },
    { id: "high", field: "status", operator: "equals", value: "error", severity: "high", priority: 100 },
  ]
);
check("приоритет: high раньше low", byPriority.ruleId === "high");

// 9. Пустой массив отключает встроенные правила
const empty = evaluateTriageRules(errorInput, []);
check(
  "пустые правила: нет совпадения и notify",
  empty.matched === false && empty.action === "notify" && empty.verdict.confidence === 0
);

// 10. Битый regex не роняет движок
const badRegex = evaluateTriageRules(errorInput, [
  { field: "error", operator: "regex", value: "[незакрытый" },
]);
check("битый regex: безопасный пропуск", badRegex.matched === false);

// 11. Встроенный набор не пуст
check("встроенные правила заданы", DEFAULT_TRIAGE_RULES.length >= 9);

console.log(`\nTriage rules: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exit(1);
