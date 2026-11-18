// P2-17: createTask не должен оставлять запись-призрак в реестре,
// если installEntry упал (нет at, fallback не удался и т.п.).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sched-p2-17-"));
process.env.OPENCODE_SCHEDULER_HOME = home;

const { PosixSchedulerBase } = await import("./dist/core/scheduler/posix.js");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`OK   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

class FailingScheduler extends PosixSchedulerBase {
  platform = "linux";
  title = "failing";
  uninstallCalls = 0;
  async installEntry() {
    throw new Error("install failed");
  }
  async uninstallEntry() {
    this.uninstallCalls++;
  }
  async applyPause() {}
}

class WorkingScheduler extends PosixSchedulerBase {
  platform = "linux";
  title = "working";
  async installEntry(entry) {
    if (entry.triggerType === "once") entry.atJobId = "at:42";
  }
  async uninstallEntry() {}
  async applyPause() {}
}

const baseOptions = {
  name: "ghost",
  schedule: "* * * * *",
  command: "/bin/true",
  triggerType: "cron",
};

// 1. Новая задача: installEntry упал → в реестре ничего нет.
{
  const scheduler = new FailingScheduler("p2-17-new", "p2-17-new");
  let threw = false;
  try {
    await scheduler.createTask(baseOptions);
  } catch (err) {
    threw = err instanceof Error && /install failed/.test(err.message);
  }
  check("createTask пробрасывает ошибку installEntry", threw);
  const tasks = await scheduler.listTasks();
  check("после сбоя нет записи-призрака", tasks.length === 0, JSON.stringify(tasks));
  check("откат вызвал uninstallEntry", scheduler.uninstallCalls === 1);
}

// 2. Обновление существующей задачи: при сбое восстанавливается старая запись.
{
  const scheduler = new FailingScheduler("p2-17-update", "p2-17-update");
  await scheduler.registry.upsert({
    ...baseOptions,
    command: "/bin/old",
    paused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  let threw = false;
  try {
    await scheduler.createTask({ ...baseOptions, command: "/bin/new" });
  } catch {
    threw = true;
  }
  check("createTask (update) пробрасывает ошибку", threw);
  const tasks = await scheduler.listTasks();
  const stored = await scheduler.registry.find("ghost");
  check("старая запись не потеряна", tasks.length === 1 && !!stored);
  check("команда откатилась к прежней", stored?.command === "/bin/old", stored?.command);
}

// 3. Успешная установка: вторая запись сохраняет atJobId для one-shot.
{
  const scheduler = new WorkingScheduler("p2-17-ok", "p2-17-ok");
  await scheduler.createTask({
    name: "once-ok",
    schedule: "",
    command: "/bin/true",
    triggerType: "once",
    runAt: "2030-01-02T09:30:00.000Z",
  });
  const stored = await scheduler.registry.find("once-ok");
  check("успешная установка оставляет запись", !!stored);
  check("atJobId сохранён после installEntry", stored?.atJobId === "at:42", stored?.atJobId);
}

if (failures > 0) {
  console.error(`\n${failures} проверка(и) провалена.`);
  process.exit(1);
}
console.log("Все проверки пройдены (posix createTask rollback).");
