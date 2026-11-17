// P1-7.T1.2: fallback для one-shot, если `at` не установлен.
// Проверяем чистые части: распознавание ENOENT, расчёт задержки, сборку
// скрипта, запуск отвязанного процесса через инъекцию spawn и снятие по pid.
import { EventEmitter } from "node:events";
import {
  buildDetachedOneShotScript,
  cancelAtFallback,
  computeDelaySeconds,
  isAtMissingError,
  isPidJobId,
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
  check(
    script === "sleep 5; /bin/bash '/tmp/x y.sh' >> '/tmp/log file' 2>&1",
    "скрипт = sleep + команда с кавычками",
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
  check(/^sleep \d+; \/bin\/bash '\/tmp\/run\.sh'$/.test(calls[0].args[1]), "в скрипте есть sleep и команда", calls[0].args[1]);
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

console.log(
  failures === 0
    ? `\nВсе проверки пройдены (at fallback).`
    : `\nЕсть падения: ${failures}.`,
);
process.exitCode = failures === 0 ? 0 : 1;
