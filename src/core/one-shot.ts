/**
 * One-shot расписание (Спринт 23).
 *
 * Задача с triggerType "once" выполняется ровно один раз в момент runAt.
 * Абсолютное время хранится в ISO-8601 (UTC), а delaySeconds — удобный
 * способ задать его относительно момента создания.
 *
 * Модуль намеренно не зависит от планировщика ОС: здесь только нормализация
 * времени и преобразование в родные форматы Windows/Linux/macOS. Это
 * позволяет тестировать one-shot без создания реальных задач.
 */

/** Максимальная задержка — 5 лет. Защита от опечаток вроде 999999999. */
export const MAX_ONESHOT_DELAY_SECONDS = 5 * 365 * 24 * 60 * 60;

/** Минимальная задержка — 1 секунда. */
export const MIN_ONESHOT_DELAY_SECONDS = 1;

export interface OneShotInput {
  /** Абсолютное время запуска (ISO-8601). */
  runAt?: unknown;
  /** Задержка от текущего момента в секундах. */
  delaySeconds?: unknown;
}

export type OneShotNormalization =
  | {
      ok: true;
      /** Нормализованное абсолютное время в ISO-8601 (UTC). */
      runAt: string;
      /** Исходная задержка, если она была задана. */
      delaySeconds?: number;
    }
  | { ok: false; error: string };

function asDelaySeconds(value: unknown): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  const seconds = Math.floor(value);
  if (seconds < MIN_ONESHOT_DELAY_SECONDS || seconds > MAX_ONESHOT_DELAY_SECONDS) {
    return "invalid";
  }
  return seconds;
}

/**
 * Приводит runAt/delaySeconds к абсолютному ISO-времени.
 *
 * Если заданы оба поля, приоритет у runAt: delaySeconds сохраняется только
 * как исходная подсказка. Так импорт экспортированной задачи с обоими полями
 * не меняет момент запуска.
 */
export function normalizeOneShotRunAt(
  input: OneShotInput,
  nowMs: number = Date.now(),
): OneShotNormalization {
  const rawRunAt =
    typeof input.runAt === "string" ? input.runAt.trim() : undefined;
  const delaySeconds = asDelaySeconds(input.delaySeconds);

  if (delaySeconds === "invalid") {
    return {
      ok: false,
      error:
        `delaySeconds должен быть целым числом от ${MIN_ONESHOT_DELAY_SECONDS} ` +
        `до ${MAX_ONESHOT_DELAY_SECONDS} секунд.`,
    };
  }

  if (rawRunAt) {
    const timestamp = Date.parse(rawRunAt);
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        error:
          "runAt должен быть датой в формате ISO-8601, например " +
          `2026-12-01T09:00:00Z (получено «${rawRunAt}»).`,
      };
    }
    if (timestamp <= nowMs) {
      return {
        ok: false,
        error:
          `runAt должен быть в будущем (получено «${rawRunAt}»). ` +
          "Для запуска сразу используйте run_task_now.",
      };
    }
    return {
      ok: true,
      runAt: new Date(timestamp).toISOString(),
      ...(delaySeconds !== undefined ? { delaySeconds } : {}),
    };
  }

  if (delaySeconds !== undefined) {
    return {
      ok: true,
      runAt: new Date(nowMs + delaySeconds * 1000).toISOString(),
      delaySeconds,
    };
  }

  return {
    ok: false,
    error:
      "Для однократного запуска укажите runAt (ISO-8601) или delaySeconds.",
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Формат даты/времени для schtasks /sd и /st.
 *
 * Windows Task Scheduler ожидает дату в формате текущей локали. На русской
 * Windows — DD.MM.YYYY, на английской — M/d/yyyy и т.д. Жёсткий DD.MM.YYYY
 * ломает создание one-shot и file/git/mcp-задач на не-RU Windows (P1-8).
 * Вызывающий код (windows.ts) передаёт `dateFormat`, полученный из системной
 * локали через PowerShell `(Get-Culture).DateTimeFormat.ShortDatePattern`.
 *
 * @param runAt — ISO-8601 время запуска.
 * @param dateFormat — шаблон даты локали (например, "dd.MM.yyyy" или "M/d/yyyy").
 *                     Если не задан — используется DD.MM.YYYY (по умолчанию RU).
 */
export function buildWindowsOneShotFlags(
  runAt: string,
  dateFormat?: string,
): ["/sc", "ONCE", "/sd", string, "/st", string] {
  const date = new Date(runAt);
  const sd = dateFormat ? formatDateByLocalePattern(date, dateFormat) : `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  return [
    "/sc",
    "ONCE",
    "/sd",
    sd,
    "/st",
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ];
}

/**
 * Форматирует Date по шаблону локали Windows (.NET-формат, как возвращает
 * (Get-Culture).DateTimeFormat.ShortDatePattern). Поддерживает d/dd, M/MM,
 * MMM/MMMM (название месяца), y/yy/yyyy. Неизвестные символы копируются как есть.
 *
 * P2-26: раньше последовательные replace(/MM/) и replace(/M/) превращали
 * «MMM» в число месяца («2030. 011 2.»). Теперь разбор идёт одним проходом
 * по токенам, поэтому MMM/MMMM не пересекаются с MM/M.
 */
export function formatDateByLocalePattern(date: Date, pattern: string): string {
  const pad2 = (v: number) => String(v).padStart(2, "0");
  const monthShort = new Intl.DateTimeFormat(undefined, {
    month: "short",
  }).format(date);
  const monthLong = new Intl.DateTimeFormat(undefined, {
    month: "long",
  }).format(date);
  return pattern.replace(
    /yyyy|yy|MMMM|MMM|MM|M|dd|d/g,
    (token) => {
      switch (token) {
        case "yyyy":
          return String(date.getFullYear());
        case "yy":
          return String(date.getFullYear()).slice(-2);
        case "MMMM":
          return monthLong;
        case "MMM":
          return monthShort;
        case "MM":
          return pad2(date.getMonth() + 1);
        case "M":
          return String(date.getMonth() + 1);
        case "dd":
          return pad2(date.getDate());
        case "d":
          return String(date.getDate());
        default:
          return token;
      }
    },
  );
}

/** Формат `at -t`: YYYYMMDDHHMM в локальном времени системы. */
export function buildAtTimestamp(runAt: string): string {
  const date = new Date(runAt);
  return (
    `${date.getFullYear()}` +
    `${pad(date.getMonth() + 1)}` +
    `${pad(date.getDate())}` +
    `${pad(date.getHours())}` +
    `${pad(date.getMinutes())}`
  );
}

/**
 * Bash-команда для one-shot в launchd.
 *
 * StartCalendarInterval не поддерживает год: без защиты задача с runAt
 * дальше чем через год сработала бы в ближайшую годовщину, а после
 * выполнения — повторно через год. Гейт сравнивает now с runAt и ставит
 * маркер, привязанный ко времени запуска.
 */
export function buildOneShotGuardCommand(
  command: string,
  runAt: string,
  stampPath: string,
): string {
  const epoch = Math.floor(new Date(runAt).getTime() / 1000);
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [
    `stamp=${quote(stampPath)}`,
    "[ -f \"$stamp\" ] && exit 0",
    `[ "$(date +%s)" -lt ${epoch} ] && exit 0`,
    "mkdir -p \"$(dirname \"$stamp\")\" 2>/dev/null || true",
    ": > \"$stamp\" 2>/dev/null || true",
    command,
  ].join("; ");
}

/**
 * StartCalendarInterval для launchd. launchd не поддерживает год, поэтому
 * обёртка дополнительно проверяет runAt и ставит маркер выполнения
 * (см. buildOneShotGuardCommand).
 */
export function buildLaunchdCalendar(runAt: string): {
  Month: number;
  Day: number;
  Hour: number;
  Minute: number;
} {
  const date = new Date(runAt);
  return {
    Month: date.getMonth() + 1,
    Day: date.getDate(),
    Hour: date.getHours(),
    Minute: date.getMinutes(),
  };
}

/** Команда самоочистки launchd-агента после единственного запуска. */
export function buildLaunchdOneShotCleanup(
  sanitizedName: string,
  profile = "default",
): string {
  const label = launchdLabel(sanitizedName, profile);
  return (
    "launchctl bootout \"gui/$(id -u)\" " +
    `"$HOME/Library/LaunchAgents/${label}.plist" ` +
    ">/dev/null 2>&1 || true"
  );
}

/**
 * label launchd-агента задачи. Для default сохраняется историческое имя
 * `com.opencode.scheduler.<name>`; у не-default профиля свой префикс, чтобы
 * одноимённые задачи разных профилей не затирали plist друг друга.
 */
export function launchdLabel(sanitizedName: string, profile = "default"): string {
  const base = `com.opencode.scheduler.${sanitizedName}`;
  if (profile === "default") return base;
  const scope = profile.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `com.opencode.scheduler.profile-${scope}.${sanitizedName}`;
}
