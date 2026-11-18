// P1-13: каждый путь из package.json#exports должен попадать в npm-тарбол.
// Иначе публикация из чистого клона даёт пакет с битым exports
// (require(".../gui-experimental") -> ERR_MODULE_NOT_FOUND).
//
// Проверяются оба пакета: корневой agent-steward и legacy-шим.
// Для корневого GUI-бандла допускается SKIP, если он ещё не собран:
// его генерирует prepublishOnly -> build:gui.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

/** Рекурсивно собирает строковые цели exports (без условий/массивов-обёрток). */
function collectExportTargets(value, acc = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) acc.push(value.slice(2));
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, acc);
    return acc;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExportTargets(item, acc);
  }
  return acc;
}

/** Возвращает Set путей, которые npm положит в тарбол. */
function packedFiles(packageDir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    // На Windows npm — это npm.cmd; Node 24 не запускает .cmd без shell.
    shell: process.platform === "win32",
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error(`npm pack не вернул список files для ${packageDir}`);
  }
  return new Set(entry.files.map((file) => String(file.path).replace(/\\/g, "/")));
}

/** Проверяет один пакет: all exports targets присутствуют в тарболе. */
function checkPackage(label, packageDir, { allowUnbuiltGui = false } = {}) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  const targets = [...new Set(collectExportTargets(manifest.exports ?? {}))];
  check(`${label}: exports содержит пути`, targets.length > 0, targets.join(", "));

  const packed = packedFiles(packageDir);
  for (const target of targets) {
    if (
      allowUnbuiltGui &&
      target === "gui-experimental.cjs" &&
      !fs.existsSync(path.join(packageDir, target))
    ) {
      console.log(
        `SKIP ${label}: ${target} не собран локально (генерируется npm run build:gui при publish)`,
      );
      continue;
    }
    check(`${label}: exports "${target}" есть в тарболе`, packed.has(target));
  }
}

// 1. Legacy-шим: файл должен быть и в git, и в тарболе.
const legacyFile = path.join(root, "legacy", "gui-experimental.cjs");
check("legacy/gui-experimental.cjs существует", fs.existsSync(legacyFile));
const tracked = execFileSync(
  "git",
  ["ls-files", "--", "legacy/gui-experimental.cjs"],
  { cwd: root, encoding: "utf8" },
).trim();
check("legacy/gui-experimental.cjs отслеживается git", tracked.length > 0, tracked);
checkPackage("legacy", path.join(root, "legacy"));

// 2. Корневой пакет: dist и остальные exports должны быть в тарболе.
checkPackage("root", root, { allowUnbuiltGui: true });

process.exit(failed ? 1 : 0);
