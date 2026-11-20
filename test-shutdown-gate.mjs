// PL-10/QV-2: наблюдаемость ворот выгрузки и автосброс «зависшего» состояния.
// Запуск: node test-shutdown-gate.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";

const { createShutdownGate } = await import("./dist/core/shutdown.js");

let checks = 0;
const check = (name, ok) => {
  checks += 1;
  if (!ok) throw new Error(`FAIL ${name}`);
  console.log(`OK   ${name}`);
};

const gate = createShutdownGate();
const initial = gate.state();
check(
  "PL-10: начальное состояние ворот наблюдаемо",
  initial.shuttingDown === false &&
    initial.reason === null &&
    initial.startedAt === null &&
    initial.activeCount === 0 &&
    initial.pid === process.pid &&
    initial.unloadCompleted === false &&
    initial.lastAutoReset === null
);

gate.begin("test unload");
const begun = gate.state();
check(
  "PL-10: begin() фиксирует причину, время и PID",
  gate.isShuttingDown() === true &&
    begun.reason === "test unload" &&
    typeof begun.startedAt === "string" &&
    !Number.isNaN(Date.parse(begun.startedAt)) &&
    begun.pid === process.pid
);

let release;
const tracked = gate.track(new Promise((resolve) => (release = resolve)));
check("PL-10: track() считает активные операции", gate.state().activeCount === 1 && gate.activeCount() === 1);
release("done");
await tracked;
check("PL-10: активные операции убывают после завершения", gate.state().activeCount === 0);

gate.complete();
const completed = gate.state();
check(
  "PL-10: complete() запрещает автосброс после реальной выгрузки",
  completed.unloadCompleted === true &&
    gate.isShuttingDown() === true &&
    completed.lastAutoReset === null
);

// PL-45: повторная регистрация плагина открывает ворота даже после complete().
gate.reset();
const afterReset = gate.state();
check(
  "PL-45: reset() открывает ворота после complete()",
  afterReset.shuttingDown === false &&
    afterReset.unloadCompleted === false &&
    afterReset.reason === null &&
    afterReset.lastAutoReset?.includes("PL-45") === true &&
    gate.isShuttingDown() === false
);

// QV-2: «зависшие» ворота (begin без complete, нет активных, истёк порог)
// автоматически открываются при первом же запросе. Порог обнуляем в дочернем
// процессе, чтобы не ждать 30 секунд.
// PL-45: тот же автосброс должен работать и после complete() без выгрузки.
const child = `
  import { createShutdownGate } from ${JSON.stringify(new URL("./dist/core/shutdown.js", import.meta.url).href)};
  const g = createShutdownGate();
  g.begin("stale hot-reload");
  const before = g.isShuttingDown();
  const after = g.state();
  g.begin("completed but still loaded");
  g.complete();
  const beforeCompleted = g.isShuttingDown();
  const afterCompleted = g.state();
  console.log(JSON.stringify({ before, after, beforeCompleted, afterCompleted }));
`;
const out = execFileSync(process.execPath, ["--input-type=module", "-e", child], {
  env: { ...process.env, AGENT_STEWARD_SHUTDOWN_STALE_MS: "0" },
  encoding: "utf8",
});
const probe = JSON.parse(out.trim());
check(
  "QV-2: зависшие ворота автосбрасываются при нуле активных операций",
  probe.before === false &&
    probe.after.shuttingDown === false &&
    probe.after.lastAutoReset !== null &&
    probe.after.lastAutoReset.includes("автосброс")
);
check(
  "PL-45: ворота автосбрасываются и после complete() без выгрузки модуля",
  probe.beforeCompleted === false &&
    probe.afterCompleted.shuttingDown === false &&
    probe.afterCompleted.lastAutoReset?.includes("Code Mode") === true
);

console.log(`Shutdown gate: ${checks} проверок пройдено.`);
