import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

// QA-P1.3: legacy-режим пишет в БД, поэтому тест обязан использовать
// изолированный home. OPENCODE_SCHEDULER_DB плагином не читается — раньше
// тестовые строки «Legacy Usage/Explicit» попадали в рабочую БД профиля и
// создавали ложное ощущение ненулевого usage в аналитике.
const liveRoot = process.env.APPDATA ?? "";
const liveDbCandidates = [
  path.join(liveRoot, "opencode", "agent-steward", "scheduler.db"),
  path.join(liveRoot, "opencode", "windows-scheduler", "scheduler.db"),
];
const TEST_TASKS = ["Legacy Usage", "Legacy NoLog", "Legacy Explicit"];
function countLiveUsageRows() {
  let total = 0;
  for (const file of liveDbCandidates) {
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const placeholders = TEST_TASKS.map(() => "?").join(", ");
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM history WHERE task_name IN (${placeholders})`)
        .get(...TEST_TASKS);
      total += Number(row?.n ?? 0);
    } catch {
      // Таблица истории может ещё не существовать — считаем 0 попаданий.
    } finally {
      db.close();
    }
  }
  return total;
}
const liveUsageBefore = countLiveUsageRows();

const { root: tmpDir } = createTestHomeSync("ws-scheduler-usage-log-");
process.env.APPDATA = tmpDir;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tmpDir, "opencode", "windows-scheduler");
const { parseUsageFromLog } = await import("./dist/core/record-history.js");
const { collectOpenCodeUsage, findOpenCodeDb } = await import("./dist/core/opencode-usage.js");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

function writeLog(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// 1. Простое извлечение токенов и стоимости
check("извлекает Tokens и cost из хвоста лога", () => {
  const log = writeLog("task1.log", `[2026-11-16 10:00:01] Запуск задачи...\nTokens: 1234\ncost: $0.012\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 1234);
  assert.strictEqual(u.costUsd, 0.012);
});

// 2. Якорные паттерны: не ловит token= внутри конфиг-дампа (opencode.json)
check("пропускает строки с opencode.json / OPENCODE_CONFIG", () => {
  const log = writeLog("task2.log", `OPENCODE_CONFIG_CONTENT={...}\n"tokens": 99999\nTokens: 42\ncost: $1.00\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 42);
  assert.strictEqual(u.costUsd, 1.00);
});

// 3. Идёт с конца: берёт последнее значение токенов
check("берёт последнее вхождение токенов (идет с конца)", () => {
  const log = writeLog("task3.log", `Tokens: 100\n...\nTokens: 777\ncost: $0.50\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 777);
});

// 4. Суффикс k/m
check("понимает суффиксы k и m", () => {
  const logK = writeLog("task4k.log", `Token usage: 5k\ncost: $0.01\n`);
  const uK = parseUsageFromLog(logK);
  assert.strictEqual(uK.tokens, 5000);

  const logM = writeLog("task4m.log", `tokens: 2.5M\ncost: $0.02\n`);
  const uM = parseUsageFromLog(logM);
  assert.strictEqual(uM.tokens, 2500000);
});

// 5. Запятая как разделитель дробной части
check("запятую в числах заменяет на точку", () => {
  const log = writeLog("task5.log", `Tokens: 1,5\ncost: $0,75\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 2); // 1.5 → Math.round(1.5) = 2
  assert.strictEqual(u.costUsd, 0.75);
});

// 6. Альтернативные формулировки
check("распознаёт альтернативные формулировки токенов/стоимости", () => {
  const log = writeLog("task6.log", `input tokens: 100\nTotal cost: $5.00\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 100);
  assert.strictEqual(u.costUsd, 5.00);
});

// 7. Пустой файл
check("пустой файл → пустой результат", () => {
  const log = writeLog("task7.log", "");
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, undefined);
  assert.strictEqual(u.costUsd, undefined);
});

// 8. Несуществующий файл
check("несуществующий файл → пустой результат", () => {
  const u = parseUsageFromLog(path.join(tmpDir, "no-such-file.log"));
  assert.strictEqual(u.tokens, undefined);
  assert.strictEqual(u.costUsd, undefined);
});

// 9. Пустой путь
check("пустой путь к логу → пустой результат", () => {
  const u = parseUsageFromLog("");
  assert.strictEqual(u.tokens, undefined);
  assert.strictEqual(u.costUsd, undefined);
});

// 10. Только токены, без стоимости
check("только токены → cost остаётся undefined", () => {
  const log = writeLog("task10.log", `Tokens: 999\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 999);
  assert.strictEqual(u.costUsd, undefined);
});

// 11. Префикс времени лога в начале строки допускается
check("префикс времени лога не мешает якорю", () => {
  const log = writeLog("task11.log", `[2026-11-16 10:00:01] Tokens: 555\n[2026-11-16 10:00:02] cost: $3.33\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, 555);
  assert.strictEqual(u.costUsd, 3.33);
});

// 12. Kosten без знака $ (только цифры + usd)
check("распознаёт cost с usd без знака $", () => {
  const log = writeLog("task12.log", `cost: 12.50 usd\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.costUsd, 12.50);
});

// 13. Только cost, без токенов
check("только стоимость → tokens остаётся undefined", () => {
  const log = writeLog("task13.log", `cost: $7.77\n`);
  const u = parseUsageFromLog(log);
  assert.strictEqual(u.tokens, undefined);
  assert.strictEqual(u.costUsd, 7.77);
});

// QA-F.1: OpenCode печатает стоимость без валютного знака.
check("costUsd=0.1 без знака валюты распознаётся", () => {
  const u = parseUsageFromLog(writeLog("task-f1a.log", `tokens=50\ncostUsd=0.1\n`));
  assert.strictEqual(u.tokens, 50);
  assert.strictEqual(u.costUsd, 0.1);
});
check("cost: 0.25 / cost=0.1 USD распознаются без $ перед числом", () => {
  assert.strictEqual(parseUsageFromLog(writeLog("task-f1b.log", `cost: 0.25\n`)).costUsd, 0.25);
  assert.strictEqual(parseUsageFromLog(writeLog("task-f1c.log", `cost=0.1 USD\n`)).costUsd, 0.1);
});
check("cost_usd=0.75 распознаётся", () => {
  assert.strictEqual(parseUsageFromLog(writeLog("task-f1d.log", `cost_usd=0.75\n`)).costUsd, 0.75);
});

// QA-P1.3: PowerShell-обёртка должна распознавать те же формы стоимости,
// что и TS-парсер. Раньше в Get-UsageFromLog были только старые шаблоны с `$`.
check("QA-F.1: PS-обёртка распознаёт costUsd/cost_usd без знака валюты", () => {
  const source = fs.readFileSync(path.resolve("src/core/ps-wrapper.ts"), "utf8");
  assert.ok(
    source.includes("costUsd|cost_usd|cost(?:\\\\s*usd)?"),
    "в Get-UsageFromLog должны быть QA-F.1-шаблоны стоимости",
  );
});

// --- B10: legacy-режим (без --start/--finish) читает usage из 11-го аргумента ---
{
  const recorder = path.resolve("dist/core/record-history.js");
  const runLegacy = (taskName, logFile, tokens = "-", cost = "-", extraEnv = {}) => {
    const result = spawnSync(
      process.execPath,
      [
        recorder,
        taskName,
        "success",
        new Date().toISOString(),
        "1000",
        "-", // error
        tokens,
        cost,
        "-", // model
        "-", // pre-flight
        "-", // post-flight
        logFile,
      ],
      { encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 30000 },
    );
    return result;
  };

  try {
    const legacyLog = writeLog("legacy.log", `[2026-11-18 10:00:00] Tokens: 4321\ncost: $0.21\n`);
    const res = runLegacy("Legacy Usage", legacyLog);
    assert.strictEqual(res.status, 0, `recorder exit ${res.status}: ${res.stderr}`);

    // Путь к несуществующему логу — graceful fallback, запись не падает.
    const missing = runLegacy("Legacy NoLog", path.join(tmpDir, "missing.log"));
    assert.strictEqual(missing.status, 0, `recorder exit ${missing.status}: ${missing.stderr}`);

    const { initDb, getDb } = await import("./dist/db/index.js");
    initDb();
    const row = getDb()
      .prepare("SELECT tokens, cost_usd FROM history WHERE task_name = ? ORDER BY id DESC LIMIT 1")
      .get("Legacy Usage");
    assert.strictEqual(Number(row.tokens), 4321);
    assert.strictEqual(Number(row.cost_usd), 0.21);

    const noLogRow = getDb()
      .prepare("SELECT tokens, cost_usd FROM history WHERE task_name = ? ORDER BY id DESC LIMIT 1")
      .get("Legacy NoLog");
    assert.strictEqual(noLogRow.tokens, null);
    assert.strictEqual(noLogRow.cost_usd, null);

    // Явно переданные значения сильнее лога.
    const explicit = runLegacy("Legacy Explicit", legacyLog, "50", "0.1");
    assert.strictEqual(explicit.status, 0, `recorder exit ${explicit.status}: ${explicit.stderr}`);
    const explicitRow = getDb()
      .prepare("SELECT tokens, cost_usd FROM history WHERE task_name = ? ORDER BY id DESC LIMIT 1")
      .get("Legacy Explicit");
    assert.strictEqual(Number(explicitRow.tokens), 50);
    assert.strictEqual(Number(explicitRow.cost_usd), 0.1);

    // PL-38: когда лог пуст, токены приходят из opencode.db.
    const usageDbPath = path.join(tmpDir, "opencode-recorder.db");
    const usageDb = new DatabaseSync(usageDbPath);
    usageDb.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
    );
    usageDb
      .prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "msg_db_usage",
        "ses_test",
        Date.now(),
        Date.now(),
        JSON.stringify({
          role: "assistant",
          cost: 0.05,
          tokens: { total: 321 },
          providerID: "opencode",
          path: { cwd: tmpDir },
        }),
      );
    usageDb.close();
    const fromDb = runLegacy("DB Usage Task", path.join(tmpDir, "empty.log"), "-", "-", {
      OPENCODE_USAGE_DB: usageDbPath,
    });
    assert.strictEqual(fromDb.status, 0, `recorder exit ${fromDb.status}: ${fromDb.stderr}`);
    const dbRow = getDb()
      .prepare("SELECT tokens, cost_usd FROM history WHERE task_name = ? ORDER BY id DESC LIMIT 1")
      .get("DB Usage Task");
    assert.strictEqual(Number(dbRow.tokens), 321);
    assert.strictEqual(Number(dbRow.cost_usd), 0.05);

    console.log("  ✅ B10: legacy-режим пишет usage из лога и не падает без него");
    passed++;
  } catch (err) {
    console.log(`  ❌ B10: legacy-режим usage: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// --- T-6.2: офлайн-оценка, когда free-провайдер не пишет usage ---
{
  const { estimateRunUsage } = await import("./dist/core/usage-surface.js");
  check("T-6.2: estimateRunUsage считает вход+выход и цену за 1M", () => {
    const estimate = estimateRunUsage({
      prompt: "a".repeat(400),
      logText: "b".repeat(800),
      pricePerMillion: 3,
    });
    assert.strictEqual(estimate.tokens, 300);
    assert.strictEqual(estimate.inputTokens, 100);
    assert.strictEqual(estimate.outputTokens, 200);
    assert.strictEqual(estimate.costUsd, 0.0009);
    assert.strictEqual(estimate.source, "offline");
  });
  check("T-6.2: неизвестная цена не выдумывает стоимость", () => {
    const estimate = estimateRunUsage({ prompt: "abcd", logText: "efgh" });
    assert.strictEqual(estimate.tokens, 2);
    assert.strictEqual(estimate.costUsd, undefined);
  });

  const recorder = path.resolve("dist/core/record-history.js");
  const runRecorder = (taskName, logFile, extraEnv = {}) =>
    spawnSync(
      process.execPath,
      [
        recorder,
        taskName,
        "success",
        new Date().toISOString(),
        "1000",
        "-",
        "-",
        "-",
        "-",
        "-",
        "-",
        logFile,
      ],
      { encoding: "utf8", env: { ...process.env, ...extraEnv }, timeout: 30000 },
    );

  const { saveTask } = await import("./dist/db/tasks-repo.js");
  saveTask({
    name: "Offline Usage Task",
    schedule: "0 0 1 * *",
    prompt: "a".repeat(400),
    model: "opencode/hy4-flash-free",
  });
  const offlineLog = writeLog("offline-usage.log", "b".repeat(800));
  const res = runRecorder("Offline Usage Task", offlineLog, {
    OPENCODE_USAGE_DB: path.join(tmpDir, "no-opencode-for-offline.db"),
  });
  assert.strictEqual(res.status, 0, `recorder exit ${res.status}: ${res.stderr}`);
  const { getDb } = await import("./dist/db/index.js");
  const row = getDb()
    .prepare("SELECT tokens, cost_usd FROM history WHERE task_name = ? ORDER BY id DESC LIMIT 1")
    .get("Offline Usage Task");
  check("T-6.2: legacy-рекордер пишет офлайн-оценку в историю", () => {
    assert.strictEqual(Number(row.tokens), 300);
    assert.strictEqual(Number(row.cost_usd), 0);
  });
}

// --- PL-38 / QV-11.2: чтение usage из собственной БД OpenCode ---
check("QV-11.2: findOpenCodeDb уважает OPENCODE_USAGE_DB", () => {
  const custom = path.join(tmpDir, "custom-opencode.db");
  assert.strictEqual(findOpenCodeDb({ OPENCODE_USAGE_DB: `  ${custom}  ` }), custom);
  assert.strictEqual(
    findOpenCodeDb({ HOME: tmpDir, USERPROFILE: tmpDir, APPDATA: tmpDir }),
    null,
  );
});

{
  const dbPath = path.join(tmpDir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const now = Date.now();
  const rows = [
    {
      id: "m1",
      time: now - 1000,
      data: {
        role: "assistant",
        cost: 0.02,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "m1",
        providerID: "opencode",
        path: { cwd: "C:/work/project" },
      },
    },
    {
      id: "m2",
      time: now - 500,
      data: {
        role: "assistant",
        cost: 0,
        tokens: { total: 50 },
        modelID: "m2",
        providerID: "ollama",
        path: { cwd: "C:/work/project" },
      },
    },
    {
      id: "m3",
      time: now - 400,
      data: {
        role: "assistant",
        cost: 99,
        tokens: { total: 9999 },
        modelID: "m3",
        providerID: "opencode",
        path: { cwd: "C:/work/other" },
      },
    },
    {
      id: "m4",
      time: now - 300,
      data: { role: "user", cost: 77, tokens: { total: 7777 }, path: { cwd: "C:/work/project" } },
    },
  ];
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(row.id, "ses_test", row.time, row.time, JSON.stringify(row.data));
  }
  db.close();

  check("QV-11.2: aggregated tokens/cost только за окно и cwd задачи", () => {
    const usage = collectOpenCodeUsage({
      dbPath,
      since: now - 5000,
      until: now + 1000,
      cwd: "C:\\work\\project",
    });
    assert.ok(usage, "usage должен быть прочитан из БД");
    assert.strictEqual(usage.tokens, 170);
    assert.strictEqual(usage.costUsd, 0.02);
    assert.strictEqual(usage.messages, 2);
    assert.strictEqual(usage.providers.opencode, 120);
    assert.strictEqual(usage.providers.ollama, 50);
  });

  check("QV-11.2: БД вне окна возвращает пустой, но валидный результат", () => {
    const usage = collectOpenCodeUsage({ dbPath, since: now - 100000, until: now - 90000 });
    assert.ok(usage);
    assert.strictEqual(usage.tokens, 0);
    assert.strictEqual(usage.messages, 0);
  });

  check("QV-11.2: отсутствующий файл БД — graceful null", () => {
    assert.strictEqual(
      collectOpenCodeUsage({ dbPath: path.join(tmpDir, "missing.db"), since: 0, until: now }),
      null,
    );
  });
}

// --- T-4.2: учёт попаданий в prompt-cache статических схем ---
{
  const dbPath = path.join(tmpDir, "opencode-cache.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)",
  );
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(
    "cache-native",
    "ses_cache",
    now - 2000,
    now - 2000,
    JSON.stringify({
      role: "assistant",
      providerID: "anthropic",
      cost: 0.01,
      tokens: { total: 1000, cache: { read: 400, write: 100 } },
    }),
  );
  insert.run(
    "cache-normalized",
    "ses_cache",
    now - 1000,
    now - 1000,
    JSON.stringify({
      role: "assistant",
      providerID: "opencode",
      cost: 0,
      tokens: { total: 500 },
      usage: { cacheReadInputTokens: 250, cacheWriteInputTokens: 50 },
    }),
  );
  db.close();

  check("T-4.2: collectOpenCodeUsage считает cache read/write в обеих форматах БД", () => {
    const usage = collectOpenCodeUsage({ dbPath, since: now - 5000, until: now + 1000 });
    assert.ok(usage);
    assert.strictEqual(usage.tokens, 1500);
    assert.strictEqual(usage.cacheReadTokens, 650);
    assert.strictEqual(usage.cacheWriteTokens, 150);
  });
}

try {
  const { closeDb } = await import("./dist/db/index.js");
  closeDb();
} catch {
  // БД могла не открыться — не мешает уборке.
}
// QA-P1.3: тест не должен оставлять следов в рабочей БД профиля.
try {
  const liveUsageAfter = countLiveUsageRows();
  if (liveUsageAfter === liveUsageBefore) {
    console.log("  ✅ QA-P1.3: тест не записал usage в live-БД");
    passed++;
  } else {
    console.error(
      `  ❌ QA-P1.3: тест записал usage в live-БД (было ${liveUsageBefore}, стало ${liveUsageAfter})`,
    );
    failed++;
  }
} catch {
  // Проверка live-БД — best effort; изолированная БД уже проверена выше.
}

removeTestHomeSync(tmpDir);

console.log(`\nИтого: ${passed} пройдено, ${failed} провалено из ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
