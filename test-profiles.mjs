/**
 * Тесты Спринта 21: профили (мультипроектность).
 * Запуск: node test-profiles.mjs (после npm run build).
 * Планировщик ОС и OpenCode не нужны — только файловая система во временной папке.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Временный конфиг-домен — ДО динамического импорта dist, чтобы PLUGIN_DIR
// вычислился уже с подменённым OPENCODE_SCHEDULER_HOME.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-profiles-"));
const base = path.join(tempRoot, "opencode", "windows-scheduler");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = base;
delete process.env.OPENCODE_SCHEDULER_PROFILE;
delete process.env.OPENCODE_SCHEDULER_PORT;

const profiles = await import("./dist/profiles.js");
const types = await import("./dist/types.js");

const {
  DEFAULT_PROFILE,
  createProfile,
  deleteProfile,
  getBasePluginDir,
  getProfileDir,
  getProfileName,
  getProfilePort,
  isProfilePinnedByEnv,
  listProfiles,
  readProfileMeta,
  sanitizeProfileName,
  setActiveProfile,
  validateProfileName,
} = profiles;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- 1. Базовая директория и профиль по умолчанию -------------------------
check("getBasePluginDir: OPENCODE_SCHEDULER_HOME имеет приоритет", getBasePluginDir() === base);
check("getProfileName: без env и маркера — default", getProfileName() === DEFAULT_PROFILE);
check("getProfileDir: default — базовая директория", getProfileDir() === base);
check(
  "getProfileDir: именованный профиль — <base>/profiles/<name>",
  getProfileDir("work") === path.join(base, "profiles", "work")
);
check("PLUGIN_DIR: указывает на базовую директорию default", types.PLUGIN_DIR === base);
check("LOCK_DIR: внутри каталога профиля", types.LOCK_DIR === path.join(base, "locks"));
check("LOG_DIR: внутри каталога профиля", types.LOG_DIR === path.join(base, "logs"));
check("WRAPPER_DIR: внутри каталога профиля", types.WRAPPER_DIR === path.join(base, "wrappers"));

// --- 2. Нормализация и валидация имён -------------------------------------
check("sanitizeProfileName: пробелы и заглавные → kebab-case", sanitizeProfileName("Work Profile") === "work-profile");
check("sanitizeProfileName: спецсимволы вырезаются", sanitizeProfileName("Work!!!2026") === "work-2026");
check("sanitizeProfileName: пустое имя → default", sanitizeProfileName("   ") === DEFAULT_PROFILE);
check("sanitizeProfileName: обрезает до 40 символов", sanitizeProfileName("a".repeat(60)).length === 40);
check("validateProfileName: 'work' валидно", validateProfileName("work") === null);
check("validateProfileName: 'work-2_x' валидно", validateProfileName("work-2_x") === null);
check("validateProfileName: пустое — ошибка", validateProfileName("") !== null);
check("validateProfileName: начинается с цифры — ошибка", validateProfileName("2work") !== null);
check("validateProfileName: пробел внутри — ошибка", validateProfileName("bad name") !== null);
check("validateProfileName: кириллица — ошибка", validateProfileName("работа") !== null);

// --- 3. Создание, список, порты ------------------------------------------
const work = createProfile("work");
check("createProfile: профиль work создан", work.name === "work");
check("createProfile: первому профилю достаётся 3783, а не порт default", work.port === 3783);
check("createProfile: порт default (3782) не выдан", work.port !== 3782);
check("createProfile: запасной порт default (4782) не выдан", work.port !== 4782);
check("createProfile: директория профиля существует", fs.existsSync(path.join(base, "profiles", "work")));
check(
  "createProfile: profile.json записан",
  fs.existsSync(path.join(base, "profiles", "work", "profile.json"))
);

const second = createProfile("second");
check("createProfile: второму профилю достаётся свободный порт", second.port === 3784);
check("readProfileMeta: читает имя и порт", readProfileMeta("work")?.port === 3783);

// B4.2: занятый другим профилем порт пропускается, даже если он дальше по диапазону.
const pinned = createProfile("pinned", 3786);
check("createProfile: явный порт сохраняется", pinned.port === 3786);
const third = createProfile("third");
check("allocateProfilePort: порт, занятый другим профилем, пропускается", third.port === 3785);

// B4.2: OPENCODE_SCHEDULER_PORT тоже резервируется.
process.env.OPENCODE_SCHEDULER_PORT = "3787";
const fourth = createProfile("fourth");
check("allocateProfilePort: порт из OPENCODE_SCHEDULER_PORT пропускается", fourth.port === 3788);
delete process.env.OPENCODE_SCHEDULER_PORT;

check("readProfileMeta: неизвестный профиль → null", readProfileMeta("nope") === null);

const all = listProfiles();
check("listProfiles: default всегда в списке", all.some((p) => p.name === "default" && p.isDefault));
check("listProfiles: созданные профили видны", all.some((p) => p.name === "work") && all.some((p) => p.name === "second"));
check("listProfiles: default первый", all[0]?.name === "default");
check("listProfiles: default активен по умолчанию", all.find((p) => p.name === "default")?.active === true);
check("listProfiles: work не активен", all.find((p) => p.name === "work")?.active === false);
check("listProfiles: порт work из profile.json", all.find((p) => p.name === "work")?.port === 3783);

check("getProfilePort: порт из profile.json", getProfilePort("work") === 3783);
process.env.OPENCODE_SCHEDULER_PORT = "5555";
check("getProfilePort: OPENCODE_SCHEDULER_PORT важнее profile.json", getProfilePort("work") === 5555);
delete process.env.OPENCODE_SCHEDULER_PORT;
check("getProfilePort: default без profile.json → null", getProfilePort("default") === null);

// --- 4. Переключение активного профиля -----------------------------------
check("isProfilePinnedByEnv: env не задан", isProfilePinnedByEnv() === false);
setActiveProfile("work");
check("setActiveProfile: маркер переключил getProfileName", getProfileName() === "work");
check("setActiveProfile: getProfileDir следует за профилем", getProfileDir() === path.join(base, "profiles", "work"));
check("setActiveProfile: PLUGIN_DIR не меняется на лету", types.PLUGIN_DIR === base);
check(
  "setActiveProfile: маркер active-profile записан",
  fs.readFileSync(path.join(base, "active-profile"), "utf8").trim() === "work"
);
check("setActiveProfile: listProfiles отмечает активный", listProfiles().find((p) => p.name === "work")?.active === true);
check("setActiveProfile: несуществующий профиль — ошибка", throws(() => setActiveProfile("missing")));

process.env.OPENCODE_SCHEDULER_PROFILE = "env-profile";
check("getProfileName: env важнее маркера", getProfileName() === "env-profile");
check("isProfilePinnedByEnv: env задан", isProfilePinnedByEnv() === true);
check("getProfileDir: профиль из env", getProfileDir() === path.join(base, "profiles", "env-profile"));
delete process.env.OPENCODE_SCHEDULER_PROFILE;
check("getProfileName: после снятия env снова маркер", getProfileName() === "work");

// --- 5. Изоляция БД и настроек (отдельный процесс, import-time) ----------
const probeScript = `
  const db = await import("./dist/db/index.js");
  const settings = await import("./dist/settings.js");
  const types = await import("./dist/types.js");
  console.log(JSON.stringify({
    pluginDir: types.PLUGIN_DIR,
    dbFile: db.getDbFile(),
    settingsFile: settings.SETTINGS_FILE,
  }));
`;
function probe(profile) {
  const env = { ...process.env, OPENCODE_SCHEDULER_HOME: base };
  if (profile) env.OPENCODE_SCHEDULER_PROFILE = profile;
  else delete env.OPENCODE_SCHEDULER_PROFILE;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`probe failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

// Маркер мог остаться на work — для проверки default возвращаем его явно.
setActiveProfile(DEFAULT_PROFILE);
const defaultProbe = probe(null);
check("изоляция: default PLUGIN_DIR = база", defaultProbe.pluginDir === base);
check("изоляция: default БД в базе", defaultProbe.dbFile === path.join(base, "scheduler.db"));
check("изоляция: default settings.json в базе", defaultProbe.settingsFile === path.join(base, "settings.json"));

const workProbe = probe("work");
const workDir = path.join(base, "profiles", "work");
check("изоляция: work PLUGIN_DIR = profiles/work", workProbe.pluginDir === workDir);
check("изоляция: work БД отдельная", workProbe.dbFile === path.join(workDir, "scheduler.db"));
check("изоляция: work settings.json отдельный", workProbe.settingsFile === path.join(workDir, "settings.json"));

// --- 6. Удаление профилей ------------------------------------------------
{
  let defaultThrew = false;
  try {
    await deleteProfile("default");
  } catch {
    defaultThrew = true;
  }
  check("deleteProfile: default удалить нельзя", defaultThrew);
}
check("deleteProfile: work удалён", (await deleteProfile("work")) === true);
check("deleteProfile: директория work исчезла", !fs.existsSync(workDir));
check("deleteProfile: маркер вернулся на default", getProfileName() === DEFAULT_PROFILE);
check("deleteProfile: повторное удаление → false", (await deleteProfile("work")) === false);
check("deleteProfile: second удалён", (await deleteProfile("second")) === true);
check("deleteProfile: pinned удалён", (await deleteProfile("pinned")) === true);
check("deleteProfile: third удалён", (await deleteProfile("third")) === true);
check("deleteProfile: fourth удалён", (await deleteProfile("fourth")) === true);
check("listProfiles: остался только default", listProfiles().length === 1 && listProfiles()[0].name === "default");

// --- 7. B-3.1: контракт manage_* и диета описаний admin-профиля -----------
const crypto = await import("node:crypto");
const { z } = await import("zod");
const { createHash } = crypto;
const { measureToolSurface } = await import("./dist/core/usage-surface.js");
const { createToolSpecs } = await import("./dist/index.js");
const { encode } = await import("gpt-tokenizer");
const countTokens = (text) => encode(text).length;
const digestSpecs = (specs) =>
  createHash("sha256")
    .update(specs.map((s) => `${s.name}\u0000${s.description}`).join("\u0001"), "utf8")
    .digest("hex");

// Замерено до правки B-3.1: measureToolSurface + gpt-tokenizer, профиль admin.
const B31_BASELINE = {
  adminTokens: 13671,
  manageTokens: 3809,
  manageChars: 2859,
  coreDigest: "3a894fba335254925dbddd61b0992c6fab016be68dd094dcd2943c5e15f1369b",
};
const MANAGE_NAMES = [
  "manage_workspaces",
  "manage_settings",
  "manage_local_ai",
  "manage_templates",
  "manage_profiles",
  "manage_secrets",
];
// PL-70: имена, обязательные параметры и набор полей — неизменны.
const MANAGE_SCHEMA_GOLDEN = {
  manage_workspaces: ["action", "id", "name", "path", "color", "env", "envFile"],
  manage_settings: ["action", "maxConcurrent", "locale", "winterMode", "notifications", "history", "integrations", "audit", "permissions", "budgets", "feedback"],
  manage_local_ai: ["action", "mode", "baseUrl", "model", "timeoutMs", "fallback", "confidenceThreshold", "shadow"],
  manage_templates: ["action", "id", "name", "prompt", "schedule", "timeoutSeconds", "model", "priority", "retryCount", "retryDelay", "qualityGate", "beforeScript", "afterScript", "nextTaskOnSuccess", "nextTaskOnError", "dependsOn", "triggerType", "mcpEvent", "watchPath", "workingDirectory", "allowedTools", "deniedTools"],
  manage_profiles: ["action", "name", "port"],
  manage_secrets: ["action", "name", "value"],
};

const adminSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "admin" });
const coreSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "core" });
const allSpecs = createToolSpecs({}, { AGENT_STEWARD_TOOL_PROFILE: "all" });
const manageSpecs = adminSpecs.filter((s) => s.name.startsWith("manage_"));
const manageSurface = measureToolSurface(manageSpecs, { countTokens });
const adminSurface = measureToolSurface(adminSpecs, { countTokens });
const manageChars = manageSpecs.reduce((sum, s) => sum + (s.description?.length ?? 0), 0);

check(
  "B-3.1: PL-70 — набор имён manage_* сохранён",
  JSON.stringify(manageSpecs.map((s) => s.name)) === JSON.stringify(MANAGE_NAMES)
);
check(
  "B-3.1: PL-70 — обязательные параметры и поля manage_* сохранены",
  manageSpecs.every((spec) => {
    const schema = z.toJSONSchema(spec.input);
    const required = schema.required ?? [];
    return (
      required.length === 1 &&
      required[0] === "action" &&
      JSON.stringify(Object.keys(schema.properties ?? {})) ===
        JSON.stringify(MANAGE_SCHEMA_GOLDEN[spec.name])
    );
  })
);
check(
  "B-3.1: PL-70 — в описаниях остались действия и read-действие",
  manageSpecs.every((s) =>
    /Actions:/.test(s.description) &&
    (/list \(read/.test(s.description) || /get \(read/.test(s.description)) &&
    /never guess get/.test(s.description)
  )
);
check(
  `B-3.1: описания manage_* короче базовых ${B31_BASELINE.manageChars} символов (факт: ${manageChars})`,
  manageChars < B31_BASELINE.manageChars
);
check(
  `B-3.1: описания manage_* короче базовых ${B31_BASELINE.manageTokens} токенов (факт: ${manageSurface.estimatedTokens})`,
  manageSurface.estimatedTokens < B31_BASELINE.manageTokens
);
check(
  `B-3.1: поверхность admin короче базовых ${B31_BASELINE.adminTokens} токенов (факт: ${adminSurface.estimatedTokens})`,
  adminSurface.estimatedTokens < B31_BASELINE.adminTokens
);
check(
  "B-3.1: остальные профили не_changed — core описания/имена побайтово прежние",
  coreSpecs.length === 8 && digestSpecs(coreSpecs) === B31_BASELINE.coreDigest
);
check(
  "B-3.1: остальные профили не_changed — состав admin/all прежний",
  adminSpecs.length === 16 &&
    allSpecs.length === 32 &&
    MANAGE_NAMES.every((name) =>
      adminSpecs.some((s) => s.name === name) && allSpecs.some((s) => s.name === name)
    )
);

// --- Итог ----------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nProfiles: ${results.length - failures.length}/${results.length} проверок успешно.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
