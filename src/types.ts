import path from "node:path";
import { z } from "zod";
import { getProfileDir, getProfileName } from "./profiles.js";

/** Папка задач плагина в планировщике ОС (Windows). */
export const TASK_FOLDER = "OpenCode";
/**
 * Имя папки/блока задач. У нестандартного профиля своё пространство имён,
 * иначе профили делят одну папку Планировщика Windows и один блок crontab.
 * Новое имя — agent-steward; историческое windows-scheduler поддерживается
 * как legacy (см. legacyTaskFolderNameForProfile).
 */
export function taskFolderNameForProfile(profile: string = getProfileName()): string {
  return profile === "default" ? "agent-steward" : `agent-steward-${profile}`;
}

/** Историческое имя папки/блока задач — для чтения и удаления старых задач. */
export function legacyTaskFolderNameForProfile(
  profile: string = getProfileName(),
): string {
  return profile === "default" ? "windows-scheduler" : `windows-scheduler-${profile}`;
}

export const TASK_FOLDER_NAME = taskFolderNameForProfile();
export const LEGACY_TASK_FOLDER_NAME = legacyTaskFolderNameForProfile();

/** Префикс всех задач плагина. */
export const TASK_PREFIX = `OpenCode\\${TASK_FOLDER_NAME}`;
/** Исторический префикс задач (до переименования). */
export const LEGACY_TASK_PREFIX = `OpenCode\\${LEGACY_TASK_FOLDER_NAME}`;

/**
 * Директория для хранения файлов плагина (обёртки, логи, блокировки, история).
 *
 * Windows: %APPDATA%\opencode\windows-scheduler (как раньше — без миграции).
 * macOS/Linux: $XDG_CONFIG_HOME/opencode/windows-scheduler или
 *              ~/.config/opencode/windows-scheduler.
 * Спринт 21: директория зависит от активного профиля (см. src/profiles.ts).
 */
function resolvePluginDir(): string {
  return getProfileDir(getProfileName());
}

export const PLUGIN_DIR = resolvePluginDir();

export const LOCK_DIR = path.join(PLUGIN_DIR, "locks");
export const LOG_DIR = path.join(PLUGIN_DIR, "logs");
export const WRAPPER_DIR = path.join(PLUGIN_DIR, "wrappers");

/** true, если плагин запущен на Windows. */
export const IS_WINDOWS = process.platform === "win32";

/** Порог возраста lock-файла, после которого он считается зависшим (24 часа). */
export const STALE_LOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Приводит имя задачи к безопасному виду для имён файлов (обёртка, промпт, lock, лог).
 * Кириллица транслитерируется, прочие спецсимволы заменяются на дефис.
 * Используется единообразно при создании задачи (index.ts) и при чтении логов (schtasks.ts).
 */
export function sanitizeName(name: string): string {
  const translit: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e",
    ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
    ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };

  let result = name.toLowerCase();
  result = result.split("").map((c) => translit[c] || c).join("");
  result = result.replace(/[^a-z0-9_\-]/g, "-");
  result = result.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return result || "task";
}

/**
 * Проверяет идентификатор LLM-модели перед подстановкой в командную строку.
 *
 * Формат: `provider/model` (вариант — `provider/model#variant`).
 * Разрешены только латиница, цифры и символы `. _ : / -` (плюс `#` для
 * варианта). Это исключает PowerShell-subexpression (`$(...)`, backtick)
 * и прочие спецсимволы. Пустая строка — «модель не задана», это допустимо.
 *
 * @returns текст ошибки или null, если значение допустимо.
 */
export function validateModelId(raw: string): string | null {
  const model = raw.trim();
  if (!model) return null;
  if (!/^[A-Za-z0-9._:/-]+(?:#[A-Za-z0-9._-]+)?$/.test(model)) {
    return (
      `Недопустимый идентификатор модели «${raw}». ` +
      "Разрешены латиница, цифры и символы «.», «_», «:», «/», «-» " +
      "(вариант — через «#»)."
    );
  }
  return null;
}

/**
 * Проверяет имя задачи до создания файлов и записи в БД.
 *
 * Разрешены буквы (включая кириллицу), цифры, пробел, «_», «-» и «.».
 * Спецсимволы оболочки (`& | < > ^ % " ' ; ( ) \``, обратный слэш, слэш)
 * и управляющие символы запрещены: даже при безопасном вызове schtasks
 * такие имена ломают пути файлов и переносимы между платформами.
 *
 * @returns текст ошибки или null, если имя допустимо.
 */
export function validateTaskName(raw: string): string | null {
  const name = raw.trim();
  if (!name) {
    return "Имя задачи не может быть пустым.";
  }
  // P1-10.T1.3: имена из одних разделителей («---», «...», «.») после
  // sanitizeName превращаются в «task» и молча конфликтуют с реальной
  // задачей «task». Требуем хотя бы одну букву или цифру.
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return (
      `Имя задачи «${name}» не содержит букв или цифр: после нормализации ` +
      "оно стало бы «task». Добавьте буквы или цифры."
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return "Имя задачи не должно содержать управляющие символы.";
  }
  const invalid = /[^\p{L}\p{N}_\-. ]/u.exec(name);
  if (invalid) {
    return (
      `Имя задачи содержит недопустимый символ «${invalid[0]}». ` +
      "Разрешены буквы (включая кириллицу), цифры, пробел, «_», «-» и «.»."
    );
  }
  // schtasks ограничивает /tn в 237 символов вместе с полным путём задачи.
  // Полный путь: \OpenCode\<TASK_FOLDER_NAME>\<taskName>
  // leading \ + TASK_FOLDER + \ + TASK_FOLDER_NAME + \ — префикс перед именем задачи.
  // Для default: \OpenCode\agent-steward\ = 24 символа → 213 на имя.
  // Для не-default профиля: \OpenCode\agent-steward-<profile>\ → чем длиннее профиль, тем меньше места.
  const prefixLength = 1 + TASK_FOLDER.length + 1 + TASK_FOLDER_NAME.length + 1;
  const MAX_TASK_NAME_LENGTH = 237 - prefixLength;
  if (name.length > MAX_TASK_NAME_LENGTH) {
    return (
      `Имя задачи "${name}" слишком длинное (${name.length} символов, максимум ${MAX_TASK_NAME_LENGTH} ` +
      "с учётом папки планировщика). Сократите имя или имя workspace (для клонов матрицы)."
    );
  }
  return null;
}

/**
 * Схема аргументов для schedule_job.
 * schedule принимает только 5-полевые cron-выражения.
 */
export const ScheduleJobArgs = z.object({
  name: z
    .string()
    .min(1)
    .superRefine((value, ctx) => {
      const error = validateTaskName(value);
      if (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
      }
    })
    .describe(
      "Имя задачи (уникально в рамках префикса OpenCode\\agent-steward; legacy OpenCode\\windows-scheduler поддерживается)",
    ),
  schedule: z
    .string()
    .min(1)
    .describe("5-полевое cron-выражение (минута час день_месяца месяц день_недели)"),
  prompt: z.string().min(1).describe("Промпт, который передаётся в opencode run при запуске задачи"),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .default(3600)
    .describe("Таймаут выполнения задачи в секундах (по умолчанию 3600)"),
  workdir: z
    .string()
    .optional()
    .describe("Рабочая директория для выполнения opencode run (по умолчанию текущая)"),
});

export type ScheduleJobArgs = z.infer<typeof ScheduleJobArgs>;

export const DeleteJobArgs = z.object({
  name: z.string().min(1).describe("Имя задачи для удаления"),
});
export type DeleteJobArgs = z.infer<typeof DeleteJobArgs>;

export const RunJobNowArgs = z.object({
  name: z.string().min(1).describe("Имя задачи для немедленного запуска"),
});
export type RunJobNowArgs = z.infer<typeof RunJobNowArgs>;

export const ListJobsArgs = z.object({});
export type ListJobsArgs = z.infer<typeof ListJobsArgs>;

/**
 * Результат преобразования cron в флаги schtasks.
 */
export interface CronConversion {
  /** Тип расписания schtasks: MINUTE, DAILY или WEEKLY. */
  sc: "MINUTE" | "HOURLY" | "DAILY" | "WEEKLY";
  /** Дополнительные флаги командной строки (кроме /sc и /tn /tr /f). */
  extraFlags: string[];
  /** Время начала для /st (HH:MM) или undefined. */
  startTime?: string;
  /** Дни недели для /d (при WEEKLY). */
  days?: string;
  /** Интервал в минутах для /mo (при MINUTE). */
  interval?: number;
}

/**
 * Информация о задаче, полученная из schtasks /query.
 */
export interface ScheduledTaskInfo {
  /** Короткое имя задачи (без папки планировщика). */
  taskName: string;
  folder?: string;
  taskNameToRun?: string;
  nextRunTime?: string;
  status?: string;
  logonMode?: string;
  lastRunTime?: string;
  lastResult?: string;
  author?: string;
  taskToRun?: string;
  comment?: string;
  triggers?: string[];
  /** true — задача поставлена на паузу (disabled). */
  paused?: boolean;
}
