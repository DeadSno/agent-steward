/**
 * Тесты конвертера cron -> schtasks (src/core/cron-to-schtasks.ts).
 * Покрывает фикс P1-3: для star-N (N делит 60) должен добавляться
 * /st 00:00, иначе schtasks якорит на момент создания, а не на сетку cron.
 *
 * Запуск: node test-cron-to-schtasks.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  convertCronToSchTasks,
  buildScheduleFlags,
  nextMonthlyStartBoundary,
} from "./dist/core/cron-to-schtasks.js";
import { isNativeSchtasksExpr, needsPollMode } from "./dist/core/schedule-v2.js";
import {
  cronStartBoundary,
  shouldDeferCronTriggerRecreation,
} from "./dist/core/scheduler/windows.js";

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
const yearlyFlags = buildScheduleFlags(yearly);
check(
  "QV-10: yearly flags /d 1 /m JAN /st 04:00",
  JSON.stringify(yearlyFlags.slice(0, 8)) ===
    JSON.stringify(["/sc", "MONTHLY", "/st", "04:00", "/d", "1", "/m", "JAN"]),
);
check("QV-10: yearly is native (no poll)", isNativeSchtasksExpr("0 4 1 1 *") === true);
check("QV-10: yearly needsPollMode=false", needsPollMode("0 4 1 1 *") === false);
const monthly = convertCronToSchTasks("30 12 15 * *");
check(
  "QV-10: '30 12 15 * *' -> MONTHLY /d 15 без /m",
  monthly.sc === "MONTHLY" &&
    monthly.extraFlags[0] === "/d" &&
    monthly.extraFlags[1] === "15" &&
    !monthly.extraFlags.includes("/m"),
);
let badMonth = false;
try {
  convertCronToSchTasks("0 4 1 13 *");
} catch {
  badMonth = true;
}
check("QV-10: невалидный месяц отклоняется", badMonth);

// --- PL-110 / PL-56: /m — 3-буквенная аббревиатура JAN..DEC ---
// Реальный вызов `schtasks /create` на ru-RU, 23.11.2026 (удалялся сразу после
// пробы): /m DEC -> exit 0 и в XML <ScheduleByMonth><December/><Day>2</Day>;
// /m 12, /m ДЕК, /m ДЕКАБРЬ, /m DECEMBER -> «Неправильное значение параметра /M».
// schtasks принимает только англоязычные аббревиатуры JAN..DEC — они же
// перечислены в локализованной справке `schtasks /create /?`, поэтому формат
// одинаково корректен на любой локали Windows.
const PL110_MONTH_TOKENS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const PL110_BAD_MONTH_VALUES = [
  "12", "ДЕК", "ДЕКАБРЬ", "JANUARY", "DECEMBER", "jan", "dec",
];

const pl110FlagsDec = buildScheduleFlags(convertCronToSchTasks("0 4 2 12 *"));
const pl110MonthValue = pl110FlagsDec[pl110FlagsDec.indexOf("/m") + 1];
check(
  "PL-110: '0 4 2 12 *' -> MONTHLY /st 04:00 /d 2 /m DEC",
  JSON.stringify(pl110FlagsDec.slice(0, 8)) ===
    JSON.stringify(["/sc", "MONTHLY", "/st", "04:00", "/d", "2", "/m", "DEC"]),
);
check(
  "PL-110: /m значение — валидный токен schtasks (не число, не имя месяца)",
  PL110_MONTH_TOKENS.includes(pl110MonthValue) &&
    !PL110_BAD_MONTH_VALUES.includes(pl110MonthValue),
);
check(
  "PL-110: '0 4 2 * *' без /m работает как раньше",
  (() => {
    const f = buildScheduleFlags(convertCronToSchTasks("0 4 2 * *"));
    return f[0] === "/sc" && f[1] === "MONTHLY" &&
      f.includes("/d") && f[f.indexOf("/d") + 1] === "2" &&
      !f.includes("/m") && f.includes("/sd");
  })(),
);

// PL-110: все 12 cron-месяцев дают корректную аббревиатуру; невалидный месяц
// по-прежнему отклоняется, а не «ломает» конвертер (preserve PL-56/PL-57/PL-75).
let pl110AllMonthsOk = true;
for (let n = 1; n <= 12; n++) {
  const f = buildScheduleFlags(convertCronToSchTasks(`0 4 2 ${n} *`));
  const v = f[f.indexOf("/m") + 1];
  if (v !== PL110_MONTH_TOKENS[n - 1] || f.filter((x) => x === "/m").length !== 1) {
    pl110AllMonthsOk = false;
  }
}
check("PL-110: месяцы 1..12 -> /m JAN..DEC ровно по одному флагу", pl110AllMonthsOk);
let pl110BadMonthThrows = false;
try {
  convertCronToSchTasks("0 4 2 13 *");
} catch {
  pl110BadMonthThrows = true;
}
check("PL-110: невалидный месяц (13) не ломает конвертер, а отклоняется", pl110BadMonthThrows);
check(
  "PL-110: /sd для явного месяца остаётся числовой DD.MM.YYYY (PL-57/PL-75)",
  /^\d{2}\.\d{2}\.\d{4}$/.test(pl110FlagsDec[pl110FlagsDec.indexOf("/sd") + 1] ?? ""),
);

// --- PL-57: стартовая граница MONTHLY-задач (без самопроизвольного catch-up) ---
// Дефект воспроизведён реальным вызовом конвертера до правки:
// buildScheduleFlags(convertCronToSchTasks("0 5 1 * *")) давал
// ["/sc","MONTHLY","/st","05:00","/d","1"] — без /sd. schtasks принимал дату
// создания как start boundary, и «Run task as soon as possible after a
// scheduled start is missed» догонял пропущенный старт через несколько минут.

// 23.11.2026 07:37 — момент создания задач из находки PL-57.
const pl57Now = new Date(2026, 10, 23, 7, 37, 0, 0);
check(
  "PL-57: '0 5 1 * *' -> /sd 01.12.2026 (следующий допустимый день)",
  nextMonthlyStartBoundary(1, null, pl57Now) === "01.12.2026",
);
check(
  "PL-57: годовое '0 4 1 1 *' -> /sd 01.01.2027 (следующий допустимый месяц)",
  nextMonthlyStartBoundary(1, 1, pl57Now) === "01.01.2027",
);
check(
  "PL-57: граница строго в будущем (ровно в момент старта -> следующий период)",
  nextMonthlyStartBoundary(1, null, new Date(2026, 10, 1, 5, 0, 0, 0)) === "01.12.2026",
);
check(
  "PL-57: несуществующее число месяца пропускается (31.02 -> 31.03.2026)",
  nextMonthlyStartBoundary(31, null, new Date(2026, 0, 31, 5, 0, 0, 0)) === "31.03.2026",
);

const pl57Before = Date.now();
const pl57Flags = buildScheduleFlags(convertCronToSchTasks("0 5 1 * *"));
const pl57SdIndex = pl57Flags.indexOf("/sd");
const pl57Boundary = pl57Flags[pl57SdIndex + 1];
check("PL-57: флаги MONTHLY содержат /sd", pl57SdIndex !== -1);
check(
  "PL-57: /sd — числовая дата DD.MM.YYYY (совместима с RU-локалью)",
  /^\d{2}\.\d{2}\.\d{4}$/.test(pl57Boundary ?? ""),
);
if (pl57Boundary) {
  const [pl57D, pl57M, pl57Y] = pl57Boundary.split(".").map(Number);
  check(
    "PL-57: /sd строго в будущем относительно момента создания",
    new Date(pl57Y, pl57M - 1, pl57D, 5, 0, 0, 0).getTime() > pl57Before,
  );
} else {
  check("PL-57: /sd строго в будущем относительно момента создания", false);
}
check(
  "PL-57: /sd добавляется только к MONTHLY, не к DAILY",
  !buildScheduleFlags(convertCronToSchTasks("0 9 * * *")).includes("/sd"),
);

// --- PL-75: update_task cron не должен пересоздавать OS-триггер с прошедшей границей ---
// update_task = delete + create. Без явной будущей /sd schtasks берёт дату
// создания и догоняет пропущенный старт (корень PL-57). Граница считается
// заново при каждом пересоздании и всегда строго в будущем.
check(
  "PL-75: MONTHLY-граница совпадает с PL-57",
  cronStartBoundary("0 5 1 * *", pl57Now) === nextMonthlyStartBoundary(1, null, pl57Now),
);
check(
  "PL-75: годовая MONTHLY-граница — 01.01.2027",
  cronStartBoundary("0 4 1 1 *", pl57Now) === "01.01.2027",
);
check(
  "PL-75: DAILY-граница — завтра (24.11.2026)",
  cronStartBoundary("0 9 * * *", pl57Now) === "24.11.2026",
);
{
  const boundary = cronStartBoundary("*/15 * * * *", pl57Now);
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(boundary);
  const future = match
    ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])).getTime() >
      new Date(pl57Now.getFullYear(), pl57Now.getMonth(), pl57Now.getDate()).getTime()
    : false;
  check("PL-75: /sd для MINUTE — DD.MM.YYYY строго в будущем", future);
}
check(
  "PL-75: прошедший previousNextRun требует отложить пересоздание триггера",
  shouldDeferCronTriggerRecreation("2026-11-22T09:00:00", pl57Now) === true,
);
check(
  "PL-75: будущий previousNextRun не блокирует пересоздание",
  shouldDeferCronTriggerRecreation("2026-11-24T09:00:00", pl57Now) === false,
);
check(
  "PL-75: неизвестный previousNextRun не блокирует пересоздание",
  shouldDeferCronTriggerRecreation(undefined, pl57Now) === false,
);

// --- BN-1 / BP-D01-1: */N, недостижимый для schtasks -------------------------
check("BN-1: '*/7 * * * *' уходит в poll-режим", needsPollMode("*/7 * * * *") === true);
check("BN-1: '*/15 * * * *' остаётся нативным", needsPollMode("*/15 * * * *") === false);
check(
  "BN-1: poll-режим ОС регистрируется как MINUTE /mo 1",
  (() => {
    const src = fs.readFileSync("src/core/scheduler/windows.ts", "utf8");
    return /needsPollMode\(schedule, tz\)/.test(src) && /"\/sc", "MINUTE", "\/mo", "1"/.test(src);
  })(),
);
// Буферизация пропущенных тиков должна быть запечена в ОБЕ обёртки и в gate.
check(
  "BN-1: ps-обёртка передаёт --catchup-file",
  /--catchup-file "\$\{scheduleGate\.catchupFile\.trim\(\)\}"/.test(
    fs.readFileSync("src/core/ps-wrapper.ts", "utf8"),
  ),
);
check(
  "BN-1: bash-обёртка передаёт --catchup-file",
  fs.readFileSync("src/core/wrappers/bash.ts", "utf8").includes("--catchup-file"),
);
check(
  "BN-1: gate умеет читать/писать маркер догона",
  (() => {
    const src = fs.readFileSync("src/core/schedule-gate.ts", "utf8");
    return src.includes("readCatchupMarker") && src.includes("writeCatchupMarker");
  })(),
);

console.log(`\n${passed}/${passed + failed} проверок пройдено`);
process.exit(failed > 0 ? 1 : 0);
