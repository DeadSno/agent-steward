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
check(
  "package.json: @opencode/plugin на полу ^2.2.7",
  pkg.dependencies?.["@opencode/plugin"] === "^2.2.7"
);
check(
  "package.json: @opencode-ai/plugin запинен 1.19.5",
  pkg.devDependencies?.["@opencode-ai/plugin"] === "1.19.5"
);
check(
  "package.json: peerDependencies не объявляют plugin API",
  !pkg.peerDependencies?.["@opencode/plugin"] &&
    !pkg.peerDependencies?.["@opencode-ai/plugin"]
);

// З1.2: границы поверхности. GUI и RPC — только V2, TUI — обе линии.
check(
  "COMPATIBILITY: матрица поверхности V1 / V2",
  compatText.includes("## Матрица поверхности V1 / V2")
);
check(
  "COMPATIBILITY: GUI и RPC — только V2",
  compatText.includes("| GUI-панель | **нет** | да |") &&
    compatText.includes("| RPC-методы") &&
    compatText.includes("GUI и RPC — только V2")
);
check(
  "COMPATIBILITY: TUI — обе линии",
  compatText.includes("| TUI-панель «Планировщик» | да") &&
    compatText.includes("**обе линии**")
);

// З1.3: инварианты состояния. Значения в документации обязаны совпадать
// с исходниками — иначе rename/dual-support незаметно ломает состояние.
check(
  "COMPATIBILITY: раздел «Инварианты состояния»",
  compatText.includes("## Инварианты состояния")
);
check(
  "COMPATIBILITY: инварианты перечисляют id, пути, БД и префикс",
  ["opencode-windows-scheduler", "scheduler.db", "%APPDATA%", "\\OpenCode\\windows-scheduler\\"].every(
    (needle) => compatText.includes(needle)
  )
);
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
check(
  'src/index.ts: plugin id остаётся "opencode-windows-scheduler"',
  /id:\s*"opencode-windows-scheduler"/.test(indexSrc)
);
check(
  "src/index.ts: setup V2 стартует через общий createRuntime",
  /export async function createRuntime\(/.test(indexSrc) &&
    /setup: async \(ctx\) => \{\s*const runtime = await createRuntime\(ctx\);/.test(indexSrc)
);
const registeredTools = [...indexSrc.matchAll(/name: "([a-z_]+)",/g)].map((m) => m[1]);
const handlerBlock = indexSrc.match(/export interface ToolHandlers \{([\s\S]*?)\n\}/);
const handlerKeys = handlerBlock
  ? [...handlerBlock[1].matchAll(/^\s{2}([a-z_]+): typeof /gm)].map((m) => m[1])
  : [];
check(
  "src/index.ts: у каждого инструмента есть общий handler",
  registeredTools.length > 0 &&
    registeredTools.length === handlerKeys.length &&
    registeredTools.every((name) => handlerKeys.includes(name))
);
check(
  "src/index.ts: ToolSpec использует общие handlers.*",
  !/execute: [a-zA-Z]+Execute as any/.test(indexSrc) &&
    (indexSrc.match(/handlers\.[a-z_]+ as any/g) || []).length === registeredTools.length
);
check(
  "src/index.ts: V2-обёртка editor.add тонкая (createToolSpecs)",
  /for \(const spec of createToolSpecs\(runtime\)\) \{/.test(indexSrc) &&
    (indexSrc.match(/editor\.add\(\{/g) || []).length === 2
);
// П2.3.1: hook-домены V2 не используются. Аудит — withAudit в specs,
// permissions — env фонового запуска, события — emit_event и триггеры runtime.
const hookDomains = ["ctx.tool.hook", "ctx.permission.hook", "ctx.event.subscribe"];
check(
  "src/index.ts: общее ядро не зависит от V2 hook-доменов",
  hookDomains.every((domain) => !indexSrc.includes(domain))
);
check(
  "COMPATIBILITY: зафиксирован отказ от hook-доменов",
  compatText.includes("Хуки не используются осознанно") &&
    compatText.includes("withAudit") &&
    compatText.includes("emit_event")
);
// П2.4.1: единый сценарий выгрузки для обоих entrypoint.
const shutdownBlock = indexSrc.match(
  /export function createShutdownHandler\([\s\S]*?\n\}/
);
const shutdownSrc = shutdownBlock ? shutdownBlock[0] : "";
const shutdownOrder = [
  "shutdownGate.begin()",
  "registration.dispose()",
  "runtime.dispose()",
  "closeDashboardServer()",
  "shutdownGate.waitForIdle(",
  "closeDb()",
].map((step) => shutdownSrc.indexOf(step));
check(
  "src/index.ts: createShutdownHandler сохраняет порядок выгрузки",
  shutdownSrc.length > 0 &&
    shutdownOrder.every((pos) => pos >= 0) &&
    shutdownOrder.every((pos, i) => i === 0 || pos > shutdownOrder[i - 1])
);
check(
  "src/index.ts: setup V2 отдаёт общий shutdown-обработчик",
  /return createShutdownHandler\(runtime, \[/.test(indexSrc) &&
    (indexSrc.match(/shutdownGate\.begin\(\)/g) || []).length === 1
);
// З3.1: dual export. V2 — const с id/setup, V1 — server на том же ядре.
check(
  "src/index.ts: V2 объявлен отдельной константой",
  /const v2Plugin = Plugin\.define\(\{/.test(indexSrc)
);
const v1HooksBlock = indexSrc.match(
  /export async function createV1Hooks\([\s\S]*?\n\}/
);
const v1HooksSrc = v1HooksBlock ? v1HooksBlock[0] : "";
check(
  "src/index.ts: V1-entrypoint использует общие createRuntime/createV1Tools/createShutdownHandler",
  v1HooksSrc.length > 0 &&
    /createRuntime\(/.test(v1HooksSrc) &&
    /createV1Tools\(runtime\)/.test(v1HooksSrc) &&
    /createShutdownHandler\(runtime\)/.test(v1HooksSrc)
);
const v1ToolsBlock = indexSrc.match(
  /export function createV1Tools\([\s\S]*?\n\}/
);
const v1ToolsSrc = v1ToolsBlock ? v1ToolsBlock[0] : "";
const v1ArgsBlock = indexSrc.match(
  /export function toV1ToolArgs\([\s\S]*?\n\}/
);
const v1ArgsSrc = v1ArgsBlock ? v1ArgsBlock[0] : "";
check(
  "src/index.ts: V1-инструменты идут через createToolSpecs и raw shape",
  v1ToolsSrc.length > 0 &&
    /createToolSpecs\(runtime\)/.test(v1ToolsSrc) &&
    /v1Tool\(\{/.test(v1ToolsSrc) &&
    /toV1ToolArgs\(spec\)/.test(v1ToolsSrc) &&
    !/options\s*:/.test(v1ToolsSrc)
);
check(
  "src/index.ts: toV1ToolArgs берёт z.object(...).shape и падает на другой схеме",
  /\.shape/.test(v1ArgsSrc) && /throw new Error/.test(v1ArgsSrc)
);
check(
  "src/index.ts: default export объединяет V2 и V1",
  /export default \{ \.\.\.v2Plugin, \.\.\.v1Plugin \};/.test(indexSrc) &&
    /const v1Plugin: V1PluginModule = \{/.test(indexSrc)
);
check(
  "package.json: тест двойного экспорта подключён",
  fs.readFileSync(path.join(root, "package.json"), "utf8").includes(
    "node test-dual-entry.mjs"
  ) && fs.existsSync(path.join(root, "test-dual-entry.mjs"))
);
const typesSrc = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
check(
  'src/types.ts: TASK_FOLDER остаётся "OpenCode"',
  typesSrc.includes('export const TASK_FOLDER = "OpenCode";')
);
const profilesSrc = fs.readFileSync(path.join(root, "src", "profiles.ts"), "utf8");
check(
  'src/profiles.ts: каталог "opencode/windows-scheduler" не переименован',
  profilesSrc.includes('"opencode", "windows-scheduler"')
);
const dbSrc = fs.readFileSync(path.join(root, "src", "db", "index.ts"), "utf8");
check(
  'src/db/index.ts: SQLite остаётся "scheduler.db"',
  dbSrc.includes('"scheduler.db"')
);

// П1.2.3: README всех локалей требуют V1 >=1.18.29 или V2, а не только v2.
const readmeFiles = ["README.md", "docs/README.ru.md", "docs/README.zh.md"];
const readmesOk = readmeFiles.filter((rel) => {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  return text.includes("1.18.29") && !/OpenCode v2/i.test(text);
});
check(
  `README (${readmeFiles.length} локали): пол V1 1.18.29 и нет «OpenCode v2»`,
  readmesOk.length === readmeFiles.length
);

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
