// T-04: лимит имени задачи считается динамически от TASK_FOLDER_NAME,
// а не жёстко 213. Для default профиля префикс \OpenCode\agent-steward\
// = 24 символа (1+8+1+14+1) → максимум 237 - 24 = 213.
//
// Запуск: node test-task-name-limit.mjs (после npm run build).
import { strict as assert } from "node:assert";

// env задаём ДО импорта, т.к. TASK_FOLDER_NAME — IIFE на уровне модуля.
process.env.OPENCODE_SCHEDULER_PROFILE = "default";
const { validateTaskName, TASK_FOLDER_NAME, TASK_FOLDER } = await import(
  "./dist/types.js"
);

const prefixLength = 1 + TASK_FOLDER.length + 1 + TASK_FOLDER_NAME.length + 1;
const expectedMax = 237 - prefixLength;

console.log(
  `TASK_FOLDER_NAME="${TASK_FOLDER_NAME}" prefixLen=${prefixLength} expectedMax=${expectedMax}`
);

const maxName = "a".repeat(expectedMax);
const overName = "a".repeat(expectedMax + 1);

assert.strictEqual(
  validateTaskName(maxName),
  null,
  `имя длиной ${expectedMax} символов допустимо`
);
assert.ok(
  validateTaskName(overName),
  `имя длиной ${expectedMax + 1} символов должно быть отвергнуто`
);
assert.ok(
  String(validateTaskName(overName)).includes(String(expectedMax)),
  "в ошибке указан актуальный максимум"
);

// Короткие имена всегда проходят.
assert.strictEqual(validateTaskName("Моя задача"), null);
assert.strictEqual(validateTaskName("a"), null);
assert.strictEqual(validateTaskName("   пробелы   "), null);

console.log("T-04 (default): все проверки пройдены.");
