/**
 * W-3.3: тесты guard-условий (shell и семантических), CLI и обёрток.
 * Запуск: node test-guards.mjs (после npm run build).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-guards-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  normalizeTaskGuards,
  evaluateGuards,
  GUARD_SKIP_EXIT_CODE,
} = await import("./dist/core/guard.js");
const { main: guardMain } = await import("./dist/core/guard-run.js");
const { parseImportJson } = await import("./dist/task-transfer.js");
const { writeWrapperCmd } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function makeRepo(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# guards\n", "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  git(dir, ["add", "src/a.ts"]);
  git(dir, ["commit", "-q", "-m", "add src"]);
  return dir;
}

const repo = makeRepo("repo");
const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
const helper = path.join(process.cwd(), "dist", "core", "guard-run.js");

// 1. Нормализация.
{
  check("normalize: undefined → без guards", normalizeTaskGuards(undefined).ok === true &&
    normalizeTaskGuards(undefined).guards === undefined);
  check("normalize: пустой объект → без guards", normalizeTaskGuards({}).ok === true &&
    normalizeTaskGuards({}).guards === undefined);
  check("normalize: неизвестный ключ → ошибка", normalizeTaskGuards({ nope: 1 }).ok === false);
  check("normalize: пустая команда → ошибка", normalizeTaskGuards({ command: "   " }).ok === false);
  check("normalize: timeout 0 → ошибка", normalizeTaskGuards({ timeoutSeconds: 0 }).ok === false);
  check("normalize: timeout 3601 → ошибка", normalizeTaskGuards({ timeoutSeconds: 3601 }).ok === false);
  check(
    "normalize: timeout 1..3600 допустим",
    normalizeTaskGuards({ timeoutSeconds: 1 }).ok && normalizeTaskGuards({ timeoutSeconds: 3600 }).ok,
  );
  check(
    "normalize: абсолютный путь → ошибка",
    normalizeTaskGuards({ semantic: { filesExist: ["/etc/passwd"] } }).ok === false &&
      normalizeTaskGuards({ semantic: { filesExist: ["C:/x"] } }).ok === false,
  );
  check(
    "normalize: выход из каталога → ошибка",
    normalizeTaskGuards({ semantic: { filesExist: ["../x"] } }).ok === false &&
      normalizeTaskGuards({ semantic: { filesExist: ["a/../../x"] } }).ok === false,
  );
  check(
    "normalize: changedSince с ведущим дефисом → ошибка",
    normalizeTaskGuards({ semantic: { changedSince: "--all" } }).ok === false,
  );
  check(
    "normalize: неизвестный semantic-ключ → ошибка",
    normalizeTaskGuards({ semantic: { nope: true } }).ok === false,
  );
  const normalized = normalizeTaskGuards({
    command: "echo ok",
    timeoutSeconds: 5,
    semantic: {
      filesExist: ["src/a.ts"],
      filesMissing: ["dist"],
      branch,
      changedPaths: ["src/**"],
      changedSince: "HEAD~1",
    },
  });
  check("normalize: валидная конфигурация проходит", normalized.ok && Boolean(normalized.guards));
  check(
    "normalize: пути нормализованы к /",
    normalized.ok && normalized.guards.semantic.filesExist[0] === "src/a.ts",
  );
}

// 2. Семантические guard-условия.
{
  const pass = await evaluateGuards(
    { semantic: { filesExist: ["README.md", "src/a.ts"] } },
    { cwd: repo },
  );
  check("semantic: filesExist проходит", pass.passed === true);

  const missing = await evaluateGuards(
    { semantic: { filesExist: ["README.md", "src/missing.ts"] } },
    { cwd: repo },
  );
  check("semantic: filesExist с отсутствующим файлом → skip", missing.passed === false);
  check(
    "semantic: причина содержит имя файла",
    missing.reasons.some((reason) => reason.includes("src/missing.ts")),
  );

  const missingOk = await evaluateGuards(
    { semantic: { filesMissing: ["dist", "src/missing.ts"] } },
    { cwd: repo },
  );
  check("semantic: filesMissing проходит", missingOk.passed === true);
  fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
  const missingFail = await evaluateGuards(
    { semantic: { filesMissing: ["dist"] } },
    { cwd: repo },
  );
  check("semantic: filesMissing с существующим путём → skip", missingFail.passed === false);

  const branchOk = await evaluateGuards({ semantic: { branch } }, { cwd: repo });
  check("semantic: branch совпадает", branchOk.passed === true);
  const branchFail = await evaluateGuards(
    { semantic: { branch: "definitely-not-this-branch" } },
    { cwd: repo },
  );
  check("semantic: branch не совпадает → skip", branchFail.passed === false);

  const changedOk = await evaluateGuards(
    { semantic: { changedPaths: ["src/**"], changedSince: "HEAD~1" } },
    { cwd: repo },
  );
  check("semantic: changedPaths находит изменение", changedOk.passed === true);
  const changedFail = await evaluateGuards(
    { semantic: { changedPaths: ["docs/**"], changedSince: "HEAD~1" } },
    { cwd: repo },
  );
  check("semantic: changedPaths без совпадений → skip", changedFail.passed === false);
  const noChanges = await evaluateGuards(
    { semantic: { changedPaths: ["src/**"], changedSince: "HEAD" } },
    { cwd: repo },
  );
  check("semantic: пустой diff → skip", noChanges.passed === false);

  const escape = await evaluateGuards(
    { semantic: { filesExist: ["../outside.txt"] } },
    { cwd: repo },
  );
  check("semantic: выход за cwd → fail-closed skip", escape.passed === false);
}

// 3. Shell guard.
{
  const ok = await evaluateGuards({ command: 'node -e "process.exit(0)"' }, { cwd: repo });
  check("shell: exit 0 → pass", ok.passed === true);

  const fail = await evaluateGuards({ command: 'node -e "process.exit(3)"' }, { cwd: repo });
  check("shell: ненулевой exit → skip", fail.passed === false);
  check(
    "shell: причина содержит код",
    fail.reasons.some((reason) => reason.includes("3")),
  );

  const timed = await evaluateGuards(
    { command: 'node -e "setTimeout(() => {}, 5000)"', timeoutSeconds: 1 },
    { cwd: repo },
  );
  check("shell: таймаут → skip", timed.passed === false);
  check(
    "shell: причина содержит таймаут",
    timed.reasons.some((reason) => reason.includes("таймаут")),
  );
}

// 4. CLI helper.
{
  const b64 = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const run = (args) =>
    spawnSync(process.execPath, [helper, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });

  const pass = run(["--cwd", repo, "--guards-b64", b64({ command: 'node -e "process.exit(0)"' })]);
  check("CLI: pass → код 0", pass.status === 0);
  check("CLI: pass печатает OK", pass.stdout.includes("OK"));

  const skip = run(["--cwd", repo, "--guards-b64", b64({ command: 'node -e "process.exit(2)"' })]);
  check("CLI: skip → код 4", skip.status === 4);
  check("CLI: skip печатает причину", skip.stdout.includes("skipped"));
  check("CLI: код 4 совпадает с константой", GUARD_SKIP_EXIT_CODE === 4);

  const json = run([
    "--cwd",
    repo,
    "--guards-b64",
    b64({ semantic: { filesExist: ["README.md"] } }),
    "--json",
  ]);
  check("CLI: --json → валидный JSON", json.status === 0 && JSON.parse(json.stdout).passed === true);

  check(
    "CLI: битый base64 → код 1",
    run(["--cwd", repo, "--guards-b64", "!!!"]).status === 1,
  );
  check("CLI: без аргументов → код 1", run([]).status === 1);
  check(
    "CLI: неизвестный флаг → код 1",
    run(["--cwd", repo, "--guards-b64", b64({ command: "echo x" }), "--nope"]).status === 1,
  );
  check("CLI: main экспортирован", typeof guardMain === "function");
}

// 5. Windows-обёртка.
{
  const guards = { command: 'node -e "process.exit(0)"', semantic: { filesExist: ["README.md"] } };
  const wrapper = await writeWrapperCmd(
    "guard-task",
    "guard task",
    path.join(tempRoot, "prompt.txt"),
    60,
    path.join(tempRoot, "lock"),
    repo,
    path.join(tempRoot, "run.log"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "new",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    guards,
    helper,
  );
  const text = fs.readFileSync(wrapper, "utf8");
  check("Windows .cmd: вызывает guard helper", text.includes("guard-run.js"));
  check("Windows .cmd: передаёт base64", text.includes("--guards-b64"));
  check("Windows .cmd: сохраняет статус guard", text.includes("AGENT_STEWARD_GUARD_STATUS"));
  check("Windows .cmd: код 4 → skip", text.includes('==\"4\"') || text.includes('=="4"'));
  check("Windows .cmd: пишет причину skip", text.includes("guard: run skipped"));
  check("Windows .cmd: fail-closed на ошибке", text.includes("guard failed with code"));

  const plain = await writeWrapperCmd(
    "guard-task-plain",
    "guard task plain",
    path.join(tempRoot, "prompt.txt"),
    60,
    path.join(tempRoot, "lock"),
    repo,
    path.join(tempRoot, "run.log"),
  );
  const plainText = fs.readFileSync(plain, "utf8");
  check("Windows .cmd: без guards нет блока", !plainText.includes("AGENT_STEWARD_GUARD_STATUS"));
}

// 6. POSIX-обёртка.
{
  const enabled = buildBashWrapperScript({
    sanitizedName: "guard-task",
    taskName: "guard task",
    promptFile: "/tmp/prompt.txt",
    timeoutSeconds: 60,
    lockFile: "/tmp/lock",
    workdir: repo,
    logFile: "/tmp/run.log",
    sessionMode: "new",
    guards: { command: 'node -e "process.exit(0)"' },
    guardHelper: helper,
  });
  check("bash: GUARD_HELPER указан", enabled.includes("GUARD_HELPER=") && enabled.includes("guard-run.js"));
  check("bash: GUARD_B64 заполнен", /GUARD_B64='[^']+'/.test(enabled) || /GUARD_B64="[^"]+"/.test(enabled));
  check("bash: вызывает helper с cwd", enabled.includes('--cwd "$PWD"'));
  check("bash: код 4 → exit 0", enabled.includes('"$GUARD_STATUS" -eq 4') && enabled.includes("exit 0"));
  check("bash: ошибка → exit 1", enabled.includes('"$GUARD_STATUS" -ne 0'));
  check("bash: сообщение о пропуске", enabled.includes("guard: run skipped"));

  const disabled = buildBashWrapperScript({
    sanitizedName: "guard-task",
    taskName: "guard task",
    promptFile: "/tmp/prompt.txt",
    timeoutSeconds: 60,
    lockFile: "/tmp/lock",
    workdir: repo,
    sessionMode: "new",
  });
  check("bash: без guards helper пуст", disabled.includes("GUARD_B64=''"));
}

// 7. Импорт/экспорт определений.
{
  const { tasks, errors } = parseImportJson(
    JSON.stringify({
      tasks: [
        {
          name: "imported guards",
          schedule: "0 3 * * *",
          prompt: "do work",
          guards: { command: "echo ok", semantic: { filesExist: ["README.md"] } },
        },
        { name: "imported plain", schedule: "0 4 * * *", prompt: "do work" },
        {
          name: "imported bad",
          schedule: "0 5 * * *",
          prompt: "do work",
          guards: { semantic: { filesExist: ["/abs"] } },
        },
      ],
    }),
  );
  check("import: guards сохранены", tasks[0]?.guards?.command === "echo ok");
  check("import: без guards поле не задано", tasks[1]?.guards === undefined);
  check("import: невалидные guards → ошибка", errors.length === 1 && errors[0].includes("guards"));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nGuards: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length > 0) {
  process.exitCode = 1;
}
