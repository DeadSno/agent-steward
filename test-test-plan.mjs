/**
 * TP-6.1 — автоматический контроль TEST-PLAN.md (Деталь 1.4).
 * Запуск: node test-test-plan.mjs
 *
 * Проверяет: покрытие §5, actual-счётчики, дату, SCHEMA_VERSION,
 * языковые артефакты, новые детали D17/D18, статус TP-задач в ROADMAP.
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
check("шапка: дата 24.11.2026", plan.includes("24.11.2026"));
check(`шапка: счётчик файлов = ${testFiles.length}`, plan.includes(`${testFiles.length} файлов`));
check(`шапка: счётчик npm-скриптов = ${npmTestScripts.length}`,
  plan.includes(`${npmTestScripts.length} npm-скриптов`));
check("S16.1.4: счётчики согласованы с шапкой",
  d16.includes(`${testFiles.length} файлов \`test-*.mjs\` (${npmTestScripts.length} npm-скриптов)`) &&
    !d16.includes("119 файлов") && !d16.includes("111 npm-скриптов"));
check("TP-6.2: маркеры генератора счётчиков на месте",
  plan.includes("<!-- counters:start -->") && plan.includes("<!-- counters:end -->"));
check(`SCHEMA_VERSION в плане = ${schemaVersion} (код)`, plan.includes(`SCHEMA_VERSION = ${schemaVersion}`));
check("D15/S15.1.2: миграция 10 → 11",
  /SCHEMA_VERSION\s*=\s*11/.test(plan) && /10\s*[→\-]+\s*11/.test(d15) && d15.includes("S15.1.2"));
check("Приложение B: 32 MCP-инструмента", mcpCount === 32);
check("Приложение A: 59 RPC-методов", rpcCount === 59);
check("§7.1 переименован в «Исправленные баги (реестр)»",
  plan.includes("### 7.1 Исправленные баги (реестр)") && !plan.includes("### 7.1 Найденные баги"));
check("нет языковых артефактов (TP-5.1)",
  artifacts.every((a) => !plan.toLowerCase().includes(a.toLowerCase())));
check("добавлена деталь D17 (обратная связь / report_bug)", /### D17\./.test(plan));
check("добавлена деталь D18 (pipeline-as-code)", /### D18\./.test(plan));
check("§4: строки D17 и D18 в матрице доступа", matrix.includes("| D17") && matrix.includes("| D18"));
check("D17: self_analysis не потерян", d17.includes("self_analysis"));
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

const failed = results.filter((r) => !r.ok);
console.log(`\nИТОГО: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length) {
  console.error("Не пройдено:\n" + failed.map((r) => " - " + r.name).join("\n"));
}
assert.equal(failed.length, 0, "TEST-PLAN.md не прошёл верификацию (Деталь 1.4)");
console.log("TEST-PLAN.md: OK");
