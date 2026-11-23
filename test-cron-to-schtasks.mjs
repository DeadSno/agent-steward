/**
 * Тесты конвертера cron -> schtasks (src/core/cron-to-schtasks.ts).
 * Покрывает фикс P1-3: для star-N (N делит 60) должен добавляться
 * /st 00:00, иначе schtasks якорит на момент создания, а не на сетку cron.
 *
 * Запуск: node test-cron-to-schtasks.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import {
  convertCronToSchTasks,
  buildScheduleFlags,
} from "./dist/core/cron-to-schtasks.js";
import { isNativeSchtasksExpr, needsPollMode } from "./dist/core/schedule-v2.js";

const results = [];
let passed = 0;
let failed = 0;
function check(name, cond) {
  const ok = !!cond;
  results.push({ name, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

// --- Паттерн 2: */N * * * * (N делит 60) ---

const c15 = convertCronToSchTasks("*/15 * * * *");
check("*/15 -> sc MINUTE", c15.sc === "MINUTE");
check("*/15 -> /mo 15", JSON.stringify(c15.extraFlags) === JSON.stringify(["/mo", "15"]));
check("*/15 -> startTime 00:00", c15.startTime === "00:00");

const flags15 = buildScheduleFlags(c15);
check("*/15 flags contain /st 00:00", flags15.includes("/st") && flags15.includes("00:00"));
check("*/15 flags contain /mo 15", flags15.includes("/mo") && flags15.includes("15"));

const c30 = convertCronToSchTasks("*/30 * * * *");
check("*/30 -> startTime 00:00", c30.startTime === "00:00");
check("*/30 -> /mo 30", JSON.stringify(c30.extraFlags) === JSON.stringify(["/mo", "30"]));

const c60 = convertCronToSchTasks("*/60 * * * *");
check("*/60 -> startTime 00:00", c60.startTime === "00:00");
check("*/60 -> /mo 60", JSON.stringify(c60.extraFlags) === JSON.stringify(["/mo", "60"]));

// --- N не делит 60 -> ошибка (задача уходит в poll+gate, не конвертируется здесь) ---
let threw = false;
try {
  convertCronToSchTasks("*/7 * * * *");
} catch {
  threw = true;
}
check("*/7 throws (not dividing 60)", threw);

// --- 其他 поддерживаемые паттерны не сломались ---
const cStar = convertCronToSchTasks("* * * * *");
check("* * * * * -> sc MINUTE /mo 1", cStar.sc === "MINUTE" && JSON.stringify(cStar.extraFlags) === JSON.stringify(["/mo", "1"]));

const mHourly = convertCronToSchTasks("15 * * * *");
check("15 * * * * -> HOURLY /st 00:15", mHourly.sc === "HOURLY" && mHourly.startTime === "00:15");

const daily = convertCronToSchTasks("0 9 * * *");
check("0 9 * * * -> DAILY /st 09:00", daily.sc === "DAILY" && daily.startTime === "09:00");

// --- QV-10: годовой cron -> нативный schtasks MONTHLY вместо минутного опроса ---
const yearly = convertCronToSchTasks("0 4 1 1 *");
check("QV-10: '0 4 1 1 *' -> MONTHLY", yearly.sc === "MONTHLY");
check(
  "QV-10: yearly flags /d 1 /m 1 /st 04:00",
  JSON.stringify(buildScheduleFlags(yearly)) ===
    JSON.stringify(["/sc", "MONTHLY", "/st", "04:00", "/d", "1", "/m", "1"]),
);
check("QV-10: yearly is native (no poll)", isNativeSchtasksExpr("0 4 1 1 *") === true);
check("QV-10: yearly needsPollMode=false", needsPollMode("0 4 1 1 *") === false);
const monthly = convertCronToSchTasks("30 12 15 * *");
check(
  "QV-10: '30 12 15 * *' -> MONTHLY /d 15 без /m",
  monthly.sc === "MONTHLY" && JSON.stringify(monthly.extraFlags) === JSON.stringify(["/d", "15"]),
);
let badMonth = false;
try {
  convertCronToSchTasks("0 4 1 13 *");
} catch {
  badMonth = true;
}
check("QV-10: невалидный месяц отклоняется", badMonth);

// --- PL-56: сборка флагов для русской локали: /m — число 1..12, а не имя месяца ---
// На русской Windows `schtasks /m` ждёт число 1..12 или имя месяца на языке
// системы; английское имя («JANUARY») даёт «ОШИБКА: Неправильное значение
// параметра /M». Конвертер не знает локаль ОС, поэтому передаёт число.
const pl56Flags = buildScheduleFlags(convertCronToSchTasks("0 4 1 1 *"));
const pl56MonthIndex = pl56Flags.indexOf("/m");
const pl56MonthValue = pl56Flags[pl56MonthIndex + 1];
check(
  "PL-56: yearly /m — числовой месяц '1', а не 'JANUARY' (русская локаль)",
  pl56MonthValue === "1" && !pl56Flags.includes("JANUARY"),
);
check(
  "PL-56: /m значение — число 1..12 (корректно для любой локали ОС)",
  /^(?:[1-9]|1[0-2])$/.test(pl56MonthValue ?? ""),
);

// PL-56: все 12 месяцев дают числовой /m без английских имён.
const pl56EnglishNames = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];
let pl56AllNumeric = true;
for (let n = 1; n <= 12; n++) {
  const f = buildScheduleFlags(convertCronToSchTasks(`0 4 1 ${n} *`));
  const v = f[f.indexOf("/m") + 1];
  if (v !== String(n) || pl56EnglishNames.some((name) => f.includes(name))) {
    pl56AllNumeric = false;
  }
}
check("PL-56: месяцы 1..12 -> числовой /m 1..12 без английских имён", pl56AllNumeric);

console.log(`\n${passed}/${passed + failed} проверок пройдено`);
process.exit(failed > 0 ? 1 : 0);
