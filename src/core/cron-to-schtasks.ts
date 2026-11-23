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
  "  M H D * *              -> MONTHLY, первого числа каждого месяца (/d D /st HH:MM)\n" +
  "  M H D M *              -> MONTHLY в указанном месяце (/m N, N=1..12), раз в год\n" +
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
 * Допустимые номера месяцев cron для schtasks /m (ключи 1..12).
 *
 * PL-56: раньше значениями карты были английские имена («JANUARY» и т.п.).
 * На локализованной ОС `schtasks /m` ожидает число 1..12 или имя месяца на
 * языке системы, поэтому английское имя отвергалось русской Windows с
 * «ОШИБКА: Неправильное значение параметра /M». Передаём числовой месяц —
 * он одинаково корректен на любой локали.
 */
const MONTH_MAP: Record<string, string> = {
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
  "10": "10",
  "11": "11",
  "12": "12",
};

/**
 * PL-57: форматирует стартовую границу schtasks в числовом формате DD.MM.YYYY,
 * совместимом с русской локалью Windows (ShortDatePattern = dd.MM.yyyy).
 *
 * schtasks /sd разбирает дату по локали ОС, поэтому единая ISO-строка не подходит
 * для всех локалей: на ANSI-сценарии «2026-12-01» может быть прочитано неверно. Явный формат
 * DD.MM.YYYY — числовой и однозначный для RU; для других локалей потребовался бы
 * XML-импорт с <StartBoundary> (там же можно выставить
 * <StartWhenAvailable>false</StartWhenAvailable> — schtasks CLI такого флага не
 * имеет). Сама по себе будущая /SD убирает условие «пропущенного старта», из-за
 * которого включённый catch-up («Run task as soon as possible...») догонял
 * задачу через несколько минут после создания.
 */
function formatStartBoundary(date: Date): string {
  return (
    String(date.getDate()).padStart(2, "0") +
    "." +
    String(date.getMonth() + 1).padStart(2, "0") +
    "." +
    String(date.getFullYear())
  );
}

/**
 * PL-57: ближайшая строго будущая дата первого срабатывания MONTHLY-задачи.
 *
 * @param dayOfMonth — день месяца 1..31 из cron-поля дня месяца.
 * @param month — номер месяца 1..12 для годового расписания, null — каждый месяц.
 * @param now — момент создания задачи (локальное время ОС).
 * @returns дата DD.MM.YYYY для флага `/sd` schtasks.
 */
export function nextMonthlyStartBoundary(
  dayOfMonth: number,
  month: number | null,
  now: Date = new Date(),
): string {
  const maxYear = now.getFullYear() + 2;
  for (let year = now.getFullYear(); year <= maxYear; year++) {
    const firstMonth = year === now.getFullYear() && month === null ? now.getMonth() : 0;
    const lastMonth = month === null ? 11 : month - 1;
    for (let monthIndex = firstMonth; monthIndex <= lastMonth; monthIndex++) {
      const candidate = new Date(year, monthIndex, dayOfMonth, 0, 0, 0, 0);
      // new Date(year, m, 31) перетекает в следующий месяц — такие месяцы
      // не подходят: schtasks просто не сработает 31-го в 30-дневном месяце.
      if (
        candidate.getDate() !== dayOfMonth ||
        candidate.getMonth() !== monthIndex ||
        candidate.getTime() <= now.getTime()
      ) {
        continue;
      }
      return formatStartBoundary(candidate);
    }
  }
  // Для dayOfMonth 1..31 и любого месяца подходящий кандидат есть всегда.
  throw new Error("Не удалось вычислить стартовую границу для MONTHLY-задачи.");
}

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

  // --- ПАТТЕРН 5: M H D [*|M] * -> MONTHLY (/d D [/m N] /st HH:MM) ---
  // QV-10: годовое выражение `0 4 1 1 *` раньше не конвертировалось и уходило
  // в минутный опрос ОС. Теперь оно выражается нативно: schtasks MONTHLY с /m
  // фиксирует месяц, а /d — день, поэтому тик один раз в год без пустых опросов.
  // PL-56: /m передаётся числом 1..12 (не английским именем), иначе локализованная
  // Windows (в т.ч. русская) отклоняет задачу как неверное значение параметра /M.
  // PL-57: MONTHLY-задачи получают явную будущую стартовую границу /SD. Без неё
  // schtasks берёт дату создания как start boundary и «догоняет» пропущенный
  // старт — задача стартует через минуты после создания, хотя nextRun в будущем.
  const dom = parseIntInRange(dayOfMonth, 1, 31);
  if (m !== undefined && h !== undefined && dom !== undefined && isStar(dayOfWeek)) {
    const startTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
    const extraFlags: string[] = ["/d", String(dom)];
    let monthNumber: number | null = null;
    if (!isStar(month)) {
      const mappedMonth = MONTH_MAP[month];
      if (!mappedMonth) {
        throw new Error(
          "Неподдерживаемое поле месяца: " + month + ".\n\n" + UNSUPPORTED_ERROR,
        );
      }
      // PL-56: числовой месяц 1..12 работает на любой локали ОС, в отличие от
      // английского имени месяца, которое русская Windows не принимает в /m.
      extraFlags.push("/m", mappedMonth);
      monthNumber = Number(mappedMonth);
    }
    extraFlags.push("/sd", nextMonthlyStartBoundary(dom, monthNumber));
    return {
      sc: "MONTHLY",
      extraFlags,
      startTime,
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
