// T-04: лимит имени задачи сужается для не-default профиля, т.к.
// TASK_FOLDER_NAME = windows-scheduler-<profile> длиннее.
//
// Запуск: node test-task-name-limit-profile.mjs (после npm run build).
import { strict as assert } from "node:assert";

process.env.OPENCODE_SCHEDULER_PROFILE = "long-profile-name";
const { validateTaskName, TASK_FOLDER_NAME, TASK_FOLDER } = await import(
  "./dist/types.js"
);

const prefixLength = 1 + TASK_FOLDER.length + 1 + TASK_FOLDER_NAME.length + 1;
const expectedMax = 237 - prefixLength;

console.log(
  `TASK_FOLDER_NAME="${TASK_FOLDER_NAME}" prefixLen=${prefixLength} expectedMax=${expectedMax}`
);

assert.ok(
  expectedMax < 208,
  `для не-default профиля лимит должен быть меньше 208 (получено ${expectedMax})`
);

const maxName = "a".repeat(expectedMax);
const overName = "a".repeat(expectedMax + 1);

assert.strictEqual(
  validateTaskName(maxName),
  null,
  `имя длиной ${expectedMax} символов допустимо для профиля`
);
assert.ok(
  validateTaskName(overName),
  `имя длиной ${expectedMax + 1} символов должно быть отвергнуто для профиля`
);

console.log("T-04 (profile): все проверки пройдены.");
