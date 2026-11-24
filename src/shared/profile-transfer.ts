/**
 * D11 (IM-10): перенос настроек профиля между машинами.
 *
 * Чистый модуль без fs/RPC: сборка/разбор JSON-бандла. Секреты (токены,
 * пароли, ключи) never попадают в экспорт — хранятся в отдельном store.
 */

export const PROFILE_BUNDLE_VERSION = 1;

/** Ключи настроек, которые разрешено переносить (совпадают с save_settings). */
export const PROFILE_SETTINGS_KEYS = [
  "maxConcurrent",
  "locale",
  "uiLocale",
  "winterMode",
  "notifications",
  "history",
  "audit",
  "permissions",
  "budgets",
  "feedback",
] as const;

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization)/i;

export interface ProfileBundle {
  version: number;
  profile: string;
  exportedAt: string;
  settings: Record<string, unknown>;
  secretsExcluded: true;
}

/** Рекурсивно вырезает значения секретных полей, сохраняя структуру. */
export function redactProfileSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactProfileSettings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "<redacted>" : redactProfileSettings(item);
    }
    return out;
  }
  return value;
}

/** Собирает бандл профиля; секретные поля заменяются на `<redacted>`. */
export function buildProfileBundle(
  profile: string,
  settings: Record<string, unknown>,
  now: Date = new Date(),
): ProfileBundle {
  return {
    version: PROFILE_BUNDLE_VERSION,
    profile: String(profile ?? ""),
    exportedAt: now.toISOString(),
    settings: redactProfileSettings(settings) as Record<string, unknown>,
    secretsExcluded: true,
  };
}

export function serializeProfileBundle(bundle: ProfileBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Разбирает и проверяет бандл; бросает понятную ошибку на чужой формат. */
export function parseProfileBundle(text: string): ProfileBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл профиля не является корректным JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Файл профиля должен быть объектом JSON");
  }
  const bundle = parsed as Partial<ProfileBundle>;
  if (bundle.version !== PROFILE_BUNDLE_VERSION) {
    throw new Error(`Неподдерживаемая версия бандла профиля: ${String(bundle.version)}`);
  }
  if (typeof bundle.profile !== "string" || !bundle.profile) {
    throw new Error("В бандле профиля отсутствует имя");
  }
  if (!bundle.settings || typeof bundle.settings !== "object" || Array.isArray(bundle.settings)) {
    throw new Error("В бандле профиля отсутствуют настройки");
  }
  return bundle as ProfileBundle;
}

/** Оставляет только ключи, принимаемые `save_settings`. */
export function profileSettingsPatch(bundle: ProfileBundle): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of PROFILE_SETTINGS_KEYS) {
    if (bundle.settings[key] !== undefined) patch[key] = bundle.settings[key];
  }
  return patch;
}
