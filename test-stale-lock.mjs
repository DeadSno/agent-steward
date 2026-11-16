// T-03: stale-lock должен вытесняться атомарным rename, а не удаляться напрямую.
// Иначе два воркера, одновременно снимающие один и тот же зависший lock, могли
// снести свежий lock, созданный другим, и запустить задачу повторно.
//
// Запуск: node test-stale-lock.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-stale-lock-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const lockDir = path.join(tempRoot, "locks");
fs.mkdirSync(lockDir, { recursive: true });

const { LockManager } = await import("./dist/core/lock.js");
const { STALE_LOCK_MAX_AGE_MS } = await import("./dist/types.js");

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
};

const OLD = new Date(Date.now() - STALE_LOCK_MAX_AGE_MS - 60_000);

// --- 1. Два воркера одновременно чистят один и тот же stale lock ---
{
  const lockFile = path.join(lockDir, "race.lock");
  fs.writeFileSync(lockFile, String(Date.now() - STALE_LOCK_MAX_AGE_MS - 60_000), "utf8");
  fs.utimesSync(lockFile, OLD, OLD);

  const a = new LockManager(lockDir);
  const b = new LockManager(lockDir);
  await Promise.all([a.initialize(), b.initialize()]);

  check("гонка: stale .lock вытеснен", !fs.existsSync(lockFile));
  const leftovers = fs.readdirSync(lockDir).filter((f) => f.includes(".stale-"));
  check(
    "гонка: временные .stale-* артефакты убраны",
    leftovers.length === 0,
    leftovers.join(", ")
  );
}

// --- 2. Свежий lock не трогается ---
{
  const lockFile = path.join(lockDir, "fresh.lock");
  fs.writeFileSync(lockFile, "fresh", "utf8");

  const a = new LockManager(lockDir);
  await a.initialize();

  check("свежий .lock не тронут", fs.existsSync(lockFile));
}

// --- 3. Stale .lock.d (POSIX mkdir-lock) вытесняется ---
{
  const lockDirPath = path.join(lockDir, "dir.lock.d");
  fs.mkdirSync(lockDirPath, { recursive: true });
  fs.writeFileSync(path.join(lockDirPath, "pid"), "999999", "utf8");
  fs.utimesSync(lockDirPath, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check("stale .lock.d вытеснен", !fs.existsSync(lockDirPath));
}

// --- 4. Осиротевший артефакт .stale-* чистится при следующем старте ---
{
  const artifact = path.join(lockDir, "old.lock.stale-123-456");
  fs.writeFileSync(artifact, "artifact", "utf8");

  const a = new LockManager(lockDir);
  await a.initialize();

  check("осиротевший .stale-* артефакт удалён", !fs.existsSync(artifact));
}

const failed = results.filter((r) => !r.ok);
console.log(`\nStale lock: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
