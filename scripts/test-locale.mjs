/**
 * Прогоняет тот же набор сюит, что `npm test`, с заданной локалью.
 *
 * Локаль задаётся переменной `OPENCODE_SCHEDULER_LOCALE`, которую читает
 * `src/i18n.ts` при загрузке: так один и тот же код проверяется в ru, en и zh
 * без правки settings.json.
 *
 * Запуск: node scripts/test-locale.mjs en
 * Локали: ru (по умолчанию), en, zh.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const locale = process.argv[2] ?? "en";

if (locale !== "ru" && locale !== "en" && locale !== "zh") {
  console.error(`Неизвестная локаль: ${locale}. Ожидается ru, en или zh.`);
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const suites = pkg.scripts.test
  .split("&&")
  .map((part) => part.trim().replace(/^node\s+/, ""))
  .filter(Boolean);

const failed = [];
for (const suite of suites) {
  const result = spawnSync(process.execPath, [suite], {
    cwd: root,
    env: { ...process.env, OPENCODE_SCHEDULER_LOCALE: locale },
    stdio: "inherit",
  });
  if (result.status !== 0) failed.push(suite);
}

if (failed.length > 0) {
  console.error(`\n${locale}: провалено ${failed.length} из ${suites.length}: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\n${locale}: все ${suites.length} сюит зелёные.`);
