// B5: installEntry не снимает паузу у paused-задачи, а ошибки launchctl
// (битый plist, права) возвращаются вызывающему с stderr и exit code.
// Реальный launchctl есть только на macOS, поэтому проверяется план команд
// и обработка ошибок через подставной runner.
import fs from "node:fs";
import {
  describeLaunchctlError,
  launchctlPauseOverrideArgs,
  MacScheduler,
  modernLaunchctlArgs,
  planLaunchctlInstall,
  runLaunchctl,
  runLaunchctlModern,
  supportsModernLaunchctl,
} from "./dist/core/scheduler/mac.js";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`OK   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const plist = "/Users/test/Library/LaunchAgents/com.opencode.scheduler.demo.plist";

// --- B5.1: paused не загружается -------------------------------------------------

{
  const plan = planLaunchctlInstall(false, plist);
  check(
    "активная задача: unload → write → load -w",
    JSON.stringify(plan.beforeWrite) === JSON.stringify(["unload", plist]) &&
      JSON.stringify(plan.afterWrite) === JSON.stringify(["load", "-w", plist]),
    JSON.stringify(plan),
  );
}

{
  const plan = planLaunchctlInstall(true, plist);
  const allArgs = [...plan.beforeWrite, ...(plan.afterWrite ?? [])];
  check("paused: после записи нет load", plan.afterWrite === null, JSON.stringify(plan));
  check(
    "paused: load -w не вызывается ни в одной фазе",
    !allArgs.includes("load"),
    JSON.stringify(allArgs),
  );
  check(
    "paused: unload -w фиксирует Disabled",
    JSON.stringify(plan.beforeWrite) === JSON.stringify(["unload", "-w", plist]),
    JSON.stringify(plan.beforeWrite),
  );
}

// --- B5.2: ошибки launchctl пробрасываются ---------------------------------------

{
  const calls = [];
  await runLaunchctl(async (args) => void calls.push(args), ["load", "-w", plist]);
  check("успешный запуск вызывает runner один раз", calls.length === 1, JSON.stringify(calls));

  const failure = Object.assign(new Error("Command failed"), {
    code: 1,
    stdout: "",
    stderr: "Invalid property list\n",
  });
  let thrown = null;
  try {
    await runLaunchctl(async () => {
      throw failure;
    }, ["load", "-w", plist]);
  } catch (err) {
    thrown = err;
  }
  check("битый plist даёт ошибку установки", thrown instanceof Error);
  check(
    "ошибка содержит команду launchctl",
    Boolean(thrown && thrown.message.includes(`launchctl load -w ${plist}`)),
    thrown?.message,
  );
  check(
    "ошибка содержит exit code и stderr",
    Boolean(thrown && thrown.message.includes("код 1") && thrown.message.includes("Invalid property list")),
    thrown?.message,
  );
  check("исходная ошибка сохранена в cause", thrown?.cause === failure);
}

{
  const failure = Object.assign(new Error("spawn launchctl ENOENT"), { code: "ENOENT" });
  const message = describeLaunchctlError(["unload", plist], failure);
  check(
    "без stderr используется message, код сохраняется",
    message.includes("код ENOENT") && message.includes("spawn launchctl ENOENT"),
    message,
  );
}

{
  let called = 0;
  await runLaunchctl(
    async () => {
      called++;
      throw Object.assign(new Error("Could not find specified service"), { code: 113 });
    },
    ["unload", plist],
    { tolerateFailure: true },
  );
  check("tolerateFailure: unload незагруженного агента не падает", called === 1);
}

// --- ML-1: bootstrap/bootout вместо load/unload -w --------------------------
{
  const uid = process.getuid?.() ?? 501;
  check(
    "ML-1: load -w → bootstrap gui/<uid>",
    JSON.stringify(modernLaunchctlArgs(["load", "-w", plist], uid)) ===
      JSON.stringify(["bootstrap", `gui/${uid}`, plist]),
  );
  check(
    "ML-1: unload -w → bootout gui/<uid>",
    JSON.stringify(modernLaunchctlArgs(["unload", "-w", plist], uid)) ===
      JSON.stringify(["bootout", `gui/${uid}`, plist]),
  );
  const other = ["print", plist];
  check("ML-1: прочие команды не меняются", modernLaunchctlArgs(other, uid) === other);
  check("ML-1: macOS 13+ использует современные команды", supportsModernLaunchctl("darwin", "22.6.0") === true);
  check("ML-1: macOS 12 использует legacy", supportsModernLaunchctl("darwin", "21.6.0") === false);
}

{
  const calls = [];
  await runLaunchctlModern(async (args) => {
    calls.push(args);
    if (args[0] === "bootstrap") {
      throw Object.assign(new Error("unrecognized subcommand"), { stderr: "unrecognized subcommand: bootstrap" });
    }
  }, ["load", "-w", plist]);
  check(
    "ML-1: фолбэк на legacy load -w при отсутствии bootstrap",
    calls.length === 2 &&
      calls[0][0] === "bootstrap" &&
      JSON.stringify(calls[1]) === JSON.stringify(["load", "-w", plist]),
    JSON.stringify(calls),
  );
}

{
  const pausedPlan = planLaunchctlInstall(true, plist);
  const calls = [];
  await runLaunchctlModern(async (args) => void calls.push(args), pausedPlan.beforeWrite);
  check(
    "ML-1: приостановленная задача не загружается (только bootout)",
    calls.length === 1 && calls[0][0] === "bootout" && pausedPlan.afterWrite === null,
    JSON.stringify(calls),
  );
}

// --- QW-3: пауза переживает перелогин на macOS 13+ -------------------------
{
  const uid = process.getuid?.() ?? 501;
  const label = "com.opencode.scheduler.demo";
  check(
    "QW-3: пауза = disable gui/<uid>/<label>",
    JSON.stringify(launchctlPauseOverrideArgs(plist, true, uid)) ===
      JSON.stringify(["disable", `gui/${uid}/${label}`]),
    JSON.stringify(launchctlPauseOverrideArgs(plist, true, uid)),
  );
  check(
    "QW-3: возобновление = enable gui/<uid>/<label>",
    JSON.stringify(launchctlPauseOverrideArgs(plist, false, uid)) ===
      JSON.stringify(["enable", `gui/${uid}/${label}`]),
    JSON.stringify(launchctlPauseOverrideArgs(plist, false, uid)),
  );
}

{
  const scheduler = new MacScheduler("default");
  const calls = [];
  scheduler.launchctl = async (args) => void calls.push(args);
  const entry = {
    name: "qw3-pause",
    schedule: "0 3 * * *",
    command: "echo qw3",
    triggerType: "cron",
    paused: false,
    createdAt: new Date().toISOString(),
  };
  await scheduler.applyPause(entry, true);
  check(
    "QW-3: applyPause(true) = unload -w (→ bootout) → disable",
    calls.length === 2 && calls[0][0] === "unload" && calls[1][0] === "disable",
    JSON.stringify(calls),
  );
  calls.length = 0;
  await scheduler.applyPause(entry, false);
  check(
    "QW-3: applyPause(false) = enable → load -w (→ bootstrap)",
    calls.length === 2 && calls[0][0] === "enable" && calls[1][0] === "load",
    JSON.stringify(calls),
  );
}

{
  const scheduler = new MacScheduler("default");
  const calls = [];
  scheduler.launchctl = async (args) => void calls.push(args);
  const entry = {
    name: "qw3-install",
    schedule: "0 3 * * *",
    command: "echo qw3",
    triggerType: "cron",
    paused: true,
    createdAt: new Date().toISOString(),
  };
  const real = {
    mkdir: fs.promises.mkdir,
    writeFile: fs.promises.writeFile,
    rename: fs.promises.rename,
  };
  fs.promises.mkdir = async () => {};
  fs.promises.writeFile = async () => {};
  fs.promises.rename = async () => {};
  try {
    await scheduler.installEntry(entry);
  } finally {
    fs.promises.mkdir = real.mkdir;
    fs.promises.writeFile = real.writeFile;
    fs.promises.rename = real.rename;
  }
  check(
    "QW-3: установка paused-задачи заканчивается disable",
    calls.length === 2 && calls[0][0] === "unload" && calls[1][0] === "disable",
    JSON.stringify(calls),
  );

  calls.length = 0;
  entry.paused = false;
  fs.promises.mkdir = async () => {};
  fs.promises.writeFile = async () => {};
  fs.promises.rename = async () => {};
  try {
    await scheduler.installEntry(entry);
  } finally {
    fs.promises.mkdir = real.mkdir;
    fs.promises.writeFile = real.writeFile;
    fs.promises.rename = real.rename;
  }
  check(
    "QW-3: установка активной задачи = unload → enable → load -w",
    calls.length === 3 &&
      calls[0][0] === "unload" &&
      calls[1][0] === "enable" &&
      calls[2][0] === "load",
    JSON.stringify(calls),
  );
}

// --- O-2: ошибки уборки plist логируются и не подменяют исходную ошибку ---
{
  const scheduler = new MacScheduler("default");
  scheduler.launchctl = async () => {}; // реальный launchctl есть только на macOS
  const entry = {
    name: "o2-temp",
    schedule: "0 3 * * *",
    command: "echo o2",
    triggerType: "cron",
    paused: false,
    createdAt: new Date().toISOString(),
  };
  const real = {
    mkdir: fs.promises.mkdir,
    writeFile: fs.promises.writeFile,
    rm: fs.promises.rm,
    unlink: fs.promises.unlink,
    warn: console.warn,
  };
  const warnings = [];
  fs.promises.mkdir = async () => {};
  fs.promises.writeFile = async () => {
    throw new Error("O2_WRITE_SENTINEL");
  };
  fs.promises.rm = async (target) => {
    throw new Error(`O2_RM_SENTINEL:${target}`);
  };
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let thrown = null;
  try {
    await scheduler.installEntry(entry);
  } catch (err) {
    thrown = err;
  } finally {
    fs.promises.mkdir = real.mkdir;
    fs.promises.writeFile = real.writeFile;
    fs.promises.rm = real.rm;
    console.warn = real.warn;
  }
  check(
    "O-2: ошибка записи plist не подменена ошибкой cleanup",
    thrown?.message === "O2_WRITE_SENTINEL",
    thrown?.message,
  );
  check(
    "O-2: ошибка удаления temp plist попадает в warn",
    warnings.some((w) => w.includes("O2_RM_SENTINEL")),
    warnings.join(" | "),
  );
}

{
  const scheduler = new MacScheduler("default");
  scheduler.launchctl = async () => {};
  const entry = {
    name: "o2-uninstall",
    schedule: "0 3 * * *",
    command: "echo o2",
    triggerType: "cron",
    paused: false,
    createdAt: new Date().toISOString(),
  };
  const real = { warn: console.warn, unlink: fs.promises.unlink };
  const warnings = [];
  fs.promises.unlink = async () => {
    throw new Error("O2_UNLINK_SENTINEL");
  };
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let thrown = null;
  try {
    await scheduler.uninstallEntry(entry);
  } catch (err) {
    thrown = err;
  } finally {
    console.warn = real.warn;
    fs.promises.unlink = real.unlink;
  }
  check("O-2: uninstallEntry не падает при ошибке unlink", thrown === null, thrown?.message);
  check(
    "O-2: ошибка unlink plist попадает в warn",
    warnings.some((w) => w.includes("O2_UNLINK_SENTINEL")),
    warnings.join(" | "),
  );
}

// QW-11: фоновый cleanup one-shot должен переживать выход launchd-джобы,
// а стампы *.once-*.done не должны копиться в ~/Library/LaunchAgents.
{
  const scheduler = new MacScheduler("default");
  const entry = {
    name: "demo",
    schedule: "0 3 * * *",
    command: "echo demo",
    triggerType: "cron",
    paused: false,
    createdAt: new Date().toISOString(),
  };
  const macSource = fs.readFileSync(new URL("./dist/core/scheduler/mac.js", import.meta.url), "utf8");
  check(
    "QW-11: plist содержит AbandonProcessGroup=true",
    macSource.includes("<key>AbandonProcessGroup</key>") && macSource.includes("<true/>"),
  );

  const label = "com.opencode.scheduler.demo";
  const real = { readdir: fs.promises.readdir, unlink: fs.promises.unlink };
  const unlinked = [];
  fs.promises.readdir = async () => [
    `${label}.once-123.done`,
    `${label}.other`,
    `com.opencode.scheduler.other.once-456.done`,
    `${label}.once-789.txt`,
  ];
  fs.promises.unlink = async (target) => {
    unlinked.push(String(target));
  };
  scheduler.launchctl = async () => {};
  try {
    await scheduler.uninstallEntry(entry);
  } finally {
    fs.promises.readdir = real.readdir;
    fs.promises.unlink = real.unlink;
  }
  check(
    "QW-11: uninstallEntry удаляет только свои *.once-*.done стампы",
    unlinked.some((p) => p.endsWith(`${label}.once-123.done`)) &&
      !unlinked.some((p) => p.includes(".other")) &&
      !unlinked.some((p) => p.includes(".once-789.txt")),
    unlinked.join(" | "),
  );
}

if (failures > 0) {
  console.error(`\n${failures} проверка(и) провалена.`);
  process.exit(1);
}
console.log("Все проверки пройдены (mac launchctl).");

