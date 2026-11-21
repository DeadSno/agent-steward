import assert from "node:assert";
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

console.log(`\nPermissions policy: все ${passed} проверок пройдены.`);
