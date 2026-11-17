import type { CronConversion } from "../types.js";

/**
 * Сообщение об ошибке, возвращаемое при встрече неподдерживаемого cron-выражения.
 * Содержит описание поддерживаемого подмножества.
 * Собрано конкатенацией, чтобы избежать последовательности закрывающего комментария внутри строк.
 */
const UNSUPPORTED_ERROR =
  "Неподдерживаемое cron-выражение.\n" +
  "\n" +
  "Поддерживаемое подмножество cron (5 полей: минута час день_месяца месяц день_недели):\n" +
  "  * * * * *              -> MINUTE, каждую минуту (/mo 1)\n" +
  "  */N * * * *            -> MINUTE, каждые N минут (/mo N)\n" +
  "  M * * * *              -> HOURLY, ежечасно в MM минут (/st 00:MM)\n" +
  "  M H * * *              -> DAILY, ежедневно в HH:MM (/st HH:MM)\n" +
  "  M H * * D              -> WEEKLY, по неделям в день D в HH:MM (/d D /st HH:MM)\n" +
  "\n" +
  "Не поддерживаются: диапазоны (1-5), списки (1,2,3), комбинации месяца и дня недели,\n" +
  "*/N в поле дня месяца или дня недели, а также любые другие сложные выражения.\n" +
  "Выражение `M H */N * *` намеренно не превращается в DAILY /mo N: cron отсчитывает\n" +
  "дни от 1-го числа месяца, а /mo N — от даты создания задачи, поэтому расписания\n" +
  "не совпадают. Такие задачи выполняются в режиме минутного опроса (minute-poll).\n" +
  "Пожалуйста, упростите расписание, используя одно из поддерживаемых выше выражений.";

/** Дни недели для schtasks /d (0 и 7 = воскресенье). */
const DAY_OF_WEEK_MAP: Record<string, string> = {
  "0": "SUN",
  "1": "MON",
  "2": "TUE",
  "3": "WED",
  "4": "THU",
  "5": "FRI",
  "6": "SAT",
  "7": "SUN",
};

/**
 * Проверяет, является ли строка звездочкой "*".
 */
function isStar(value: string): boolean {
  return value === "*";
}

/**
 * Проверяет, является ли строка шаблоном звездочка-слэш-N (N — положительное целое).
 * Возвращает N или undefined.
 */
function parseStep(value: string): number | undefined {
  const match = /^\*\/(\d+)$/.exec(value);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  return n > 0 ? n : undefined;
}

/**
 * Проверяет, является ли строка одиночным целым числом в диапазоне [min, max].
 * Возвращает число или undefined.
 */
function parseIntInRange(value: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = parseInt(value, 10);
  return n >= min && n <= max ? n : undefined;
}

/**
 * Валидирует и преобразует 5-полевое cron-выражение во флаги schtasks.
 * Возвращает CronConversion или выбрасывает Error с понятным сообщением.
 */
export function convertCronToSchTasks(cron: string): CronConversion {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      "Ожидалось 5 полей cron-выражения (минута час день_месяца месяц день_недели), получено " +
        fields.length +
        ".\n\n" +
        UNSUPPORTED_ERROR,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // --- ПАТТЕРН 1: * * * * * -> MINUTE /mo 1 ---
  if (
    isStar(minute) &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    return {
      sc: "MINUTE",
      extraFlags: ["/mo", "1"],
    };
  }

  // --- ПАТТЕРН 2: */N * * * * -> MINUTE /mo N ---
  const stepN = parseStep(minute);
  if (
    stepN !== undefined &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    if (stepN > 1439) {
      throw new Error(
        "Интервал /mo " +
          stepN +
          " минут превышает максимально допустимый для schtasks (1439 минут).\n\n" +
          UNSUPPORTED_ERROR,
      );
    }
    // schtasks /mo Nanchors на момент создания задачи, а cron */N означает
    // минуты 0, N, 2N … внутри часа. Семантики совпадают только когда N
    // делит 60 без остатка И есть выровненный старт (00:00), поэтому ниже
    // добавляется startTime: "00:00". Для N, не делящих 60, выбрасывается
    // ошибка — задача уходит в минутный опрос с gate во враппере
    // (needsPollMode в windows.ts), а не конвертируется здесь нативно.
    if (60 % stepN !== 0) {
      throw new Error(
        "Интервал */" +
          stepN +
          " не делит час нацело: cron и schtasks понимают его по-разному.\n\n" +
          UNSUPPORTED_ERROR,
      );
    }
    return {
      sc: "MINUTE",
      extraFlags: ["/mo", String(stepN)],
      // schtasks /mo Nanchors на момент создания задачи; cron */N означает
      // минуты 0, N, 2N … внутри часа. Выровненный старт 00:00 делает
      // расписание идентичным cron для любого N, делящего 60.
      startTime: "00:00",
    };
  }

  // --- ПАТТЕРН 3: M * * * * -> HOURLY /mo 1 /st 00:MM (каждый час в минуту M) ---
  const mHourly = parseIntInRange(minute, 0, 59);
  if (
    mHourly !== undefined &&
    isStar(hour) &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    return {
      sc: "HOURLY",
      extraFlags: ["/mo", "1"],
      startTime: "00:" + String(mHourly).padStart(2, "0"),
    };
  }

  // --- ПАТТЕРН 4: M H * * * -> DAILY /st HH:MM ---
  const m = parseIntInRange(minute, 0, 59);
  const h = parseIntInRange(hour, 0, 23);
  if (
    m !== undefined &&
    h !== undefined &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    isStar(dayOfWeek)
  ) {
    const startTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    return {
      sc: "DAILY",
      extraFlags: [],
      startTime,
    };
  }

  // --- ПАТТЕРН 4: M H * * D -> WEEKLY /d D /st HH:MM ---
  const d = parseIntInRange(dayOfWeek, 0, 7);
  if (
    m !== undefined &&
    h !== undefined &&
    isStar(dayOfMonth) &&
    isStar(month) &&
    d !== undefined
  ) {
    const startTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    const dayName = DAY_OF_WEEK_MAP[String(d)];
    return {
      sc: "WEEKLY",
      extraFlags: ["/d", dayName],
      startTime,
      days: dayName,
    };
  }

  // Ни один поддерживаемый паттерн не совпал.
  throw new Error(UNSUPPORTED_ERROR);
}

/**
 * Формирует массив флагов расписания для schtasks на основе CronConversion.
 * Включает /sc, /st (если есть), и дополнительные флаги (/mo, /d).
 */
export function buildScheduleFlags(conversion: CronConversion): string[] {
  const flags: string[] = ["/sc", conversion.sc];

  if (conversion.startTime) {
    flags.push("/st", conversion.startTime);
  }

  flags.push(...conversion.extraFlags);

  return flags;
}
