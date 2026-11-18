/**
 * B11: промпт передаётся opencode после `--`, а лимит argv POSIX
 * проверяется строгим `-ge` (MAX_ARG_STRLEN учитывает завершающий NUL).
 * Запуск: node test-prompt-argv.mjs (после npm run build).
 */
import { WRAPPER_SCRIPT } from "./dist/core/ps-wrapper.js";
import { buildBashWrapperScript } from "./dist/core/wrappers/bash.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const bashScript = buildBashWrapperScript({
  sanitizedName: "prompt-argv",
  taskName: "Prompt Argv",
  promptFile: "/tmp/prompt.txt",
  timeoutSeconds: 60,
  lockFile: "/tmp/prompt-argv.lock",
  workdir: "/tmp",
  logFile: "/tmp/prompt-argv.log",
  recorderFile: "/tmp/record-history.js",
  workspaceName: "backend",
});

const execLines = bashScript
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("exec opencode run"));

check("bash: все ветки запуска найдены", execLines.length === 8, String(execLines.length));
check(
  "bash: в каждой ветке перед промптом стоит --",
  execLines.length > 0 && execLines.every((line) => line.endsWith('-- "$PROMPT"')),
  execLines.find((line) => !line.endsWith('-- "$PROMPT"')) ?? ""
);
check(
  "bash: промпт не передаётся напрямую после флагов",
  !execLines.some((line) => /[^-] "\$PROMPT"$/.test(line))
);
check(
  "bash: лимит argv проверяется через -ge",
  bashScript.includes('if [ "$PROMPT_BYTES" -ge 131072 ]') &&
    !bashScript.includes('if [ "$PROMPT_BYTES" -gt 131072 ]')
);
check(
  "bash: сообщение об ошибке называет максимум 131071",
  bashScript.includes("(максимум 131071)")
);

check(
  "PowerShell: -- добавляется отдельным аргументом",
  WRAPPER_SCRIPT.includes('$opencodeArgs += @("--", $prompt)')
);
check(
  "PowerShell: промпт не добавляется без --",
  !WRAPPER_SCRIPT.split("\n").some((line) => line.trim().startsWith("$opencodeArgs += $prompt"))
);

console.log(`\n${failed === 0 ? "OK" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
