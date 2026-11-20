/**
 * P2-33.T1.3: тесты схемы и валидатора Pipeline-as-code.
 * Запуск: node test-pipeline.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-pipeline-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  validatePipelineSpec,
  pipelineStepTaskName,
  PIPELINE_VERSION,
} = await import("./dist/core/pipeline-spec.js");
const { parsePipelineYaml, loadPipelineFile } = await import("./dist/core/pipeline-io.js");
const {
  pipelineExportLookupError,
  pipelineSpecToTasks,
  tasksToPipelineSpec,
} = await import("./dist/core/pipeline-map.js");
const { planPipelineApply, executePipelineApply } = await import("./dist/core/pipeline-apply.js");
const { pipelineExportSchema } = await import("./dist/index.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function step(id, extra = {}) {
  return { id, prompt: `do ${id}`, schedule: "0 2 * * *", ...extra };
}
function pipeline(steps, extra = {}) {
  return { version: 1, name: "ci", steps, ...extra };
}
function hasError(result, pathFragment, textFragment) {
  return result.errors.some(
    (issue) =>
      issue.path.includes(pathFragment) &&
      (textFragment === undefined || issue.message.includes(textFragment)),
  );
}

// 1. Минимальный валидный pipeline.
{
  const result = validatePipelineSpec(pipeline([step("lint")]));
  check("валидный минимальный pipeline: ok, без ошибок", result.ok && result.errors.length === 0);
  check("PIPELINE_VERSION = 1", PIPELINE_VERSION === 1);
  check(
    "pipelineStepTaskName: '<pipeline> <id>'",
    pipelineStepTaskName("ci", "build") === "ci build",
  );
}

// 2. Версия формата.
{
  const result = validatePipelineSpec({ ...pipeline([step("lint")]), version: 2 });
  check("неподдерживаемая version — ошибка", !result.ok && hasError(result, "version"));
}

// 3. Пустой список шагов.
{
  const result = validatePipelineSpec(pipeline([]));
  check("пустой steps — ошибка", !result.ok && hasError(result, "steps"));
}

// 4. Дубликаты id (без учёта регистра).
{
  const result = validatePipelineSpec(pipeline([step("build"), step("Build")]));
  check("дубликат id — ошибка", !result.ok && hasError(result, "steps[1].id", "уже используется"));
}

// 5. Ссылка на несуществующий шаг.
{
  const result = validatePipelineSpec(pipeline([step("build", { needs: ["lint"] })]));
  check("неизвестный needs — ошибка", !result.ok && hasError(result, "needs", "не найден"));
}

// 6. Цикл зависимостей.
{
  const result = validatePipelineSpec(
    pipeline([
      step("a", { needs: ["b"] }),
      step("b", { needs: ["c"] }),
      step("c", { needs: ["a"] }),
    ]),
  );
  check("цикл зависимостей — ошибка", !result.ok && hasError(result, "steps", "Циклическая"));
}

// 7. Зависимость от самого себя.
{
  const result = validatePipelineSpec(pipeline([step("a", { needs: ["a"] })]));
  check("self-need — ошибка", !result.ok && hasError(result, "needs", "самого себя"));
}

// 8. Корневой cron-шаг без schedule.
{
  const result = validatePipelineSpec(pipeline([{ id: "lint", prompt: "lint" }]));
  check("cron без schedule — ошибка", !result.ok && hasError(result, "schedule", "нужен schedule"));
}

// 9. trigger: dag без needs.
{
  const result = validatePipelineSpec(
    pipeline([step("lint", { trigger: "dag", schedule: undefined })]),
  );
  check("dag без needs — ошибка", !result.ok && hasError(result, "trigger", "непустым needs"));
}

// 10. trigger: dag с needs — валиден без cron.
{
  const result = validatePipelineSpec(
    pipeline([
      step("lint"),
      step("build", { trigger: "dag", schedule: undefined, needs: ["lint"] }),
    ]),
  );
  check("dag с needs без schedule — ok", result.ok && result.errors.length === 0);
}

// 11. Некорректный cron.
{
  const result = validatePipelineSpec(pipeline([step("lint", { schedule: "61 * * * *" })]));
  check("некорректный cron — ошибка", !result.ok && hasError(result, "schedule", "Некорректный"));
}

// 12. defaults.schedule наследуется корневым шагом.
{
  const result = validatePipelineSpec(
    pipeline([{ id: "lint", prompt: "lint" }], { defaults: { schedule: "@every 15m" } }),
  );
  check("defaults.schedule наследуется — ok", result.ok && result.errors.length === 0);
}

// 13. once без runAt.
{
  const result = validatePipelineSpec(
    pipeline([step("deploy", { trigger: "once", schedule: undefined })]),
  );
  check("once без runAt — ошибка", !result.ok && hasError(result, "runAt"));
}

// 14. once с валидным runAt.
{
  const result = validatePipelineSpec(
    pipeline([
      step("deploy", { trigger: "once", schedule: undefined, runAt: "2026-12-31T23:00:00Z" }),
    ]),
  );
  check("once с runAt — ok", result.ok && result.errors.length === 0);
}

// 15. Пустой matrix.workspaces.
{
  const result = validatePipelineSpec(
    pipeline([step("build", { matrix: { workspaces: [] } })]),
  );
  check("пустой matrix.workspaces — ошибка", !result.ok && hasError(result, "matrix.workspaces"));
}

// 16. matrix вместе с workspaceId.
{
  const result = validatePipelineSpec(
    pipeline([step("build", { workspaceId: "ws-1", matrix: { workspaces: ["api"] } })]),
  );
  check("matrix + workspaceId — ошибка", !result.ok && hasError(result, "matrix"));
}

// 17. Недопустимый model.
{
  const result = validatePipelineSpec(pipeline([step("lint", { model: "bad model!" })]));
  check("недопустимый model — ошибка", !result.ok && hasError(result, "model"));
}

// 18. Неизвестный часовой пояс.
{
  const result = validatePipelineSpec(pipeline([step("lint", { timezone: "Mars/Base" })]));
  check("неизвестный timezone — ошибка", !result.ok && hasError(result, "timezone"));
}

// 19. Пустой allowedTools.
{
  const result = validatePipelineSpec(pipeline([step("lint", { allowedTools: [] })]));
  check("пустой allowedTools — ошибка", !result.ok && hasError(result, "allowedTools"));
}

// 20. priority вне 0…10.
{
  const result = validatePipelineSpec(pipeline([step("lint", { priority: 11 })]));
  check("priority 11 — ошибка", !result.ok && hasError(result, "priority"));
}

// 21. Коллизия имён задач (без учёта регистра).
{
  const result = validatePipelineSpec(
    pipeline([
      step("a", { name: "Same Task" }),
      step("b", { name: "same task" }),
    ]),
  );
  check("коллизия имён задач — ошибка", !result.ok && hasError(result, "steps[1].name", "уже используется"));
}

// 22. Корень — не объект.
{
  const result = validatePipelineSpec("not a pipeline");
  check("не-объект — ошибка", !result.ok && hasError(result, "$"));
}

// 23. Неизвестное поле — предупреждение, не ошибка.
{
  const result = validatePipelineSpec(pipeline([step("lint")], { unknownField: true }));
  check(
    "неизвестное поле — warning, ok остаётся true",
    result.ok && result.warnings.some((issue) => issue.path === "unknownField"),
  );
}

// 24-29. YAML-парсер (P2-33.T2.1).
{
  const yaml = [
    'version: 1',
    'name: ci-yaml',
    'defaults:',
    '  schedule: "0 3 * * *"',
    'steps:',
    '  - id: lint',
    '    prompt: make lint',
    '  - id: build',
    '    prompt: make build',
    '    needs: [lint]',
  ].join("\n");
  const result = parsePipelineYaml(yaml);
  check(
    "YAML: валидный документ разбирается и валидируется",
    result.ok &&
      result.spec !== undefined &&
      result.spec.name === "ci-yaml" &&
      result.spec.steps.length === 2 &&
      result.spec.defaults.schedule === "0 3 * * *" &&
      result.spec.steps[1].needs[0] === "lint",
  );
}

{
  const result = parsePipelineYaml("version: 1\nname: [unclosed\nsteps: []\n");
  check("YAML: синтаксическая ошибка — ошибка с путём $", !result.ok && hasError(result, "$"));
}

{
  const result = parsePipelineYaml("version: 1\nname: ci\nname: other\nsteps: []\n");
  check("YAML: дубликат ключа — ошибка", !result.ok && hasError(result, "$"));
}

{
  const result = parsePipelineYaml("just a string");
  check("YAML: скаляр вместо объекта — ошибка", !result.ok && hasError(result, "$"));
}

{
  const result = parsePipelineYaml("");
  check("YAML: пустой документ — ошибка", !result.ok && hasError(result, "$"));
}

{
  const result = await loadPipelineFile(path.join(tempRoot, "missing.pipeline.yaml"));
  check("YAML: отсутствующий файл — ошибка чтения", !result.ok && hasError(result, "missing.pipeline.yaml"));
}

{
  // PL-18/PL-27: pipeline_validate/pipeline_apply должны принимать относительный путь.
  const yaml = [
    "version: 1",
    "name: ci-rel",
    "defaults:",
    '  schedule: "0 3 * * *"',
    "steps:",
    "  - id: lint",
    "    prompt: make lint",
  ].join("\n");
  const yamlPath = path.join(tempRoot, "relative.pipeline.yaml");
  fs.writeFileSync(yamlPath, yaml, "utf8");
  const prevCwd = process.cwd();
  try {
    process.chdir(tempRoot);
    const relative = await loadPipelineFile("relative.pipeline.yaml");
    check("YAML: относительный путь против cwd — ok", relative.ok && relative.spec?.name === "ci-rel");
    const absolute = await loadPipelineFile(yamlPath);
    check("YAML: абсолютный путь по-прежнему работает", absolute.ok && absolute.spec?.name === "ci-rel");
    // PL-34: cwd хоста не совпадает с каталогом задачи — помогает явный baseDir.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-pipeline-base-"));
    fs.writeFileSync(path.join(projectRoot, "opencode.pipeline.yaml"), yaml, "utf8");
    const byBase = await loadPipelineFile("opencode.pipeline.yaml", projectRoot);
    check(
      "YAML: относительный путь против workingDirectory — ok",
      byBase.ok && byBase.spec?.name === "ci-rel",
    );
    const stillFails = await loadPipelineFile("definitely-missing.pipeline.yaml", projectRoot);
    check("YAML: отсутствующий файл с baseDir — ошибка", !stillFails.ok);
  } finally {
    process.chdir(prevCwd);
  }
}

// 30-38. Маппинг PipelineSpec → TaskDefinition[] (P2-33.T2.2).
{
  const spec = pipeline([
    step("lint"),
    step("build", { trigger: "dag", schedule: undefined, needs: ["lint"] }),
  ]);
  const { tasks } = pipelineSpecToTasks(spec);
  check("map: по задаче на шаг", tasks.length === 2);
  check(
    "map: имя задачи '<pipeline> <id>' и маркеры",
    tasks[0].name === "ci lint" &&
      tasks[0].pipelineName === "ci" &&
      tasks[0].pipelineStepId === "lint",
  );
  check(
    "map: cron-шаг сохраняет schedule и triggerType",
    tasks[0].schedule === "0 2 * * *" && tasks[0].triggerType === "cron",
  );
  check(
    "map: needs → dependsOn с именами задач",
    JSON.stringify(tasks[1].dependsOn) === JSON.stringify(["ci lint"]),
  );
  check(
    "map: trigger dag → ручной file без cron",
    tasks[1].triggerType === "file" && tasks[1].schedule === "",
  );
}

{
  const spec = pipeline([{ id: "lint", prompt: "lint" }], {
    defaults: {
      schedule: "0 3 * * *",
      model: "openai/gpt-4o",
      priority: 7,
      timeoutSeconds: 600,
      retryCount: 2,
      allowedTools: ["bash"],
    },
  });
  const { tasks } = pipelineSpecToTasks(spec);
  check(
    "map: defaults наследуются",
    tasks[0].schedule === "0 3 * * *" &&
      tasks[0].model === "openai/gpt-4o" &&
      tasks[0].priority === 7 &&
      tasks[0].timeoutSeconds === 600 &&
      tasks[0].retryCount === 2 &&
      JSON.stringify(tasks[0].allowedTools) === JSON.stringify(["bash"]),
  );
}

{
  const spec = pipeline([
    step("deploy", {
      trigger: "once",
      schedule: undefined,
      runAt: "2026-12-31T23:00:00Z",
      qualityGate: "npm test",
      beforeScript: "echo pre",
      afterScript: "echo post",
    }),
  ]);
  const { tasks } = pipelineSpecToTasks(spec);
  check(
    "map: once → runAt и хуки",
    tasks[0].triggerType === "once" &&
      tasks[0].runAt === "2026-12-31T23:00:00Z" &&
      tasks[0].qualityGate === "npm test" &&
      tasks[0].beforeScript === "echo pre" &&
      tasks[0].afterScript === "echo post",
  );
}

{
  const spec = pipeline([
    step("build", {
      matrix: { workspaces: ["api", "web"], strategy: "sequential", concurrency: 2 },
    }),
  ]);
  const { tasks } = pipelineSpecToTasks(spec, {
    resolveWorkspaceId: (value) => (value === "api" ? "uuid-api" : undefined),
  });
  check(
    "map: matrix.workspaces → workspaceIds + резолвер",
    tasks[0].matrix.workspaceIds[0] === "uuid-api" &&
      tasks[0].matrix.workspaceIds[1] === "web" &&
      tasks[0].matrix.strategy === "sequential" &&
      tasks[0].matrix.concurrency === 2,
  );
}

{
  const spec = pipeline([step("build", { matrix: { workspaces: ["missing"] } })]);
  const { warnings } = pipelineSpecToTasks(spec, { resolveWorkspaceId: () => undefined });
  check(
    "map: неразрешённый workspace — warning",
    warnings.some((warning) => warning.includes("missing")),
  );
}

// 39-44. Идемпотентный diff/apply (P2-33.T2.3).
{
  const spec = pipeline([step("lint"), step("build", { needs: ["lint"] })]);
  const { tasks } = pipelineSpecToTasks(spec);

  const fresh = planPipelineApply(spec, []);
  check(
    "apply: пустая БД → все create",
    fresh.creates.length === 2 && fresh.updates.length === 0,
  );

  const second = planPipelineApply(spec, tasks);
  check(
    "apply: повторный apply → unchanged",
    second.creates.length === 0 && second.unchanged.length === 2,
  );

  const changed = tasks.map((task) =>
    task.pipelineStepId === "lint" ? { ...task, prompt: "changed" } : task,
  );
  const plan = planPipelineApply(spec, changed);
  check(
    "apply: изменённый prompt → update",
    plan.updates.length === 1 && plan.updates[0].task.pipelineStepId === "lint",
  );

  const foreign = {
    name: "other",
    schedule: "",
    prompt: "x",
    pipelineName: "other",
    pipelineStepId: "lint",
  };
  const isolated = planPipelineApply(spec, [foreign]);
  check(
    "apply: чужая задача не трогается",
    isolated.creates.length === 2 && isolated.updates.length === 0,
  );

  const stale = {
    name: "ci old",
    schedule: "",
    prompt: "x",
    pipelineName: "ci",
    pipelineStepId: "old",
  };
  const withStale = planPipelineApply(spec, [...tasks, stale]);
  check(
    "apply: исчезнувший шаг → stale + warning",
    withStale.stale.length === 1 &&
      withStale.warnings.some((warning) => warning.includes("old")),
  );

  const calls = [];
  const result = await executePipelineApply(plan, {
    create: (task) => calls.push(`c:${task.name}`),
    update: (task) => calls.push(`u:${task.name}`),
  });
  check(
    "apply: execute вызывает update и считает",
    result.updated === 1 && calls.length === 1 && calls[0].startsWith("u:"),
  );
}

// 45-48. Обратный маппинг tasks → PipelineSpec для CLI export (P2-33.T3).
{
  const original = pipeline([
    step("lint"),
    step("build", { needs: ["lint"], trigger: "dag", schedule: undefined }),
    step("deploy", {
      needs: ["build"],
      trigger: "dag",
      schedule: undefined,
      matrix: { workspaces: ["api"], strategy: "parallel" },
    }),
  ]);
  const { tasks } = pipelineSpecToTasks(original);
  const exported = tasksToPipelineSpec(tasks, original.name);
  const reparsed = validatePipelineSpec(exported.spec);
  check(
    "export: round-trip проходит валидатор",
    reparsed.ok && exported.spec.steps.length === 3,
  );
  check(
    "export: needs восстановлены",
    exported.spec.steps[1].needs?.[0] === "lint" &&
      exported.spec.steps[2].needs?.[0] === "build",
  );
  check(
    "export: dag восстановлен по эвристике",
    exported.spec.steps[1].trigger === "dag" &&
      exported.spec.steps[2].trigger === "dag",
  );
  check(
    "export: matrix.workspaces восстановлены",
    exported.spec.steps[2].matrix?.workspaces[0] === "api",
  );
}

{
  const spec = pipeline([step("lint"), step("build", { needs: ["lint"], trigger: "dag" })]);
  const { tasks } = pipelineSpecToTasks(spec);
  const withForeign = tasks.map((task) =>
    task.pipelineStepId === "build"
      ? { ...task, dependsOn: [...(task.dependsOn ?? []), "external"] }
      : task,
  );
  const exported = tasksToPipelineSpec(withForeign, spec.name);
  check(
    "export: внешняя зависимость → warning и опущена",
    exported.warnings.some((warning) => warning.includes("external")) &&
      exported.spec.steps[1].needs?.length === 1,
  );
}

// 50. Guards (W-3): валидация, маппинг, export round-trip.
{
  const result = validatePipelineSpec(
    pipeline([step("lint", { guards: { semantic: { filesExist: ["/abs"] } } })]),
  );
  check(
    "guards: невалидные guards → ошибка по path steps[0].guards",
    !result.ok && hasError(result, "steps[0].guards"),
  );
}

{
  const validGuards = {
    command: "node ./scripts/check.mjs",
    timeoutSeconds: 30,
    semantic: { filesExist: ["src/a.ts"], changedSince: "HEAD~2" },
  };
  const spec = pipeline([step("lint", { guards: validGuards })]);
  check("guards: валидные guards — ok без ошибок", validatePipelineSpec(spec).ok);
  const { tasks } = pipelineSpecToTasks(spec);
  check(
    "guards: маппинг — guards попали в TaskDefinition",
    JSON.stringify(tasks[0].guards) === JSON.stringify(validGuards),
  );
  const exported = tasksToPipelineSpec(tasks, spec.name);
  check(
    "guards: export round-trip сохраняет guards",
    exported.spec.steps[0]?.guards?.command === "node ./scripts/check.mjs" &&
      exported.spec.steps[0]?.guards?.semantic?.changedSince === "HEAD~2",
  );
}

{
  const spec = pipeline([step("build")]);
  const { tasks } = pipelineSpecToTasks(spec);
  check(
    "QA-P3.2: существующий конвейер находится",
    pipelineExportLookupError(tasks, spec.name) === null,
  );
  const missing = pipelineExportLookupError(tasks, "no-such-pipeline");
  check(
    "QA-P3.2: несуществующий конвейер даёт ошибку «не найден»",
    typeof missing === "string" && missing.includes("no-such-pipeline") && missing.includes("не найден"),
  );
  check(
    "QA-P3.2: конфликт pipeline/pipelineName отвергается схемой",
    !pipelineExportSchema.safeParse({ pipeline: "A", pipelineName: "B" }).success,
  );
  check(
    "QA-P3.2: одинаковые pipeline/pipelineName принимаются",
    pipelineExportSchema.safeParse({ pipeline: "A", pipelineName: "A" }).success,
  );
  check(
    "QA-P3.2: только pipelineName принимается",
    pipelineExportSchema.safeParse({ pipelineName: "A" }).success,
  );
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nPipeline spec: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length > 0) {
  process.exitCode = 1;
}
