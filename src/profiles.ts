import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Профили (Спринт 21): каждый профиль — отдельная директория со своей БД,
 * настройками, логами, обёртками и портом дашборда. Профиль `default`
 * использует базовую директорию плагина (как раньше — без миграции), остальные
 * живут в `<base>/profiles/<name>`.
 */

export const DEFAULT_PROFILE = "default";

/** Файл-маркер активного профиля (когда переменная окружения не задана). */
const ACTIVE_PROFILE_FILE = "active-profile";

/** Метаданные профиля: имя и порт дашборда. */
export interface ProfileMeta {
  name: string;
  port: number;
}

/** Описание профиля для RPC/GUI. */
export interface ProfileInfo {
  name: string;
  dir: string;
  port: number | null;
  isDefault: boolean;
  active: boolean;
}

/**
 * Базовая директория плагина (до профилей).
 *
 * Windows: %APPDATA%\opencode\agent-steward.
 * macOS/Linux: $XDG_CONFIG_HOME/opencode/agent-steward или
 *              ~/.config/opencode/agent-steward.
 * OPENCODE_SCHEDULER_HOME переопределяет всё (тесты, кастомные установки).
 *
 * При первом запуске после переименования данные из исторической
 * .../opencode/windows-scheduler копируются в новую директорию (legacy
 * остаётся на месте как резервная копия).
 */
export function getBasePluginDir(): string {
  const custom = process.env.OPENCODE_SCHEDULER_HOME?.trim();
  if (custom) return path.resolve(custom);

  const root = path.join(pluginConfigRoot(), "opencode");
  const target = path.join(root, "agent-steward");
  const legacy = path.join(root, "windows-scheduler");

  if (fs.existsSync(target) || !fs.existsSync(legacy)) return target;

  try {
    migrateLegacyBaseDir(legacy, target);
    return target;
  } catch (error) {
    // Не теряем доступ к данным: продолжаем работать в старой директории.
    console.error(
      `[agent-steward] Не удалось перенести данные из "${legacy}" в "${target}": ${
        error instanceof Error ? error.message : String(error)
      }. Использую старую директорию.`,
    );
    return legacy;
  }
}

/** Корень конфигурации пользователя (без .../opencode). */
function pluginConfigRoot(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

const MIGRATION_MARKER = ".migrated-from-windows-scheduler";

/** Расширения текстовых файлов, в которых могут быть абсолютные пути. */
const PATH_REWRITE_EXTENSIONS = new Set([
  ".json",
  ".cmd",
  ".sh",
  ".bash",
  ".ps1",
  ".txt",
]);

/**
 * Копирует legacy-директорию в новую и переписывает в текстовых файлах
 * абсолютные пути старой директории на новую. Копия делается во временную
 * директорию и переименовывается атомарно, чтобы не оставить половину данных.
 */
function migrateLegacyBaseDir(legacy: string, target: string): void {
  const temp = `${target}.migrating-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(legacy, temp, { recursive: true });

  rewriteAbsolutePaths(temp, legacy, target);
  fs.writeFileSync(
    path.join(temp, MIGRATION_MARKER),
    `${new Date().toISOString()}\n`,
    "utf8",
  );

  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    // Параллельный процесс мог успеть создать target — это не ошибка.
    if (fs.existsSync(target)) return;
    throw error;
  }
}

function rewriteAbsolutePaths(root: string, from: string, to: string): void {
  const variants = [
    from,
    from.replace(/\\/g, "/"),
    from.replace(/\\/g, "\\\\"),
  ].filter((value, index, all) => value && all.indexOf(value) === index);

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!PATH_REWRITE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      const text = fs.readFileSync(full, "utf8");
      let next = text;
      for (const variant of variants) {
        next = next.split(variant).join(variant.includes("\\\\") ? to.replace(/\\/g, "\\\\") : variant.includes("/") ? to.replace(/\\/g, "/") : to);
      }
      if (next !== text) fs.writeFileSync(full, next, "utf8");
    }
  };

  walk(root);
}

/** Нормализует имя профиля: нижний регистр, только [a-z0-9_-]. */
export function sanitizeProfileName(value: string | null | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || DEFAULT_PROFILE;
}

/** Валидация имени профиля (без «исправления»): пусто/кривые символы — ошибка. */
export function validateProfileName(value: string): string | null {
  const trimmed = (value ?? "").trim().toLowerCase();
  if (!trimmed) return "Имя профиля не может быть пустым.";
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(trimmed)) {
    return "Имя профиля: только латиница, цифры, «-» и «_», до 40 символов, не с цифры.";
  }
  return null;
}

/** Читает имя активного профиля из файла-маркера (если есть). */
function readActiveProfileMarker(base: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(base, ACTIVE_PROFILE_FILE), "utf8").trim();
    return raw ? sanitizeProfileName(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Имя текущего профиля: OPENCODE_SCHEDULER_PROFILE > файл-маркер > default.
 */
export function getProfileName(): string {
  const fromEnv = process.env.OPENCODE_SCHEDULER_PROFILE?.trim();
  if (fromEnv) return sanitizeProfileName(fromEnv);
  return readActiveProfileMarker(getBasePluginDir()) ?? DEFAULT_PROFILE;
}

/** Директория профиля: default — базовая, остальные — <base>/profiles/<name>. */
export function getProfileDir(name: string = getProfileName()): string {
  const base = getBasePluginDir();
  const normalized = sanitizeProfileName(name);
  if (normalized === DEFAULT_PROFILE) return base;
  return path.join(base, "profiles", normalized);
}

/** Путь к метаданным профиля. */
function profileMetaFile(name: string): string {
  return path.join(getProfileDir(name), "profile.json");
}

/**
 * Порты, зарезервированные за профилем default: основной (PREFERRED_PORT
 * в server.ts) и запасной. У default может не быть profile.json, поэтому
 * в listProfiles() его порт — null, и раньше аллокатор выдавал 3782 второму
 * профилю: два дашборда дрались за один порт.
 */
const DEFAULT_PROFILE_PORTS = new Set([3782, 4782]);
const FIRST_PROFILE_PORT = 3783;
const LAST_PORT = 65535;

/**
 * Свободный порт для профиля без вызова listProfiles()/readProfileMeta()
 * (иначе рекурсия: allocateProfilePort -> listProfiles -> readProfileMeta).
 * Сканирует profile.json всех профилей напрямую с файловой системы.
 * Возвращает null, если свободных портов не осталось.
 */
function findFreeProfilePort(): number | null {
  const used = new Set<number>(DEFAULT_PROFILE_PORTS);
  const fromEnv = Number(process.env.OPENCODE_SCHEDULER_PORT);
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= LAST_PORT) {
    used.add(Math.floor(fromEnv));
  }
  const profilesRoot = path.join(getBasePluginDir(), "profiles");
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    // profiles/ ещё нет — учитываем только зарезервированные и env.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = fs.readFileSync(
        path.join(profilesRoot, entry.name, "profile.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Partial<ProfileMeta>;
      const port = Number(parsed?.port);
      if (Number.isFinite(port) && port >= 1 && port <= LAST_PORT) {
        used.add(Math.floor(port));
      }
    } catch {
      // Битый/отсутствующий profile.json — игнорируем.
    }
  }
  for (let port = FIRST_PROFILE_PORT; port <= LAST_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

/** Читает profile.json профиля (или null, если файла нет/он битый). */
export function readProfileMeta(name: string): ProfileMeta | null {
  try {
    const file = profileMetaFile(name);
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProfileMeta>;
    const profileName = sanitizeProfileName(parsed?.name ?? name);
    let port = Number(parsed?.port);
    port = Number.isFinite(port) && port >= 1 && port <= LAST_PORT ? Math.floor(port) : 0;

    // B4.3 (QA #3): профили, созданные до B4.2, могли получить порт default
    // (3782/4782). Он зарезервирован — два дашборда дрались бы за один порт.
    // Мигрируем такой профиль на свободный порт и перезаписываем profile.json.
    // Идемпотентно: после первой миграции порт уже не из DEFAULT_PROFILE_PORTS.
    if (name !== DEFAULT_PROFILE && port > 0 && DEFAULT_PROFILE_PORTS.has(port)) {
      const free = findFreeProfilePort();
      if (free === null) return { name: profileName, port: 0 };
      fs.writeFileSync(
        file,
        JSON.stringify({ ...parsed, name: profileName, port: free }, null, 2),
        "utf8",
      );
      port = free;
    }

    return { name: profileName, port };
  } catch {
    return null;
  }
}

/** Порт дашборда профиля: env > profile.json > null (дефолтная логика сервера). */
export function getProfilePort(name: string = getProfileName()): number | null {
  const fromEnv = Number(process.env.OPENCODE_SCHEDULER_PORT);
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= 65535) {
    return Math.floor(fromEnv);
  }
  const meta = readProfileMeta(name);
  if (meta && meta.port > 0) return meta.port;
  return null;
}

/** Список существующих профилей (default всегда первый). */
export function listProfiles(): ProfileInfo[] {
  const base = getBasePluginDir();
  const active = getProfileName();
  const names = new Set<string>([DEFAULT_PROFILE]);

  const profilesRoot = path.join(base, "profiles");
  try {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = sanitizeProfileName(entry.name);
      if (candidate === DEFAULT_PROFILE) continue;
      names.add(candidate);
    }
  } catch {
    // profiles/ ещё нет — только default.
  }

  return Array.from(names)
    .sort((a, b) => (a === DEFAULT_PROFILE ? -1 : b === DEFAULT_PROFILE ? 1 : a.localeCompare(b)))
    .map((name) => {
      const meta = readProfileMeta(name);
      return {
        name,
        dir: getProfileDir(name),
        port: meta && meta.port > 0 ? meta.port : null,
        isDefault: name === DEFAULT_PROFILE,
        active: name === active,
      };
    });
}

/**
 * Свободный порт для нового профиля (B4.2).
 *
 * Исключает зарезервированные порты default, порты из profile.json всех
 * профилей и порт, заданный через OPENCODE_SCHEDULER_PORT. Сканирует диапазон
 * от 3783 до 65535 и берёт первый не занятый — прежняя формула
 * `3782 + used.size` могла выдать уже занятый порт (например, при
 * зарезервированном 3783 и одном профиле).
 */
function allocateProfilePort(): number {
  const used = new Set<number>(DEFAULT_PROFILE_PORTS);
  for (const profile of listProfiles()) {
    if (profile.port) used.add(profile.port);
  }
  const fromEnv = Number(process.env.OPENCODE_SCHEDULER_PORT);
  if (Number.isFinite(fromEnv) && fromEnv >= 1 && fromEnv <= LAST_PORT) {
    used.add(Math.floor(fromEnv));
  }
  for (let port = FIRST_PROFILE_PORT; port <= LAST_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error("Не удалось выделить порт профилю: свободных портов не осталось.");
}

/**
 * Создаёт профиль: директорию + profile.json. Для default просто гарантирует
 * базовую директорию. Возвращает метаданные профиля.
 */
export function createProfile(name: string, port?: number): ProfileMeta {
  const error = validateProfileName(name);
  if (error) throw new Error(error);
  const normalized = sanitizeProfileName(name);
  const dir = getProfileDir(normalized);
  fs.mkdirSync(dir, { recursive: true });

  const existing = readProfileMeta(normalized);
  const assigned =
    Number.isFinite(Number(port)) && Number(port) > 0
      ? Math.floor(Number(port))
      : existing && existing.port > 0
        ? existing.port
        : allocateProfilePort();

  const meta: ProfileMeta = { name: normalized, port: assigned };
  fs.writeFileSync(profileMetaFile(normalized), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

/** Удаляет профиль (кроме default). Возвращает true, если директория удалена. */
export async function deleteProfile(name: string): Promise<boolean> {
  if (name === DEFAULT_PROFILE) {
    throw new Error("Профиль default удалить нельзя.");
  }
  const normalized = sanitizeProfileName(name);
  // Имя, которое санитизировалось в default (например, кириллица или пустая строка),
  // не соответствует существующему не-default профилю — такого профиля нет.
  if (normalized === DEFAULT_PROFILE) return false;
  const dir = getProfileDir(normalized);
  if (!fs.existsSync(dir)) return false;

  // T-05: перед удалением директории профиля снимаем ЕГО задачи ОС,
  // иначе после удаления профиля остаются «сироты» в schtasks/crontab/launchd.
  // Бэкенд создаётся в пространстве имён удаляемого профиля (не активного!),
  // и удаление задач дожидается завершения до fs.rmSync.
  // Динамический import — чтобы не создавать циклическую зависимость
  // profiles.ts → scheduler/index.ts → types.ts (TASK_FOLDER_NAME IIFE).
  // Ошибки снятия не фатальны — директорию всё равно чистим.
  try {
    const { removeScheduledTasksForProfile } = await import("./core/scheduler/index.js");
    await removeScheduledTasksForProfile(normalized);
  } catch {
    // Планировщик недоступен (нет schtasks/launchd/crontab) — не прерываем удаление.
  }

  fs.rmSync(dir, { recursive: true, force: true });

  // Если удалили активный профиль — возвращаем маркер на default.
  const base = getBasePluginDir();
  if (readActiveProfileMarker(base) === normalized) {
    setActiveProfile(DEFAULT_PROFILE);
  }
  return true;
}

/**
 * Переключает активный профиль через файл-маркер. Изменение подхватится при
 * следующем запуске OpenCode (директории вычисляются при загрузке модуля).
 */
export function setActiveProfile(name: string): void {
  const normalized = sanitizeProfileName(name);
  if (normalized !== DEFAULT_PROFILE && !fs.existsSync(getProfileDir(normalized))) {
    throw new Error(`Профиль "${normalized}" не существует. Сначала создайте его.`);
  }
  const base = getBasePluginDir();
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, ACTIVE_PROFILE_FILE), `${normalized}\n`, "utf8");
}

/** true, если профиль переключается переменной окружения (маркер не поможет). */
export function isProfilePinnedByEnv(): boolean {
  return Boolean(process.env.OPENCODE_SCHEDULER_PROFILE?.trim());
}
