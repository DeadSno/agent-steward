// Д3: разбор известных кодов и текстов ошибок schtasks.
//
// Проверяет:
//  1. HRESULT-коды статусов задач (0x41301 и др.) дают понятное пояснение.
//  2. Знаковый HRESULT (access denied) приводится к unsigned.
//  3. Текстовая эвристика работает как фолбэк при общем коде 1.
//  4. Неизвестный код/текст не подменяет сообщение (null).
//  5. SchtasksError добавляет пояснение, сохраняя code и stderr.
//
// Запуск: node test-schtasks-errors.mjs (после npm run build).
import { strict as assert } from "node:assert";
import {
  explainSchtasksError,
  SchtasksError,
} from "./dist/core/scheduler/windows.js";

// 1. Коды статусов.
assert.equal(
  explainSchtasksError(0x41301, ""),
  "Задача сейчас выполняется.",
  "0x41301 должен означать «выполняется»"
);
assert.equal(
  explainSchtasksError(0x41303, ""),
  "Задача ещё ни разу не запускалась.",
  "0x41303 должен означать «ещё не запускалась»"
);
assert.equal(
  explainSchtasksError(0x41306, ""),
  "Выполнение задачи было прервано пользователем.",
  "0x41306 должен означать «прервана»"
);

// 2. Знаковый HRESULT access denied приводится к unsigned.
assert.equal(
  explainSchtasksError(-2147024891, ""),
  "Нет прав на операцию с задачей (access denied).",
  "0x80070005 в знаковом виде должен распознаваться"
);

// 3. Текстовая эвристика при общем коде 1.
assert.equal(
  explainSchtasksError(1, "ERROR: The task is currently running."),
  "Задача уже выполняется.",
  "английский текст должен распознаваться"
);
assert.equal(
  explainSchtasksError(1, "ОШИБКА: Отказано в доступе."),
  "Нет прав на операцию с задачей (access denied).",
  "русский текст должен распознаваться"
);
assert.equal(
  explainSchtasksError(1, "cannot find the task"),
  "Задача или файл не найдены.",
  "«cannot find» должен распознаваться"
);

// 4. Неизвестный код и текст — без пояснения.
assert.equal(
  explainSchtasksError(1, "some unknown failure"),
  null,
  "неизвестная ошибка не должна получать выдуманное пояснение"
);
assert.equal(
  explainSchtasksError(null, ""),
  null,
  "null-код без текста не должен давать пояснение"
);

// 5. SchtasksError добавляет пояснение, сохраняя исходные данные.
const known = new SchtasksError("schtasks error: boom", 0x41301, "stderr text");
assert.ok(
  known.message.includes("schtasks error: boom"),
  "исходный текст ошибки должен сохраняться"
);
assert.ok(
  known.message.includes("пояснение: Задача сейчас выполняется."),
  "пояснение должно добавляться к сообщению"
);
assert.equal(known.code, 0x41301, "код должен сохраняться");
assert.equal(known.stderr, "stderr text", "stderr должен сохраняться");

const unknown = new SchtasksError("schtasks error: mystery", 1, "");
assert.equal(
  unknown.message,
  "schtasks error: mystery",
  "неизвестная ошибка не должна дополняться пояснением"
);

console.log("Schtasks errors: все проверки пройдены.");
