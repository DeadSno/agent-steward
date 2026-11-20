/**
 * TP-6.2 — генератор счётчиков TEST-PLAN.md по маркерам.
 *
 *   node scripts/gen-test-plan-counters.mjs              # JSON в stdout
 *   node scripts/gen-test-plan-counters.mjs --write      # обновить блок между маркерами
 *   node scripts/gen-test-plan-counters.mjs --out <file> # записать JSON в файл
 *
 * Маркеры в TEST-PLAN.md:
 *   <!-- counters:start -->
 *   <!-- counters:end -->
 *
 * Скрипт только считает фактические значения из кода/плана и не меняет остальной текст.
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const planPath = path.join(root, "TEST-PLAN.md");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const plan = fs.readFileSync(planPath, "utf8");

const section = (title, next) => {
  const from = plan.indexOf(title);
  if (from < 0) return "";
  const to = next ? plan.indexOf(next, from + title.length) : plan.length;
  return plan.slice(from, to < 0 ? plan.length : to);
};

const appendixA = section("## Приложение A.", "## Приложение B.");
const appendixB = section("## Приложение B.", "## Приложение C.");
const appendixC = section("## Приложение C.", "---");
const coverage = section("## 5. Матрица покрытия автотестами", "## 6.");

const backtickNames = (text) =>
  [...text.matchAll(/`([a-z][a-z0-9_-]+)`/g)].map((m) => m[1]);
const unique = (xs) => [...new Set(xs)];

const testFiles = fs
  .readdirSync(root)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();
const npmTestScripts = Object.keys(pkg.scripts ?? {}).filter((k) => k.startsWith("test"));
const rpcMethods = unique(backtickNames(appendixA)).filter((n) => /^[a-z][a-z0-9_]*$/.test(n));
const mcpTools = unique(backtickNames(appendixB)).filter((n) => /^[a-z][a-z0-9_]*$/.test(n));
const httpEndpoints = unique(
  [...appendixC.matchAll(/`\s*(?:GET|POST)\s+([^`]+)`/g)].map((m) => m[1].trim()),
);
const coverageEntries = unique(
  [...coverage.matchAll(/^\|\s*`([^`]+\.mjs)`/gm)].map((m) => m[1]),
);

const server = fs.readFileSync(path.join(root, "src", "server.ts"), "utf8");
const literalEndpoints = new Set(
  [...server.matchAll(/pathname\s*===\s*"([^"]+)"/g)].map((m) => m[1]),
);
const paramEndpoints = new Set(
  [...server.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => m[1]),
);
const codeEndpoints = unique([...literalEndpoints, ...paramEndpoints]);

const counters = {
  generatedAt: new Date().toISOString(),
  pluginVersion: pkg.version,
  schemaVersion:
    Number(
      /export const SCHEMA_VERSION = (\d+)/.exec(
        fs.readFileSync(path.join(root, "src", "db", "schema.ts"), "utf8"),
      )?.[1],
    ) ?? null,
  testFiles: testFiles.length,
  npmTestScripts: npmTestScripts.length,
  mcpToolsPlan: mcpTools.length,
  rpcMethodsPlan: rpcMethods.length,
  httpEndpointsAppendix: httpEndpoints.length,
  httpEndpointsCode: codeEndpoints.length,
  coverageEntries: coverageEntries.length,
};

const json = JSON.stringify(counters, null, 2);
const args = process.argv.slice(2);

if (args.includes("--write")) {
  const start = "<!-- counters:start -->";
  const end = "<!-- counters:end -->";
  if (!plan.includes(start) || !plan.includes(end)) {
    console.error("В TEST-PLAN.md нет маркеров counters:start / counters:end");
    process.exit(2);
  }
  const before = plan.slice(0, plan.indexOf(start) + start.length);
  const after = plan.slice(plan.indexOf(end));
  const table = [
    "",
    "| Счётчик | Значение | Источник |",
    "|---|---|---|",
    `| MCP-инструментов | ${counters.mcpToolsPlan} | Приложение B |`,
    `| RPC-методов | ${counters.rpcMethodsPlan} | Приложение A |`,
    `| HTTP-эндпоинтов | ${counters.httpEndpointsAppendix} | Приложение C |`,
    `| Файлов test-*.mjs | ${counters.testFiles} | корень репозитория |`,
    `| npm-скриптов test* | ${counters.npmTestScripts} | package.json |`,
    `| Покрытие в §5 | ${counters.coverageEntries} | TEST-PLAN §5 |`,
    `| SCHEMA_VERSION | ${counters.schemaVersion} | src/db/schema.ts |`,
    "",
  ].join("\n");
  fs.writeFileSync(planPath, before + table + after, "utf8");
  console.log(`Счётчики обновлены в TEST-PLAN.md:\n${table}`);
} else {
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    const out = path.resolve(root, args[outIdx + 1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json + "\n", "utf8");
    console.log(`Записано: ${out}`);
  } else {
    console.log(json);
  }
}
