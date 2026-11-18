// Тесты Спринта 23: one-shot расписание (runAt/delaySeconds, triggerType "once").
// Запуск: node test-one-shot.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-one-shot-test-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const {
  MAX_ONESHOT_DELAY_SECONDS,
  normalizeOneShotRunAt,
  buildWindowsOneShotFlags,
  formatDateByLocalePattern,
  buildAtTimestamp,
  buildLaunchdCalendar,
  buildLaunchdOneShotCleanup,
  buildOneShotGuardCommand,
} = await import("./dist/core/one-shot.js");
const { cleanupWindowsOneShotTask } = await import("./dist/core/record-history.js");
const { initDb, closeDb } = await import("./dist/db/index.js");
const {
  saveTaskDefinition,
  buildExportJson,
  parseImportJson,
} = await import("./dist/task-transfer.js");
const { simulatePipeline } = await import("./dist/core/dry-run.js");

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    passed++;
    return;
  }
  failed++;
  console.error(`  ✗ ${label}`);
}

function section(title) {
  console.log(`\n${title}`);
}

const pad = (value) => String(value).padStart(2, "0");

function expectedWindows(runAt) {
  const date = new Date(runAt);
  return [
    "/sc",
    "ONCE",
    "/sd",
    `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    "/st",
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ];
}

function expectedAt(runAt) {
  const date = new Date(runAt);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

try {
  initDb();

  section("Нормализация runAt/delaySeconds");
  {
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    const fromRunAt = normalizeOneShotRunAt({ runAt: futureIso });
    check("runAt в будущем принимается", fromRunAt.ok === true);
    check("runAt нормализуется в ISO", fromRunAt.ok && fromRunAt.runAt === new Date(Date.parse(futureIso)).toISOString());

    const fromDelay = normalizeOneShotRunAt({ delaySeconds: 90 }, Date.now());
    check("delaySeconds задаёт абсолютное время", fromDelay.ok === true);
    check("delaySeconds сохраняется в результате", fromDelay.ok && fromDelay.delaySeconds === 90);

    const both = normalizeOneShotRunAt({ runAt: futureIso, delaySeconds: 30 });
    check("runAt имеет приоритет над delaySeconds", both.ok === true && both.runAt === new Date(Date.parse(futureIso)).toISOString() && both.delaySeconds === 30);

    check("пустой ввод отклоняется", normalizeOneShotRunAt({}).ok === false);
    check("прошедшая дата отклоняется", normalizeOneShotRunAt({ runAt: new Date(Date.now() - 60_000).toISOString() }).ok === false);
    check("невалидная дата отклоняется", normalizeOneShotRunAt({ runAt: "завтра утром" }).ok === false);
    check("нулевая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: 0 }).ok === false);
    check("дробная задержка округляется вниз", normalizeOneShotRunAt({ delaySeconds: 12.9 }).ok === true);
    check("слишком большая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: MAX_ONESHOT_DELAY_SECONDS + 1 }).ok === false);
    check("задержка ровно на максимуме принимается", normalizeOneShotRunAt({ delaySeconds: MAX_ONESHOT_DELAY_SECONDS }).ok === true);
    check("строковая задержка отклоняется", normalizeOneShotRunAt({ delaySeconds: "60" }).ok === false);
  }

  section("Форматы планировщиков ОС");
  {
    const sample = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    const windows = buildWindowsOneShotFlags(sample);
    const expected = expectedWindows(sample);
    check("Windows ONCE использует /sc ONCE", JSON.stringify(windows) === JSON.stringify(expected));
    check("Windows ONCE дата DD.MM.YYYY", /^\d{2}\.\d{2}\.\d{4}$/.test(windows[3]));
    check("Windows ONCE время HH:MM", /^\d{2}:\d{2}$/.test(windows[5]));

    // P2-26: названия месяцев (MMM/MMMM) не должны превращаться в цифры.
    const p226 = new Date(2030, 0, 2, 9, 30);
    const shortMonth = new Intl.DateTimeFormat(undefined, { month: "short" }).format(p226);
    const longMonth = new Intl.DateTimeFormat(undefined, { month: "long" }).format(p226);
    check(
      "P2-26: MMM не превращается в цифры",
      formatDateByLocalePattern(p226, "yyyy. MMM d.") === `2030. ${shortMonth} 2.`,
    );
    check(
      "P2-26: MMMM даёт полное имя месяца",
      formatDateByLocalePattern(p226, "yyyy MMMM d") === `2030 ${longMonth} 2`,
    );
    check(
      "P2-26: нет мусорной даты из цифр",
      !/2030\.\s*\d{3,}/.test(formatDateByLocalePattern(p226, "yyyy. MMM d.")),
    );
    check(
      "P2-26: schtasks получает корректную дату",
      buildWindowsOneShotFlags(p226.toISOString(), "yyyy. MMM d.")[3] === `2030. ${shortMonth} 2.`,
    );

    const at = buildAtTimestamp(sample);
    check("Linux at -t использует 12 цифр", /^\d{12}$/.test(at));
    check("Linux at -t совпадает с локальной датой", at === expectedAt(sample));

    const calendar = buildLaunchdCalendar(sample);
    const date = new Date(sample);
    check("launchd Month соответствует локальному месяцу", calendar.Month === date.getMonth() + 1);
    check("launchd Day соответствует локальному дню", calendar.Day === date.getDate());
    check("launchd Hour соответствует локальному часу", calendar.Hour === date.getHours());
    check("launchd Minute соответствует локальной минуте", calendar.Minute === date.getMinutes());

    const cleanup = buildLaunchdOneShotCleanup("My-Task_1");
    check("cleanup вызывает bootout", cleanup.includes("bootout"));
    check("cleanup содержит имя санитизированной задачи", cleanup.includes("com.opencode.scheduler.My-Task_1.plist"));
    check("cleanup не прерывает обёртку при отсутствии агента", cleanup.includes("|| true"));

    // P2-27: /z ломает schtasks на Win10/11, поэтому ONCE чистится вручную.
    check(
      "P2-27: флаг /z не передаётся в schtasks",
      !buildWindowsOneShotFlags(sample, "dd.MM.yyyy").includes("/z"),
    );
    const deletedOneShots = [];
    const onceCleanup = await cleanupWindowsOneShotTask("My-Task_1", {
      platform: "win32",
      getDefinition: () => ({ triggerType: "once" }),
      deleteTask: async (name) => {
        deletedOneShots.push(name);
      },
    });
    check("P2-27: ONCE удаляется из Планировщика на Windows", onceCleanup === true);
    check("P2-27: удаляется именно эта задача", deletedOneShots[0] === "My-Task_1");
    check(
      "P2-27: cron-задача не удаляется",
      (await cleanupWindowsOneShotTask("cron-task", {
        platform: "win32",
        getDefinition: () => ({ triggerType: "cron" }),
        deleteTask: async () => {
          throw new Error("deleteTask не должен вызываться");
        },
      })) === false,
    );
    check(
      "P2-27: на Linux очистка не выполняется",
      (await cleanupWindowsOneShotTask("My-Task_1", {
        platform: "linux",
        getDefinition: () => ({ triggerType: "once" }),
        deleteTask: async () => {
          throw new Error("deleteTask не должен вызываться");
        },
      })) === false,
    );
    check(
      "P2-27: ошибка удаления не ломает завершение",
      (await cleanupWindowsOneShotTask("My-Task_1", {
        platform: "win32",
        getDefinition: () => ({ triggerType: "once" }),
        deleteTask: async () => {
          throw new Error("schtasks недоступен");
        },
      })) === false,
    );

    // P2-12.T2: guard от раннего запуска и повторной годовщины launchd.
    const guard = buildOneShotGuardCommand(
      "/bin/bash '/tmp/task.sh'",
      sample,
      "/tmp/agents/My-Task_1.once.done"
    );
    const sampleEpoch = Math.floor(Date.parse(sample) / 1000);
    check("guard содержит epoch runAt", guard.includes(`-lt ${sampleEpoch}`));
    check("guard выходит до runAt", guard.includes("exit 0"));
    check("guard проверяет маркер выполнения", guard.includes('[ -f "$stamp" ]'));
    check("guard создаёт маркер", guard.includes(': > "$stamp"'));
    check("guard выполняет исходную команду", guard.includes("/bin/bash '/tmp/task.sh'"));
    check(
      "guard экранирует одинарную кавычку в пути маркера",
      buildOneShotGuardCommand("true", sample, "/tmp/it's.done").includes(
        `stamp='/tmp/it'\\''s.done'`
      )
    );
  }

  section("Export/import round-trip для one-shot");
  const futureRunAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const definition = {
    name: "One Shot Roundtrip",
    schedule: "",
    prompt: "выполнить один раз",
    triggerType: "once",
    runAt: futureRunAt,
    timeoutSeconds: 600,
    priority: 7,
    retryCount: 2,
    dependsOn: ["Earlier Task"],
    workingDirectory: tempRoot,
  };
  await saveTaskDefinition(definition);

  const exported = await buildExportJson([
    {
      taskName: `\\OpenCode\\windows-scheduler\\${definition.name}`,
      nextRunTime: null,
      status: "ready",
    },
  ]);
  const exportedJson = JSON.parse(exported.data);
  const exportedTask = exportedJson.tasks.find((task) => task.name === definition.name);
  check("экспорт содержит ровно одну задачу", exported.count === 1 && exportedJson.tasks.length === 1);
  check("экспорт сохраняет triggerType once", exportedTask?.triggerType === "once");
  check("экспорт сохраняет runAt", exportedTask?.runAt === futureRunAt);
  check("экспорт разрешает пустое расписание для once", exportedTask?.schedule === "");
  check("экспорт сохраняет остальные поля", exportedTask?.timeoutSeconds === 600 && exportedTask?.priority === 7 && exportedTask?.retryCount === 2);

  const imported = parseImportJson(exported.data);
  check("round-trip не даёт ошибок", imported.errors.length === 0 && imported.tasks.length === 1);
  const importedTask = imported.tasks[0];
  check("round-trip сохраняет triggerType once", importedTask?.triggerType === "once");
  check("round-trip сохраняет runAt", importedTask?.runAt === futureRunAt);
  check("round-trip сохраняет prompt", importedTask?.prompt === definition.prompt);

  const delayedImport = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{
      name: "Delayed One Shot",
      prompt: "выполнить позже",
      triggerType: "once",
      delaySeconds: 120,
    }],
  }));
  check("импорт с delaySeconds работает", delayedImport.errors.length === 0 && delayedImport.tasks.length === 1);
  check("импорт с delaySeconds создаёт будущий runAt", Date.parse(delayedImport.tasks[0]?.runAt ?? "") > Date.now());

  const missingTiming = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{ name: "No Timing", prompt: "не хватает времени", triggerType: "once" }],
  }));
  check("once без runAt/delaySeconds отклоняется", missingTiming.errors.length === 1 && missingTiming.tasks.length === 0);

  const pastImport = parseImportJson(JSON.stringify({
    version: 1,
    tasks: [{
      name: "Past One Shot",
      prompt: "прошлое время",
      triggerType: "once",
      runAt: new Date(Date.now() - 3_600_000).toISOString(),
    }],
  }));
  check("once с прошедшим runAt отклоняется", pastImport.errors.length === 1 && pastImport.tasks.length === 0);

  section("Dry-run для one-shot");
  const dryRun = await simulatePipeline(definition.name);
  const dryRunTask = dryRun.tasks.find((task) => task.name === definition.name);
  check("dry-run успешен для one-shot", dryRun.success === true);
  check("dry-run помечает задачу как once", dryRunTask?.trigger === "once");
  check("dry-run возвращает runAt как next run", dryRunTask?.scheduleDetails?.nextRuns?.[0] === futureRunAt);

  console.log(`\nИтого: ${passed} пройдено, ${failed} не пройдено.`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error("\nТест завершился с ошибкой:", error);
  process.exitCode = 1;
} finally {
  try {
    closeDb();
  } catch {
    // temp dir can be removed best-effort
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
