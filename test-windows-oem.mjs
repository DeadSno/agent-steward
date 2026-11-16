// T-06: декодирование консоли Windows — OEMCP из реестра вместо жёсткой cp866.
//
// Проверяет:
//  1. getOemCodePage() возвращает корректный номер кодовой страницы (> 0).
//  2. decodeConsoleOutputSync() корректно декодирует байты в OEM-кодировке (cp866).
//  3. Валидный UTF-8 проходит без изменений.
//  4. Невалидный UTF-8 с cp866-байтами декодируется через OEMCP.
//
// Запуск: node test-windows-oem.mjs (после npm run build).
import { strict as assert } from "node:assert";
import {
  getOemCodePage,
  decodeConsoleOutputSync,
} from "./dist/core/scheduler/windows.js";

// 1. OEMCP из реестра — положительное число.
const cp = await getOemCodePage();
console.log(`OEMCP=${cp}`);
assert.ok(Number.isInteger(cp) && cp > 0 && cp < 65536, `OEMCP должен быть числом > 0, получено: ${cp}`);

// Повторный вызов должен вернуть кэшированное значение.
const cp2 = await getOemCodePage();
assert.strictEqual(cp2, cp, "OEMCP должен кэшироваться");

// 2. CP866: "Привет" (байты через iconv-lite: 8f e0 a8 a2 a5 e2).
const cp866Bytes = Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]);
const decoded = decodeConsoleOutputSync(cp866Bytes);
assert.strictEqual(decoded, "Привет", `Ожидалось "Привет", получено: "${decoded}"`);

// 3. Валидный UTF-8 проходит без изменений.
const utf8 = Buffer.from("Hello, World!", "utf8");
assert.strictEqual(
  decodeConsoleOutputSync(utf8),
  "Hello, World!",
  "UTF-8 должен пройти без изменений"
);
const utf8Ru = Buffer.from("Привет, мир!", "utf8");
assert.strictEqual(
  decodeConsoleOutputSync(utf8Ru),
  "Привет, мир!",
  "UTF-8 с кириллицей должен пройти без изменений"
);

// 4. Пустая / null / undefined / строка.
assert.strictEqual(decodeConsoleOutputSync(null), "");
assert.strictEqual(decodeConsoleOutputSync(undefined), "");
assert.strictEqual(decodeConsoleOutputSync(Buffer.alloc(0)), "");
assert.strictEqual(decodeConsoleOutputSync("уже строка"), "уже строка");

// 5. getOemCodePage на этой машине — 866 (русская Windows) или другая OEM.
//    Ценность теста: не падает, возвращает число.
console.log(`getOemCodePage() = ${cp} (ожидается 866 на русской Windows)`);

console.log("T-06: все проверки пройдены.");
