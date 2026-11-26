// QA-D316-15: ответ schedule_task не должен показывать неявный cwd,
// который не сохранён в definition и не виден в dry_run.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qa-d316-15-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { getTask } = await import("./dist/db/tasks-repo.js");
const { createToolHandlers } = await import("./dist/index.js");

let passed = 0;
function check(label, condition) {
  if (!condition) throw new Error(label);
  passed++;
}

function parseResult(result) {
  return JSON.parse(typeof result === "string" ? result : result.content);
}

initDb();
const handlers = createToolHandlers({});
const implicitName = "QA-D316-15-Implicit";
const explicitName = "QA-D316-15-Explicit";
try {
  const implicit = parseResult(
    await handlers.schedule_task({
      name: implicitName,
      schedule: "0 0 1 1 *",
      prompt: "x",
    }),
  );
  // V009-6: при падении в CI-message видно только булево success — печатаем
  // полный ответ, чтобы диагностика не требовала локальной репродукции локали.
  if (implicit.success !== true) {
    console.error("schedule_task (без cwd):", JSON.stringify(implicit));
  }
  check("schedule_task создал задачу без явного cwd", implicit.success === true);
  check(
    "QA-D316-15: ответ не показывает неявный каталог проекта",
    implicit.task?.workingDirectory === null,
  );
  check(
    "QA-D316-15: definition тоже не содержит неявный cwd",
    getTask(implicitName)?.workingDirectory === undefined,
  );

  const explicit = parseResult(
    await handlers.schedule_task({
      name: explicitName,
      schedule: "0 0 1 1 *",
      prompt: "x",
      workingDirectory: tempRoot,
    }),
  );
  check("schedule_task создал задачу с явным cwd", explicit.success === true);
  check(
    "QA-D316-15: явный cwd показан в ответе",
    explicit.task?.workingDirectory === tempRoot,
  );
  check(
    "QA-D316-15: явный cwd сохранён в definition",
    getTask(explicitName)?.workingDirectory === tempRoot,
  );
} finally {
  for (const name of [implicitName, explicitName]) {
    try {
      await handlers.delete_task({ name });
    } catch {
      // Задача мога не создаться при падении теста.
    }
  }
  closeDb();
}

console.log(`test-workdir-response: ${passed} проверок пройдено`);
