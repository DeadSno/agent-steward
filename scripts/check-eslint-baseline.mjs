/**
 * QA-A2.0 — храповик (ratchet) для предупреждений ESLint.
 *
 * Сравнивает текущие счётчики `eslint src` с зафиксированными в
 * `eslint-baseline.json` и падает, если где-то появилось НОВОЕ предупреждение.
 * Уменьшения разрешены и по ним baseline обновляется вручную:
 *
 *   npm run lint:baseline          # проверить (используется в CI)
 *   npm run lint:baseline:update   # перезаписать baseline после уменьшения
 *
 * Исторический старт эпика QA-A2 — 826 предупреждений; он лежит в поле
 * epicStartWarnings как справка. Гейт сравнивает с актуальными числами:
 * после QA-A2.1 их 543, и каждая следующая подзадача (A2.2-A2.5) опускает
 * планку. QA-A2.7 закрыл эпик с 0 warning / 0 error: гейт снят, CI использует
 * npm run lint:strict. Скрипт оставлен для истории и проверки регрессий.
 *
 * Запуск: node scripts/check-eslint-baseline.mjs [--update]
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { ESLint } from "eslint";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
export const baselinePath = path.join(root, "eslint-baseline.json");
export const EPIC_START_WARNINGS = 826;

/** Путь файла в baseline — всегда относительно корня и с прямыми слешами. */
export function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

/** Собирает счётчики из результатов ESLint. Чистая функция — тестируется отдельно. */
export function collect(results) {
  const byFile = {};
  const byRule = {};
  const byFileRule = {};
  let warnings = 0;
  let errors = 0;

  for (const result of results) {
    const file = relativePath(result.filePath);
    for (const message of result.messages) {
      if (message.severity === 2) errors += 1;
      else if (message.severity === 1) warnings += 1;

      const rule = message.ruleId ?? "(fatal)";
      byRule[rule] = (byRule[rule] ?? 0) + 1;
      byFile[file] = (byFile[file] ?? 0) + 1;
      byFileRule[file] ??= {};
      byFileRule[file][rule] = (byFileRule[file][rule] ?? 0) + 1;
    }
  }

  return { warnings, errors, byRule, byFile, byFileRule };
}

/**
 * Сравнивает текущие счётчики с baseline. Любой рост — регрессия.
 * Уменьшения разрешены и по ним baseline обновляется вручную.
 */
export function compare(current, baseline) {
  const problems = [];
  const allowedTotals = baseline.totals ?? { warnings: 0, errors: 0 };

  if (current.errors > 0) {
    problems.push(`ESLint errors: ${current.errors} (в baseline ${allowedTotals.errors})`);
  }
  if (current.warnings > allowedTotals.warnings) {
    problems.push(
      `всего warning: ${current.warnings} > baseline ${allowedTotals.warnings}`
    );
  }
  for (const [rule, count] of Object.entries(current.byRule ?? {})) {
    const allowed = baseline.byRule?.[rule] ?? 0;
    if (count > allowed) problems.push(`${rule}: ${count} > baseline ${allowed}`);
  }
  for (const [file, count] of Object.entries(current.byFile ?? {})) {
    const allowed = baseline.byFile?.[file] ?? 0;
    if (count > allowed) problems.push(`${file}: ${count} > baseline ${allowed}`);
  }
  for (const [file, rules] of Object.entries(current.byFileRule ?? {})) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline.byFileRule?.[file]?.[rule] ?? 0;
      if (count > allowed) {
        problems.push(`${file} [${rule}]: ${count} > baseline ${allowed}`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Собирает документ baseline из текущих результатов линтера. */
export function makeBaseline(current) {
  return {
    task: "QA-A2.0",
    epicStartWarnings: EPIC_START_WARNINGS,
    note:
      "QA-A2.7: эпик типизации закрыт — 0 warning / 0 error в src/. " +
      "Baseline-гейт снят: CI использует npm run lint:strict. " +
      "Профиль сохранён нулевым для истории.",
    totals: { warnings: current.warnings, errors: current.errors },
    byRule: current.byRule,
    byFile: current.byFile,
    byFileRule: current.byFileRule,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url);

if (isMain) {
  const eslint = new ESLint();
  const results = await eslint.lintFiles(["src"]);
  const current = collect(results);

  if (process.argv.includes("--update")) {
    fs.writeFileSync(baselinePath, JSON.stringify(makeBaseline(current), null, 2) + "\n");
    console.log(
      `QA-A2.0: baseline обновлён — ${current.warnings} warning, ${current.errors} error`
    );
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const { ok, problems } = compare(current, baseline);
  if (ok) {
    const saved = baseline.totals.warnings - current.warnings;
    console.log(
      `QA-A2.0: новых предупреждений нет — ${current.warnings} warning ` +
        `(baseline ${baseline.totals.warnings}${saved > 0 ? `, -${saved}` : ""})`
    );
    process.exit(0);
  }
  console.error("QA-A2.0: обнаружены новые предупреждения ESLint:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("Если уменьшение осознанное — npm run lint:baseline:update");
  process.exit(1);
}
