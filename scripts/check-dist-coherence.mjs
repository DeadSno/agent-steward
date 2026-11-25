/**
 * QA-DIST: smoke-проверка согласованности dist перед прогоном сюит.
 *
 * Журнал воспроизведения: общий `dist/` между worktree через junction привёл
 * к тому, что свежий `dist/core/execution.js` импортировал устаревшую версию
 * `dist/db/capability-repo.js` без `consumeExploreUsage`; падал импорт модуля,
 * хотя `npm run build` в своей worktree проходил. Проверяем реальный импорт
 * обоих модулей и наличие ожидаемого экспорта до запуска тестов.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  { file: "dist/core/execution.js", exportName: "buildExecutionPlan" },
  { file: "dist/db/capability-repo.js", exportName: "consumeExploreUsage" },
];

let failed = false;
for (const { file, exportName } of targets) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    console.error(`QA-DIST: нет ${file} — запустите npm run build`);
    failed = true;
    continue;
  }
  try {
    const module = await import(pathToFileURL(absolute).href);
    if (typeof module[exportName] !== "function") {
      console.error(`QA-DIST: ${file} не экспортирует ${exportName} () — dist рассинхронизирован`);
      failed = true;
    }
  } catch (error) {
    console.error(`QA-DIST: импорт ${file} упал: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log("QA-DIST: smoke импорта dist/core/execution.js и dist/db/capability-repo.js пройден");
