// P-3: контракт AgentInvoker, UsageParser, ToolPolicy и поля harness.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HARNESS_VALUES, HARNESS_NAMES, resolveInvoker, OpencodeCliInvoker, DshHeadlessInvoker,
  AcpInvoker, CursorCliInvoker,
} from "./dist/invokers/agent-invoker.js";
import {
  HARNESS_VALUES as PUBLIC_HARNESS_VALUES,
  resolveInvoker as publicResolveInvoker,
} from "./dist/core-entry.js";
import { parseUsageFromText } from "./dist/invokers/usage-parser.js";
import { ToolPolicy } from "./dist/invokers/tool-policy.js";
import { scheduleTaskSchema, updateTaskSchema } from "./dist/index.js";
import { buildBashWrapperScript } from "./dist/core/wrappers/bash.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
let checks = 0;
const check = (name, fn) => {
  try { fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};
const checkAsync = async (name, fn) => {
  try { await fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

check("P-3.3: четыре инвокера доступны и переключаются", () => {
  assert.deepEqual(HARNESS_NAMES.sort(), ["acp", "cursor-cli", "dsh-headless", "opencode"]);
  assert.ok(resolveInvoker() instanceof OpencodeCliInvoker);
  assert.ok(resolveInvoker("dsh-headless") instanceof DshHeadlessInvoker);
  assert.ok(resolveInvoker("acp") instanceof AcpInvoker);
  assert.ok(resolveInvoker("cursor-cli") instanceof CursorCliInvoker);
  assert.ok(resolveInvoker("unknown") instanceof OpencodeCliInvoker);
});

check("P-3.1/P-3.2: buildCommand opencode совместим со старой командой", () => {
  const cmd = new OpencodeCliInvoker().buildCommand({ model: "opencode/hy4-flash-free", prompt: "hi" });
  assert.deepEqual(cmd.args, ["run", "--auto", "--model", "opencode/hy4-flash-free", "--", "hi"]);
  assert.equal(cmd.commandPath, "opencode");
});

check("P-3.2: env-переопределение AGENT_COMMAND_PATH/AGENT_ARGS", () => {
  const cmd = new OpencodeCliInvoker().buildCommand({
    prompt: "hi",
    env: { AGENT_COMMAND_PATH: "dsh", AGENT_ARGS: "--headless run" },
  });
  assert.equal(cmd.commandPath, "dsh");
  assert.deepEqual(cmd.args, ["--headless", "run", "--", "hi"]);
  assert.deepEqual(cmd.env, { AGENT_COMMAND_PATH: "dsh", AGENT_ARGS: "--headless run" });
});

check("P-3.2: оба wrapper'а параметризованы, дефолт сохранён", () => {
  const ps = read("src/core/ps-wrapper.ts");
  const bash = read("src/core/wrappers/bash.ts");
  assert.match(ps, /AGENT_COMMAND_PATH/);
  assert.match(ps, /@\("run", "--auto"\)/);
  assert.match(bash, /AGENT_COMMAND_PATH=/);
  assert.match(bash, /AGENT_ARGS=\$\{AGENT_ARGS-'run --auto'\}/);
  assert.ok(!bash.includes("exec opencode run --auto"));
});

check("P-3.3: не-opencode инвокеры собирают свои команды", () => {
  assert.deepEqual(new DshHeadlessInvoker().buildCommand().args, ["--headless", "run"]);
  assert.deepEqual(new AcpInvoker().buildCommand().args, ["run", "--stdio"]);
  assert.deepEqual(new CursorCliInvoker().buildCommand().args, ["agent", "--print"]);
});

check("P-3.1: единый источник правды HARNESS_VALUES и публичный контракт ./core", () => {
  assert.deepEqual([...HARNESS_VALUES].sort(), [...HARNESS_NAMES].sort());
  assert.deepEqual([...PUBLIC_HARNESS_VALUES], [...HARNESS_VALUES]);
  assert.ok(publicResolveInvoker("acp") instanceof AcpInvoker);
  // Схемы задач принимают ровно те значения, что объявляет контракт.
  const base = { name: "P3", schedule: "0 9 * * *", prompt: "test", triggerType: "cron" };
  for (const harness of HARNESS_VALUES) {
    assert.equal(scheduleTaskSchema.parse({ ...base, harness }).harness, harness);
    assert.equal(updateTaskSchema.parse({ name: "P3", harness }).harness, harness);
  }
});

check("P-3.1: UsageParser разбирает токены и стоимость", () => {
  const usage = parseUsageFromText("input tokens: 1,200\noutput tokens: 300\ncost $0.0042");
  assert.deepEqual(usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costUsd: 0.0042 });
  assert.equal(parseUsageFromText(""), null);
});

check("P-3.1: ToolPolicy.toHarnessConfig() сериализуем и полон", () => {
  const policy = ToolPolicy.forHarness("opencode");
  const config = policy.toHarnessConfig();
  assert.equal(config.allowedTools.length, 34);
  assert.equal(config.deniedTools.length, 0);
  assert.equal(JSON.parse(JSON.stringify(config)).harness, "opencode");
  const cursor = ToolPolicy.forHarness("cursor-cli").toHarnessConfig();
  assert.ok(cursor.allowedTools.includes("list_tasks"));
  assert.ok(cursor.deniedTools.includes("delete_task"));
  assert.equal(cursor.allowedTools.length + cursor.deniedTools.length, 34);
});

check("P-3.4: поле harness принимается схемами и обратно совместимо", () => {
  const base = { name: "P3", schedule: "0 9 * * *", prompt: "test", triggerType: "cron" };
  assert.equal(scheduleTaskSchema.parse({ ...base, harness: "acp" }).harness, "acp");
  assert.equal(scheduleTaskSchema.parse(base).harness, undefined);
  assert.equal(updateTaskSchema.parse({ name: "P3", harness: "dsh-headless" }).harness, "dsh-headless");
  assert.throws(() => scheduleTaskSchema.parse({ ...base, harness: "bogus" }));
});

check("P-3.4: harness сохраняется в definition и импорте", () => {
  const tt = read("src/task-transfer.ts");
  assert.match(tt, /harness\?: HarnessName/);
  assert.match(tt, /HARNESS_VALUES/);
});

check("P-3.2: harness доходит до definition и обёрток", () => {
  const idx = read("src/index.ts");
  assert.match(idx, /\.\.\.\(harness \? \{ harness \} : \{\}\)/);
  assert.match(idx, /input\.harness \?\? previous\.harness/);
  assert.match(idx, /harnessDefaults/);
  const ps = read("src/core/ps-wrapper.ts");
  assert.match(ps, /HarnessCommandB64/);
  assert.match(ps, /HarnessArgsBaked/);
  const bash = read("src/core/wrappers/bash.ts");
  assert.match(bash, /HARNESS_COMMAND_PATH/);
  assert.match(bash, /HARNESS_ARGS/);
});

check("P-3.2: не-opencode харнесс запекает только префикс команды", () => {
  const cmd = resolveInvoker("dsh-headless").buildCommand({ env: {} });
  assert.equal(cmd.commandPath, "dsh");
  assert.deepEqual(cmd.args, ["--headless", "run"]);
  assert.ok(!cmd.args.some((arg) => arg === "--model" || arg === "--"));
});

check("P-3.2: runner.ts подключён к AgentInvoker.invoke", () => {
  const src = read("src/invokers/agent-invoker.ts");
  assert.match(src, /resolveRunner\(options\.runner\)/);
  assert.match(src, /\.runner\.execute\(/);
});

check("P-3.3: смена харнесса меняет обёртку без правки ядра", () => {
  const base = {
    sanitizedName: "p33-contract",
    taskName: "P3.3 contract",
    promptFile: "/tmp/p33-contract.prompt",
    timeoutSeconds: 60,
    lockFile: "/tmp/p33-contract.lock",
  };
  const scriptFor = (harness) => {
    const built = resolveInvoker(harness).buildCommand({ env: {} });
    return buildBashWrapperScript({
      ...base,
      ...(harness === "opencode"
        ? {}
        : { harnessDefaults: { commandPath: built.commandPath, args: built.args } }),
    });
  };
  const opencode = scriptFor("opencode");
  const dsh = scriptFor("dsh-headless");
  const cursor = scriptFor("cursor-cli");
  // Исходный харнесс остаётся буквально прежним.
  assert.match(opencode, /HARNESS_COMMAND_PATH=''/);
  assert.match(opencode, /HARNESS_ARGS=''/);
  assert.match(opencode, /AGENT_COMMAND_PATH="\$\{AGENT_COMMAND_PATH:-opencode\}"/);
  assert.match(opencode, /AGENT_ARGS=\$\{AGENT_ARGS-'run --auto'\}/);
  // Другой харнесс подставляется только через публичный контракт инвокера.
  assert.match(dsh, /HARNESS_COMMAND_PATH='dsh'/);
  assert.match(dsh, /HARNESS_ARGS='--headless run'/);
  assert.match(cursor, /HARNESS_COMMAND_PATH='cursor'/);
  assert.match(cursor, /HARNESS_ARGS='agent --print'/);
  assert.ok(!dsh.includes("HARNESS_COMMAND_PATH='opencode'"));
  assert.ok(!dsh.includes("--model") || !dsh.includes("HARNESS_ARGS='--model"));
});

await checkAsync("P-3.2: invoke_execution через local runner", async () => {
  const result = await new OpencodeCliInvoker().invoke({
    env: { AGENT_COMMAND_PATH: process.execPath, AGENT_ARGS: "--version" },
    runner: { kind: "local" },
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
});

console.log(`test-invokers: ${checks} checks passed`);
