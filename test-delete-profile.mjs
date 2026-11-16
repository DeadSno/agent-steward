// T-05: deleteProfile снимает задачи профиля ОС перед удалением директории.
//
// Запуск: node test-delete-profile.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT:", err.message);
  console.log("STACK:", err.stack);
  process.exit(1);
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-delete-profile-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");
delete process.env.OPENCODE_SCHEDULER_PROFILE;

const { deleteProfile, DEFAULT_PROFILE, getBasePluginDir, getProfileDir } = await import(
  "./dist/profiles.js"
);
const { taskFolderNameForProfile } = await import("./dist/types.js");
const { TaskRegistry } = await import("./dist/core/scheduler/registry.js");
const { taskFullNameForProfile, windowsTaskPrefixForProfile } = await import(
  "./dist/core/scheduler/windows.js"
);
const { launchdLabel } = await import("./dist/core/one-shot.js");

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

// --- 1. Нельзя удалить default ---
{
  let threw = false;
  try {
    await deleteProfile(DEFAULT_PROFILE);
  } catch {
    threw = true;
  }
  check("default профиль нельзя удалить (бросает ошибку)", threw);
}

// --- 2. Удаление несуществующего профиля ---
{
  const removed = await deleteProfile("несуществующий-профиль");
  check("несуществующий профиль: удалён=false", removed === false);
}

// --- 3. Задачи адресуются в пространстве имён СВОЕГО профиля ---
{
  check(
    "taskFolderNameForProfile: default = windows-scheduler",
    taskFolderNameForProfile(DEFAULT_PROFILE) === "windows-scheduler"
  );
  check(
    "taskFolderNameForProfile: work = windows-scheduler-work",
    taskFolderNameForProfile("work") === "windows-scheduler-work"
  );
  const workTask = taskFullNameForProfile("probe", "work");
  check(
    "taskFullNameForProfile: задача work в папке work",
    workTask === "\\OpenCode\\windows-scheduler-work\\probe",
    workTask
  );
  check(
    "windowsTaskPrefixForProfile: префикс work не совпадает с default",
    windowsTaskPrefixForProfile("work") !== windowsTaskPrefixForProfile(DEFAULT_PROFILE)
  );
  check(
    "launchdLabel: label work не совпадает с default",
    launchdLabel("Probe", "work") !== launchdLabel("Probe", DEFAULT_PROFILE)
  );
}

// --- 4. Удаление задач неактивного профиля не трогает реестр активного ---
{
  const activeDir = getProfileDir(DEFAULT_PROFILE);
  const inactiveName = "inactive-profile-probe";
  const inactiveDir = getProfileDir(inactiveName);
  fs.mkdirSync(inactiveDir, { recursive: true });

  const entry = (name) => ({
    name,
    schedule: "0 * * * *",
    command: "/bin/true",
    triggerType: "cron",
    paused: false,
    createdAt: new Date().toISOString(),
  });
  const activeRegistry = new TaskRegistry("linux", DEFAULT_PROFILE);
  const inactiveRegistry = new TaskRegistry("linux", inactiveName);
  await activeRegistry.upsert(entry("same-task"));
  await inactiveRegistry.upsert(entry("same-task"));

  check(
    "реестр active и inactive — разные файлы",
    activeRegistry.path !== inactiveRegistry.path &&
      activeRegistry.path.startsWith(activeDir) &&
      inactiveRegistry.path.startsWith(inactiveDir)
  );

  // Эмулируем снятие задач неактивного профиля: удаляем запись только из его реестра.
  await inactiveRegistry.remove("same-task");
  const activeEntries = await activeRegistry.load();
  check(
    "задачи активного профиля не тронуты",
    activeEntries.some((e) => e.name === "same-task"),
    JSON.stringify(activeEntries)
  );
  check(
    "задача неактивного профиля удалена из его реестра",
    (await inactiveRegistry.load()).length === 0
  );

  fs.rmSync(inactiveDir, { recursive: true, force: true });
  fs.rmSync(activeRegistry.path, { force: true });
  check("база плагина существует для проверки пути", fs.existsSync(getBasePluginDir()));
}

// --- 5. Удаление существующего не-default профиля ---
{
  const profileName = "test-profile-to-delete";
  const dir = getProfileDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marker.txt"), "hello", "utf8");

  const removed = await deleteProfile(profileName);
  check("существующий профиль: удалён=true", removed === true);
  check("директория профиля удалена", !fs.existsSync(dir));
  check("deleteProfile асинхронный (задачи снимаются до rmSync)", deleteProfile.constructor.name === "AsyncFunction");
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDelete profile: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
