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

const { isProcessAlive, LockManager, withLock, withLockWait } = await import("./dist/core/lock.js");
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

// --- 3. Stale .lock.d (POSIX mkdir-lock) мёртвого владельца вытесняется ---
{
  const lockDirPath = path.join(lockDir, "dir.lock.d");
  fs.mkdirSync(lockDirPath, { recursive: true });
  fs.writeFileSync(path.join(lockDirPath, "pid"), "999999", "utf8");
  fs.utimesSync(lockDirPath, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check("stale .lock.d мёртвого владельца вытеснен", !fs.existsSync(lockDirPath));
}

// --- 3a. B7: stale .lock.d живого владельца НЕ вытесняется ---
{
  const lockDirPath = path.join(lockDir, "dir-live.lock.d");
  fs.mkdirSync(lockDirPath, { recursive: true });
  const liveToken = `${process.pid}-${new Date().toISOString()}`;
  fs.writeFileSync(path.join(lockDirPath, "pid"), liveToken, "utf8");
  fs.utimesSync(lockDirPath, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check(
    "B7: stale .lock.d живого процесса не вытеснен",
    fs.existsSync(lockDirPath) &&
      fs.readFileSync(path.join(lockDirPath, "pid"), "utf8") === liveToken
  );
  fs.rmSync(lockDirPath, { recursive: true, force: true });
}

// --- 3b. B7: .lock.d без pid-файла вытесняется по возрасту (fallback) ---
{
  const lockDirPath = path.join(lockDir, "dir-nopid.lock.d");
  fs.mkdirSync(lockDirPath, { recursive: true });
  fs.writeFileSync(path.join(lockDirPath, "notes"), "no pid", "utf8");
  fs.utimesSync(lockDirPath, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check("B7: stale .lock.d без pid вытеснен по возрасту", !fs.existsSync(lockDirPath));
}

// --- 4. Осиротевший артефакт .stale-* чистится при следующем старте ---
{
  const artifact = path.join(lockDir, "old.lock.stale-123-456");
  fs.writeFileSync(artifact, "artifact", "utf8");

  const a = new LockManager(lockDir);
  await a.initialize();

  check("осиротевший .stale-* артефакт удалён", !fs.existsSync(artifact));
}

// --- 5. Свой lock снимается только со своим токеном ---
{
  const a = new LockManager(lockDir);
  const token = await a.acquire("owner");
  check("acquire: возвращает непустой токен", typeof token === "string" && token.length > 10);
  check(
    "acquire: в файле лежит именно токен",
    fs.readFileSync(path.join(lockDir, "owner.lock"), "utf8") === token
  );

  const released = await a.release("owner", token);
  check("release: свой lock снят", released === true && !fs.existsSync(path.join(lockDir, "owner.lock")));
}

// --- 6. Чужой/поддельный токен не снимает lock ---
{
  const owner = new LockManager(lockDir);
  const token = await owner.acquire("foreign");
  const stranger = new LockManager(lockDir);
  const released = await stranger.release("foreign", "not-my-token");
  check(
    "release: чужой токен не снимает lock",
    released === false && fs.existsSync(path.join(lockDir, "foreign.lock"))
  );
  check(
    "release: содержимое чужого lock не изменилось",
    fs.readFileSync(path.join(lockDir, "foreign.lock"), "utf8") === token
  );
  await owner.release("foreign", token);
}

// --- 7. Вытесненный владелец не сносит lock нового владельца ---
{
  const oldOwner = new LockManager(lockDir);
  const oldToken = await oldOwner.acquire("evicted");
  const livePath = path.join(lockDir, "evicted.lock");

  // Имитируем вытеснение по staleMs: старый файл унесли, новый владелец взял lock.
  const stalePath = `${livePath}.stale-test`;
  fs.renameSync(livePath, stalePath);
  fs.rmSync(stalePath, { force: true });

  const newOwner = new LockManager(lockDir);
  const newToken = await newOwner.acquire("evicted");
  const released = await oldOwner.release("evicted", oldToken);

  check(
    "вытеснение: старый владелец не снял новый lock",
    released === false &&
      fs.existsSync(livePath) &&
      fs.readFileSync(livePath, "utf8") === newToken
  );
  await newOwner.release("evicted", newToken);
}

// --- 8. withLock / withLockWait снимают lock после работы ---
{
  const manager = new LockManager(lockDir);
  let calls = 0;
  const first = await withLock(manager, "with-lock", async () => {
    calls += 1;
    check("withLock: lock удерживается во время fn", fs.existsSync(path.join(lockDir, "with-lock.lock")));
    return "ok";
  });
  check("withLock: результат возвращён и lock снят", first === "ok" && calls === 1 && !fs.existsSync(path.join(lockDir, "with-lock.lock")));

  const second = await withLockWait(
    manager,
    "with-lock-wait",
    async () => {
      calls += 1;
      return 42;
    },
    { timeoutMs: 500 }
  );
  check("withLockWait: результат возвращён и lock снят", second === 42 && calls === 2 && !fs.existsSync(path.join(lockDir, "with-lock-wait.lock")));
}

// --- 9. withLock пропускает запуск, если lock уже занят ---
{
  const manager = new LockManager(lockDir);
  const token = await manager.acquire("busy");
  let ran = false;
  const result = await withLock(manager, "busy", async () => {
    ran = true;
    return "should-not-run";
  });
  check("withLock: занятый lock не запускает fn", result === null && ran === false);
  await manager.release("busy", token);
}

// --- 10. P2-18: живой владелец старого lock не вытесняется при initialize ---
{
  check("liveness: текущий процесс жив", isProcessAlive(process.pid) === true);
  check("liveness: заведомо мёртвый pid не жив", isProcessAlive(999999999) === false);

  const liveOld = path.join(lockDir, "live-old.lock");
  const liveToken = `${process.pid}-${Date.now()}-live-owner`;
  fs.writeFileSync(liveOld, liveToken, "utf8");
  fs.utimesSync(liveOld, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check(
    "P2-18: старый lock живого процесса не вытеснен",
    fs.existsSync(liveOld) && fs.readFileSync(liveOld, "utf8") === liveToken
  );
  fs.rmSync(liveOld, { force: true });
}

// --- 11. P2-18: старый lock мёртвого процесса вытесняется при initialize ---
{
  const deadOld = path.join(lockDir, "dead-old.lock");
  fs.writeFileSync(deadOld, `999999999-${Date.now()}-dead-owner`, "utf8");
  fs.utimesSync(deadOld, OLD, OLD);

  const a = new LockManager(lockDir);
  await a.initialize();

  check("P2-18: старый lock мёртвого процесса вытеснен", !fs.existsSync(deadOld));
}

// --- 12. P2-18: withLockWait не вытесняет живой старый lock и упирается в таймаут ---
{
  const manager = new LockManager(lockDir);
  const token = await manager.acquire("wait-live");
  const livePath = path.join(lockDir, "wait-live.lock");
  fs.utimesSync(livePath, OLD, OLD);

  let threw = false;
  try {
    await withLockWait(
      manager,
      "wait-live",
      async () => "must-not-run",
      { timeoutMs: 300, retryDelayMs: 20, staleMs: 60_000 }
    );
  } catch (err) {
    threw = /Не удалось получить блокировку/.test(String(err?.message ?? err));
  }

  check(
    "P2-18: withLockWait не забрал lock живого владельца",
    threw && fs.existsSync(livePath) && fs.readFileSync(livePath, "utf8") === token
  );
  await manager.release("wait-live", token);
}

// --- 13. P2-18: withLockWait вытесняет старый lock мёртвого владельца и выполняет fn ---
{
  const manager = new LockManager(lockDir);
  const deadPath = path.join(lockDir, "wait-dead.lock");
  fs.writeFileSync(deadPath, `999999999-${Date.now()}-dead-owner`, "utf8");
  fs.utimesSync(deadPath, OLD, OLD);

  let ran = false;
  const result = await withLockWait(
    manager,
    "wait-dead",
    async () => {
      ran = true;
      return "ran";
    },
    { timeoutMs: 3000, retryDelayMs: 20, staleMs: 60_000 }
  );

  check(
    "P2-18: withLockWait вытеснил мёртвый lock и выполнил fn",
    result === "ran" && ran === true && !fs.existsSync(deadPath)
  );
}

// --- 14. O-2: ошибки cleanup не маскируются, а попадают в console.warn ---
{
  const artifact = path.join(lockDir, "warn.lock.stale-777");
  fs.writeFileSync(artifact, "artifact", "utf8");
  const realRm = fs.promises.rm;
  const realWarn = console.warn;
  const warnings = [];
  fs.promises.rm = async (target, options) => {
    if (String(target) === artifact) {
      throw Object.assign(new Error("O2_CLEANUP_SENTINEL"), { code: "EPERM" });
    }
    return realRm(target, options);
  };
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let initializeError = null;
  try {
    await new LockManager(lockDir).initialize();
  } catch (err) {
    initializeError = err;
  } finally {
    fs.promises.rm = realRm;
    console.warn = realWarn;
  }
  check("O-2: initialize не падает при ошибке удаления .stale-*", initializeError === null);
  check(
    "O-2: причина ошибки cleanup видна в предупреждении",
    warnings.some((w) => w.includes("O2_CLEANUP_SENTINEL") && w.includes(artifact)),
    warnings.join(" | "),
  );
  fs.rmSync(artifact, { force: true });
}

// --- 14b. O-2: withLockWait продолжает работу, если stale-артефакт не удалился ---
{
  const manager = new LockManager(lockDir);
  const deadPath = path.join(lockDir, "warn-wait.lock");
  fs.writeFileSync(deadPath, `999999999-${Date.now()}-o2`, "utf8");
  fs.utimesSync(deadPath, OLD, OLD);

  const realRm = fs.promises.rm;
  const realWarn = console.warn;
  const warnings = [];
  fs.promises.rm = async (target, options) => {
    if (String(target).includes(".stale-")) throw new Error("O2_WAIT_SENTINEL");
    return realRm(target, options);
  };
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  let result;
  try {
    result = await withLockWait(
      manager,
      "warn-wait",
      async () => "ran",
      { timeoutMs: 3000, retryDelayMs: 20, staleMs: 60_000 },
    );
  } finally {
    fs.promises.rm = realRm;
    console.warn = realWarn;
  }
  check("O-2: withLockWait выполняет fn при ошибке удаления артефакта", result === "ran");
  check(
    "O-2: предупреждение withLockWait содержит причину",
    warnings.some((w) => w.includes("O2_WAIT_SENTINEL")),
    warnings.join(" | "),
  );
  fs.rmSync(deadPath, { force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\nStale lock: ${results.length - failed.length}/${results.length} проверок пройдено.`);
try {
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3 });
} catch {
  // На Windows временная папка может быть занята — не валим тест.
}
process.exit(failed.length > 0 ? 1 : 0);
