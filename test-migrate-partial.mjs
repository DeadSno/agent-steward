/**
 * Регрессия P3-34: legacy history.json со статусом "partial" должен
 * переноситься в SQLite как partial, а не превращаться в error.
 *
 * Запуск: node test-migrate-partial.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-migrate-partial-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const pluginDir = process.env.OPENCODE_SCHEDULER_HOME;
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(
  path.join(pluginDir, "history.json"),
  JSON.stringify(
    [
      {
        taskName: "Partial Legacy",
        status: "partial",
        startedAt: "2026-04-01T10:00:00.000Z",
        finishedAt: "2026-04-01T10:00:05.000Z",
        durationMs: 5000,
        tokens: 42,
        costUsd: 0.004,
      },
      {
        taskName: "Failed Legacy",
        status: "error",
        startedAt: "2026-04-01T11:00:00.000Z",
        finishedAt: "2026-04-01T11:00:05.000Z",
        durationMs: 5000,
        error: "boom",
      },
    ],
    null,
    2,
  ),
);

let passed = 0;
let failed = 0;
const check = (name, cond) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
};

const { initDb, closeDb } = await import("./dist/db/index.js");
const { migrateJsonToDb } = await import("./dist/db/migrate.js");
const historyRepo = await import("./dist/db/history-repo.js");
const metricsRepo = await import("./dist/db/metrics-repo.js");

initDb();
try {
  const migration = await migrateJsonToDb();
  check("миграция выполнена", migration.migrated && migration.history === 2);

  const rows = historyRepo.getHistory("Partial Legacy", 10);
  check("history.json partial → SQLite partial", rows.length === 1 && rows[0].status === "partial");

  const metrics = metricsRepo.getMetrics("Partial Legacy");
  check("метрики: partial = 1", metrics?.partial === 1);
  check("метрики: error = 0", metrics?.error === 0);

  const totals = metricsRepo.getTotals();
  check('итоги: partial = 1, error = 1 (только "Failed Legacy")', totals.partial === 1 && totals.error === 1);
} finally {
  closeDb();
}

console.log(`\n${passed}/${passed + failed} проверок миграции partial пройдено.`);
process.exit(failed > 0 ? 1 : 0);
