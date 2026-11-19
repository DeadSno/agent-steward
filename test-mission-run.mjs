import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ab8-"));
const dbPath = path.join(root, "mission.db");
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const { initDb, closeDb } = await import("./dist/db/index.js");
const { listRuns, listRunSteps } = await import("./dist/db/runs-repo.js");
const { runMission, normalizeMissionSpec } = await import("./dist/core/mission.js");

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    process.exitCode = 1;
  }
}

initDb(dbPath);

// 1. Dry-run: план строится, запуск в ledger не создаётся.
{
  const result = await runMission(
    { prompt: "подготовь отчёт", taskName: "ad-hoc-dry", cwd: root, dryRun: true },
    { executor: { id: "fake", supports: () => true, execute: async () => ({ output: "no" }) } },
  );
  check("dry-run: success", result.success === true);
  check("dry-run: статус planned", result.status === "planned");
  check("dry-run: runId пустой", result.runId === null);
  check("dry-run: описание содержит шаг", result.description.includes("ad-hoc-dry"), result.description);
  check("dry-run: запись в ledger не создана", listRuns().length === 0);
}

// 2. Обычный ad-hoc запуск проходит через единый путь и пишет ledger.
{
  const calls = [];
  const result = await runMission(
    {
      prompt: "проверь репозиторий",
      taskName: "ad-hoc-live",
      cwd: root,
      taskType: "run_tests",
      model: "test/model",
    },
    {
      executor: {
        id: "fake",
        supports: (route) => route.executor !== null,
        execute: async (input) => {
          calls.push(input);
          return { output: "готово" };
        },
      },
    },
  );
  check("запуск: success", result.success === true, result.error ?? "");
  check("запуск: статус passed", result.status === "passed");
  check("запуск: runId выдан", typeof result.runId === "string" && result.runId.length > 0);
  const runs = listRuns();
  check("запуск: одна запись в ledger", runs.length === 1, String(runs.length));
  const run = runs[0];
  check("запуск: имя задачи сохранено", run?.taskName === "ad-hoc-live");
  check("запуск: статус run passed", run?.status === "passed");
  check("запуск: metadata.adHoc", run?.metadata?.adHoc === true);
  const steps = listRunSteps(run.id);
  check("запуск: один шаг", steps.length === 1, String(steps.length));
  check("запуск: шаг passed", steps[0]?.status === "passed");
  check("запуск: output шага сохранён", steps[0]?.output === "готово", JSON.stringify(steps[0]?.output));
  check("запуск: исполнитель получил промпт", calls[0]?.context.prompt === "проверь репозиторий");
  check("запуск: исполнитель получил модель", calls[0]?.context.profile.model === "test/model");
}

// 3. Ошибка исполнителя переводит run в failed и сохраняет причину.
{
  const result = await runMission(
    { prompt: "сломайся", taskName: "ad-hoc-fail", cwd: root },
    {
      executor: {
        id: "fake",
        supports: () => true,
        execute: async () => ({ output: "частично", error: "boom" }),
      },
    },
  );
  check("ошибка: success false", result.success === false);
  check("ошибка: статус failed", result.status === "failed");
  check("ошибка: причина в результате", String(result.error).includes("boom"), String(result.error));
  const run = listRuns("ad-hoc-fail")[0];
  check("ошибка: run failed в ledger", run?.status === "failed");
  check("ошибка: шаг failed в ledger", listRunSteps(run.id)[0]?.status === "failed");
}

// 4. Один workspace — одна миссия: параллельный запуск отклоняется.
{
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  let preparedResolve;
  const prepared = new Promise((resolve) => {
    preparedResolve = resolve;
  });
  const executor = {
    id: "slow",
    supports: () => true,
    execute: async () => {
      await blocker;
      return { output: "done" };
    },
  };
  const first = runMission(
    { prompt: "долгая миссия", taskName: "ad-hoc-long", cwd: root },
    { executor, onPrepared: () => preparedResolve() },
  );
  await prepared;
  await assert.rejects(
    runMission(
      { prompt: "вторая миссия", taskName: "ad-hoc-second", cwd: root },
      { executor },
    ),
    /уже выполняется миссия/,
  );
  check("блокировка: второй запуск отклонён", true);
  release();
  const finished = await first;
  check("блокировка: первый запуск завершён", finished.success === true, finished.error ?? "");
  const again = await runMission(
    { prompt: "после блокировки", taskName: "ad-hoc-after", cwd: root },
    { executor: { id: "fake", supports: () => true, execute: async () => ({ output: "ok" }) } },
  );
  check("блокировка: lock снят после завершения", again.success === true);
}

// 5. Контракт безопасности и валидация входа.
{
  await assert.rejects(() => runMission({ prompt: "   " }), /Пустой миссия|prompt/i);
  await assert.rejects(
    () => runMission({ prompt: "x", policy: "bad" }),
    /policy/i,
  );
  await assert.rejects(
    () => runMission({ prompt: "x", timeoutSeconds: 0 }),
    /timeout/i,
  );
  await assert.rejects(
    () => runMission({ prompt: "x", session: "bad" }),
    /session/i,
  );
  await assert.rejects(
    () => runMission({ prompt: "x", allowedTools: ["bash"], deniedTools: ["bash"] }),
    /одновременно разрешён и запрещён/,
  );
  check("валидация: некорректные входы отклонены", true);
  const normalized = normalizeMissionSpec({ prompt: " x ", cwd: root, session: "reuse", sessionId: "ses_1234567890" });
  check("валидация: промпт обрезан", normalized.prompt === "x");
  check("валидация: cwd абсолютный", path.isAbsolute(normalized.cwd));
  check("валидация: cwd совпадает", normalized.cwd === path.resolve(root));
  check("валидация: session reuse сохранён", normalized.session === "reuse");
}

// 6. Ad-hoc не регистрирует задачи в ОС: в пути миссии нет планировщика.
{
  const source = fs.readFileSync("src/core/mission.ts", "utf8");
  check(
    "ОС: нет импорта планировщика",
    !/from\s+["'][^"']*(scheduler|schtasks|crontab)/.test(source),
  );
  check("ОС: нет вызова createTask", !/schedulerCreateTask|createTask\(/.test(source));
}

closeDb();
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows может держать файл БД; временный каталог очистит ОС.
}

console.log(`\nМиссии: ${passed} ok, ${failed} fail`);
if (failed > 0) {
  process.exitCode = 1;
}
