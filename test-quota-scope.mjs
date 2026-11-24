// QW-7: детектор квоты не должен читать строки из предыдущих прогонов.
// Берём реальный сгенерированный bash-код обёртки и исполняем только блок
// вычисления QUOTA_SCOPE на логе с двумя прогонами.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");

// Windows: system32\bash.exe — это WSL, он не пробрасывает env/аргументы в -c.
// Git Bash ведёт себя как обычный POSIX bash и есть на windows-latest в CI.
const bashPath =
  process.platform === "win32"
    ? [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      ].find((candidate) => {
        try {
          execFileSync(candidate, ["-c", "true"]);
          return true;
        } catch {
          return false;
        }
      })
    : "bash";
if (!bashPath) {
  console.log("QW-7: POSIX/Git bash не найден — поведенческие проверки пропущены.");
  process.exit(0);
}

let checks = 0;
function check(name, condition) {
  checks += 1;
  assert.ok(condition, name);
  console.log(`OK   ${name}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-steward-qw7-"));
try {
  // bash понимает UNIX-пути; на Windows путь из path.join надо нормализовать.
  const logFile = path.join(tempRoot, "run.log").replace(/\\/g, "/");
  const script = buildBashWrapperScript({
    sanitizedName: "quota-scope-probe",
    taskName: "Quota Scope Probe",
    promptFile: path.join(tempRoot, "prompt.txt"),
    timeoutSeconds: 60,
    lockFile: path.join(tempRoot, "quota-scope-probe.lock"),
    workdir: tempRoot,
    logFile,
    recorderFile: path.join(tempRoot, "record-history.js"),
  });

  const start = script.indexOf('QUOTA_SCOPE=""');
  const end = script.indexOf('if [ -f "$TIMEOUT_MARKER" ]', start);
  check("QW-7: блок вычисления QUOTA_SCOPE найден в обёртке", start >= 0 && end > start);
  const scopeSnippet = script.slice(start, end);

  fs.writeFileSync(
    logFile,
    [
      "[старый] === Run started 2026-11-01T00:00:00Z (Old task) ===",
      "[старый] Free usage limit reached — старый прогон",
      "[новый] === Run started 2026-11-24T12:00:00Z (Quota Scope Probe) ===",
      "[новый] завершилось с кодом 1 — обычная ошибка",
    ].join("\n") + "\n",
    "utf8",
  );

  const stdout = execFileSync(bashPath, ["-c", `${scopeSnippet}\nprintf '%s' "$QUOTA_SCOPE"`], {
    encoding: "utf8",
    env: { ...process.env, LOG_FILE: logFile },
  });
  check("QW-7: старая строка квоты не попала в сегмент текущего прогона", !stdout.includes("старый прогон"));
  check("QW-7: сегмент текущего прогона содержит свежий вывод", stdout.includes("обычная ошибка"));
  check("QW-7: маркер текущего прогона исключён из сегмента", !stdout.includes("=== Run started 2026-11-24"));

  fs.writeFileSync(
    logFile,
    [
      "[старый] === Run started 2026-11-01T00:00:00Z (Old task) ===",
      "[старый] Free usage limit reached — старый прогон",
      "[новый] === Run started 2026-11-24T12:00:00Z (Quota Scope Probe) ===",
      "[новый] Free usage limit reached — новая квота",
    ].join("\n") + "\n",
    "utf8",
  );
  const quotaOut = execFileSync(bashPath, ["-c", `${scopeSnippet}\nprintf '%s' "$QUOTA_SCOPE"`], {
    encoding: "utf8",
    env: { ...process.env, LOG_FILE: logFile },
  });
  check("QW-7: свежая строка квоты обнаруживается", quotaOut.includes("новая квота"));
  check("QW-7: старая строка квоты по-прежнему исключена", !quotaOut.includes("старый прогон"));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`QW-7: ${checks} проверок пройдено.`);
