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
  escalateAfterGate,
  escalationChain,
  isEscalationExhausted,
  nextGateTarget,
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

if (process.exitCode === 1) {
  console.error("Escalation: есть падения.");
} else {
  console.log("Escalation: все проверки пройдены.");
}
