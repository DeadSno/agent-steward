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

console.log(`\n${passed}/${passed + failed} проверок пройдено`);
process.exit(failed > 0 ? 1 : 0);
