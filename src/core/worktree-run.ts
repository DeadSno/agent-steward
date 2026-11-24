#!/usr/bin/env node
/**
 * W-1/W-2 (0.0.6): CLI-помощник обёртки для одноразовых git worktree.
 *
 * Создание (вызывается из сгенерированного .cmd/.sh):
 *   node worktree-run.js --repo "<workdir>" --task "<task name>" [--root <dir>] [--json]
 *   node worktree-run.js create --repo ... --task ...
 *
 * Очистка (после прогона и для остатков):
 *   node worktree-run.js cleanup --path "<worktree>" [--repo <root>] [--root <dir>] [--keep-branch] [--json]
 *   node worktree-run.js cleanup --stale [--root <dir>] [--max-age-hours <n>] [--json]
 *
 * При создании в stdout печатается только путь к worktree (одна строка) —
 * обёртка ловит его и переходит туда. Диагностика и ошибки идут в stderr.
 * При ошибке exit 1: обёртка обязана упасть fail-closed, а не работать в
 * основном дереве.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupStaleWorktrees,
  createRunWorktree,
  DEFAULT_STALE_AFTER_MS,
  removeRunWorktree,
} from "./worktree.js";

type Mode = "create" | "cleanup";

interface HelperArgs {
  mode: Mode;
  repo?: string;
  task?: string;
  root?: string;
  path?: string;
  branch?: string;
  keepBranch: boolean;
  stale: boolean;
  maxAgeHours?: number;
  json: boolean;
}

function parseArgs(argv: string[]): { args: HelperArgs; error?: string } {
  const args: HelperArgs = { mode: "create", keepBranch: false, stale: false, json: false };
  let index = 0;

  // Подкоманда необязательна: старые обёртки вызывают помощник без неё.
  if (argv[0] === "create" || argv[0] === "cleanup") {
    args.mode = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--keep-branch":
        args.keepBranch = true;
        break;
      case "--stale":
        args.stale = true;
        break;
      case "--repo":
      case "--task":
      case "--root":
      case "--path":
      case "--branch":
      case "--max-age-hours": {
        if (!value || value.startsWith("--")) {
          return { args, error: `Флаг ${flag} требует значение.` };
        }
        if (flag === "--repo") args.repo = value;
        if (flag === "--task") args.task = value;
        if (flag === "--root") args.root = value;
        if (flag === "--path") args.path = value;
        if (flag === "--branch") args.branch = value;
        if (flag === "--max-age-hours") {
          const hours = Number(value);
          if (!Number.isFinite(hours) || hours < 0) {
            return { args, error: "Флаг --max-age-hours требует неотрицательное число." };
          }
          args.maxAgeHours = hours;
        }
        index += 1;
        break;
      }
      default:
        return { args, error: `Неизвестный аргумент: ${flag}` };
    }
  }
  return { args };
}

function usage(): string {
  return [
    "Использование:",
    "  worktree-run.js create --repo <dir> --task <name> [--root <dir>] [--json]",
    "  worktree-run.js --repo <dir> --task <name> [--root <dir>] [--json]  (легаси, подкоманда необязательна)",
    "  worktree-run.js cleanup --path <worktree> [--repo <root>] [--root <dir>] [--keep-branch] [--json]",
    "  worktree-run.js cleanup --stale [--root <dir>] [--max-age-hours <n>] [--json]",
  ].join("\n");
}

async function runCreate(args: HelperArgs): Promise<number> {
  if (!args.repo || !args.task) {
    process.stderr.write(`[worktree] ${usage()}\n`);
    return 1;
  }

  // W-2.2: попутная уборка остатков. Не влияет на создание: ошибки уборки
  // игнорируются, свежие worktree не трогаются.
  await cleanupStaleWorktrees({ rootDir: args.root }).catch(() => undefined);

  const result = await createRunWorktree({
    repoDir: args.repo,
    taskName: args.task,
    rootDir: args.root,
  });
  if (!result.ok) {
    // PL-126: обёртка пишет stderr в лог задачи — причина должна быть
    // понятной и в логе, и в истории (которую пишет обёртка через --skip).
    process.stderr.write(
      `[worktree] PL-126: не удалось создать worktree для задачи "${args.task}", репозиторий ${args.repo}: ${result.error}\n`,
    );
    return 1;
  }

  process.stdout.write(
    args.json ? `${JSON.stringify(result.worktree)}\n` : `${result.worktree.path}\n`,
  );
  return 0;
}

async function runCleanup(args: HelperArgs): Promise<number> {
  if (args.stale && args.path) {
    process.stderr.write("[worktree] Нельзя совмещать --stale и --path.\n");
    return 1;
  }

  if (args.stale) {
    const summary = await cleanupStaleWorktrees({
      rootDir: args.root,
      maxAgeMs:
        args.maxAgeHours === undefined
          ? DEFAULT_STALE_AFTER_MS
          : args.maxAgeHours * 60 * 60 * 1000,
    });
    process.stdout.write(
      args.json
        ? `${JSON.stringify(summary)}\n`
        : `[worktree] Удалено: ${summary.removed.length}, пропущено: ${summary.skipped.length}, sidecar: ${summary.pruned.length}, ошибок: ${summary.errors.length}${summary.locked ? " (уборка уже выполняется)" : ""}\n`,
    );
    if (summary.errors.length > 0) {
      for (const error of summary.errors) process.stderr.write(`[worktree] ${error}\n`);
      return 1;
    }
    return 0;
  }

  if (!args.path) {
    process.stderr.write(`[worktree] ${usage()}\n`);
    return 1;
  }

  const result = await removeRunWorktree({
    path: args.path,
    repoRoot: args.repo,
    branch: args.branch,
    rootDir: args.root,
    deleteBranch: !args.keepBranch,
  });
  if (!result.ok) {
    process.stderr.write(`[worktree] ${result.error}\n`);
    return 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify({ ok: true, path: args.path })}\n`);
  return 0;
}

/** Точка входа для тестов: возвращает exit code, ничего не завершает. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`[worktree] ${parsed.error}\n`);
    return 1;
  }
  return parsed.args.mode === "cleanup" ? runCleanup(parsed.args) : runCreate(parsed.args);
}

// QA-PORT-12: в свежем worktree `dist/` — junction на основной чек-аут. Без
// --preserve-symlinks Node резолвит модуль по реальному пути, а process.argv[1]
// остаётся путём через junction, поэтому проверка `import.meta.url ===
// invokedPath` не срабатывала, main() не вызывался и helper молча выходил с
// кодом 0. Сравниваем
// реальные пути обоих файлов (realpath) — теперь работает и с junction, и без.
const realPath = (value: string): string => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};
const invokedPath = process.argv[1] ? realPath(process.argv[1]) : "";
const modulePath = realPath(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`[worktree] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
