/**
 * Тесты Спринта 14, часть 2: Dry-Run (simulatePipeline).
 * Запуск: node test-dry-run.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-dry-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { recordRun } = await import("./dist/db/history-repo.js");
const { simulatePipeline, workingDirectoryDriftWarning, isFrequentCron } = await import("./dist/core/dry-run.js");
const { t } = await import("./dist/i18n.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

initDb();

try {
  // Дерево: root -> [build, lint]; build -> lint.
  await saveTask({
    name: "Root", schedule: "0 9 * * *", prompt: "Запусти релиз",
    dependsOn: ["Build"],
    beforeScript: "git pull", afterScript: "git push", qualityGate: "npm test",
    allowedTools: ["read"], deniedTools: ["bash"],
  });
  await saveTask({ name: "Build", schedule: "*/5 * * * *", prompt: "Собери проект npm run build", dependsOn: ["Lint"], workingDirectory: tempRoot });
  await saveTask({ name: "Lint", schedule: "*/2 * * * *", prompt: "Проверь код" });
  await saveTask({
    name: "Danger", schedule: "* * * * *", prompt: "rm -rf / и git push --force",
  });
  await saveTask({
    name: "EventRoot", prompt: "event root", triggerType: "mcp-event",
    mcpEvent: { server: "test", event: "probe" },
  });

  // История для оценок: 2 успешных запуска Lint по 10 с, 1000 токенов.
  const base = Date.now();
  recordRun("Lint", "success", new Date(base - 20000).toISOString(), 10000, null, undefined, 1000);
  recordRun("Lint", "success", new Date(base - 10000).toISOString(), 10000, null, undefined, 1000);

  // 1. Не найденная задача.
  let threw = "";
  try {
    await simulatePipeline("Nope");
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check("неизвестная задача бросает ошибку", threw === t("dryRun.taskNotFound", { task: "Nope" }));

  // 2. Топологический порядок.
  const report = await simulatePipeline("Root");
  check("отчёт успешен", report.success === true && report.taskName === "Root");
  const order = report.tasks.map((t) => t.name);
  check("топологический порядок: Lint перед Build",
    order.indexOf("Lint") < order.indexOf("Build") && order.indexOf("Build") < order.indexOf("Root"));
  // PL-26/PL-30: trigger — реальный triggerType, entryMode — режим входа.
  check("корневая задача имеет trigger=cron и entryMode=manual",
    report.tasks.find((t) => t.name === "Root")?.trigger === "cron" &&
    report.tasks.find((t) => t.name === "Root")?.entryMode === "manual");
  check("зависимости имеют trigger=cron и entryMode=dag",
    report.tasks.find((t) => t.name === "Build")?.trigger === "cron" &&
    report.tasks.find((t) => t.name === "Build")?.entryMode === "dag" &&
    report.tasks.find((t) => t.name === "Lint")?.trigger === "cron" &&
    report.tasks.find((t) => t.name === "Lint")?.entryMode === "dag");
  check("trigger совпадает с triggerDetails.type",
    report.tasks.every((t) => t.trigger === t.triggerDetails?.type));

  const eventReport = await simulatePipeline("EventRoot");
  check("PL-26: trigger=mcp-event для event-задачи",
    eventReport.tasks[0]?.trigger === "mcp-event" &&
    eventReport.tasks[0]?.triggerDetails?.type === "mcp-event" &&
    eventReport.tasks[0]?.entryMode === "manual");

  // 3. Команды.
  const rootItem = report.tasks.find((t) => t.name === "Root");
  check("команда содержит opencode run --model-free", rootItem.command.startsWith("opencode run"));
  check("roleScoped в отчёте", rootItem.roleScoped?.allowed?.join(",") === "read" && rootItem.roleScoped?.denied?.join(",") === "bash");
  check("pre/post/QG в отчёте", rootItem.preFlight === "git pull" && rootItem.postFlight === "git push" && rootItem.qualityGate === "npm test");

  // 4. Оценки по истории.
  const lintItem = report.tasks.find((t) => t.name === "Lint");
  check("оценка длительности из истории (10 с)", lintItem.estimatedDurationSec === 10);
  check("оценка токенов из истории (1000)", lintItem.estimatedTokens === 1000);
  check("оценка стоимости из токенов", Math.abs(lintItem.estimatedCostUsd - 0.003) < 1e-9);

  // 5. Задача без истории — null + предупреждение.
  const buildItem = report.tasks.find((t) => t.name === "Build");
  check("нет истории -> null оценки", buildItem.estimatedDurationSec == null && buildItem.estimatedTokens == null && buildItem.estimatedCostUsd == null);
  check("предупреждение об отсутствии истории", report.warnings.includes(`[Build] ${t("dryRun.noHistory")}`));

  // 6. Опасные паттерны.
  const danger = await simulatePipeline("Danger");
  check("предупреждение rm -rf /", danger.warnings.some((w) => w.includes("rm -rf /")));
  check("предупреждение git push --force", danger.warnings.some((w) => w.includes("git push --force")));

  // 7. Несуществующая рабочая директория.
  await saveTask({ name: "Ghost", schedule: "* * * * *", prompt: "x", workingDirectory: "Z:/definitely/not/exist" });
  const ghost = await simulatePipeline("Ghost");
  check("предупреждение о несуществующей директории", ghost.warnings.includes(`[Ghost] ${t("dryRun.cwdMissing", { path: "Z:/definitely/not/exist" })}`));

  // 8. Топологические суммы.
  check("totals длительность = 10 с", report.totals.estimatedDurationSec === 10);
  check("totals токены = 1000", report.totals.estimatedTokens === 1000);

  // 9. Реального запуска нет: команда — только текст.
  check("симуляция не исполняет команды", report.tasks.every((t) => typeof t.command === "string"));

  // 10. PL-8.1: дрейф HEAD относительно createdAt задачи.
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-drift-"));
  execFileSync("git", ["init", "-q", gitRoot]);
  execFileSync("git", ["-C", gitRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", gitRoot, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", gitRoot, "commit", "-q", "--allow-empty", "-m", "init"]);
  const driftDef = {
    name: "Drift", schedule: "* * * * *", prompt: "x",
    workingDirectory: gitRoot, createdAt: "2020-01-01T00:00:00Z",
  };
  const drift = workingDirectoryDriftWarning(driftDef, gitRoot);
  check("PL-8.1: предупреждение при HEAD новее createdAt", typeof drift === "string" && drift.includes("PL-8.1"));
  check("PL-8.1: без createdAt предупреждения нет", workingDirectoryDriftWarning({ ...driftDef, createdAt: "" }, gitRoot) === null);

  // 11. QV-9: частый cron + тяжёлый промпт — антипаттерн.
  check("QV-9: '* * * * *' — частый cron", isFrequentCron("* * * * *") === true);
  check("QV-9: '*/5 * * * *' — частый cron", isFrequentCron("*/5 * * * *") === true);
  check("QV-9: '0,5,10 * * * *' — частый cron", isFrequentCron("0,5,10 * * * *") === true);
  check("QV-9: '0 4 * * *' — не частый cron", isFrequentCron("0 4 * * *") === false);
  check("QV-9: '0 4 1 1 *' — не частый cron", isFrequentCron("0 4 1 1 *") === false);
  await saveTask({ name: "HeavyMinute", schedule: "* * * * *", prompt: "opencode run --model x \"analyze\"" });
  const heavy = await simulatePipeline("HeavyMinute");
  check("QV-9: предупреждение про частый cron + opencode run", heavy.warnings.some((w) => w.includes("QV-9")));
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDry-run: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
