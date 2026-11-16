/**
 * Тесты Спринта 26: зашифрованное хранилище секретов.
 * Запуск: node test-secrets.mjs (после npm run build).
 * Реальные секреты не записываются: конфиг-домен подменяется temp-директорией.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-secrets-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const secrets = await import("./dist/core/secrets.js");

const {
  setSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  listSecrets,
  collectSecretNames,
  expandSecretRefs,
  resolveSecretRefs,
  redactSecretsInText,
  SECRET_REF_RE,
  resetSecretsCache,
} = secrets;

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const SECRET_NAME = "test_bot_token";
const SECRET_VALUE = "123456:ABCdefGhIJKlmNopQRSTUVWX";

// --- 1. set/get/delete -------------------------------------------------------
resetSecretsCache();
const item = setSecret(SECRET_NAME, SECRET_VALUE);
check("setSecret возвращает элемент с именем и превью", item.name === SECRET_NAME && item.preview === "••••UVWX" && item.updatedAt);
check("getSecret возвращает значение", getSecret(SECRET_NAME) === SECRET_VALUE);
check("hasSecret true после set", hasSecret(SECRET_NAME) === true);
check("hasSecret false для несуществующего", hasSecret("nonexistent") === false);
check("listSecrets содержит секрет", listSecrets().some((s) => s.name === SECRET_NAME && s.preview === "••••UVWX"));

const deleted = deleteSecret(SECRET_NAME);
check("deleteSecret возвращает true", deleted === true);
check("getSecret undefined после удаления", getSecret(SECRET_NAME) === undefined);
check("hasSecret false после удаления", hasSecret(SECRET_NAME) === false);
check("listSecrets пуст после удаления", listSecrets().length === 0);

// Имя секрета с точками и подчёркиваниями.
const dotted = "my.bot_token-v2";
setSecret(dotted, "supersecret123");
check("getSecret с точкой и дефисом", getSecret(dotted) === "supersecret123");
deleteSecret(dotted);

// --- 2. ${secret:NAME} refs expansion ---------------------------------------
setSecret("api_key", "sk-1234567890abcdef");
const expanded = expandSecretRefs("ключ=${secret:api_key} и конец");
check("expandSecretRefs подставляет значение", expanded.value === "ключ=sk-1234567890abcdef и конец");
check("expandSecretRefs не оставляет пропусков", expanded.missing.length === 0);

const embedded = expandSecretRefs("pref ${secret:api_key} suff");
check("expandSecretRefs встроенная ссылка", embedded.value === "pref sk-1234567890abcdef suff");

// Отсутствующий секрет → ссылка остаётся + имя в missing.
const missing = expandSecretRefs("${secret:missing_key} и ${secret:api_key}");
check(
  "expandSecretRefs отсутствующий → ссылка сохраняется",
  missing.value === "${secret:missing_key} и sk-1234567890abcdef"
);
check("expandSecretRefs missing содержит имя", missing.missing.includes("missing_key"));
check("expandSecretRefs missing не содержит найденный", !missing.missing.includes("api_key"));

// SECRET_REF_RE находит ссылки.
check("SECRET_REF_RE находит ссылку", SECRET_REF_RE.test("${secret:foo}"));

// --- 3. resolveSecretRefs на env-объекте -------------------------------------
resetSecretsCache();
setSecret("db_pass", "P@ssw0rd!");
const envRes = resolveSecretRefs({ DB_URL: "postgres://user:${secret:db_pass}@host", PLAIN: "visible" });
check("resolveSecretRefs расшифровывает env", envRes.env.DB_URL === "postgres://user:P@ssw0rd!@host");
check("resolveSecretRefs оставляет обычное значение", envRes.env.PLAIN === "visible");
check("resolveSecretRefs missing пуст", envRes.missing.length === 0);

// --- 4. Спринт 29.3: scoped-инъекция секретов ---------------------
resetSecretsCache();
await setSecret("API_KEY", "sk-1234567890abcdef");
await setSecret("GH_TOKEN", "ghp_abcdef1234567890");

check(
  "collectSecretNames: извлекает имена из prompt",
  JSON.stringify(collectSecretNames("покажи ${secret:API_KEY} и ${secret:GH_TOKEN}")) ===
    JSON.stringify(["API_KEY", "GH_TOKEN"])
);

check(
  "collectSecretNames: из пустой строки — пусто",
  collectSecretNames("").length === 0
);

check(
  "collectSecretNames: без ссылок — пусто",
  collectSecretNames("просто текст без секретов").length === 0
);

check(
  "collectSecretNames: дедуплицирует",
  JSON.stringify(collectSecretNames("${secret:API_KEY} и ещё ${secret:API_KEY}")) ===
    JSON.stringify(["API_KEY"])
);

// expandSecretRefs без ограничений — подставляет все
const allRefs = expandSecretRefs("ключ=${secret:API_KEY}, токен=${secret:GH_TOKEN}");
check(
  "expandSecretRefs: без allowed подставляет все",
  allRefs.value === "ключ=sk-1234567890abcdef, токен=ghp_abcdef1234567890" &&
    allRefs.missing.length === 0
);

// expandSecretRefs с allowed — только разрешённые
const scopedRefs = expandSecretRefs(
  "ключ=${secret:API_KEY}, токен=${secret:GH_TOKEN}",
  ["API_KEY"]
);
check(
  "expandSecretRefs: с allowed подставляет только разрешённый",
  scopedRefs.value === "ключ=sk-1234567890abcdef, токен=${secret:GH_TOKEN}" &&
    scopedRefs.missing.length === 0
);

// resolveSecretRefs с allowed — только разрешённые секреты в env
const scopedEnv = resolveSecretRefs(
  { CMD: "запусти ${secret:API_KEY}", HOOK: "${secret:GH_TOKEN}" },
  ["API_KEY"]
);
check(
  "resolveSecretRefs: scoped инжектит только разрешённые",
  scopedEnv.env.CMD === "запусти sk-1234567890abcdef" &&
    scopedEnv.env.HOOK === "${secret:GH_TOKEN}" &&
    scopedEnv.missing.length === 0
);

// Задача без ссылок на секреты не получает ни одного значения
const noRefsEnv = resolveSecretRefs({ CMD: "просто команда" }, []);
check(
  "resolveSecretRefs: без ссылок — пустой env",
  noRefsEnv.env.CMD === "просто команда" && noRefsEnv.missing.length === 0
);

// --- 5. redactSecretsInText -------------------------------------------------
resetSecretsCache();
setSecret("telegram_token", "123456:ABCdefGhIJKlmNopQRSTUVWX");
setSecret("api_secret", "s3cr3t_k3y");

let redacted = redactSecretsInText("TOKEN=123456:ABCdefGhIJKlmNopQRSTUVWX");
check("redactSecretsInText маскирует TOKEN=", redacted === "TOKEN=***");

redacted = redactSecretsInText("api_secret=s3cr3t_k3y");
check("redactSecretsInText маскирует api_secret=", redacted === "api_secret=***");

redacted = redactSecretsInText("Без секретов здесь");
check("redactSecretsInText без изменений", redacted === "Без секретов здесь");

// ${secret:NAME} остаётся нетронутым (не маскируется как значение).
redacted = redactSecretsInText("USE ${secret:telegram_token}");
check("redactSecretsInText не трогает ${secret:NAME}", redacted === "USE ${secret:telegram_token}");

// Короткое значение (<4 символов) не заменяется по общему правилу.
setSecret("short", "abc");
redacted = redactSecretsInText("short=abc");
check("redactSecretsInText короткое значение не маскируется", redacted === "short=abc");

// --- 6. Зашифрованный файл не содержит plaintext -----------------------------
const secretsFile = path.join(process.env.OPENCODE_SCHEDULER_HOME, "secrets.json");
const keyFile = path.join(process.env.OPENCODE_SCHEDULER_HOME, "secrets.key");
fs.mkdirSync(path.dirname(secretsFile), { recursive: true });

setSecret("hidden", "very_secret_value_12345");
const raw = fs.readFileSync(secretsFile, "utf8");
let parsedSecrets;
try {
  parsedSecrets = JSON.parse(raw);
} catch {
  parsedSecrets = null;
}
check("secrets.json не содержит plaintext значения", !raw.includes("very_secret_value_12345"));
check("секретное имя хранится как ключ JSON (только значение зашифровано)", raw.includes('"hidden"'));
check("secrets.json существует и валидный JSON", !!parsedSecrets && !!parsedSecrets.secrets && !!parsedSecrets.secrets.hidden);

// Ключ-файл существует, 32 байта.
const keyData = fs.readFileSync(keyFile);
check("secrets.key 32 байта", keyData.length === 32);

// 6. Права на ключ: POSIX 0600, Windows — ACL без наследования и только текущий пользователь.
if (process.platform === "win32") {
  const acl = spawnSync("icacls", [keyFile], { encoding: "utf8", windowsHide: true });
  const aclText = `${acl.stdout ?? ""}\n${acl.stderr ?? ""}`;
  const user = process.env.USERNAME ?? os.userInfo().username;
  check("secrets.key: ACL применён (icacls доступен)", acl.status === 0);
  check("secrets.key: наследование отключено", !aclText.includes("(I)"));
  check("secrets.key: доступ только текущему пользователю", aclText.includes(user));
  check(
    "secrets.key: BUILTIN\\Users не имеет доступа",
    !/BUILTIN\\Users/i.test(aclText)
  );
} else {
  const mode = fs.statSync(keyFile).mode & 0o777;
  check("secrets.key: режим 0600", mode === 0o600);
}

// --- 7. Несуществующий/повреждённый ключ -------------------------------------
resetSecretsCache();
const corruptedKey = path.join(process.env.OPENCODE_SCHEDULER_HOME, "secrets.key");
fs.writeFileSync(corruptedKey, "not-32-bytes");
try {
  getSecret("anything");
  check("getSecret с повреждённым ключом не бросает", true);
} catch {
  check("getSecret с повреждённым ключом не бросает", false);
}

// --- 8. Повреждённый secrets.json не затирается ------------------------------
resetSecretsCache();
fs.writeFileSync(corruptedKey, crypto.randomBytes(32));
fs.writeFileSync(secretsFile, "{ это не json");
let corruptReadThrew = false;
try {
  getSecret("hidden");
} catch {
  corruptReadThrew = true;
}
check("getSecret на битом secrets.json не бросает", corruptReadThrew === false);
const pluginDir = path.dirname(secretsFile);
const quarantined = fs
  .readdirSync(pluginDir)
  .filter((name) => name.startsWith("secrets.json.corrupt-"));
check("битый secrets.json отложен в .corrupt-*", quarantined.length === 1);
setSecret("after_corruption", "value12345");
check("после повреждения запись снова работает", getSecret("after_corruption") === "value12345");

// --- 9. Итог -----------------------------------------------------------------
const failures = results.filter((item) => !item.ok);
console.log(`\nSecrets: ${results.length - failures.length}/${results.length} проверок пройдено.`);
if (failures.length > 0) {
  for (const item of failures) console.error(`FAIL: ${item.name}`);
  process.exit(1);
}
