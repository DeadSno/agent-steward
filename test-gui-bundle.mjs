/**
 * Тест GUI-бандла в условиях renderer (регресс на падение панели «Планировщик»).
 *
 * Контекст бага: в бандле выполнялся `process.env.OPENCODE_SCHEDULER_LOCALE`
 * (src/i18n.ts), а в renderer OpenCode глобального `process` нет. Загрузка
 * модуля падала с `ReferenceError: process is not defined`, и панель
 * `scheduler-jobs` не регистрировалась — раздел «Планировщик» просто исчезал
 * из GUI без каких-либо тостов.
 *
 * Тест грузит собранный `gui-experimental.cjs` в `vm`-контексте без `process`,
 * с заглушками host-модулей, и проверяет, что:
 *   1) бандл вообще исполняется (нет обращений к node-глобалам на загрузке);
 *   2) в коде нет `process.env/platform/argv/cwd`;
 *   3) default-export умеет `setup()`;
 *   4) `setup()` регистрирует панель `scheduler-jobs`.
 *
 * Бандл — артефакт сборки (`npm run build:gui`) и лежит в .gitignore, поэтому
 * при его отсутствии тест печатает SKIP и завершается успешно.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(root, "gui-experimental.cjs"),
  path.join(root, "dist", "gui-experimental.cjs"),
];
const bundlePath = candidates.find((file) => fs.existsSync(file));

let passed = 0;
let failed = 0;

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` - ${details}` : ""}`);
  }
}

// BN-8: инкрементальная сборка и кэш артефактов.
const tsconfig = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
const viteConfig = fs.readFileSync(path.join(root, "vite.config.ts"), "utf8");
const ciWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
check(
  "BN-8: tsc использует инкрементальный tsbuildinfo",
  /"incremental"\s*:\s*true/.test(tsconfig) && tsconfig.includes("tsBuildInfoFile")
);
check(
  "BN-8: Vite использует постоянный cacheDir",
  /cacheDir\s*:\s*["']node_modules\/\.cache\/vite["']/.test(viteConfig)
);
check(
  "BN-8: CI восстанавливает кэш сборки между прогонами",
  ciWorkflow.includes("actions/cache@") && ciWorkflow.includes("node_modules/.cache")
);

// D16 (IM-15): отладочная сборка и флаг --debug.
const pkgForDebug = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cliSrc = fs.readFileSync(path.join(root, "src", "cli.ts"), "utf8");
const debugSrc = fs.readFileSync(path.join(root, "src", "shared", "debug.ts"), "utf8");
check(
  "D16: build:debug собирает отдельный бандл с source map",
  typeof pkgForDebug.scripts["build:debug"] === "string" &&
    pkgForDebug.scripts["build:debug"].includes("--mode debug") &&
    viteConfig.includes("gui-experimental.debug.cjs") &&
    viteConfig.includes("sourcemap")
);
check(
  "D16: CLI принимает --debug, секреты редактируются",
  cliSrc.includes("parseDebugArgs(rawArgv)") &&
    cliSrc.includes("setDebugEnabled(true)") &&
    debugSrc.includes('arg === "--debug"') &&
    debugSrc.includes("<redacted>") &&
    debugSrc.includes('typeof process !== "undefined"')
);

const debugDistPath = path.join(root, "dist", "shared", "debug.js");
if (fs.existsSync(debugDistPath)) {
  const { DEBUG_ENV, redactDebug, parseDebugArgs, isDebugEnabled, setDebugEnabled } = await import(
    "./dist/shared/debug.js"
  );
  const redacted = redactDebug({ apiKey: "k-123", password: "p-456", task: "build", note: "Bearer TOKENVALUE" });
  check(
    "D16: redactDebug скрывает ключи и Bearer",
    DEBUG_ENV === "AGENT_STEWARD_DEBUG" &&
      redacted.includes("<redacted>") &&
      redacted.includes("build") &&
      !redacted.includes("k-123") &&
      !redacted.includes("p-456") &&
      !redacted.includes("TOKENVALUE"),
    redacted
  );
  const parsedDebug = parseDebugArgs(["--debug", "pipeline", "validate", "spec.yaml", "--json"]);
  check(
    "D16: --debug убирается из argv других команд",
    parsedDebug.debug === true && !parsedDebug.args.includes("--debug") && parsedDebug.args.length === 4,
    JSON.stringify(parsedDebug)
  );
  setDebugEnabled(false);
  const wasEnabled = isDebugEnabled();
  setDebugEnabled(true);
  const nowEnabled = isDebugEnabled();
  setDebugEnabled(false);
  check("D16: режим логов управляется флагом", wasEnabled === false && nowEnabled === true);
} else {
  console.log("SKIP debug module not built (run: npm run build)");
}

if (!bundlePath) {
  console.log("SKIP gui bundle not built (run: npm run build:gui)");
  console.log("\n0 passed, 0 failed");
  process.exit(0);
}

const code = fs.readFileSync(bundlePath, "utf8");
console.log(`bundle: ${path.relative(root, bundlePath)} (${code.length} bytes)`);

/** Мини-заглушка solid-js: сигналы и компоненты-пустышки. */
const signal = (value) => [() => value, (next) => (value = next)];
const solid = new Proxy(
  {
    createSignal: signal,
    createMemo: (fn) => fn,
    createEffect: () => {},
    createRoot: (fn) => fn(() => {}),
    untrack: (fn) => fn(),
    batch: (fn) => fn(),
    onMount: () => {},
    onCleanup: () => {},
    createContext: () => ({}),
    useContext: () => ({}),
    mergeProps: (...args) => Object.assign({}, ...args),
    splitProps: (props) => [props, props],
    For: () => null,
    Show: () => null,
    Index: () => null,
    Suspense: () => null,
    ErrorBoundary: () => null,
  },
  { get: (target, key) => (key in target ? target[key] : () => null) }
);

const solidWeb = new Proxy(
  {
    template: () => () => null,
    insert: () => {},
    setAttribute: () => {},
    effect: () => {},
    delegateEvents: () => {},
    render: () => {},
    createComponent: () => null,
    memo: (fn) => fn,
  },
  { get: (target, key) => (key in target ? target[key] : () => null) }
);

/** Любой вызов/свойство RPC-заглушки — тихий Proxy. */
const anyFn = () =>
  new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anyFn()),
    apply: () => anyFn(),
    construct: () => anyFn(),
  });

const rpcStub = anyFn();

const pathStub = {
  resolve: (...parts) => parts.join("/"),
  join: (...parts) => parts.join("/"),
  dirname: (value) => String(value).replace(/[\\/][^\\/]*$/, ""),
  sep: "/",
};

const fsStub = {
  statSync: () => {
    throw new Error("ENOENT: renderer has no fs");
  },
  readFileSync: () => {
    throw new Error("ENOENT: renderer has no fs");
  },
};

const urlStub = { fileURLToPath: (value) => String(value).replace(/^file:\/\//, "") };

function fakeRequire(request) {
  if (request === "solid-js") return solid;
  if (request === "solid-js/web") return solidWeb;
  if (request === "@opencode/plugin/gui") {
    return { Plugin: { define: (def) => def }, Panel: "Panel" };
  }
  if (request === "@opencode/plugin/rpc") return rpcStub;
  if (request === "@opencode/plugin") return { Plugin: { define: (def) => def }, Rpc: rpcStub };
  if (request === "node:path" || request === "path") return pathStub;
  if (request === "node:fs" || request === "fs") return fsStub;
  if (request === "node:url" || request === "url") return urlStub;
  throw new Error(`unexpected require in renderer: ${request}`);
}

const sandbox = {
  console,
  URL,
  URLSearchParams,
  document: {
    baseURI: "http://localhost/plugin/gui-experimental.cjs",
    currentScript: null,
    querySelector: () => null,
  },
  require: fakeRequire,
  // Renderer даёт таймеры; в vm-контексте их нужно объявить руками.
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  queueMicrotask: (fn) => fn(),
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.module = { exports: {} };
sandbox.exports = sandbox.module.exports;

// Ключевая часть воспроизведения: в контексте НЕТ `process`.
const context = vm.createContext(sandbox);

let evalError = null;
try {
  vm.runInContext(code, context, { filename: bundlePath });
} catch (error) {
  evalError = error;
}

check(
  "бандл исполняется в renderer без process",
  evalError === null,
  evalError instanceof Error ? `${evalError.name}: ${evalError.message}` : String(evalError)
);

// Статическая страховка: обращения к process допустимы только под guard'ом
// `typeof process !== "undefined"` (см. envLocale() в src/i18n.ts). Иначе
// renderer упадёт на этапе загрузки бандла.
const processRefs = [...code.matchAll(/process\.(env|platform|argv|cwd)\b/g)].map(
  (match) => match.index ?? 0
);
const unguarded = processRefs.filter((index) => {
  const before = code.slice(Math.max(0, index - 80), index);
  return !/typeof process\s*[!=]==?\s*["']undefined["']|typeof process<"u"/.test(before);
});
check(
  "обращения к process только под typeof-guard",
  unguarded.length === 0,
  unguarded.length > 0 ? `без guard: ${unguarded.length} (позиции ${unguarded.join(", ")})` : ""
);

const mod = sandbox.module.exports;
const plugin = mod && (mod.default ?? mod);
check("default-export содержит setup()", Boolean(plugin && typeof plugin.setup === "function"));

const registered = [];
const ctx = {
  client: { rpc: () => new Proxy({}, { get: () => async () => ({}) }) },
  toast: { show: () => {} },
  add: (_component, props) => {
    registered.push(props);
    return props;
  },
};

let setupError = null;
try {
  if (plugin && typeof plugin.setup === "function") plugin.setup(ctx);
} catch (error) {
  setupError = error;
}

check(
  "setup() не бросает",
  setupError === null,
  setupError instanceof Error ? `${setupError.name}: ${setupError.message}` : String(setupError)
);

const ids = registered.map((props) => props && props.id);
check(
  "панель scheduler-jobs зарегистрирована",
  ids.includes("scheduler-jobs"),
  `зарегистрировано: ${JSON.stringify(ids)}`
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
