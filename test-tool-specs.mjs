/**
 * P-1.2: контрактный снимок публичной поверхности инструментов и её паритет
 * со списком RPC-методов. Тест работает против dist/ (после npm run build).
 *
 * Снимок детерминирован: имена сортируются, каждая spec сериализуется в
 * канонический JSON (рекурсивная сортировка ключей) и хэшируется SHA-256.
 * Изменение имени, описания или JSON-схемы однозначно ломает тест —
 * это и есть смысл снимка.
 *
 * Запуск: node test-tool-specs.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";

import { CODE_MODE_BRIDGE_NOTE, coreScheduleTaskSchema, createToolSpecs } from "./dist/index.js";
import { SchedulerRpc } from "./dist/rpc.js";

const EXPECTED_NAMES = ["backup_db", "cleanup_history","delete_task","dry_run","emit_event","get_analytics","get_audit_log","get_dashboard_info","get_history","get_metrics","get_task_logs","list_tasks","manage_local_ai","manage_profiles","manage_secrets","manage_settings","manage_templates","manage_workspaces","matrix_control","pause_task","pipeline_apply","pipeline_export","pipeline_validate","report_bug","restore_db","resume_task","run_task_now","schedule_advanced","schedule_task","self_analysis","send_notification","transfer_tasks","update_advanced","update_task"];

const EXPECTED_HASHES = {
  "backup_db": "1e2e5c835f456cc1ec6d59cc5aee886cbec145704c7ce20245fe863f24e9f425",
  "cleanup_history": "853127264ab9854c23fc5ff576ced049c5e11a2e98f9a233736bb2bb7f097710",
  "delete_task": "c5e32479d6445c8703607930f67068b74628a54fc99416f3ed1b86447c53bbd6",
  "dry_run": "a2745de0884064bc48501fb1a22a53cd81b0c221abc6d66769c99f0ebd2b70ce",
  "emit_event": "69a4a1ecee1fd24248c3aecaf88e3de6640e0da7b7d9857ab79ac80e422431e3",
  "get_analytics": "8268cf115cbfc78835f6cd77c0d40c569a69398b62e4b18a17a4320cbbbc1211",
  "get_audit_log": "95d7f3b67594675a9ba227eaf5a7669fc327389ffb63fc7a875e08a8c32c38eb",
  "get_dashboard_info": "cb06f02d12e893bbf3f8275942acd09fa36c03d9dca20a20b7b5bec30d3de69d",
  "get_history": "b92edfe1fac86da7085b542b3e7168d217226c23dc04e393e19d9ed28f6287cf",
  "get_metrics": "0d6fc70379c301efdbe9880a676e6d40038b2ea4d085f7dd7056b11c85cb2731",
  "get_task_logs": "103d0eef118e78b781b8e000d438ba398da175e387756771609c6007fa18d273",
  "list_tasks": "f0ade897b2eeee46dd8da469a5839ce5f8f4bb2ef2d3afbd5170dcf4f091f966",
  "manage_local_ai": "9930720739344e9915c7883a093df45edab8d1199d4e26a1817ee255b941a179",
  "manage_profiles": "91452c69f58c6a05d32b34cc33f3763c8cfa550ab24110f11f9405d0d1324cb6",
  "manage_secrets": "6f299e9d7b9f6d0f274c039e967ade1ef724c0bce4c21cd79febea3005c18d57",
  "manage_settings": "07ebca5724ee6f582d598a25811cf0e151c27b292cb9f184c887acc421368a02",
  "manage_templates": "190af9f84ae9ef2fe6a79deee0c78cfb8513e5e7cce79d5b52a6d2f50e0b0de3",
  "manage_workspaces": "496dfda65aa16e53309a12552af317aea66287e29d7e51d3fc9abb3278bb811c",
  "matrix_control": "5f30777453632898950abad42549762b912275c1129a4718d70779a7cf58f979",
  "pause_task": "7b692a53a254694db74a5241f009bb6bbfa1459fa1eec6ba0a58c206142fc7ec",
  "pipeline_apply": "e7790906f23cbc53b7cbe487cb791129ce86bbf67fda76b683f5149b0158234e",
  "pipeline_export": "4189bd7e5fda81c5482d342d96df0957d4774fa8ac905f16bfb691540eb85c0e",
  "pipeline_validate": "e318c099197757950eb430129b2915e2233b38fbe099dcf138b066249dc2353a",
  "report_bug": "4f4864272c626a31c9a3f8f0a3131223615066969741b7a2104766fc957d8a8b",
  "resume_task": "79fbf775bd98b0d683461c9dd729991967ef0efe4af1b3e941a6824abe13d8c2",
  "restore_db": "04716abf698825be1a921f42c07ae45906abbf258847585397fa1b3e2b559c68",
  "run_task_now": "d2e78054ed564c0b64c7289a0e4c27aeb73ce6dc77b70e5bfce8bc77016cf7df",
  "schedule_advanced": "908ea14e55f69bc3c91e8a51895827348f63602a643b4e4f5ccee29525dd49d4",
  "schedule_task": "3d545ca3ff6e9ce65bf0ff793302c75a97198a5b565c32afcb3fc0cd56ee8c1e",
  "self_analysis": "a6ea0752bda3e7b3509eeeb92dff665252817d5348592a0a69bda75af98919a9",
  "send_notification": "fcbbf72f33ad244e024d296e164b21ebaca5fca26f820321666599f50bece6f1",
  "transfer_tasks": "aaefe6d85a8266003ecc86a637064634d3e82a2bf187808d39b515ed42493f0d",
  "update_advanced": "a67187006d35114108e0d072f2b6b8248bec39c519e1d4a524b28596c6a5d8f9",
  "update_task": "a7cd4d0d5333ead463954c0eb9ffb29fbc3d375873699de845713e1edce1ad67",
};

const EXPECTED_RPC_METHODS = ["add_workspace","backup_db","cancel_matrix","cleanup_history","cleanup_matrix_orphans","compare_triage","create_profile","create_task","decide_approval","delete_profile","delete_secret","delete_task","delete_template","delete_workspace","discard_dlq","dry_run","dry_run_all","emit_event","expand_matrix_preview","export_tasks","get_analytics","get_audit","get_dashboard_port","get_history","get_matrix_results","get_metrics","get_platform","get_profiles","get_settings","get_shadow_report","get_task_logs","get_tasks","get_templates","get_workspaces","import_tasks","list_approvals","list_dlq","list_durable_runs","list_secrets","pause_durable_run","pause_task","pipeline_apply","pipeline_export","pipeline_validate","reset_shadow_report","restore_db","resume_durable_run","resume_task","retry_dlq","run_mission","run_task","save_secret","save_settings","save_template","self_analysis","send_digest","set_profile","test_local_ai","test_notification","update_task","update_workspace"];

/**
 * Соответствие MCP-инструментов RPC-методам — многие-ко-многим.
 * Это не «один инструмент = один метод»: manage_* объединяет несколько
 * RPC-операций, а часть RPC доступна только через GUI.
 */
const TOOL_TO_RPC = {
  backup_db: ["backup_db"],
  cleanup_history: ["cleanup_history"],
  delete_task: ["delete_task"],
  dry_run: ["dry_run"],
  emit_event: ["emit_event"],
  get_analytics: ["get_analytics"],
  get_audit_log: ["get_audit"],
  get_dashboard_info: ["get_dashboard_port", "get_platform"],
  get_history: ["get_history"],
  get_metrics: ["get_metrics"],
  get_task_logs: ["get_task_logs"],
  list_tasks: ["get_tasks"],
  manage_local_ai: ["test_local_ai", "get_settings", "save_settings"],
  manage_profiles: ["get_profiles", "set_profile", "create_profile", "delete_profile"],
  manage_secrets: ["list_secrets", "save_secret", "delete_secret"],
  manage_settings: ["get_settings", "save_settings"],
  manage_templates: ["get_templates", "save_template", "delete_template"],
  manage_workspaces: ["get_workspaces", "add_workspace", "update_workspace", "delete_workspace"],
  matrix_control: ["get_matrix_results", "cancel_matrix", "cleanup_matrix_orphans", "expand_matrix_preview"],
  pause_task: ["pause_task"],
  pipeline_apply: ["pipeline_apply"],
  pipeline_export: ["pipeline_export"],
  pipeline_validate: ["pipeline_validate"],
  report_bug: ["test_notification"],
  resume_task: ["resume_task"],
  restore_db: ["restore_db"],
  run_task_now: ["run_task"],
  schedule_advanced: ["create_task"],
  schedule_task: ["create_task"],
  self_analysis: ["self_analysis"],
  send_notification: ["test_notification", "send_digest"],
  transfer_tasks: ["export_tasks", "import_tasks"],
  update_advanced: ["update_task"],
  update_task: ["update_task"],
};

/** RPC-методы без MCP-инструмента (GUI / внутренние операции). */
const RPC_ONLY = [
  "compare_triage",
  "decide_approval",
  "discard_dlq",
  "dry_run_all",
  "get_shadow_report",
  "list_approvals",
  "list_dlq",
  "list_durable_runs",
  "pause_durable_run",
  "reset_shadow_report",
  "resume_durable_run",
  "retry_dlq",
  "run_mission",
];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${stable(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function specHash(spec) {
  const payload = {
    name: spec.name,
    description: spec.description,
    input: z.toJSONSchema(spec.input, { target: "draft-2020-12" }),
    ...(spec.output
      ? { output: z.toJSONSchema(spec.output, { target: "draft-2020-12" }) }
      : {}),
  };
  return createHash("sha256").update(stable(payload), "utf8").digest("hex");
}

const sortNames = (a, b) => a.localeCompare(b, "en");
const env = { AGENT_STEWARD_TOOL_PROFILE: "all" };
const specs = createToolSpecs({}, env).slice().sort((a, b) => sortNames(a.name, b.name));
const rpcMethods = Object.keys(SchedulerRpc.methods).slice().sort(sortNames);

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`OK   ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

check("P-1.2: реестр содержит ровно 34 инструмента", () => {
  assert.equal(specs.length, 34);
});
check("P-1.2: имена и порядок (детерминированная сортировка) совпадают со снимком", () => {
  assert.deepEqual(specs.map((spec) => spec.name), EXPECTED_NAMES);
  assert.deepEqual([...EXPECTED_NAMES].sort(sortNames), EXPECTED_NAMES);
});
check("P-1.2: уникальность имён инструментов", () => {
  assert.equal(new Set(specs.map((spec) => spec.name)).size, specs.length);
});
check("QA-D316-19: все описания честно называют лимит каталога Code Mode", () => {
  assert.equal(
    specs.filter((spec) => spec.description.includes(CODE_MODE_BRIDGE_NOTE)).length,
    34,
  );
  assert.match(CODE_MODE_BRIDGE_NOTE, /8 of 34 registered tools/);
  assert.match(CODE_MODE_BRIDGE_NOTE, /MCP tools, CLI and HTTP RPC/);
});
for (const spec of specs) {
  check(`P-1.2: снимок ${spec.name} (name + description + JSON-схемы)`, () => {
    assert.equal(specHash(spec), EXPECTED_HASHES[spec.name]);
  });
}
check("P-1.2: снимок не содержит лишних ключей", () => {
  assert.deepEqual(Object.keys(EXPECTED_HASHES).sort(sortNames), EXPECTED_NAMES);
});
check("P-1.2: output-схема есть только у list_tasks", () => {
  assert.deepEqual(
    specs.filter((spec) => spec.output).map((spec) => spec.name),
    ["list_tasks"],
  );
});
check("P-1.2: все JSON-схемы инструментов валидны для draft-2020-12", () => {
  for (const spec of specs) {
    const json = z.toJSONSchema(spec.input, { target: "draft-2020-12" });
    assert.equal(json.type, "object", `${spec.name}: input должен быть объектом`);
    assert.ok(json.properties, `${spec.name}: нет properties`);
  }
});

// QA-PORT-11:get_history раньше молча игнорировал name и любые опечатки,
// из-за чего фильтр казался сломанным — возвращалась вся история.
const historySpec = specs.find((spec) => spec.name === "get_history");
check("QA-PORT-11: get_history принимает name как псевдоним taskName", () => {
  assert.ok(historySpec, "нет spec get_history");
  assert.equal(historySpec.input.parse({ name: "X", limit: 3 }).name, "X");
  assert.equal(historySpec.input.parse({ taskName: "X", compact: true }).taskName, "X");
});
check("QA-PORT-11: get_history отклоняет неизвестные аргументы", () => {
  const parsed = historySpec.input.safeParse({ name: "X", bogus: 1 });
  assert.equal(parsed.success, false, "неизвестный ключ должен отклоняться, а не игнорироваться");
  assert.match(parsed.error?.issues?.[0]?.message ?? "", /Unrecognized key/i);
});

// QA-PORT-4: event-driven задачи доступны без admin-профиля.
const coreSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "core" });
check("QA-PORT-4: emit_event зарегистрирован в core-профиле", () => {
  assert.ok(coreSpecs.some((spec) => spec.name === "emit_event"));
});
check("QA-PORT-4: core-профиль не тянет admin-инструменты", () => {
  assert.equal(coreSpecs.length, 10);
  assert.equal(coreSpecs.some((spec) => spec.name === "schedule_advanced"), false);
});
check("QA-PORT-4: coreScheduleTaskSchema сохраняет mcpEvent", () => {
  const parsed = coreScheduleTaskSchema.parse({
    name: "qa-port-4-probe",
    prompt: "probe",
    triggerType: "mcp-event",
    mcpEvent: { server: "codebase-memory", event: "qa-port-4-probe" },
  });
  assert.deepEqual(parsed.mcpEvent, { server: "codebase-memory", event: "qa-port-4-probe" });
});
check("QA-D316-2: coreScheduleTaskSchema.shape содержит обе цепочки", () => {
  assert.ok("nextTaskOnSuccess" in coreScheduleTaskSchema.shape, "нет nextTaskOnSuccess");
  assert.ok("nextTaskOnError" in coreScheduleTaskSchema.shape, "нет nextTaskOnError");
  const parsed = coreScheduleTaskSchema.parse({
    name: "qa-d316-2-probe",
    schedule: "0 4 * * *",
    prompt: "probe",
    nextTaskOnSuccess: "on-success",
    nextTaskOnError: "on-error",
  });
  assert.equal(parsed.nextTaskOnSuccess, "on-success");
  assert.equal(parsed.nextTaskOnError, "on-error");
});

check("P-1.2: список RPC-методов совпадает со снимком (61 метод)", () => {
  assert.deepEqual(rpcMethods, EXPECTED_RPC_METHODS);
  assert.deepEqual([...EXPECTED_RPC_METHODS].sort(sortNames), EXPECTED_RPC_METHODS);
  assert.equal(new Set(rpcMethods).size, rpcMethods.length);
});
check("P-1.2: у каждого инструмента есть хотя бы один RPC-метод", () => {
  for (const name of EXPECTED_NAMES) {
    const mapped = TOOL_TO_RPC[name];
    assert.ok(Array.isArray(mapped) && mapped.length > 0, `${name}: нет соответствия RPC`);
    for (const method of mapped) {
      assert.ok(rpcMethods.includes(method), `${name} → ${method}: метод не найден в RPC`);
    }
  }
  assert.deepEqual(Object.keys(TOOL_TO_RPC).sort(sortNames), EXPECTED_NAMES);
});
check("P-1.2: RPC-only-методы не изменились", () => {
  const rpcCoveredByTools = new Set(Object.values(TOOL_TO_RPC).flat());
  const actualOnly = rpcMethods.filter((method) => !rpcCoveredByTools.has(method)).sort(sortNames);
  assert.deepEqual(actualOnly, [...RPC_ONLY].sort(sortNames));
  assert.equal(rpcCoveredByTools.size + actualOnly.length, rpcMethods.length);
  for (const method of RPC_ONLY) assert.ok(rpcMethods.includes(method), `${method}: нет в RPC`);
});

// QA-PORT-11: адаптеры (Code Mode/MCP/RPC) не всегда прогоняют input через
// Zod — обработчик и RPC обязаны отклонять лишние ключи сами.
const unknownExec = await historySpec.execute({ bogus: 1 });
const aliasExec = await historySpec.execute({ name: "__QA_PORT_11_MISSING__", limit: 3 });
check("QA-PORT-11: execute отклоняет неизвестный аргумент", () => {
  const payload = JSON.parse(unknownExec.content);
  assert.equal(payload.success, false);
  assert.match(payload.error ?? "", /неизвестные аргументы/);
});
check("QA-PORT-11: execute фильтрует по name (псевдоним taskName)", () => {
  assert.equal(JSON.parse(aliasExec.content).count, 0);
});

// QA-PORT-14: именованный dry_run раньше бросал исключение наружу, и адаптер
// MCP отвечал сырым "Tool result declared output without an output schema".
const dryRunSpec = specs.find((spec) => spec.name === "dry_run");
const dryRunMissingExec = await dryRunSpec.execute({ name: "__QA_PORT_14_MISSING__" });
check("QA-PORT-14: dry_run неизвестного имени возвращает структурированную ошибку", () => {
  const payload = JSON.parse(dryRunMissingExec.content);
  assert.equal(payload.success, false);
  assert.equal(payload.taskName, "__QA_PORT_14_MISSING__");
  assert.deepEqual(payload.tasks, []);
  assert.match(payload.error ?? "", /не найден|not found/i);
});
console.log(`\nTool specs: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exitCode = 1;
