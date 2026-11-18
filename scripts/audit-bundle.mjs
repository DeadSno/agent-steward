#!/usr/bin/env node
// Сбор фактов для внешнего аудита. ПО УМОЛЧАНИЮ READ-ONLY.
// Мутирующее/сетевое — только по флагам: --build --tests --audit
// Выход: audit-bundle.md (для вставки), audit-bundle.json (для агента), audit-raw/*.log (полные логи)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const a = argv.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

const O = {
  build: flag("build"), tests: flag("tests"), audit: flag("audit"),
  since: opt("since", null),
  cap: Number(opt("cap", 6000)),
  maxBytes: Number(opt("max-bytes", 60000)),
  budgetMs: Number(opt("budget", 180)) * 1000,
  cmdMs: Number(opt("cmd-timeout", 60)) * 1000,
};

const T0 = Date.now();
const left = () => O.budgetMs - (Date.now() - T0);
const RAW = "audit-raw";
fs.mkdirSync(RAW, { recursive: true });
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(cmd, args, { label, cwd, shell = false, timeout = O.cmdMs } = {}) {
  if (left() <= 0) return { ok: false, out: "", note: "SKIP: бюджет времени исчерпан" };
  const r = spawnSync(cmd, args, {
    encoding: "utf8", cwd, shell, windowsHide: true,
    timeout: Math.max(1000, Math.min(timeout, left())),
    killSignal: "SIGKILL", maxBuffer: 64e6,
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (label) fs.writeFileSync(path.join(RAW, `${label}.log`), out);
  return { ok: r.status === 0, status: r.status, out, err: r.error ? String(r.error.message) : null };
}
const git = (...a) => run("git", a);
const npm = (a, o = {}) => run(NPM, a, { shell: true, ...o }); // .cmd требует shell

if (!fs.existsSync("package.json")) { console.error("Запусти из корня репозитория"); process.exit(1); }
const inGit = git("rev-parse", "--git-dir").ok;
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

// ---------- инвентарь с blob-sha ----------
let tracked = [];
if (inGit) {
  tracked = git("ls-files", "-s").out.split("\n").filter(Boolean).map(l => {
    const m = /^\d+ ([0-9a-f]+) \d+\t(.*)$/.exec(l);
    return m ? { path: m[2], sha: m[1] } : null;
  }).filter(Boolean);
} else {
  const walk = (d, acc = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", "coverage", RAW].includes(e.name)) continue;
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p, acc) : acc.push({ path: p.replace(/\\/g, "/"), sha: "" });
    }
    return acc;
  };
  tracked = walk(".");
}
const trackedSet = new Set(tracked.map(t => t.path));
for (const t of tracked) { try { t.size = fs.statSync(t.path).size; } catch { t.size = -1; } }
const bySize = [...tracked].sort((a, b) => b.size - a.size);

// игнорируемые исходники (ловит legacy/gui-experimental.cjs-класс багов)
const ignoredSrc = inGit
  ? git("ls-files", "--others", "--ignored", "--exclude-standard").out
      .split("\n").filter(p => /^(src|legacy|scripts)\//.test(p) || /\.(ts|tsx|js|cjs|mjs)$/.test(p))
  : [];

// ---------- exports → диск / git / тарбол ----------
const targets = (e) => { const o = []; const w = v => { if (typeof v === "string") o.push(v); else if (v && typeof v === "object") Object.values(v).forEach(w); }; w(e); return [...new Set(o)]; };
function packList(cwd, label) {
  const r = npm(["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd, label });
  try { const j = JSON.parse(r.out.slice(r.out.indexOf("["))); return new Set((j[0]?.files || []).map(f => f.path)); }
  catch { return null; }
}
const packMain = packList(undefined, "pack-main");
const hasLegacy = fs.existsSync("legacy/package.json");
const packLegacy = hasLegacy ? packList("legacy", "pack-legacy") : null;

function expReport(p, base, pack) {
  const rows = [];
  for (const [k, v] of Object.entries(p.exports || {})) {
    for (const t of targets(v)) {
      const rel = path.posix.normalize(path.posix.join(base, t));
      const disk = fs.existsSync(rel);
      const inGitRepo = trackedSet.has(rel);
      const inPack = pack ? pack.has(path.posix.relative(base, rel)) : null;
      const bad = !disk || (inGit && !inGitRepo) || inPack === false;
      rows.push(`${bad ? "❌" : "✅"} ${k} → ${t} | disk:${disk ? "ok" : "MISSING"} git:${inGitRepo ? "ok" : "UNTRACKED"} pack:${inPack === null ? "n/a" : inPack ? "ok" : "MISSING"}`);
    }
  }
  return rows.join("\n") || "нет exports";
}

// ---------- тесты: обе стороны ----------
const chain = (pkg.scripts?.test || "").split("&&").map(s => s.trim().replace(/^node\s+/, "")).filter(Boolean);
const onDisk = tracked.filter(t => /^test-.*\.mjs$/.test(t.path)).map(t => t.path);
const notWired = onDisk.filter(f => !chain.includes(f));
const brokenChain = chain.filter(f => f.endsWith(".mjs") && !fs.existsSync(f));

// ---------- локали ----------
let localeReport = "нет locales/";
if (fs.existsSync("locales")) {
  const cats = {};
  for (const f of fs.readdirSync("locales").filter(f => f.endsWith(".json")))
    cats[f.replace(".json", "")] = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join("locales", f), "utf8"))));
  const names = Object.keys(cats);
  const all = new Set(names.flatMap(n => [...cats[n]]));
  localeReport = names.map(n => {
    const miss = [...all].filter(k => !cats[n].has(k));
    return `${n}: ${cats[n].size} ключей, отсутствует ${miss.length}${miss.length ? " → " + miss.slice(0, 15).join(", ") : ""}`;
  }).join("\n") + `\nвсего уникальных ключей: ${all.size}`;
}

// ---------- схема ----------
const schemaFile = ["src/db/schema.ts"].find(f => fs.existsSync(f));
const schemaSrc = schemaFile ? fs.readFileSync(schemaFile, "utf8") : "";
const schemaVer = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(schemaSrc)?.[1] ?? "?";
const tables = [...schemaSrc.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?[`"]?(\w+)/g)].map(m => m[1]);

// ---------- grep (POSIX ERE, без shell) ----------
const gg = (pattern, ...paths) => {
  if (!inGit) return "не git-репозиторий";
  const r = run("git", ["grep", "-nE", pattern, "--", ...paths]);
  return r.out.trim() || "(нет совпадений)";
};
const wiring = gg("routeStep|recordCapabilityOutcome|escalateAfterGate|planMission|createRun",
  "src/index.ts", "src/core/record-history.ts", "src/core/wrappers", "src/core/ps-wrapper.ts");
const risky = gg("execSync|spawnSync|shell:[[:space:]]*true|JSON\\.parse|catch[[:space:]]*\\{[[:space:]]*\\}", "src");
const todos = gg("TODO|FIXME|HACK|XXX", "src");

// ---------- CI и конфиги ----------
const wfDir = ".github/workflows";
const workflows = fs.existsSync(wfDir)
  ? fs.readdirSync(wfDir).map(f => {
      const s = fs.readFileSync(path.join(wfDir, f), "utf8");
      const keys = s.split("\n").filter(l => /runs-on|node-version|npm (run|ci|test)|matrix|cron/.test(l));
      return `### ${f}\n${keys.join("\n")}`;
    }).join("\n\n")
  : "нет workflows";
const configs = ["tsconfig.json", "eslint.config.mjs", "vite.config.ts", ".gitignore"]
  .filter(fs.existsSync).map(f => `### ${f}\n${fs.readFileSync(f, "utf8")}`).join("\n\n");

// ---------- опциональное ----------
const opt_ = {};
if (O.build) opt_.build = npm(["run", "build"], { label: "build", timeout: 240000 });
if (fs.existsSync("eslint.config.mjs") || pkg.scripts?.lint) opt_.lint = npm(["run", "lint", "--if-present"], { label: "lint", timeout: 180000 });
if (O.tests) {
  const r = npm(["test"], { label: "tests", timeout: 1500000 });
  const fails = r.out.split("\n").filter(l => /FAIL|✖|not ok|Error:|failed/i.test(l)).slice(0, 80);
  opt_.tests = { ok: r.ok, out: `exit=${r.status}\n--- FAIL-строки ---\n${fails.join("\n")}\n--- хвост ---\n${r.out.split("\n").slice(-80).join("\n")}` };
}
if (O.audit) opt_.audit = npm(["audit", "--omit=dev"], { label: "audit", timeout: 90000 });

// ---------- сборка ----------
const sections = [];
const S = (t, b) => sections.push({ title: t, body: String(b ?? "").slice(0, O.cap) + (String(b ?? "").length > O.cap ? "\n…[обрезано, полный лог в audit-raw/]" : "") });

S("Окружение", [
  `node ${process.version}`, `npm ${npm(["-v"]).out.trim()}`, `git ${git("--version").out.trim()}`,
  `os ${process.platform} ${process.arch}`, `cwd ${process.cwd()}`,
  `HEAD ${inGit ? git("rev-parse", "HEAD").out.trim() : "не git"}`,
  `branch ${inGit ? git("rev-parse", "--abbrev-ref", "HEAD").out.trim() : "-"}`,
  `dirty:\n${inGit ? git("status", "--porcelain").out.trim() || "(чисто)" : "-"}`,
  `режим: read-only${O.build ? " +build" : ""}${O.tests ? " +tests" : ""}${O.audit ? " +audit" : ""}`,
].join("\n"));
S("Последние 25 коммитов", inGit ? git("log", "-25", "--oneline").out : "-");
if (O.since) S(`Изменено с ${O.since}`, git("diff", "--name-only", `${O.since}..HEAD`).out);
S("Инвентарь: топ-60 по размеру", bySize.slice(0, 60).map(t => `${String(t.size).padStart(8)}  ${t.sha.slice(0, 8)}  ${t.path}`).join("\n"));
S("Итого", `${tracked.length} отслеживаемых файлов, ${tracked.reduce((a, t) => a + Math.max(0, t.size), 0)} байт`);
S("Игнорируемые исходники (риск невоспроизводимой публикации)", ignoredSrc.join("\n") || "(нет)");
S("package.json (срез)", JSON.stringify({ name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, exports: pkg.exports, files: pkg.files, engines: pkg.engines }, null, 2));
S("EXPORTS main: диск / git / тарбол", expReport(pkg, ".", packMain));
if (hasLegacy) S("EXPORTS legacy: диск / git / тарбол", expReport(JSON.parse(fs.readFileSync("legacy/package.json", "utf8")), "legacy", packLegacy));
S("Сюиты на диске, но НЕ в npm test", notWired.join("\n") || "(все подключены)");
S("Сюиты в npm test, но файла НЕТ (битый chain)", brokenChain.join("\n") || "(нет)");
S("Локали: parity ключей", localeReport);
S("Схема", `SCHEMA_VERSION=${schemaVer}\nтаблицы: ${tables.join(", ") || "?"}`);
S("Wiring горячего пути", wiring);
S("Рискованные паттерны", risky);
S("TODO/FIXME", todos);
S("CI workflows (ключевые строки)", workflows);
S("Конфиги", configs);
S("npm ls --depth=0", npm(["ls", "--depth=0"], { label: "ls" }).out);
for (const [k, v] of Object.entries(opt_)) S(`Опционально: ${k}`, typeof v === "string" ? v : (v.out ?? JSON.stringify(v)));

let md = `# audit-bundle\n\nСобрано ${new Date().toISOString()} · бюджет ${O.budgetMs / 1000}s, потрачено ${((Date.now() - T0) / 1000).toFixed(1)}s\n\n`;
for (const s of sections) {
  const chunk = `## ${s.title}\n\n\`\`\`\n${s.body}\n\`\`\`\n\n`;
  if (md.length + chunk.length > O.maxBytes) { md += `## …усечено по --max-bytes\n\nПолные данные: audit-bundle.json и audit-raw/\n`; break; }
  md += chunk;
}
fs.writeFileSync("audit-bundle.md", md);
fs.writeFileSync("audit-bundle.json", JSON.stringify({ head: inGit ? git("rev-parse", "HEAD").out.trim() : null, opts: O, tracked, ignoredSrc, notWired, brokenChain, schemaVer, tables, sections }, null, 2));

// coverage-ledger — только если ещё нет
if (!fs.existsSync("AUDIT-COVERAGE.md")) {
  const rows = tracked.filter(t => /^src\//.test(t.path) || /^test-.*\.mjs$/.test(t.path))
    .sort((a, b) => b.size - a.size)
    .map(t => `| ${t.path} | ${t.size} | ${t.sha.slice(0, 8)} | — | не покрыто | — |`).join("\n");
  fs.writeFileSync("AUDIT-COVERAGE.md", `# AUDIT-COVERAGE\n\n| Файл | Байт | Blob | Аудит (SHA) | Покрытие | Находки |\n|---|---|---|---|---|---|\n${rows}\n`);
}

const alerts = [
  ignoredSrc.length && `игнорируемые исходники: ${ignoredSrc.length}`,
  brokenChain.length && `битый test-chain: ${brokenChain.length}`,
  notWired.length && `сюиты вне chain: ${notWired.length}`,
].filter(Boolean);
console.log(`audit-bundle.md (${fs.statSync("audit-bundle.md").size} б), audit-bundle.json, audit-raw/`);
console.log(alerts.length ? "⚠ " + alerts.join(" · ") : "✅ быстрых аномалий не найдено");