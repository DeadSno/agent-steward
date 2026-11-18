import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-steward-p230-"));
const dbPath = path.join(root, "scheduler.db");
const workerPath = path.join(root, "worker.mjs");

const distUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "db", "index.js"),
).href;
const settingsUrl = pathToFileURL(
  path.join(process.cwd(), "dist", "db", "settings-repo.js"),
).href;

await fs.writeFile(
  workerPath,
  [
    `import { initDb } from ${JSON.stringify(distUrl)};`,
    `import { decrementCounterSetting } from ${JSON.stringify(settingsUrl)};`,
    `initDb(process.env.P230_DB);`,
    `const value = decrementCounterSetting(process.env.P230_KEY, 20);`,
    `process.stdout.write(JSON.stringify(value));`,
  ].join("\n"),
  "utf8",
);

function runWorker(key) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], {
      env: { ...process.env, P230_DB: dbPath, P230_KEY: key },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`worker exit ${code}: ${err}`));
        return;
      }
      resolve(JSON.parse(out));
    });
  });
}

try {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => runWorker("retry_state:parallel-task")),
  );

  assert.equal(results.length, 20, "должно быть 20 результатов");
  assert.equal(
    new Set(results).size,
    20,
    "значения не должны повторяться (потеря декрементов)",
  );
  const sorted = [...results].sort((a, b) => a - b);
  assert.deepEqual(
    sorted,
    Array.from({ length: 20 }, (_, i) => i),
    "20 параллельных декрементов должны дать ровно 0..19",
  );
  console.log("OK: P2-30: 20 параллельных процессов дали уникальные 0..19");

  const exhausted = await runWorker("retry_state:parallel-task");
  assert.equal(exhausted, null, "21-й декремент должен вернуть null");
  console.log("OK: P2-30: исчерпанный счётчик возвращает null");

  const otherTask = await runWorker("retry_state:other-task");
  assert.equal(otherTask, 19, "счётчики разных задач независимы");
  console.log("OK: P2-30: счётчики задач независимы");

  console.log("Все проверки пройдены (retry counter): 3.");
} finally {
  // Windows may keep sqlite file handles after child processes exit.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}
