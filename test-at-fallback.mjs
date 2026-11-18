// P1-7.T1.2: fallback для one-shot, если `at` не установлен.
// Проверяем чистые части: распознавание ENOENT, расчёт задержки, сборку
// скрипта, запуск отвязанного процесса через инъекцию spawn и снятие по pid.
import { EventEmitter } from "node:events";
import {
  buildDetachedOneShotScript,
  cancelAtFallback,
  computeDelaySeconds,
  fallbackMarker,
  isAtMissingError,
  isPidJobId,
  pruneStaleFallbackEntries,
  scheduleAtFallback,
} from "./dist/core/scheduler/at-fallback.js";

let failures = 0;
const check = (cond, msg, detail) => {
  if (cond) {
    console.log("OK: " + msg);
  } else {
    failures += 1;
    console.error("FAIL: " + msg + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
};

const entry = (overrides = {}) => ({
  name: "at-fallback-test",
  schedule: "",
  triggerType: "once",
  runAt: new Date(Date.now() + 90_000).toISOString(),
  command: "/tmp/run-task.sh",
  logFile: null,
  ...overrides,
});

// --- isAtMissingError ----------------------------------------------------
check(isAtMissingError({ code: "ENOENT" }), "ENOENT распознаётся как отсутствие at");
check(
  isAtMissingError(new Error("spawn at ENOENT")),
  "текст ENOENT распознаётся",
);
check(
  isAtMissingError(new Error("at: not found")),
  "«not found» распознаётся",
);
check(!isAtMissingError(new Error("EACCES: permission denied")), "EACCES — не отсутствие at");
check(!isAtMissingError(null), "null — не отсутствие at");

// --- computeDelaySeconds -------------------------------------------------
{
  const now = Date.parse("2026-11-17T10:00:00Z");
  check(
    computeDelaySeconds("2026-11-17T10:01:30Z", now) === 90,
    "задержка 90 секунд",
  );
  check(
    computeDelaySeconds("2026-11-17T09:59:00Z", now) === 0,
    "прошедшее время -> 0, без отрицательного sleep",
  );
  let threw = false;
  try {
    computeDelaySeconds("не дата", now);
  } catch {
    threw = true;
  }
  check(threw, "некорректный runAt -> ошибка");
}

// --- buildDetachedOneShotScript -----------------------------------------
{
  const now = Date.parse("2026-11-17T10:00:00Z");
  const script = buildDetachedOneShotScript(
    entry({ runAt: "2026-11-17T10:00:05Z" }),
    "/bin/bash '/tmp/x y.sh' >> '/tmp/log file' 2>&1",
    now,
  );
  const marker = fallbackMarker("at-fallback-test");
  check(
    marker ===
      "opencode-scheduler-at-fallback:" +
        Buffer.from("at-fallback-test", "utf8").toString("base64url"),
    "маркер содержит base64url имени задачи",
    marker,
  );
  check(
    script ===
      `sleep 5; /bin/bash '/tmp/x y.sh' >> '/tmp/log file' 2>&1 # ${marker}`,
    "скрипт = sleep + команда с кавычками + маркер",
    script,
  );

  let threw = false;
  try {
    buildDetachedOneShotScript(entry({ runAt: undefined }), "echo", now);
  } catch {
    threw = true;
  }
  check(threw, "one-shot без runAt -> ошибка");
}

// --- scheduleAtFallback через внедрённый spawn --------------------------
{
  const calls = [];
  let unrefCalled = false;
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {
      unrefCalled = true;
    };
    process.nextTick(() => child.emit("spawn"));
    return child;
  };

  const target = entry({ runAt: new Date(Date.now() + 60_000).toISOString() });
  const jobId = await scheduleAtFallback(target, "/bin/bash '/tmp/run.sh'", {
    spawnFn: fakeSpawn,
    now: () => Date.now(),
  });

  check(jobId === "pid:4242", "scheduleAtFallback возвращает pid:<pid>", jobId);
  check(
    calls.length === 1 && calls[0].file === "/bin/bash" && calls[0].args[0] === "-c",
    "запускается /bin/bash -c <script>",
    calls,
  );
  check(
    calls[0].options.detached === true && calls[0].options.stdio === "ignore",
    "процесс отвязан и не держит stdio",
    calls[0].options,
  );
  check(/^sleep \d+; \/bin\/bash '\/tmp\/run\.sh' # opencode-scheduler-at-fallback:[A-Za-z0-9_-]+$/.test(calls[0].args[1]), "в скрипте есть sleep, команда и маркер", calls[0].args[1]);
  check(unrefCalled, "unref() вызван");
}

{
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.pid = 1;
    child.unref = () => {};
    process.nextTick(() => child.emit("error", new Error("spawn /bin/bash EACCES")));
    return child;
  };
  let message = "";
  try {
    await scheduleAtFallback(entry(), "echo ok", { spawnFn: fakeSpawn });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check(message.includes("EACCES"), "ошибка spawn прокидывается наружу", message);
}

// --- isPidJobId / cancelAtFallback --------------------------------------
check(isPidJobId("pid:4242"), "pid:4242 — fallback-задание");
check(!isPidJobId("17"), "числовой id at — не fallback");
check(!isPidJobId(undefined), "undefined — не fallback");
check(cancelAtFallback("17") === false, "cancelAtFallback не трогает at-задания");
check(cancelAtFallback("pid:0") === false, "pid:0 не снимается");
check(cancelAtFallback("pid:999999999") === false, "несуществующий pid — false без исключения");
check(cancelAtFallback("pid:4242") === false, "без имени задачи pid не снимается");

// P1-14: личность процесса проверяется по маркеру в /proc/<pid>/cmdline.
{
  const killed = [];
  const mismatch = cancelAtFallback("pid:4242", "at-fallback-test", {
    isAlive: () => false,
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  check(
    mismatch === false && killed.length === 0,
    "чужой/мёртвый pid не убивается",
    { mismatch, killed },
  );

  killed.length = 0;
  const matched = cancelAtFallback("pid:4242", "at-fallback-test", {
    isAlive: () => true,
    kill: (pid, signal) => killed.push([pid, signal]),
  });
  check(
    matched === true && killed[0]?.[0] === -4242 && killed[0]?.[1] === "SIGTERM",
    "свой pid снимается группой процессов",
    { matched, killed },
  );

  const attempts = [];
  const fallback = cancelAtFallback("pid:4242", "at-fallback-test", {
    isAlive: () => true,
    kill: (pid) => {
      attempts.push(pid);
      if (pid < 0) throw new Error("EPERM");
    },
  });
  check(
    fallback === true && attempts.join(",") === "-4242,4242",
    "если группа недоступна — kill по положительному pid",
    { fallback, attempts },
  );
}

// P1-14: очистка pid:-записей при старте.
const makeRegistry = (entries) => {
  const state = { entries, saves: 0 };
  return {
    state,
    registry: {
      load: async () => state.entries,
      save: async (list) => {
        state.saves += 1;
        state.entries = list;
      },
    },
  };
};
const pruneNow = Date.parse("2026-11-18T10:00:00Z");

{
  const alive = entry({
    name: "alive",
    atJobId: "pid:11",
    runAt: "2026-11-18T10:10:00Z",
  });
  const { state, registry } = makeRegistry([alive]);
  const report = await pruneStaleFallbackEntries(registry, {
    now: () => pruneNow,
    isAlive: (pid, name) => pid === 11 && name === "alive",
  });
  check(
    report.kept === 1 && report.removed === 0 && state.saves === 0 && alive.atJobId === "pid:11",
    "живой fallback сохраняется, реестр не перезаписывается",
    report,
  );
}

{
  const future = entry({
    name: "future",
    command: "/tmp/run.sh",
    atJobId: "pid:22",
    runAt: "2026-11-18T10:10:00Z",
  });
  const { state, registry } = makeRegistry([future]);
  const scheduled = [];
  const report = await pruneStaleFallbackEntries(registry, {
    now: () => pruneNow,
    isAlive: () => false,
    schedule: async (target, command, at) => {
      scheduled.push({ name: target.name, command, at });
      return "pid:99";
    },
  });
  check(
    report.removed === 1 &&
      report.rescheduled === 1 &&
      future.atJobId === "pid:99" &&
      scheduled[0]?.command === "/bin/bash '/tmp/run.sh'" &&
      scheduled[0]?.at === pruneNow,
    "мёртвый будущий one-shot пересоздаётся",
    { report, scheduled, atJobId: future.atJobId },
  );
  check(state.saves === 1, "после пересоздания реестр сохранён");
}

{
  const past = entry({
    name: "past",
    atJobId: "pid:33",
    runAt: "2026-11-18T09:00:00Z",
  });
  const { state, registry } = makeRegistry([past]);
  const warnings = [];
  const report = await pruneStaleFallbackEntries(registry, {
    now: () => pruneNow,
    isAlive: () => false,
    warn: (message) => warnings.push(message),
  });
  check(
    report.removed === 1 &&
      report.missed === 1 &&
      report.rescheduled === 0 &&
      past.atJobId === undefined &&
      warnings.some((message) => message.includes("время запуска уже прошло")),
    "мёртвый прошедший one-shot помечается пропущенным",
    { report, warnings, atJobId: past.atJobId },
  );
  check(state.saves === 1, "после удаления мёртвой записи реестр сохранён");
}

if (process.platform !== "linux") {
  const report = await pruneStaleFallbackEntries({
    load: async () => {
      throw new Error("load не должен вызываться");
    },
    save: async () => {},
  });
  check(
    report.skipped === true && report.removed === 0,
    "без /proc и без isAlive prune безопасно пропускается",
    report,
  );
}

console.log(
  failures === 0
    ? `\nВсе проверки пройдены (at fallback).`
    : `\nЕсть падения: ${failures}.`,
);
process.exitCode = failures === 0 ? 0 : 1;
