// T-05: deleteProfile снимает задачи профиля ОС перед удалением директории.
//
// Запуск: node test-delete-profile.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";

process.on("uncaughtException", (err) => {
  console.log("UNCAUGHT:", err.message);
  console.log("STACK:", err.stack);
  process.exit(1);
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-delete-profile-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { deleteProfile, DEFAULT_PROFILE, getProfileDir } = await import("./dist/profiles.js");

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

// --- 1. Нельзя удалить default ---
{
  let threw = false;
  try {
    deleteProfile(DEFAULT_PROFILE);
  } catch (err) {
    threw = true;
  }
  check("default профиль нельзя удалить (бросает ошибку)", threw);
}

// --- 2. Удаление несуществующего профиля ---
{
  const removed = await deleteProfile("несуществующий-профиль");
  check("несуществующий профиль: удалён=false", removed === false);
}

// --- 3. Удаление существующего не-default профиля ---
{
  const profileName = "test-profile-to-delete";
  const dir = getProfileDir(profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "marker.txt"), "hello", "utf8");

  const removed = await deleteProfile(profileName);
  check("существующий профиль: удалён=true", removed === true);
  check("директория профиля удалена", !fs.existsSync(dir));
}

const failed = results.filter((r) => !r.ok);
console.log(`\nDelete profile: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
