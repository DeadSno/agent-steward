// P1-12: Linux one-shot pause/resume не должен терять paused в реестре.
// Тест не трогает реальный crontab/at: используется временный профиль и
// one-shot-запись без atJobId.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sched-p1-12-"));
process.env.OPENCODE_SCHEDULER_HOME = path.join(root, "opencode", "windows-scheduler");
process.env.OPENCODE_SCHEDULER_DB = path.join(root, "scheduler.db");

const { LinuxScheduler } = await import(
  pathToFileURL(path.resolve("dist/core/scheduler/linux.js")).href
);

class TestScheduler extends LinuxScheduler {
  get registryRef() {
    return this.registry;
  }
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}

const scheduler = new TestScheduler("p1-12-test");
const base = {
  schedule: "",
  command: "/bin/true",
  triggerType: "once",
  createdAt: new Date().toISOString(),
};

try {
  // 1. Пауза one-shot: реестр должен сохранить paused:true.
  const name = "P1-12 One Shot";
  const runAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await scheduler.registryRef.upsert({ ...base, name, runAt, paused: false });

  await scheduler.pauseTask(name);

  const pausedEntry = (await scheduler.registryRef.load()).find((e) => e.name === name);
  check("pause one-shot: в реестре paused:true", pausedEntry?.paused === true, JSON.stringify(pausedEntry));

  const pausedList = (await scheduler.listTasks()).find((t) => t.taskName === name);
  check(
    "pause one-shot: listTasks отдаёт Disabled, а не Ready",
    pausedList?.status === "Disabled" && pausedList?.paused === true,
    JSON.stringify(pausedList),
  );

  // 2. Resume one-shot с runAt в прошлом: предупреждение, а не тишина.
  const pastName = "P1-12 Past One Shot";
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await scheduler.registryRef.upsert({ ...base, name: pastName, runAt: past, paused: true });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await scheduler.resumeTask(pastName);
  } finally {
    console.warn = originalWarn;
  }

  check(
    "resume one-shot в прошлом: есть предупреждение",
    warnings.some((w) => w.includes("уже прошло")),
    JSON.stringify(warnings),
  );

  const resumedEntry = (await scheduler.registryRef.load()).find((e) => e.name === pastName);
  check("resume one-shot в прошлом: paused снят", resumedEntry?.paused === false);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
