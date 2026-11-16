import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-triage-async-"));
process.env.OPENCODE_SCHEDULER_HOME = home;
process.env.APPDATA = home;

const {
  writeTriageJob,
  readTriageJob,
  runTriageJob,
  scheduleTriageJob,
} = await import("./dist/core/triage-worker.js");
const { readTriageDecisions } = await import("./dist/core/triage-shadow.js");
const { saveSettings } = await import("./dist/settings.js");
const { notifyTaskCompletion } = await import("./dist/notifications.js");
const { closeDb } = await import("./dist/db/index.js");

let passed = 0;
let failed = 0;

function check(name, condition, details = "") {
  if (condition) {
    passed++;
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${details ? ` — ${details}` : ""}`);
  }
}

function triage(extra = {}) {
  return {
    mode: "rules",
    baseUrl: "http://127.0.0.1:9",
    model: "qwen3:4b",
    timeoutMs: 500,
    fallback: "rules",
    confidenceThreshold: 0.6,
    rules: [],
    ...extra,
  };
}

const skipDeploy = {
  id: "skip-deploy",
  field: "task",
  operator: "equals",
  value: "deploy",
  action: "skip",
  priority: 50,
};

const input = (overrides = {}) => ({
  taskName: "deploy",
  status: "error",
  error: "boom",
  durationMs: 1000,
  ...overrides,
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function waitFor(fn, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

try {
  // 1. Задание содержит снимок настроек и очищенный текст ошибки.
  const jobFile = writeTriageJob(
    input({ error: "token=abc123 quality gate failed" }),
    triage({ rules: [skipDeploy] })
  );
  const job = readTriageJob(jobFile);
  check("job: версия 1", job.version === 1);
  check("job: режим сохранён", job.triage.mode === "rules");
  check("job: правило сохранено", job.triage.rules?.[0]?.id === "skip-deploy");
  check(
    "job: секрет в ошибке замаскирован",
    typeof job.input.error === "string" &&
      !job.input.error.includes("abc123") &&
      job.input.error.includes("***")
  );

  const longFile = writeTriageJob(
    input({ taskName: "long-error", error: "x".repeat(5000) }),
    triage()
  );
  const longJob = readTriageJob(longFile);
  check(
    "job: длинная ошибка обрезана",
    typeof longJob.input.error === "string" &&
      longJob.input.error.length <= 4001 &&
      longJob.input.error.endsWith("…")
  );
  fs.unlinkSync(longFile);

  // 2. Синхронное выполнение задания пишет async-решение в аудит.
  const decision = await runTriageJob(jobFile);
  check("run: решение получено", decision?.action === "skip");
  const recorded = readTriageDecisions({ taskName: "deploy" })[0];
  check("run: audit action=skip", recorded?.action === "skip");
  check("run: audit async=true", recorded?.async === true);
  check("run: audit suppressed=false", recorded?.suppressed === false);
  check("run: audit shadow=false", recorded?.shadow === false);
  fs.unlinkSync(jobFile);

  // 3. Режим off не создаёт решение.
  const offFile = writeTriageJob(
    input({ taskName: "off-noop" }),
    triage({ mode: "off" })
  );
  const offDecision = await runTriageJob(offFile);
  check("off: решение не создаётся", offDecision === null);
  check(
    "off: аудит пуст",
    readTriageDecisions({ taskName: "off-noop" }).length === 0
  );
  fs.unlinkSync(offFile);

  // 4. Shadow-снимок сохраняется в аудите, но доставка не подавляется.
  const shadowFile = writeTriageJob(
    input({ taskName: "shadow-async" }),
    triage({
      rules: [skipDeploy],
      shadow: {
        enabled: true,
        days: 14,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
  );
  await runTriageJob(shadowFile);
  const shadowRecord = readTriageDecisions({ taskName: "shadow-async" })[0];
  check("shadow: audit shadow=true", shadowRecord?.shadow === true);
  check("shadow: audit suppressed=false", shadowRecord?.suppressed === false);
  check("shadow: async=true", shadowRecord?.async === true);
  fs.unlinkSync(shadowFile);

  // 5. Запись переживает переоткрытие базы.
  closeDb();
  check(
    "audit: async-решение пережило reopen",
    readTriageDecisions({ taskName: "deploy" }).length === 1
  );

  // 6. Планировщик запускает detached-процесс с нужными аргументами.
  let spawnCall = null;
  const scheduled = scheduleTriageJob(
    input({ taskName: "spawn-check" }),
    triage({ rules: [skipDeploy] }),
    {
      spawnFn: (command, args, options) => {
        spawnCall = { command, args, options };
        return { unref() {}, on() {} };
      },
    }
  );
  check("spawn: задание запланировано", scheduled.scheduled === true);
  check("spawn: файл существует", Boolean(scheduled.file && fs.existsSync(scheduled.file)));
  check(
    "spawn: аргумент --triage",
    spawnCall?.args?.[1] === "--triage" && spawnCall?.args?.[2] === scheduled.file
  );
  check(
    "spawn: detached + ignore + windowsHide",
    spawnCall?.options?.detached === true &&
      spawnCall?.options?.stdio === "ignore" &&
      spawnCall?.options?.windowsHide === true
  );
  if (scheduled.file) fs.unlinkSync(scheduled.file);

  // 7. Ошибка spawn не бросает исключение и убирает файл задания.
  const failedSpawn = scheduleTriageJob(
    input({ taskName: "spawn-fail" }),
    triage(),
    {
      spawnFn: () => {
        throw new Error("spawn failed");
      },
    }
  );
  check("spawn: ошибка возвращается", failedSpawn.scheduled === false);
  check(
    "spawn: файл удалён после ошибки",
    Boolean(failedSpawn.file && !fs.existsSync(failedSpawn.file))
  );

  // 8. Уведомление не ждёт модель: доставка происходит сразу, триаж — в фоне.
  await withServer(
    (req, res) => {
      req.resume();
      req.on("end", () => {
        globalThis.__webhookBody = "received";
        sendJson(res, 200, { ok: true });
      });
    },
    async (webhookUrl) => {
      await saveSettings({
        notifications: {
          enabled: true,
          onlyOnError: false,
          webhook: {
            enabled: true,
            url: webhookUrl,
            timeoutMs: 2000,
            retryCount: 0,
            retryDelayMs: 0,
          },
          filters: { include: [], exclude: [] },
          triage: triage({
            mode: "llm",
            baseUrl: "http://127.0.0.1:9",
            timeoutMs: 5000,
            fallback: "notify",
            rules: [skipDeploy],
            shadow: { enabled: false, days: 14, startedAt: null },
          }),
        },
      });
      let calls = 0;
      let scheduledInput = null;
      globalThis.__webhookBody = "";
      const started = Date.now();
      await notifyTaskCompletion("deploy", "error", 1000, "boom", 0, 0, {
        asyncTriage: true,
        scheduleTriage: (jobInput) => {
          calls++;
          scheduledInput = jobInput;
          return { scheduled: true };
        },
      });
      const elapsed = Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      check("async: webhook доставлен сразу", globalThis.__webhookBody === "received");
      check("async: задержка доставки < 2 с", elapsed < 2000, `elapsed=${elapsed}`);
      check("async: триаж запланирован один раз", calls === 1);
      check("async: в триаж передан taskName", scheduledInput?.taskName === "deploy");
      check(
        "async: синхронного решения нет",
        readTriageDecisions({ taskName: "deploy" }).length === 1
      );
    }
  );

  // 9. Реальный detached-процесс: модель отвечает, решение появляется в аудите.
  const verdict = {
    category: "quality",
    severity: "high",
    confidence: 0.95,
    reason: "Quality Gate провален.",
  };
  await withServer(
    (req, res) => {
      req.resume();
      req.on("end", () =>
        sendJson(res, 200, { message: { content: JSON.stringify(verdict) } })
      );
    },
    async (baseUrl) => {
      const live = scheduleTriageJob(
        input({ taskName: "worker-live" }),
        triage({
          mode: "llm",
          baseUrl,
          timeoutMs: 3000,
          fallback: "rules",
          shadow: { enabled: false, days: 14, startedAt: null },
        })
      );
      check("worker: процесс запущен", live.scheduled === true);
      const liveRecord = await waitFor(
        () => readTriageDecisions({ taskName: "worker-live" })[0] ?? null
      );
      check("worker: решение записано", Boolean(liveRecord));
      check("worker: source=llm", liveRecord?.source === "llm");
      check("worker: async=true", liveRecord?.async === true);
      check("worker: action=notify", liveRecord?.action === "notify");
    }
  );
} finally {
  closeDb();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\nTriage async: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) process.exitCode = 1;
