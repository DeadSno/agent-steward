// S-2: публичный сабпат agent-steward/router — capability-роутинг,
// first_pass_rate и flywheel-обучение без БД и без вызова модели.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const router = await import("agent-steward/router");
const capability = await import("./dist/db/capability-repo.js");

let checks = 0;
const check = (name, fn) => {
  try {
    fn();
    checks++;
    console.log(`OK: ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

const approx = (actual, expected, eps = 1e-9) =>
  assert(Math.abs(actual - expected) <= eps, `${actual} !== ${expected}`);

check("S-2: package.json объявляет сабпат ./router с dist-файлами", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const entry = pkg.exports["./router"];
  assert(entry, "нет exports ./router");
  assert.equal(entry.default, "./dist/router.js");
  assert.equal(entry.types, "./dist/router.d.ts");
  assert(fs.existsSync(path.join(root, entry.default)), "нет dist/router.js");
  assert(fs.existsSync(path.join(root, entry.types)), "нет dist/router.d.ts");
});

check("S-2: константы роутера совпадают с SQLite-картой", () => {
  assert.equal(router.LOCAL_SUCCESS_THRESHOLD, capability.LOCAL_SUCCESS_THRESHOLD);
  assert.equal(router.CLOUD_FAILURE_THRESHOLD, capability.CLOUD_FAILURE_THRESHOLD);
  assert.equal(router.MIN_RUNS_FOR_DECISION, capability.MIN_RUNS_FOR_DECISION);
  assert.equal(router.RECENT_RUNS_LIMIT, capability.RECENT_RUNS_LIMIT);
  assert.equal(router.SUCCESS_HALF_LIFE_RUNS, 8);
  assert.equal(router.DECAY_WEIGHT, 0.7);
  assert.equal(router.FIRST_PASS_WEIGHT, 0.3);
});

check("S-2: decayedSuccessRate — пустая история и границы", () => {
  assert.equal(router.decayedSuccessRate([]), 0);
  assert.equal(router.decayedSuccessRate([1]), 1);
  assert.equal(router.decayedSuccessRate([0]), 0);
  assert.equal(router.decayedSuccessRate([2, 1]), 1); // некорректные значения отфильтрованы
});

check("S-2: decayedSuccessRate — свежие исходы весят больше старых", () => {
  const old = router.decayedSuccessRate([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  const fresh = router.decayedSuccessRate([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  assert(old < 0.5, `старые успехи дали ${old}`);
  assert(fresh > 0.5, `свежие успехи дали ${fresh}`);
});

check("S-2: формула затухания одна и в публичном роутере, и в capability-repo", () => {
  const runs = [1, 0, 1, 1, 0, 1];
  approx(router.decayedSuccessRate(runs), capability.decayedSuccessRate(runs));
  approx(router.effectiveReliability(0.6, 0.8), capability.effectiveReliability(0.6, 0.8));
  approx(router.effectiveReliability(0.6, 0.8), 0.7 * 0.6 + 0.3 * 0.8);
});

check("S-2: effectiveReliability ограничен отрезком [0,1]", () => {
  assert.equal(router.effectiveReliability(2, 2), 1);
  assert.equal(router.effectiveReliability(-1, -1), 0);
});

check("S-2: пустая запись обучения детерминирована и не мутирует аргумент", () => {
  const empty = router.emptyLearningRecord(" Code Review ");
  assert.equal(empty.taskType, "code_review");
  assert.equal(empty.model, "local");
  assert.equal(empty.runsTotal, 0);
  assert.deepEqual(empty.last10Runs, []);
  empty.last10Runs.push(1);
  assert.deepEqual(router.emptyLearningRecord("code_review").last10Runs, []);
});

check("S-2: flywheel-обучение не мутирует предыдущую запись", () => {
  const first = router.applyLearningOutcome(null, { taskType: "audit", passed: true });
  const second = router.applyLearningOutcome(first, {
    taskType: "audit",
    passed: false,
    attempts: 2,
  });
  assert.equal(first.runsTotal, 1);
  assert.equal(first.runsPassed, 1);
  assert.equal(second.runsTotal, 2);
  assert.equal(second.runsPassed, 1);
  assert.deepEqual(first.last10Runs, [1]);
  assert.deepEqual(second.last10Runs, [1, 0]);
  approx(first.firstPassRate, 1);
  approx(second.firstPassRate, 0.5);
});

check("S-2: firstPass по умолчанию = успех с первой попытки", () => {
  const okFirst = router.applyLearningOutcome(null, {
    taskType: "fp",
    passed: true,
    attempts: 1,
  });
  const okThird = router.applyLearningOutcome(okFirst, {
    taskType: "fp",
    passed: true,
    attempts: 3,
  });
  const failed = router.applyLearningOutcome(okThird, {
    taskType: "fp",
    passed: false,
    attempts: 1,
  });
  assert.equal(okFirst.firstPassCount, 1);
  assert.equal(okThird.firstPassCount, 1);
  assert.equal(failed.firstPassCount, 1, "провал не считается first-pass");
  assert.equal(okThird.firstPassRate, 0.5);
  assert.equal(failed.firstPassRate, 1 / 3);
});

check("S-2: явный firstPass=true разрешён только для успеха", () => {
  const explicit = router.applyLearningOutcome(null, {
    taskType: "explicit_fp",
    passed: true,
    attempts: 4,
    firstPass: true,
  });
  assert.equal(explicit.firstPassCount, 1);
  const failed = router.applyLearningOutcome(null, {
    taskType: "explicit_fp",
    passed: false,
    firstPass: true,
  });
  assert.equal(failed.firstPassCount, 0);
});

check("S-2: валидация некорректных исходов", () => {
  const bad = [
    { taskType: "", passed: true },
    { taskType: "x", passed: "true" },
    { taskType: "x", passed: true, attempts: 0 },
    { taskType: "x", passed: true, attempts: 1.5 },
    { taskType: "x", passed: true, firstPass: "yes" },
  ];
  for (const outcome of bad) {
    assert.throws(() => router.applyLearningOutcome(null, outcome));
  }
  const record = router.emptyLearningRecord("audit");
  assert.throws(() => router.applyLearningOutcome(record, { taskType: "other", passed: true }));
});

check("S-2: при малом числе прогонов решение explore/no-data", () => {
  for (const n of [0, 1, 2]) {
    let record = null;
    for (let i = 0; i < n; i++) {
      record = router.applyLearningOutcome(record, { taskType: "audit", passed: true });
    }
    const decision = router.decideLearningRoute("audit", record);
    assert.equal(decision.target, "explore");
    assert.equal(decision.reason, "no-data");
  }
});

check("S-2: стабильный успех уходит на local-reliable", () => {
  let record = null;
  for (let i = 0; i < 3; i++) {
    record = router.applyLearningOutcome(record, {
      taskType: "audit",
      passed: true,
      attempts: 1,
    });
  }
  const decision = router.decideLearningRoute("audit", record);
  assert.equal(decision.target, "local");
  assert.equal(decision.reason, "local-reliable");
  approx(decision.firstPassRate, 1);
  approx(decision.effectiveSuccessRate, 1);
});

check("S-2: нестабильный успех уходит в review", () => {
  let record = null;
  const outcomes = [true, true, true, false];
  for (const passed of outcomes) {
    record = router.applyLearningOutcome(record, { taskType: "audit", passed });
  }
  const decision = router.decideLearningRoute("audit", record);
  assert.equal(decision.target, "review");
  assert(decision.effectiveSuccessRate < router.LOCAL_SUCCESS_THRESHOLD);
  assert(decision.effectiveSuccessRate > router.CLOUD_FAILURE_THRESHOLD);
});

check("S-2: устойчивый провал эскалируется в cloud", () => {
  let record = null;
  for (let i = 0; i < 6; i++) {
    record = router.applyLearningOutcome(record, { taskType: "audit", passed: false });
  }
  const decision = router.decideLearningRoute("audit", record);
  assert.equal(decision.target, "cloud");
  assert.equal(decision.reason, "escalate");
  assert.equal(decision.firstPassRate, 0);
});

check("S-2: кастомные пороги проверяются", () => {
  assert.throws(() => router.decideLearningRoute("audit", null, { localSuccess: 0.2, cloudFailure: 0.5 }));
  assert.throws(() => router.normalizeThresholds({ minRuns: 0 }));
  assert.throws(() => router.normalizeThresholds({ localSuccess: -1 }));
  assert.deepEqual(router.normalizeThresholds({ localSuccess: 0.9, minRuns: 5 }), {
    localSuccess: 0.9,
    cloudFailure: 0.3,
    minRuns: 5,
  });
});

check("S-2: статические правила доступны и заморожены", () => {
  const rules = router.listStaticRouteRules();
  assert.equal(rules, router.STATIC_ROUTE_RULES);
  assert(Object.isFrozen(rules));
  assert(rules.length >= 7);
  assert.equal(router.normalizeTaskType(" Run-Tests "), "run_tests");
  assert.equal(router.routeStaticStep("RUN_TESTS").transport, "direct");
});

check("S-2: статическое правило выигрывает по умолчанию", () => {
  const r = router.createCapabilityRouter();
  const decision = r.route("Run Tests");
  assert.equal(decision.target, "local");
  assert.equal(decision.reason, "static-rule");
  assert.equal(decision.source, "static");
  assert.equal(decision.transport, "direct");
  assert.equal(decision.runsTotal, 0);
});

check("S-2: неизвестный тип без данных — explore", () => {
  const decision = router.createCapabilityRouter().route("some_new_task");
  assert.equal(decision.target, "explore");
  assert.equal(decision.reason, "no-data");
  assert.equal(decision.transport, undefined);
});

check("S-2: обученное решение перекрывает правило при learnedOverridesStatic", () => {
  const r = router.createCapabilityRouter({ learnedOverridesStatic: true });
  for (let i = 0; i < 3; i++) {
    r.learn({ taskType: "run_tests", passed: false });
  }
  const decision = r.route("run_tests");
  assert.equal(decision.target, "cloud");
  assert.equal(decision.source, "learned");
  assert.equal(decision.reason, "escalate");
  assert.equal(decision.transport, undefined);
});

check("S-2: learn возвращает решение и накапливает статистику", () => {
  const r = router.createCapabilityRouter();
  assert.equal(r.get("audit"), null);
  let last;
  for (let i = 0; i < 3; i++) {
    last = r.learn({ taskType: "audit", passed: true, attempts: 1 });
  }
  assert.equal(last.target, "local");
  assert.equal(r.get("audit").runsTotal, 3);
  assert.equal(r.get("AUDIT").firstPassCount, 3);
});

check("S-2: get возвращает копию записи", () => {
  const r = router.createCapabilityRouter();
  r.learn({ taskType: "audit", passed: true });
  const record = r.get("audit");
  record.last10Runs.push(0);
  assert.deepEqual(r.get("audit").last10Runs, [1]);
});

check("S-2: снимок детерминирован и версионирован", () => {
  const r = router.createCapabilityRouter();
  r.learn({ taskType: "zeta", passed: true });
  r.learn({ taskType: "alpha", passed: false });
  const snapshot = r.snapshot();
  assert.equal(snapshot.version, router.CAPABILITY_ROUTER_SNAPSHOT_VERSION);
  assert.deepEqual(Object.keys(snapshot.routes), ["alpha", "zeta"]);
  assert.deepEqual(snapshot.thresholds, { localSuccess: 0.85, cloudFailure: 0.3, minRuns: 3 });
  assert.equal(snapshot.learnedOverridesStatic, false);
});

check("S-2: restore переносит обучение в новый роутер", () => {
  const source = router.createCapabilityRouter();
  for (let i = 0; i < 3; i++) {
    source.learn({ taskType: "audit", passed: true });
  }
  const snapshot = source.snapshot();
  const restored = router.createCapabilityRouter({}, snapshot);
  assert.equal(restored.route("audit").target, "local");
  assert.equal(restored.get("audit").runsTotal, 3);
  const other = router.createCapabilityRouter();
  other.restore(snapshot);
  assert.deepEqual(other.snapshot(), snapshot);
  other.reset();
  assert.deepEqual(other.snapshot().routes, {});
  assert.equal(other.route("audit").target, "explore");
});

check("S-2: restore отклоняет неизвестную версию и чужие пороги", () => {
  const r = router.createCapabilityRouter();
  const snapshot = r.snapshot();
  assert.throws(() => router.createCapabilityRouter({}, { ...snapshot, version: 99 }));
  assert.throws(() =>
    r.restore({ ...snapshot, thresholds: { localSuccess: 0.9, cloudFailure: 0.3, minRuns: 3 } }),
  );
});

check("S-2: граф импортов сабпата не тянет БД и OpenCode", () => {
  const seen = new Set();
  const stack = [path.join(root, "dist/router.js")];
  let files = 0;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    files++;
    assert(
      !/\b(?:from|import|export)\s*[^;\n]*?["'](?:@opencode[^"']*|(?:[^"']*\/)?(?:\.\.\/)+db\/[^"']*)["']/.test(src),
      `${file}: внешняя зависимость`,
    );
    for (const match of src.matchAll(/from\s+["'](\.[^"']+\.js)["']/g)) {
      stack.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  assert(files >= 3, `обошли слишком мало модулей: ${files}`);
});

console.log(`test-router: ${checks} checks passed`);
