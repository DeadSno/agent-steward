/**
 * QA-A3 / BP-D08-1: нагрузочная проверка истории на 100K+ записей.
 *
 * Подтверждает два свойства больших объёмов истории:
 *   1. Фильтры `getHistory({taskName})` и `getHistory({status})` используют
 *      индексы (EXPLAIN QUERY PLAN → SEARCH USING INDEX), а не SCAN history.
 *   2. Запросы и ретеншн укладываются в разумное время — дашборд не висит.
 *
 * Данные вставляются прямым SQL в отдельной транзакции (100K recordRun()
 * вызовов был бы слишком медленным), но через ту же схему и БД, что и прод.
 *
 * Запуск: node test-history-load.mjs (после npm run build)
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

const home = createTestHomeSync("ws-history-load-");
process.env.APPDATA = home.appData;
process.env.OPENCODE_SCHEDULER_HOME = home.pluginDir;

const { initDb, getDb, closeDb } = await import("./dist/db/index.js");
const { getHistory, countHistory, pruneHistory } = await import("./dist/db/history-repo.js");
const { getTotals, getDailyMetrics } = await import("./dist/db/metrics-repo.js");

const ROWS = 100_500;
const TASK_COUNT = 50;
const QUERY_BUDGET_MS = 3000;
const PRUNE_BUDGET_MS = 10_000;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`OK   ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
}
function timed(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  console.log(`     ${label}: ${ms.toFixed(1)} мс`);
  return { result, ms };
}

initDb();
const db = getDb();

try {
  // --- 1. Наполнение --------------------------------------------------------
  const insert = db.prepare(`
    INSERT INTO history (task_name, status, started_at, finished_at, duration_ms,
                         error, tokens, cost_usd, model, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const base = Date.parse("2026-11-20T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;

  const seed = timed("вставка 100500 строк", () => {
    db.exec("BEGIN");
    try {
      for (let i = 0; i < ROWS; i += 1) {
        const task = `load-task-${i % TASK_COUNT}`;
        const status = i % 10 === 0 ? "error" : i % 23 === 0 ? "partial" : "success";
        const started = new Date(base - (i % 365) * day).toISOString();
        insert.run(
          task,
          status,
          started,
          started,
          1000 + (i % 5000),
          status === "error" ? "boom" : null,
          100 + (i % 900),
          (i % 100) / 1000,
          "load/model",
          `ws-${i % 7}`,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });

  check(`загружено ${ROWS} записей`, () => {
    assert.equal(countHistory(), ROWS);
    assert.ok(seed.ms < 60_000, `вставка заняла ${seed.ms.toFixed(0)} мс`);
  });

  // --- 2. Индексы -----------------------------------------------------------
  function plan(sql, ...params) {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
      .map((row) => String(row.detail ?? ""))
      .join(" | ");
  }

  const taskPlan = plan(
    "SELECT * FROM history WHERE lower(task_name) = lower(?) ORDER BY started_at DESC, id DESC LIMIT ?",
    "load-task-42",
    50,
  );
  check("фильтр по taskName использует индекс, а не SCAN", () => {
    console.log(`     plan: ${taskPlan}`);
    assert.match(taskPlan, /idx_history_task_lower/u, `ожидался индекс, план: ${taskPlan}`);
    assert.doesNotMatch(taskPlan, /SCAN history/u);
  });

  const statusPlan = plan(
    "SELECT * FROM history WHERE lower(status) = lower(?) ORDER BY started_at DESC, id DESC LIMIT ?",
    "success",
    50,
  );
  check("фильтр по status использует индекс, а не SCAN", () => {
    console.log(`     plan: ${statusPlan}`);
    assert.match(statusPlan, /idx_history_status_lower/u, `ожидался индекс, план: ${statusPlan}`);
    assert.doesNotMatch(statusPlan, /SCAN history/u);
  });

  // --- 3. Скорость и корректность выборок ----------------------------------
  const byTask = timed("getHistory(taskName)", () => getHistory("load-task-42", 50));
  check(`getHistory(taskName) < ${QUERY_BUDGET_MS} мс и возвращает 50 нужных записей`, () => {
    assert.ok(byTask.ms < QUERY_BUDGET_MS, `${byTask.ms.toFixed(1)} мс`);
    assert.equal(byTask.result.length, 50);
    assert.ok(byTask.result.every((r) => r.taskName === "load-task-42"));
  });

  const byStatus = timed("getHistory(status)", () => getHistory(null, 50, "success"));
  check(`getHistory(status) < ${QUERY_BUDGET_MS} мс и возвращает 50 успешных`, () => {
    assert.ok(byStatus.ms < QUERY_BUDGET_MS, `${byStatus.ms.toFixed(1)} мс`);
    assert.equal(byStatus.result.length, 50);
    assert.ok(byStatus.result.every((r) => r.status === "success"));
  });

  const all = timed("getHistory(null)", () => getHistory(null, 50));
  check(`getHistory(null) < ${QUERY_BUDGET_MS} мс`, () => {
    assert.ok(all.ms < QUERY_BUDGET_MS, `${all.ms.toFixed(1)} мс`);
    assert.equal(all.result.length, 50);
  });

  const totals = timed("getTotals", () => getTotals());
  check(`getTotals < ${QUERY_BUDGET_MS} мс и считает ${ROWS} записей`, () => {
    assert.ok(totals.ms < QUERY_BUDGET_MS, `${totals.ms.toFixed(1)} мс`);
    assert.equal(totals.result.total, ROWS);
    assert.ok(totals.result.success > 0 && totals.result.error > 0);
  });

  // --- 4. Ретеншн на больших объёмах ---------------------------------------
  const pruned = timed("pruneHistory(maxRecords=100)", () => pruneHistory({ maxRecords: 100 }));
  check(`pruneHistory < ${PRUNE_BUDGET_MS} мс и оставляет 100 записей`, () => {
    assert.ok(pruned.ms < PRUNE_BUDGET_MS, `${pruned.ms.toFixed(1)} мс`);
    assert.equal(pruned.result.kept, 100);
    assert.equal(countHistory(), 100);
  });

  // --- IM-7: дневная агрегация в SQL, без полного скана history ------------
  const daily = timed("getDailyMetrics(14)", () => getDailyMetrics(14));
  check(`getDailyMetrics < ${QUERY_BUDGET_MS} мс на ${ROWS} записях`, () => {
    assert.ok(daily.ms < QUERY_BUDGET_MS, `${daily.ms.toFixed(1)} мс`);
    assert.ok(daily.result.length > 0 && daily.result.length <= 14);
    assert.ok(daily.result.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)));
  });
  check("IM-7: план getDailyMetrics использует индекс started_at", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT substr(started_at,1,10) AS day, COUNT(*) FROM history WHERE started_at >= ? AND status <> 'running' AND task_name NOT LIKE '\\_\\_%' ESCAPE '\\' GROUP BY day",
      )
      .all(new Date(Date.now() - 14 * 86400000).toISOString());
    const text = JSON.stringify(plan);
    assert.ok(text.includes("idx_history_started_at"), text);
  });

  // --- 5. Граничные состояния после очистки --------------------------------
  check("после ретеншна фильтры работают без NaN/undefined", () => {
    const empty = getHistory("ghost-task", 10);
    assert.deepEqual(empty, []);
    const rest = getHistory(null, 10);
    assert.equal(rest.length, 10);
    assert.ok(rest.every((r) => typeof r.durationMs === "number"));
  });
} finally {
  closeDb();
  removeTestHomeSync(home.root);
}

console.log(`\nHistory load: ${passed} пройдено, ${failed} упало.`);
if (failed > 0) process.exitCode = 1;
