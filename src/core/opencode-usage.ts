/**
 * PL-38 / QV-11.2: подсчёт токенов и стоимости из собственной БД OpenCode.
 *
 * Обёртки задач не печатают `Tokens:`/`Usage:` в лог — для провайдеров
 * hy4-flash-free и ollama OpenCode вообще не выводит эту строку. Истина о
 * расходе лежит в `opencode.db` (таблица `message`, поле `data` с JSON
 * ассистентских сообщений). Читаем БД только на чтение и никогда не падаем,
 * если файла нет, он занят или формат изменился.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

export interface OpenCodeUsage {
  tokens: number;
  costUsd: number;
  messages: number;
  providers: Record<string, number>;
}

export interface CollectOpenCodeUsageOptions {
  /** Нижняя граница окна, epoch ms. */
  since: number;
  /** Верхняя граница окна, epoch ms. */
  until: number;
  /** Явный путь к БД (тесты и переменная OPENCODE_USAGE_DB). */
  dbPath?: string;
  /** Рабочая директория задачи — фильтр по `path.cwd` сообщения. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const nodeRequire = createRequire(import.meta.url);

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

function loadDatabaseSync(): new (
  location: string,
  options?: Record<string, unknown>
) => SqliteDatabase {
  const mod = nodeRequire("node:sqlite") as { DatabaseSync: new (
    location: string,
    options?: Record<string, unknown>
  ) => SqliteDatabase };
  return mod.DatabaseSync;
}

/** Кандидаты путей к БД OpenCode в порядке приоритета. */
export function findOpenCodeDb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const explicit = env.OPENCODE_USAGE_DB?.trim();
  if (explicit) return path.resolve(explicit);

  // env имеют приоритет над os.homedir(): тот кэширует путь при старте Node,
  // из-за чего тесты с изолированным HOME видели реальную БД пользователя.
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  const candidates =
    platform === "win32" && env.APPDATA
      ? [
        path.join(env.APPDATA, "opencode", "opencode.db"),
        path.join(home, ".local", "share", "opencode", "opencode.db"),
      ]
      : [
        path.join(home, ".local", "share", "opencode", "opencode.db"),
        path.join(home, ".config", "opencode", "opencode.db"),
      ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function asFiniteNumber(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function parseMessageData(raw: unknown): {
  tokens: number;
  costUsd: number;
  provider: string;
  cwd: string;
} | null {
  if (typeof raw !== "string") return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (data.role !== "assistant") return null;

  const tokensRaw = data.tokens;
  let tokens = 0;
  if (tokensRaw && typeof tokensRaw === "object" && !Array.isArray(tokensRaw)) {
    const tokensObj = tokensRaw as Record<string, unknown>;
    // OpenCode иногда пишет только total, иногда input/output/reasoning.
    const cache = tokensObj.cache && typeof tokensObj.cache === "object"
      ? (tokensObj.cache as Record<string, unknown>)
      : {};
    tokens =
      asFiniteNumber(tokensObj.total) ||
      asFiniteNumber(tokensObj.input) +
        asFiniteNumber(tokensObj.output) +
        asFiniteNumber(tokensObj.reasoning) +
        asFiniteNumber(cache.read) +
        asFiniteNumber(cache.write);
  }

  const messagePath = data.path && typeof data.path === "object" && !Array.isArray(data.path)
    ? (data.path as Record<string, unknown>)
    : {};

  return {
    tokens,
    costUsd: asFiniteNumber(data.cost),
    provider: typeof data.providerID === "string" ? data.providerID : "unknown",
    cwd: typeof messagePath.cwd === "string" ? messagePath.cwd : "",
  };
}

/**
 * Суммирует usage ассистентских сообщений за окно времени.
 * Возвращает null, если БД недоступна (не искать токены в логах впустую).
 */
export function collectOpenCodeUsage(
  options: CollectOpenCodeUsageOptions,
): OpenCodeUsage | null {
  const dbPath = options.dbPath ?? findOpenCodeDb(options.env, options.platform);
  if (!dbPath || !fs.existsSync(dbPath)) return null;

  const since = Math.min(options.since, options.until);
  const until = Math.max(options.since, options.until);
  let db: SqliteDatabase | null = null;
  try {
    const DatabaseSync = loadDatabaseSync();
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT data FROM message WHERE time_created >= ? AND time_created <= ? AND json_extract(data, '$.role') = 'assistant'",
      )
      .all(since, until);

    const result: OpenCodeUsage = { tokens: 0, costUsd: 0, messages: 0, providers: {} };
    const wantedCwd = options.cwd?.trim().toLowerCase();
    for (const row of rows) {
      const raw = (row as { data?: unknown }).data;
      const message = parseMessageData(raw);
      if (!message) continue;
      if (
        wantedCwd &&
        message.cwd &&
        message.cwd.replace(/\\/g, "/").toLowerCase() !== wantedCwd.replace(/\\/g, "/").toLowerCase()
      ) {
        continue;
      }
      result.tokens += message.tokens;
      result.costUsd += message.costUsd;
      result.messages += 1;
      result.providers[message.provider] =
        (result.providers[message.provider] ?? 0) + message.tokens;
    }
    return result;
  } catch {
    // БД занята/заблокирована/старой схемы — это диагностика, не отказ задачи.
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
