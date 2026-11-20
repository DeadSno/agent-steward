/**
 * QA-P2.1: отклонение невалидных значений при create/update.
 * Запуск: node test-validation.mjs (после npm run build).
 */
import fs from "node:fs";
import path from "node:path";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

const { root: tempRoot } = createTestHomeSync("ws-scheduler-validation-");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  scheduleTaskSchema,
  updateTaskSchema,
  validateTaskInputRanges,
} = await import("./dist/index.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

const createBase = {
  name: "qa-validation-probe",
  schedule: "* * * * *",
  prompt: "noop",
};
const updateBase = { name: "qa-validation-probe", prompt: "noop" };

const invalidPatches = [
  ["priority:99", { priority: 99 }],
  ["retryCount:-1", { retryCount: -1 }],
  ["retryDelay:-10", { retryDelay: -10 }],
  ["timeoutSeconds:-1", { timeoutSeconds: -1 }],
  ["prompt:''", { prompt: "" }],
  ["triggerType:file + watchPath:''", { triggerType: "file", watchPath: "" }],
  ["watchGlobs:['** /*.md']", { watchGlobs: ["** /*.md"] }],
  ["watchIgnore:['bad mask']", { watchIgnore: ["bad mask"] }],
  ["gitPaths:['a b']", { gitPaths: ["a b"] }],
];

try {
  for (const [label, patch] of invalidPatches) {
    const createInput = { ...createBase, ...patch };
    const updateInput = { ...updateBase, ...patch };
    check(
      `Q2.1 create-Zod отклоняет ${label}`,
      scheduleTaskSchema.safeParse(createInput).success === false,
    );
    check(
      `Q2.1 update-Zod отклоняет ${label}`,
      updateTaskSchema.safeParse(updateInput).success === false,
    );
    check(
      `Q2.1 validateTaskInputRanges отклоняет ${label}`,
      validateTaskInputRanges(createInput) !== null,
    );
  }

  check(
    "Q2.1 валидные create-значения проходят",
    scheduleTaskSchema.safeParse({
      ...createBase,
      priority: 7,
      retryCount: 0,
      retryDelay: 10,
      timeoutSeconds: 60,
      watchGlobs: ["**/*.md", "!**/vendor/**"],
      gitPaths: ["src/**"],
    }).success === true,
  );
  check(
    "Q2.1 валидные update-значения проходят",
    updateTaskSchema.safeParse({ ...updateBase, priority: 0, retryCount: 2 }).success === true,
  );
  check(
    "Q2.1 пустой watchPath без file-триггера остаётся легальным (очистка поля)",
    updateTaskSchema.safeParse({ ...updateBase, watchPath: "" }).success === true,
  );
  check(
    "Q2.1 validateTaskInputRanges не ругается на валидные значения",
    validateTaskInputRanges({ ...createBase, priority: 5, watchGlobs: ["**/*.md"] }) === null,
  );

  const dist = fs.readFileSync(new URL("./dist/index.js", import.meta.url), "utf8");
  const calls = dist.match(/validateTaskInputRanges\(/g) ?? [];
  check(
    "Q2.1 валидация вызвана в MCP create, update и RPC create (3 вызова + definition)",
    calls.length >= 4,
  );
} finally {
  removeTestHomeSync(tempRoot);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nValidation: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
