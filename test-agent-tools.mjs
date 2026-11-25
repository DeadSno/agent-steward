/**
 * Тесты паритета агента (Спринт 17.6 / роадмап 0.3–0.4):
 * расширенная схема schedule_task, схемы новых инструментов и чтение логов.
 * Запуск: node test-agent-tools.mjs (после npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-agent-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  scheduleTaskSchema,
  deleteTaskSchema,
  updateTaskSchema,
  matrixControlSchema,
  matrixSchema,
  manageSettingsSchema,
  manageTemplatesSchema,
  manageProfilesSchema,
  transferTasksSchema,
  emitEventSchema,
  emitEventCore,
  matchesMcpEventSubscription,
  normalizeMcpEventTrigger,
  getTaskLogsSchema,
  createToolHandlers,
  createToolSpecs,
  coreScheduleTaskSchema,
  coreUpdateTaskSchema,
  normalizeTaskStatus,
} = await import("./dist/index.js");
const {
  CHILD_RUN_ENV,
  isChildRunMode,
} = await import("./dist/core/run-mode.js");
const { getTaskLogs } = await import("./dist/core/scheduler/logs.js");
const { runOpencode, quoteCmdArg, opencodeCommandFor } = await import("./dist/core/opencode-cli.js");
const {
  validateCmdLineText,
  validateModelReference,
} = await import("./dist/core/task-name.js");
const { readStructuredLogs } = await import("./dist/core/structured-log.js");
const { resolveDeleteNames, summarizeBatchDelete } = await import(
  "./dist/shared/batch-delete.js"
);
const { executeBatchCalls, BATCH_CALL_LIMIT } = await import(
  "./dist/shared/batch-call.js"
);
const { LOG_DIR, sanitizeName } = await import("./dist/types.js");
const { loadTemplates, saveTemplate, deleteTemplate } = await import("./dist/templates.js");
const { saveTask, getTask } = await import("./dist/db/tasks-repo.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

/** Возвращает true, если схема отвергла входные данные. */
function rejects(schema, value) {
  return schema.safeParse(value).success === false;
}

// 1. Минимальная задача по-прежнему валидна.
const minimal = scheduleTaskSchema.safeParse({
  name: "nightly",
  schedule: "0 3 * * *",
  prompt: "Собери отчёт",
});
check("schedule_task: минимальные поля валидны", minimal.success);

const fileTrigger = scheduleTaskSchema.safeParse({
  name: "watch-inbox",
  schedule: "* * * * *",
  prompt: "Обработай новый файл",
  triggerType: "file",
  watchPath: "C:/data/inbox",
});
check(
  "schedule_task: watchPath для file-триггера принимается",
  fileTrigger.success && fileTrigger.data.watchPath === "C:/data/inbox"
);

// 2. Новые поля 0.3 принимаются и сохраняются.
const full = scheduleTaskSchema.safeParse({
  name: "deploy",
  schedule: "*/15 * * * *",
  prompt: "Задеплой",
  timeoutSeconds: 900,
  model: "test/model",
  priority: 9,
  beforeScript: "git pull",
  afterScript: "git push",
  qualityGate: "npm test",
  dependsOn: ["build"],
  retryCount: 2,
  retryDelay: 30,
  nextTaskOnSuccess: "smoke",
  nextTaskOnError: "rollback",
  triggerType: "cron",
  workspaceId: "ws-1",
  allowedTools: ["read", "bash"],
  deniedTools: ["write"],
});
check(
  "schedule_task: qualityGate/dependsOn/retry/nextTask* принимаются",
  full.success &&
    full.data.qualityGate === "npm test" &&
    full.data.dependsOn?.[0] === "build" &&
    full.data.retryCount === 2 &&
    full.data.retryDelay === 30 &&
    full.data.nextTaskOnSuccess === "smoke" &&
    full.data.nextTaskOnError === "rollback"
);

// 3. Matrix 0.3: concurrency и overrides.
const matrix = scheduleTaskSchema.safeParse({
  name: "fanout",
  schedule: "* * * * *",
  prompt: "Прогони тесты",
  matrix: {
    workspaceIds: ["ws-1", "ws-2"],
    strategy: "parallel",
    failureMode: "continue",
    aggregation: "summary",
    createAggregator: true,
    concurrency: 2,
    overrides: {
      "ws-2": {
        prompt: "Только e2e",
        model: "test/fast",
        qualityGate: "npm run e2e",
        beforeScript: "git pull",
        afterScript: "git push",
      },
    },
  },
});
check(
  "schedule_task: matrix.concurrency и matrix.overrides принимаются",
  matrix.success &&
    matrix.data.matrix?.concurrency === 2 &&
    matrix.data.matrix?.overrides?.["ws-2"]?.qualityGate === "npm run e2e"
);

// 4. Невалидная стратегия отвергается.
check(
  "schedule_task: неизвестная strategy отвергается",
  rejects(scheduleTaskSchema, {
    name: "x",
    schedule: "* * * * *",
    prompt: "p",
    matrix: { workspaceIds: ["ws-1"], strategy: "chaos" },
  })
);

// 5. Без промпта задача не создаётся.
check(
  "schedule_task: отсутствие prompt отвергается",
  rejects(scheduleTaskSchema, { name: "x", schedule: "* * * * *" })
);

// 6. Обновление: достаточно одного name (частичное обновление).
const partial = updateTaskSchema.safeParse({ name: "deploy", qualityGate: "npm test" });
check(
  "update_task: частичное обновление валидно",
  partial.success && partial.data.qualityGate === "npm test" && partial.data.schedule === undefined
);

// 7. Обновление: matrix: null отключает матрицу.
check(
  "update_task: matrix: null принимается",
  updateTaskSchema.safeParse({ name: "deploy", matrix: null }).success
);

// 8. Обновление: пустая строка очищает поле.
check(
  "update_task: пустая строка допустима (очистка поля)",
  updateTaskSchema.safeParse({ name: "deploy", model: "" }).success
);

// PL-74/PL-88: единая валидация формата provider/model в схемах и в write-пути.
const badModel = "hy4-flash-free";
const noPrefixSchedule = scheduleTaskSchema.safeParse({
  name: "no-prefix", schedule: "0 3 * * *", prompt: "p", model: badModel,
});
check(
  "PL-74/PL-88: schedule_task отвергает модель без provider/",
  !noPrefixSchedule.success &&
    /provider\/model/.test(noPrefixSchedule.error.issues[0].message) &&
    /opencode models/.test(noPrefixSchedule.error.issues[0].message)
);
check(
  "PL-74/PL-88: schedule_task принимает opencode/hy4-flash-free",
  scheduleTaskSchema.safeParse({
    name: "prefixed", schedule: "0 3 * * *", prompt: "p",
    model: "opencode/hy4-flash-free",
  }).success
);
const noPrefixUpdate = updateTaskSchema.safeParse({ name: "deploy", model: badModel });
check(
  "PL-74/PL-88: update_task отвергает модель без provider/",
  !noPrefixUpdate.success &&
    /provider\/model/.test(noPrefixUpdate.error.issues[0].message)
);
check(
  "PL-74/PL-88: update_task принимает модель с префиксом и пустую строку",
  updateTaskSchema.safeParse({ name: "deploy", model: "opencode/hy4-flash-free" }).success &&
    updateTaskSchema.safeParse({ name: "deploy", model: "" }).success
);
check(
  "PL-74/PL-88: общая валидация доступна как validateModelReference",
  validateModelReference(badModel)?.includes("provider/model") === true &&
    validateModelReference("opencode/hy4-flash-free") === null
);
// 9. matrix_control: cleanup без name.
check(
  "matrix_control: cleanup без имени валиден",
  matrixControlSchema.safeParse({ action: "cleanup" }).success
);

// 10. matrix_control: неизвестное действие отвергается.
check(
  "matrix_control: неизвестное действие отвергается",
  rejects(matrixControlSchema, { action: "reboot" })
);

// 11. matrixSchema напрямую: пустой workspaceIds допустим схемой (проверяется
//     отдельно на уровне валидации задачи), но элементы — строки.
check(
  "matrixSchema: workspaceIds — массив строк",
  matrixSchema.safeParse({ workspaceIds: ["a"] }).success &&
    rejects(matrixSchema, { workspaceIds: [1] })
);

// 11b. Новые инструменты полного паритета: схемы принимают корректные входы
// и отвергают неизвестные действия/пустые события.
check(
  "manage_settings: частичное обновление валидно",
  manageSettingsSchema.safeParse({ action: "update", maxConcurrent: 2 }).success &&
    rejects(manageSettingsSchema, { action: "update", maxConcurrent: 0 })
);
check(
  "manage_templates: save и delete валидны, неизвестное действие отвергается",
  manageTemplatesSchema.safeParse({ action: "save", name: "t", prompt: "p" }).success &&
    manageTemplatesSchema.safeParse({ action: "delete", id: "x" }).success &&
    rejects(manageTemplatesSchema, { action: "rename" })
);
check(
  "manage_profiles: create с портом валиден, порт вне диапазона отвергается",
  manageProfilesSchema.safeParse({ action: "create", name: "p", port: 3782 }).success &&
    rejects(manageProfilesSchema, { action: "create", name: "p", port: 70000 })
);
check(
  "transfer_tasks: import требует строку данных при корректном action",
  transferTasksSchema.safeParse({ action: "export" }).success &&
    rejects(transferTasksSchema, { action: "import", data: 42 })
);
check(
  "emit_event: пустое имя события отвергается",
  !emitEventSchema.safeParse({ eventName: "" }).success &&
    emitEventSchema.safeParse({ eventName: "deploy.done", payload: { ok: true } }).success
);

// 12. Все инструменты агента (полный функционал плагина) экспортируются в dist.
const dist = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
const toolNames = [
  "schedule_task",
  "list_tasks",
  "update_task",
  "delete_task",
  "run_task_now",
  "pause_task",
  "resume_task",
  "get_history",
  "get_task_logs",
  "dry_run",
  "manage_workspaces",
  "matrix_control",
  "get_metrics",
  "get_analytics",
  "manage_settings",
  "manage_templates",
  "manage_profiles",
  "transfer_tasks",
  "send_notification",
  "get_dashboard_info",
  "cleanup_history",
  "emit_event",
];
check(
  `все ${toolNames.length} инструментов агента присутствуют в сборке`,
  toolNames.every((name) => dist.includes(`name: "${name}"`))
);

// 12b. Ручной запуск не должен зависеть от cron: обёртка получает
// одноразовый маркер --force-file, который снимает проверку расписания.
const psWrapper = fs.readFileSync(
  new URL("./dist/core/ps-wrapper.js", import.meta.url),
  "utf8"
);
check(
  "run_task_now: обёртка поддерживает --force-file и requestImmediateRun",
  psWrapper.includes("--force-file") && psWrapper.includes("requestImmediateRun")
);

// PL-6.1: подсказка про явный exit 0 в обеих обёртках.
const bashWrapper = fs.readFileSync(
  new URL("./dist/core/wrappers/bash.js", import.meta.url),
  "utf8"
);
check(
  "PL-6.1: pre-flight ошибка подсказывает явный exit 0 в PS и bash",
  psWrapper.includes("exit 0") && bashWrapper.includes("exit 0")
);

// PL-69: в журнале должна быть реальная причина падения beforeScript.
check(
  "PL-69: pre-flight лог содержит команду, код выхода и stderr",
  psWrapper.includes("Pre-flight причина: command=$BeforeScript; exitCode=$preCode") &&
    psWrapper.includes("Pre-flight stderr: $line") &&
    psWrapper.includes("Pre-flight stdout: $line") &&
    psWrapper.includes("stderr=$preStderrText")
);

// PL-7.2: обе обёртки пишут разделённые stdout/stderr через hook-output.js.
const hookHelper = fs.readFileSync(new URL("./dist/hook-output.js", import.meta.url), "utf8");
check(
  "PL-7.2: обёртки подключают hook-output.js для preFlight/postFlight",
  psWrapper.includes("hook-output.js") &&
    psWrapper.includes("Write-HookStructuredOutput") &&
    bashWrapper.includes("run_hook_captured") &&
    bashWrapper.includes("hook-output.js") &&
    hookHelper.includes("appendHookOutputLog")
);
const hookOut = path.join(tempRoot, "hook-stdout.txt");
const hookErr = path.join(tempRoot, "hook-stderr.txt");
fs.writeFileSync(hookOut, "push ok\n", "utf8");
fs.writeFileSync(hookErr, "remote: diagnostics\n", "utf8");
const hookRun = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./dist/hook-output.js", import.meta.url)), "postFlight", "PL7-hook-probe", "3", hookOut, hookErr, "42"],
  { encoding: "utf8" },
);
const hookLogs = readStructuredLogs({ event: "hook.output", task: "PL7-hook-probe", limit: 5 });
check(
  "PL-7.2: hook-output.js пишет exit code и разделённые потоки в журнал",
  hookRun.status === 0 &&
    hookLogs.records.some(
      (record) =>
        record.postFlightExitCode === 3 &&
        record.postFlightStdout?.includes("push ok") &&
        record.postFlightStderr?.includes("remote: diagnostics") &&
        record.runId === 42,
    )
);

// QA-D316-6: проваленный quality gate пишет фазу qualityGate и свой вывод.
const gateOut = path.join(tempRoot, "gate-stdout.txt");
const gateErr = path.join(tempRoot, "gate-stderr.txt");
fs.writeFileSync(gateOut, "npm error: missing module\n", "utf8");
fs.writeFileSync(gateErr, 'TOKEN=supersecret\n', "utf8");
const gateHookRun = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./dist/hook-output.js", import.meta.url)), "qualityGate", "QA-D316-6-probe", "1", gateOut, gateErr, "43"],
  { encoding: "utf8" },
);
const gateHookLogs = readStructuredLogs({ event: "hook.output", task: "QA-D316-6-probe", limit: 5 });
check(
  "QA-D316-6: hook-output.js пишет фазу qualityGate с stdout/stderr гейта",
  gateHookRun.status === 0 &&
    gateHookLogs.records.some(
      (record) =>
        record.phase === "qualityGate" &&
        record.qualityGateExitCode === 1 &&
        record.qualityGateStdout?.includes("missing module") &&
        record.runId === 43,
    )
);
check(
  "QA-D316-6: секреты в выводе quality gate маскируются в журнале",
  gateHookLogs.records.some(
    (record) =>
      record.phase === "qualityGate" &&
      typeof record.qualityGateStderr === "string" &&
      !record.qualityGateStderr.includes("supersecret"),
  )
);

// QV-8: дочерний `opencode run` помечается обёрткой и не получает инструменты.
check(
  "QV-8: isChildRunMode распознаёт только явные truthy-значения",
  isChildRunMode({}) === false &&
    isChildRunMode({ [CHILD_RUN_ENV]: "1" }) === true &&
    isChildRunMode({ [CHILD_RUN_ENV]: " TRUE " }) === true &&
    isChildRunMode({ [CHILD_RUN_ENV]: "off" }) === false
);
check(
  "QV-8: PS и bash обёртки выставляют маркер дочернего прогона",
  psWrapper.includes(`$env:${CHILD_RUN_ENV} = "1"`) &&
    psWrapper.includes("Remove-Item Env:\\" + CHILD_RUN_ENV) &&
    bashWrapper.includes(`export ${CHILD_RUN_ENV}=1`)
);
check(
  "PL-25: обе обёртки снимают и проверяют worktree snapshot гейта",
  psWrapper.includes("worktree-snapshot") &&
    psWrapper.includes("worktree-verify") &&
    bashWrapper.includes("worktree-snapshot") &&
    bashWrapper.includes("worktree-verify")
);
const childSpecs = createToolSpecs({}, { [CHILD_RUN_ENV]: "1" });
const parentSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "all" });
const defaultSpecs = createToolSpecs({}, {});
const adminSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "admin" });
check(
  `QV-8: поверхность инструментов ${parentSpecs.length} → ${childSpecs.length} в дочернем прогоне`,
  parentSpecs.length === 34 && Array.isArray(childSpecs) && childSpecs.length === 0
);
const defaultNames = defaultSpecs.map((spec) => spec.name);
const adminNames = adminSpecs.map((spec) => spec.name);
check(
  `QA-PORT-4/T-1: дефолтный профиль core = 10 инструментов, включая emit_event (${defaultSpecs.length})`,
  defaultSpecs.length === 10 &&
    defaultNames.includes("schedule_task") &&
    defaultNames.includes("list_tasks") &&
    defaultNames.includes("emit_event") &&
    !defaultNames.some((name) => name.startsWith("manage_") || name.endsWith("_advanced"))
);
check(
  `QA-PORT-4/T-1/T-3: профиль admin = core + manage_* + advanced (${adminSpecs.length})`,
  adminSpecs.length === 19 &&
    adminNames.filter((name) => name.startsWith("manage_")).length === 6 &&
    adminNames.includes("schedule_advanced") &&
    adminNames.includes("update_advanced")
);
check(
  "T-1: невалидное значение профиля безопасно падает в core",
  createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "bogus" }).length === 10
);

// T-2: «толстые» поля доступны только в advanced-инструментах; базовые схемы
// их отбрасывают, а полные — сохраняют. Оба варианта идут через общий хендлер,
// поэтому V1/V2 и RPC видят одинаковый контракт (T-2.3).
const matrixOnly = {
  name: "T2-probe",
  prompt: "probe",
  schedule: "0 7 1 * *",
  matrix: { workspaceIds: [] },
};
const coreScheduleParsed = coreScheduleTaskSchema.parse(matrixOnly);
const advancedScheduleParsed = scheduleTaskSchema.parse(matrixOnly);
const coreUpdateParsed = coreUpdateTaskSchema.parse({ name: "T2-probe", matrix: { workspaceIds: [] } });
const advancedUpdateParsed = updateTaskSchema.parse({ name: "T2-probe", matrix: { workspaceIds: [] } });
check(
  "T-2.1: базовая schedule_task не несёт matrix/DAG/retry, полная схема — несёт",
  coreScheduleParsed.matrix === undefined && advancedScheduleParsed.matrix !== undefined
);
check(
  "T-2.2: базовая update_task не несёт matrix/DAG/retry, полная схема — несёт",
  coreUpdateParsed.matrix === undefined && advancedUpdateParsed.matrix !== undefined
);
const scheduleSpec = parentSpecs.find((spec) => spec.name === "schedule_advanced");
const updateSpec = parentSpecs.find((spec) => spec.name === "update_advanced");
check(
  "T-2.3: паритет контракта — advanced-спеки используют общие хендлеры и полные схемы",
  scheduleSpec?.input === scheduleTaskSchema &&
    updateSpec?.input === updateTaskSchema &&
    typeof createToolHandlers({}).schedule_advanced === "function" &&
    typeof createToolHandlers({}).update_advanced === "function"
);

// PL-70: все manage_* явно описывают контракт action, чтобы агент не терял вызовы.
const manageToolNames = [
  "manage_workspaces",
  "manage_settings",
  "manage_local_ai",
  "manage_templates",
  "manage_profiles",
  "manage_secrets",
];
const manageSpecs = parentSpecs.filter((spec) => manageToolNames.includes(spec.name));
check(
  `PL-70: все ${manageToolNames.length} manage_* описали доступные действия и read-действие`,
  manageSpecs.length === manageToolNames.length &&
    manageSpecs.every(
      (spec) =>
        spec.description.includes("Only listed actions") &&
        spec.description.includes("never guess get") &&
        /read action \(list\/get\)/.test(spec.description)
    )
);
check(
  "PL-70: action=get отвергается там, где объявлен только list",
  !manageTemplatesSchema.safeParse({ action: "get" }).success &&
    !manageProfilesSchema.safeParse({ action: "get" }).success &&
    manageSettingsSchema.safeParse({ action: "get" }).success
);

// 13. Описания инструментов переведены на английский.
check(
  "описания инструментов на английском",
  dist.includes("Partially updates an existing task") &&
    dist.includes("Returns recent run history") &&
    dist.includes("Matrix lifecycle")
);

// 14. getTaskLogs: параметр lines возвращает последние N строк.
const logName = "agent-log-test";
const logPath = path.join(LOG_DIR, `${sanitizeName(logName)}.log`);
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(
  logPath,
  Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\r\n"),
  "utf8"
);
const tail = await getTaskLogs(logName, 3);
check(
  "get_task_logs: lines=3 возвращает последние 3 строки",
  tail.error === undefined && tail.logs.split("\n").length === 3 && tail.logs.endsWith("line-10")
);

// 15. getTaskLogs: по умолчанию читает последние 50 строк.
const defaultTail = await getTaskLogs(logName);
check(
  "get_task_logs: по умолчанию не больше 50 строк",
  defaultTail.error === undefined && defaultTail.logs.split("\n").length === 10
);

// 16. getTaskLogs: отсутствующий лог даёт понятную ошибку.
const missing = await getTaskLogs("no-such-task-log");
check(
  "get_task_logs: отсутствующий лог даёт ошибку",
  Boolean(missing.error) && missing.logs === ""
);

// 17. QA-P3.3: delete_template принимает имя шаблона как алиас id.
const repoSource = fs.readFileSync(new URL("./src/db/templates-repo.ts", import.meta.url), "utf8");
check(
  "QA-P3.3: репозиторий удаляет по id или имени",
  repoSource.includes("DELETE FROM templates WHERE id = ? OR name = ?")
);

const byName = await saveTemplate({ name: "QA-P3.3 Probe", prompt: "probe" });
await deleteTemplate(byName.name);
const afterNameDelete = await loadTemplates();
check(
  "QA-P3.3: шаблон удалён по имени",
  !afterNameDelete.some((template) => template.id === byName.id || template.name === byName.name)
);

// Повторное удаление и удаление по id остаются идемпотентными.
await deleteTemplate(byName.name);
const byId = await saveTemplate({ name: "QA-P3.3 Probe 2", prompt: "probe" });
await deleteTemplate(byId.id);
const afterIdDelete = await loadTemplates();
check(
  "QA-P3.3: повторное удаление и удаление по id работают",
  !afterIdDelete.some((template) => template.id === byId.id || template.name === byId.name)
);

// PL-17/PL-28/PL-32: MCP-обработчик manage_templates принимает name для delete.
const handlers = createToolHandlers({});
const mcpProbe = await saveTemplate({ name: "PL-32 MCP Probe", prompt: "probe" });
const mcpDelete = JSON.parse(
  (await handlers.manage_templates({ action: "delete", name: mcpProbe.name })).content,
);
check(
  "PL-32: manage_templates delete по имени через MCP-обработчик",
  mcpDelete.success === true &&
    !(await loadTemplates()).some((template) => template.name === mcpProbe.name)
);

// PL-74/PL-88: write-путь (RPC-вызов без Zod) тоже отклоняет модель без provider/.
const pl74Handler = JSON.parse(
  (
    await handlers.schedule_task({
      name: "pl74-no-prefix",
      schedule: "0 3 * * *",
      prompt: "probe",
      model: "mimo-v2.6-flash-free",
    })
  ).content
);
check(
  "PL-74/PL-88: write-путь schedule_task тоже отклоняет модель без префикса",
  pl74Handler.success === false &&
    /provider\/model|Invalid model/.test(JSON.stringify(pl74Handler))
);

// PL-19: get_task_logs принимает name и taskName.
check(
  "PL-19: схема get_task_logs принимает name и taskName",
  getTaskLogsSchema.safeParse({ name: logName }).success &&
    getTaskLogsSchema.safeParse({ taskName: logName }).success
);
const logsByAlias = JSON.parse((await handlers.get_task_logs({ taskName: logName, lines: 3 })).content);
const logsByName = JSON.parse((await handlers.get_task_logs({ name: logName, lines: 3 })).content);
const logsNoName = JSON.parse((await handlers.get_task_logs({})).content);
check(
  "PL-19: обработчик get_task_logs читает логи по taskName/name",
  logsByAlias.success === true &&
    logsByName.success === true &&
    logsByAlias.logs.endsWith("line-10") &&
    logsNoName.success === false
);

// PL-35: emit_event возвращает код, список совпавших и ошибок запуска.
const noSubscribers = await emitEventCore("qa.pl35.no-such-event", {});
const emptyEvent = await emitEventCore("   ", {});
check(
  "PL-35: emit_event различает no_subscribers и пустое имя",
  noSubscribers.code === "no_subscribers" &&
    noSubscribers.success === true &&
    Array.isArray(noSubscribers.matched) &&
    Array.isArray(noSubscribers.failed) &&
    emptyEvent.success === false
);
const rpcSource = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
const rpcStart = rpcSource.indexOf("emit_event: async (");
const rpcHandler = rpcSource.slice(rpcStart, rpcStart + 300);
check(
  "PL-35: RPC-хендлер использует общий обработчик emit_event",
  rpcStart >= 0 &&
    rpcHandler.includes("emitEventCore") &&
    !rpcHandler.includes("normalizePriority")
);

// PL-53: отказ старта по событийному триггеру обязан попадать в историю и
// структурированный журнал, а не только в console.error хоста.
const eventStart = rpcSource.indexOf("async function scheduleEventRun(");
const eventBody = rpcSource.slice(eventStart, eventStart + 2000);
check(
  "PL-53: отказ scheduleEventRun пишется в историю и журнал",
  eventStart >= 0 &&
    /recordRun\(taskName,\s*"error"/.test(eventBody) &&
    eventBody.includes('event: "trigger.start_failed"') &&
    eventBody.includes("reason,")
);

// QV-3: emit_event различает подписчиков по mcpEvent.server.
const qv3Def = (server, event = "deploy.done") => ({
  name: `qv3-${server}`,
  triggerType: "mcp-event",
  mcpEvent: { server, event },
});
const qv3Github = qv3Def("github");
const qv3Jira = qv3Def("jira");
check(
  "QV-3: emitEventSchema принимает server",
  emitEventSchema.safeParse({ eventName: "deploy.done", server: "github" }).success &&
    emitEventSchema.safeParse({ eventName: "deploy.done" }).success
);
check(
  "QV-3: сервер учитывается при сопоставлении подписки",
  matchesMcpEventSubscription(qv3Github, "DEPLOY.DONE", "GitHub") === true &&
    matchesMcpEventSubscription(qv3Github, "deploy.done", "jira") === false &&
    matchesMcpEventSubscription(qv3Jira, "deploy.done", "github") === false
);
check(
  "QV-3: без server сохраняется обратная совместимость",
  matchesMcpEventSubscription(qv3Github, "deploy.done") === true &&
    matchesMcpEventSubscription(qv3Jira, "deploy.done", "   ") === true &&
    matchesMcpEventSubscription({ name: "cron", triggerType: "cron" }, "deploy.done") === false
);

// PL-48: definition может быть сохранена с алиасом eventName — матчер должен
// через normalizeMcpEventTrigger, иначе задача не получит событие.
const pl48Def = (mcpEvent) => ({ name: "pl48-alias", triggerType: "mcp-event", mcpEvent });
check(
  "PL-48: матчер понимает алиас eventName в сохранённой задаче",
  matchesMcpEventSubscription(pl48Def({ server: "agent-steward", eventName: "qa.pl48.start" }), "QA.PL48.START", "AGENT-STEWARD") === true &&
    matchesMcpEventSubscription(pl48Def({ server: "github", event: "qa.pl48.start", eventName: "ignored" }), "ignored") === false &&
    matchesMcpEventSubscription(pl48Def({ eventName: "qa.pl48.start", filter: "ok = true" }), "qa.pl48.start", undefined, { ok: true }) === true &&
    matchesMcpEventSubscription(pl48Def({ eventName: "qa.pl48.start", filter: "ok = true" }), "qa.pl48.start", undefined, { ok: false }) === false
);

// PL-42: mcpEvent принимает и event, и алиас eventName (совместимость с emit_event).
check(
  "PL-42: схема schedule_task принимает eventName и event",
  scheduleTaskSchema.safeParse({
    name: "pl42-alias",
    schedule: "",
    prompt: "probe",
    triggerType: "mcp-event",
    mcpEvent: { server: "github", eventName: "deploy.done" },
  }).success &&
    scheduleTaskSchema.safeParse({
      name: "pl42-event",
      schedule: "",
      prompt: "probe",
      triggerType: "mcp-event",
      mcpEvent: { server: "github", event: "deploy.done" },
    }).success
);

const pl42Alias = normalizeMcpEventTrigger({ server: "github", eventName: " deploy.done " });
const pl42Event = normalizeMcpEventTrigger({
  server: "github",
  event: "deploy.done",
  filter: "repo=x",
});
check(
  "PL-42: eventName создаёт задачу с event из алиаса",
  pl42Alias?.event === "deploy.done" && pl42Alias?.server === "github"
);
check(
  "PL-42: mcpEvent.event работает как раньше (server + filter)",
  pl42Event?.event === "deploy.done" &&
    pl42Event?.server === "github" &&
    pl42Event?.filter === "repo=x"
);
check(
  "PL-42: при конфликте полей event имеет приоритет над eventName",
  normalizeMcpEventTrigger({
    server: "github",
    event: "deploy.done",
    eventName: "deploy.failed",
  })?.event === "deploy.done"
);
const pl42Missing = JSON.parse(
  (
    await handlers.schedule_task({
      name: "pl42-no-event",
      schedule: "",
      prompt: "probe",
      triggerType: "mcp-event",
      mcpEvent: { server: "github" },
    })
  ).content
);
check(
  "PL-42: без event и eventName schedule_task возвращает ошибку",
  pl42Missing.success === false &&
    /mcpEvent\.event/.test(pl42Missing.error) &&
    /mcpEvent\.eventName/.test(pl42Missing.error)
);
check(
  "PL-42: path schedule_task использует общую нормализацию",
  /normalizeMcpEventTrigger\(mcpEvent\)/.test(rpcSource)
);

// PL-4: get_metrics отдаёт toolBlocked как показатель политики (а не ошибку).
const metricsPayload = JSON.parse((await handlers.get_metrics({})).content);
check(
  "PL-4: get_metrics содержит счётчик toolBlocked",
  typeof metricsPayload.metrics.toolBlocked === "number" && metricsPayload.metrics.toolBlocked >= 0
);

// QV-11.1: офлайн-оценка поверхности инструментов без вызова модели.
const { measureToolSurface } = await import("./dist/core/usage-surface.js");
// QV-11.1: реальный офлайн-токенайзер, без вызовов модели и без chars→tokens.
const { encode } = await import("gpt-tokenizer");
const countTokens = (text) => encode(text).length;
const surface = measureToolSurface(createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "all" }), {
  countTokens,
});
const coreSurface = measureToolSurface(defaultSpecs, { countTokens });
console.log(
  `QV-11.1 surface: ${surface.tools} tools, ${surface.descriptionCount} descriptions, ` +
    `${surface.descriptionChars} description chars, ~${surface.estimatedTokens} tokens`,
);
console.log(
  `T-1/T-2 core surface: ${coreSurface.tools} tools, ~${coreSurface.estimatedTokens} tokens`,
);
check(
  "QV-11.1: оценка поверхности инструментов детерминирована",
  surface.tools === 34 &&
    surface.descriptionCount > 0 &&
    surface.descriptionCount <= surface.tools &&
    surface.descriptionChars > 0 &&
    surface.estimatedTokens > surface.descriptionChars / 4
);
check(
  `T-1.2/T-1.4: дефолтный профиль ≤ 6k токенов (факт: ${coreSurface.estimatedTokens})`,
  coreSurface.tools === 10 &&
    coreSurface.estimatedTokens > 0 &&
    coreSurface.estimatedTokens <= 6000 &&
    coreSurface.estimatedTokens < surface.estimatedTokens / 3
);

// --- Деталь 3.11: диета core-схем без потери возможностей ---
{
  const {
    coreScheduleTaskSchema,
    scheduleTaskSchema,
    compactHistoryRecords,
  } = await import("./dist/index.js");
  const coreKeys = Object.keys(coreScheduleTaskSchema.shape);
  const fullKeys = Object.keys(scheduleTaskSchema.shape);
  check(
    "3.11: core сохраняет все базовые поля (возможности не потеряны)",
    ["name", "schedule", "prompt", "model", "timeoutSeconds", "qualityGate",
      "workingDirectory", "worktree", "tokenBudget", "allowedTools", "deniedTools",
      "triggerType"].every((key) => coreKeys.includes(key))
  );
  check(
    "3.11: advanced-поля по-прежнему вынесены из core",
    !coreKeys.includes("matrix") && !coreKeys.includes("dependsOn") &&
      fullKeys.includes("matrix") && fullKeys.includes("dependsOn")
  );
  check(
    "3.11: описания core короче полных, а advanced сохраняет подробности",
    coreScheduleTaskSchema.shape.schedule.description.length <
      scheduleTaskSchema.shape.schedule.description.length &&
      scheduleTaskSchema.shape.schedule.description.includes("5 fields")
  );
  // Реальная экономия — в тексте описаний, который уходит провайдеру.
  // JSON.stringify(zod) считает внутренние обёртки, поэтому сравниваем
  // именно суммарную длину описаний одних и тех же полей.
  const descLen = (schema, keys) =>
    keys.reduce((sum, key) => sum + (schema.shape[key]?.description?.length ?? 0), 0);
  const coreDescChars = descLen(coreScheduleTaskSchema, coreKeys);
  const fullDescChars = descLen(scheduleTaskSchema, coreKeys);
  check(
    `3.11: описания core легче полных (${coreDescChars} < ${fullDescChars} символов)`,
    coreDescChars < fullDescChars && fullDescChars - coreDescChars > 500
  );
  const longError = "x".repeat(1000);
  const original = [{ taskName: "a", error: longError }, { taskName: "b", error: "short" }];
  const compacted = compactHistoryRecords(original);
  check(
    "3.11: compactHistoryRecords урезает длинный error и не мутирует исходник",
    compacted[0].error.length < longError.length &&
      compacted[0].error.endsWith("…[truncated]") &&
      compacted[1].error === "short" &&
      original[0].error === longError
  );
}

// QA-PORT-4: event-driven задачи доступны в core-профиле. Короткое поле
// mcpEvent и инструмент emit_event переведены в core. QA-D316-2: цепочки
// nextTaskOnSuccess/nextTaskOnError — тоже плоские строки, поэтому больше
// не требуют admin-профиля (бывший PL-129).
{
  const coreShape = coreScheduleTaskSchema.shape;
  const fullShape = scheduleTaskSchema.shape;
  check(
    "QA-PORT-4/QA-D316-2: coreScheduleTaskSchema.shape содержит mcpEvent и обе цепочки",
    "mcpEvent" in coreShape &&
      "nextTaskOnSuccess" in coreShape &&
      "nextTaskOnError" in coreShape
  );
  check(
    "QA-D316-2: полная scheduleTaskSchema содержит обе цепочки",
    "nextTaskOnSuccess" in fullShape && "nextTaskOnError" in fullShape
  );
  const localeHints = ["en", "ru", "zh", "tr"].map((locale) => {
    const catalog = JSON.parse(
      fs.readFileSync(new URL(`./locales/${locale}.json`, import.meta.url), "utf8")
    );
    return catalog["tool.error.mcpEventRequired"] ?? "";
  });
  check(
    "QA-PORT-4: все 4 локали упоминают mcpEvent/emit_event, admin-профиль и nextTaskOnSuccess",
    localeHints.every(
      (hint) =>
        hint.includes("mcpEvent") &&
        hint.includes("emit_event") &&
        hint.includes("schedule_advanced") &&
        hint.includes("AGENT_STEWARD_TOOL_PROFILE=all") &&
        hint.includes("nextTaskOnSuccess")
    )
  );
}

// QA-D316-2: цепочки, принятые core-профилем, доходят до definition и view.
// Задачу в ОС не регистрируем (schtasks не трогаем): проверяем форму,
// сохранённое определение и маппинг в list_tasks по исходнику dist/index.js.
{
  const parsed = coreScheduleTaskSchema.parse({
    name: "qa-d316-2-chain-probe",
    schedule: "0 4 * * *",
    prompt: "probe",
    nextTaskOnSuccess: "qa-d316-2-on-success",
    nextTaskOnError: "qa-d316-2-on-error",
  });
  check(
    "QA-D316-2: core-схема сохраняет оба поля в разобранных данных",
    parsed.nextTaskOnSuccess === "qa-d316-2-on-success" &&
      parsed.nextTaskOnError === "qa-d316-2-on-error"
  );
  saveTask(parsed);
  const stored = getTask("qa-d316-2-chain-probe");
  check(
    "QA-D316-2: definition хранит обе цепочки после saveTask/getTask",
    stored?.nextTaskOnSuccess === "qa-d316-2-on-success" &&
      stored?.nextTaskOnError === "qa-d316-2-on-error"
  );
  const listViewSource = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
  check(
    "QA-D316-2: list_tasks маппит обе цепочки из definition",
    /nextTaskOnSuccess:\s*def\?\.nextTaskOnSuccess\s*\?\?\s*null/.test(listViewSource) &&
      /nextTaskOnError:\s*def\?\.nextTaskOnError\s*\?\?\s*null/.test(listViewSource)
  );
}

// QA-HIST-PAGE: get_history отдаёт пагинацию и полный count, а не тихий кап 200.
{
  const historySpec = defaultSpecs.find((spec) => spec.name === "get_history");
  check(
    "QA-HIST-PAGE: core-схема get_history принимает offset",
    "offset" in (historySpec?.input?.shape ?? {})
  );
  check(
    "QA-HIST-PAGE: get_history возвращает total/hasMore/truncated и offset",
    /const hasMore\s*=\s*offset \+ output\.length < total/.test(dist) &&
      /truncated:\s*hasMore/.test(dist) &&
      /total,[\s\S]{0,80}offset,[\s\S]{0,40}hasMore,[\s\S]{0,40}truncated/.test(dist)
  );
  const rpcSource = fs.readFileSync(new URL("./dist/rpc.js", import.meta.url), "utf8");
  check(
    "QA-HIST-PAGE: RPC-контракт get_history описывает поля пагинации",
    /offset:\s*\{ type: "number" \}/.test(rpcSource) &&
      /hasMore:\s*\{ type: "boolean" \}/.test(rpcSource) &&
      /truncated:\s*\{ type: "boolean" \}/.test(rpcSource)
  );
}

// PL-54: промпт с двойными кавычками доходит до opencode через cmd.exe
// без обрезки. Реальный вызов runOpencode с подменённым opencode.cmd в PATH:
// shim форвардит %* в node-скрипт, который печатает полученный argv как JSON.
{
  const pl54Dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl54-argv-"));
  const echoPath = path.join(pl54Dir, "echo.cjs");
  const shimPath = path.join(pl54Dir, "opencode.cmd");
  fs.writeFileSync(echoPath, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n");
  fs.writeFileSync(shimPath, `@ECHO off\r\nSETLOCAL\r\nnode "${echoPath}" %*\r\n`);
  const prompts = [
    'Скажи "привет" мир',
    'echo "quoted" and "another"',
    'промпт без кавычек, но с пробелами',
    'путь C:\\Program Files\\x',
  ];
  check(
    "PL-54: quoteCmdArg экранирует двойные кавычки удвоением",
    quoteCmdArg('Скажи "привет" мир') === '"Скажи ""привет"" мир"'
  );
  check(
    "PL-54: валидация cmd-строки пропускает двойные кавычки, но не переводы строк и NUL",
    validateCmdLineText('Скажи "привет" мир', "Промпт") === null &&
      /перевод строки/.test(validateCmdLineText("a\nb", "Промпт") ?? "") &&
      /NUL/.test(validateCmdLineText("a\0b", "Промпт") ?? "")
  );
  check(
    "PL-54: opencodeCommandFor (win32) строит cmd.exe /d /s /c",
    (() => {
      const cmd = opencodeCommandFor("win32", ["run", "--", 'Скажи "привет" мир']);
      return cmd.file === "cmd.exe" &&
        cmd.args[0] === "/d" && cmd.args[1] === "/s" && cmd.args[2] === "/c" &&
        cmd.args[3].includes('"Скажи ""привет"" мир"');
    })()
  );
  if (process.platform === "win32") {
    const savedPath = process.env.PATH;
    process.env.PATH = `${pl54Dir}${path.delimiter}${savedPath ?? ""}`;
    try {
      for (const prompt of prompts) {
        const result = await runOpencode(["run", "--", prompt]);
        let delivered = null;
        try {
          delivered = result.ok ? JSON.parse(result.stdout).at(-1) : null;
        } catch {}
        check(
          `PL-54: runOpencode доставляет промпт без обрезки: ${JSON.stringify(prompt)}`,
          delivered === prompt
        );
      }
    } finally {
      process.env.PATH = savedPath;
    }
  } else {
    console.log("PL-54: реальный cmd.exe-прогон пропущен (не Windows)");
  }
}

// B-2: actionable model routing в schedule_task / update_task.
{
  const { getSchedulerBackend } = await import("./dist/core/scheduler/index.js");
  const backend = getSchedulerBackend();
  const originalBackend = {
    createTask: backend.createTask,
    listTasks: backend.listTasks,
    deleteTask: backend.deleteTask,
  };
  const created = new Set();
  backend.createTask = async ({ name }) => { created.add(name); };
  backend.listTasks = async () => [...created].map((taskName) => ({ taskName }));
  backend.deleteTask = async (name) => { created.delete(name); };

  check(
    "B-2.1: обе core/full-схемы принимают autoSelectModel и отвергают не-boolean",
    Object.keys(scheduleTaskSchema.shape).includes("autoSelectModel") &&
      Object.keys(coreScheduleTaskSchema.shape).includes("autoSelectModel") &&
      Object.keys(updateTaskSchema.shape).includes("autoSelectModel") &&
      Object.keys(coreUpdateTaskSchema.shape).includes("autoSelectModel") &&
      scheduleTaskSchema.safeParse({
      name: "B2-Schema", schedule: "0 9 * * *", prompt: "x", autoSelectModel: true,
    }).success &&
      coreScheduleTaskSchema.safeParse({
        name: "B2-Schema", schedule: "0 9 * * *", prompt: "x", autoSelectModel: true,
      }).success &&
      updateTaskSchema.safeParse({ name: "B2-Schema", autoSelectModel: false }).success &&
      coreUpdateTaskSchema.safeParse({ name: "B2-Schema", autoSelectModel: true }).success &&
      rejects(scheduleTaskSchema, {
        name: "B2-Schema", schedule: "0 9 * * *", prompt: "x", autoSelectModel: "yes",
      })
  );

  try {
    const noModel = JSON.parse((await handlers.schedule_task({
      name: "B2-NoModel", schedule: "0 9 * * *",
      prompt: "Проведи аудит безопасности и рефакторинг ядра",
    })).content);
    check(
      "B-2.1: schedule_task без явной модели возвращает предупреждение в результате",
      noModel.success === true && Array.isArray(noModel.warnings) &&
        noModel.warnings.some((w) => w.includes("B-2.1:") &&
          w.includes("anthropic/claude-3-5-sonnet")) &&
        noModel.task.model === null && noModel.autoSelected === false
    );

    const auto = JSON.parse((await handlers.schedule_task({
      name: "B2-AutoComplex", schedule: "0 9 * * *",
      prompt: "Проведи аудит безопасности", autoSelectModel: true,
    })).content);
    check(
      "B-2.1: schedule_task с autoSelectModel подбирает модель без предупреждения",
      auto.success === true && auto.task.model === "anthropic/claude-3-5-sonnet" &&
        auto.autoSelected === true && (auto.warnings ?? []).length === 0
    );

    const explicit = JSON.parse((await handlers.schedule_task({
      name: "B2-Explicit", schedule: "0 9 * * *",
      prompt: "Проведи аудит безопасности",
      model: "opencode/hy4-flash-free", autoSelectModel: true,
    })).content);
    check(
      "B-2.2: schedule_task не переопределяет явную модель даже с autoSelectModel",
      explicit.success === true && explicit.task.model === "opencode/hy4-flash-free" &&
        explicit.autoSelected === false && (explicit.warnings ?? []).length === 0
    );

    const updAuto = JSON.parse((await handlers.update_task({
      name: "B2-AutoComplex", prompt: "Собери отчёт о статусе задач", autoSelectModel: true,
    })).content);
    check(
      "B-2.1: update_task пересчитывает автоподобранную модель по новому промпту",
      updAuto.success === true && updAuto.model === "opencode/hy4-flash-free" &&
        updAuto.autoSelected === true && (updAuto.warnings ?? []).length === 0
    );

    const updWarn = JSON.parse((await handlers.update_task({
      name: "B2-NoModel", prompt: "Собери отчёт о статусе задач", autoSelectModel: false,
    })).content);
    check(
      "B-2.1: update_task без модели и без автоподбора возвращает предупреждение",
      updWarn.success === true && Array.isArray(updWarn.warnings) &&
        updWarn.warnings.some((w) => w.includes("B-2.1:")) &&
        updWarn.model === null && updWarn.autoSelected === false
    );

    const updExplicit = JSON.parse((await handlers.update_task({
      name: "B2-Explicit", prompt: "Проведи аудит безопасности",
      model: "anthropic/claude-3-5-sonnet", autoSelectModel: true,
    })).content);
    check(
      "B-2.2: update_task не переопределяет явную модель даже с autoSelectModel",
      updExplicit.success === true &&
        updExplicit.model === "anthropic/claude-3-5-sonnet" &&
        updExplicit.autoSelected === false && (updExplicit.warnings ?? []).length === 0
    );
  } finally {
    backend.createTask = originalBackend.createTask;
    backend.listTasks = originalBackend.listTasks;
    backend.deleteTask = originalBackend.deleteTask;
  }
}

// IM-2 / D02: пакетное удаление задач — чистые функции и частичный успех.
check(
  "IM-2: имена и пакет объединяются, дубли и пустоты отбрасываются",
  JSON.stringify(resolveDeleteNames({ name: " B ", names: ["a", "", "A", "  ", "b", "C"] })) ===
    JSON.stringify(["a", "b", "C"]) &&
    resolveDeleteNames({}).length === 0
);
check(
  "IM-2: частичный успех сохраняет удалённые задачи и ошибки",
  (() => {
    const s = summarizeBatchDelete([
      { name: "ok", removed: ["ok [linux]"], existed: true },
      { name: "absent", removed: [], existed: false },
      { name: "bad", removed: [], existed: true, error: "PL-42 guard" },
    ]);
    return (
      s.success === false &&
      JSON.stringify(s.deleted) === JSON.stringify(["ok", "ok [linux]"]) &&
      JSON.stringify(s.missing) === JSON.stringify(["absent"]) &&
      s.failed.length === 1 &&
      s.failed[0].error === "PL-42 guard" &&
      s.requested === 3
    );
  })()
);
check(
  "IM-2: delete_task объявляет пакетную форму names в схеме",
  typeof deleteTaskSchema.safeParse({ names: ["a", "b"] }) !== "undefined" &&
    deleteTaskSchema.safeParse({ names: ["a", "b"] }).success &&
    !deleteTaskSchema.safeParse({}).success === true
);

// IM-4: батч MCP-вызовов с изоляцией результатов и лимитом пакета.
{
  const { z } = await import("zod");
  const specs = [
    {
      name: "echo",
      input: z.object({ value: z.string() }),
      execute: async (args) => ({ content: [{ type: "text", text: args.value }] }),
    },
    {
      name: "boom",
      input: z.object({}),
      execute: async () => { throw new Error("PL-TEST: boom"); },
    },
  ];
  const batch = await executeBatchCalls(specs, [
    { name: "echo", args: { value: "ok" } },
    { name: "unknown", args: {} },
    { name: "boom", args: {} },
    { name: "echo", args: { value: 42 } },
  ]);
  check(
    "IM-4: батч изолирует ошибки вызовов",
    batch.length === 4 &&
      batch[0].ok === true &&
      batch[0].result?.[0] === "ok" &&
      batch[1].ok === false &&
      batch[1].error?.includes("неизвестный инструмент") === true &&
      batch[2].ok === false &&
      batch[2].error?.includes("PL-TEST: boom") === true &&
      batch[3].ok === false
  );
  const overLimit = await executeBatchCalls(
    specs,
    Array.from({ length: BATCH_CALL_LIMIT + 1 }, () => ({ name: "echo", args: { value: "x" } })),
  );
  check(
    "IM-4: лимит пакета отклоняется",
    overLimit.length === 1 && overLimit[0].ok === false &&
      overLimit[0].error?.includes(String(BATCH_CALL_LIMIT)) === true
  );
  const mcpSource = fs.readFileSync(new URL("./src/mcp.ts", import.meta.url), "utf8");
  check(
    "IM-4: batch_call зарегистрирован в MCP",
    mcpSource.includes('"batch_call"') &&
      mcpSource.includes("executeBatchCalls(") &&
      mcpSource.includes("BATCH_CALL_LIMIT")
  );
}

// QA-UPDATE-SCOPE: частичный update и откат не должны заново валидировать SCOPE прежнего промпта.
{
  const { getSchedulerBackend } = await import("./dist/core/scheduler/index.js");
  const backend = getSchedulerBackend();
  const originalBackend = {
    createTask: backend.createTask,
    listTasks: backend.listTasks,
    deleteTask: backend.deleteTask,
  };
  const created = new Set();
  backend.createTask = async ({ name }) => { created.add(name); };
  backend.listTasks = async () => [...created].map((name) => ({ taskName: name }));
  backend.deleteTask = async (name) => { created.delete(name); };

  const scopePath = "reports/qa-update-scope-missing.json";
  const scopedPrompt = `Собери отчёт. SCOPE: ${scopePath}`;
  try {
    const made = JSON.parse((await handlers.schedule_task({
      name: "QA-UpdateScope", schedule: "0 9 * * *",
      prompt: scopedPrompt, filesCreate: [scopePath],
    })).content);
    check(
      "QA-UPDATE-SCOPE: задача с несуществующим SCOPE создаётся через filesCreate",
      made.success === true
    );

    const updated = JSON.parse((await handlers.update_task({
      name: "QA-UpdateScope", worktree: true,
    })).content);
    check(
      "QA-UPDATE-SCOPE: partial update не перепроверяет SCOPE прежнего промпта",
      updated.success === true && !String(updated.message).includes("PL-79/PL-82")
    );

    const badUpdate = JSON.parse((await handlers.update_task({
      name: "QA-UpdateScope",
      prompt: "SCOPE: reports/qa-update-scope-brand-new.json",
    })).content);
    check(
      "QA-UPDATE-SCOPE: новый SCOPE-путь по-прежнему валидируется",
      badUpdate.success === false && String(badUpdate.message).includes("PL-79/PL-82")
    );
    check(
      "QA-UPDATE-SCOPE: откат восстановил задачу с прежним SCOPE",
      created.has("QA-UpdateScope") === true
    );
  } finally {
    backend.createTask = originalBackend.createTask;
    backend.listTasks = originalBackend.listTasks;
    backend.deleteTask = originalBackend.deleteTask;
  }

  const ru = JSON.parse(fs.readFileSync(new URL("./locales/ru.json", import.meta.url), "utf8"));
  check(
    "QA-UPDATE-SCOPE: rollbackFailed не утверждает ложное «задача отсутствует»",
    ru["tool.task.rollbackFailed"].includes("сохранено в БД") &&
      !ru["tool.task.rollbackFailed"].includes("отсутствует в планировщике")
  );
}

// QA-STATUS-SYNC: list_tasks не должен показывать stale running/unknown,
// если история и активные прогоны говорят обратное.
{
  check(
    "QA-STATUS-SYNC: stale OS-running без истории → success",
    normalizeTaskStatus("running", "success", false) === "success"
  );
  check(
    "QA-STATUS-SYNC: stale OS-running без истории → idle",
    normalizeTaskStatus("running", undefined, false) === "idle"
  );
  check(
    "QA-STATUS-SYNC: реальный активный прогон → running",
    normalizeTaskStatus("ready", "success", true) === "running"
  );
  check(
    "QA-STATUS-SYNC: unknown без истории → idle",
    normalizeTaskStatus("unknown", undefined, false) === "idle"
  );
  check(
    "QA-STATUS-SYNC: unknown с историей error → error",
    normalizeTaskStatus("unknown", "error", false) === "error"
  );
  const source = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
  check(
    "QA-STATUS-SYNC: list_tasks использует normalizeTaskStatus",
    /normalizeTaskStatus\(t\.status,/.test(source) &&
      /listRunningRecords\(\)\.map\(/.test(source)
  );
}

// PL-106: guard изоляции должен быть per-checkout, а не глобальным для процесса.
{
  const source = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
  check(
    "QA-PL106: счётчик PL-106 ключуется каталогом чек-аута",
    source.includes("activeNonIsolatedByCheckout = new Map()") &&
      source.includes("checkoutKeyFor(definition)") &&
      !source.includes("activeNonIsolatedRuns")
  );
  check(
    "QA-PL106: снятие счётчика использует ключ чек-аута на всех выходах",
    source.includes("releaseNonIsolatedRun(isolation.isolated ? null : checkoutKey)") &&
      source.includes("staleDefinition?.worktree ? null : checkoutKeyFor(staleDefinition)")
  );
  const runNow = fs.readFileSync(new URL("./dist/core/scheduler/run-now.js", import.meta.url), "utf8");
  check(
    "QA-PL106: сообщение об ошибке честно указывает на чек-аут",
    runNow.includes("в этом чек-ауте") && !runNow.includes("на процесс плагина")
  );
}

// QA-P1 (25.11): само-диагностика загруженной копии плагина в get_dashboard_info.
// Без неё рассинхрон конфига OpenCode (v0.0.7 по старому пути) невидим агентам.
{
  const { getPluginDiagnostics } = await import("./dist/version.js");
  const diag = getPluginDiagnostics();
  check(
    "QA-PLUGIN-DIAG: диагностика содержит версию и абсолютные пути",
    typeof diag.version === "string" &&
      diag.version.length > 0 &&
      path.isAbsolute(diag.modulePath) &&
      path.isAbsolute(diag.packageRoot) &&
      path.isAbsolute(diag.workspaceRoot) &&
      typeof diag.loadedFromWorkspace === "boolean"
  );
  const dash = JSON.parse((await handlers.get_dashboard_info({})).content);
  check(
    "QA-PLUGIN-DIAG: get_dashboard_info возвращает блок plugin",
    dash.plugin?.version === diag.version &&
      dash.plugin?.packageRoot === diag.packageRoot &&
      dash.plugin?.staleInstallation === diag.staleInstallation
  );
  // Имитируем рабочий каталог с манифестом другой версии того же пакета.
  const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-stale-plugin-"));
  const originalCwd = process.cwd();
  try {
    fs.writeFileSync(
      path.join(staleRoot, "package.json"),
      JSON.stringify({ name: "agent-steward", version: "0.0.0-stale" })
    );
    process.chdir(staleRoot);
    const staleDiag = getPluginDiagnostics();
    check(
      "QA-PLUGIN-DIAG: версия из старого чек-аута помечает установку как stale",
      staleDiag.staleInstallation === true &&
        staleDiag.reason === "identity-mismatch" &&
        staleDiag.workspaceVersion === "0.0.0-stale" &&
        staleDiag.version !== staleDiag.workspaceVersion
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(staleRoot, { recursive: true, force: true });
  }
  const ownDiag = getPluginDiagnostics();
  check(
    "QA-PLUGIN-DIAG: свой чек-аут не помечается как stale",
    ownDiag.reason === "ok" && ownDiag.staleInstallation === false
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\nAgent tools: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
