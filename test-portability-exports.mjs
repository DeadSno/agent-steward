// P-5.3: subpath exports работают из одного пакета, без монорепо.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let checks = 0;
const check = (name, fn) => {
  try { fn(); checks++; }
  catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

check("P-5.3: package.json объявляет ./core ./mcp ./dsh", () => {
  for (const subpath of ["./core", "./mcp", "./dsh"]) {
    assert.ok(pkg.exports[subpath], `нет exports ${subpath}`);
    assert.ok(fs.existsSync(path.join(root, pkg.exports[subpath].default)), `нет файла ${pkg.exports[subpath].default}`);
  }
});

const core = await import("agent-steward/core");
const mcp = await import("agent-steward/mcp");
const dsh = await import("agent-steward/dsh");

check("P-5.3: ./core даёт createRuntime/createToolSpecs/TOOL_NAMES", () => {
  assert.equal(typeof core.createRuntime, "function");
  assert.equal(typeof core.createToolSpecs, "function");
  assert.equal(core.TOOL_NAMES.length, 34);
});
check("P-5.3: ./mcp даёт createMcpServer/startMcpServer", () => {
  assert.equal(typeof mcp.createMcpServer, "function");
  assert.equal(typeof mcp.startMcpServer, "function");
  assert.ok(mcp.MCP_SKILL_URI.startsWith("skill://"));
});
check("P-5.3: ./dsh даёт defineDshTools и зафиксированную версию", () => {
  assert.equal(typeof dsh.defineDshTools, "function");
  assert.match(dsh.DSH_ADAPTER_VERSION, /^dsh-developer-preview-/);
});

check("P-5.1: CLI объявляет команды mcp и serve", () => {
  const cli = fs.readFileSync(path.join(root, "dist/cli.js"), "utf8");
  assert.match(cli, /"mcp"/);
  assert.match(cli, /"serve"/);
  const serve = fs.readFileSync(path.join(root, "src/serve.ts"), "utf8");
  assert.match(serve, /startDashboardServer/);
});

console.log(`test-portability-exports: ${checks} checks passed`);
