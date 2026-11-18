// Спринт 36.5.b: Capability Map — слой 2 роутера (0 токенов).
//
// Проверяем:
//  - схема v7: таблица capability_map и индекс по success_rate;
//  - исходы гейта обновляют счётчики, success_rate и скользящие средние;
//  - last_10_runs хранит ровно 10 последних исходов, новые справа;
//  - решение по порогам: explore (мало данных) → review → local / cloud;
//  - фильтры и валидация входа;
//  - карта переживает переоткрытие БД;
//  - старая БД v5 поднимается миграцией и сразу работает с картой.
//
// Запуск: node test-capability-map.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-capability-"));
const dbPath = path.join(tempRoot, "scheduler.db");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_DB = dbPath;

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

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { SCHEMA_VERSION, getSchemaVersion } = await import("./dist/db/schema.js");
const capability = await import("./dist/db/capability-repo.js");
const DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;

initDb(dbPath);

// 1. Схема (capability_map с v6)
assert(SCHEMA_VERSION >= 6, `схема не ниже v6 (${SCHEMA_VERSION})`);
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, "PRAGMA user_version совпадает со SCHEMA_VERSION");
assert(capability.isCapabilityMapReady(), "таблица capability_map создана");
const columns = getDb()
  .prepare("PRAGMA table_info(capability_map)")
  .all()
  .map((column) => column.name);
for (const column of [
  "task_type",
  "model",
  "runs_total",
  "runs_passed",
  "success_rate",
  "avg_cost_usd",
  "avg_time_ms",
  "last_10_runs",
]) {
  assert(columns.includes(column), `колонка capability_map.${column} есть`);
}
const indexes = getDb()
  .prepare("PRAGMA index_list(capability_map)")
  .all()
  .map((index) => index.name);
assert(indexes.includes("idx_capability_success"), "индекс idx_capability_success есть");

// 2. Пустая карта честно говорит «нет данных»
assert(capability.getCapability("write_file") === null, "неизвестный тип: записи нет");
const emptyDecision = capability.decideCapabilityRoute("write_file");
assert(
  emptyDecision.target === "explore" && emptyDecision.reason === "no-data",
  "без данных решение — explore/no-data"
);
assert(emptyDecision.runsTotal === 0, "у explore runsTotal = 0");
assert(capability.listCapabilities().length === 0, "список пустой на чистой карте");

// 3. Первый успешный исход
const first = capability.recordCapabilityOutcome({
  taskType: "write_file",
  passed: true,
  costUsd: 0.02,
  timeMs: 1500,
});
assert(first.runsTotal === 1 && first.runsPassed === 1, "первый исход: 1 запуск, 1 успех");
assert(first.successRate === 1, "первый исход: success_rate = 1");
assert(first.avgCostUsd === 0.02, "первый исход: средняя стоимость 0.02");
assert(first.avgTimeMs === 1500, "первый исход: среднее время 1500 мс");
assert(first.last10Runs.length === 1 && first.last10Runs[0] === 1, "первый исход попал в last_10_runs");
assert(first.model === "local", "модель по умолчанию — local");

// 4. Второй исход — провал, средние пересчитываются
const second = capability.recordCapabilityOutcome({
  taskType: "write_file",
  passed: false,
  costUsd: 0.04,
  timeMs: 500,
});
assert(second.runsTotal === 2 && second.runsPassed === 1, "второй исход: 2 запуска, 1 успех");
assert(second.successRate === 0.5, "второй исход: success_rate = 0.5");
assert(
  Math.abs(second.avgCostUsd - 0.03) < 1e-9,
  `средняя стоимость — скользящее среднее (${second.avgCostUsd})`
);
assert(second.avgTimeMs === 1000, `среднее время — скользящее среднее (${second.avgTimeMs})`);
assert(
  JSON.stringify(second.last10Runs) === JSON.stringify([1, 0]),
  "last_10_runs: старые слева, новые справа"
);

// 5. Мало данных — всё ещё explore
const twoRuns = capability.decideCapabilityRoute("write_file");
assert(
  twoRuns.target === "explore" && twoRuns.reason === "no-data",
  "2 исхода меньше minRuns: решение остаётся explore"
);

// 6. Третий исход — стабильности нет, решение review
const third = capability.recordCapabilityOutcome({
  taskType: "write_file",
  passed: true,
});
assert(third.runsTotal === 3, "третий исход: 3 запуска");
assert(Math.abs(third.successRate - 2 / 3) < 1e-9, "третий исход: success_rate = 2/3");
const review = capability.decideCapabilityRoute("write_file");
assert(review.target === "review" && review.reason === "review", "0.67 → review");
assert(review.runsTotal === 3 && review.capability !== null, "решение возвращает данные карты");

// 7. Надёжный тип уходит в локаль
for (let index = 0; index < 4; index += 1) {
  capability.recordCapabilityOutcome({ taskType: "write_file", passed: true });
}
const reliable = capability.getCapability("write_file");
assert(reliable.runsTotal === 7 && reliable.runsPassed === 6, "7 запусков, 6 успехов");
const localDecision = capability.decideCapabilityRoute("write_file");
assert(
  localDecision.target === "local" && localDecision.reason === "local-reliable",
  `success_rate ${localDecision.successRate.toFixed(3)} ≥ 0.85 → local`
);

// 8. Кастомные пороги меняют решение без обучения
const strict = capability.decideCapabilityRoute("write_file", { localSuccess: 0.95, cloudFailure: 0.9 });
assert(strict.target === "cloud", "строгий порог 0.95/0.9 при success_rate 0.857 → cloud");
const patient = capability.decideCapabilityRoute("write_file", { minRuns: 1 });
assert(patient.target === "local", "minRuns = 1 не мешает решению local");

// 9. Безнадёжный тип эскалируется в облако
capability.recordCapabilityOutcome({ taskType: "jira_update_task", passed: true, model: "cloud" });
for (let index = 0; index < 4; index += 1) {
  capability.recordCapabilityOutcome({ taskType: "jira_update_task", passed: false, model: "cloud" });
}
const escalate = capability.decideCapabilityRoute("jira_update_task");
assert(
  escalate.target === "cloud" && escalate.reason === "escalate",
  "success_rate 0.2 ≤ 0.30 → escalate"
);
assert(
  escalate.capability?.model === "cloud",
  "карта помнит последнего исполнителя (cloud)"
);

// 10. Валидация входа
assertThrows(() => capability.recordCapabilityOutcome({ taskType: "", passed: true }), "пустой taskType отклоняется");
assertThrows(
  () => capability.recordCapabilityOutcome({ taskType: "x", passed: true, costUsd: -1 }),
  "отрицательная стоимость отклоняется"
);
assertThrows(
  () => capability.recordCapabilityOutcome({ taskType: "x", passed: "yes" }),
  "не-boolean passed отклоняется"
);
assertThrows(
  () => capability.decideCapabilityRoute("write_file", { localSuccess: 0.2, cloudFailure: 0.5 }),
  "localSuccess ≤ cloudFailure отклоняется"
);
assertThrows(() => capability.getCapability("  "), "пробельный taskType отклоняется");

// 11. last_10_runs ограничен десятью исходами
for (let index = 0; index < 12; index += 1) {
  capability.recordCapabilityOutcome({ taskType: "read_file", passed: index % 2 === 0 });
}
const recent = capability.getCapability("read_file");
assert(recent.runsTotal === 12, "last_10_runs: счётчик считает все 12 запусков");
assert(recent.last10Runs.length === 10, `last_10_runs хранит 10 исходов (${recent.last10Runs.length})`);
assert(recent.last10Runs.at(-1) === 0, "last_10_runs: последний исход справа");
assert(
  recent.last10Runs.filter((value) => value === 1).length === 5,
  "last_10_runs: пять успехов из десяти"
);

// 12. Нормализация типа и сортировка списка
capability.recordCapabilityOutcome({ taskType: "Run Tests", passed: true, costUsd: 0.01 });
assert(capability.getCapability(" run-tests ") !== null, "тип нормализуется при записи и чтении");
const listed = capability.listCapabilities();
assert(listed[0].taskType === "run_tests", `список сортирует по success_rate (${listed[0].taskType})`);
assert(
  listed.every((item, index) => index === 0 || listed[index - 1].successRate >= item.successRate),
  "список отсортирован по убыванию success_rate"
);
assert(capability.listCapabilities(1).length === 1, "limit работает");
assert(listed.some((item) => item.taskType === "run_tests"), "run_tests попал в список");

// 13. Карта переживает переоткрытие БД
closeDb();
initDb(dbPath);
const afterReopen = capability.getCapability("write_file");
assert(afterReopen?.runsTotal === 7, "после переоткрытия статистика на месте");
assert(
  capability.decideCapabilityRoute("write_file").target === "local",
  "после переоткрытия решение то же"
);

// 14. Старая БД v5 поднимается миграцией
closeDb();
const legacyPath = path.join(tempRoot, "legacy-v5.db");
const legacy = new DatabaseSync(legacyPath);
legacy.exec("PRAGMA user_version = 5");
legacy.close();
initDb(legacyPath);
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, `legacy v5 поднялась до v${SCHEMA_VERSION}`);
assert(capability.isCapabilityMapReady(), "миграция создала capability_map");
const legacyOutcome = capability.recordCapabilityOutcome({ taskType: "apply_diff", passed: true });
assert(legacyOutcome.runsTotal === 1, "карта работает сразу после миграции");
closeDb();

console.log(process.exitCode ? "\nЕсть провалы." : "\nВсе проверки Capability Map пройдены.");

