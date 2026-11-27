// Д3: разбор известных кодов и текстов ошибок schtasks + UAC-фолбэк повышения.
//
// Проверяет:
//  1. HRESULT-коды статусов задач (0x41301 и др.) дают понятное пояснение.
//  2. Знаковый HRESULT (access denied) приводится к unsigned.
//  3. Текстовая эвристика работает фолбэком при общем коде 1.
//  4. Неизвестный код/текст не подменяет сообщение (null).
//  5. SchtasksError добавляет пояснение, сохраняя code и stderr.
//  6. UAC-фолбэк: «нет прав» распознаётся, повышение просится только для
//     изменяющих команд, выключается AGENT_STEWARD_NO_UAC и в services.
//  7. Повышенная цепочка cmd.exe → exe сохраняет argv побайтово (кириллица,
//     `& | "`, пробелы), код возврата и stderr (реальный запуск без UAC).
//
// Запуск: node test-schtasks-errors.mjs (после npm run build).
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  explainSchtasksError,
  SchtasksError,
  isAccessDeniedError,
  shouldTryElevation,
  stderrFromExecMessage,
  runSchtasksElevated,
  NO_UAC_ENV,
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

// 6. UAC-фолбэк: распознавание «нет прав» и решение о повышении.
//    «Нет прав» — только код/HRESULT или анкорированный stderr: имя задачи
//    не должно превращать любую ошибку в повод поднимать UAC-промпт.
assert.ok(
  isAccessDeniedError(
    new SchtasksError("schtasks error: ERROR: Access is denied.", 1, "ERROR: Access is denied.")
  ),
  "stderr «ERROR: Access is denied.» должен считаться отсутствием прав"
);
assert.ok(
  isAccessDeniedError(new SchtasksError("schtasks error: x", -2147024891, "")),
  "HRESULT 0x80070005 должен считаться отсутствием прав даже без текста"
);
assert.ok(
  isAccessDeniedError({ code: 5, stderr: "Отказано в доступе." }),
  "код выхода 5 и русский stderr должны считаться отсутствием прав"
);
assert.ok(!isAccessDeniedError({ code: 1, message: "schtasks error: boom", stderr: "" }), "общий код 1 без текста прав — не повод повышаться");
assert.ok(
  !isAccessDeniedError(new SchtasksError("schtasks error: x", 1, "ERROR: The task name already exists.")),
  "«уже существует» не должно выглядеть как «нет прав»"
);
assert.ok(
  !isAccessDeniedError(
    new SchtasksError(
      'schtasks error: "schtasks.exe" /create /tn "Access is denied" /f | ERROR: The task name already exists.',
      1,
      "ERROR: The task name already exists."
    )
  ),
  "имя задачи «Access is denied» в командной строке не должно вымогать повышение на чужой ошибке"
);

// Regression: a task named like the HRESULT must not open the elevation path
// on an unrelated "task not found" error.
assert.ok(
  !isAccessDeniedError(
    new SchtasksError(
      'schtasks error: "schtasks.exe" /delete /tn "0x80070005" | ERROR: The task name "0x80070005" not found.',
      1,
      'ERROR: The task name "0x80070005" not found.'
    )
  ),
  "0x80070005 in a task name must not trigger the UAC fallback"
);
assert.ok(
  isAccessDeniedError({ code: 1, stderr: "ERROR: Access is denied. (0x80070005)" }),
  "an anchored HRESULT line must still be recognized as access denied"
);

const interactive = { SESSIONNAME: "Console" };
assert.ok(shouldTryElevation(["/create", "/tn", "X"], interactive), "/create — изменяющая команда, в интерактивной сессии повышаться можно");
assert.ok(shouldTryElevation(["/DELETE", "/tn", "X", "/f"], interactive), "флаг регистронезависим");
assert.ok(!shouldTryElevation(["/query", "/v", "/fo", "LIST"], interactive), "чтение не должно поднимать UAC-промпт");
assert.ok(!shouldTryElevation(["/create", "/tn", "X"], {}), "без SESSIONNAME — сервисный контекст, согласия ждать не от кого");
assert.ok(!shouldTryElevation(["/create", "/tn", "X"], { SESSIONNAME: "Services" }), "в services/session 0 промпт показывать некому");
assert.ok(shouldTryElevation(["/create", "/tn", "X"], { SESSIONNAME: "RDP-Tcp#0" }), "RDP-сессия тоже интерактивная");
assert.ok(!shouldTryElevation(["/create", "/tn", "X"], { ...interactive, [NO_UAC_ENV]: "1" }), "AGENT_STEWARD_NO_UAC=1 выключает фолбэк");
assert.ok(!shouldTryElevation(["/create", "/tn", "X"], { ...interactive, [NO_UAC_ENV]: "true" }), "истинные значения тоже выключают фолбэк");
assert.ok(shouldTryElevation(["/create", "/tn", "X"], { ...interactive, [NO_UAC_ENV]: "0" }), "AGENT_STEWARD_NO_UAC=0 фолбэк НЕ выключает");

// 7. Повышение самого exe (без UAC, с заглушкой вместо schtasks.exe): массив
//    аргументов и код возврата должны дожить до конца. Вывод повышенного
//    процесса намеренно не перехватывается — заглушка пишет argv в файл сама.
if (process.platform === "win32") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "as-uac-test-"));
  try {
    const argvScript = path.join(dir, "stub-argv.mjs");
    await fs.writeFile(
      argvScript,
      [
        "import fs from \"node:fs\";",
        "const out = process.argv[process.argv.length - 1];",
        "fs.writeFileSync(out, JSON.stringify(process.argv.slice(1, -1)));",
        "process.exit(3);",
        "",
      ].join("\n")
    );

    const argsFile = path.join(dir, "argv.json");
    const args = [
      argvScript,
      "/create",
      "/tn",
      'OpenCode\\agent-steward\\Тест & | "кавычка"',
      "/tr",
      '"C:\\Program Files\\agent-steward\\wrapper.cmd" /with space',
      "/sc",
      "ONCE",
      "/f",
      argsFile,
    ];
    // Целевой exe — настоящий (node.exe), как schtasks.exe: без cmd-ассоциации,
    // честная проверка argv-верности. verb=null — запуск без повышения; "open" —
    // та же ветка ShellExecute, что и «-Verb RunAs», но без самого UAC-промпта.
    for (const verb of [null, "open"]) {
      await fs.rm(argsFile, { force: true });
      const res = await runSchtasksElevated(args, { verb, exe: process.execPath });
      assert.equal(res.code, 3, `код возврата заглушки должен вернуться (verb=${verb})`);
      assert.deepEqual(
        JSON.parse(await fs.readFile(argsFile, "utf8")),
        args.slice(0, -1),
        `argv должен дойти до exe без искажений (verb=${verb})`
      );
      assert.equal(res.stdout, "", `повышенный запуск не перехватывает вывод (verb=${verb})`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
} else {
  console.log("пропуск 7: повышение самого exe проверяется только на Windows");
}

// 8. SchtasksError несёт флаг taskMissing — по нему runTask уходит в
//    legacy-папку, когда вывод повышенного запуска не перехвачен. Само
//    решение принимает код выхода читающего /query, не текст; ветка с
//    реальным UAC проверяется живьём (CI без промпта её не пройдёт).
assert.equal(new SchtasksError("x", 1, "").taskMissing, false);
assert.equal(new SchtasksError("x", 1, "", true).taskMissing, true);

// 9. Bun (the OpenCode runtime) does not attach stderr to execFile errors —
//    the text lives only in message. Without recovery, the UAC fallback stays
//    silent inside the plugin (verified live: create/delete failed without a prompt).
assert.equal(
  isAccessDeniedError({ code: 1, stderr: stderrFromExecMessage("ERROR: Access is denied.\r\r\n") }),
  true,
  "Bun format: message without prefix -> stderr recovered, access denied detected",
);
assert.equal(
  stderrFromExecMessage("Command failed: schtasks /create /tn X /tr Y /sc once\r\nERROR: Access is denied."),
  "ERROR: Access is denied.",
  "Node format: take the lines after Command failed",
);
// Spoofing is still dead: a task name in the command line cannot produce an
// "Access is denied" line at the start of the string.
assert.equal(
  isAccessDeniedError({
    code: 1,
    stderr: stderrFromExecMessage(
      'Command failed: schtasks /delete /tn "Access is denied" /f\nERROR: The task name "Access is denied" not found.',
    ),
  }),
  false,
  "a task named \"Access is denied\" must not extort a prompt",
);

console.log("Schtasks errors: все проверки пройдены.");
