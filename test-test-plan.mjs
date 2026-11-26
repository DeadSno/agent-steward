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
check("шапка: дата 26.11.2026", plan.includes("26.11.2026"));
check("шапка: негатив — возврат старой даты 25.11.2026 детектируется",
  !plan.replaceAll("26.11.2026", "25.11.2026").includes("26.11.2026"));
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

// TPS-1.3 (Деталь 3.16): закрытые ID удалены из §2/§7, в §7.4 осталась только X-4.
const details = section(plan, "## 2. Детали, задачи, подзадачи", "## 3.");
const s74 = section(plan, "### 7.4 Доработки из ROADMAP.md (открытые)", "## 8.");

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

// Закрытые ID больше не должны присутствовать в таблицах плана.
const reintroduced = (text) => CLOSED_74.filter(([, key]) => rowFor(text, key)).map(([id]) => id);

check(`TPS-1.3: ${CLOSED_74.length} закрытых ID §7.4 удалены из плана`,
  reintroduced(s74).length === 0);

// Закрытые подзадачи §2 (BN/IM/QA-P3 и весь D17) тоже удалены.
const CLOSED_S2 = [
  "S01.1.BP.1", "S02.1.BP.2", "S03.1.BP.1", "S03.1.BP.2", "S03.1.BP.3",
  "S03.1.BP.4", "S04.1.BP.2", "S05.1.BP.2", "S06.1.BP.3", "S06.1.BP.4",
  "S08.1.BP.1", "S08.1.BP.2", "S09.1.BP.1", "S09.1.BP.2", "S10.1.BP.2",
  "S10.1.BP.3", "S11.1.BP.2", "S12.1.BP.1", "S12.1.BP.2", "S13.1.BP.1",
  "S13.1.BP.2", "S14.1.BP.1", "S14.1.BP.2", "S15.1.BP.1", "S15.1.BP.2",
  "S16.1.BP.1", "S16.1.BP.2",
  ...Array.from({ length: 6 }, (_, i) => `S17.1.${i + 1}`),
  "S17.1.BP.1", "S17.1.BP.2",
];
check(`TPS-1.3: ${CLOSED_S2.length} закрытых подзадач §2 удалены из плана`,
  CLOSED_S2.every((id) => !rowFor(details, id)));

// X-4 закрыта и перенесена в CHANGELOG: §7.4 не содержит открытых строк.
const x4Row = rowFor(s74, "X-4");
const s74OpenRows = s74.split("\n").filter((line) =>
  /^\s*\|/.test(line) && !/^\s*\|\s*(ID|---)/.test(line));
check("TPS-1.3: X-4 и все открытые строки удалены из §7.4",
  !x4Row && s74OpenRows.length === 0);

// Негативный тест: возврат закрытой строки F-1 в §7.4 должен ловиться guard-ом.
const injected = `${s74}\n| F-1 | D17 | P2 | ✅ закрыто | перенесено в CHANGELOG.md |\n`;
check("TPS-1.3: негативный тест — возврат F-1 в §7.4 обнаруживается",
  reintroduced(injected).includes("F-1"));
check("TPS-1.3: исходное состояние §7.4 восстановлено",
  reintroduced(s74).length === 0 && !rowFor(s74, "F-1"));

// Устаревшие счётчики и ссылки на удалённые секции не должны вернуться.
check("актуализация: нет 32 инструментов, 21 проверки, Деталей 3.9/3.19",
  !/32 инструмент/i.test(plan) && !/21 проверка/.test(plan) &&
    !/Деталь 3\.19/.test(plan) && !/Деталь 3\.9/.test(plan));

const failed = results.filter((r) => !r.ok);
console.log(`\nИТОГО: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length) {
  console.error("Не пройдено:\n" + failed.map((r) => " - " + r.name).join("\n"));
}
assert.equal(failed.length, 0, "TEST-PLAN.md не прошёл верификацию (Деталь 1.4)");
console.log("TEST-PLAN.md: OK");
