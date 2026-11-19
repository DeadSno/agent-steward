// Регрессия упаковки: точка входа V2 не должна требовать devDependency
// @opencode-ai/plugin. Воспроизводим установку пакета как у пользователя
// OpenCode 2 — только production-зависимости, без devDependencies репозитория.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

const npm = (args, cwd) =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-prod-"));
try {
  // Собираем реальный тарбол (без скриптов — dist уже собран npm run build).
  npm(["pack", "--ignore-scripts", "--pack-destination", tmp], root);
  const tarball = fs
    .readdirSync(tmp)
    .find((name) => name.startsWith("agent-steward-") && name.endsWith(".tgz"));
  check("тарбол agent-steward создан", Boolean(tarball), tarball || "");
  if (!tarball) throw new Error("npm pack не создал тарбол");

  // Чистая установка: только prod-зависимости, как у конечного пользователя.
  npm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      path.join(tmp, tarball),
    ],
    tmp,
  );

  const installed = path.join(tmp, "node_modules", "agent-steward");
  const entry = path.join(installed, "dist", "index.js");
  check("установленный dist/index.js существует", fs.existsSync(entry));

  const source = fs.readFileSync(entry, "utf8");
  check(
    "точка входа не импортирует @opencode-ai/plugin",
    !source.includes('from "@opencode-ai/plugin"'),
  );
  check(
    "v1-пакет отсутствует в prod-дереве",
    !fs.existsSync(path.join(tmp, "node_modules", "@opencode-ai", "plugin")),
  );

  // Импорт точки входа — именно тут раньше падал ERR_MODULE_NOT_FOUND.
  let module = null;
  let importError = null;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    importError = error;
  }
  check(
    "импорт agent-steward без devDependencies",
    !importError,
    importError ? String(importError && importError.message) : "",
  );
  if (module) {
    const plugin = module.default ?? {};
    check("dual-export: V2 setup на месте", typeof plugin.setup === "function");
    check("dual-export: V1 server на месте", typeof plugin.server === "function");
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`Production install: ${failed ? `${failed} FAIL` : "все проверки пройдены"}`);
process.exit(failed ? 1 : 0);
