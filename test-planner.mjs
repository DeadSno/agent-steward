/**
 * Тесты роутера, слой 3: декомпозиция миссии (Sprint 36.5.c).
 *
 * Проверяем: эвристика не ходит в модель, модель вызывается только для
 * декомпозиции, маршрут шагов остаётся за слоями 1–2, неоднозначные типы
 * помечаются, а не выдумываются.
 */

import assert from "node:assert/strict";
import {
  decomposeHeuristically,
  guessTaskType,
  needsDecomposition,
  planMission,
  planMissionSync,
} from "./dist/core/router/planner.js";
import { routeStaticStep } from "./dist/core/router/rules.js";

let failed = false;

function ok(message, fn) {
  try {
    fn();
    console.log(`OK: ${message}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${message}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function okAsync(message, fn) {
  try {
    await fn();
    console.log(`OK: ${message}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL: ${message}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function throws(message, fn, pattern) {
  ok(message, () => {
    assert.throws(fn, pattern);
  });
}

// --- 1. Когда декомпозиция нужна, а когда нет --------------------------------
ok("одна известная задача не требует декомпозиции", () => {
  assert.equal(needsDecomposition("run_tests"), false);
});

ok("многострочная миссия требует декомпозиции", () => {
  assert.equal(needsDecomposition("прочитай файл\nпрогони тесты"), true);
});

ok("миссия с «затем» требует декомпозиции", () => {
  assert.equal(needsDecomposition("прочитай файл затем прогони тесты"), true);
});

ok("пустая миссия не требует декомпозиции", () => {
  assert.equal(needsDecomposition("   "), false);
});

// --- 2. Эвристика ------------------------------------------------------------
ok("эвристика разбивает миссию на три шага", () => {
  const steps = decomposeHeuristically("прочитай src/app.ts\nисправь ошибку\nпрогони тесты");
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((step) => step.taskType),
    ["read_file", "apply_diff", "run_tests"],
  );
});

ok("эвристика определяет PR и Jira", () => {
  assert.equal(guessTaskType("создай pull request в репозиторий"), "github_create_pr");
  assert.equal(guessTaskType("обнови тикет в jira"), "jira_update_task");
});

ok("неизвестный фрагмент помечается unknown, а не выдумывается", () => {
  const steps = decomposeHeuristically("сделай что-нибудь странное");
  assert.equal(steps[0].taskType, "unknown");
});

ok("эвристика снимает маркеры списка", () => {
  const steps = decomposeHeuristically("1. прочитай файл\n2) прогони тесты\n- посмотри логи");
  assert.equal(steps.length, 3);
  assert.equal(steps[2].taskType, "read_file");
  assert.ok(!steps[0].stepName.startsWith("1."));
});

ok("эвристика уважает maxSteps", () => {
  const steps = decomposeHeuristically("прочитай файл\nисправь ошибку\nпрогони тесты", 2);
  assert.equal(steps.length, 2);
});

throws("пустая миссия — ошибка", () => decomposeHeuristically("   "), /Пустая миссия/u);

// --- 3. planMission без модели ----------------------------------------------
ok("planMission без декомпозера работает эвристикой", () => {
  const plan = planMissionSync("прочитай файл\nпрогони тесты");
  assert.equal(plan.source, "heuristic");
  assert.deepEqual(
    plan.steps.map((step) => step.taskType),
    ["read_file", "run_tests"],
  );
});

ok("неоднозначные типы собраны без дублей", () => {
  const plan = planMissionSync("сделай странное\nсделай другое странное");
  assert.deepEqual(plan.ambiguousTaskTypes, ["unknown"]);
});

ok("известные типы не попадают в неоднозначные", () => {
  const plan = planMissionSync("прочитай файл\nпрогони тесты");
  assert.deepEqual(plan.ambiguousTaskTypes, []);
});

ok("маршрут шага не вычисляется декомпозером", () => {
  const plan = planMissionSync("прочитай файл");
  assert.deepEqual(Object.keys(plan.steps[0]).sort(), ["stepName", "taskType"]);
  assert.equal(routeStaticStep(plan.steps[0].taskType)?.executor, "local");
});

// --- 4. planMission с моделью ------------------------------------------------
await okAsync("модель вызывается один раз на миссию", async () => {
  const calls = [];
  const plan = await planMission("перенеси изменения в прод", {
    decomposer: {
      decompose(mission) {
        calls.push(mission);
        return [
          { stepName: "прочитать changelog", taskType: "Read File" },
          { stepName: "создать PR", taskType: "github_create_pr" },
        ];
      },
    },
  });
  assert.deepEqual(calls, ["перенеси изменения в прод"]);
  assert.equal(plan.source, "model");
  assert.deepEqual(
    plan.steps.map((step) => step.taskType),
    ["read_file", "github_create_pr"],
  );
});

await okAsync("асинхронный декомпозер поддерживается", async () => {
  const plan = await planMission("миссия", {
    decomposer: {
      async decompose() {
        return [{ stepName: "шаг", taskType: "run_tests" }];
      },
    },
  });
  assert.equal(plan.steps.length, 1);
});

await okAsync("модель уважает maxSteps", async () => {
  const plan = await planMission("миссия", {
    maxSteps: 1,
    decomposer: {
      decompose() {
        return [
          { stepName: "первый", taskType: "read_file" },
          { stepName: "второй", taskType: "run_tests" },
        ];
      },
    },
  });
  assert.equal(plan.steps.length, 1);
});

await okAsync("неизвестный тип от модели помечается для слоя 2", async () => {
  const plan = await planMission("миссия", {
    decomposer: { decompose: () => [{ stepName: "шаг", taskType: "custom_op" }] },
  });
  assert.deepEqual(plan.ambiguousTaskTypes, ["custom_op"]);
});

await okAsync("пустой план модели — ошибка", async () => {
  await assert.rejects(() => planMission("миссия", { decomposer: { decompose: () => [] } }), /пустой план/u);
});

await okAsync("шаг без типа — ошибка", async () => {
  await assert.rejects(
    () => planMission("миссия", { decomposer: { decompose: () => [{ stepName: "шаг", taskType: "  " }] } }),
    /без имени или типа/u,
  );
});

await okAsync("ошибка модели пробрасывается наверх", async () => {
  await assert.rejects(
    () =>
      planMission("миссия", {
        decomposer: {
          decompose() {
            throw new Error("локальная модель недоступна");
          },
        },
      }),
    /локальная модель недоступна/u,
  );
});

await okAsync("пустая миссия не доходит до модели", async () => {
  let called = false;
  await assert.rejects(
    () =>
      planMission("   ", {
        decomposer: {
          decompose() {
            called = true;
            return [];
          },
        },
      }),
    /Пустая миссия/u,
  );
  assert.equal(called, false);
});

// --- 5. Валидация ------------------------------------------------------------
throws("некорректный maxSteps отклоняется", () => planMissionSync("прочитай файл", { maxSteps: 0 }), /maxSteps/u);

ok("длинное имя шага обрезается", () => {
  const steps = decomposeHeuristically(`прочитай ${"очень ".repeat(40)}длинный файл`);
  assert.ok(steps[0].stepName.length <= 120);
});

if (!failed) {
  console.log("Router planner: все проверки пройдены.");
}
