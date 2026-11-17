// P2-11: валидация идентификатора модели до подстановки в командную строку.
// Модель приходит из tool-аргументов и попадает в PowerShell/скрипты, поэтому
// в ней не должно быть символов подстановки ($, `, ;, кавычки, пробелы и т.п.).
//
// Запуск: node test-model-validation.mjs (после npm run build).
import { strict as assert } from "node:assert";

const { validateModelId } = await import("./dist/types.js");

const valid = [
  "anthropic/claude-sonnet-4",
  "openai/gpt-5",
  "openai/gpt-5#high",
  "google/gemini-2.5-pro",
  "local/llama3.2:8b",
  "provider/model_name.v1-beta",
];
for (const model of valid) {
  assert.strictEqual(
    validateModelId(model),
    null,
    `валидная модель «${model}» должна приниматься`
  );
}

const invalid = [
  "bad;calc",
  "$(calc.exe)",
  "`calc.exe`",
  "bad model",
  "a/b#c#d",
  'a"b',
  "a'b",
  "a\nb",
  "a\rb",
  "модель/тест",
  "a/b#",
  "#high",
  "a/b|c",
  "a/b&calc",
];
for (const model of invalid) {
  const error = validateModelId(model);
  assert.ok(
    error,
    `невалидная модель ${JSON.stringify(model)} должна отвергаться`
  );
  assert.ok(
    error.includes(model),
    "текст ошибки содержит исходное значение модели"
  );
}

// Пустая строка/пробелы означают «модель не задана» — это не ошибка.
assert.strictEqual(validateModelId(""), null);
assert.strictEqual(validateModelId("   "), null);

// P2-11.T1.2: свободный текст уходит в .cmd только в base64 — payload из
// model/workspaceName/списка инструментов не должен появляться в командной строке.
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-model-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

try {
  const { writeWrapperCmd, writePromptFile, ensureWrapper } = await import(
    "./dist/core/ps-wrapper.js"
  );
  const promptFile = await writePromptFile("ModelGuard", "test");
  await ensureWrapper();

  const payloadModel = "m$(calc.exe)";
  const payloadWorkspace = "ws`$(calc.exe)%PATH%";
  const payloadTool = "read$(calc.exe)";
  const cmdFile = await writeWrapperCmd(
    "ModelGuard",
    "ModelGuard",
    promptFile,
    60,
    path.join(tempRoot, "lock"),
    tempRoot,
    undefined,
    undefined,
    undefined,
    payloadModel,
    undefined,
    undefined,
    payloadWorkspace,
    [payloadTool],
    []
  );
  const cmdText = fs.readFileSync(cmdFile, "utf8");

  assert.ok(!cmdText.includes("calc.exe"), "payload не попадает в .cmd");
  assert.ok(!cmdText.includes("%PATH%"), "%PATH% не попадает в .cmd");

  const decode = (flag) => {
    const match = cmdText.match(new RegExp(`${flag} "([^"]+)"`));
    assert.ok(match, `в .cmd есть ${flag}`);
    return Buffer.from(match[1], "base64").toString("utf8");
  };
  assert.strictEqual(decode("-ModelB64"), payloadModel);
  assert.strictEqual(decode("-WorkspaceNameB64"), payloadWorkspace);
  assert.strictEqual(decode("-AllowedToolsB64"), payloadTool);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(
  `Model validation: ${valid.length + invalid.length + 2} проверок и base64-обёртка пройдены.`
);
