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

import { coreScheduleTaskSchema, createToolSpecs } from "./dist/index.js";
import { SchedulerRpc } from "./dist/rpc.js";

const EXPECTED_NAMES = ["backup_db", "cleanup_history","delete_task","dry_run","emit_event","get_analytics","get_audit_log","get_dashboard_info","get_history","get_metrics","get_task_logs","list_tasks","manage_local_ai","manage_profiles","manage_secrets","manage_settings","manage_templates","manage_workspaces","matrix_control","pause_task","pipeline_apply","pipeline_export","pipeline_validate","report_bug","restore_db","resume_task","run_task_now","schedule_advanced","schedule_task","self_analysis","send_notification","transfer_tasks","update_advanced","update_task"];

const EXPECTED_HASHES = {
  "backup_db": "73be63e5b6f4cad3f0506862685fe11272d43e86cae164e1d5ad44959f253b8b",
  "cleanup_history": "e0d8444307eee168d08818ceb0e36ce87b76be33e9594a346720a1b11cf5fac9",
  "delete_task": "f96c50589c0b898f2f896f2287d90e602b897f61e89625d4441e019f21432d52",
  "dry_run": "67b796bae3827c90edd3876793fcc642c1e10aad8c12fed6e36dbc1e74888214",
  "emit_event": "b9abb6a5a0401639869af52e05eda62e08126fbe9b8034b493075ff188bc6e89",
  "get_analytics": "670d13b7fa742830125f7858cadd7b2b0c5b5c891d430bca5503104f7fabfeaa",
  "get_audit_log": "3810746a61da06c07a4ff741373a56cecd9660ef9d4f8681d2907798dde859f0",
  "get_dashboard_info": "35585e2d07b4e1a4be6e4363578356e8f4c9f122b9b932d109bc0551e0adfe0b",
  "get_history": "d493aca4a2d50598b1320c006bb74b01ab82ab9cb1cb31b364b9666b5d71c11d",
  "get_metrics": "6cc97118655743a29c01757ab200ed3dc1152eddf6e77c314c88034dff1fdd71",
  "get_task_logs": "e283a97a52a0ceb44dae5a604411787b53fc34e327656d89cb3da6902f1e207d",
  "list_tasks": "2165c5cde418227f0eb6eb6a6cf24f2bf8b19899c5f609cf1eaa30111e35424a",
  "manage_local_ai": "6b8c022c60d6537d603b7e8f8d95373bc2e5dfa57cb3b9ff5177aae35833e76f",
  "manage_profiles": "ffe6782eed04c22f44b4a023511b302326cb8d076915b4af0112ca22a52f039f",
  "manage_secrets": "6e2f507bcc3183532b5b8df28e3162a540dbd0b2e400f7afe5ff2deda3638673",
  "manage_settings": "eb9cd62e562ac48ced6c95cc95cd0a38f7db8602ecba018ae6d4ec12c05ca1a1",
  "manage_templates": "d5a9d3f9a28da70836e7b67da45bffa34714cb7110a2a11bef8824f8365716b6",
  "manage_workspaces": "2a926ad681c50d609d5c2aeb647c4fe5a0bc54849f9399de4951004046749d78",
  "matrix_control": "fd759c49ea39fd334fa036664e608a04469accae922dc2bf58c7f9463ccf074e",
  "pause_task": "922a6255827534146daa175289aeaa1e6ae2cc5db4b9517a2d5fc38de32ff107",
  "pipeline_apply": "359f6926d430cf5ec92231138fa219ee8a838eaacde999131903d404920c24dd",
  "pipeline_export": "7bd07dba920d68b05def4137fbd17974fa84fb66a30ab80d348169763830d0cc",
  "pipeline_validate": "1e5793f4446041b7403c5a89894f7f6a65e5dba685910b79f76e9cbe149e3568",
  "report_bug": "cbed52370760f1e9629b55d868b8dc7f746eb653e90f3e5d62c978797eda17ca",
  "resume_task": "37a8eb0da28e78a7c8bb58cc43b9c68a10a428cce0014fe94e13170fb1b17311",
  "restore_db": "831883a897c117984f283a976654f320a4a6724171fc2016b7077344351f058a",
  "run_task_now": "adcfc004fce2d39ca95953df502b8f9587c475af4a377e7d7213b7ff83347e8a",
  "schedule_advanced": "a3f0f250efdbd3a6390f318b19fa4b85fcc4286cb7c1bec293a239eefa25f04b",
  "schedule_task": "e054072d5661ae5900a1317ad334e4ac1f5bd8e35fd6f5962cb723c783309378",
  "self_analysis": "1455ca31e66913748fbf3803567919e1a0c0781b46ddaa25015d11e6d27973ab",
  "send_notification": "c212dcbf36e38363577dc1afc60a32a3b780e18bdc55c93aed609b9f38033b1d",
  "transfer_tasks": "5971ba4980ba58b6af7a519b629f9e6a5fd16ba0bbcbaeaee060d32ed0c9e2bd",
  "update_advanced": "844abfea03bdfa50cece13a2b8211ba3251a613c19f4b35d843511f6e933d374",
  "update_task": "92557e2d5bbc2c4fe2b98f6ad615bcbe441f08330af9485a79c07e07ea4c0e05",
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
console.log(`\nTool specs: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exitCode = 1;
