// P-4.1/P-4.2/P-4.3: контракт dsh-адаптера и копии SKILL.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineDshTools, submitDshJob, DSH_ADAPTER_VERSION, readDshSkill } from "./dist/dsh.js";

const root = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (name, fn) => {
  try { fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const registered = new Map();
const submitted = [];
const ctx = {
  tools: { register: (name, spec) => registered.set(name, spec) },
  jobs: { submit: async (name, payload) => { submitted.push({ name, payload }); return { id: submitted.length }; } },
};
const names = defineDshTools(ctx);

check("P-4.1: через ctx.tools.register зарегистрировано 34 инструмента", () => {
  assert.equal(names.length, 34);
  assert.equal(registered.size, 34);
  for (const [name, spec] of registered) {
    assert.ok(spec.description, `нет description у ${name}`);
    assert.ok(spec.inputSchema && typeof spec.inputSchema === "object", `нет схемы у ${name}`);
    assert.equal(typeof spec.handler, "function");
  }
});

const { TOOL_NAMES } = await import("./dist/tool-specs.js");
check("P-4.1: множество имён совпадает с MCP/RPC-контрактом", () => {
  assert.deepEqual(names.slice().sort(), [...TOOL_NAMES].sort());
});

await submitDshJob(ctx, "nightly", "go");
check("P-4.1: фоновый запуск ушёл в dsh jobs", () => {
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].name, "nightly");
  assert.equal(submitted[0].payload.harness, "dsh-headless");
});

check("P-4.2: копия SKILL.md идентична исходнику", () => {
  const source = fs.readFileSync(path.join(root, "skills/scheduled-job-best-practices/SKILL.md"), "utf8");
  const copy = fs.readFileSync(path.join(root, ".agents/skills/agent-steward/SKILL.md"), "utf8");
  assert.equal(copy, source);
});

check("P-4.3: версия dsh зафиксирована и читается адаптером", () => {
  assert.match(DSH_ADAPTER_VERSION, /^dsh-developer-preview-\d{4}-\d{2}$/);
  assert.ok(fs.readFileSync(path.join(root, "docs/portability.md"), "utf8").includes(DSH_ADAPTER_VERSION));
});

const text = await readDshSkill();
check("P-4.2: readDshSkill не пустой", () => {
  assert.match(text, /Scheduled Job Best Practices/i);
});

console.log(`test-dsh-adapter: ${checks} checks passed`);
