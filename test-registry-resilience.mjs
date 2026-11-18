// P2-16: реестр POSIX-планировщика устойчив к повреждению и параллельным записям.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sched-p2-16-"));
process.env.OPENCODE_SCHEDULER_HOME = path.join(root, "opencode", "windows-scheduler");

const { TaskRegistry } = await import(
  pathToFileURL(path.resolve("dist/core/scheduler/registry.js")).href
);

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failed += 1;
}
function entry(name) {
  return { name, schedule: "* * * * *", command: "/bin/true", triggerType: "cron", paused: false, createdAt: new Date().toISOString() };
}

try {
  // 1. Отсутствующий файл — нормальная пустая запись.
  const reg = new TaskRegistry("p2-16-basic", "p2-16-basic-profile");
  check("ENOENT: load() возвращает []", (await reg.load()).length === 0);

  // 2. Повреждённый JSON уходит в карантин и блокирует дальнейшие чтения.
  fs.mkdirSync(path.dirname(reg.path), { recursive: true });
  fs.writeFileSync(reg.path, "{ this is not json", "utf8");
  let threw = false;
  try {
    await reg.load();
  } catch (err) {
    threw = /поврежд|карантин/i.test(String(err?.message ?? err));
  }
  check("битый JSON: load() бросает понятную ошибку", threw);
  check("битый JSON: оригинальный файл удалён", !fs.existsSync(reg.path));
  const quarantine = fs.readdirSync(path.dirname(reg.path)).filter((f) => f.includes(".corrupt-"));
  const sentinel = `${path.basename(reg.path)}.blocked`;
  check("битый JSON: файл в карантине", quarantine.length === 1, quarantine.join(","));
  check("битый JSON: есть .blocked-маркер", fs.existsSync(path.join(path.dirname(reg.path), sentinel)));
  check(
    "битый JSON: маркер указывает на карантин",
    fs.readFileSync(path.join(path.dirname(reg.path), sentinel), "utf8").includes(quarantine[0] ?? "___"),
  );

  // 3. Успешная запись снимает блокировку.
  await reg.save([entry("after-recovery")]);
  check("save(): маркер снят", !fs.existsSync(path.join(path.dirname(reg.path), sentinel)));
  check("save(): валидная запись читается", (await reg.load()).length === 1);

  // 4. Параллельные RMW-операции не теряют записи.
  const parallel = new TaskRegistry("p2-16-parallel", "p2-16-parallel-profile");
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => parallel.upsert(entry(`task-${String(i).padStart(2, "0")}`))),
  );
  const all = await parallel.load();
  check("40 параллельных upsert → 40 записей", all.length === 40, String(all.length));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `FAIL: ${failed}` : "Все проверки пройдены (registry resilience).");
process.exit(failed ? 1 : 0);
