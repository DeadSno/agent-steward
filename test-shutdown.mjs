// Д6: ворота выгрузки плагина — приём новых запусков и ожидание активных.
//
// Проверяет:
//  1. До begin() ворота открыты, активных операций нет.
//  2. begin() переводит ворота в режим выгрузки.
//  3. waitForIdle ждёт завершения отслеживаемой операции.
//  4. Отклонённая операция снимается с учёта.
//  5. По таймауту возвращается timedOut=true и число незавершённых.
//
// Запуск: node test-shutdown.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { createShutdownGate } from "./dist/core/shutdown.js";

const gate = createShutdownGate();

// 1. Исходное состояние.
assert.equal(gate.isShuttingDown(), false, "до begin() ворота открыты");
assert.equal(gate.activeCount(), 0, "активных операций нет");
const idle = await gate.waitForIdle(10);
assert.deepEqual(idle, { timedOut: false, remaining: 0 }, "пустые ворота не ждут");

// 2. begin().
gate.begin();
assert.equal(gate.isShuttingDown(), true, "после begin() ворота закрыты");

// 3. Ожидание завершения операции.
let release;
const pending = new Promise((resolve) => {
  release = resolve;
});
const tracked = gate.track(pending);
assert.equal(gate.activeCount(), 1, "операция учтена");
const waiting = gate.waitForIdle(200);
release("ok");
assert.equal(await tracked, "ok", "track возвращает результат операции");
const waited = await waiting;
assert.deepEqual(waited, { timedOut: false, remaining: 0 }, "waitForIdle дождался операции");
assert.equal(gate.activeCount(), 0, "после завершения операция снята с учёта");

// 4. Отклонённая операция тоже снимается с учёта.
const failed = gate.track(Promise.reject(new Error("boom")));
await failed.catch(() => {
  /* ожидаемо */
});
assert.equal(gate.activeCount(), 0, "rejected-операция снята с учёта");

// 5. Таймаут.
const forever = new Promise(() => {
  /* никогда не завершится */
});
gate.track(forever);
const timedOut = await gate.waitForIdle(20);
assert.equal(timedOut.timedOut, true, "по таймауту timedOut=true");
assert.equal(timedOut.remaining, 1, "незавершённая операция посчитана");

console.log("Shutdown gate: все проверки пройдены.");
