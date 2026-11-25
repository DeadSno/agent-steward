import assert from "node:assert";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolvePermissions,
  buildOpencodeConfig,
  DEFAULT_PERMISSION_POLICY,
  RISK_CLASSES,
  DEFAULT_RISK_CLASS,
  RISK_POLICY_BASELINE,
  compilePermissionPolicy,
  classifyRiskClass,
  normalizeRiskClass,
  normalizeEgressPolicy,
  extractEgressHost,
  checkEgress,
  runEgressGuarded,
  normalizeWriteScopePolicy,
  checkWriteScope,
  WRITE_SCOPE_REASONS,
} from "./dist/core/permissions.js";

let passed = 0;
function check(name, cond) {
  assert.ok(cond, `FAIL: ${name}`);
  console.log(`OK   ${name}`);
  passed++;
}

const eff = resolvePermissions({});
check("hybrid policy default", eff.policy === DEFAULT_PERMISSION_POLICY);
const shell = eff.permissions.find((p) => p.action === "shell");
const question = eff.permissions.find((p) => p.action === "question");
check("hybrid shell denied", shell.effect === "deny");
check("hybrid question denied", question.effect === "deny");
check("hybrid deniedByPolicy shell", eff.deniedByPolicy.some((d) => d.action === "shell" && typeof d.hint === "string" && d.hint.length > 0));
check("hybrid deniedByPolicy question", eff.deniedByPolicy.some((d) => d.action === "question" && typeof d.hint === "string" && d.hint.length > 0));
check("hybrid read allowed", eff.permissions.find((p) => p.action === "read").effect === "allow");
check("hybrid edit allowed", eff.permissions.find((p) => p.action === "edit").effect === "allow");

const effLegacy = resolvePermissions({ policy: "hybrid", legacyShell: true });
check("legacyShell enables shell", effLegacy.permissions.find((p) => p.action === "shell").effect === "allow");
check("legacyShell still denies question", effLegacy.permissions.find((p) => p.action === "question").effect === "deny");

const effSecure = resolvePermissions({ policy: "secure" });
check("secure read allowed", effSecure.permissions.find((p) => p.action === "read").effect === "allow");
check("secure edit denied", effSecure.permissions.find((p) => p.action === "edit").effect === "deny");
check("secure shell denied", effSecure.permissions.find((p) => p.action === "shell").effect === "deny");
check("secure skill allowed", effSecure.permissions.find((p) => p.action === "skill").effect === "allow");

const effLegacyAll = resolvePermissions({ policy: "legacy" });
for (const p of effLegacyAll.permissions) {
  check(`legacy ${p.action} allowed`, p.effect === "allow");
}

const effDeny = resolvePermissions({ policy: "legacy", deniedTools: ["shell"] });
check("deniedTools overrides legacy", effDeny.permissions.find((p) => p.action === "shell").effect === "deny");

const effAllow = resolvePermissions({ policy: "hybrid", allowedTools: ["shell"] });
check("allowedTools enables shell in hybrid", effAllow.permissions.find((p) => p.action === "shell").effect === "allow");

// PL-133: shell-only allowlist не блокирует чтение кода и загрузку скиллов.
for (const action of ["read", "glob", "grep", "skill", "shell"]) {
  check(
    `PL-133: shell-only разрешает ${action}`,
    effAllow.permissions.find((p) => p.action === action).effect === "allow",
  );
}
const effShellOnlyDenied = resolvePermissions({
  policy: "hybrid",
  allowedTools: ["shell"],
  deniedTools: ["skill"],
});
check(
  "PL-133: явный deniedTools запрещает skill даже в shell-only задаче",
  effShellOnlyDenied.permissions.find((p) => p.action === "skill").effect === "deny",
);

// PL-141: allowlist намеренно нестрогий; жёсткое запрещение read-only действий —
// только через явный deniedTools. Контракт зафиксирован в ARCHITECTURE.
const effShellHardDenied = resolvePermissions({
  policy: "hybrid",
  allowedTools: ["shell"],
  deniedTools: ["read", "glob", "grep", "skill"],
});
for (const action of ["read", "glob", "grep", "skill"]) {
  check(
    `PL-141: deniedTools запрещает ${action} в shell-only задаче`,
    effShellHardDenied.permissions.find((p) => p.action === action).effect === "deny",
  );
}
check(
  "PL-141: shell остаётся разрешённым при явном denied read-only",
  effShellHardDenied.permissions.find((p) => p.action === "shell").effect === "allow",
);
const architecture = readFileSync(new URL("./docs/ARCHITECTURE.md", import.meta.url), "utf8");
check(
  "PL-141: ARCHITECTURE документирует нестрогий allowlist и deniedTools",
  architecture.includes("only an explicit `deniedTools` entry can deny them"),
);

const config = buildOpencodeConfig({ policy: "hybrid" });
const parsed = JSON.parse(config);
check("config has schema", parsed["$schema"] === "https://opencode.ai/config.json");
check("config has 10 permissions", parsed.permissions.length === 10);
check("config shell deny", parsed.permissions.find((p) => p.action === "shell").effect === "deny");

// ── ARCH-2.1 / ARCH-2.2: класс риска и компиляция политики ─────────────────
check("risk classes: таблица R0..R3", RISK_CLASSES.join(",") === "R0,R1,R2,R3");
check("risk class default — R2 (гибрид)", DEFAULT_RISK_CLASS === "R2");
check(
  "normalizeRiskClass: валидный и неизвестный класс",
  normalizeRiskClass("R1") === "R1" && normalizeRiskClass("R9") === DEFAULT_RISK_CLASS,
);

// Таблица соответствия класс → политика + явные списки + лимиты.
const expectedPolicy = { R0: "secure", R1: "secure", R2: "hybrid", R3: "legacy" };
for (const klass of RISK_CLASSES) {
  const baseline = RISK_POLICY_BASELINE[klass];
  const compiled = compilePermissionPolicy({ riskClass: klass });
  check(`${klass} → ${expectedPolicy[klass]}`, compiled.policy === expectedPolicy[klass]);
  check(
    `${klass}: явные allowedTools`,
    compiled.allowedTools.length > 0 &&
      JSON.stringify(compiled.allowedTools) === JSON.stringify(baseline.allowedTools),
  );
  check(
    `${klass}: явные deniedTools`,
    JSON.stringify(compiled.deniedTools) === JSON.stringify(baseline.deniedTools),
  );
  check(`${klass}: лимиты`, JSON.stringify(compiled.limits) === JSON.stringify(baseline.limits));
  check(
    `${klass}: компилятор детерминирован`,
    JSON.stringify(compilePermissionPolicy({ riskClass: klass })) === JSON.stringify(compiled),
  );
  const effective = resolvePermissions({
    policy: compiled.policy,
    allowedTools: compiled.allowedTools,
    deniedTools: compiled.deniedTools,
  });
  check(`${klass}: скомпилированная политика даёт 10 правил`, effective.permissions.length === 10);
}
const effectOf = (compiled, action) =>
  resolvePermissions({
    policy: compiled.policy,
    allowedTools: compiled.allowedTools,
    deniedTools: compiled.deniedTools,
  }).permissions.find((p) => p.action === action).effect;
check("R0: edit запрещён", effectOf(compilePermissionPolicy({ riskClass: "R0" }), "edit") === "deny");
check("R1: webfetch разрешён", effectOf(compilePermissionPolicy({ riskClass: "R1" }), "webfetch") === "allow");
check("R2: shell запрещён", effectOf(compilePermissionPolicy({ riskClass: "R2" }), "shell") === "deny");
check("R3: shell разрешён", effectOf(compilePermissionPolicy({ riskClass: "R3" }), "shell") === "allow");

// Классификация по tool/gate scope.
check("classify: secure → R0", classifyRiskClass({ policy: "secure" }) === "R0");
check("classify: secure + gate → R1", classifyRiskClass({ policy: "secure", gate: "npm test" }) === "R1");
check("classify: hybrid → R2", classifyRiskClass({ policy: "hybrid" }) === "R2");
check("classify: legacy → R3", classifyRiskClass({ policy: "legacy" }) === "R3");
check(
  "classify: явный shell поднимает до R3",
  classifyRiskClass({ policy: "hybrid", allowedTools: ["bash"] }) === "R3",
);
check(
  "classify: denylist сужает класс до R0",
  classifyRiskClass({
    policy: "hybrid",
    deniedTools: ["subagent", "webfetch", "websearch", "edit", "write", "apply_patch", "remove"],
  }) === "R0",
);

// Явные переопределения поверх базы риск-класса.
const withBash = compilePermissionPolicy({ riskClass: "R2", allowedTools: ["bash"] });
check("compiler: явный allowlist добавляет инструмент", withBash.allowedTools.includes("bash"));
check("compiler: явный allowlist снимает базовый denylist алиасов", !withBash.deniedTools.includes("bash"));
const withDenied = compilePermissionPolicy({ riskClass: "R3", deniedTools: ["bash"] });
check(
  "compiler: явный denylist выигрывает у R3",
  withDenied.deniedTools.includes("bash") && !withDenied.allowedTools.includes("bash"),
);
check(
  "compiler: явная политика заменяет политику класса",
  compilePermissionPolicy({ riskClass: "R0", policy: "legacy" }).policy === "legacy",
);

// ── ARCH-6.1 / QW-4: egress-политика в execute-пути, не в конфиге OpenCode ───
check(
  "egress: без конфига политика не задана (fail-open)",
  normalizeEgressPolicy(null) === null &&
    normalizeEgressPolicy(undefined) === null &&
    normalizeEgressPolicy([]) === null &&
    normalizeEgressPolicy({ allowedHosts: [] }) === null,
);
const normalizedEgress = normalizeEgressPolicy({
  allowedHosts: ["API.Example.COM.", "*.GitHub.com"],
  allowedApis: ["https://API.Example.COM/v1/"],
});
check(
  "egress: нормализация whitelist (trim/lower/дедуп)",
  normalizedEgress !== null &&
    normalizedEgress.allowedHosts.join(",") === "api.example.com,.github.com" &&
    normalizedEgress.allowedApis.join(",") === "https://api.example.com/v1/",
);
check(
  "egress: строка хостов через запятую",
  JSON.stringify(normalizeEgressPolicy("API.Example.COM, *.GitHub.com")) ===
    JSON.stringify({ allowedHosts: ["api.example.com", ".github.com"], allowedApis: [] }),
);
check(
  "egress: extractEgressHost URL/port/bare/невалидный",
  extractEgressHost("https://api.github.com:443/repos") === "api.github.com" &&
    extractEgressHost("evil.example:8080/x") === "evil.example" &&
    extractEgressHost("not a url") === null &&
    extractEgressHost("") === null,
);

const noPolicy = checkEgress(null, "https://evil.example/x");
check(
  "egress: fail-open без политики (старое поведение)",
  noPolicy.allowed === true &&
    noPolicy.reason === "no-policy" &&
    noPolicy.degraded === false &&
    noPolicy.policyConfigured === false,
);
const egressPolicy = { allowedHosts: ["api.github.com"], allowedApis: [] };
const allowedHost = checkEgress(egressPolicy, "https://api.github.com/repos");
check(
  "egress: разрешённый хост проходит",
  allowedHost.allowed === true &&
    allowedHost.reason === "allowed-host" &&
    allowedHost.host === "api.github.com" &&
    allowedHost.degraded === false,
);
const blockedHost = checkEgress(egressPolicy, "https://evil.example/x");
check(
  "egress: запрещённый хост блокируется и имеет причину",
  blockedHost.allowed === false &&
    blockedHost.reason === "blocked-host" &&
    blockedHost.degraded === true &&
    blockedHost.detail.includes("evil.example"),
);
const suffixPolicy = { allowedHosts: [".github.com"], allowedApis: [] };
const subOk = checkEgress(suffixPolicy, "https://sub.github.com/x");
const subBad = checkEgress(suffixPolicy, "https://github.com.evil.test/x");
check(
  "egress: .suffix пускает поддомен, но не подмену домена",
  subOk.allowed === true && subBad.allowed === false,
);
const apiOk = checkEgress(
  { allowedHosts: [], allowedApis: ["https://api.github.com/repos/"] },
  "https://api.github.com/repos/o/r",
);
check("egress: разрешённый API-префикс проходит", apiOk.allowed === true && apiOk.reason === "allowed-api");
const invalidDest = checkEgress(egressPolicy, "not a url");
check(
  "egress: невалидный адрес — отказ с причиной",
  invalidDest.allowed === false &&
    invalidDest.reason === "invalid-destination" &&
    invalidDest.degraded === true,
);

const compiledWithEgress = compilePermissionPolicy({ riskClass: "R2", egress: ["api.github.com"] });
check(
  "egress: компилятор переносит whitelist в execute-политику",
  compiledWithEgress.egress !== null &&
    compiledWithEgress.egress.allowedHosts.join(",") === "api.github.com",
);
check(
  "egress: компилятор без whitelist оставляет fail-open",
  compilePermissionPolicy({ riskClass: "R2" }).egress === null,
);
const scoped = JSON.parse(
  buildOpencodeConfig({ policy: "hybrid", egress: { allowedHosts: ["api.github.com"] } }),
);
check(
  "QW-4: scoped-конфиг содержит только поля схемы OpenCode и 10 правил",
  scoped.egress === undefined &&
    scoped.permissions.length === 10 &&
    Object.keys(scoped).every((key) => key === "$schema" || key === "permissions"),
);
const legacyConfig = JSON.parse(buildOpencodeConfig({ policy: "hybrid" }));
check(
  "egress: без политики конфиг байт-в-байт прежний (fail-open)",
  legacyConfig.egress === undefined &&
    JSON.stringify(legacyConfig.permissions) === JSON.stringify(parsed.permissions),
);

// Execute-path: действие вызывается только при разрешённом выходе.
let calls = 0;
const action = () => {
  calls++;
  return "downloaded";
};
const okRun = await runEgressGuarded(egressPolicy, "https://api.github.com/repos", action);
check(
  "egress: execute-path разрешённый хост выполняет действие",
  okRun.ok === true && okRun.status === "ok" && okRun.value === "downloaded" && calls === 1,
);
const blockedRun = await runEgressGuarded(egressPolicy, "https://evil.example/x", action);
check(
  "egress: execute-path заблокированный хост НЕ выполняет действие и деградирует",
  blockedRun.ok === false &&
    blockedRun.status === "degraded" &&
    blockedRun.degraded === true &&
    calls === 1,
);
const noPolicyRun = await runEgressGuarded(null, "https://evil.example/x", action);
check(
  "egress: execute-path без политики сохраняет старое поведение",
  noPolicyRun.ok === true && noPolicyRun.status === "ok" && calls === 2,
);

// ── SC-1.2: write-scope guard (deny по умолчанию) и его аудит ────────────────
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sc1-write-scope-"));
const scopeRoot = path.join(tempRoot, "worktree");
fs.mkdirSync(path.join(scopeRoot, "src"), { recursive: true });
const outsidePath = path.join(tempRoot, "outside", "secret.txt");
const insidePath = path.join(scopeRoot, "src", "a.ts");

check(
  "SC-1.2: причины решения зафиксированы",
  WRITE_SCOPE_REASONS.join(",") === "within-scope,outside-denied,outside-allowed,traversal,invalid-path",
);
const insideDecision = checkWriteScope({ target: insidePath, baseDir: scopeRoot });
check(
  "SC-1.2: путь внутри worktree разрешён",
  insideDecision.allowed === true &&
    insideDecision.reason === "within-scope" &&
    insideDecision.resolvedPath === insidePath,
);
const outsideDecision = checkWriteScope({ target: outsidePath, baseDir: scopeRoot });
check(
  "SC-1.2: путь вне write-scope запрещён по умолчанию",
  outsideDecision.allowed === false &&
    outsideDecision.reason === "outside-denied" &&
    outsideDecision.outsideAllowed === false &&
    typeof outsideDecision.detail === "string" && outsideDecision.detail.length > 0,
);
const explicitDecision = checkWriteScope({
  target: outsidePath,
  baseDir: scopeRoot,
  policy: { allowOutside: true },
});
check(
  "SC-1.2: явный opt-in разрешает запись вне scope",
  explicitDecision.allowed === true &&
    explicitDecision.reason === "outside-allowed" &&
    explicitDecision.outsideAllowed === true,
);
const extraDecision = checkWriteScope({
  target: outsidePath,
  baseDir: scopeRoot,
  policy: { extraRoots: [path.dirname(outsidePath)] },
});
check(
  "SC-1.2: дополнительный явно разрешённый корень считается внутри scope",
  extraDecision.allowed === true && extraDecision.reason === "within-scope",
);
const traversalRaw = checkWriteScope({ target: "../outside/secret.txt", baseDir: scopeRoot });
check(
  "SC-1.2: path traversal с родительским сегментом маскируется сразу",
  traversalRaw.allowed === false &&
    traversalRaw.reason === "traversal" &&
    traversalRaw.resolvedPath === null,
);
// path.join нормализует '..' в абсолютный путь — guard всё равно видит его вне scope.
const normalizedOutside = path.join(scopeRoot, "..", "outside", "secret.txt");
const traversalNormalized = checkWriteScope({ target: normalizedOutside, baseDir: scopeRoot });
check(
  "SC-1.2: нормализованный обход '..' теперь просто путь вне scope — тоже deny",
  traversalNormalized.allowed === false &&
    traversalNormalized.reason === "outside-denied",
);
check(
  "SC-1.2: пустой путь — invalid-path",
  checkWriteScope({ target: "", baseDir: scopeRoot }).reason === "invalid-path",
);
check(
  "SC-1.2: дефолтная политика — deny с корнем baseDir",
  normalizeWriteScopePolicy(null, scopeRoot).allowedRoot === scopeRoot &&
    normalizeWriteScopePolicy(null, scopeRoot).allowOutside === false &&
    normalizeWriteScopePolicy(null, scopeRoot).configured === false,
);
check(
  "SC-1.2: относительный корень резолвится через baseDir при компиляции и resolve",
  compilePermissionPolicy({ writeScope: "src", baseDir: scopeRoot }).writeScope.allowedRoot ===
    path.join(scopeRoot, "src") &&
    resolvePermissions({ writeScope: { scope: "src" }, baseDir: scopeRoot }).writeScope.allowedRoot ===
      path.join(scopeRoot, "src"),
);
const compiledScope = compilePermissionPolicy({
  riskClass: "R2",
  writeScope: { allowedRoot: scopeRoot, allowOutside: false },
});
check(
  "SC-1.2: компилятор переносит write-scope в execute-политику",
  compiledScope.writeScope.allowedRoot === scopeRoot &&
    compiledScope.writeScope.allowOutside === false &&
    compiledScope.writeScope.configured === true,
);
const effectiveScope = resolvePermissions({
  policy: "hybrid",
  writeScope: { allowedRoot: scopeRoot, allowOutside: true },
});
check(
  "SC-1.2: resolvePermissions отдаёт нормализованный write-scope",
  effectiveScope.writeScope.allowOutside === true &&
    effectiveScope.writeScope.allowedRoot === scopeRoot,
);
const scopedConfig = JSON.parse(
  buildOpencodeConfig({
    policy: "hybrid",
    writeScope: { allowedRoot: scopeRoot, allowOutside: true },
  }),
);
check(
  "QW-4: write-scope не попадает в OPENCODE_CONFIG_CONTENT",
  scopedConfig.writeScope === undefined &&
    scopedConfig.egress === undefined &&
    Object.keys(scopedConfig).every((key) => key === "$schema" || key === "permissions"),
);

// Аудит решений: temp-БД подключается после env, как в test-audit.mjs.
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
const audit = await import("./dist/core/audit.js");
const dbModule = await import("./dist/db/index.js");
dbModule.getDb();
audit.resetAuditCleanupThrottle();
audit.clearAuditLog();

const deniedAttempt = audit.recordWriteScopeDecision({
  decision: outsideDecision,
  task: "sc1-dev",
  actor: "test",
});
check(
  "SC-1.2: отказ пишется в аудит как write_scope.denied",
  deniedAttempt.action === audit.WRITE_SCOPE_DENIED_ACTION &&
    typeof deniedAttempt.auditId === "number" &&
    deniedAttempt.auditId > 0,
);
const outsideAttempt = audit.recordWriteScopeDecision({
  decision: explicitDecision,
  task: "sc1-dev",
  actor: "test",
});
check(
  "SC-1.2: явный выход пишется в аудит как write_scope.allowed_outside",
  outsideAttempt.action === audit.WRITE_SCOPE_ALLOWED_OUTSIDE_ACTION &&
    typeof outsideAttempt.auditId === "number",
);
const deniedLog = audit.readAuditLog({ action: audit.WRITE_SCOPE_DENIED_ACTION });
check(
  "SC-1.2: событие аудита содержит причину и путь",
  deniedLog.total === 1 &&
    deniedLog.records[0].details.reason === "outside-denied" &&
    deniedLog.records[0].details.path === outsidePath &&
    deniedLog.records[0].details.scopeRoot === scopeRoot,
);
check(
  "SC-1.2: разрешённый выход зафиксирован отдельным событием",
  audit.readAuditLog({ action: audit.WRITE_SCOPE_ALLOWED_OUTSIDE_ACTION }).total === 1,
);
const secretDecision = {
  ...outsideDecision,
  detail: "apiToken=LEAKME123 вне scope",
  resolvedPath: path.join(tempRoot, "apiToken=LEAKME123", "x.txt"),
};
audit.recordWriteScopeDecision({ decision: secretDecision, task: "sc1-dev", actor: "test" });
const secretLog = audit.readAuditLog({ action: audit.WRITE_SCOPE_DENIED_ACTION, limit: 5 });
check(
  "SC-1.2:redactAuditDetails вычищает секреты из деталей аудита",
  !JSON.stringify(secretLog.records).includes("LEAKME123") &&
    JSON.stringify(secretLog.records).includes("apiToken=***"),
);

let writeCalls = 0;
const deniedRun = await audit.runWriteScopeGuarded(
  { target: outsidePath, baseDir: scopeRoot, task: "sc1-dev", actor: "test" },
  () => {
    writeCalls++;
    return "written";
  },
);
check(
  "SC-1.2: execute-path не выполняет запись при deny",
  deniedRun.ok === false &&
    deniedRun.status === "denied" &&
    writeCalls === 0,
);
const allowedRun = await audit.runWriteScopeGuarded(
  { target: insidePath, baseDir: scopeRoot, task: "sc1-dev", actor: "test" },
  (resolved) => {
    writeCalls++;
    return resolved;
  },
);
check(
  "SC-1.2: execute-path выполняет запись внутри scope",
  allowedRun.ok === true && allowedRun.status === "ok" && writeCalls === 1 && allowedRun.value === insidePath,
);

console.log(`\nPermissions policy: все ${passed} проверок пройдены.`);
