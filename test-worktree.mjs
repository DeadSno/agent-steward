/**
 * W-1.3 / W-2.3: тесты одноразового git worktree (без Docker), очистки и
 * интеграции с обёртками. Запуск: node test-worktree.mjs (после npm run build).
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-worktree-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  isGitRepository,
  createRunWorktree,
  removeRunWorktree,
  cleanupStaleWorktrees,
  WORKTREE_ROOT_DIR,
  DEFAULT_STALE_AFTER_MS,
} = await import("./dist/core/worktree.js");
const { parseImportJson } = await import("./dist/task-transfer.js");
const { writeWrapperCmd } = await import("./dist/core/ps-wrapper.js");
const { buildBashWrapperScript } = await import("./dist/core/wrappers/bash.js");
const { main: worktreeMain } = await import("./dist/core/worktree-run.js");

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

/**
 * git возвращает канонический путь: на macOS /var/... → /private/var/...,
 * на Windows короткое имя RUNNER~1 → полное имя. Сравниваем реальные пути,
 * иначе корректный worktree кажется «чужим» только в CI.
 */
function samePath(left, right) {
  const norm = (value) => {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync(resolved);
    } catch {
      // Путь мог быть уже удалён — сравниваем как есть.
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return norm(left) === norm(right);
}

/**
 * Канонический корень репозитория по мнению git. На Windows ни path.resolve,
 * ни realpathSync не гарантируют совпадение с выводом git: короткое имя
 * RUNNER~1 и прямой слеш сохраняются по-разному. Сравниваем вывод git с выводом
 * git — это единственный надёжный способ на всех ОС.
 */
function gitRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Пути всех зарегистрированных worktree из `git worktree list --porcelain`. */
function registeredWorktreePaths(cwd) {
  return git(cwd, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
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
    check("worktree: репозиторий определён", gitRoot(wt.repoRoot) === gitRoot(repo));
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
  for (const item of parallel) {
    if (!item.ok) console.error(`fan-out: ошибка создания worktree: ${item.error}`);
  }
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
  check(
    "Windows .cmd: очистка после прогона",
    text.includes('cleanup --path "%AGENT_STEWARD_WORKTREE%"'),
  );
  check(
    "Windows .cmd: исходный код возврата сохраняется",
    text.includes("AGENT_STEWARD_EXIT_CODE") && text.includes("exit /b %AGENT_STEWARD_EXIT_CODE%"),
  );
  check(
    "Windows .cmd: перед очисткой выходит из worktree",
    text.includes("set \"AGENT_STEWARD_EXIT_CODE=%errorlevel%\"") &&
      text.indexOf('cd /d "' + repo) < text.indexOf('cleanup --path "%AGENT_STEWARD_WORKTREE%"'),
  );

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
  check("bash: очистка после прогона", enabled.includes("cleanup_worktree()"));
  check(
    "bash: очистка вызывается из trap",
    enabled.includes("cleanup() { cleanup_worktree;") &&
      enabled.includes("trap cleanup EXIT INT TERM"),
  );
  check(
    "bash: очистка выходит из worktree",
    enabled.includes('cd "$WORKDIR" 2>/dev/null || true') &&
      enabled.includes('cleanup --path "$AGENT_STEWARD_WORKTREE"'),
  );

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

// 11. W-2.1: удаление worktree после прогона.
let disposable;
{
  const created = await createRunWorktree({
    repoDir: repo,
    taskName: "cleanup-me",
    rootDir: worktreeRoot,
  });
  disposable = created;
  check("cleanup: worktree создан", created.ok === true);
  if (created.ok) {
    const wt = created.worktree;
    const removed = await removeRunWorktree({ path: wt.path, rootDir: worktreeRoot });
    check("cleanup: удаление успешно", removed.ok === true);
    check("cleanup: каталог удалён", !fs.existsSync(wt.path));
    check("cleanup: sidecar удалён", !fs.existsSync(`${wt.path}.json`));
    check(
      "cleanup: запись исчезла из git worktree list",
      !registeredWorktreePaths(repo).some((registered) => samePath(registered, wt.path)),
    );
    check("cleanup: ветка удалена", git(repo, ["branch", "--list", wt.branch]).trim() === "");
    check("cleanup: повторный вызов идемпотентен", (await removeRunWorktree({ path: wt.path, rootDir: worktreeRoot })).ok === true);
  }
}

// 12. W-2.2: защита от удаления чужих каталогов и веток.
{
  const outside = path.join(tempRoot, "outside", "wt");
  fs.mkdirSync(outside, { recursive: true });
  const foreign = await removeRunWorktree({ path: outside, repoRoot: repo, rootDir: worktreeRoot });
  check("guard: путь вне корня не удаляется", foreign.ok === false && fs.existsSync(outside));

  const unowned = path.join(worktreeRoot, "not-ours");
  fs.mkdirSync(unowned, { recursive: true });
  const unownedResult = await removeRunWorktree({ path: unowned, repoRoot: repo, rootDir: worktreeRoot });
  check("guard: каталог без sidecar не удаляется", unownedResult.ok === false && fs.existsSync(unowned));

  const created = await createRunWorktree({ repoDir: repo, taskName: "wrong-branch", rootDir: worktreeRoot });
  check("guard: worktree для проверки ветки создан", created.ok === true);
  if (created.ok) {
    const wrong = await removeRunWorktree({
      path: created.worktree.path,
      branch: "main",
      rootDir: worktreeRoot,
    });
    check("guard: чужая ветка не удаляется", wrong.ok === false && fs.existsSync(created.worktree.path));
    check("guard: корректное удаление после отказа", (await removeRunWorktree({ path: created.worktree.path, rootDir: worktreeRoot })).ok === true);
  }

  const kept = await createRunWorktree({ repoDir: repo, taskName: "keep-branch", rootDir: worktreeRoot });
  check("guard: worktree с сохранением ветки создан", kept.ok === true);
  if (kept.ok) {
    const removed = await removeRunWorktree({
      path: kept.worktree.path,
      rootDir: worktreeRoot,
      deleteBranch: false,
    });
    check("guard: --keep-branch оставляет ветку", removed.ok === true && git(repo, ["branch", "--list", kept.worktree.branch]).trim() !== "");
    check(
      "guard: --keep-branch снимает регистрацию worktree",
      !git(repo, ["worktree", "list", "--porcelain"]).includes(kept.worktree.branch),
    );
    let branchDeleted = false;
    try {
      git(repo, ["branch", "-D", kept.worktree.branch]);
      branchDeleted = true;
    } catch (err) {
      console.error(`Не удалось удалить ветку ${kept.worktree.branch}: ${String(err)}`);
    }
    check("guard: ветка после --keep-branch удаляется вручную", branchDeleted);
  }
}

// 13. W-2.2: уборка остатков и защита от гонок.
{
  const staleRoot = path.join(tempRoot, "stale-worktrees");
  const old = await createRunWorktree({ repoDir: repo, taskName: "stale-old", rootDir: staleRoot });
  const fresh = await createRunWorktree({ repoDir: repo, taskName: "stale-fresh", rootDir: staleRoot });
  check("stale: оба worktree созданы", old.ok === true && fresh.ok === true);

  if (old.ok) {
    const sidecarPath = `${old.worktree.path}.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    sidecar.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  }

  const ghost = path.join(staleRoot, "ghost");
  fs.writeFileSync(
    path.join(staleRoot, "ghost.json"),
    JSON.stringify({
      path: ghost,
      branch: "agent-steward/ghost",
      repoRoot: repo,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(staleRoot, "unknown"), { recursive: true });

  const summary = await cleanupStaleWorktrees({ rootDir: staleRoot });
  check("stale: старый worktree удалён", old.ok && summary.removed.includes(old.worktree.path));
  check("stale: свежий worktree не тронут", fresh.ok && summary.skipped.includes(fresh.worktree.path));
  check("stale: fresh-каталог на месте", fresh.ok && fs.existsSync(fresh.worktree.path));
  check("stale: sidecar без копии убран", summary.pruned.includes(ghost) && !fs.existsSync(path.join(staleRoot, "ghost.json")));
  check("stale: чужой каталог не удалён", fs.existsSync(path.join(staleRoot, "unknown")));
  check("stale: без ошибок", summary.errors.length === 0);

  const lockedCandidate = await createRunWorktree({ repoDir: repo, taskName: "locked-old", rootDir: staleRoot });
  if (lockedCandidate.ok) {
    const sidecarPath = `${lockedCandidate.worktree.path}.json`;
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    sidecar.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), "utf8");
  }
  const lockPath = path.join(staleRoot, ".cleanup-lock");
  fs.mkdirSync(lockPath, { recursive: true });
  const lockedSummary = await cleanupStaleWorktrees({ rootDir: staleRoot });
  check("stale: параллельная уборка уступает lock", lockedSummary.locked === true && lockedSummary.removed.length === 0);
  check("stale: кандидат жив, пока lock свежий", lockedCandidate.ok === true && fs.existsSync(lockedCandidate.worktree.path));

  const staleLockTime = new Date(Date.now() - 20 * 60 * 1000);
  fs.utimesSync(lockPath, staleLockTime, staleLockTime);
  const recovered = await cleanupStaleWorktrees({ rootDir: staleRoot });
  check("stale: осиротевший lock перехватывается", recovered.locked === false);
  check("stale: кандидат удалён после снятия lock", lockedCandidate.ok && recovered.removed.includes(lockedCandidate.worktree.path));

  const cliCandidate = await createRunWorktree({ repoDir: repo, taskName: "cli-cleanup", rootDir: staleRoot });
  const cliCode = await worktreeMain([
    "cleanup", "--stale", "--root", staleRoot, "--max-age-hours", "0", "--json",
  ]);
  check("CLI cleanup --stale: код 0", cliCode === 0);
  check("CLI cleanup --stale: worktree удалён", cliCandidate.ok && !fs.existsSync(cliCandidate.worktree.path));
}

// 14. CLI очистки: успех и защитные ошибки.
{
  const created = await createRunWorktree({ repoDir: repo, taskName: "cli-path", rootDir: worktreeRoot });
  check("CLI cleanup: worktree создан", created.ok === true);
  if (created.ok) {
    const code = await worktreeMain([
      "cleanup", "--path", created.worktree.path, "--repo", repo, "--root", worktreeRoot, "--json",
    ]);
    check("CLI cleanup --path: код 0", code === 0);
    check("CLI cleanup --path: каталог удалён", !fs.existsSync(created.worktree.path));
  }

  check("CLI cleanup: нет --path → код 1", (await worktreeMain(["cleanup"])) === 1);
  check(
    "CLI cleanup: --stale и --path несовместимы",
    (await worktreeMain(["cleanup", "--stale", "--path", path.join(worktreeRoot, "x")])) === 1,
  );

  const outside = path.join(tempRoot, "outside", "wt");
  check(
    "CLI cleanup: путь вне корня → код 1",
    (await worktreeMain([
      "cleanup", "--path", outside, "--repo", repo, "--root", worktreeRoot,
    ])) === 1,
  );
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nWorktree: ${results.length - failed.length}/${results.length} проверок пройдено.`);
if (failed.length > 0) {
  // Имена падающих проверок должны попадать в хвост лога CI (annotations
  // показывают только последние строки, а не весь вывод теста).
  console.error(`Не прошли проверки: ${failed.map((entry) => entry.name).join("; ")}`);
  process.exitCode = 1;
} else {
  // Не оставляем за собой временные репозитории и worktree.
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Windows может держать дескрипторы недолго — каталог в temp безопасен.
  }
}
