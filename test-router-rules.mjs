/**
 * Тест слоя 1 роутера (Спринт 36.5.a).
 *
 * Проверяет, что известные типы задач маршрутизируются таблицей статических
 * правил: 0 токенов, без БД и без вызова модели. Отдельно проверяется, что
 * модуль правил вообще не импортирует ничего (иначе горячий путь мог бы
 * случайно потянуть модель или БД).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  STATIC_ROUTE_RULES,
  isStaticTaskType,
  listStaticRouteRules,
  normalizeTaskType,
  routeStaticStep,
} from "./dist/core/router/rules.js";

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

// 1. Таблица соответствует документации
const expected = {
  read_file: ["direct", "local"],
  write_file: ["direct", "local"],
  run_tests: ["direct", "local"],
  apply_diff: ["direct", "local"],
  github_create_pr: ["mcp", "local"],
  jira_update_task: ["mcp", "cloud"],
};

check(
  "таблица правил содержит все документированные типы",
  STATIC_ROUTE_RULES.length === Object.keys(expected).length,
  `правил: ${STATIC_ROUTE_RULES.length}`
);

for (const [taskType, [transport, executor]] of Object.entries(expected)) {
  const rule = routeStaticStep(taskType);
  check(
    `${taskType} → ${transport} + ${executor}`,
    rule?.transport === transport && rule?.executor === executor,
    `получено: ${rule?.transport ?? "нет"} + ${rule?.executor ?? "нет"}`
  );
}

// 2. Идентичные типы в таблице не дублируются
const types = STATIC_ROUTE_RULES.map((rule) => rule.taskType);
check("типы задач уникальны", new Set(types).size === types.length);

// 3. Нормализация входа
check("пробелы и регистр нормализуются", normalizeTaskType("  Run Tests ") === "run_tests");
check("дефисы нормализуются", normalizeTaskType("apply-diff") === "apply_diff");
check("повторные подчёркивания схлопываются", normalizeTaskType("read__file") === "read_file");

check(
  "routeStaticStep терпит свободную форму",
  routeStaticStep("GitHub Create PR")?.transport === "mcp"
);
check(
  "routeStaticStep('') даёт undefined",
  routeStaticStep("") === undefined
);
check(
  "routeStaticStep('   ') даёт undefined",
  routeStaticStep("   ") === undefined
);

// 4. Неизвестный тип — это не ошибка, а сигнал слою 2/3
check(
  "неизвестный тип не маршрутизируется статикой",
  routeStaticStep("summarize_pdf") === undefined
);
check("isStaticTaskType: известный тип", isStaticTaskType("write_file") === true);
check("isStaticTaskType: неизвестный тип", isStaticTaskType("deploy_to_mars") === false);

// 5. Таблица не мутируется вызывающим кодом
let mutationBlocked = false;
try {
  // @ts-expect-error — проверяем именно защиту от записи во время исполнения
  STATIC_ROUTE_RULES.push({ taskType: "evil", transport: "cloud", executor: "cloud" });
} catch {
  mutationBlocked = true;
}
check("таблица правил заморожена", mutationBlocked || STATIC_ROUTE_RULES.length === 6);
check("listStaticRouteRules возвращает ту же таблицу", listStaticRouteRules() === STATIC_ROUTE_RULES);

// 6. Каждое правило описано (используется в логах и GUI)
check(
  "у каждого правила есть описание",
  STATIC_ROUTE_RULES.every((rule) => typeof rule.description === "string" && rule.description.length > 10)
);

// 7. Горячий путь не тянет модель и БД: у модуля правил нет импортов
const rulesSource = readFileSync(
  fileURLToPath(new URL("./src/core/router/rules.ts", import.meta.url)),
  "utf8"
);
check(
  "rules.ts не импортирует модель, БД и транспорт",
  !/^\s*import\s/m.test(rulesSource),
  "найден import в rules.ts"
);

// 8. Маршрутизация 1000 шагов не вызывает побочных эффектов и укладывается в бюджет
const startedAt = Date.now();
for (let index = 0; index < 1000; index++) {
  routeStaticStep(index % 2 === 0 ? "run_tests" : "jira_update_task");
}
const elapsedMs = Date.now() - startedAt;
check(
  "1000 маршрутизаций быстрее 50 мс",
  elapsedMs < 50,
  `заняло ${elapsedMs} мс`
);

console.log(`\nИтог: ${passed} пройдено, ${failed} провалено.`);
if (failed > 0) {
  process.exitCode = 1;
}
