import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-log-test-"));
// B10: legacy-режим пишет в БД, поэтому база теста изолирована во временной
// папке. Env выставляется до импорта модулей — путь БД читается при импорте.
process.env.OPENCODE_SCHEDULER_DB = path.join(tmpDir, "usage.db");
const { parseUsageFromLog } = await import("./dist/core/record-history.js");

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

// --- B10: legacy-режим (без --start/--finish) читает usage из 11-го аргумента ---
{
  const recorder = path.resolve("dist/core/record-history.js");
  const runLegacy = (taskName, logFile, tokens = "-", cost = "-") => {
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
      { encoding: "utf8", env: { ...process.env }, timeout: 30000 },
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

    console.log("  ✅ B10: legacy-режим пишет usage из лога и не падает без него");
    passed++;
  } catch (err) {
    console.log(`  ❌ B10: legacy-режим usage: ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

try {
  const { closeDb } = await import("./dist/db/index.js");
  closeDb();
} catch {
  // БД могла не открыться — не мешает уборке.
}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // Windows может держать файл БД — тест уже завершён.
}

console.log(`\nИтого: ${passed} пройдено, ${failed} провалено из ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
