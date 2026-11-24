// P-5.3: subpath exports работают из одного пакета, без монорепо.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// QA-PORT-8: в свежем worktree `dist/` может быть junction на основной чек-аут.
// Без --preserve-symlinks Node резолвит bare-импорты по реальному пути и ищет
// @modelcontextprotocol/sdk в чужом node_modules. Перезапускаемся с флагом,
// чтобы и `node test-portability-exports.mjs`, и `npm test` работали одинаково.
if (!process.execArgv.includes("--preserve-symlinks")) {
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(
    process.execPath,
    ["--preserve-symlinks", ...process.execArgv, fileURLToPath(import.meta.url)],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

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

check("P-5.3/P-1.2: ./core даёт контекст-free ядро и реестр инструментов", () => {
  assert.equal(typeof core.createRuntimeCore, "function");
  assert.equal(typeof core.buildToolSpecs, "function");
  assert.equal(core.TOOL_NAMES.length, 34);
  // Адаптер OpenCode остаётся в корневом entrypoint'е, а не в фасаде ядра.
  assert.equal(core.createRuntime, undefined, "./core не должен экспортировать адаптер OpenCode");
  assert.equal(core.createToolSpecs, undefined, "./core не должен экспортировать адаптер OpenCode");
});

check("P-1.2: граф импортов ./core не содержит @opencode-*", () => {
  const seen = new Set();
  const stack = [path.join(root, "dist/core-entry.js")];
  let files = 0;
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8");
    files++;
    assert(
      !/\b(?:from|import)\s*\(?\s*["']@opencode[^"']*["']/.test(src),
      `${path.relative(root, file)} тянет OpenCode-контекст`
    );
    for (const match of src.matchAll(/["'](\.[^"']+\.js)["']/g)) {
      stack.push(path.resolve(path.dirname(file), match[1]));
    }
  }
  assert(files > 5, `обошли слишком мало модулей ядра: ${files}`);
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
