/**
 * QA-A2.7 — точечный тест снятого baseline-гейта ESLint.
 * Baseline сохранён нулевым для истории; CI проверяет npm run lint:strict.
 * Запуск: node test-eslint-baseline.mjs (или npm run test:eslint-baseline).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  collect,
  compare,
  makeBaseline,
  relativePath,
  EPIC_START_WARNINGS,
} from "./scripts/check-eslint-baseline.mjs";

const root = path.dirname(url.fileURLToPath(import.meta.url));
const results = [];
function check(name, fn, skip = false) {
  if (skip) {
    console.log(`SKIP ${name}: ESLint не установлен (нет node_modules)`);
    return;
  }
  try {
    fn();
    results.push(true);
    console.log(`OK   ${name}`);
  } catch (error) {
    results.push(false);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const baselinePath = path.join(root, "eslint-baseline.json");
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

check("QA-A2.0: старт эпика зафиксирован как 826", () => {
  assert.equal(baseline.epicStartWarnings, 826);
  assert.equal(EPIC_START_WARNINGS, 826);
});

check("QA-A2.7: baseline нулевой и согласован между всеми срезами", () => {
  assert.equal(baseline.totals.errors, 0);
  assert.equal(baseline.totals.warnings, 0);
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  assert.equal(sum(baseline.byRule), baseline.totals.warnings);
  assert.equal(sum(baseline.byFile), baseline.totals.warnings);
  assert.equal(
    Object.values(baseline.byFileRule).reduce((a, rules) => a + sum(rules), 0),
    baseline.totals.warnings
  );
  assert.deepEqual(baseline.byRule, {});
  assert.deepEqual(baseline.byFile, {});
  assert.deepEqual(baseline.byFileRule, {});
});

check("baseline: пути относительные и без обратных слешей", () => {
  assert.ok(Object.keys(baseline.byFile).every((p) => p.startsWith("src/")));
  assert.ok(Object.keys(baseline.byFile).every((p) => !p.includes("\\")));
});

check("collect: считает warning/error и группирует по файлу и правилу", () => {
  const a = path.resolve(root, "src/a.ts");
  const b = path.resolve(root, "src/db/b.ts");
  const got = collect([
    { filePath: a, messages: [{ severity: 1, ruleId: "r1" }, { severity: 1, ruleId: "r2" }] },
    { filePath: b, messages: [{ severity: 2, ruleId: "r1" }] },
  ]);
  assert.equal(got.warnings, 2);
  assert.equal(got.errors, 1);
  assert.equal(relativePath(a), "src/a.ts");
  assert.equal(got.byFile["src/a.ts"], 2);
  assert.equal(got.byRule.r1, 2);
  assert.equal(got.byFileRule["src/db/b.ts"].r1, 1);
});

const base = {
  totals: { warnings: 2, errors: 0 },
  byRule: { r1: 2 },
  byFile: { "src/a.ts": 2 },
  byFileRule: { "src/a.ts": { r1: 2 } },
};
const current = (warnings, errors = 0, overrides = {}) => ({
  warnings,
  errors,
  byRule: overrides.byRule ?? { r1: warnings },
  byFile: overrides.byFile ?? { "src/a.ts": warnings },
  byFileRule: overrides.byFileRule ?? { "src/a.ts": { r1: warnings } },
});

check("compare: равные и уменьшенные счётчики проходят", () => {
  assert.equal(compare(base, base).ok, true);
  assert.equal(compare(current(1), base).ok, true);
});

check("compare: новое предупреждение в существующем файле/правиле — регрессия", () => {
  const result = compare(current(3), base);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("src/a.ts [r1]")));
});

check("compare: новый файл и новое правило — регрессия", () => {
  assert.equal(
    compare(current(2, 0, { byRule: { r1: 1, r2: 1 }, byFileRule: { "src/a.ts": { r1: 1, r2: 1 } } }), base).ok,
    false
  );
  assert.equal(
    compare(current(2, 0, { byFile: { "src/new.ts": 2 }, byFileRule: { "src/new.ts": { r1: 2 } } }), base).ok,
    false
  );
});

check("compare: ошибки ESLint всегда проваливают гейт", () => {
  const result = compare(current(0, 1, { byRule: {}, byFile: {}, byFileRule: {} }), base);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => p.includes("errors")));
});

check("makeBaseline: сохраняет исторический старт и текущие totals", () => {
  const doc = makeBaseline(current(7));
  assert.equal(doc.epicStartWarnings, 826);
  assert.equal(doc.totals.warnings, 7);
  assert.equal(doc.totals.errors, 0);
});

check("QA-A2.7: CI использует lint:strict после Lint, baseline-гейт убран", () => {
  assert.ok(ci.includes("npm run lint:strict"));
  assert.ok(!ci.includes("npm run lint:baseline"));
  assert.ok(ci.indexOf("npm run lint:strict") > ci.indexOf("npm run lint\n"));
});

check("package.json: скрипт lint:strict и тест подключены в npm test", () => {
  assert.equal(pkg.scripts["lint:strict"], "eslint src --max-warnings=0");
  assert.equal(pkg.scripts["lint:baseline"], "node scripts/check-eslint-baseline.mjs");
  assert.equal(pkg.scripts["lint:baseline:update"], "node scripts/check-eslint-baseline.mjs --update");
  assert.equal(pkg.scripts["test:eslint-baseline"], "node test-eslint-baseline.mjs");
  assert.ok(pkg.scripts.test.includes("node test-eslint-baseline.mjs"));
});

check("QW-14.1: в flat-конфиге нет несуществующего @typescript-eslint/no-console", () => {
  const config = fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8");
  assert.ok(!config.includes('"@typescript-eslint/no-console"'));
  assert.ok(config.includes('"no-console": "off"'));
  assert.ok(!config.includes("База: eslint:recommended"));
  assert.ok(config.includes("@typescript-eslint/recommended-type-checked + stylistic-type-checked"));
});

// QA-D316-1: baseline «0 errors» должен совпадать с реальным прогоном ESLint.
// Воспроизведение: npm run lint падал с exit 1 при 23 errors, хотя
// eslint-baseline.json объявлял totals.errors = 0 и afterScript pl-commit.ps1
// никогда не коммитил/пушил результат задачи.
const eslintBin = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
check("QA-D316-1: реальный прогон ESLint (JSON-formatter) даёт 0 errors", () => {
  const result = spawnSync(process.execPath, [eslintBin, "src", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `ESLint завершился с кодом ${result.status}. stderr: ${(result.stderr ?? "").slice(0, 2000)}`,
  );
  let reports;
  try {
    reports = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Не удалось разобрать JSON-вывод ESLint: ${error.message}. stdout: ${(result.stdout ?? "").slice(0, 2000)}`,
    );
  }
  const errors = reports.reduce((sum, report) => sum + report.errorCount, 0);
  if (errors > 0) {
    const details = reports
      .filter((report) => report.errorCount > 0)
      .map((report) => ({
        file: path.relative(root, report.filePath).replaceAll("\\", "/"),
        messages: report.messages
          .filter((message) => message.severity === 2)
          .map((message) => `${message.ruleId}:${message.line}`),
      }));
    throw new Error(`ESLint нашёл ${errors} errors: ${JSON.stringify(details)}`);
  }
}, !fs.existsSync(eslintBin));

const failed = results.filter((ok) => !ok).length;
console.log(`\nESLint baseline: ${results.length - failed}/${results.length} проверок пройдено.`);
process.exit(failed > 0 ? 1 : 0);
