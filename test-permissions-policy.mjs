import assert from "node:assert";
import {
  resolvePermissions,
  buildOpencodeConfig,
  DEFAULT_PERMISSION_POLICY,
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

console.log(`\nPermissions policy: все ${passed} проверок пройдены.`);
