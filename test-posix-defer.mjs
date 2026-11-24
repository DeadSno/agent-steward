// QW-9: POSIX delete не должен терять запись при сбое uninstall; defer-файл
// не должен блокировать тик после гибели обёртки.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PosixSchedulerBase } from "./dist/core/scheduler/posix.js";
import { deferFileBusy, acquireDefer, releaseDefer } from "./dist/core/defer.js";

let checks = 0;
function check(name, condition) {
  checks += 1;
  assert.ok(condition, name);
  console.log(`OK   ${name}`);
}

const entry = {
  name: "probe",
  schedule: "* * * * *",
  command: "run-probe.cmd",
  logFile: "probe.log",
  workingDirectory: process.cwd(),
  triggerType: "cron",
  paused: false,
  createdAt: new Date().toISOString(),
};

class ProbeScheduler extends PosixSchedulerBase {
  constructor(failUninstall = false) {
    super("qw9-probe");
    this.calls = [];
    this.failUninstall = failUninstall;
    this.record = { ...entry };
    this.registry = {
      find: async () => (this.record ? { ...this.record } : undefined),
      remove: async (name) => {
        this.calls.push(`remove:${name}`);
        this.record = undefined;
      },
      upsert: async (value) => {
        this.calls.push(`upsert:${value.name}`);
        this.record = { ...value };
      },
    };
  }
  async installEntry() {}
  async uninstallEntry(value) {
    this.calls.push(`uninstall:${value.name}`);
    if (this.failUninstall) throw new Error("crontab write failed");
  }
  async applyPause() {}
}

const ok = new ProbeScheduler();
await ok.deleteTask("probe");
check("QW-9: запись реестра удаляется до uninstall", ok.calls[0] === "remove:probe" && ok.calls[1] === "uninstall:probe");
check("QW-9: после успешного delete реестр пуст", ok.record === undefined);

const failed = new ProbeScheduler(true);
await assert.rejects(() => failed.deleteTask("probe"), /crontab write failed/);
check("QW-9: при сбое uninstall запись реестра восстановлена", failed.record?.name === "probe");
const retry = new ProbeScheduler();
await retry.deleteTask("probe");
check("QW-9: повторный delete после сбоя снимает cron-строку", retry.calls.includes("uninstall:probe") && retry.record === undefined);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qw9-defer-"));
try {
  const deferFile = path.join(tempRoot, "task.defer");
  const now = Date.now();

  check("QW-9: acquireDefer пишет ISO|PID", (() => {
    check("QW-9: слот свободен до захвата", !deferFileBusy(deferFile, now));
    const acquired = acquireDefer(deferFile, now);
    const raw = fs.readFileSync(deferFile, "utf8");
    const [ts, pid] = raw.split("|");
    return acquired && Number(pid) === process.pid && Number.isFinite(Date.parse(ts));
  })());
  check("QW-9: живой владелец удерживает слот", deferFileBusy(deferFile, now + 60_000));
  check("QW-9: мёртвый PID освобождает слот", (() => {
    fs.writeFileSync(deferFile, `${new Date(now).toISOString()}|99999999`);
    return !deferFileBusy(deferFile, now + 60_000) && !fs.existsSync(deferFile);
  })());
  check("QW-9: legacy-файл живёт не дольше MAX_POSTPONE_MS (12 ч)", (() => {
    fs.writeFileSync(deferFile, new Date(now).toISOString());
    return (
      deferFileBusy(deferFile, now + 11 * 60 * 60 * 1000) &&
      !deferFileBusy(deferFile, now + 13 * 60 * 60 * 1000) &&
      !fs.existsSync(deferFile)
    );
  })());
  check("QW-9: битый defer-файл удаляется", (() => {
    fs.writeFileSync(deferFile, "not-a-date");
    return !deferFileBusy(deferFile, now) && !fs.existsSync(deferFile);
  })());
  check("QW-9: releaseDefer снимает слот", (() => {
    acquireDefer(deferFile, now);
    releaseDefer(deferFile);
    return !fs.existsSync(deferFile);
  })());
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`QW-9: ${checks} проверок пройдено.`);
