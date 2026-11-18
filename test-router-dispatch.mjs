// Спринт 36.5.e: маршрутизация известных типов задач не вызывает модель.
//
// Проверяем:
//  - слой 1 отвечает ещё до инициализации БД и не создаёт записей в Capability Map;
//  - неизвестный тип уходит в Capability Map: без данных — explore;
//  - накопленные исходы дают local / cloud без участия модели;
//  - пустой тип — ошибка, а не молчаливый маршрут;
//  - dispatch.ts и rules.ts не импортируют planner/модель;
//  - 1000 маршрутов по статическим правилам укладываются в миллисекунды.
//
// Запуск: node test-router-dispatch.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { routeStep } from "./dist/core/router/dispatch.js";
import { initDb, closeDb } from "./dist/db/index.js";
import {
  listCapabilities,
  recordCapabilityOutcome,
} from "./dist/db/capability-repo.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-dispatch-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = path.join(tempRoot, "scheduler.db");

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const assertThrows = (fn, msg) => {
  try {
    fn();
  } catch {
    assert(true, msg);
    return;
  }
  assert(false, msg);
};

// 1. Статическое правило работает без БД.
const staticRoute = routeStep("Run Tests");
assert(staticRoute.taskType === "run_tests", "тип нормализован: Run Tests");
assert(staticRoute.source === "static", "известный тип решён слоем 1");
assert(staticRoute.target === "local", "run_tests исполняется локально");
assert(staticRoute.transport === "direct", "run_tests: транспорт direct");
assert(staticRoute.executor === "local", "run_tests: исполнитель local");
assert(staticRoute.reason === "static-rule", "причина static-rule");
assert(staticRoute.decision === undefined, "слой 2 не вызывался");

const prRoute = routeStep("github_create_pr");
assert(prRoute.transport === "mcp", "PR идёт через MCP");
assert(prRoute.executor === "local", "PR исполняется локально");

// 2. Инициализируем БД (явный путь: импорты выполняются раньше тела модуля,
// поэтому переменную окружения здесь использовать нельзя) и повторяем:
// карта не должна пополняться статикой.
initDb(path.join(tempRoot, "scheduler.db"));
const before = listCapabilities().length;
routeStep("read_file");
routeStep("apply_diff");
routeStep("jira_update_task");
const after = listCapabilities().length;
assert(before === 0 && after === 0, "статика не пишет в Capability Map");

// 3. Неизвестный тип: без данных — explore.
const unknown = routeStep("custom_migration");
assert(unknown.source === "capability", "неизвестный тип решает слой 2");
assert(unknown.target === "explore", "без данных — explore");
assert(unknown.reason === "no-data", "причина no-data");
assert(unknown.transport === null, "explore без транспорта");
assert(unknown.executor === null, "explore без исполнителя");

// 4. Три успеха — local без модели.
for (let index = 0; index < 3; index += 1) {
  recordCapabilityOutcome({ taskType: "stable_task", passed: true });
}
const stable = routeStep("stable_task");
assert(stable.target === "local", "три успеха дают local");
assert(stable.transport === "direct", "local ходит напрямую");
assert(stable.reason === "local-reliable", "причина local-reliable");
assert(stable.decision?.runsTotal === 3, "решение видит три исхода");

// 5. Три провала — cloud.
for (let index = 0; index < 3; index += 1) {
  recordCapabilityOutcome({ taskType: "hopeless_task", passed: false });
}
const hopeless = routeStep("hopeless_task");
assert(hopeless.target === "cloud", "три провала дают cloud");
assert(hopeless.transport === "cloud", "cloud ходит в облако");
assert(hopeless.executor === "cloud", "исполнитель cloud");
assert(hopeless.reason === "escalate", "причина escalate");

// 6. Один провал опускает долю до 0.75 — это review, а не local.
recordCapabilityOutcome({ taskType: "stable_task", passed: false });
const mixed = routeStep("stable_task");
assert(mixed.target === "review", "3 из 4 дают review");
assert(mixed.reason === "review", "причина review");

// 6a. Порог можно переопределить без модели.
const custom = routeStep("stable_task", { localSuccess: 0.7 });
assert(custom.target === "local", "порог 0.7 возвращает local");
assert(custom.reason === "local-reliable", "причина local-reliable");

// 7. Пустой тип — ошибка.
assertThrows(() => routeStep("   "), "пустой тип задачи — ошибка");

// 8. Исходники: модель в горячем пути не участвует.
const dispatchSource = fs.readFileSync(
  path.join("src", "core", "router", "dispatch.ts"),
  "utf8",
);
assert(
  !/import[^;]*from\s+["'][^"']*planner/i.test(dispatchSource),
  "dispatch.ts не импортирует planner",
);
const rulesSource = fs.readFileSync(
  path.join("src", "core", "router", "rules.ts"),
  "utf8",
);
assert(!/^import\s/m.test(rulesSource), "rules.ts по-прежнему без импортов");

// 9. Горячий путь статики.
const startedAt = performance.now();
for (let index = 0; index < 1000; index += 1) {
  routeStep("run_tests");
}
const elapsed = performance.now() - startedAt;
assert(elapsed < 100, `1000 статических маршрутов за ${elapsed.toFixed(1)} мс`);

closeDb();

if (process.exitCode === 1) {
  console.error("Router dispatch: есть падения.");
} else {
  console.log("Router dispatch: все проверки пройдены.");
}
