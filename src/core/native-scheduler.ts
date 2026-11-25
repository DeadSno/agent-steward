/**
 * AD-1.1: подготовка режима `nativeScheduler`.
 *
 * Хост OpenCode может однажды взять на себя старт фоновых задач. Этот модуль
 * фиксирует *режим* и *капабилити контракт* хоста, но не создаёт нового движка:
 * при отсутствии capability (`auto` без маркера хоста) остаётся текущая
 * polling-обвязка schtasks/cron/launchd. Ledger, DLQ, бюджеты, approval и сам
 * execution loop не зависят от режима — меняется только источник триггера.
 */

/** Источник триггера фоновой задачи. */
export type SchedulerMode = "polling" | "native" | "auto";

/** Настройка режима планировщика из `settings.json`. */
export interface NativeSchedulerSettings {
  /** `auto` — только при подтверждённой capability хоста, иначе polling. */
  mode: SchedulerMode;
  /** Имя хоста/канала триггеров (для логов и внешнего контракта). */
  host: string;
}

/** По умолчанию режим не меняется: polling без явного сигнала от хоста. */
export const DEFAULT_NATIVE_SCHEDULER_SETTINGS: NativeSchedulerSettings = {
  mode: "auto",
  host: "",
};

/** Переменная окружения, которой хост объявляет native-планировщик. */
export const NATIVE_SCHEDULER_HOST_ENV = "OPENCODE_NATIVE_SCHEDULER";

/** Имя хоста (необязательно). */
export const NATIVE_SCHEDULER_HOST_NAME_ENV = "OPENCODE_NATIVE_SCHEDULER_HOST";

/** Список объявленных capability через запятую (необязательно). */
export const NATIVE_SCHEDULER_CAPS_ENV = "OPENCODE_NATIVE_SCHEDULER_CAPS";

/**
 * Инварианты, которые обязаны сохраняться при любом режиме планировщика.
 * Native-хост отвечает только за доставку триггера; всё остальное остаётся
 * в ядре плагина и не дублируется в хосте.
 */
export const NATIVE_SCHEDULER_INVARIANTS = [
  "ledger",
  "dlq",
  "budgets",
  "approval",
  "execution-loop",
] as const;

export type NativeSchedulerInvariant = (typeof NATIVE_SCHEDULER_INVARIANTS)[number];

/** Информация об обнаруженной capability нативного планировщика хоста. */
export interface NativeSchedulerHostInfo {
  /** Имя хоста/канала. */
  name: string;
  /** Версия контракта хоста, если объявлена. */
  version: string;
  /** ОС, на которой работает хост (информационно; режим от неё не зависит). */
  platform: NodeJS.Platform;
  /** Объявленные capability: обязательные инварианты + дополнительные. */
  capabilities: readonly string[];
}

/** Хост явно выключил нативный планировщик. */
export class NativeSchedulerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeSchedulerUnavailableError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeMode(value: unknown, fallback: SchedulerMode): SchedulerMode {
  return value === "polling" || value === "native" || value === "auto" ? value : fallback;
}

/** Приводит настройки режима к безопасному виду. */
export function normalizeNativeSchedulerSettings(
  value: unknown,
  fallback: NativeSchedulerSettings = DEFAULT_NATIVE_SCHEDULER_SETTINGS,
): NativeSchedulerSettings {
  const raw = asRecord(value);
  if (!raw) return { ...fallback };
  const host =
    typeof raw.host === "string" ? raw.host.trim().slice(0, 120) : fallback.host;
  return {
    mode: normalizeMode(raw.mode, fallback.mode),
    host: host || fallback.host,
  };
}

function envFlag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") {
    return false;
  }
  return null;
}

/**
 * Определяет, объявил ли хост нативный планировщик.
 *
 * Привязка к ОС есть только в информационном поле `platform`: сам режим
 * платформо-независим и одинаково работает с win32/linux/darwin. Явный
 * список capability не может *сузить* обязательные инварианты — если хост
 * объявил CAPS без них, режим считается недоступным (fail-closed).
 */
export function detectNativeSchedulerHost(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NativeSchedulerHostInfo | null {
  const flag = envFlag(env[NATIVE_SCHEDULER_HOST_ENV]);
  if (flag !== true) return null;

  const name =
    env[NATIVE_SCHEDULER_HOST_NAME_ENV]?.trim().slice(0, 120) || "opencode-native";
  const declared = env[NATIVE_SCHEDULER_CAPS_ENV];
  const capabilities = declared
    ? declared.split(",").map((item) => item.trim()).filter(Boolean)
    : [...NATIVE_SCHEDULER_INVARIANTS];
  const missing = NATIVE_SCHEDULER_INVARIANTS.filter(
    (invariant) => !capabilities.includes(invariant),
  );
  if (missing.length > 0) return null;

  return {
    name,
    version: "1.0",
    platform,
    capabilities: [...new Set(capabilities)],
  };
}

/**
 * Разрешает итоговый режим: явный выбор побеждает, `auto` требует подтверждения
 * capability хоста и в противном случае безопасно падает на polling.
 */
export function resolveSchedulerMode(
  settings: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): SchedulerMode {
  const mode = normalizeNativeSchedulerSettings(settings).mode;
  if (mode === "polling" || mode === "native") return mode;
  return detectNativeSchedulerHost(env, platform) ? "native" : "polling";
}

/** Проверка доступности хоста перед включением нативного режима. */
export function assertNativeSchedulerHost(
  host: NativeSchedulerHostInfo | null,
  mode: SchedulerMode,
): NativeSchedulerHostInfo {
  if (mode !== "native") {
    throw new NativeSchedulerUnavailableError(
      `Режим ${mode} не требует нативного хоста`,
    );
  }
  if (!host) {
    throw new NativeSchedulerUnavailableError(
      "Хост не объявил capability nativeScheduler; доступна только polling-обвязка",
    );
  }
  return host;
}

/** Подпись контракта нативного режима (используется внешним контрактом AD-1.2). */
export function nativeSchedulerContract(host: NativeSchedulerHostInfo | null): {
  mode: SchedulerMode;
  host: string | null;
  platform: NodeJS.Platform | null;
  preserved: readonly NativeSchedulerInvariant[];
} {
  return {
    mode: host ? "native" : "polling",
    host: host?.name ?? null,
    platform: host?.platform ?? null,
    preserved: [...NATIVE_SCHEDULER_INVARIANTS],
  };
}
