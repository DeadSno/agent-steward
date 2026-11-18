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
    /setup: async \(ctx\) => \{\s*const runtime = await createRuntime\(ctx\);/.test(indexSrc)
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
  "CI: пин 22.22.0 совпадает с минимумом из engines",
  pkg.engines?.node === ">=22.22.0" && ciSrc.includes('"22.22.0"')
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

const failed = results.filter((r) => !r.ok);
console.log(`\nDocs: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
