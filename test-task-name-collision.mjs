import assert from "node:assert/strict";
import {
  findSanitizedNameConflict,
  sanitizedConflictMessage,
} from "./dist/core/task-name.js";
import { sanitizeName, validateTaskName } from "./dist/types.js";

// P1-10.T1.1 / T2.1: разные исходные имена, один sanitized-идентификатор.
const noArtifacts = () => false;

const cases = [
  ["my task", "my-task"],
  ["my--task", "my-task"],
  ["My Task!", "my-task"],
  ["задача-1", "zadacha-1"],
];

for (const [newName, existingName] of cases) {
  assert.equal(
    sanitizeName(newName),
    sanitizeName(existingName),
    `«${newName}» и «${existingName}» должны сжиматься в одно имя`,
  );
  const conflict = findSanitizedNameConflict(
    newName,
    [existingName, "another-task"],
    noArtifacts,
  );
  assert.deepEqual(
    conflict,
    { kind: "task", taskName: existingName },
    `коллизия «${newName}» ↔ «${existingName}» должна быть найдена`,
  );
  const message = sanitizedConflictMessage(newName, conflict);
  assert.ok(message.includes(sanitizeName(newName)), "в ошибке есть sanitized-имя");
  assert.ok(message.includes(existingName), "в ошибке есть имя существующей задачи");
}

// Обновление той же задачи (имя совпадает без учёта регистра) — не коллизия.
assert.equal(
  findSanitizedNameConflict("my-task", ["My-Task"], noArtifacts),
  null,
  "та же задача в другом регистре не конфликтует",
);

// Разные имена с разными sanitized — не конфликтуют.
assert.equal(
  findSanitizedNameConflict("my task", ["other-task"], noArtifacts),
  null,
  "независимые задачи не конфликтуют",
);

// Осиротевший wrapper/prompt при отсутствии задачи в БД — тоже коллизия.
const orphan = findSanitizedNameConflict("my task", [], (file) =>
  file.endsWith("run-my-task.cmd"),
);
assert.equal(orphan?.kind, "file");
assert.ok(String(orphan.file).includes("run-my-task.cmd"));
const orphanMessage = sanitizedConflictMessage("my task", orphan);
assert.ok(orphanMessage.includes("старые файлы"), "ошибка советует удалить файлы");

// P1-10.T2.2: имена из одних разделителей не должны молча становиться «task».
for (const bad of ["---", "...", "."]) {
  assert.equal(sanitizeName(bad), "task", `«${bad}» действительно сжимается в task`);
  const error = validateTaskName(bad);
  assert.ok(error, `«${bad}» должно быть отвергнуто`);
  assert.ok(String(error).includes("букв"), "в ошибке объяснена причина");
}
assert.equal(validateTaskName("task"), null, "обычное имя task остаётся допустимым");
assert.equal(validateTaskName("задача-1"), null, "кириллица остаётся допустимой");

console.log("P1-10: коллизии sanitized-имени — все проверки пройдены.");
