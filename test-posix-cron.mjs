/**
 * P3-31: Linux-бэкенд должен отдавать crontab родной Vixie-синтаксис
 * (списки/диапазоны/шаги/имена) и уходить в минутный poll только для
 * Quartz-расширений, @-макросов и чужой IANA-таймзоны.
 * Запуск: node test-posix-cron.mjs (после npm run build).
 * Реальный crontab/at не трогается: вызывается только генерация строки.
 */
import { LinuxScheduler } from "./dist/core/scheduler/linux.js";
import { systemTimeZone } from "./dist/core/schedule-v2.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

// cronLine — приватный только для TypeScript; в JS он доступен на прототипе.
// Экземпляр не конструируем: генерация строки не использует состояние объекта.
const scheduler = Object.create(LinuxScheduler.prototype);
const cronLine = (schedule, extra = {}) =>
  scheduler.cronLine({
    name: "p3-31-test",
    schedule,
    command: "/tmp/wrapper.sh",
    logFile: "/tmp/p3-31.log",
    triggerType: "cron",
    paused: false,
    createdAt: "2026-11-18T00:00:00.000Z",
    ...extra,
  });

const nativeCases = [
  "*/15 * * * *",
  "0,12 8-10 * JAN,MAR 1-5",
  "0 0 * * MON",
  "30 4 1,15 * *",
];
for (const expr of nativeCases) {
  const line = cronLine(expr);
  check(`crontab: ${expr} идёт как есть`, line.startsWith(`${expr} `), line);
  check(`crontab: ${expr} содержит команду`, line.includes("/bin/bash") && line.includes("/tmp/p3-31.log"));
}

const pollCases = [
  ["0 0 L * *", "Quartz L"],
  ["0 0 * * 5#3", "Quartz d#n"],
  ["@daily", "@-макрос"],
];
for (const [expr, label] of pollCases) {
  const line = cronLine(expr);
  check(`crontab: ${label} уходит в poll`, line.startsWith("* * * * * "), line);
}

const foreign = cronLine("0 9 * * *", { timezone: "Pacific/Kiritimati" });
check("crontab: чужая таймзона уходит в poll", foreign.startsWith("* * * * * "), foreign);
const local = cronLine("0 9 * * *", { timezone: systemTimeZone() });
check("crontab: системная таймзона остаётся native", local.startsWith("0 9 * * * "), local);
check("crontab: файловый триггер не даёт строки", cronLine("", { triggerType: "file" }) === "");

console.log(`\nPOSIX crontab: ${passed}/${passed + failed} проверок пройдено.`);
process.exit(failed > 0 ? 1 : 0);
