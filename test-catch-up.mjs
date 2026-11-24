/**
 * QW-2: catch-up не должен запускать задачи, стоящие на паузе.
 *
 * Регрессия воспроизводит поведение POSIX: runTask спавнит bash напрямую и не
 * смотрит на disabled-запись планировщика, поэтому единственный барьер —
 * selectCatchUpTasks. Проверяются paused, pausedUntil, не-cron триггеры,
 * история запусков, порог 5 минут и порядок приоритетов.
 *
 * Запуск: node test-catch-up.mjs (после npm run build).
 */
import { selectCatchUpTasks } from "./dist/core/catch-up.js";

const results = [];
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` :: ${detail}`}`);
}

function definition(overrides = {}) {
  return {
    name: "QW2-Task",
    schedule: "0 * * * *",
    prompt: "noop",
    timezone: "UTC",
    ...overrides,
  };
}

const now = new Date("2026-11-24T12:30:00.000Z");

// --- Базовый пропуск -------------------------------------------------------
const base = selectCatchUpTasks([definition()], [], now);
check("пропущенный cron попадает в catch-up", base.length === 1);
check(
  "previousRun = 12:00 UTC",
  base[0]?.previousRun.toISOString() === "2026-11-24T12:00:00.000Z",
  base[0]?.previousRun.toISOString(),
);
check("ageMs = 30 минут", base[0]?.ageMs === 30 * 60 * 1000, String(base[0]?.ageMs));

// --- Пауза (главный фикс QW-2) --------------------------------------------
check("paused:true не запускается", selectCatchUpTasks([definition({ paused: true })], [], now).length === 0);
check(
  "paused:false запускается",
  selectCatchUpTasks([definition({ paused: false })], [], now).length === 1,
);
check(
  "pausedUntil в будущем не запускается",
  selectCatchUpTasks(
    [definition({ pausedUntil: "2026-11-25T00:00:00.000Z" })],
    [],
    now,
  ).length === 0,
);
check(
  "pausedUntil (даже истёкший) не запускается до resumeExpiredPauses",
  selectCatchUpTasks(
    [definition({ pausedUntil: "2026-11-23T00:00:00.000Z" })],
    [],
    now,
  ).length === 0,
);

// --- Триггеры и расписание -------------------------------------------------
check(
  "file-триггер не участвует в catch-up",
  selectCatchUpTasks([definition({ triggerType: "file" })], [], now).length === 0,
);
check(
  "once-триггер не участвует в catch-up",
  selectCatchUpTasks([definition({ triggerType: "once" })], [], now).length === 0,
);
check(
  "triggerType по умолчанию = cron",
  selectCatchUpTasks([definition({ triggerType: undefined })], [], now).length === 1,
);
check("пустое расписание пропускается", selectCatchUpTasks([definition({ schedule: "" })], [], now).length === 0);

// --- История ---------------------------------------------------------------
check(
  "запуск после previousRun блокирует catch-up",
  selectCatchUpTasks(
    [definition()],
    [{ taskName: "QW2-Task", startedAt: "2026-11-24T12:15:00.000Z" }],
    now,
  ).length === 0,
);
check(
  "запуск до previousRun не блокирует",
  selectCatchUpTasks(
    [definition()],
    [{ taskName: "QW2-Task", startedAt: "2026-11-24T11:30:00.000Z" }],
    now,
  ).length === 1,
);
check(
  "имя задачи сравнивается без учёта регистра",
  selectCatchUpTasks(
    [definition()],
    [{ taskName: "qw2-task", startedAt: "2026-11-24T12:15:00.000Z" }],
    now,
  ).length === 0,
);
check(
  "чужой запуск не блокирует",
  selectCatchUpTasks(
    [definition()],
    [{ taskName: "OTHER", startedAt: "2026-11-24T12:15:00.000Z" }],
    now,
  ).length === 1,
);

// --- Порог и приоритет -----------------------------------------------------
const soon = new Date("2026-11-24T12:00:30.000Z");
check(
  "свежий тик (< 5 мин) не считается пропуском",
  selectCatchUpTasks([definition({ schedule: "* * * * *" })], [], soon).length === 0,
);
const priority = selectCatchUpTasks(
  [
    definition({ name: "low", priority: 1 }),
    definition({ name: "high", priority: 10 }),
    definition({ name: "normal", priority: 5 }),
  ],
  [],
  now,
);
check(
  "порядок: high → normal → low",
  priority.map((item) => item.definition.name).join(",") === "high,normal,low",
  priority.map((item) => item.definition.name).join(","),
);

// --- Часовой пояс ----------------------------------------------------------
const msk = selectCatchUpTasks(
  [definition({ schedule: "0 9 * * *", timezone: "Europe/Moscow" })],
  [],
  new Date("2026-11-24T07:00:00.000Z"),
);
check("timezone учитывается (09:00 MSK = 06:00Z)", msk.length === 1);
check(
  "previousRun в UTC для MSK",
  msk[0]?.previousRun.toISOString() === "2026-11-24T06:00:00.000Z",
  msk[0]?.previousRun.toISOString(),
);

console.log(`\nCatch-up: ${passed}/${passed + failed} проверок пройдено.`);
if (failed > 0) {
  console.error(`Провалено: ${failed}`);
  process.exit(1);
}


