#!/usr/bin/env node
/**
 * W-3 (0.0.6): CLI-помощник guard-условий.
 *
 * Вызывается из сгенерированных обёрток до запуска opencode:
 *   node guard-run.js --cwd "<workdir>" --guards-b64 "<base64 json>" [--json]
 *
 * Коды выхода:
 *   0 — все guard-проверки пройдены, можно запускать;
 *   4 — проверки не пройдены, прогон нужно пропустить (skip);
 *   1 — некорректные аргументы или конфигурация (fail-closed).
 *
 * В stdout печатается человекочитаемая причина (или JSON с --json),
 * диагностика — в stderr. Модуль ничего не завершает при импорте.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateGuards,
  GUARD_SKIP_EXIT_CODE,
  normalizeTaskGuards,
} from "./guard.js";

interface HelperArgs {
  cwd?: string;
  guardsB64?: string;
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
      case "--cwd":
      case "--guards-b64": {
        if (!value || value.startsWith("--")) {
          return { args, error: `Флаг ${flag} требует значение.` };
        }
        if (flag === "--cwd") args.cwd = value;
        if (flag === "--guards-b64") args.guardsB64 = value;
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
    '  guard-run.js --cwd <dir> --guards-b64 "<base64 json>" [--json]',
  ].join("\n");
}

/** Точка входа для тестов: возвращает exit code, ничего не завершает. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`[guard] ${parsed.error}\n`);
    return 1;
  }

  const { cwd, guardsB64 } = parsed.args;
  if (!cwd || !guardsB64) {
    process.stderr.write(`[guard] ${usage()}\n`);
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(guardsB64, "base64").toString("utf8"));
  } catch (error) {
    process.stderr.write(
      `[guard] не удалось разобрать guards: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const normalized = normalizeTaskGuards(raw);
  if (!normalized.ok) {
    process.stderr.write(`[guard] ${normalized.error}\n`);
    return 1;
  }
  if (!normalized.guards) {
    process.stderr.write("[guard] пустая конфигурация guard.\n");
    return 1;
  }

  const result = await evaluateGuards(normalized.guards, { cwd });
  if (parsed.args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (result.passed) {
    process.stdout.write(`[guard] OK: ${result.checks.length} проверок пройдено\n`);
  } else {
    process.stdout.write(`[guard] skipped: ${result.reasons.join("; ")}\n`);
  }
  return result.passed ? 0 : GUARD_SKIP_EXIT_CODE;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`[guard] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
