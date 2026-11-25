/**
 * TP-6.1 — автоматический контроль TEST-PLAN.md (Деталь 1.4).
 * Запуск: node test-test-plan.mjs
 *
 * Проверяет: покрытие §5, actual-счётчики, дату, SCHEMA_VERSION,
 * языковые артефакты, новые детали D17/D18, статус TP-задач в ROADMAP,
 * а также закрытые ID §7.4 и устойчивость guard-а к регрессиям (TPS-1.3).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.dirname(url.fileURLToPath(new URL(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const plan = read("TEST-PLAN.md");
const roadmap = read("ROADMAP.md");
const changelog = read("CHANGELOG.md");
const schemaSrc = read("src/db/schema.ts");
const pkg = JSON.parse(read("package.json"));

const section = (text, title, next) => {
  const from = text.indexOf(title);
  if (from < 0) return "";
  const to = next ? text.indexOf(next, from + title.length) : text.length;
  return text.slice(from, to < 0 ? text.length : to);
};

const coverage = section(plan, "## 5. Матрица покрытия автотестами", "## 6.");
const summary = section(plan, "## 1. Сводная карта деталей", "## 2.");
const matrix = section(plan, "## 4. Матрица доступа", "## 5.");
const appendixA = section(plan, "## Приложение A.", "## Приложение B.");
const appendixB = section(plan, "## Приложение B.", "## Приложение C.");
const d15 = section(plan, "### D15.", "### D16.");
const d16 = section(plan, "### D16.", "### D17.");
const d17 = section(plan, "### D17.", "### D18.");
const detail14 = section(roadmap, "## Деталь 1.4", "---");

const testFiles = fs.readdirSync(root).filter((f) => /^test-.*\.mjs$/.test(f)).sort();
const mentioned = [...new Set([...coverage.matchAll(/^\|\s*`([^`]+\.mjs)`/gm)].map((m) => m[1]))];
const npmTestScripts = Object.keys(pkg.scripts ?? {}).filter((k) => k.startsWith("test"));
const rpcCount = new Set([...appendixA.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])).size;
const mcpCount = new Set([...appendixB.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])).size;
const schemaVersion = Number(/export const SCHEMA_VERSION = (\d+)/.exec(schemaSrc)?.[1]);

const artifacts = [
  "largas запусках",
  "jednym вызовом",
  "криticos",
  "Chakon (watch)",
  "mezclываются",
  "lожных",
  "ajuda",
  "полный прогона",
  "häufig обновление",
];

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

check(`§5: все ${testFiles.length} файлов test-*.mjs упомянуты`,
  testFiles.every((f) => mentioned.includes(f)));
check(`§5: все ${mentioned.length} упомянутых файлов существуют`,
  mentioned.every((f) => testFiles.includes(f)));
check("шапка: дата 25.11.2026", plan.includes("25.11.2026"));
check(`шапка: счётчик файлов = ${testFiles.length}`, plan.includes(`${testFiles.length} файлов`));
check(`шапка: счётчик npm-скриптов = ${npmTestScripts.length}`,
  plan.includes(`${npmTestScripts.length} npm-скриптов`));
check("S16.1.4: счётчики согласованы с шапкой",
  d16.includes(`${testFiles.length} файлов \`test-*.mjs\` (${npmTestScripts.length} npm-скриптов)`) &&
    !d16.includes("119 файлов") && !d16.includes("111 npm-скриптов"));
check("TP-6.2: маркеры генератора счётчиков на месте",
  plan.includes("<!-- counters:start -->") && plan.includes("<!-- counters:end -->"));
check(`SCHEMA_VERSION в плане = ${schemaVersion} (код)`, plan.includes(`SCHEMA_VERSION = ${schemaVersion}`));
check("D15/S15.1.2: миграция 10 → 14 (актуальная схема)",
  /SCHEMA_VERSION\s*=\s*14/.test(plan) && /SCHEMA_VERSION\s*=\s*14/.test(d15) &&
    /10\s*[→\-]+\s*14/.test(d15) && d15.includes("S15.1.2"));
check("Приложение B: 34 MCP-инструмента", mcpCount === 34);
check("Приложение A: 61 RPC-методов", rpcCount === 61);
check("§7.1 переименован в «Исправленные баги (реестр)»",
  plan.includes("### 7.1 Исправленные баги (реестр)") && !plan.includes("### 7.1 Найденные баги"));
check("нет языковых артефактов (TP-5.1)",
  artifacts.every((a) => !plan.toLowerCase().includes(a.toLowerCase())));
check("добавлена деталь D17 (обратная связь / report_bug)", /### D17\./.test(plan));
check("добавлена деталь D18 (pipeline-as-code)", /### D18\./.test(plan));
check("§4: строки D17 и D18 в матрице доступа", matrix.includes("| D17") && matrix.includes("| D18"));
check("D17: self_analysis не потерян", d17.includes("self_analysis"));
check("D04: 34 инструмента в сводке и матрице доступа (не 30/32)",
  summary.split("\n").some((line) => /^\|\s*D04\s*\|/.test(line) && line.includes("34 инструмента")) &&
  matrix.split("\n").some((line) => /^\|\s*D04 MCP-слой\s*\|/.test(line) && line.includes("34")) &&
  !/D04[^\n]*(все 30|все 32)/.test(plan));
check("ROADMAP: все TP-3/4/5/6 подзадачи закрыты", !/^- \[ \] TP-[3-6]\./m.test(detail14));
check("артефакты TP-6 созданы",
  testFiles.includes("test-test-plan.mjs") &&
    fs.existsSync(path.join(root, "scripts", "gen-test-plan-counters.mjs")));

// PL-3.2: закрытые подзадачи уходят из ROADMAP и остаются только в CHANGELOG.
const movedIds = ["TP-3", "TP-4", "TP-5", "TP-6"];
check("PL-3.2: Деталь 1.4 / TP-3…TP-6 отсутствуют в ROADMAP",
  !/^##\s+Деталь 1\.4\b/m.test(roadmap) &&
    movedIds.every((id) =>
      !new RegExp(`^-\\s*\\[[ xX]\\]\\s*${id}\\b`, "m").test(roadmap)));
check("PL-3.2: Деталь 1.4 / TP-3…TP-6 зафиксированы в CHANGELOG",
  /Деталь 1\.4/.test(changelog) &&
    /TP-3\s*[–—-]\s*TP-6/.test(changelog) &&
    /удалена из ROADMAP/i.test(changelog));

// TPS-1.3 (Деталь 3.16): guard против возврата закрытых ID §7.4 в открытые статусы.
const s74 = section(plan, "### 7.4 Доработки из ROADMAP.md (бэклог)", "## 8.");

// Закрытые ID привязаны к строке таблицы §7.4. Составные строки дают несколько
// ID на одну строку: E-1/E-2.1/E-2.2, M-1..M-8, F-2/F-2.5 (F-2.5 — в «Сути»).
const CLOSED_74 = [
  ["F-1", "F-1"], ["F-2", "F-2"], ["F-2.5", "F-2.5"], ["F-3", "F-3"], ["F-4", "F-4"],
  ["E-1", "E-1"], ["E-2", "E-2.1"], ["E-3", "E-3"], ["E-4", "E-4"], ["E-5", "E-5"],
  ["A-1", "A-1"],
  ["D-1", "D-1"], ["D-2", "D-2"], ["D-3", "D-3"],
  ["A-2", "A-2"], ["A-3", "A-3"], ["A-4", "A-4"], ["A-5", "A-5"], ["A-6", "A-6"],
  ...Array.from({ length: 8 }, (_, i) => [`M-${i + 1}`, "M-1..M-8"]),
  ["X-1", "X-1"], ["X-2", "X-2"], ["X-3", "X-3"], ["X-5", "X-5"], ["X-6", "X-6"],
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Токен с границами: "F-2" не должен матчить "F-2.5", а "E-2.1"/"M-1..M-8"
// привязывают составные ID к их единственной строке таблицы.
const rowFor = (text, key) => {
  const re = new RegExp(`(?<![\\w.])${escRe(key)}(?![\\w.])`);
  return text.split("\n").find((line) => /^\s*\|/.test(line) && re.test(line));
};
const cellsOf = (row) => row.split("|").map((c) => c.trim());

function auditClosed74(text) {
  const issues = [];
  for (const [id, key] of CLOSED_74) {
    const row = rowFor(text, key);
    if (!row) {
      issues.push(`${id}: строка §7.4 не найдена (${key})`);
      continue;
    }
    const status = cellsOf(row)[4] ?? "";
    const essence = cellsOf(row)[5] ?? "";
    if (!status.includes("✅")) issues.push(`${id}: статус «${status}» — ожидается ✅`);
    if (!/CHANGELOG/i.test(essence)) issues.push(`${id}: нет ссылки на CHANGELOG в «Сути»`);
  }
  return issues;
}

const s74Issues = auditClosed74(s74);
check(`TPS-1.3: ${CLOSED_74.length} закрытых ID §7.4 имеют ✅ и ссылку на CHANGELOG`,
  s74Issues.length === 0);
if (s74Issues.length) console.error(s74Issues.map((s) => " - " + s).join("\n"));

// X-4 намеренно исключён из обязательных: ему разрешено оставаться 🔄.
const x4Row = rowFor(s74, "X-4");
check("TPS-1.3: X-4 разрешён оставаться 🔄 (не требует закрытия)",
  !!x4Row && /[✅🔄]/.test(cellsOf(x4Row)[4] ?? ""));

// Негативный тест: подменяем статус F-1 на ⬜ и убеждаемся, что guard это ловит.
const f1Row = rowFor(s74, "F-1");
const mutated = f1Row ? s74.replace(f1Row, f1Row.replace("✅", "⬜")) : s74;
check("TPS-1.3: негативный тест — регрессия F-1 → ⬜ обнаруживается guard-ом",
  mutated !== s74 && auditClosed74(mutated).some((s) => s.startsWith("F-1:")));
// Восстановление: правка была только в памяти, на диске §7.4 не менялся.
const restored = s74;
check("TPS-1.3: исходное состояние §7.4 восстановлено",
  restored === s74 && auditClosed74(restored).length === 0);

const failed = results.filter((r) => !r.ok);
console.log(`\nИТОГО: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length) {
  console.error("Не пройдено:\n" + failed.map((r) => " - " + r.name).join("\n"));
}
assert.equal(failed.length, 0, "TEST-PLAN.md не прошёл верификацию (Деталь 1.4)");
console.log("TEST-PLAN.md: OK");
