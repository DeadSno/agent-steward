import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-ab8-"));
const dbPath = path.join(root, "mission.db");
process.env.OPENCODE_SCHEDULER_DB = dbPath;

const { initDb, closeDb, getDb } = await import("./dist/db/index.js");
const { listRuns, listRunSteps, createRun } = await import("./dist/db/runs-repo.js");
const { runMission, normalizeMissionSpec, formatLogRunMarker, extractLastRunLog } = await import("./dist/core/mission.js");
const { createRegisteredRunContext, createAdHocRunContext } = await import("./dist/core/execution.js");
const { compilePermissionPolicy, RISK_CLASSES } = await import("./dist/core/permissions.js");

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

// 1b. W-3: два dry-run в одном cwd проходят параллельно (нет захвата activeWorkspaces).
{
  let prepared = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const onPrepared = () => {
    prepared += 1;
    if (prepared === 2) release();
  };
  const attempts = Promise.all([
    runMission({ prompt: "параллельный dry A", cwd: root, dryRun: true }, { onPrepared }),
    runMission({ prompt: "параллельный dry B", cwd: root, dryRun: true }, { onPrepared }),
  ]);
  let results;
  try {
    results = await Promise.race([
      attempts,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("второй dry-run заблокирован activeWorkspaces")),
          2000,
        ),
      ),
    ]);
  } catch (err) {
    check("dry-run: два вызова в одном cwd проходят параллельно", false, String(err));
  }
  if (results) {
    check(
      "dry-run: два вызова в одном cwd проходят параллельно",
      results.length === 2 && results.every((item) => item.success && item.dryRun === true) && prepared === 2,
    );
    check("dry-run: параллельные вызовы не пишут ledger", listRuns().length === 0);
  }
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

// 7. Маркер запуска в логе: лог НЕ очищается, прогон всегда оставляет след.
{
  const now = new Date("2026-11-19T12:00:00.000Z");
  const runMarker = formatLogRunMarker("run", "github-ci-check", now);
  const missionMarker = formatLogRunMarker("mission", "ad-hoc", now);
  check(
    "лог: маркер запуска содержит время и имя",
    runMarker === "[agent-steward] === Run started 2026-11-19T12:00:00.000Z (github-ci-check) ===\n",
    JSON.stringify(runMarker),
  );
  check("лог: маркер миссии отличается", missionMarker.includes("Mission started") && !missionMarker.includes("Run started"));
  check("лог: маркер заканчивается переводом строки", runMarker.endsWith("\n"));
  // QA #8: при создании задачи пишется маркер подготовки, а НЕ "Run started".
  const prepareMarker = formatLogRunMarker("prepare", "qa-fix8-probe", now);
  check(
    "лог: маркер подготовки не притворяется запуском",
    prepareMarker === "[agent-steward] === Task prepared 2026-11-19T12:00:00.000Z (qa-fix8-probe) ===\n" &&
      !prepareMarker.includes("Run started"),
    JSON.stringify(prepareMarker),
  );
  const missionSource = fs.readFileSync("src/core/mission.ts", "utf8");
  const indexSource = fs.readFileSync("src/index.ts", "utf8");
  check(
    "лог: подготовка миссии не очищает файл",
    !/writeFile\(logFile,\s*["']{2}/.test(missionSource),
  );
  check(
    "лог: подготовка запуска не очищает файл",
    !/writeFile\(logFile,\s*["']{2}/.test(indexSource),
  );
  // QA-E.1: потребители лога видят только последний прогон.
  const combined = [
    runMarker,
    "старый вывод предыдущей задачи\n",
    prepareMarker,
    "вывод подготовки (не запуск)\n",
    missionMarker,
    "свежий вывод\n",
    "tokens: 50\n",
  ].join("");
  const last = extractLastRunLog(combined);
  check(
    "лог: extractLastRunLog отсекает предыдущие прогоны",
    last === `${missionMarker}свежий вывод\ntokens: 50\n`,
    JSON.stringify(last),
  );
  check(
    "лог: Task prepared не считается границей прогона",
    extractLastRunLog(`${prepareMarker}нет запуска\n`) === `${prepareMarker}нет запуска\n`,
  );
  check(
    "лог: без маркера возвращается весь текст (обратная совместимость)",
    extractLastRunLog("\uFEFFстарый лог без маркеров\n") === "старый лог без маркеров\n",
  );
  const logsSource = fs.readFileSync("src/core/scheduler/logs.ts", "utf8");
  const recorderSource = fs.readFileSync("src/core/record-history.ts", "utf8");
  check(
    "лог: getTaskLogs и парсер токенов используют extractLastRunLog",
    logsSource.includes("extractLastRunLog(") && recorderSource.includes("extractLastRunLog("),
  );
  const wrapperSource = fs.readFileSync("src/core/ps-wrapper.ts", "utf8");
  check(
    "лог: пустой код ошибки заменяется сообщением",
    wrapperSource.includes('"Код возврата $($script:exitCode)"'),
  );
  // QA-P0.2: обёртки должны оставлять маркер реального прогона, иначе
  // extractLastRunLog() не может отделить последний запуск от предыдущих.
  const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");
  const bashWrapper = buildBashWrapperScript({
    sanitizedName: "qa-log-probe",
    taskName: "qa-log-probe",
    promptFile: "C:/tmp/qa-log-probe.txt",
    timeoutSeconds: 10,
    lockFile: "C:/tmp/locks/qa-log-probe.lock",
  });
  check(
    "лог QA-P0.2: bash-обёртка пишет маркер Run started в LOG_FILE",
    bashWrapper.includes("[agent-steward] === Run started %s (%s) ===") &&
      bashWrapper.includes('>> "$LOG_FILE" 2>/dev/null || true'),
  );
  check(
    "лог QA-P0.2: PS-обёртка пишет маркер Run started без префикса времени",
    wrapperSource.includes('"[agent-steward] === Run started " + $startedAtIso + " (" + $TaskName + ") ==="') &&
      wrapperSource.includes("Add-Content -Path $LogFile -Value (\"[agent-steward] === Run started \""),
  );
  const syntheticLog = [
    "[agent-steward] === Task prepared 2026-11-20T04:00:00.000Z (qa-log-probe) ===\n",
    "старый вывод\n",
    "[agent-steward] === Run started 2026-11-20T05:00:00.000Z (qa-log-probe) ===\n",
    "свежий вывод\n",
  ].join("");
  check(
    "лог QA-P0.2: маркер прогона отсекает подготовку и старый вывод",
    extractLastRunLog(syntheticLog) ===
      "[agent-steward] === Run started 2026-11-20T05:00:00.000Z (qa-log-probe) ===\nсвежий вывод\n",
  );
}

// 8. ARCH-2.1/2.2: риск-класс в MissionSpec/RunContext и паритет входов.
{
  const defaults = normalizeMissionSpec({ prompt: "x", cwd: root });
  check(
    "риск: без riskClass сохранено текущее поведение (hybrid, без списков)",
    defaults.riskClass === undefined &&
      defaults.policy === "hybrid" &&
      defaults.allowedTools === undefined &&
      defaults.deniedTools === undefined &&
      defaults.gateTimeoutSeconds === undefined,
  );

  const r0 = normalizeMissionSpec({ prompt: "x", cwd: root, riskClass: "R0" });
  check("риск: R0 компилируется в secure", r0.riskClass === "R0" && r0.policy === "secure");
  check("риск: R0 получает явные списки инструментов", Array.isArray(r0.allowedTools) && r0.allowedTools.length > 0 && Array.isArray(r0.deniedTools));
  check("риск: R0 получает лимит гейта из таблицы", r0.gateTimeoutSeconds === 120, String(r0.gateTimeoutSeconds));
  await assert.rejects(() => runMission({ prompt: "x", riskClass: "R9" }), /riskClass/i);
  check("риск: неизвестный класс отклоняется", true);

  const planned = await runMission(
    { prompt: "рискованный промпт", taskName: "ad-hoc-risk", cwd: root, riskClass: "R1", dryRun: true },
    { executor: { id: "fake", supports: () => true, execute: async () => ({ output: "no" }) } },
  );
  check(
    "риск: контекст миссии несёт класс и скомпилированную политику",
    planned.plan.context.riskClass === "R1" && planned.plan.context.compiledPolicy.policy === "secure",
  );

  for (const klass of RISK_CLASSES) {
    const adHoc = createAdHocRunContext("одинаковый промпт", { riskClass: klass, taskName: "parity" });
    const registered = createRegisteredRunContext(
      { name: "parity", prompt: "одинаковый промпт" },
      { riskClass: klass },
    );
    const expected = compilePermissionPolicy({ riskClass: klass });
    check(
      `${klass}: паритет ad-hoc и registered`,
      adHoc.riskClass === klass &&
        registered.riskClass === klass &&
        JSON.stringify(adHoc.compiledPolicy) === JSON.stringify(registered.compiledPolicy),
    );
    check(
      `${klass}: контекст совпадает с компилятором`,
      JSON.stringify(adHoc.compiledPolicy) === JSON.stringify(expected),
    );
  }

  const adHocScope = createAdHocRunContext("p", {
    taskName: "scope",
    policy: "secure",
    metadata: { gate: "npm test" },
  });
  const registeredScope = createRegisteredRunContext(
    { name: "scope", prompt: "p", qualityGate: "npm test" },
    { policy: "secure" },
  );
  check(
    "риск: классификация по gate scope одинакова для обоих входов",
    adHocScope.riskClass === "R1" &&
      registeredScope.riskClass === "R1" &&
      JSON.stringify(adHocScope.compiledPolicy) === JSON.stringify(registeredScope.compiledPolicy),
  );
}

closeDb();
try {
  fs.rmSync(root, { recursive: true, force: true });
} catch {
  // Windows может держать файл БД; временный каталог очистит ОС.
}

// QA-D315-1: старые БД пользователей создавали `runs.started_at TEXT NOT NULL`.
// Pending-запуск должен создаваться и там, без нарушения контракта legacy-схемы.
{
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-d315-"));
  const legacyDb = path.join(legacyRoot, "legacy.db");
  process.env.OPENCODE_SCHEDULER_DB = legacyDb;
  initDb(legacyDb);
  getDb().exec("DROP TABLE IF EXISTS runs");
  getDb().exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task_name TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_run_id TEXT,
      workspace_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  try {
    const legacyRun = createRun({ taskName: "qa-d315-legacy" });
    check(
      "QA-D315-1: pending-запуск создаётся в legacy-БД с NOT NULL started_at",
      typeof legacyRun.startedAt === "string" && legacyRun.startedAt.length > 0,
      JSON.stringify(legacyRun),
    );
  } catch (err) {
    check("QA-D315-1: pending-запуск создаётся в legacy-БД с NOT NULL started_at", false, String(err));
  }
  closeDb();
  try {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  } catch {
    // Windows может держать файл БД; временный каталог очистит ОС.
  }
}

console.log(`\nМиссии: ${passed} ok, ${failed} fail`);
if (failed > 0) {
  process.exitCode = 1;
}
