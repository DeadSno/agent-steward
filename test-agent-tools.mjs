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
const { LOG_DIR, sanitizeName } = await import("./dist/types.js");
const { loadTemplates, saveTemplate, deleteTemplate } = await import("./dist/templates.js");

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
const parentSpecs = createToolSpecs({}, {});
check(
  `QV-8: поверхность инструментов ${parentSpecs.length} → ${childSpecs.length} в дочернем прогоне`,
  parentSpecs.length === 30 && Array.isArray(childSpecs) && childSpecs.length === 0
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
        spec.description.includes("Use ONLY the action values listed above") &&
        spec.description.includes("do not guess an action") &&
        /no get action|get \(read\)/.test(spec.description)
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
const surface = measureToolSurface(createToolSpecs({}, {}), {
  countTokens: (text) => encode(text).length,
});
console.log(
  `QV-11.1 surface: ${surface.tools} tools, ${surface.descriptionCount} descriptions, ` +
    `${surface.descriptionChars} description chars, ~${surface.estimatedTokens} tokens`,
);
check(
  "QV-11.1: оценка поверхности инструментов детерминирована",
  surface.tools === 30 &&
    surface.descriptionCount > 0 &&
    surface.descriptionCount <= surface.tools &&
    surface.descriptionChars > 0 &&
    surface.estimatedTokens > surface.descriptionChars / 4
);

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

const failed = results.filter((r) => !r.ok);
console.log(`\nAgent tools: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
