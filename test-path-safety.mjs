/**
 * Path-safety: writePromptFile / lockFilePath sanitize taskName themselves.
 *
 * Defence-in-depth: callers already normalize task names, but these helpers must
 * never escape the prompts/locks directories even if a hostile name reaches them.
 * Cross-platform: works on Windows, macOS and Linux.
 *
 * Run: node test-path-safety.mjs (after npm run build).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-path-"));
process.env.APPDATA = tempRoot;
const pluginDir = path.join(tempRoot, "opencode", "windows-scheduler");
process.env.OPENCODE_SCHEDULER_HOME = pluginDir;

const { writePromptFile, lockFilePath } = await import("./dist/core/ps-wrapper.js");

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

function insidePluginDir(target) {
  const relative = path.relative(pluginDir, path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// --- lockFilePath ------------------------------------------------------------
for (const hostile of ["../../evil", "..\\..\\evil", "/etc/passwd", "a/b/c"]) {
  const lock = lockFilePath(hostile);
  check(`lockFilePath(${JSON.stringify(hostile)}) внутри pluginDir/locks`,
    insidePluginDir(lock) && path.dirname(path.resolve(lock)) === path.join(pluginDir, "locks"));
}

// --- writePromptFile ---------------------------------------------------------
for (const hostile of ["../../evil", "..\\..\\evil", "/etc/passwd", "a/b/c"]) {
  const prompt = await writePromptFile(hostile, "safe prompt");
  check(`writePromptFile(${JSON.stringify(hostile)}) внутри pluginDir/prompts`,
    insidePluginDir(prompt) && path.dirname(path.resolve(prompt)) === path.join(pluginDir, "prompts"));
  const written = fs.readFileSync(prompt, "utf8").replace(/^\uFEFF/, "");
  check(`writePromptFile(${JSON.stringify(hostile)}) создаёт файл с содержимым`,
    written === "safe prompt");
}

// --- PL-139: детерминированная регрессия на кириллический prompt round-trip ---
// Могилибица при выводе в консоль PowerShell / Win32_Process.CommandLine — артефакт
// кодовой страницы терминала, а не повреждение файла: проверяем чтением как UTF-8.
const cyrillicPrompt = "ГОАЛ: проверка кириллицы — Święty Łódź 中文";
const cyrillicPath = await writePromptFile("CyrillicUtf8Probe", cyrillicPrompt);
check("writePromptFile('CyrillicUtf8Probe') возвращает путь в pluginDir/prompts",
  insidePluginDir(cyrillicPath) && path.dirname(path.resolve(cyrillicPath)) === path.join(pluginDir, "prompts"));
const cyrillicWritten = await fs.promises.readFile(cyrillicPath, "utf8");
check("writePromptFile('CyrillicUtf8Probe') round-trip кириллицы через UTF-8 (после снятия BOM)",
  cyrillicWritten.replace(/^\uFEFF/, "") === cyrillicPrompt);

// Ни один файл не должен появиться выше pluginDir.
const parentEntries = fs.readdirSync(tempRoot).filter((entry) => entry !== "opencode");
check("во временном корне нет файлов, созданных обходом пути", parentEntries.length === 0);

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log(`\nPath safety: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
