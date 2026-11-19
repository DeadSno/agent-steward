#!/usr/bin/env node
/**
 * W-1 (0.0.6): CLI-помощник обёртки — создаёт одноразовый git worktree.
 *
 * Вызывается из сгенерированного .cmd/.sh:
 *   node worktree-run.js --repo "<workdir>" --task "<task name>" [--root <dir>] [--json]
 *
 * В stdout печатается только путь к worktree (одна строка) — обёртка ловит его
 * и переходит туда. Диагностика и ошибки идут в stderr. При ошибке exit 1:
 * обёртка обязана упасть fail-closed, а не работать в основном дереве.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRunWorktree } from "./worktree.js";

interface HelperArgs {
  repo?: string;
  task?: string;
  root?: string;
  json: boolean;
}

function parseArgs(argv: string[]): { args: HelperArgs; error?: string } {
  const args: HelperArgs = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--repo":
      case "--task":
      case "--root": {
        if (!value || value.startsWith("--")) {
          return { args, error: `Флаг ${flag} требует значение.` };
        }
        if (flag === "--repo") args.repo = value;
        if (flag === "--task") args.task = value;
        if (flag === "--root") args.root = value;
        index += 1;
        break;
      }
      default:
        return { args, error: `Неизвестный аргумент: ${flag}` };
    }
  }
  return { args };
}

/** Точка входа для тестов: возвращает exit code, ничего не завершает. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`[worktree] ${parsed.error}\n`);
    return 1;
  }
  const { repo, task, root, json } = parsed.args;
  if (!repo || !task) {
    process.stderr.write(
      "[worktree] Использование: worktree-run.js --repo <dir> --task <name> [--root <dir>] [--json]\n",
    );
    return 1;
  }

  const result = await createRunWorktree({ repoDir: repo, taskName: task, rootDir: root });
  if (!result.ok) {
    process.stderr.write(`[worktree] ${result.error}\n`);
    return 1;
  }

  process.stdout.write(
    json ? `${JSON.stringify(result.worktree)}\n` : `${result.worktree.path}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
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
