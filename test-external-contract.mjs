/**
 * AD-1.2: golden-контракт Этапа 3 (pipeline YAML + SQLite ledger + MCP/API).
 * Запуск: node test-external-contract.mjs (после npm run build).
 *
 * Проверяем, что описание контракта детерминировано, что все официальные входы
 * отображаются в существующий execution loop и что план внешнего запроса
 * совпадает с планом обычного ad-hoc запуска — второго движка нет.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Изолируем каталог плагина ДО динамических импортов dist (PLUGIN_DIR на импорте).
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ad12-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const contract = await import("./dist/core/external-contract.js");
const execution = await import("./dist/core/execution.js");
const facade = await import("./dist/core-entry.js");

const root = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(fs.readFileSync(path.join(root, "test-external-contract-golden.json"), "utf8"));

let checks = 0;
const check = (name, fn) => {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    checks++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

check("AD-1.2: дескриптор совпадает с golden-фикстурой", () => {
  assert.deepEqual(contract.externalContractDescriptor(), golden.descriptor);
});

check("AD-1.2: канонический JSON и хэш стабильны", () => {
  assert.equal(contract.externalContractCanonical(), golden.canonical);
  assert.equal(contract.externalContractHash(), golden.hash);
  assert.equal(contract.externalContractHash(contract.externalContractDescriptor()), golden.hash);
});

check("AD-1.2: идентификатор контракта версионирован", () => {
  assert.equal(contract.externalContractId(), golden.id);
  assert.equal(contract.externalContractId(), "agent-steward.external-contract@1.0");
});

check("AD-1.2: pipeline и SQLite-ledger фиксируют реальные версии", () => {
  const descriptor = contract.externalContractDescriptor();
  assert.equal(descriptor.pipeline.format, "opencode.pipeline.yaml");
  assert.equal(descriptor.pipeline.version, 1);
  assert.equal(descriptor.ledger.database, "scheduler.db");
  assert.equal(descriptor.ledger.schemaVersion, 14);
  assert.deepEqual([...descriptor.ledger.tables], [...golden.descriptor.ledger.tables]);
});

check("AD-1.2: все входы идут через один execution loop", () => {
  const entries = contract.externalContractDescriptor().entries;
  assert.equal(entries.length, 7);
  for (const entry of entries) {
    assert.equal(entry.loop, "RunContext -> buildExecutionPlan -> executeExecutionPlan");
  }
  assert.deepEqual(
    entries.map((entry) => `${entry.channel}/${entry.name}`),
    golden.descriptor.entries.map((entry) => `${entry.channel}/${entry.name}`),
  );
});

check("AD-1.2: инварианты и гейты перечислены явно", () => {
  const descriptor = contract.externalContractDescriptor();
  assert.deepEqual([...descriptor.preserved], [
    "ledger", "dlq", "budgets", "approval", "quality-gate", "local-first",
  ]);
  assert.deepEqual([...descriptor.executionLoop.gates], [
    "risk-class", "compiled-policy", "quality-gate", "commit-attribution", "budget", "approval",
  ]);
  assert.equal(descriptor.executionLoop.context, "RunContext");
  assert.equal(descriptor.executionLoop.plan, "buildExecutionPlan");
  assert.equal(descriptor.executionLoop.execute, "executeExecutionPlan");
});

check("AD-1.2: неизвестный вход отклоняется", () => {
  assert.throws(() => contract.resolveExternalEntry("mcp", "no-such-tool"), /неизвестный вход/);
  assert.throws(() => contract.resolveExternalEntry("api", "run_task_now"), /неизвестный вход/);
});

check("AD-1.2: дрейф контракта меняет хэш (golden ловит правку)", () => {
  const mutated = contract.externalContractDescriptor();
  mutated.version = "1.1";
  assert.notEqual(contract.externalContractHash(mutated), golden.hash);
  const mutatedTables = contract.externalContractDescriptor();
  mutatedTables.ledger.tables = [...mutatedTables.ledger.tables, "extra_table"];
  assert.notEqual(contract.externalContractHash(mutatedTables), golden.hash);
});

check("AD-1.2: трассировка контракта перечисляет версию и входы", () => {
  const trace = contract.describeExternalContract();
  assert.match(trace, /agent-steward\.external-contract@1\.0 hash=1e05a35afdc1feff/);
  assert.match(trace, /pipeline: opencode\.pipeline\.yaml v1/);
  assert.match(trace, /ledger: scheduler\.db schema=14 tables=8/);
  assert.match(trace, /entry: scheduler\/nativeScheduler -> mcp-event/);
});

await checkAsync("AD-1.2: публичный core-фасад экспортирует контракт", async () => {
  assert.equal(facade.EXTERNAL_CONTRACT_FORMAT, "agent-steward.external-contract");
  assert.equal(facade.EXTERNAL_CONTRACT_VERSION, "1.0");
  assert.equal(typeof facade.externalContractDescriptor, "function");
  assert.equal(typeof facade.buildExternalContractPlan, "function");
});

for (const entry of golden.descriptor.entries) {
  await checkAsync(`AD-1.2: план ${entry.channel}/${entry.name} = план ad-hoc запуска`, async () => {
    const request = {
      channel: entry.channel,
      entry: entry.name,
      mission: "Проверить контракт Этапа 3",
      cwd: root,
      taskType: "review",
    };
    const external = await contract.buildExternalContractPlan(request, { exploreBudget: { enabled: false } });
    const directContext = execution.createAdHocRunContext(request.mission, {
      cwd: root,
      taskName: `external-${entry.name}`,
      taskType: "review",
      trigger: entry.trigger,
    });
    const direct = await execution.buildExecutionPlan(directContext, { exploreBudget: { enabled: false } });

    assert.equal(external.contractId, golden.id);
    assert.equal(external.contractHash, golden.hash);
    assert.equal(external.entry.trigger, entry.trigger);
    assert.deepEqual(external.plan.steps, direct.steps);
    assert.equal(external.plan.source, direct.source);
    assert.deepEqual(external.plan.warnings, direct.warnings);
    assert.deepEqual(external.plan.ambiguousTaskTypes, direct.ambiguousTaskTypes);
    assert.equal(external.context.origin, "ad-hoc");
    assert.equal(external.context.trigger, entry.trigger);
    assert.equal(external.context.metadata.externalContract, "1.0");
    assert.equal(external.context.metadata.externalChannel, entry.channel);
    assert.equal(external.context.metadata.externalEntry, entry.name);
    assert.match(external.trace, new RegExp(`источник ${external.plan.source}`));
  });
}

console.log(`AD-1.2 checks: ${checks}`);
if (process.exitCode) console.error("FAIL: внешний контракт изменился или план разошёлся с ad-hoc");
