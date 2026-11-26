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
check(
  "ARCHITECTURE: описывает модель исполнения (входы → ядро → обёртка)",
  arch.includes("## Execution model") &&
    arch.includes("| ad-hoc (no OS registration) |") &&
    arch.includes("| internal orchestration (core-driven, no OS) |") &&
    arch.includes("| registered triggers |") &&
    arch.includes("| Plugin host |") &&
    arch.includes("| recorder |"),
);
const schemaSrc = fs.readFileSync(path.join(root, "src/db/schema.ts"), "utf8");
const schemaVersion = Number(/export const SCHEMA_VERSION = (\d+)/.exec(schemaSrc)?.[1]);
const agentsDoc = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
check(
  `AGENTS.md: SCHEMA_VERSION совпадает с кодом (${schemaVersion})`,
  agentsDoc.includes(`SCHEMA_VERSION=${schemaVersion}`),
);
check(
  `ARCHITECTURE: SCHEMA_VERSION совпадает с кодом (${schemaVersion})`,
  Number.isInteger(schemaVersion) &&
    arch.includes(`\`SCHEMA_VERSION\` is currently **${schemaVersion}**`) &&
    arch.includes(`\`SCHEMA_VERSION\` (currently \`${schemaVersion}\`)`),
);
check("ARCHITECTURE: Linux-бэкенд — crontab (не systemd)", arch.includes("| Linux | `crontab` |"));
check("ARCHITECTURE: модули index/gui/server/matrix/record-history", ["src/index.ts", "gui.tsx", "server.ts", "core/matrix.ts", "record-history.ts"].every((m) => arch.includes(m)));
check("ARCHITECTURE: пути плагина %APPDATA% и XDG", arch.includes("%APPDATA%") && arch.includes("XDG_CONFIG_HOME"));
check("ARCHITECTURE: security-модель (localhost, metadata, plaintext)", arch.includes("no authentication") && arch.includes("metadata") && arch.includes("plain text"));

const feat = fs.readFileSync(path.join(docs, "FEATURES.md"), "utf8");
// Список инструментов берём из реестра кода, а не хардкодим: иначе новый
// инструмент (как было с self_analysis) выпадает из документации незаметно.
const toolRegistry = [...fs.readFileSync(path.join(root, "src", "index.ts"), "utf8").matchAll(/^\s+name: "([a-z_]+)",$/gm)].map((m) => m[1]);
const toolsMissingInFeatures = toolRegistry.filter((t) => !feat.includes("`" + t + "`"));
check(
  `FEATURES: все ${toolRegistry.length} инструментов реестра описаны`,
  toolRegistry.length >= 26 && toolsMissingInFeatures.length === 0
);
const readmeMain = fs.readFileSync(path.join(root, "README.md"), "utf8");
check(
  "README: счётчик инструментов совпадает с реестром кода",
  readmeMain.includes(`${toolRegistry.length} agent tools`) &&
    readmeMain.includes(`${toolRegistry.length} tools covering`)
);
const toolsMissingInReadme = toolRegistry.filter((t) => !readmeMain.includes("`" + t + "`"));
check(
  `README: все ${toolRegistry.length} инструментов реестра описаны в таблице`,
  toolsMissingInReadme.length === 0
);
const strategyDoc = fs.readFileSync(path.join(root, "ROADMAP-STRATEGY.md"), "utf8");
check(
  "DOCS: счётчик инструментов унифицирован в ARCHITECTURE/STRATEGY",
  arch.includes(`${toolRegistry.length} agent tools`) &&
    arch.includes(`${toolRegistry.length} tools registered`) &&
    strategyDoc.includes(`${toolRegistry.length} инструментов агента`)
);
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
check(
  "QW-14.4: npm-тарбол исключает мёртвый index.js и dev-скрипты коммитов",
  !pkg.files.includes("index.js") && pkg.files.includes("!scripts/*-commit.ps1")
);
check(
  "QW-14.4: все README упоминают четвёртый каталог locales/tr.json",
  [
    readmeMain,
    fs.readFileSync(path.join(docs, "README.ru.md"), "utf8"),
    fs.readFileSync(path.join(docs, "README.zh.md"), "utf8"),
  ].every((text) => text.includes("locales/tr.json"))
);
check(
  "QW-14.4: COMPATIBILITY называет последнюю V1 1.19.6",
  fs.readFileSync(path.join(docs, "COMPATIBILITY.md"), "utf8").includes("1.19.6")
);
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
// QA-D316-19: лимит каталога Code Mode и альтернативные пути обязаны быть
// задокументированы — иначе агент делает вывод об отсутствии инструмента.
check(
  "QA-D316-19: COMPATIBILITY фиксирует 8 из 34 и пути MCP/CLI/RPC",
  compatText.includes("| Каталог Code Mode раннера | 8 из 34 инструментов |") &&
    compatText.includes("MCP, CLI и HTTP RPC")
);

// З1.3: инварианты состояния. Значения в документации обязаны совпадать
// с исходниками — иначе rename/dual-support незаметно ломает состояние.
check(
  "COMPATIBILITY: раздел «Инварианты состояния»",
  compatText.includes("## Инварианты состояния")
);
check(
  "COMPATIBILITY: инварианты перечисляют id, пути, БД и префикс",
  ["opencode-windows-scheduler", "scheduler.db", "%APPDATA%", "\\OpenCode\\agent-steward\\", "\\OpenCode\\windows-scheduler\\"].every(
    (needle) => compatText.includes(needle)
  )
);
const indexSrc = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
check(
  'src/index.ts: plugin id остаётся "opencode-windows-scheduler"',
  /id:\s*"opencode-windows-scheduler"/.test(indexSrc)
);
// Регресс «RPC is unavailable: opencode-windows-scheduler»: сервер
// регистрирует RPC под SchedulerRpc.id, а GUI строит URL
// /api/rpc/<SchedulerRpc.id>/<method> из своего (заранее собранного)
// бандла. Если id в src/rpc.ts и в gui-experimental.cjs разойдутся,
// все вызовы панели вернут 400. Поэтому проверяем совпадение трёх id.
const rpcSrc = fs.readFileSync(path.join(root, "src", "rpc.ts"), "utf8");
const rpcId = (rpcSrc.match(/export const SchedulerRpc = Rpc\.define\(\{[\s\S]*?id:\s*"([^"]+)"/) || [])[1];
check(
  'src/rpc.ts: RPC-канал называется "opencode-windows-scheduler"',
  rpcId === "opencode-windows-scheduler",
  String(rpcId)
);
check(
  "src/rpc.ts: id RPC-канала совпадает с id плагина в src/index.ts",
  rpcId !== undefined && new RegExp(`id:\\s*"${rpcId}"`).test(indexSrc)
);
const guiBundlePath = path.join(root, "gui-experimental.cjs");
if (fs.existsSync(guiBundlePath)) {
  const guiCode = fs.readFileSync(guiBundlePath, "utf8");
  const guiRpcId = (guiCode.match(/Rpc\.define\(\{id:"([^"]+)"/) || [])[1];
  check(
    "gui-experimental.cjs: id RPC-канала совпадает с src/rpc.ts (бандл не устарел)",
    guiRpcId === rpcId,
    `bundle=${guiRpcId}, src=${rpcId}`
  );
}
check(
  "src/index.ts: setup V2 стартует через общий createRuntime",
  /export async function createRuntime\(/.test(indexSrc) &&
    // QV-8: перед createRuntime допустим ранний возврат для дочернего прогона.
    /setup: async \(ctx\) => \{[\s\S]{0,800}?const runtime = await createRuntime\(ctx\);/.test(indexSrc)
);
// Регресс: GUI вызывает rpc.<method>, но метод обязан быть объявлен в
// SchedulerRpc.methods, иначе клиент падает с "TypeError: ... is not a function".
const guiSrc = fs.readFileSync(path.join(root, "src", "gui.tsx"), "utf8");
const methodsBlock = (rpcSrc.match(/methods:\s*\{([\s\S]*?)\n\s*\},\n\s*events:/) || [])[1] || "";
const declaredMethods = new Set(
  [...methodsBlock.matchAll(/^\s{4}([a-z_]+):\s*\{/gm)].map((m) => m[1])
);
const calledMethods = [
  ...new Set([...guiSrc.matchAll(/\brpc\.([a-z_]+)\(/g)].map((m) => m[1])),
];
const missingMethods = calledMethods.filter((m) => !declaredMethods.has(m));
check(
  "src/gui.tsx: все rpc.<method> объявлены в SchedulerRpc.methods",
  calledMethods.length > 0 && missingMethods.length === 0,
  `missing: ${missingMethods.join(", ")}`
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
    (indexSrc.match(/execute: handlers\.[a-z_]+/g) || []).length === registeredTools.length
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
const packageSrc = fs.readFileSync(path.join(root, "package.json"), "utf8");
const integrationPath = path.join(root, "test-v1-integration.mjs");
const integrationSrc = fs.existsSync(integrationPath)
  ? fs.readFileSync(integrationPath, "utf8")
  : "";
check(
  "package.json: интеграционный тест V1 подключён",
  packageSrc.includes("node test-v1-integration.mjs") &&
    fs.existsSync(integrationPath)
);
check(
  "test-v1-integration: реальный server() и изолированный порт дашборда",
  /pluginModule\.server\(\{ directory:/.test(integrationSrc) &&
    /OPENCODE_SCHEDULER_PORT/.test(integrationSrc) &&
    /hooks\.dispose\(\)/.test(integrationSrc)
);
const dualEntrySrc = fs.readFileSync(path.join(root, "test-dual-entry.mjs"), "utf8");
check(
  "test-dual-entry: наборы имён V1 и V2 сверяются",
  /createToolHandlers/.test(dualEntrySrc)
);
check(
  "test-dual-entry: zod разрешается через createRequire от V1 SDK, а не хардкодом пути",
  /v1PluginRequire\.resolve\("zod"\)/.test(dualEntrySrc) &&
    /@opencode-ai", "plugin", "package\.json"/.test(dualEntrySrc) &&
    !/plugin\/node_modules\/zod\/index\.cjs/.test(dualEntrySrc)
);
const ciPath = path.join(root, ".github", "workflows", "ci.yml");
const ciSrc = fs.existsSync(ciPath) ? fs.readFileSync(ciPath, "utf8") : "";
check(
  "CI: отдельные jobs compat-v1 и compat-v2",
  /compat-v1:/.test(ciSrc) &&
    /compat-v2:/.test(ciSrc) &&
    /node test-v1-integration\.mjs/.test(ciSrc)
);
// P3-32: "22" в setup-node резолвится в последний 22.x (обычно НОВЕЕ минимума),
// поэтому комментарий про «старее» был неверным. Пин нужен для стабильности
// и проверки нижней границы engines, а не защиты от старого 22.x.
check(
  'CI: комментарий про Node "22" не утверждает, что он старее пина',
  !/старее/.test(ciSrc) && ciSrc.includes("нижнюю границу")
);
check(
  "CI: пин 26.4.0 совпадает с минимумом из engines",
  pkg.engines?.node === ">=26.4.0" && ciSrc.includes('"26.4.0"')
);
// macOS дорог в релизной очереди (он блокировал publish 0.0.3), поэтому
// проверяется обычным CI на каждом push. Инвариант не даёт молча потерять macOS.
const releasePath = path.join(root, ".github", "workflows", "release.yml");
const releaseSrc = fs.existsSync(releasePath)
  ? fs.readFileSync(releasePath, "utf8")
  : "";
const ciOsMatrix = ciSrc.match(/os:\s*\[([^\]]+)\]/)?.[1] ?? "";
const releaseOsMatrix = releaseSrc.match(/os:\s*\[([^\]]+)\]/)?.[1] ?? "";
check(
  "CI/release: macOS покрыт CI, релиз проверяет windows и ubuntu",
  ciOsMatrix.includes("macos-latest") &&
    releaseOsMatrix.includes("windows-latest") &&
    releaseOsMatrix.includes("ubuntu-latest")
);
const tuiSrc = fs.readFileSync(path.join(root, "src", "tui.tsx"), "utf8");
const tuiV1Path = path.join(root, "src", "tui-v1.tsx");
check(
  "src/tui.tsx: один модуль отдаёт V2 setup и V1 tui",
  /export const v2Tui = Plugin\.define\(\{/.test(tuiSrc) &&
    /export default \{ \.\.\.v2Tui, tui: tuiV1 \}/.test(tuiSrc) &&
    fs.existsSync(tuiV1Path)
);
const tuiV1Src = fs.existsSync(tuiV1Path) ? fs.readFileSync(tuiV1Path, "utf8") : "";
check(
  "src/tui-v1.tsx: TuiPluginModule, слот sidebar_content и маршрут",
  /const moduleDefinition: TuiPluginModule = \{ id: PLUGIN_ID, tui: tuiV1 \}/.test(
    tuiV1Src
  ) &&
    /api\.slots\.register\(\{/.test(tuiV1Src) &&
    /sidebar_content:/.test(tuiV1Src) &&
    /api\.route\.register\(\[/.test(tuiV1Src)
);
check(
  "src/tui-v1.tsx: kv, lifecycle и действия run/pause/resume/log",
  /api\.kv\.get<string>/.test(tuiV1Src) &&
    /api\.kv\.set\(/.test(tuiV1Src) &&
    /api\.lifecycle\.onDispose\(/.test(tuiV1Src) &&
    /backend\.runTask\(/.test(tuiV1Src) &&
    /backend\.pauseTask\(/.test(tuiV1Src) &&
    /backend\.resumeTask\(/.test(tuiV1Src) &&
    /getTaskLogs\(/.test(tuiV1Src)
);
check(
  'package.json: TUI-часть опубликована как "./tui"',
  JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  ).exports?.["./tui"] === "./src/tui.tsx"
);
const typesSrc = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
check(
  'src/types.ts: TASK_FOLDER остаётся "OpenCode"',
  typesSrc.includes('export const TASK_FOLDER = "OpenCode";')
);
const profilesSrc = fs.readFileSync(path.join(root, "src", "profiles.ts"), "utf8");
check(
  'src/profiles.ts: целевой каталог agent-steward, legacy windows-scheduler',
  profilesSrc.includes('"agent-steward"') && profilesSrc.includes('"windows-scheduler"')
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

// З3.5: у каждой линии свой ключ конфига, примеры есть во всех локалях.
// В конфиге указывается npm-имя пакета (agent-steward); plugin id отдельный
// и по-прежнему opencode-windows-scheduler.
const configKeysOk = readmeFiles.filter((rel) => {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  return (
    text.includes('"plugin": ["agent-steward"]') &&
    text.includes('"plugins": ["agent-steward"]') &&
    !text.includes('"plugin": ["opencode-windows-scheduler"]') &&
    !text.includes('"plugins": ["opencode-windows-scheduler"]')
  );
});
check(
  `README (${readmeFiles.length} локали): ключи plugin (V1) и plugins (V2) указывают npm-имя agent-steward`,
  configKeysOk.length === readmeFiles.length
);

// P3-7: явный контракт паритета zh. test-i18n проверяет locales/*.json,
// но не сами .md-переводы — здесь фиксируем структуру документов.
const zhPairs = [
  ["docs/README.zh.md", "docs/README.ru.md"],
  ["docs/FAQ.zh.md", "docs/FAQ.ru.md"],
  ["docs/SAVINGS.zh.md", "docs/SAVINGS.ru.md"],
  ["docs/CROSS_PLATFORM.zh.md", "docs/CROSS_PLATFORM.ru.md"],
  ["docs/FEATURES.zh.md", "docs/FEATURES.md"],
];
const h2Count = (rel) =>
  (fs.readFileSync(path.join(root, rel), "utf8").match(/^## /gm) || []).length;
const fenceCount = (rel) =>
  (fs.readFileSync(path.join(root, rel), "utf8").match(/^```/gm) || []).length;
const zhMissing = zhPairs.filter(
  ([zh, ref]) =>
    !fs.existsSync(path.join(root, zh)) || !fs.existsSync(path.join(root, ref))
);
check("zh-документация: все пары zh + базовая локаль существуют", zhMissing.length === 0);
const zhHeadingDrift = zhPairs
  .filter(([zh, ref]) => h2Count(zh) !== h2Count(ref));
check(
  `zh: число разделов h2 совпадает с базовой локалью (${zhPairs.length} пар)`,
  zhHeadingDrift.length === 0
);
const zhFenceDrift = zhPairs.filter(([zh, ref]) => fenceCount(zh) !== fenceCount(ref));
check(
  "zh: число блоков кода совпадает с базовой локалью",
  zhFenceDrift.length === 0
);
const compatibilitySrc = fs.readFileSync(
  path.join(root, "docs", "COMPATIBILITY.md"),
  "utf8"
);
check(
  "COMPATIBILITY: раздел о ключах конфигурации по линиям",
  compatibilitySrc.includes("**Конфигурация по линиям.**") &&
    compatibilitySrc.includes("`plugin`") &&
    compatibilitySrc.includes("`plugins`") &&
    !compatibilitySrc.includes("dual-поддержка полей")
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

// P3-6: шаблоны сообщества и DX-ярлыки не должны незаметно пропадать.
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
check(
  ".github: шаблон bug report",
  fs.existsSync(path.join(root, ".github", "ISSUE_TEMPLATE", "bug_report.yml"))
);
check(
  ".github: шаблон feature request",
  fs.existsSync(path.join(root, ".github", "ISSUE_TEMPLATE", "feature_request.yml"))
);
check(
  ".github: pull request template",
  fs.existsSync(path.join(root, ".github", "pull_request_template.md"))
);
check(
  "package.json: ярлык test:triage-compare указывает на существующую сюиту",
  typeof pkgJson.scripts?.["test:triage-compare"] === "string" &&
    fs.existsSync(path.join(root, "test-triage-compare.mjs"))
);
check(
  "package.json: pretest:parallel собирает проект перед параллельным прогоном",
  pkgJson.scripts?.["pretest:parallel"] === "npm run build"
);

// P3-36: npm переписывает относительные ссылки в README пакета как
// <repository>/blob/<путь> и теряет ветку. В итоге ссылка из legacy-пакета
// вела на https://github.com/DeadSno/agent-steward/blob/docs/MIGRATION.md
// (ветка `docs` не существует). Ссылка на гайд по ренейму должна быть
// абсолютной и указывать на ветку с самим разделом (сейчас dev).
const legacyReadmePath = path.join(root, "legacy", "README.md");
const legacyReadme = fs.existsSync(legacyReadmePath)
  ? fs.readFileSync(legacyReadmePath, "utf8")
  : "";
const migrationUrl =
  "https://github.com/DeadSno/agent-steward/blob/dev/docs/MIGRATION.md#from-opencode-windows-scheduler-to-agent-steward-package-rename";
check("legacy/README.md существует", legacyReadme.length > 0);
check(
  "legacy/README.md: ссылка на MIGRATION абсолютная и с веткой",
  legacyReadme.includes(`[docs/MIGRATION.md](${migrationUrl})`)
);
check(
  "legacy/README.md: нет относительной ссылки ../docs/MIGRATION.md (ломается на npm)",
  !legacyReadme.includes("../docs/MIGRATION.md")
);
const migrationDoc = fs.readFileSync(path.join(docs, "MIGRATION.md"), "utf8");
check(
  "docs/MIGRATION.md: анкор package rename существует в целевом документе",
  migrationDoc.includes("## From `opencode-windows-scheduler` to `agent-steward` (package rename)")
);

// Дашборд отдаёт x-plugin-dashboard: agent-steward (DASHBOARD_MARKER).
// Клиентская проверка в readJson должна принимать оба маркера, иначе на каждый
// успешный ответ сыпется ложное предупреждение «нет заголовка».
const serverSrc = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
const markerGuard = /if \(marker !== 'agent-steward' && marker !== 'opencode-windows-scheduler'\) \{[\s\S]{0,200}?В ответе нет заголовка x-plugin-dashboard/.test(serverSrc);
check(
  "server.ts: readJson принимает маркеры agent-steward и legacy без ложного warning",
  markerGuard && serverSrc.includes('const DASHBOARD_MARKER = "agent-steward"')
);

// DOC-1.3: счётчик сюит в README сверяется не с числом файлов на диске, а с
// числом `node test-*.mjs` в сценарии `npm test`. Отдельные сюиты (например,
// `test-chaos-dag.mjs` через `test:chaos`) в npm test не входят, но обязаны
// быть упомянуты в каком-либо script — иначе тест незаметно «теряется».
const npmTestScript = pkgJson.scripts?.test ?? "";
const suitesInScript = [...npmTestScript.matchAll(/node (test-[^\s]+\.mjs)/g)].map((m) => m[1]);
const suitesInScriptUnique = [...new Set(suitesInScript)];
const suiteFilesOnDisk = fs.readdirSync(root).filter((f) => /^test-.*\.mjs$/.test(f));
const readmeSuiteCount = Number(/# (\d+) test suites/.exec(readmeMain)?.[1]);
const allScriptsText = Object.values(pkgJson.scripts ?? {}).join(" ");
const unlistedSuites = suiteFilesOnDisk.filter((f) => !allScriptsText.includes(f));

check(
  `README: число test suites (${readmeSuiteCount}) = число node test-*.mjs в npm test (${suitesInScriptUnique.length})`,
  Number.isInteger(readmeSuiteCount) &&
    readmeSuiteCount === suitesInScriptUnique.length &&
    suitesInScript.length === suitesInScriptUnique.length
);

// REL-01: переведённые README должны показывать то же число уникальных сюит,
// что и npm test. Эталон берём из suitesInScriptUnique, а не хардкодим: как
// только в npm test добавят сюиту, счётчик в локалях тоже обязан обновиться.
for (const rel of ["docs/README.ru.md", "docs/README.zh.md"]) {
  const p = path.join(root, rel);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  const match = /npm test[^\n]*#\s*(\d+)/.exec(text);
  const found = match ? Number(match[1]) : null;
  check(
    `${rel}: счётчик сюит в npm test ${found === null ? "отсутствует" : `найдено ${found}`}, ожидалось ${suitesInScriptUnique.length}`,
    found !== null && found === suitesInScriptUnique.length
  );
}
check(
  `package.json: все ${suiteFilesOnDisk.length} test-*.mjs на диске упомянуты в скриптах (не упомянуто: ${unlistedSuites.length})`,
  unlistedSuites.length === 0 && suiteFilesOnDisk.length > 0
);

// PL-44: счётчики tools/RPC/сюит во всех локальных SKILL.md сверяются с кодом.
const rpcMethodsBlock = (rpcSrc.match(/methods:\s*\{([\s\S]*?)\n\s*\},\n\s*events:/) || [])[1] || "";
const rpcCountForSkills = [...rpcMethodsBlock.matchAll(/^\s{4}[a-z_]+:\s*\{/gm)].length;
const skillFiles = [
  ...fs
    .readdirSync(path.join(root, ".opencode/skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(".opencode/skills", e.name, "SKILL.md")),
  ...fs
    .readdirSync(path.join(root, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join("skills", e.name, "SKILL.md")),
].filter((rel) => fs.existsSync(path.join(root, rel)));

const skillCounters = {
  tools: toolRegistry.length,
  rpc: rpcCountForSkills,
  suites: suitesInScriptUnique.length,
};
const skillPatterns = [
  { kind: "tools", re: /\*\*(\d+)\*\*\s+tools\b/g },
  { kind: "tools", re: /(?<!\*)\b(\d+)\s+tools\b/g },
  { kind: "tools", re: /\*\*(\d+)\*\*\s+agent tools\b/g },
  { kind: "tools", re: /(?<!\*)\b(\d+)\s+agent tools\b/g },
  { kind: "tools", re: /\*\*(\d+)\*\*\s+MCP-инструментов/g },
  { kind: "tools", re: /(?<!\*)\b(\d+)\s+MCP-инструментов/g },
  { kind: "tools", re: /инструменты\s*\(из\s*\*\*(\d+)\*\*\)/g },
  { kind: "tools", re: /инструменты\s*\(из\s*(\d+)\)/g },
  { kind: "rpc", re: /\*\*(\d+)\*\*\s+RPC-методов/g },
  { kind: "rpc", re: /(?<!\*)\b(\d+)\s+RPC-методов/g },
  { kind: "rpc", re: /RPC-методы\s*\(из\s*\*\*(\d+)\*\*\)/g },
  { kind: "rpc", re: /RPC-методы\s*\(из\s*(\d+)\)/g },
  { kind: "suites", re: /\*\*(\d+)\*\*\s+наборов тестов/g },
  { kind: "suites", re: /(?<!\*)\b(\d+)\s+наборов тестов/g },
  { kind: "suites", re: /\*\*(\d+)\*\*\s+test suites\b/g },
  { kind: "suites", re: /(?<!\*)\b(\d+)\s+test suites\b/g },
];
let skillCounterMatches = 0;
let skillFilesWithAllThree = 0;
for (const rel of skillFiles) {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const seen = { tools: false, rpc: false, suites: false };
  for (const { kind, re } of skillPatterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const found = Number(m[1]);
      const expected = skillCounters[kind];
      skillCounterMatches++;
      seen[kind] = true;
      check(
        `${rel}: счётчик ${kind} найдено ${found}, ожидалось ${expected}`,
        found === expected
      );
    }
  }
  if (seen.tools && seen.rpc && seen.suites) skillFilesWithAllThree++;
}
check(
  `SKILL.md: найдено ${skillCounterMatches} упоминаний счётчиков в ${skillFiles.length} файлах`,
  skillCounterMatches > 0 && skillFiles.length > 0
);
check(
  `SKILL.md: хотя бы один файл объявляет все три счётчика (tools/RPC/suites), найдено ${skillFilesWithAllThree}`,
  skillFilesWithAllThree >= 1
);

// QA-D316-22 / P-4.2: копия SKILL.md обязана быть побайтово идентична
// исходнику. Рассинхрон ловился только в test-dsh-adapter.mjs (P-4.2)
// после сборки, поэтому фиксируем его мета-гейтом до полного прогона.
const skillSourcePath = path.join(root, "skills/scheduled-job-best-practices/SKILL.md");
const skillCopyPath = path.join(root, ".agents/skills/agent-steward/SKILL.md");
check(
  "QA-D316-22 / P-4.2: копия SKILL.md в .agents/skills/agent-steward побайтово идентична исходнику",
  fs.existsSync(skillSourcePath) &&
    fs.existsSync(skillCopyPath) &&
    fs.readFileSync(skillSourcePath).equals(fs.readFileSync(skillCopyPath))
);

// ROADMAP: закрытые подзадачи удаляются отсюда, остаются только открытые.
// QA-A2.5/A2.6 закрыты по факту (QV-7) и больше не должны встречаться в роадмапе.
const roadmapText = fs.readFileSync(path.join(root, "ROADMAP.md"), "utf8");

// PL-71: /help OpenCode показывает не более 12 инструментов — это не число
// инструментов плагина. В коде должно быть честное пояснение, без старого
// утверждения «12 tools» как количества инструментов плагина.
const helpLimitMatch = /PLUGIN_HELP_VISIBLE_TOOL_LIMIT\s*=\s*(\d+)/.exec(indexSrc);
const helpLimit = helpLimitMatch ? Number(helpLimitMatch[1]) : null;
check(
  `PL-71: лимит /help объявлен в коде (${helpLimit ?? "нет"}), ожидалось 12`,
  helpLimit === 12
);
check(
  "PL-71: описания инструментов честно сообщают про лимит /help",
  indexSrc.includes("PLUGIN_HELP_NOTE") &&
    (indexSrc.match(/PLUGIN_HELP_NOTE/g) || []).length >= 3 &&
    indexSrc.includes("OpenCode /help displays at most")
);
check(
  "PL-71: в исходниках нет устаревшего утверждения «12 tools»",
  !/\b12 tools\b/.test(indexSrc)
);
check(
  "PL-71: регрессия — устаревшее «12 tools» детектируется",
  /\b12 tools\b/.test("// plugin provides 12 tools")
);

// PL-89: release-check SKILL.md должен объявлять счётчик сюит наравне с
// agent-steward-dev/docs-sync. Общий цикл выше ловит только «наборов тестов»,
// поэтому здесь проверяется форма «116 наборов».
const suitesCounterRe = /(?<!\*)\b(\d+)\s+наборов(?: тестов)?/g;
const suitesCountersIn = (text) => [...text.matchAll(suitesCounterRe)].map((m) => Number(m[1]));
const releaseCheckRel = ".opencode/skills/release-check/SKILL.md";
const releaseCheckSuites = suitesCountersIn(
  fs.readFileSync(path.join(root, releaseCheckRel), "utf8")
);
check(
  `PL-89: ${releaseCheckRel}: счётчик сюит ${releaseCheckSuites.join(",") || "отсутствует"}, ожидалось ${skillCounters.suites}`,
  releaseCheckSuites.length > 0 && releaseCheckSuites.every((n) => n === skillCounters.suites)
);
check(
  "PL-89: регрессия — подмена счётчика сюит (115 наборов) детектируется",
  suitesCountersIn("... 115 наборов ...").every((n) => n !== skillCounters.suites)
);

// PL-78: каждая значащая строка «Детали 3.8» — чекбокс, заголовок или
// метаданные-файлы в backticks; обрывки предложений недопустимы.
const detail38Lines = (text) => {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Деталь\s+3\.8\b/.test(line));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^(---|#{1,2}\s)/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== "");
};
const damaged38Lines = (text) =>
  detail38Lines(text).filter(
    (line) => !/^#{1,6}\s/.test(line) && !/^`/.test(line) && !/^- \[ \] /.test(line)
  );
// Раздел «Деталь 3.8» мог быть намеренно удалён из ROADMAP (23.11.2026):
// проверяем целостность только если он есть, отсутствие не считается повреждением.
check(
  `PL-78: Деталь 3.8 — ${detail38Lines(roadmapText).length} строк, повреждённых ${damaged38Lines(roadmapText).length}`,
  damaged38Lines(roadmapText).length === 0
);
check(
  "PL-78: регрессия — обрывок строки в Детали 3.8 детектируется",
  damaged38Lines("## Деталь 3.8 — x\n\n- [ ] PL-1 - ok\nобрывок предложения\n").length === 1
);

// QA-FULL-05: заголовок src/runtime.ts должен быть валидным JSDoc и описывать
// публичный контракт ядра, а не обрывок после переноса кода из index.ts.
const runtimeHeader = fs
  .readFileSync(path.join(root, "src/runtime.ts"), "utf8")
  .split(/\r?\n/)
  .slice(0, 14)
  .join("\n");
check(
  "QA-FULL-05: src/runtime.ts начинается с корректного JSDoc-блока",
  /^\/\*\*/.test(runtimeHeader) && /\*\//.test(runtimeHeader) && !/\/\*\./.test(runtimeHeader)
);
check(
  "QA-FULL-05: JSDoc описывает createRuntimeCore / SchedulerRuntime / dispose",
  runtimeHeader.includes("createRuntimeCore") &&
    runtimeHeader.includes("SchedulerRuntime") &&
    runtimeHeader.includes("dispose")
);
const brokenRuntimeHeader = "/**\n/*.\n * обрывок\n */\n";
check(
  "QA-FULL-05: регрессия — повреждённый JSDoc детектируется",
  /\/\*\./.test(brokenRuntimeHeader) && !/^\/\*\*[\s\S]*createRuntimeCore/.test(brokenRuntimeHeader)
);

// PL-100: ID подзадач в ROADMAP должны быть уникальны даже при параллельной
// работе нескольких агентов.
const roadmapIds = (text) => [...text.matchAll(/^- \[ \] ([A-Z]+-\d+(?:\.\d+)?)/gm)].map((m) => m[1]);
const duplicateIds = (ids) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
const roadmapDuplicateIds = duplicateIds(roadmapIds(roadmapText));
check(
  `PL-100: ID подзадач в ROADMAP уникальны (${roadmapIds(roadmapText).length} строк, дубли: ${roadmapDuplicateIds.join(",") || "нет"})`,
  roadmapDuplicateIds.length === 0
);
check(
  "PL-100: регрессия — дубль ID детектируется",
  duplicateIds(roadmapIds("- [ ] PL-1 - a\n- [ ] PL-1 - b\n")).join(",") === "PL-1"
);

check(
  "ROADMAP: закрытых подзадач нет (QA-A2.5/A2.6 перенесены в CHANGELOG)",
  !/\[[xX]\]\s/.test(roadmapText) && !/QA-A2\.[56]/.test(roadmapText)
);

// QA-PORT-10: документация MCP ссылается на оба готовых сниппета — файлы
// должны существовать и описывать stdio-подключение к `agent-steward mcp`.
const mcpSnippetPaths = ["examples/.cursor/mcp.json", "examples/.vscode/mcp.json"];
const mcpSnippets = mcpSnippetPaths.map((rel) => {
  const text = fs.readFileSync(path.join(root, rel), "utf8");
  const parsed = JSON.parse(text);
  const server = parsed.mcpServers?.["agent-steward"] ?? parsed.servers?.["agent-steward"];
  return Boolean(server) && JSON.stringify(server).includes("mcp");
});
check(
  `QA-PORT-10: сниппеты MCP для Cursor/VS Code на месте (${mcpSnippets.filter(Boolean).length}/${mcpSnippetPaths.length})`,
  mcpSnippets.every(Boolean)
);

// DS-5.3: счётчики инструментов/RPC и список модулей в ARCHITECTURE.md и
// диаграмме сверяются с кодом, чтобы дрейф ловился в CI (без ручного аудита).
const listTsModules = (dir, prefix) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + "/" + entry.name;
    if (entry.isDirectory()) out.push(...listTsModules(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out.sort();
};
const coreModules = listTsModules(path.join(root, "src/core"), "src/core");
const dbModules = listTsModules(path.join(root, "src/db"), "src/db");
const diagramsDoc = fs.readFileSync(path.join(docs, "ARCHITECTURE-DIAGRAMS.md"), "utf8");
const diagramModuleLines = new Set(diagramsDoc.split(/\r?\n/).map((line) => line.trim()));
const missingInDiagram = [...coreModules, ...dbModules].filter((p) => !diagramModuleLines.has(p));
check(
  `DS-5.3: диаграмма содержит все модули src/core (${coreModules.length}) и src/db (${dbModules.length}); пропущено ${missingInDiagram.length}`,
  coreModules.length > 0 && dbModules.length > 0 && missingInDiagram.length === 0
);
check(
  `DS-5.3: диаграмма: счётчики ${coreModules.length}/${dbModules.length} модулей совпадают с кодом`,
  diagramsDoc.includes(`${coreModules.length} модулей в \`src/core/\``) &&
    diagramsDoc.includes(`${dbModules.length} модулей в \`src/db/\``)
);
check(
  `DS-5.3: ARCHITECTURE/STRATEGY: RPC-методы ${rpcCountForSkills} совпадают с кодом`,
  rpcCountForSkills > 0 &&
    arch.includes(`${rpcCountForSkills} methods`) &&
    strategyDoc.includes(`${rpcCountForSkills} RPC-методов`)
);
const requiredModules = [
  "agents.ts",
  "agents-advanced.ts",
  "approval-api.ts",
  "environment.ts",
  "runner.ts",
  "runner-docker.ts",
  "runner-ssh.ts",
  "tool-profile.ts",
  "usage-surface.ts",
  "opencode-usage.ts",
  "budget.ts",
  "savings.ts",
  "execution.ts",
  "mission.ts",
];
const missingInArchitecture = requiredModules.filter(
  (m) => !arch.includes("src/core/" + m) && !arch.includes("core/" + m)
);
check(
  `DS-5.3: ARCHITECTURE: обязательные модули 3.10/3.11/DS-4.2 (пропущено ${missingInArchitecture.length})`,
  missingInArchitecture.length === 0
);
check(
  "DS-5.3: регрессия — устаревшие счётчики 30/57 и 71 модулей детектируются",
  !arch.includes("30-tool registry") &&
    !arch.includes("57 methods") &&
    !diagramsDoc.includes("71 модулей") &&
    /30-tool registry|57 methods|71 модулей/.test("ARCHITECTURE: 30-tool registry, 57 methods; diagram: 71 модулей")
);

// DOCS-008: регрессия на 240 битых локальных ссылок в диаграммах — ссылки
// писались как из корня (`src/...`), хотя файлы лежат в `docs/`.
const markdownFiles = [];
for (const scanDir of [root, docs, path.join(root, ".agents"), path.join(root, "skills")]) {
  if (!fs.existsSync(scanDir)) continue;
  for (const entry of fs.readdirSync(scanDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    // DOCS-008: временные файлы (_tmp_*, .tmp*) не являются частью проекта.
    if (/^(_tmp_|\.tmp)/i.test(entry.name)) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (rel === "CHANGELOG.md" || rel.startsWith("node_modules/") || rel.startsWith("dist/") || rel.startsWith("legacy/")) continue;
    markdownFiles.push(full);
  }
}
const brokenDocLinks = [];
for (const file of markdownFiles) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().split(/\s+/)[0];
    if (!raw || /^(https?:|mailto:|#)/.test(raw)) continue;
    // Исторические ссылки вида `src/core/execution.ts:478` — это путь + номер
    // строки, а не отдельный файл; `:line` не должен ломать проверку ссылок.
    const target = raw.split("#")[0].replace(/:\d+(?::\d+)?$/, "");
    if (!target) continue;
    const resolved = path.isAbsolute(target)
      ? path.join(root, target)
      : path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) {
      brokenDocLinks.push(`${path.relative(root, file)}: ${raw}`);
    }
  }
}
check(
  `DOCS-008: локальные Markdown-ссылки существуют (${markdownFiles.length} файлов)`,
  markdownFiles.length > 0 && brokenDocLinks.length === 0
);
check(
  "DOCS-008: регрессия — временные _tmp_*.md и :line-ссылки не ломают гейт",
  fs.readFileSync(path.join(root, "test-docs.mjs"), "utf8").includes("(_tmp_|\\.tmp)") &&
    fs.readFileSync(path.join(root, "test-docs.mjs"), "utf8").includes("replace(/:\\d+(?::\\d+)?$/, \"\")")
);

// QA-DIST: предпроверка согласованности dist обязательна для параллельных прогонов.
{
  const runner = fs.readFileSync(path.join(root, "scripts/run-tests.mjs"), "utf8");
  const smoke = fs.readFileSync(path.join(root, "scripts/check-dist-coherence.mjs"), "utf8");
  check(
    "QA-DIST: run-tests вызывает smoke импорта dist до старта сюит",
    runner.includes("scripts/check-dist-coherence.mjs") &&
      runner.indexOf("spawnSync(") < runner.indexOf("let suites = pkg.scripts.test") &&
      smoke.includes("consumeExploreUsage") &&
      smoke.includes("dist/core/execution.js")
  );
}

// DEEP-4.1: матрица объективных артефактов приёмки D01–D18 вместо трёх субъективных критериев.
{
  const plan = fs.readFileSync(path.join(root, "TEST-PLAN.md"), "utf8");
  const marker = "## 4.1 Матрица объективных артефактов приёмки (DEEP-4)";
  const start = plan.indexOf(marker);
  const end = start >= 0 ? plan.indexOf("\n## 5. Матрица покрытия автотестами", start) : -1;
  const matrix = start >= 0 && end > start ? plan.slice(start, end) : "";
  check("DEEP-4.1: §4.1 матрица объективных артефактов присутствует", matrix.length > 0);

  const ids = [...matrix.matchAll(/^\|\s*(D\d{2})\s*\|/gm)].map((m) => m[1]);
  const expectedIds = Array.from({ length: 18 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`);
  check(
    "DEEP-4.1: матрица содержит ровно D01–D18 в порядке",
    ids.join(",") === expectedIds.join(","),
  );

  const rows = new Map();
  for (const line of matrix.split("\n")) {
    const m = /^\|\s*(D\d{2})\s*\|(.+)\|$/.exec(line);
    // Экранированные `\|` внутри URL/CLI не должны делить ячейки.
    if (m) rows.set(m[1], m[2].split(/(?<!\\)\|/).map((cell) => cell.trim()));
  }
  check(
    "DEEP-4.1: у каждой детали заполнены все три колонки",
    expectedIds.every((id) => {
      const cells = rows.get(id);
      return cells?.length === 3 && cells.every((cell) => cell.length > 0);
    }),
  );
  check(
    "DEEP-4.1: колонка «работает» содержит команду прогона",
    expectedIds.every((id) =>
      /`node test-[^`]+\.mjs`|`npm run [^`]+`/.test(rows.get(id)?.[0] ?? ""),
    ),
  );

  const appendixB = plan.slice(
    plan.indexOf("## Приложение B"),
    plan.indexOf("## Приложение C"),
  );
  const mcpNames = new Set([...appendixB.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
  check(
    "DEEP-4.1: колонка «агент» ссылается на MCP-инструмент из Приложения B",
    mcpNames.size === 34 &&
      expectedIds.every((id) =>
        [...(rows.get(id)?.[1] ?? "").matchAll(/`([a-z_]+)`/g)].some((m) =>
          mcpNames.has(m[1]),
        ),
      ),
  );
  check(
    "DEEP-4.1: колонка «пользователь» указывает GUI/дашборд/TUI/CLI",
    expectedIds.every((id) => /GUI|дашборд|TUI|CLI/i.test(rows.get(id)?.[2] ?? "")),
  );

  const section = (text, from, to) => {
    const a = text.indexOf(from);
    const b = a < 0 ? -1 : text.indexOf(to, a + from.length);
    return a >= 0 && b > a ? text.slice(a, b) : "";
  };
  const d17 = section(plan, "### D17. Обратная связь / report_bug", "### D18.");
  const hasCriteriaTail = (text) =>
    /\*\*Критерии приёмки:\*\*/.test(text) &&
    /\*\*Доступ агента:\*\*/.test(text) &&
    /\*\*Доступ пользователя:\*\*/.test(text);
  check(
    "DEEP-4.1: criteria-хвост D17 удалён (заметка и self_analysis сохранены)",
    d17.includes("self_analysis") &&
      !hasCriteriaTail(d17) &&
      !d17.includes("| ID | Подзадача | Шаги | Ожидаемый результат |"),
  );
  check(
    "DEEP-4.1: регрессия criteria-хвоста D17 детектируется",
    hasCriteriaTail(
      d17 +
        "\n**Критерии приёмки:** x\n**Доступ агента:** y\n**Доступ пользователя:** z\n" +
        "| ID | Подзадача | Шаги | Ожидаемый результат |",
    ),
  );
}

// DEEP-4.2–DEEP-4.4: протокол прогона матрицы D01–D18.
{
  const plan = fs.readFileSync(path.join(root, "TEST-PLAN.md"), "utf8");
  const marker = "### 8.1 Результаты прогона матрицы DEEP-4";
  const start = plan.indexOf(marker);
  const end = start >= 0 ? plan.indexOf("\n---", start) : -1;
  const log = start >= 0 && end > start ? plan.slice(start, end) : "";
  check("DEEP-4.x: §8.1 протокол прогона матрицы присутствует", log.length > 0);

  const expectedIds = Array.from({ length: 18 }, (_, i) => `D${String(i + 1).padStart(2, "0")}`);
  const parseRows = (text) => {
    const rows = new Map();
    for (const line of text.split("\n")) {
      const m = /^\|\s*(D\d{2})\s*\|(.+)\|$/.exec(line);
      if (m) rows.set(m[1], m[2].split(/(?<!\\)\|/).map((c) => c.trim()));
    }
    return rows;
  };
  const validShape = (text) => {
    const rows = parseRows(text);
    const ids = [...rows.keys()];
    if (!ids.length || new Set(ids).size !== ids.length) return false;
    if (ids.some((id) => !expectedIds.includes(id))) return false;
    if (ids.join(",") !== ids.slice().sort().join(",")) return false;
    return ids.every((id) => {
      const cells = rows.get(id);
      return (
        cells?.length === 3 &&
        cells.every((c) => c.length > 0) &&
        /`node test-[^`]+\.mjs`|`npm run [^`]+`/.test(cells[1]) &&
        /✅|⚠️|⏳/.test(cells[2])
      );
    });
  };
  check("DEEP-4.x: строки §8.1 уникальны, упорядочены и в пределах D01–D18", validShape(log));
  check(
    "DEEP-4.x: негативный тест — подмена команды прогона детектируется",
    !validShape(log.replace(/`node test-[^`]+\.mjs`|`npm run [^`]+`/g, "")),
  );
  check(
    "DEEP-4.5: все 18 деталей зафиксированы в протоколе прогона",
    parseRows(log).size === 18 && expectedIds.every((id) => parseRows(log).has(id)),
  );
  check(
    "DEEP-4.5: непрогоняных деталей (⏳) не осталось",
    ![...parseRows(log).values()].some((cells) => cells[2].includes("⏳")),
  );
  check(
    "DEEP-4.5: итог §8 переключён на принято с 18/18",
    /^\|\s*Итог\s*\|\s*✅[^\n]*18\/18/m.test(plan),
  );
}

// QA-FULL-01: декларация engines.node и CI должны совпадать с нижней границей
// @opentui/core (node >=26.4.0), иначе `npm ci --engine-strict` падает EBADENGINE.
{
  const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const ci = read(".github/workflows/ci.yml");
  const nightly = read(".github/workflows/nightly.yml");
  const release = read(".github/workflows/release.yml");
  const readme = read("README.md");
  const engine = pkg.engines?.node ?? "";
  const validEngine = (value) => value === ">=26.4.0";
  check("QA-FULL-01: engines.node совпадает с нижней границей @opentui/core", validEngine(engine));
  check(
    "QA-FULL-01: негативный тест — старая декларация >=22.22.0 детектируется",
    !validEngine(">=22.22.0"),
  );
  check(
    "QA-FULL-01: CI-матрица проверяет 26.4.0 и не держит устаревшие 22.22/24",
    /node:\s*\["26\.4\.0",\s*26\]/.test(ci) &&
      !ci.includes('"22.22.0"') &&
      !/node-version:\s*24\b/.test(ci),
  );
  check(
    "QA-FULL-01: smoke `npm ci --dry-run --engine-strict` есть в CI",
    /npm ci --dry-run --engine-strict --ignore-scripts/.test(ci),
  );
  check(
    "QA-FULL-01: nightly и release используют Node 26.4.0",
    !/node-version:\s*(?:22\.22\.0|24)\b/.test(nightly + "\n" + release) &&
      (nightly.match(/node-version:\s*26\.4\.0/g) ?? []).length >= 1 &&
      (release.match(/node-version:\s*26\.4\.0/g) ?? []).length >= 3,
  );
  check("QA-FULL-01: README декларирует Node.js 26.4+", /Node\.js 26\.4\+/.test(readme));
}

// QA-FULL-04: «Ближайшие две недели» должны отражать реально открытые QA,
// а не закрытые EV-1/EX-1/SC-1/LP-1/AD-1 и P-1/P-2.
{
  const strategy = fs.readFileSync(path.join(root, "ROADMAP-STRATEGY.md"), "utf8");
  const start = strategy.indexOf("## Ближайшие две недели");
  const end = start >= 0 ? strategy.indexOf("\n---", start) : -1;
  const block = start >= 0 && end > start ? strategy.slice(start, end) : "";
  const activeLegacy = (text) =>
    /^\s*\d+\.\s*(?:P-1|P-2|EV-1|EX-1|SC-1|LP-1|AD-1)\s*[—–-]/m.test(text) ||
    /остаётся открытым до FIX/i.test(text);
  check(
    "QA-FULL-04: блок пересобран под реально открытые QA",
    ["QA-DEEP4-1", "QA-FULL-04", "QA-FULL-06"].every((id) => block.includes(id)),
  );
  check("QA-FULL-04: закрытые P-1/P-2 и EV-1…AD-1 не активны", !activeLegacy(block));
  check(
    "QA-FULL-04: негативный тест — возврат активного P-1 детектируется",
    activeLegacy(block + "\n1. P-1 — закрыть изоляцию ядра\n"),
  );
  check(
    "QA-FULL-04: будущие ID помечены как future",
    /future, не в ближайшие две недели/i.test(block),
  );
  check(
    "QA-FULL-04: синхронизация strategy ↔ ROADMAP сохранена",
    /\[ROADMAP\.md\]\(\.\/ROADMAP\.md\)/.test(strategy),
  );
}

// QA-FULL-06: причина пропуска PL-121 видна в истории/MCP/дашборде.
{
  const readSrc = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
  const history = readSrc(path.join("src", "db", "history-repo.ts"));
  const facade = readSrc(path.join("src", "history.ts"));
  const index = readSrc("src/index.ts");
  const server = readSrc("src/server.ts");
  const safety = fs.readFileSync(path.join(root, "docs", "SAFETY.md"), "utf8");
  const hasSkipFilter = (text) => /skipReason/i.test(text);
  check(
    "QA-FULL-06: skipReason-фильтр есть в history-repo и facade",
    hasSkipFilter(history) && hasSkipFilter(facade) &&
      /status\s*===\s*["']skipped["']/.test(facade),
  );
  check(
    "QA-FULL-06: get_history schema/RPC принимают skipReason",
    hasSkipFilter(index) && /allowedHistoryKeys[\s\S]{0,240}skipReason/.test(index),
  );
  check(
    "QA-FULL-06: дашборд отдаёт и показывает skipReason",
    /skipReason/.test(server) && /history\?skipReason|searchParams\.get\(["']skipReason["']\)/.test(server),
  );
  check(
    "QA-FULL-06: SAFETY.md документирует skipReason и PL-121",
    /skipReason/.test(safety) && /PL-121/.test(safety),
  );
  check(
    "QA-FULL-06: негативный тест — потеря skipReason в SAFETY.md детектируется",
    !hasSkipFilter(safety.replace(/skipReason/g, "X")),
  );
}

// QA-CI-NODE26: тест саммари не должен звать process.exit() сразу после close().
{
  const summaryTest = fs.readFileSync(
    path.join(root, "test-notifications-summary.mjs"),
    "utf8",
  );
  const detectHardExit = (text) =>
    /process\.exit\(/.test(text) ||
    !/process\.exitCode\s*=/.test(text) ||
    !/closeAllConnections\?\.\(\)/.test(text);
  check(
    "QA-CI-NODE26: саммари использует exitCode и закрывает соединения",
    !detectHardExit(summaryTest),
  );
  check(
    "QA-CI-NODE26: негативный тест — возврат process.exit() детектируется",
    detectHardExit(summaryTest.replace("process.exitCode =", "process.exit(")),
  );
}

// ROADMAP: расшифровка стратегических ID и отсутствие устаревших ссылок.
{
  const roadmap = fs.readFileSync(path.join(root, "ROADMAP.md"), "utf8");
  const decoder = /### Что означают ID([\s\S]*?)\*\*Входы аудита/.exec(roadmap)?.[1] ?? "";
  const hasIds = (ids) => ids.every((id) => decoder.includes(`- **${id}**`));
  const hasStalePointer = (text) =>
    text.includes("QA-DEEP4-1 (ниже)") || text.includes("Ниже — только открытые находки");
  check(
    "ROADMAP: расшифрованы P-1…P-5",
    hasIds(["P-1", "P-2", "P-3", "P-4", "P-5"]),
  );
  check(
    "ROADMAP: расшифрованы S-1…S-6 и помечены реализованными",
    hasIds(["S-1", "S-2", "S-3", "S-4", "S-5", "S-6"]) &&
      (decoder.match(/✅ Реализовано/g) ?? []).length >= 6,
  );
  check(
    "ROADMAP: нет устаревших ссылок на закрытые находки",
    !hasStalePointer(roadmap),
  );
  check(
    "ROADMAP: негативный тест — возврат устаревшей ссылки детектируется",
    hasStalePointer(roadmap + "\nНиже — только открытые находки"),
  );
}

// ROADMAP: закрытые задачи не висят в роадмапе — архив удалён.
{
  const roadmapText = fs.readFileSync(path.join(root, "ROADMAP.md"), "utf8");
  const hasArchive = (text) =>
    text.includes("### Архив задач и подзадач") || /✅ по коду/.test(text);
  check("ROADMAP: архив закрытых задач удалён", !hasArchive(roadmapText));
  check(
    "ROADMAP: негатив — возврат архива детектируется",
    hasArchive(roadmapText + "\n### Архив задач и подзадач\n- **DEEP-1.1** … — ✅ по коду"),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDocs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
