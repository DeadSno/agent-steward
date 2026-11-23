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
  "first_pass_count",
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

// 12b. B13.1: затухание успехов — свежие исходы весят больше старых
assert(capability.decayedSuccessRate([]) === 0, "decay: пустая история даёт 0");
assert(capability.decayedSuccessRate([1]) === 1, "decay: единственный свежий успех даёт 1");
const decayOldSuccess = capability.decayedSuccessRate([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
const decayNewSuccess = capability.decayedSuccessRate([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
assert(
  decayNewSuccess > decayOldSuccess,
  `decay: свежие успехи весят больше старых (${decayNewSuccess.toFixed(3)} > ${decayOldSuccess.toFixed(3)})`,
);

// 12c. B13.2: first_pass_rate считается по попыткам, а не по успеху
const firstPassOutcome1 = capability.recordCapabilityOutcome({
  taskType: "first_pass_audit",
  passed: true,
  attempts: 1,
});
assert(firstPassOutcome1.firstPassCount === 1, "first-pass: успех с attempt=1 засчитан");
assert(firstPassOutcome1.firstPassRate === 1, "first-pass: 1 из 1");
const firstPassOutcome2 = capability.recordCapabilityOutcome({
  taskType: "first_pass_audit",
  passed: true,
  attempts: 3,
});
assert(firstPassOutcome2.firstPassCount === 1, "first-pass: успех с attempt=3 не засчитан");
assert(firstPassOutcome2.successRate === 1, "first-pass: кумулятивный success_rate остаётся 1");
assert(firstPassOutcome2.firstPassRate === 0.5, "first-pass: 1 из 2 = 0.5");
const firstPassOutcome3 = capability.recordCapabilityOutcome({
  taskType: "first_pass_audit",
  passed: false,
});
assert(firstPassOutcome3.firstPassRate === 1 / 3, "first-pass: провал уменьшает долю до 1/3");
const firstPassOutcome4 = capability.recordCapabilityOutcome({
  taskType: "first_pass_audit",
  passed: true,
  attempts: 5,
  firstPass: true,
});
assert(firstPassOutcome4.firstPassCount === 2, "first-pass: явный firstPass=true засчитан");
assert(firstPassOutcome4.firstPassRate === 0.5, "first-pass: 2 из 4 = 0.5");
for (const [label, outcome] of [
  ["attempts=0", { taskType: "bad_attempts", passed: true, attempts: 0 }],
  ["firstPass=строка", { taskType: "bad_first_pass", passed: true, firstPass: "yes" }],
]) {
  let rejected = false;
  try {
    capability.recordCapabilityOutcome(outcome);
  } catch {
    rejected = true;
  }
  assert(rejected, `first-pass: невалидный ${label} отклонён`);
  assert(capability.getCapability(outcome.taskType) === null, `first-pass: ${label} не создал запись`);
}

// 12d. B13.4: старые успехи не перевешивают свежие провалы
for (let index = 0; index < 20; index += 1) {
  capability.recordCapabilityOutcome({
    taskType: "stale_success",
    passed: true,
    attempts: 1,
  });
}
for (let index = 0; index < 10; index += 1) {
  capability.recordCapabilityOutcome({
    taskType: "stale_success",
    passed: false,
  });
}
const stale = capability.getCapability("stale_success");
assert(stale.runsTotal === 30, "B13.4: 30 исходов в истории");
assert(stale.successRate > 0.6, "B13.4: кумулятивный success_rate всё ещё высокий");
assert(
  stale.last10Runs.length === 10 && stale.last10Runs.every((value) => value === 0),
  "B13.4: последние 10 исходов — провалы",
);
assert(stale.decayedSuccessRate < 0.5, "B13.4: затухающий success_rate ниже 0.5");
assert(stale.effectiveSuccessRate < 0.85, "B13.4: эффективная надёжность ниже 0.85");
const staleDecision = capability.decideCapabilityRoute("stale_success");
assert(staleDecision.target !== "local", "B13.4: свежие провалы не дают local-модель");
assert(
  staleDecision.effectiveSuccessRate === stale.effectiveSuccessRate,
  "B13.4: решение использует effectiveSuccessRate",
);

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

// 15. Старая карта v9 получает first_pass_count с backfill из runs_passed
const legacyCapPath = path.join(tempRoot, "legacy-v9-capability.db");
const legacyCap = new DatabaseSync(legacyCapPath);
legacyCap.exec(`
  PRAGMA user_version = 9;
  CREATE TABLE capability_map (
    task_type TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    runs_total INTEGER NOT NULL DEFAULT 0,
    runs_passed INTEGER NOT NULL DEFAULT 0,
    success_rate REAL NOT NULL DEFAULT 0,
    avg_cost_usd REAL NOT NULL DEFAULT 0,
    avg_time_ms REAL NOT NULL DEFAULT 0,
    last_10_runs TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO capability_map (
    task_type, model, runs_total, runs_passed, success_rate,
    avg_cost_usd, avg_time_ms, last_10_runs, created_at, updated_at
  ) VALUES (
    'legacy_cap', 'local', 5, 4, 0.8, 0, 0, '[1,1,0,1,1]',
    '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
  );
`);
legacyCap.close();
initDb(legacyCapPath);
assert(getSchemaVersion(getDb()) === SCHEMA_VERSION, `legacy v9 поднялась до v${SCHEMA_VERSION}`);
const migratedCap = capability.getCapability("legacy_cap");
assert(migratedCap !== null, "legacy v9: запись карты сохранена");
assert(migratedCap.firstPassCount === 4, "legacy v9: first_pass_count заполнен из runs_passed");
assert(migratedCap.firstPassRate === 0.8, "legacy v9: first_pass_rate = 4/5");
closeDb();

// 16. ARCH-3.1/3.2: flake/infra_fail не обучают карту; карантин с истечением.
const flakeDbPath = path.join(tempRoot, "flake-aware.db");
initDb(flakeDbPath);
const { recordGateOutcome, listGateOutcomes, verifyGateOutcomeChain } = await import(
  "./dist/db/runs-repo.js"
);
const future = new Date(Date.now() + 25 * 60 * 60 * 1000);

const flakeResult = capability.recordGateVerdict(
  {
    outcomeKey: "flake-1",
    taskType: "flake_task",
    gateKey: "npm test",
    verdict: "flake",
    attemptsToPass: 2,
    firstPass: false,
    reason: "прошёл со второй попытки",
  },
  new Date(),
);
assert(flakeResult.verdict === "flake", "flake-вердикт записан");
assert(flakeResult.capabilityUpdated === false, "flake НЕ обновляет capability_map");
assert(capability.getCapability("flake_task") === null, "карта пуста после flake");
const flakeRows = listGateOutcomes();
assert(
  flakeRows.some(
    (row) => row.verdict === "flake" && row.attemptsToPass === 2 && row.firstPass === 0,
  ),
  "ledger: verdict=flake, attempts_to_pass=2, first_pass=0",
);
assert(verifyGateOutcomeChain().ok, "hash-цепочка ledger не разорвана");

const infraResult = capability.recordGateVerdict(
  {
    outcomeKey: "infra-1",
    taskType: "flake_task",
    gateKey: "npm test",
    verdict: "infra_fail",
    attemptsToPass: 2,
    firstPass: false,
    reason: "sqlite database is locked",
  },
  new Date(),
);
assert(infraResult.verdict === "infra_fail", "infra_fail записан отдельно от flake");
assert(infraResult.capabilityUpdated === false, "infra_fail НЕ обновляет capability_map");
assert(capability.getCapability("flake_task") === null, "карта по-прежнему пуста после infra_fail");
assert(
  infraResult.warning !== null && /инфраструктур/.test(infraResult.warning),
  "infra_fail даёт отдельное предупреждение пользователю",
);

capability.recordGateVerdict(
  {
    outcomeKey: "flake-2",
    taskType: "flake_task",
    gateKey: "npm test",
    verdict: "flake",
    attemptsToPass: 2,
    firstPass: false,
  },
  new Date(),
);
assert(capability.isGateQuarantined("npm test"), "стабильно флакующий гейт ушёл в карантин");
assert(
  capability.getGateQuarantineWarning("npm test") !== null,
  "карантин даёт предупреждение для отчёта",
);
assert(
  capability.listGateQuarantines().some(
    (q) => q.gateKey === "npm test" && q.quarantinedUntil !== null && !q.expired,
  ),
  "карантин виден в снимке",
);
assert(
  !capability.isGateQuarantined("npm test", future),
  "карантин истекает сам (не блокирует навсегда)",
);

const stablePass = capability.recordGateVerdict(
  {
    outcomeKey: "stable-pass-1",
    taskType: "stable_task",
    gateKey: "npm test",
    verdict: "pass",
    attemptsToPass: 1,
    firstPass: true,
    costUsd: 0.05,
    timeMs: 200,
  },
  new Date(),
);
assert(stablePass.capabilityUpdated === true, "стабильный pass обновляет capability_map");
assert(
  capability.getCapability("stable_task")?.runsPassed === 1 &&
    capability.getCapability("stable_task")?.firstPassCount === 1,
  "стабильный pass: first-pass статистика на месте",
);
assert(!capability.isGateQuarantined("npm test"), "стабильный pass снимает карантин гейта");
const stableFail = capability.recordGateVerdict(
  {
    outcomeKey: "stable-fail-1",
    taskType: "stable_task",
    gateKey: "npm test",
    verdict: "fail",
    attemptsToPass: 1,
    firstPass: false,
  },
  new Date(),
);
assert(stableFail.capabilityUpdated === true, "стабильный fail обновляет capability_map");
assert(
  capability.getCapability("stable_task")?.runsTotal === 2 &&
    capability.getCapability("stable_task")?.successRate === 0.5,
  "регрессия: обычные pass/fail считаются как раньше",
);
assert(
  recordGateOutcome !== undefined && listGateOutcomes().length >= 5,
  "все вердикты попали в общий ledger gate_outcomes",
);
closeDb();

// 17. PL-96: цепочка проверяется полностью, а не только первые 1000 строк.
const pl96DbPath = path.join(tempRoot, "pl96-chain.db");
initDb(pl96DbPath);
const { readGateOutcomeLedger } = await import("./dist/db/runs-repo.js");
for (let i = 0; i < 1005; i += 1) {
  recordGateOutcome({
    outcomeKey: `pl96-${i}`,
    verdict: "pass",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  });
}
const fullChain = verifyGateOutcomeChain();
assert(fullChain.ok, "PL-96: цепочка из 1005 записей валидна");
assert(fullChain.length === 1005, "PL-96: проверены все 1005 записей, а не 1000");
const tailRow = listGateOutcomes(10000)[1004];
getDb()
  .prepare("UPDATE gate_outcomes SET evidence_path = ? WHERE id = ?")
  .run("forged-after-1000", tailRow.id);
const brokenChain = verifyGateOutcomeChain();
assert(!brokenChain.ok, "PL-96: подмена после 1000-й записи обнаруживается");
assert(brokenChain.brokenAt === 1004, "PL-96: разрыв найден в записи 1005");
assert(
  !readGateOutcomeLedger({ limit: 5 }).chain.ok,
  "PL-96: read-путь с limit=5 проверяет всю цепочку",
);
closeDb();

// 18. PL-98: автопроверка цепочки ledger-а пишется в аудит и доступна отчёту.
const pl98DbPath = path.join(tempRoot, "pl98-ledger.db");
initDb(pl98DbPath);
const { verifyGateLedgerIntegrity, getLastGateLedgerVerification } = await import(
  "./dist/core/audit.js"
);
for (let i = 0; i < 5; i += 1) {
  recordGateOutcome({
    outcomeKey: `pl98-${i}`,
    verdict: "pass",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
  });
}
const firstCheck = verifyGateLedgerIntegrity("startup");
assert(firstCheck.ok && firstCheck.length === 5, "PL-98: стартовая проверка нашла все 5 записей");
assert(firstCheck.source === "startup", "PL-98: источник проверки зафиксирован");
assert(firstCheck.auditId !== null, "PL-98: результат проверки записан в аудит");
assert(
  getLastGateLedgerVerification() === firstCheck,
  "PL-98: последний результат доступен без повторного чтения ledger-а",
);
const readVerifyAudit = () =>
  getDb()
    .prepare(
      "SELECT action, source, details_json FROM audit_log " +
        "WHERE action = 'gate_ledger.verify' ORDER BY id ASC",
    )
    .all();
const firstAudit = readVerifyAudit();
assert(firstAudit.length === 1, "PL-98: в аудите ровно одна запись gate_ledger.verify");
assert(
  firstAudit[0].source === "startup" && JSON.parse(firstAudit[0].details_json).ok === true,
  "PL-98: аудит сохранил источник и успешный результат",
);
const pl98Rows = listGateOutcomes(10000);
getDb()
  .prepare("UPDATE gate_outcomes SET evidence_path = ? WHERE id = ?")
  .run("forged-pl98", pl98Rows[pl98Rows.length - 1].id);
const secondCheck = verifyGateLedgerIntegrity("self-analysis:rpc");
assert(!secondCheck.ok, "PL-98: повторная проверка ловит подмену последней записи");
assert(secondCheck.brokenAt === 4, "PL-98: разрыв найден в последней (5-й) записи");
assert(
  secondCheck.source === "self-analysis:rpc" &&
    getLastGateLedgerVerification() === secondCheck,
  "PL-98: данные отчёта берутся из свежей проверки",
);
const secondAudit = readVerifyAudit();
assert(secondAudit.length === 2, "PL-98: обе проверки зафиксированы в журнале аудита");
const failedDetails = JSON.parse(secondAudit[1].details_json);
assert(
  failedDetails.ok === false && failedDetails.brokenAt === 4,
  "PL-98: в аудите есть details повреждённой цепочки",
);
closeDb();

console.log(process.exitCode ? "\nЕсть провалы." : "\nВсе проверки Capability Map пройдены.");

