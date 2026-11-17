// P1-6.T1.3: конвертация cron → launchd на macOS.
// Проверяем шаг `*/N` (массив StartCalendarInterval, выровненный по cron-сетке)
// и то, что неконвертируемые выражения падают с понятной ошибкой, а не молча
// ставят неверное расписание. Установка и fallback в installEntry проверяются
// косвенно: ошибка здесь — вход в ветку StartInterval 60.
import { cronToLaunchdSchedule } from "./dist/core/scheduler/mac.js";

let failures = 0;
const check = (cond, msg, detail) => {
  if (cond) {
    console.log("OK: " + msg);
  } else {
    failures += 1;
    console.error("FAIL: " + msg + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
};

const expectThrow = (cron, msg) => {
  let error = null;
  try {
    cronToLaunchdSchedule(cron);
  } catch (err) {
    error = err;
  }
  check(error instanceof Error, msg, error ? null : "не бросил");
};

// --- Поддерживаемые формы ------------------------------------------------
{
  const schedule = cronToLaunchdSchedule("* * * * *");
  check(schedule.interval === 60, "* * * * * -> StartInterval 60", schedule);
}

{
  const schedule = cronToLaunchdSchedule("*/15 * * * *");
  const minutes = (schedule.calendars || []).map((item) => item.Minute);
  check(
    Array.isArray(schedule.calendars) && minutes.join(",") === "0,15,30,45",
    "*/15 -> минуты 0,15,30,45 (выравнивание по cron-сетке)",
    schedule,
  );
}

{
  const schedule = cronToLaunchdSchedule("*/7 * * * *");
  const minutes = (schedule.calendars || []).map((item) => item.Minute);
  check(
    minutes.join(",") === "0,7,14,21,28,35,42,49,56",
    "*/7 -> минуты 0,7,…,56",
    schedule,
  );
  check(
    (schedule.calendars || []).every((item) => item.Minute % 7 === 0),
    "*/7 -> каждая минута кратна 7",
    schedule,
  );
}

{
  const schedule = cronToLaunchdSchedule("5 * * * *");
  check(
    schedule.calendar?.Minute === 5 && schedule.calendar?.Hour === undefined,
    "5 * * * * -> Minute 5 каждый час",
    schedule,
  );
}

{
  const schedule = cronToLaunchdSchedule("0 9 * * *");
  check(
    schedule.calendar?.Minute === 0 && schedule.calendar?.Hour === 9,
    "0 9 * * * -> ежедневно 09:00",
    schedule,
  );
}

{
  const schedule = cronToLaunchdSchedule("0 9 * * 1");
  check(
    schedule.calendar?.Weekday === 1 && schedule.calendar?.Hour === 9,
    "0 9 * * 1 -> еженедельно в понедельник",
    schedule,
  );
}

{
  const schedule = cronToLaunchdSchedule("0 9 * * 0");
  check(
    schedule.calendar?.Weekday === 0,
    "0 9 * * 0 -> воскресенье (0)",
    schedule,
  );
}

// --- Неконвертируемые формы ---------------------------------------------
expectThrow("@daily", "неконвертируемый @daily -> ошибка");
expectThrow("0 9 1 * *", "фиксированный день месяца -> ошибка");
expectThrow("0 9 * 1 *", "фиксированный месяц -> ошибка");
expectThrow("0 9 * * 1,3", "список дней недели -> ошибка");
expectThrow("0 9 * * 1-5", "диапазон дней недели -> ошибка");
expectThrow("0 0 L * *", "L в дне месяца -> ошибка");
expectThrow("0 0 * * 5#2", "5#2 (вторая пятница) -> ошибка");
expectThrow("*/5 9 * * *", "*/N с фиксированным часом -> ошибка");
expectThrow("*/0 * * * *", "*/0 -> ошибка, а не пустой массив");
expectThrow("0 9 * * 8", "день недели 8 -> ошибка");
expectThrow("0 9 * *", "4 поля -> ошибка");
expectThrow("0 9 * * * *", "6 полей -> ошибка");

console.log(
  failures === 0
    ? `\nВсе проверки пройдены (mac cron).`
    : `\nЕсть падения: ${failures}.`,
);
process.exitCode = failures === 0 ? 0 : 1;
