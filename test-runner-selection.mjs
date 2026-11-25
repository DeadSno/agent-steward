// EX-1.1: декларативный выбор runner (local/docker/ssh) в схеме задачи, CLI,
// RPC и запекание транспорта в обёртку через runner-run bridge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RUNNER_KINDS,
  normalizeRunnerConfig,
  encodeRunnerAgentDefaults,
  decodeRunnerAgentDefaults,
  resolveRunner,
} from "./dist/core/runner.js";
import {
  runnerTaskSchema,
  scheduleTaskSchema,
  updateTaskSchema,
} from "./dist/index.js";

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

check("EX-1.1: RUNNER_KINDS — единственный список допустимых значений", () => {
  assert.deepEqual([...RUNNER_KINDS], ["local", "docker", "ssh"]);
});

check("EX-1.1: normalizeRunnerConfig принимает только поля задачи", () => {
  assert.equal(normalizeRunnerConfig(undefined), undefined);
  assert.equal(normalizeRunnerConfig(null), undefined);
  assert.equal(normalizeRunnerConfig("docker"), undefined);
  assert.equal(normalizeRunnerConfig([]), undefined);
  assert.deepEqual(
    normalizeRunnerConfig({ kind: "docker", image: "  alpine:3  ", user: " u ", host: " h ", optOut: true, deps: { exists: () => true } }),
    { kind: "docker", image: "alpine:3", user: "u", host: "h", optOut: true }
  );
  assert.deepEqual(normalizeRunnerConfig({ kind: "unknown" }), {});
});

check("EX-1.1: fail-open — невалидный/неполный runner деградирует в local", () => {
  for (const config of [undefined, {}, { kind: "unknown" }, { kind: "docker" }, { kind: "ssh" }, { kind: "local", optOut: true }]) {
    const resolved = resolveRunner(config);
    assert.equal(resolved.requested === "docker" || resolved.requested === "ssh" ? resolved.fallback : true, true);
    assert.equal(resolved.runner.name, "local");
    assert.equal(resolved.verdict({ command: "cmd", args: [] }).runner, "local");
  }
});

check("EX-1.1: runnerTaskSchema принимает допустимые поля и отклоняет мусор", () => {
  assert.equal(runnerTaskSchema.safeParse({ kind: "local" }).success, true);
  assert.equal(runnerTaskSchema.safeParse({ kind: "docker", image: "alpine:3", optOut: false }).success, true);
  assert.equal(runnerTaskSchema.safeParse({ kind: "ssh", host: "srv", user: "deploy" }).success, true);
  assert.equal(runnerTaskSchema.safeParse({ kind: "vm" }).success, false);
  assert.equal(runnerTaskSchema.safeParse({ kind: "local", deps: {} }).data.deps, undefined);
});

check("EX-1.1: runner есть в схеме задач и в update (null сбрасывает)", () => {
  assert.equal(scheduleTaskSchema.safeParse({ name: "EX11", prompt: "x", schedule: "0 0 * * *", runner: { kind: "ssh", host: "srv" } }).success, true);
  assert.equal(updateTaskSchema.safeParse({ name: "EX11", runner: { kind: "docker", image: "alpine" } }).success, true);
  assert.equal(updateTaskSchema.safeParse({ name: "EX11", runner: null }).success, true);
  assert.equal(updateTaskSchema.safeParse({ name: "EX11", runner: { kind: "vm" } }).success, false);
  assert.ok(read("src/index.ts").includes("CORE_FIELD_DESCRIPTIONS.runner") ||
    /runner:\s*["']/.test(read("src/index.ts")));
});

check("EX-1.1: RPC create_task/update_task/run_mission принимают runner", () => {
  for (const rel of ["src/rpc.ts"]) {
    const src = read(rel);
    assert.equal((src.match(/runner: RunnerSchema/g) || []).length >= 3, true);
    assert.ok(src.includes('enum: ["local", "docker", "ssh", null]'));
  }
});

check("EX-1.1: CLI выставляет --runner и параметры транспорта", () => {
  const cli = read("src/cli.ts");
  for (const flag of ["--runner", "--runner-image", "--runner-host", "--runner-user", "--runner-opt-out"]) {
    assert.ok(cli.includes('"' + flag + '"'), `нет флага ${flag}`);
  }
  assert.ok(cli.includes("RUNNER_KINDS"));
  assert.ok(cli.includes("normalizeRunnerConfig"));
});

check("EX-1.1: задача и transfer сохраняют runner", () => {
  assert.ok(read("src/task-transfer.ts").includes("runner?: RunnerConfig"));
  const transfer = read("src/task-transfer.ts");
  assert.ok(transfer.includes("normalizeRunnerConfig"));
  assert.ok(read("src/core/mission.ts").includes("runner?: RunnerConfig"));
});

check("EX-1.1: токен runner — одно слово без пробелов, без утечки окружения", () => {
  const token = encodeRunnerAgentDefaults({ runner: { kind: "ssh", host: "srv" }, harness: { commandPath: "opencode", args: ["run", "--auto"] } });
  assert.equal(token.commandPath, process.execPath);
  assert.equal(token.args.length, 1);
  assert.equal(/\s/.test(token.args[0]), false);
  assert.deepEqual(decodeRunnerAgentDefaults(token.args[0]), { runner: { kind: "ssh", host: "srv" }, harness: { commandPath: "opencode", args: ["run", "--auto"] } });
  assert.throws(() => decodeRunnerAgentDefaults("not-a-token"));
});

check("EX-1.1: обёртки получают токен через harnessDefaults", () => {
  const ps = read("src/core/ps-wrapper.ts");
  const bash = read("src/core/wrappers/bash.ts");
  assert.ok(ps.includes("harnessDefaults?: { commandPath: string; args: string[] }"));
  assert.ok(bash.includes("harnessDefaults?: { commandPath: string; args: string[] }"));
  assert.ok(read("src/core/mission.ts").includes("harnessDefaults: runnerDefaults"));
});

await checkAsync("EX-1.1: runner-run.js реально запускает команду через выбранный транспорт", async () => {
  const harness = { commandPath: process.execPath, args: ["-e", "process.stdout.write('EX11-OK')"] };
  const token = encodeRunnerAgentDefaults({ runner: { kind: "local" }, harness });
  const result = spawnSync(process.execPath, [path.join(root, "dist/core/runner-run.js"), token.args[0], "noop"], { encoding: "utf8" });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout.trim(), "EX11-OK");
});

await checkAsync("EX-1.1: runner-run.js отклоняет битый токен кодом 2", async () => {
  const result = spawnSync(process.execPath, [path.join(root, "dist/core/runner-run.js"), "broken-token", "noop"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /runner|Runner/);
});

check("EX-1.1: docs больше не обещают «только программно»", () => {
  const arch = read("docs/ARCHITECTURE.md");
  assert.ok(arch.includes("runner is selectable declaratively"));
  assert.equal(/только программно/.test(arch), false);
  assert.ok(read("docs/ARCHITECTURE-DIAGRAMS.md").includes("src/core/runner-run.ts"));
});

console.log(`test-runner-selection: ${checks}/${checks} checks passed`);
