/**
 * Проверка документации 0.6: ARCHITECTURE / FEATURES / MIGRATION.
 * Запуск: node test-docs.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.dirname(url.fileURLToPath(new URL(import.meta.url)));
const docs = path.join(root, "docs");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const files = ["ARCHITECTURE.md", "FEATURES.md", "MIGRATION.md"];

for (const file of files) {
  const p = path.join(docs, file);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  check(`docs/${file} существует`, text.length > 0);
  check(`docs/${file}: есть заголовок h1`, text.startsWith("# "));
  check(`docs/${file}: есть оглавление ссылками`, /\]\(#/.test(text));
}

const arch = fs.readFileSync(path.join(docs, "ARCHITECTURE.md"), "utf8");
check("ARCHITECTURE: описывает 4 типа процессов", arch.includes("| Plugin host |") && arch.includes("| Recorder |"));
check("ARCHITECTURE: Linux-бэкенд — crontab (не systemd)", arch.includes("| Linux | `crontab` |"));
check("ARCHITECTURE: модули index/gui/server/matrix/record-history", ["src/index.ts", "gui.tsx", "server.ts", "core/matrix.ts", "record-history.ts"].every((m) => arch.includes(m)));
check("ARCHITECTURE: пути плагина %APPDATA% и XDG", arch.includes("%APPDATA%") && arch.includes("XDG_CONFIG_HOME"));
check("ARCHITECTURE: security-модель (localhost, metadata, plaintext)", arch.includes("no authentication") && arch.includes("metadata") && arch.includes("plain text"));

const feat = fs.readFileSync(path.join(docs, "FEATURES.md"), "utf8");
check("FEATURES: все 22 инструмента агента", ["schedule_task", "update_task", "pause_task", "resume_task", "get_history", "get_task_logs", "dry_run", "manage_workspaces", "matrix_control", "list_tasks", "delete_task", "run_task_now", "get_metrics", "get_analytics", "manage_settings", "manage_templates", "manage_profiles", "transfer_tasks", "send_notification", "get_dashboard_info", "cleanup_history", "emit_event"].every((t) => feat.includes(t)));
check("FEATURES: матрица со всеми полями конфига", ["strategy", "failureMode", "concurrency", "overrides", "createAggregator", "aggregation"].every((k) => feat.includes(k)));
check("FEATURES: статусы истории incl. partial", feat.includes("`partial`"));
check("FEATURES: ограничения (limits) честно перечислены", feat.includes("No one-shot") && feat.toLowerCase().includes("restrict the agent process") && feat.toLowerCase().includes("session continuity"));

const mig = fs.readFileSync(path.join(docs, "MIGRATION.md"), "utf8");
for (const section of ["From cron / crontab", "From systemd timers", "From launchd", "From Windows Task Scheduler", "Bulk import and export", "Verification checklist", "Common pitfalls", "Rollback"]) {
  check(`MIGRATION: раздел «${section}»`, mig.includes(`## ${section}`));
}
check("MIGRATION: пример import-формата с version: 1", mig.includes('"version": 1') && mig.includes('"tasks":'));
check("MIGRATION: нет упоминаний конкурентов", !/different-ai|sig9|jdormit|geckom|pan17|Fraser/i.test(mig));

// Все три файла в npm-пакете.
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check("package.json: files включает docs", Array.isArray(pkg.files) && pkg.files.includes("docs"));
check("package.json: files включает locales", Array.isArray(pkg.files) && pkg.files.includes("locales"));
check("package.json: test включает test-docs.mjs", typeof pkg.scripts.test === "string" && pkg.scripts.test.includes("test-docs.mjs"));
check("package.json: test включает test-i18n.mjs", typeof pkg.scripts.test === "string" && pkg.scripts.test.includes("test-i18n.mjs"));
check(
  "package.json: test:en гоняет сюиты в английской локали",
  typeof pkg.scripts["test:en"] === "string" &&
    pkg.scripts["test:en"].includes("scripts/test-locale.mjs")
);
check(
  "scripts/test-locale.mjs существует",
  fs.existsSync(path.join(root, "scripts", "test-locale.mjs"))
);

// Спринт 28, задача 28.6 отменена в 1.5.6: заглушка `opencode-pipeline`
// удалена из репозитория, сам пакет депрекейчен, резерв имени переехал
// в `agent-steward`. Проверяем, что локальные пакеты не вернулись и что
// workflow публикации заглушки вместе с ними не восстановили.
const packagesDir = path.join(root, "packages");
const strayPackages = fs.existsSync(packagesDir)
  ? fs
      .readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];
check(
  `packages/: нет локальных пакетов (${strayPackages.join(", ") || "пусто"})`,
  strayPackages.length === 0
);
check(
  "workflow публикации заглушки удалён",
  !fs.existsSync(path.join(root, ".github", "workflows", "publish-placeholder.yml"))
);

// Контракт совместимости: числа в docs/COMPATIBILITY.md — источник истины
// для README и CI. Минимум V1 зафиксирован в 1.5.6.
const compatDoc = path.join(docs, "COMPATIBILITY.md");
const compatText = fs.existsSync(compatDoc) ? fs.readFileSync(compatDoc, "utf8") : "";
check("docs/COMPATIBILITY.md существует", compatText.length > 0);
check("COMPATIBILITY: минимум V1 = 1.18.29", compatText.includes("1.18.29"));
check("COMPATIBILITY: TUI V1 через @opencode-ai/plugin/tui", compatText.includes("@opencode-ai/plugin/tui"));
check("COMPATIBILITY: минимум V2 = 2.2.7", compatText.includes("`2.2.7`"));
check("COMPATIBILITY: V2 проверяется на 2.3.0", compatText.includes("2.3.0"));

// Спринт 28: каталоги локалей обязаны совпадать по набору ключей.
// Рассинхронизация — падение CI (см. ROADMAP, спринт 28).
const localesDir = path.join(root, "locales");
const readCatalog = (locale) => {
  const p = path.join(localesDir, `${locale}.json`);
  check(`locales/${locale}.json существует`, fs.existsSync(p));
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
};
const ruCatalog = readCatalog("ru");
const enCatalog = readCatalog("en");
const ruKeys = Object.keys(ruCatalog).sort();
const enKeys = Object.keys(enCatalog).sort();
const onlyRu = ruKeys.filter((k) => !(k in enCatalog));
const onlyEn = enKeys.filter((k) => !(k in ruCatalog));
check(`locales: нет ключей только в ru (${onlyRu.join(", ") || "нет"})`, onlyRu.length === 0);
check(`locales: нет ключей только в en (${onlyEn.join(", ") || "нет"})`, onlyEn.length === 0);
check("locales: набор ключей не пуст", ruKeys.length > 0);
check(
  "locales: значения не пустые",
  ruKeys.every((k) => typeof ruCatalog[k] === "string" && ruCatalog[k].length > 0) &&
    enKeys.every((k) => typeof enCatalog[k] === "string" && enCatalog[k].length > 0)
);

const failed = results.filter((r) => !r.ok);
console.log(`\nDocs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
