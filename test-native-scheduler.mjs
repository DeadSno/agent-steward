/**
 * AD-1.1: режим nativeScheduler, capability хоста и fallback на polling.
 * Запуск: node test-native-scheduler.mjs (после npm run build).
 *
 * Проверяем и привязку к ОС (platform попадает в контракт хоста), и работу без
 * привязки — режим от ОС не зависит, меняется только имя планировщика.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Изолируем каталог плагина ДО загрузки dist: PLUGIN_DIR вычисляется на импорте.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ad1-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
const native = await import("./dist/core/native-scheduler.js");
const scheduler = await import("./dist/core/scheduler/index.js");
const { loadSettings, saveSettings } = await import("./dist/settings.js");
const {
  NATIVE_SCHEDULER_INVARIANTS,
  NativeSchedulerUnavailableError,
  assertNativeSchedulerHost,
  detectNativeSchedulerHost,
  nativeSchedulerContract,
  normalizeNativeSchedulerSettings,
  resolveSchedulerMode,
} = native;
const {
  NativeSchedulerBackend,
  configureSchedulerMode,
  getSchedulerBackend,
  getSchedulerMode,
  getSchedulerTitle,
  registerNativeSchedulerFactory,
} = scheduler;

const root = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
const check = (name, fn) => {
  try {
    fn();
    checks++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    checks++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    process.exitCode = 1;
  }
};

const HOST_ENV = "OPENCODE_NATIVE_SCHEDULER";
const envWith = (extra = {}) => ({ ...process.env, [HOST_ENV]: undefined, ...extra });

check("AD-1.1: инварианты фиксируют ledger/DLQ/бюджет/approval/execution-loop", () => {
  assert.deepEqual([...NATIVE_SCHEDULER_INVARIANTS], [
    "ledger",
    "dlq",
    "budgets",
    "approval",
    "execution-loop",
  ]);
});

check("AD-1.1: нормализация настроек режима fail-safe", () => {
  assert.deepEqual(normalizeNativeSchedulerSettings(undefined), {
    mode: "auto",
    host: "",
  });
  assert.deepEqual(normalizeNativeSchedulerSettings({ mode: "unknown", host: "  probe  " }), {
    mode: "auto",
    host: "probe",
  });
  assert.deepEqual(normalizeNativeSchedulerSettings({ mode: "native", host: "" }), {
    mode: "native",
    host: "",
  });
});

check("AD-1.1: без capability хоста режим не включается", () => {
  assert.equal(detectNativeSchedulerHost(envWith()), null);
  assert.equal(detectNativeSchedulerHost(envWith({ [HOST_ENV]: "0" })), null);
  assert.equal(resolveSchedulerMode(undefined, envWith()), "polling");
});

for (const platform of ["win32", "linux", "darwin"]) {
  check(`AD-1.1: хост обнаружен с привязкой к ОС ${platform}`, () => {
    const host = detectNativeSchedulerHost(
      envWith({ [HOST_ENV]: "1", OPENCODE_NATIVE_SCHEDULER_HOST: "probe-host" }),
      platform,
    );
    assert.ok(host);
    assert.equal(host.name, "probe-host");
    assert.equal(host.platform, platform);
    assert.equal(host.version, "1.0");
    assert.deepEqual([...host.capabilities], [...NATIVE_SCHEDULER_INVARIANTS]);
    // Режим платформо-независим: тот же результат без явной ОС.
    assert.equal(
      resolveSchedulerMode({ mode: "auto" }, envWith({ [HOST_ENV]: "true" }), platform),
      "native",
    );
  });
}

check("AD-1.1: CAPS не могут сузить обязательные инварианты", () => {
  assert.equal(
    detectNativeSchedulerHost(
      envWith({ [HOST_ENV]: "1", OPENCODE_NATIVE_SCHEDULER_CAPS: "ledger,dlq" }),
      "linux",
    ),
    null,
  );
  const host = detectNativeSchedulerHost(
    envWith({
      [HOST_ENV]: "1",
      OPENCODE_NATIVE_SCHEDULER_CAPS: "ledger,dlq,budgets,approval,execution-loop,custom",
    }),
    "win32",
  );
  assert.ok(host?.capabilities.includes("custom"));
});

check("AD-1.1: явный выбор режима побеждает capability хоста", () => {
  const hostEnv = envWith({ [HOST_ENV]: "1" });
  assert.equal(resolveSchedulerMode({ mode: "polling" }, hostEnv), "polling");
  assert.equal(resolveSchedulerMode({ mode: "native" }, envWith()), "native");
  assert.equal(resolveSchedulerMode({ mode: "auto" }, hostEnv), "native");
});

check("AD-1.1: native без хоста блокируется fail-closed", () => {
  assert.throws(() => assertNativeSchedulerHost(null, "native"), NativeSchedulerUnavailableError);
  assert.throws(
    () => assertNativeSchedulerHost(null, "polling"),
    NativeSchedulerUnavailableError,
  );
});

check("AD-1.1: контракт нативного режима сохраняет все инварианты", () => {
  const host = detectNativeSchedulerHost(envWith({ [HOST_ENV]: "1" }), "linux");
  assert.equal(nativeSchedulerContract(host).mode, "native");
  assert.equal(nativeSchedulerContract(host).platform, "linux");
  assert.deepEqual([...nativeSchedulerContract(host).preserved], [...NATIVE_SCHEDULER_INVARIANTS]);
  assert.equal(nativeSchedulerContract(null).mode, "polling");
});

class FakeRegistry {
  entries = [];
  async load() {
    return this.entries.map((entry) => ({ ...entry }));
  }
  async upsert(entry) {
    this.entries = this.entries.filter((item) => item.name !== entry.name);
    this.entries.push({ ...entry });
  }
  async remove(name) {
    this.entries = this.entries.filter((item) => item.name !== name);
  }
  async setPaused(name, paused) {
    const entry = this.entries.find((item) => item.name === name);
    if (entry) entry.paused = paused;
  }
}

await checkAsync("AD-1.1: native-бэкенд регистрирует и запускает через общий колбэк", async () => {
  const registry = new FakeRegistry();
  const calls = [];
  const backend = new NativeSchedulerBackend({
    host: {
      name: "probe-host",
      version: "1.0",
      platform: "linux",
      capabilities: NATIVE_SCHEDULER_INVARIANTS,
    },
    registry,
    trigger: async (name) => {
      calls.push(name);
      return { alreadyRunning: false };
    },
    platform: "linux",
  });
  assert.equal(backend.platform, "linux");
  assert.equal(backend.title, "native-scheduler");
  await backend.createTask({ name: "probe", schedule: "0 9 * * *", command: "cmd", model: "m" });
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].triggerType, "cron");
  const listed = await backend.listTasks();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].taskName, "probe");
  assert.equal(listed[0].comment, "native:probe-host");
  assert.equal(listed[0].paused, false);
  await backend.pauseTask("probe");
  assert.equal((await backend.listTasks())[0].paused, true);
  await backend.resumeTask("probe");
  assert.equal((await backend.listTasks())[0].paused, false);
  assert.deepEqual(await backend.runTask("probe"), { alreadyRunning: false });
  assert.deepEqual(calls, ["probe"]);
  await backend.deleteTask("probe");
  assert.equal((await backend.listTasks()).length, 0);
  await assert.rejects(() => backend.runTask("probe"), /не зарегистрирована/);
});

check("AD-1.1: конфигурация режима переключает бэкенд и заголовок", () => {
  assert.equal(configureSchedulerMode({ mode: "polling" }, envWith({ [HOST_ENV]: "1" })), "polling");
  assert.equal(getSchedulerMode(), "polling");
  assert.notEqual(getSchedulerTitle("win32"), "native-scheduler");

  const registry = new FakeRegistry();
  registerNativeSchedulerFactory(
    (host) =>
      new NativeSchedulerBackend({
        host,
        registry,
        trigger: async () => ({ alreadyRunning: false }),
      }),
  );
  assert.equal(configureSchedulerMode({ mode: "native" }, envWith({ [HOST_ENV]: "1" })), "native");
  assert.equal(getSchedulerMode(), "native");
  assert.equal(getSchedulerTitle("win32"), "native-scheduler");
  assert.equal(getSchedulerBackend().title, "native-scheduler");

  // Возврат в polling — исходное состояние процесса.
  configureSchedulerMode({ mode: "polling" }, envWith());
  assert.equal(getSchedulerBackend().title !== "native-scheduler", true);
});

// Интеграция с settings.json: поле появилось в дефолтах и сохраняется частично.
await checkAsync("AD-1.1: nativeScheduler живёт в settings.json", async () => {
  const initial = await loadSettings();
  assert.deepEqual(initial.nativeScheduler, { mode: "auto", host: "" });
  const saved = await saveSettings({ nativeScheduler: { mode: "native", host: "probe" } });
  assert.deepEqual(saved.nativeScheduler, { mode: "native", host: "probe" });
  const reloaded = await loadSettings();
  assert.deepEqual(reloaded.nativeScheduler, { mode: "native", host: "probe" });
  assert.equal(
    resolveSchedulerMode(reloaded.nativeScheduler, envWith({ [HOST_ENV]: "1" })),
    "native",
  );
});

console.log(`AD-1.1 checks: ${checks}`);
