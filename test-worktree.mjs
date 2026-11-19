/**
 * W-1.3: тесты одноразового git worktree (без Docker) и интеграции с обёртками.
 * Запуск: node test-worktree.mjs (после npm run build).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-worktree-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { isGitRepository, createRunWorktree, WORKTREE_ROOT_DIR } = await import(
  "./dist/core/worktree.js"
);
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

/** Создаёт настоящий git-репозиторий с одним коммитом. */
function makeRepo(name) {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const repo = makeRepo("repo");
const notRepo = path.join(tempRoot, "plain");
fs.mkdirSync(notRepo, { recursive: true });
const worktreeRoot = path.join(tempRoot, "worktrees");
const helper = path.join(process.cwd(), "dist", "core", "worktree-run.js");

// 1. Определение репозитория.
{
  const root = await isGitRepository(repo);
  check("isGitRepository: настоящий репозиторий → корень", Boolean(root) && fs.existsSync(root));
  check("isGitRepository: обычный каталог → null", (await isGitRepository(notRepo)) === null);
  check("isGitRepository: пустой путь → null", (await isGitRepository("")) === null);
}

// 2. Создание worktree.
let first;
{
  const result = await createRunWorktree({
    repoDir: repo,
    taskName: "Ночная сборка / fan-out",
    rootDir: worktreeRoot,
  });
  first = result;
  check("createRunWorktree: успех", result.ok === true);
  if (result.ok) {
    const wt = result.worktree;
    check("worktree: каталог существует", fs.existsSync(wt.path));
    check("worktree: файл из базового коммита на месте", fs.existsSync(path.join(wt.path, "README.md")));
    check("worktree: репозиторий определён", path.resolve(wt.repoRoot).toLowerCase() === path.resolve(repo).toLowerCase());
    check("worktree: базовая ветка agent-steward/", wt.branch.startsWith("agent-steward/"));
    check("worktree: baseCommit — 40 hex", /^[0-9a-f]{40}$/.test(wt.baseCommit));
    check("worktree: уникальный путь вне репозитория", !wt.path.startsWith(repo));
    check("worktree: sidecar для очистки записан", fs.existsSync(`${wt.path}.json`));
    const sidecar = JSON.parse(fs.readFileSync(`${wt.path}.json`, "utf8"));
    check("worktree: sidecar содержит имя задачи", sidecar.taskName === "Ночная сборка / fan-out");
    check(
      "worktree: ветка видна в git worktree list",
      git(repo, ["worktree", "list", "--porcelain"]).includes(wt.branch),
    );
  }
}

// 3. Уникальность пути и ветки у повторного запуска.
{
  const second = await createRunWorktree({
    repoDir: repo,
    taskName: "Ночная сборка / fan-out",
    rootDir: worktreeRoot,
  });
  check("повторный запуск: успех", second.ok === true);
  check(
    "повторный запуск: другой путь и ветка",
    second.ok && first.ok && second.worktree.path !== first.worktree.path &&
      second.worktree.branch !== first.worktree.branch,
  );
}

// 4. Fan-out: параллельные запуски не мешают друг другу (W-1.3, без Docker).
{
  const parallel = await Promise.all(
    ["fan-a", "fan-b", "fan-c"].map((taskName) =>
      createRunWorktree({ repoDir: repo, taskName, rootDir: worktreeRoot }),
    ),
  );
  check("fan-out: все три запуска успешны", parallel.every((item) => item.ok));
  const paths = parallel.filter((item) => item.ok).map((item) => item.worktree.path);
  const branches = parallel.filter((item) => item.ok).map((item) => item.worktree.branch);
  check("fan-out: пути уникальны", new Set(paths).size === 3);
  check("fan-out: ветки уникальны", new Set(branches).size === 3);
  check("fan-out: у каждого своя рабочая копия", paths.every((item) => fs.existsSync(item)));
}

// 5. Fail-closed: не репозиторий и пустые параметры.
{
  const notGit = await createRunWorktree({
    repoDir: notRepo,
    taskName: "broken",
    rootDir: worktreeRoot,
  });
  check("не git-репозиторий: ok=false", notGit.ok === false);
  check("не git-репозиторий: понятная ошибка", notGit.ok === false && notGit.error.includes("git"));

  const noDir = await createRunWorktree({ repoDir: "", taskName: "x" });
  check("пустая рабочая директория: ok=false", noDir.ok === false);
  const noName = await createRunWorktree({ repoDir: repo, taskName: "  " });
  check("пустое имя задачи: ok=false", noName.ok === false);
}

// 6. CLI-помощник обёртки.
{
  const ok = spawnSync(
    process.execPath,
    [helper, "--repo", repo, "--task", "cli-task", "--root", worktreeRoot],
    { encoding: "utf8", windowsHide: true },
  );
  const output = (ok.stdout ?? "").trim();
  check("CLI: код 0", ok.status === 0);
  check("CLI: печатает только путь", output.length > 0 && !output.includes("\n"));
  check("CLI: путь существует", fs.existsSync(output));

  const json = spawnSync(
    process.execPath,
    [helper, "--repo", repo, "--task", "cli-json", "--root", worktreeRoot, "--json"],
    { encoding: "utf8", windowsHide: true },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(json.stdout ?? "");
  } catch {
    parsed = null;
  }
  check("CLI --json: код 0 и структура", json.status === 0 && parsed?.path && parsed?.branch);

  const bad = spawnSync(
    process.execPath,
    [helper, "--repo", notRepo, "--task", "cli-bad", "--root", worktreeRoot],
    { encoding: "utf8", windowsHide: true },
  );
  check("CLI: не репозиторий → код 1", bad.status === 1);
  check("CLI: ошибка в stderr", (bad.stderr ?? "").includes("[worktree]"));

  const missing = spawnSync(process.execPath, [helper, "--task", "x"], {
    encoding: "utf8",
    windowsHide: true,
  });
  check("CLI: нет --repo → код 1", missing.status === 1);

  const unknown = spawnSync(process.execPath, [helper, "--repo", repo, "--nope"], {
    encoding: "utf8",
    windowsHide: true,
  });
  check("CLI: неизвестный флаг → код 1", unknown.status === 1);
}

// 7. Windows-обёртка: worktree включается только по флагу.
{
  const common = [
    "wt-task",
    "wt task",
    path.join(tempRoot, "prompt.txt"),
    60,
    path.join(tempRoot, "lock"),
    repo,
    path.join(tempRoot, "run.log"),
  ];
  const withWt = await writeWrapperCmd(...common, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    "new", undefined, undefined, undefined, undefined, undefined, true, helper);
  const text = fs.readFileSync(withWt, "utf8");
  check("Windows .cmd: создаёт worktree", text.includes("AGENT_STEWARD_WORKTREE"));
  check("Windows .cmd: переходит в worktree", text.includes('cd /d "%AGENT_STEWARD_WORKTREE%"'));
  check("Windows .cmd: запоминает репозиторий", text.includes("AGENT_STEWARD_WORKTREE_REPO"));
  check("Windows .cmd: fail-closed при ошибке", text.includes("git worktree creation failed"));
  check("Windows .cmd: путь помощника", text.includes("worktree-run.js"));

  const withoutWt = await writeWrapperCmd(...common);
  const plain = fs.readFileSync(withoutWt, "utf8");
  check("Windows .cmd: без флага нет создания worktree", !plain.includes("AGENT_STEWARD_WORKTREE"));
}

// 8. POSIX-обёртка: флаг, fail-closed и контекст промпта.
{
  const enabled = buildBashWrapperScript({
    sanitizedName: "wt-task",
    taskName: "wt task",
    promptFile: "/tmp/prompt.txt",
    timeoutSeconds: 60,
    lockFile: "/tmp/lock",
    workdir: repo,
    logFile: "/tmp/run.log",
    sessionMode: "new",
    worktree: true,
    worktreeHelper: helper,
  });
  check("bash: WORKTREE_MODE=1", enabled.includes("WORKTREE_MODE=1"));
  check("bash: помощник указан", enabled.includes("worktree-run.js"));
  check("bash: fail-closed", enabled.includes("не удалось создать git worktree"));
  check("bash: экспорт пути", enabled.includes("export AGENT_STEWARD_WORKTREE"));
  check("bash: cd в worktree", enabled.includes('cd "$AGENT_STEWARD_WORKTREE"'));
  check("bash: контекст в промпте", enabled.includes("одноразовый git worktree: $AGENT_STEWARD_WORKTREE"));

  const disabled = buildBashWrapperScript({
    sanitizedName: "wt-task",
    taskName: "wt task",
    promptFile: "/tmp/prompt.txt",
    timeoutSeconds: 60,
    lockFile: "/tmp/lock",
    workdir: repo,
    sessionMode: "new",
  });
  check("bash: WORKTREE_MODE=0 по умолчанию", disabled.includes("WORKTREE_MODE=0"));
  check("bash: без флага WORKTREE_MODE=0 и ветка не активируется", disabled.includes("WORKTREE_MODE=0") && !disabled.includes("WORKTREE_MODE=1"));
}

// 9. Импорт определения сохраняет флаг worktree.
{
  const { tasks, errors } = parseImportJson(
    JSON.stringify({
      tasks: [
        {
          name: "imported wt",
          schedule: "0 3 * * *",
          prompt: "do work",
          worktree: true,
        },
        {
          name: "imported plain",
          schedule: "0 4 * * *",
          prompt: "do work",
        },
      ],
    }),
  );
  check("import: без ошибок", errors.length === 0 && tasks.length === 2);
  check("import: worktree=true сохранён", tasks[0]?.worktree === true);
  check("import: worktree по умолчанию не задан", tasks[1]?.worktree === undefined);
}

// 10. Корень по умолчанию — вне репозитория, рядом с данными плагина.
{
  const insideRepo = WORKTREE_ROOT_DIR.startsWith(repo);
  check("WORKTREE_ROOT_DIR: вне рабочего репозитория", !insideRepo);
  check("WORKTREE_ROOT_DIR: внутри данных плагина", WORKTREE_ROOT_DIR.includes("worktrees"));
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nWorktree: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length > 0) {
  process.exitCode = 1;
} else {
  // Не оставляем за собой временные репозитории и worktree.
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Windows может держать дескрипторы недолго — каталог в temp безопасен.
  }
}
