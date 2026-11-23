// Спринт 36.5.d: эскалация после провала Quality Gate — по правилу, без модели.
//
// Проверяем:
//  - успешный гейт всегда принимается на текущем уровне;
//  - цепочка провалов: local → cloud → review → blocked;
//  - nextGateTarget / isEscalationExhausted / escalationChain;
//  - ошибки на неизвестный уровень и на некорректный результат гейта;
//  - модуль не импортирует модель, БД и сеть (только таблица переходов);
//  - 1000 решений принимаются за миллисекунды.
//
// Запуск: node test-escalation.mjs (после npm run build).
import fs from "node:fs";
import path from "node:path";

import {
  MAX_ESCALATION_STEPS,
  MAX_GATE_ATTEMPTS,
  escalateAfterGate,
  escalationChain,
  gateVerdict,
  isEscalationExhausted,
  nextGateTarget,
  resolveGateOutcome,
  runGateWithRetry,
  shouldRetryGate,
} from "./dist/core/router/escalation.js";

const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const assertThrows = (fn, msg) => {
  try {
    fn();
  } catch {
    assert(true, msg);
    return;
  }
  assert(false, msg);
};

// 1. Успех принимается на любом уровне.
for (const level of ["local", "cloud", "review"]) {
  const decision = escalateAfterGate(level, { passed: true });
  assert(decision.action === "accept", `${level}: успешный гейт принят`);
  assert(decision.next === level, `${level}: уровень не меняется`);
  assert(decision.reason === "gate-passed", `${level}: причина gate-passed`);
}

// 2. Цепочка провалов.
const localFail = escalateAfterGate("local", { passed: false });
assert(localFail.action === "escalate-cloud", "провал local уходит в cloud");
assert(localFail.next === "cloud", "провал local: следующий уровень cloud");
assert(localFail.reason === "local-failed", "провал local: причина local-failed");

const cloudFail = escalateAfterGate("cloud", { passed: false });
assert(cloudFail.action === "escalate-review", "провал cloud уходит в review");
assert(cloudFail.next === "review", "провал cloud: следующий уровень review");
assert(cloudFail.reason === "cloud-failed", "провал cloud: причина cloud-failed");

const reviewFail = escalateAfterGate("review", { passed: false });
assert(reviewFail.action === "blocked", "провал review означает blocked");
assert(reviewFail.next === "review", "blocked остаётся на review");
assert(reviewFail.reason === "review-failed", "blocked: причина review-failed");

// 3. Вспомогательные функции.
assert(nextGateTarget("local") === "cloud", "nextGateTarget(local) = cloud");
assert(nextGateTarget("cloud") === "review", "nextGateTarget(cloud) = review");
assert(nextGateTarget("review") === null, "nextGateTarget(review) = null");
assert(isEscalationExhausted("review"), "review исчерпан");
assert(!isEscalationExhausted("local"), "local не исчерпан");
assert(
  MAX_ESCALATION_STEPS === 2,
  "длина автоматической цепочки — 2 шага",
);
assert(
  escalationChain("local").join(">") === "local>cloud>review",
  "цепочка local>cloud>review",
);
assert(
  escalationChain("cloud").join(">") === "cloud>review",
  "цепочка с cloud короче",
);
assert(escalationChain("review").length === 1, "review — последний уровень");

// 4. Ошибки входа.
assertThrows(
  () => nextGateTarget("quantum"),
  "неизвестный уровень — ошибка",
);
assertThrows(
  () => escalateAfterGate("local", null),
  "null вместо результата гейта — ошибка",
);
assertThrows(
  () => escalateAfterGate("local", { passed: "yes" }),
  "не-boolean passed — ошибка",
);
assertThrows(
  () => escalateAfterGate("local", {}),
  "отсутствующий passed — ошибка",
);

// 5. Модуль не тянет модель и БД.
const source = fs.readFileSync(
  path.join("src", "core", "router", "escalation.ts"),
  "utf8",
);
assert(!/^import\s/m.test(source), "escalation.ts не импортирует ничего");
assert(
  !/planMission|decompose|capability-repo|node:sqlite/i.test(source),
  "в escalation.ts нет модели и БД",
);

// 6. Горячий путь: 1000 решений за миллисекунды.
const startedAt = performance.now();
for (let index = 0; index < 1000; index += 1) {
  escalateAfterGate("local", { passed: index % 2 === 0 });
}
const elapsed = performance.now() - startedAt;
assert(elapsed < 100, `1000 решений уложились в ${elapsed.toFixed(1)} мс`);

// 7. ARCH-3.1: вердикты, повтор гейта на том же артефакте и first-pass.
assert(MAX_GATE_ATTEMPTS === 2, "допускается ровно 2 попытки гейта");
assert(gateVerdict({ passed: true }) === "pass", "явного вердикта нет — pass из passed");
assert(gateVerdict({ passed: false }) === "fail", "явного вердикта нет — fail из passed");
assert(gateVerdict({ passed: true, verdict: "flake" }) === "flake", "явный вердикт имеет приоритет");
assert(shouldRetryGate("flake") && shouldRetryGate("infra_fail"), "flake/infra_fail повторяются");
assert(!shouldRetryGate("pass") && !shouldRetryGate("fail"), "стабильные pass/fail не повторяются");

const stablePass = resolveGateOutcome([{ passed: true, reason: "ok" }]);
assert(
  stablePass.verdict === "pass" && stablePass.firstPass === true && stablePass.attemptsToPass === 1,
  "стабильный pass: first_pass=true, attempts_to_pass=1",
);
const flakePass = resolveGateOutcome([
  { passed: false, verdict: "flake", reason: "tmp timeout" },
  { passed: true, reason: "ok" },
]);
assert(
  flakePass.verdict === "flake" && flakePass.passed === true &&
    flakePass.firstPass === false && flakePass.attemptsToPass === 2 && flakePass.retried,
  "флакующий гейт: проход со 2-й попытки, first_pass=false, attempts_to_pass=2",
);
const infraOutcome = resolveGateOutcome([
  { passed: false, verdict: "infra_fail", reason: "sqlite locked" },
  { passed: false, verdict: "infra_fail", reason: "sqlite locked" },
]);
assert(
  infraOutcome.verdict === "infra_fail" && !infraOutcome.passed && infraOutcome.attemptsToPass === 2,
  "infra_fail не смешивается с flake и fail",
);
const mixedOutcome = resolveGateOutcome([
  { passed: false, verdict: "flake" },
  { passed: false, verdict: "infra_fail" },
]);
assert(mixedOutcome.verdict === "infra_fail", "infra_fail доминирует над flake");
const stableFail = resolveGateOutcome([{ passed: false, verdict: "fail" }]);
assert(stableFail.verdict === "fail" && !stableFail.retried, "стабильный fail не повторяется");

let gateCalls = 0;
const retried = await runGateWithRetry((attempt) => {
  gateCalls += 1;
  return attempt === 1
    ? { passed: false, verdict: "flake", reason: "first call flaked" }
    : { passed: true, reason: "second call ok" };
});
assert(gateCalls === 2, "runGateWithRetry вызвал гейт ровно 2 раза");
assert(
  retried.verdict === "flake" && retried.firstPass === false && retried.attemptsToPass === 2,
  "runGateWithRetry: проход со 2-й попытки на том же артефакте",
);

let stableCalls = 0;
const stable = await runGateWithRetry(() => {
  stableCalls += 1;
  return { passed: true };
});
assert(stableCalls === 1 && stable.firstPass === true, "стабильный pass не вызывает повтор");

const blockedFlake = escalateAfterGate("local", { passed: false, verdict: "flake" });
assert(
  blockedFlake.action === "blocked" && blockedFlake.reason === "flake-detected",
  "flake не эскалируется (смена исполнителя не лечит шум)",
);
const blockedInfra = escalateAfterGate("cloud", { passed: false, verdict: "infra_fail" });
assert(
  blockedInfra.action === "blocked" && blockedInfra.reason === "infra-error",
  "infra_fail не эскалируется (это не вина агента)",
);

if (process.exitCode === 1) {
  console.error("Escalation: есть падения.");
} else {
  console.log("Escalation: все проверки пройдены.");
}
