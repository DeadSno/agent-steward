import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LockManager, ownerPidFromToken, parseLockToken } from "./dist/core/lock.js";
import { PS_LOCK_PID_FUNCTION, WRAPPER_SCRIPT } from "./dist/core/ps-wrapper.js";
import { BASH_LOCK_PID_FUNCTION, buildBashWrapperScript } from "./dist/core/wrappers/bash.js";

let passed = 0;
let failed = 0;

function check(ok, name, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

function eq(actual, expected, name) {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

const ISO = "2026-11-18T10:20:30.000Z";
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

console.log("Lock token format (B6)");

// --- 1. Общий парсер: все известные форматы -------------------------------
eq(
  parseLockToken(`${4321}-${ISO}`),
  { pid: 4321, createdAt: ISO, format: "unified" },
  "parse: единый <pid>-<iso>",
);
eq(
  parseLockToken(`${4321}-${ISO}-${UUID}`),
  { pid: 4321, createdAt: ISO, format: "unified" },
  "parse: единый токен с uuid-суффиксом",
);
eq(
  parseLockToken(`4321-1731912345678-${UUID}`),
  { pid: 4321, createdAt: null, format: "node-legacy" },
  "parse: старый Node <pid>-<epoch>-<uuid>",
);
eq(
  parseLockToken(`4321-1731912345678-live-owner`),
  { pid: 4321, createdAt: null, format: "node-legacy" },
  "parse: старый Node с произвольным суффиксом",
);
eq(
  parseLockToken(`2026-11-18T10:20:30.1234567Z|8765`),
  { pid: 8765, createdAt: "2026-11-18T10:20:30.1234567Z", format: "ps-legacy" },
  "parse: legacy PS ISO|PID (PID, а не год)",
);
eq(
  parseLockToken("8765\n"),
  { pid: 8765, createdAt: null, format: "pid" },
  "parse: голый PID с переводом строки",
);
eq(parseLockToken(String(Date.now())).pid, null, "parse: epoch без разделителя не владелец");
eq(parseLockToken("").pid, null, "parse: пустой токен");
eq(parseLockToken("not-a-lock").pid, null, "parse: мусор");
eq(parseLockToken(ISO).pid, null, "parse: ISO без PID не владелец");
eq(parseLockToken(`${ISO}|`).pid, null, "parse: legacy PS без PID");
eq(ownerPidFromToken(`2026-11-18T10:00:00Z|4242`), 4242, "ownerPidFromToken: legacy PS");

// --- 2. Node пишет единый формат -----------------------------------------
const home = await fs.mkdtemp(path.join(os.tmpdir(), "lock-format-"));
const lockDir = path.join(home, "locks");
try {
  const manager = new LockManager(lockDir);
  const token = await manager.acquire("alpha");
  check(typeof token === "string", "Node: lock захвачен");
  const tokenInfo = parseLockToken(token);
  eq(tokenInfo.pid, process.pid, "Node: токен начинается с PID");
  eq(tokenInfo.format, "unified", "Node: формат unified");
  const onDisk = await fs.readFile(manager.pathFor("alpha"), "utf8");
  eq(parseLockToken(onDisk).pid, process.pid, "Node: на диске читаемый PID");
  check(await manager.release("alpha", token), "Node: release удаляет свой lock");
  check(!(await manager.isLocked("alpha")), "Node: после release lock свободен");

  // --- 3. Interop: Node не вытесняет живой PS-lock -----------------------
  const writeOld = async (file, content) => {
    const full = path.join(lockDir, file);
    await fs.writeFile(full, content, "utf8");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(full, old, old);
    return full;
  };

  await writeOld("ps-live.lock", `2026-11-18T10:20:30.1234567Z|${process.pid}`);
  await writeOld("node-live.lock", `${process.pid}-${ISO}-${UUID}`);
  await writeOld("ps-dead.lock", `2026-11-18T10:20:30.1234567Z|4000000`);
  await writeOld("node-dead.lock", `4000000-${ISO}`);
  await manager.initialize();

  check(
    await fs.stat(path.join(lockDir, "ps-live.lock")).then(() => true, () => false),
    "interop: старый legacy-PS lock живого PID сохранён",
  );
  check(
    await fs.stat(path.join(lockDir, "node-live.lock")).then(() => true, () => false),
    "interop: старый Node lock живого PID сохранён",
  );
  check(
    !(await fs.stat(path.join(lockDir, "ps-dead.lock")).then(() => true, () => false)),
    "interop: legacy-PS lock мёртвого PID вытеснен",
  );
  check(
    !(await fs.stat(path.join(lockDir, "node-dead.lock")).then(() => true, () => false)),
    "interop: Node lock мёртвого PID вытеснен",
  );

  // --- 4. Текст обёрток ---------------------------------------------------
  check(
    WRAPPER_SCRIPT.includes(PS_LOCK_PID_FUNCTION),
    "PS: общий парсер вставлен в обёртку",
  );
  check(
    // PL-146: unified-токен пишут и lock, и checkout-lock — всего 4 места.
    (WRAPPER_SCRIPT.match(/GetBytes\("\$PID-\$startedAtIso"\)/g) ?? []).length === 4,
    "PS: все места пишут единый <pid>-<iso>",
  );
  check(!WRAPPER_SCRIPT.includes("$startedAtIso|$PID"), "PS: старый ISO|PID больше не пишется");

  const bashScript = buildBashWrapperScript({
    sanitizedName: "t",
    taskName: "t",
    promptFile: "C:/tmp/prompt.txt",
    timeoutSeconds: 10,
    lockFile: "C:/tmp/locks/t.lock",
  });
  check(bashScript.includes(BASH_LOCK_PID_FUNCTION), "bash: общий парсер вставлен в обёртку");
  check(
    bashScript.includes('if [ -f "$LOCK_FILE" ]'),
    "bash: проверяет файловый lock Node/PS",
  );
  check(
    bashScript.includes('"$$-$(date -u +%Y-%m-%dT%H:%M:%SZ)"'),
    "bash: pid-файл пишется в едином формате",
  );

  // --- 5. Реальные парсеры PS и bash -------------------------------------
  const tokens = [
    [`4321-${ISO}`, 4321],
    [`4321-${ISO}-${UUID}`, 4321],
    ["2026-11-18T10:20:30.1234567Z|8765", 8765],
    ["8765", 8765],
  ];

  if (process.platform === "win32") {
    const psFile = path.join(home, "lock-parse.ps1");
    const cases = tokens
      .map(([text, want]) => `  @{ Text = '${text}'; Want = ${want} }`)
      .join(",\n");
    await fs.writeFile(
      psFile,
      `\uFEFF${PS_LOCK_PID_FUNCTION}\n` +
        `$cases = @(\n${cases}\n)\n` +
        `foreach ($c in $cases) {\n` +
        `  $got = Get-LockOwnerPid -Content $c.Text\n` +
        `  if ($got -ne $c.Want) { Write-Output ("FAIL|" + $c.Text + "|" + $got); exit 1 }\n` +
        `}\n` +
        `if ((Get-LockOwnerPid -Content "$PID-${ISO}") -ne $PID) { Write-Output "FAIL|self"; exit 1 }\n` +
        `if ((Get-LockOwnerPid -Content "${ISO}") -ne 0) { Write-Output "FAIL|iso"; exit 1 }\n` +
        `Write-Output "OK"\n`,
      "utf8",
    );
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile],
      { encoding: "utf8", timeout: 60000 },
    );
    check(
      res.status === 0 && /OK/.test(String(res.stdout ?? "")),
      "PS: реальный Get-LockOwnerPid читает все форматы",
      String(res.stderr ?? res.error?.message ?? res.stdout ?? "").slice(0, 200),
    );
  } else {
    console.log("skip - PS: powershell.exe доступен только на Windows");
  }

  const bashProbe = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
  if (bashProbe.status === 0) {
    const cases = tokens
      .map(([text, want]) => `check '${text}' '${want}'`)
      .join("\n");
    const shSource =
      `#!/usr/bin/env bash\nset -u\n${BASH_LOCK_PID_FUNCTION}\n` +
      `check() {\n  local got\n  got="$(parse_lock_pid "$1")"\n` +
      `  if [ "$got" != "$2" ]; then echo "FAIL|$1|$got"; exit 1; fi\n}\n` +
      `${cases}\ncheck 'not-a-lock' ''\ncheck '${ISO}' ''\necho OK\n`;
    // Через stdin: Git Bash на Windows может не видеть временные файлы Node.
    const res = spawnSync("bash", ["-s"], {
      input: shSource,
      encoding: "utf8",
      timeout: 60000,
    });
    check(
      res.status === 0 && /OK/.test(String(res.stdout ?? "")),
      "bash: реальный parse_lock_pid читает все форматы",
      String(res.stderr ?? res.error?.message ?? res.stdout ?? "").slice(0, 200),
    );

    const syntax = spawnSync("bash", ["-n", "-s"], {
      input: bashScript,
      encoding: "utf8",
    });
    check(
      syntax.status === 0,
      "bash: сгенерированная обёртка синтаксически валидна",
      String(syntax.stderr ?? syntax.error?.message ?? "").slice(0, 300),
    );
  } else {
    console.log("skip - bash недоступен в PATH");
  }
} finally {
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}

console.log(`\nLock format: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
