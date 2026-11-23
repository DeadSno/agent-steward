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

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { saveTask } = await import("./dist/db/tasks-repo.js");
const { recordRun } = await import("./dist/db/history-repo.js");
const {
  simulatePipeline, workingDirectoryDriftWarning, isFrequentCron, minimumCronIntervalMinutes,
  scopeModulesFromText, qualityGateCoverageWarning, MODULE_REQUIRED_TEST_SUITES,
  qualityGateLintWarning, REQUIRED_LINT_CHECKS,
  qualityGateDocsScopeWarning, roadmapDuplicateIds,
  recommendModelForTask, preflightSkipRiskWarnings,
} = await import("./dist/core/dry-run.js");
const {
  modelAvailabilityWarning,
  chooseFallbackModel,
  normalizeModelKey,
} = await import("./dist/core/opencode-cli.js");
const { createToolHandlers } = await import("./dist/index.js");
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

  // 5. PL-123 (а): задача без своей истории, но в глобальной истории есть
  //    успешные прогоны Lint -> не-null оценки и пометка об источнике.
  const buildItem = report.tasks.find((t) => t.name === "Build");
  check("PL-123: нет своей истории -> не-null оценки из глобальной истории",
    buildItem.estimatedDurationSec === 10 &&
    buildItem.estimatedTokens === 1000 &&
    Math.abs(buildItem.estimatedCostUsd - 0.003) < 1e-9);
  check("PL-123: пометка источника оценки (глобальная история)",
    report.warnings.some((w) => w.startsWith("[Build] ") && w.includes("PL-123:") && w.includes("глобальн")));

  // 6. Опасные паттерны.
  const danger = await simulatePipeline("Danger");
  check("предупреждение rm -rf /", danger.warnings.some((w) => w.includes("rm -rf /")));
  check("предупреждение git push --force", danger.warnings.some((w) => w.includes("git push --force")));

  // 7. Несуществующая рабочая директория.
  await saveTask({ name: "Ghost", schedule: "* * * * *", prompt: "x", workingDirectory: "Z:/definitely/not/exist" });
  const ghost = await simulatePipeline("Ghost");
  check("предупреждение о несуществующей директории", ghost.warnings.includes(`[Ghost] ${t("dryRun.cwdMissing", { path: "Z:/definitely/not/exist" })}`));

  // 8. Топологические суммы. PL-123: Root и Build теперь тоже получают
  //    оценки из глобальной истории (10 с / 1000 токенов каждый), поэтому
  //    сумма по трем задачам = 30 с / 3000 токенов.
  check("totals длительность = 30 с", report.totals.estimatedDurationSec === 30);
  check("totals токены = 3000", report.totals.estimatedTokens === 3000);
  check("totals стоимость = 0.009", Math.abs(report.totals.estimatedCostUsd - 0.009) < 1e-9);

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

  // 12. PL-49/PL-50: интервал cron, таймаут > интервала и минутный poll.
  check("PL-49: '* * * * *' -> 1 мин", minimumCronIntervalMinutes("* * * * *") === 1);
  check("PL-49: '*/5 * * * *' -> 5 мин", minimumCronIntervalMinutes("*/5 * * * *") === 5);
  check("PL-49: '0,5,10 * * * *' -> 5 мин", minimumCronIntervalMinutes("0,5,10 * * * *") === 5);
  check("PL-49: '0 4 * * *' -> интервал не вычисляется", minimumCronIntervalMinutes("0 4 * * *") === null);
  await saveTask({
    name: "PollTask", schedule: "0 4 */2 * *", timeoutSeconds: 3600,
    prompt: "x",
  });
  const poll = await simulatePipeline("PollTask");
  check("PL-50: triggerDetails.polling для cron вне подмножества schtasks",
    poll.tasks[0]?.triggerDetails?.polling === true);
  check("PL-50: предупреждение про минутный poll", poll.warnings.some((w) => w.includes("PL-50")));
  // PL-49: */15 выразимо в schtasks, но интервал вычисляется — отдельная задача.
  await saveTask({
    name: "TimeoutTask", schedule: "*/15 * * * *", timeoutSeconds: 3600,
    prompt: "x",
  });
  const heavyCron = await simulatePipeline("TimeoutTask");
  check("PL-49: предупреждение про timeout > интервала cron",
    heavyCron.warnings.some((w) => w.includes("PL-49")));

  // 13. PL-55: эвристика PL-2.2 не должна срабатывать на упоминание
  //     результатов тестов в описании, но обязана ловить реальные команды.
  const shellDenied = { allowedTools: ["read"], deniedTools: ["bash"] };
  await saveTask({
    name: "PL-55-MentionOnly", schedule: "0 9 * * *",
    prompt: "Проанализируй результаты тестов GitHub Actions: какие тесты прошли, какие node test упали. В логах уже есть npm test results — просто интерпретируй их и напиши отчёт.",
    ...shellDenied,
  });
  const mention = await simulatePipeline("PL-55-MentionOnly");
  check("PL-55: упоминание результатов тестов НЕ даёт PL-2.2",
    !mention.warnings.some((w) => w.includes("PL-2.2")));

  await saveTask({
    name: "PL-55-Imperative", schedule: "0 9 * * *",
    prompt: "Запусти тесты и проверь себя: run npm test, затем доложи результат.",
    ...shellDenied,
  });
  const imperative = await simulatePipeline("PL-55-Imperative");
  check("PL-55: повелительная команда самопроверки по-прежнему даёт PL-2.2",
    imperative.warnings.some((w) => w.includes("PL-2.2")));

  await saveTask({
    name: "PL-55-ExplicitCommand", schedule: "0 9 * * *",
    prompt: "Выполни команду:\n`npm test`\nи сообщи результат.",
    ...shellDenied,
  });
  const explicit = await simulatePipeline("PL-55-ExplicitCommand");
  check("PL-55: явная команда npm test по-прежнему даёт PL-2.2",
    explicit.warnings.some((w) => w.includes("PL-2.2")));

  // 14. PL-64: смешивание CJK и кириллицы в одном промпте (как в ARCH-6)
  //     предупреждает до запуска, но не ломает китайские/русские локали.
  // Имена задач нейтральные: warnings имеют префикс [taskName], поэтому
  // совпадение «PL-64» в имени дало бы ложное срабатывание проверки.
  const hasScriptWarning = (warnings) => warnings.some((w) => w.includes("PL-64:"));
  await saveTask({
    name: "MixedScripts", schedule: "0 9 * * *",
    prompt: "报告和 run статус: подготовь отчёт",
  });
  const mixed = await simulatePipeline("MixedScripts");
  check("PL-64: смешанные CJK+кириллица дают предупреждение",
    hasScriptWarning(mixed.warnings));
  check("PL-64: предупреждение не делает отчёт провальным (warning, не error)",
    mixed.success === true && Array.isArray(mixed.warnings));

  await saveTask({
    name: "ChineseOnly", schedule: "0 9 * * *",
    prompt: "请报告运行结果和状态",
  });
  const chinese = await simulatePipeline("ChineseOnly");
  check("PL-64: чистый китайский промпт не даёт предупреждения",
    !hasScriptWarning(chinese.warnings));

  await saveTask({
    name: "RussianOnly", schedule: "0 9 * * *",
    prompt: "Подготовь отчёт о статусе запуска",
  });
  const russian = await simulatePipeline("RussianOnly");
  check("PL-64: чистый русский промпт не даёт предупреждения",
    !hasScriptWarning(russian.warnings));

  await saveTask({
    name: "KanaMixed", schedule: "0 9 * * *",
    prompt: "レポートと run статус",
  });
  const kana = await simulatePipeline("KanaMixed");
  check("PL-64: смешанные кана+кириллица тоже дают предупреждение",
    hasScriptWarning(kana.warnings));

  await saveTask({
    name: "HookOnly", schedule: "0 9 * * *",
    prompt: "Подготовь отчёт о статусе запуска",
    afterScript: "echo 报告和状态",
  });
  const hook = await simulatePipeline("HookOnly");
  check("PL-64: CJK только в afterScript не даёт предупреждения (проверяем промпт)",
    !hasScriptWarning(hook.warnings));

  // 15. PL-65: qualityGate обязан покрывать все сюиты изменённого модуля.
  //     ARCH-7 менял src/core/execution.ts, но забыл test-mission-run.mjs —
  //     регрессия ARCH-7.2 дошла до итоговой проверки.
  const hasCoverageWarning = (warnings) => warnings.some((w) => w.includes("PL-65:"));
  check("PL-65: реестр execution.ts содержит полный набор из трёх сюит",
    JSON.stringify(MODULE_REQUIRED_TEST_SUITES["src/core/execution.ts"]) ===
    JSON.stringify(["test-mission-run.mjs", "test-execution-pipeline.mjs", "test-execution-hardening.mjs"]));
  check("PL-65: SCOPE извлекает путь модуля без дублей",
    JSON.stringify(scopeModulesFromText(
      "SCOPE: src/core/execution.ts; test-dry-run.mjs\nSCOPE: src/core/execution.ts",
    )) === JSON.stringify(["src/core/execution.ts"]));
  check("PL-65: пустой SCOPE и неизвестный модуль не дают предупреждения",
    qualityGateCoverageWarning("npm test", []) === null &&
    qualityGateCoverageWarning("npm test", scopeModulesFromText("нет модулей")) === null &&
    qualityGateCoverageWarning("npm test", ["src/core/dry-run.ts"]) === null);

  await saveTask({
    name: "PL-65-PartialGate", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/execution.ts; test-dry-run.mjs",
    qualityGate: "node test-execution-pipeline.mjs && node test-execution-hardening.mjs",
  });
  const partial = await simulatePipeline("PL-65-PartialGate");
  check("PL-65: неполный qualityGate предупреждает о пропущенной сюите",
    hasCoverageWarning(partial.warnings) &&
    partial.warnings.some((w) => w.includes("test-mission-run.mjs")));
  check("PL-65: предупреждение не делает отчёт провальным", partial.success === true);

  await saveTask({
    name: "PL-65-FullGate", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/execution.ts; test-dry-run.mjs",
    qualityGate: "node test-mission-run.mjs && npm run test:execution-pipeline && node test-execution-hardening.mjs",
  });
  const full = await simulatePipeline("PL-65-FullGate");
  check("PL-65: полный qualityGate (включая npm-алиас) без предупреждения",
    !hasCoverageWarning(full.warnings));

  await saveTask({
    name: "PL-65-NoGate", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/execution.ts",
  });
  const noGate = await simulatePipeline("PL-65-NoGate");
  check("PL-65: отсутствие qualityGate тоже даёт предупреждение",
    hasCoverageWarning(noGate.warnings));

  // 16. PL-66: гейт задачи, меняющей модули src/**/*.ts, обязан включать
  //     npm run lint и npm run lint:baseline — иначе ESLint-error доходит до CI.
  //     Имена задач нейтральные: warnings имеют префикс [taskName], поэтому
  //     совпадение «PL-66» в имени дало бы ложное срабатывание проверки.
  const hasLintWarning = (warnings) => warnings.some((w) => w.includes("PL-66:"));
  const tsModule = ["src/core/dry-run.ts"];
  check("PL-66: реестр обязательных проверок содержит lint и lint:baseline",
    JSON.stringify(REQUIRED_LINT_CHECKS) ===
    JSON.stringify(["npm run lint", "npm run lint:baseline"]));
  check("PL-66: пустой SCOPE не даёт предупреждения (fail-open)",
    qualityGateLintWarning("npm run build", []) === null &&
    qualityGateLintWarning("npm run build", undefined) === null);
  check("PL-66: полный гейт с обеими проверками не даёт предупреждения",
    qualityGateLintWarning("npm run lint && npm run lint:baseline && npm run build", tsModule) === null);
  check("PL-66: только lint:baseline не засчитывается как обычный lint",
    qualityGateLintWarning("npm run lint:baseline", tsModule)?.includes("npm run lint") === true);
  check("PL-66: только lint не засчитывается как baseline",
    qualityGateLintWarning("npm run lint", tsModule)?.includes("npm run lint:baseline") === true);
  check("PL-66: lint-job не подменяет обязательную проверку",
    qualityGateLintWarning("npm run lint-job", tsModule)?.includes("npm run lint,") === true);

  await saveTask({
    name: "PL-66-NoLint", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "npm run build && node test-dry-run.mjs",
  });
  const noLint = await simulatePipeline("PL-66-NoLint");
  check("PL-66: гейт без линтера предупреждает о пропущенной проверке",
    hasLintWarning(noLint.warnings) &&
    noLint.warnings.some((w) => w.includes("npm run lint:baseline")));
  check("PL-66: предупреждение не делает отчёт провальным", noLint.success === true);

  await saveTask({
    name: "PL-66-FullLint", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "npm run lint && npm run lint:baseline && npm run build",
  });
  const fullLint = await simulatePipeline("PL-66-FullLint");
  check("PL-66: полный qualityGate проходит без предупреждения",
    !hasLintWarning(fullLint.warnings));

  // 17. PL-76: проверка доступности модели в dry_run + запасная модель без потери гейта.
  const available = ["opencode/hy4-flash-free", "anthropic/claude-3-5-sonnet"];
  const gate = "npm run build && node test-model-validation.mjs";
  check("PL-76: доступная модель предупреждения не даёт",
    modelAvailabilityWarning("opencode/hy4-flash-free", available, gate) === null);
  check("PL-76: пустой список доступных моделей — fail-open",
    modelAvailabilityWarning("opencode/mimo-v2.6-flash-free", [], gate) === null);
  check("PL-76: модель без провайдера отвергается уже в dry_run",
    /provider\/model/.test(modelAvailabilityWarning("hy4-flash-free", available, gate) ?? ""));
  check("PL-76: normalizeModelKey снимает регистр/пробелы/вариант",
    normalizeModelKey("  OpenCode/HY4-FLASH-FREE#high ") === "opencode/hy4-flash-free");
  check("PL-76: запасная модель — бесплатная того же провайдера",
    chooseFallbackModel("opencode/mimo-v2.6-flash-free", [
      "anthropic/claude-3-5-sonnet", "opencode/hy4-flash-free", "openai/gpt-4o",
    ]) === "opencode/hy4-flash-free");
  const unavailableWarning = modelAvailabilityWarning(
    "opencode/mimo-v2.6-flash-free", available, gate,
  );
  check("PL-76: предупреждение называет причину, фолбэк и сохраняет qualityGate",
    /PL-76:/.test(unavailableWarning ?? "") &&
      /Free usage limit reached/.test(unavailableWarning ?? "") &&
      /opencode\/hy4-flash-free/.test(unavailableWarning ?? "") &&
      (unavailableWarning ?? "").includes(gate));

  // Интеграция: dry_run через MCP-обработчик добавляет предупреждение в отчёт.
  await saveTask({
    name: "PL-76-Unavailable", schedule: "0 9 * * *",
    prompt: "Проверь доступность модели", qualityGate: gate,
    model: "opencode/mimo-v2.6-flash-free",
  });
  const previousOverride = process.env.OPENCODE_SCHEDULER_AVAILABLE_MODELS;
  process.env.OPENCODE_SCHEDULER_AVAILABLE_MODELS = available.join(",");
  try {
    const dryReport = JSON.parse(
      (await createToolHandlers({}).dry_run({ name: "PL-76-Unavailable" })).content,
    );
    const modelWarning = dryReport.warnings.find((w) => w.includes("PL-76:"));
    check("PL-76: dry_run отдаёт предупреждение о недоступной модели с фолбэком",
      dryReport.success === true &&
        /opencode\/hy4-flash-free/.test(modelWarning ?? "") &&
        (modelWarning ?? "").includes(gate));
  } finally {
    if (previousOverride === undefined) {
      delete process.env.OPENCODE_SCHEDULER_AVAILABLE_MODELS;
    } else {
      process.env.OPENCODE_SCHEDULER_AVAILABLE_MODELS = previousOverride;
    }
  }

  // 18. PL-117: гейт с test-docs.mjs требует SCOPE с проверяемыми файлами и
  //     детерминированную проверку дублей ID в ROADMAP (fail-open).
  const hasDocsGateWarning = (warnings) => warnings.some((w) => w.includes("PL-117:"));
  check("PL-117: чистые функции экспортированы",
    typeof qualityGateDocsScopeWarning === "function" && typeof roadmapDuplicateIds === "function");

  const dupText = "- [ ] PL-9 - a\n- [ ] PL-9 - b\n- [ ] PL-7 - c\n- [ ] PL-7 - d\n";
  check("PL-117: дубли ID в переданном ROADMAP детектируются (чистая функция)",
    JSON.stringify(roadmapDuplicateIds(dupText)) === JSON.stringify(["PL-9", "PL-7"]));
  check("PL-117: уникальные ID, пустой и невалидный текст не дают дублей (fail-open)",
    roadmapDuplicateIds("- [ ] PL-1 - a\n- [ ] PL-2 - b").length === 0 &&
    roadmapDuplicateIds("").length === 0 &&
    Array.isArray(roadmapDuplicateIds(null)) && roadmapDuplicateIds(null).length === 0);
  check("PL-117: детерминизм чистой функции (один текст — один результат)",
    JSON.stringify(roadmapDuplicateIds(dupText)) === JSON.stringify(roadmapDuplicateIds(dupText)));

  check("PL-117: fail-open — гейт без test-docs.mjs не предупреждает",
    qualityGateDocsScopeWarning("npm run build && npm run lint", "SCOPE: нет файлов") === null &&
    qualityGateDocsScopeWarning(null, "SCOPE: нет файлов") === null);
  check("PL-117: предупреждение при отсутствии файлов в SCOPE",
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts")?.includes("ROADMAP.md") === true &&
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts")?.includes("CHANGELOG.md") === true);
  check("PL-117: нет предупреждения, когда оба файла есть в SCOPE",
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: ROADMAP.md; CHANGELOG.md; src/core/dry-run.ts") === null);
  check("PL-117: npm-алиас test:docs тоже детектируется",
    typeof qualityGateDocsScopeWarning("npm run test:docs", "SCOPE: src/core/dry-run.ts") === "string");
  check("PL-117: детерминизм функции предупреждения",
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: x") ===
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: x"));

  // PL-122: предупреждение о SCOPE выдаётся только тогда, когда манифест -Files
  // в afterScript реально пишет ROADMAP.md/CHANGELOG.md.
  const afterScriptNoDocs = 'powershell.exe -File pl-commit.ps1 -Files "src/core/dry-run.ts;test-dry-run.mjs" -Marker "m"';
  const afterScriptDocs = 'powershell.exe -File pl-commit.ps1 -Files "ROADMAP.md;CHANGELOG.md" -Marker "m"';
  check("PL-122: afterScript без docs — предупреждения PL-117 о SCOPE нет",
    qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts", null, afterScriptNoDocs) === null);
  check("PL-122: afterScript с -Files ROADMAP.md;CHANGELOG.md — предупреждение есть",
    (qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts", null, afterScriptDocs) ?? "").includes("ROADMAP.md") &&
    (qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts", null, afterScriptDocs) ?? "").includes("CHANGELOG.md"));
  check("PL-122: без afterScript сохраняется прежнее предупреждение",
    (qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: src/core/dry-run.ts") ?? "").includes("ROADMAP.md"));
  check("PL-122: дубли ID сообщаются независимо от afterScript",
    (qualityGateDocsScopeWarning("node test-docs.mjs", "SCOPE: ROADMAP.md; CHANGELOG.md", dupText, afterScriptNoDocs) ?? "").includes("дубли ID"));

  const docsScopeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-docs-"));
  await saveTask({
    name: "DocsScopeMissing", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "node test-docs.mjs", workingDirectory: docsScopeDir,
  });
  const missingScope = await simulatePipeline("DocsScopeMissing");
  check("PL-117: dry_run предупреждает, когда SCOPE не содержит ROADMAP.md и CHANGELOG.md",
    hasDocsGateWarning(missingScope.warnings) &&
    missingScope.warnings.some((w) => w.includes("ROADMAP.md") && w.includes("CHANGELOG.md")));
  check("PL-117: предупреждение не делает отчёт провальным", missingScope.success === true);

  await saveTask({
    name: "DocsScopeFull", schedule: "0 9 * * *",
    prompt: "SCOPE: ROADMAP.md; CHANGELOG.md; src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "node test-docs.mjs", workingDirectory: docsScopeDir,
  });
  const fullScope = await simulatePipeline("DocsScopeFull");
  check("PL-117: при полном SCOPE предупреждения нет", !hasDocsGateWarning(fullScope.warnings));

  // PL-122: read-only зонд с afterScript, чей -Files не содержит docs, больше
  // не получает ложное PL-117 про неполный SCOPE.
  await saveTask({
    name: "DocsReadOnlyProbe", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "node test-docs.mjs",
    afterScript: afterScriptNoDocs, workingDirectory: docsScopeDir,
  });
  const readOnlyProbe = await simulatePipeline("DocsReadOnlyProbe");
  check("PL-122: read-only зонд с afterScript без docs — PL-117 в dry_run не выдаётся",
    !hasDocsGateWarning(readOnlyProbe.warnings) && readOnlyProbe.success === true);

  fs.writeFileSync(path.join(docsScopeDir, "ROADMAP.md"),
    "- [ ] PL-1 - a\n- [ ] PL-1 - b\n- [ ] PL-2 - c\n");
  await saveTask({
    name: "DocsScopeDupIds", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts",
    qualityGate: "npm run test:docs", workingDirectory: docsScopeDir,
  });
  const dupIds = await simulatePipeline("DocsScopeDupIds");
  check("PL-117: дубли ID в доступной ROADMAP задачи попадают в предупреждение",
    hasDocsGateWarning(dupIds.warnings) &&
    dupIds.warnings.some((w) => w.includes("дубли ID") && w.includes("PL-1")));

  // PL-122: подавление SCOPE-предупреждения не скрывает дубли ID в ROADMAP.
  await saveTask({
    name: "DocsProbeDupIds", schedule: "0 9 * * *",
    prompt: "SCOPE: src/core/dry-run.ts; test-dry-run.mjs",
    qualityGate: "node test-docs.mjs",
    afterScript: afterScriptNoDocs, workingDirectory: docsScopeDir,
  });
  const probeDupIds = await simulatePipeline("DocsProbeDupIds");
  check("PL-122: дубли ID сообщаются и при afterScript без docs",
    hasDocsGateWarning(probeDupIds.warnings) &&
    probeDupIds.warnings.some((w) => w.includes("дубли ID") && w.includes("PL-1")));

  // 19. T-7.1/T-7.2: preflight рисков пропуска и рекомендация модели.
  const sharedCwd = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-preflight-"));
  await saveTask({ name: "T7-Routine", schedule: "0 9 * * *", prompt: "Собери отчёт о статусе задач", workingDirectory: sharedCwd, dependsOn: ["T7-Complex"] });
  await saveTask({ name: "T7-Complex", schedule: "0 9 * * *", prompt: "Проведи аудит безопасности и рефакторинг ядра", workingDirectory: sharedCwd });
  const routineReport = await simulatePipeline("T7-Routine");
  check("T-7.1: общий checkout без worktree даёт preflight-предупреждение о lock-skip",
    routineReport.warnings.some((w) => w.includes("T-7.1:") && w.includes("T7-Complex")));
  check("T-7.1: рекомендация модели добавлена в каждую задачу отчёта",
    routineReport.tasks.every((task) => task.modelRecommendation && typeof task.modelRecommendation.tier === "string"));
  check("T-7.2: рутина получает free-модель, сложная — дорогую",
    recommendModelForTask("Собери отчёт").model === "opencode/hy4-flash-free" &&
    recommendModelForTask("Сделай аудит безопасности и рефакторинг").model === "anthropic/claude-3-5-sonnet");
  check("T-7.2: явная модель пользователя не подменяется",
    recommendModelForTask("Аудит", "opencode/hy4-flash-free").recommended === false &&
    recommendModelForTask("Аудит", "opencode/hy4-flash-free").currentModel === "opencode/hy4-flash-free");
  check("T-7.1: worktree и уникальные cwd не дают ложного предупреждения",
    preflightSkipRiskWarnings([
      { name: "A", worktree: true, workingDirectory: sharedCwd },
      { name: "B", workingDirectory: path.join(sharedCwd, "b") },
    ]).length === 0);

  // 20. PL-123: детерминированные регрессии фолбэка оценки.
  // (а) задача без прогонов, но глобальная история непуста (2 успешных Lint
  //     по 10 с / 1000 токенов) -> не-null оценки и пометка источника.
  await saveTask({ name: "PL-123-Global", schedule: "0 9 * * *", prompt: "x" });
  const globalFallback = await simulatePipeline("PL-123-Global");
  const globalItem = globalFallback.tasks.find((t) => t.name === "PL-123-Global");
  check("PL-123 (а): не-null оценки из глобальной истории",
    globalItem.estimatedDurationSec === 10 &&
    globalItem.estimatedTokens === 1000 &&
    Math.abs(globalItem.estimatedCostUsd - 0.003) < 1e-9);
  check("PL-123 (а): пометка источника в выводе dry_run",
    globalFallback.warnings.some((w) => w.includes("PL-123:") && w.includes("глобальной истории")));
  check("PL-123 (а): старое noHistory-предупреждение больше не выдаётся",
    !globalFallback.warnings.some((w) => w.includes(t("dryRun.noHistory"))));

  // (б) пустая глобальная история -> старое поведение сохранено: null + noHistory.
  //     Чистим историю в конце прогона, чтобы не задеть предыдущие проверки.
  getDb().exec("DELETE FROM history");
  await saveTask({ name: "PL-123-Empty", schedule: "0 9 * * *", prompt: "x" });
  const emptyFallback = await simulatePipeline("PL-123-Empty");
  const emptyItem = emptyFallback.tasks.find((t) => t.name === "PL-123-Empty");
  check("PL-123 (б): пустая глобальная история -> null оценки",
    emptyItem.estimatedDurationSec == null &&
    emptyItem.estimatedTokens == null &&
    emptyItem.estimatedCostUsd == null);
  check("PL-123 (б): пустая глобальная история -> noHistory",
    emptyFallback.warnings.includes(`[PL-123-Empty] ${t("dryRun.noHistory")}`));
  check("PL-123 (б): пометки глобального фолбэка нет",
    !emptyFallback.warnings.some((w) => w.includes("PL-123:")));
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDry-run: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
