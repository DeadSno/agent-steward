/**
 * Параллельный прогон того же набора сюит, что `npm test`.
 *
 * Читает `scripts.test` из package.json, разбивает цепочку по `&&` и запускает
 * наборы пулом воркеров. Последовательный `npm test` остаётся как есть — он
 * нужен для воспроизводимости и отладки.
 *
 * Запуск:
 *   node scripts/run-tests.mjs
 *   node scripts/run-tests.mjs --concurrency=2
 *   node scripts/run-tests.mjs --locale=en
 *   node scripts/run-tests.mjs --only=dashboard
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {
    concurrency: Math.max(1, Math.min(8, os.cpus().length || 4)),
    locale: null,
    only: null,
    timeoutMs: 15 * 60 * 1000,
  };

  for (const arg of argv) {
    if (arg === "--serial") options.concurrency = 1;
    else if (arg.startsWith("--concurrency=")) {
      const value = Number(arg.slice("--concurrency=".length));
      if (!Number.isInteger(value) || value < 1) {
        console.error(`Некорректная конкурентность: ${arg}`);
        process.exit(2);
      }
      options.concurrency = Math.min(8, value);
    } else if (arg.startsWith("--locale=")) {
      options.locale = arg.slice("--locale=".length);
      if (!["ru", "en", "zh"].includes(options.locale)) {
        console.error(`Неизвестная локаль: ${options.locale}. Ожидается ru, en или zh.`);
        process.exit(2);
      }
    } else if (arg.startsWith("--only=")) {
      options.only = arg.slice("--only=".length);
    } else if (arg.startsWith("--timeout=")) {
      const seconds = Number(arg.slice("--timeout=".length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        console.error(`Некорректный таймаут: ${arg}`);
        process.exit(2);
      }
      options.timeoutMs = seconds * 1000;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "node scripts/run-tests.mjs [--concurrency=N] [--serial] [--locale=ru|en|zh]",
          "                            [--only=substring] [--timeout=seconds]",
        ].join("\n")
      );
      process.exit(0);
    } else {
      console.error(`Неизвестный аргумент: ${arg}`);
      process.exit(2);
    }
  }

  return options;
}

const options = parseArgs(process.argv.slice(2));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
let suites = pkg.scripts.test
  .split("&&")
  .map((part) => part.trim().replace(/^node\s+/, ""))
  .filter(Boolean);

if (options.only) {
  suites = suites.filter((suite) => suite.includes(options.only));
}

if (suites.length === 0) {
  console.error("Не найдено ни одного набора для запуска.");
  process.exit(1);
}

const total = suites.length;
const results = new Array(total);
let completed = 0;
let failed = 0;

const startedAt = Date.now();

function formatDuration(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function runSuite(suite, index) {
  return new Promise((resolve) => {
    const suiteStartedAt = Date.now();
    const child = spawn(process.execPath, [suite], {
      cwd: root,
      env: {
        ...process.env,
        ...(options.locale ? { OPENCODE_SCHEDULER_LOCALE: options.locale } : {}),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      const result = {
        suite,
        index,
        ok: false,
        code: null,
        durationMs: Date.now() - suiteStartedAt,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
        timedOut,
      };
      finish(result);
      resolve(result);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        suite,
        index,
        ok: code === 0 && !timedOut,
        code,
        durationMs: Date.now() - suiteStartedAt,
        stdout,
        stderr,
        timedOut,
      };
      finish(result);
      resolve(result);
    });
  });
}

function finish(result) {
  results[result.index] = result;
  completed++;
  if (!result.ok) failed++;

  const status = result.ok ? "OK  " : result.timedOut ? "TIME" : "FAIL";
  console.log(
    `[${String(completed).padStart(3)}/${total}] ${status} ${result.suite} (${formatDuration(
      result.durationMs
    )})`
  );

  if (!result.ok) {
    const output = `${result.stdout}${result.stderr}`.trim();
    if (output) {
      console.error(`--- вывод ${result.suite} ---`);
      console.error(output);
      console.error(`--- конец ${result.suite} ---`);
    }
    if (result.timedOut) {
      console.error(`Таймаут ${formatDuration(options.timeoutMs)}: ${result.suite}`);
    }
  }
}

async function main() {
  console.log(
    `Параллельный прогон: ${total} наборов, конкурентность ${options.concurrency}${
      options.locale ? `, локаль ${options.locale}` : ""
    }`
  );

  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, total) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= total) return;
      await runSuite(suites[index], index);
    }
  });

  await Promise.all(workers);

  const durationMs = Date.now() - startedAt;
  const failedSuites = results.filter((result) => !result.ok);

  console.log("");
  console.log(
    `Итого: ${total - failedSuites.length}/${total} наборов за ${formatDuration(durationMs)}`
  );

  if (failedSuites.length > 0) {
    console.error("Провалены:");
    for (const result of failedSuites) {
      console.error(`  - ${result.suite}${result.timedOut ? " (таймаут)" : ""}`);
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
