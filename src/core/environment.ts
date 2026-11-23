/**
 * A-2.1/A-2.2/A-3.1: env-профили, жёсткая изоляция сред, связь задачи и
 * запуска через профиль, а также детерминированная регистрация артефактов.
 *
 * Модуль намеренно чистый: никаких чтений системных часов, файлов, сети и
 * внешних процессов. Всё, что нужно вызывающему коду, — явные входы.
 */

import { createHash } from "node:crypto";

/** Допустимые профили окружения. */
export type EnvironmentName = "dev" | "staging" | "prod";

/** Без явного выбора используется dev. */
export const DEFAULT_ENVIRONMENT: EnvironmentName = "dev";

export const ENVIRONMENT_NAMES: readonly EnvironmentName[] = ["dev", "staging", "prod"];

/**
 * CROSS-ENV deny-список: эти ключи не имеют права переходить из одной среды
 * в другую (ни через ручной ввод, ни через наследование переменных).
 */
export const CROSS_ENV_DENY: readonly string[] = [
  "API_TOKEN",
  "DATABASE_URL",
  "SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "OPENCODE_API_KEY",
];

/** Один профиль environment: только свои переменные и общий deny-список. */
export interface EnvironmentProfile {
  readonly name: EnvironmentName;
  readonly description: string;
  /** Переменные этого профиля — без заимствований из других сред. */
  readonly variables: Readonly<Record<string, string>>;
  /** CROSS-ENV deny-список, обязательный для каждого профиля. */
  readonly deny: readonly string[];
}

/**
 * Жёсткая изоляция: у каждого профиля свой собственный набор переменных.
 * Общие ключи (APP_ENV, API_BASE_URL, LOG_LEVEL) имеют разные значения, а
 * уникальные ключи с префиксами DEV_, STAGING_ и PROD_ не встречаются в других
 * профилях.
 */
export const ENVIRONMENT_PROFILES: Readonly<Record<EnvironmentName, EnvironmentProfile>> = {
  dev: {
    name: "dev",
    description: "Локальная разработка",
    variables: {
      APP_ENV: "dev",
      API_BASE_URL: "http://localhost:3000",
      LOG_LEVEL: "debug",
      DEV_HOT_RELOAD: "true",
    },
    deny: CROSS_ENV_DENY,
  },
  staging: {
    name: "staging",
    description: "Предрелизный стенд",
    variables: {
      APP_ENV: "staging",
      API_BASE_URL: "https://staging.example.invalid",
      LOG_LEVEL: "info",
      STAGING_GATEWAY: "https://gateway.staging.example.invalid",
    },
    deny: CROSS_ENV_DENY,
  },
  prod: {
    name: "prod",
    description: "Продукционная среда",
    variables: {
      APP_ENV: "prod",
      API_BASE_URL: "https://api.example.invalid",
      LOG_LEVEL: "warn",
      PROD_REGION: "eu-central-1",
    },
    deny: CROSS_ENV_DENY,
  },
};

export function isEnvironmentName(value: unknown): value is EnvironmentName {
  return typeof value === "string" && (ENVIRONMENT_NAMES as readonly string[]).includes(value);
}

/** Явный выбор профиля; отсутствие или неизвестное значение → dev. */
export function resolveEnvironmentName(value?: unknown): EnvironmentName {
  return isEnvironmentName(value) ? value : DEFAULT_ENVIRONMENT;
}

export function resolveEnvironment(value?: unknown): EnvironmentProfile {
  return ENVIRONMENT_PROFILES[resolveEnvironmentName(value)];
}

/** Свежая копия только своих переменных профиля. */
export function environmentVariables(name?: unknown): Record<string, string> {
  return { ...resolveEnvironment(name).variables };
}

/**
 * Проверка CROSS-ENV: запрещённый ключ или переменная, принадлежащая другой
 * среде, не должна попасть в выбранный профиль. Возвращает причины (пусто — OK).
 */
export function crossEnvViolations(
  name: unknown,
  incoming: Readonly<Record<string, string>>,
): string[] {
  const profile = resolveEnvironment(name);
  const ownKeys = new Set(Object.keys(profile.variables));
  const deny = new Set(profile.deny);
  const foreignKeys = new Set<string>();
  for (const other of ENVIRONMENT_NAMES) {
    if (other === profile.name) continue;
    for (const key of Object.keys(ENVIRONMENT_PROFILES[other].variables)) {
      if (!ownKeys.has(key)) foreignKeys.add(key);
    }
  }
  const violations: string[] = [];
  for (const key of Object.keys(incoming).sort()) {
    if (deny.has(key)) violations.push(`CROSS-ENV deny: ${key}`);
    else if (foreignKeys.has(key)) violations.push(`CROSS-ENV: ${key} принадлежит другой среде`);
  }
  return violations;
}

/** Fail-closed проверка изоляции; бросает понятную причину при нарушении. */
export function assertEnvironmentIsolation(
  name: unknown,
  incoming: Readonly<Record<string, string>>,
): void {
  const violations = crossEnvViolations(name, incoming);
  if (violations.length > 0) {
    throw new Error(
      `Нарушение изоляции среды "${resolveEnvironmentName(name)}": ${violations.join(", ")}`,
    );
  }
}

/* ------------------------------------------------------------------------- *
 * A-2.2: связь профиля задачи и профиля запуска.
 * ------------------------------------------------------------------------- */

/** Вердикт проверки профилей: содержит обе среды и их описания (env). */
export interface EnvironmentVerdict {
  readonly ok: boolean;
  readonly reason: string;
  readonly taskEnvironment: EnvironmentName;
  readonly runEnvironment: EnvironmentName;
  readonly env: {
    readonly task: EnvironmentProfile;
    readonly run: EnvironmentProfile;
  };
}

/**
 * Запуск разрешён только когда профиль задачи совпадает с профилем запуска.
 * Оба входа неявно дефолтят в dev — «без явного выбора используется dev».
 */
export function checkEnvironmentCompatibility(
  task: unknown,
  run: unknown,
): EnvironmentVerdict {
  const taskEnvironment = resolveEnvironmentName(task);
  const runEnvironment = resolveEnvironmentName(run);
  const ok = taskEnvironment === runEnvironment;
  return {
    ok,
    reason: ok
      ? ""
      : `Профиль задачи "${taskEnvironment}" не совпадает с профилем запуска ` +
        `"${runEnvironment}": выполнение заблокировано`,
    taskEnvironment,
    runEnvironment,
    env: {
      task: ENVIRONMENT_PROFILES[taskEnvironment],
      run: ENVIRONMENT_PROFILES[runEnvironment],
    },
  };
}

/** Исключение для вызывающих кодов, которым нужен Structured verdict. */
export class EnvironmentMismatchError extends Error {
  readonly verdict: EnvironmentVerdict;

  constructor(verdict: EnvironmentVerdict) {
    super(verdict.reason);
    this.name = "EnvironmentMismatchError";
    this.verdict = verdict;
  }
}

/* ------------------------------------------------------------------------- *
 * A-3.1: артефакты запуска (reports/coverage) как детерминированный список.
 * ------------------------------------------------------------------------- */

export type ArtifactContent = string | Uint8Array;

/** Вход регистратора: путь и содержимое — реальные файлы не читаются. */
export interface RunArtifactInput {
  path: string;
  content: ArtifactContent;
}

/** Запись запуска: путь, SHA-256 содержимого и размер в байтах. */
export interface RunArtifactRecord {
  path: string;
  sha256: string;
  size: number;
}

export type ArtifactEntries =
  | Readonly<Record<string, ArtifactContent>>
  | readonly RunArtifactInput[];

function isArtifactInputList(entries: ArtifactEntries): entries is readonly RunArtifactInput[] {
  return Array.isArray(entries);
}

/** Приводит путь к одному виду: прямые слеши, без ведущего `./`. */
export function normalizeArtifactPath(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Типовые пути отчётов и coverage — для фильтрации на стороне вызывающего кода. */
export function isRunArtifactPath(value: string): boolean {
  const p = normalizeArtifactPath(value).toLowerCase();
  return (
    p.startsWith("reports/") ||
    p.startsWith("coverage/") ||
    p.endsWith(".lcov") ||
    p.endsWith(".info") ||
    p.endsWith("coverage-final.json") ||
    p.endsWith("cobertura-coverage.xml")
  );
}

/**
 * Чистая регистрация артефактов: детерминированная сортировка по пути,
 * дедупликация, SHA-256 и размер содержимого. Не читает часы и файлы —
 * тесты передают пути вместе с содержимым.
 */
export function registerRunArtifacts(entries: ArtifactEntries): RunArtifactRecord[] {
  const normalized: RunArtifactInput[] = isArtifactInputList(entries)
    ? entries.map((entry) => ({
      path: normalizeArtifactPath(entry.path),
      content: entry.content,
    }))
    : Object.entries(entries).map(([entryPath, content]) => ({
      path: normalizeArtifactPath(entryPath),
      content,
    }));
  const sorted = normalized
    .filter((entry) => entry.path.length > 0 && entry.content !== undefined && entry.content !== null)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const records: RunArtifactRecord[] = [];
  for (const entry of sorted) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const bytes =
      typeof entry.content === "string"
        ? Buffer.from(entry.content, "utf8")
        : Buffer.from(entry.content);
    records.push({
      path: entry.path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
  return records;
}
