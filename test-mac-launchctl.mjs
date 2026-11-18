// B5: installEntry не снимает паузу у paused-задачи, а ошибки launchctl
// (битый plist, права) возвращаются вызывающему с stderr и exit code.
// Реальный launchctl есть только на macOS, поэтому проверяется план команд
// и обработка ошибок через подставной runner.
import {
  describeLaunchctlError,
  planLaunchctlInstall,
  runLaunchctl,
} from "./dist/core/scheduler/mac.js";

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`OK   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const plist = "/Users/test/Library/LaunchAgents/com.opencode.scheduler.demo.plist";

// --- B5.1: paused не загружается -------------------------------------------------

{
  const plan = planLaunchctlInstall(false, plist);
  check(
    "активная задача: unload → write → load -w",
    JSON.stringify(plan.beforeWrite) === JSON.stringify(["unload", plist]) &&
      JSON.stringify(plan.afterWrite) === JSON.stringify(["load", "-w", plist]),
    JSON.stringify(plan),
  );
}

{
  const plan = planLaunchctlInstall(true, plist);
  const allArgs = [...plan.beforeWrite, ...(plan.afterWrite ?? [])];
  check("paused: после записи нет load", plan.afterWrite === null, JSON.stringify(plan));
  check(
    "paused: load -w не вызывается ни в одной фазе",
    !allArgs.includes("load"),
    JSON.stringify(allArgs),
  );
  check(
    "paused: unload -w фиксирует Disabled",
    JSON.stringify(plan.beforeWrite) === JSON.stringify(["unload", "-w", plist]),
    JSON.stringify(plan.beforeWrite),
  );
}

// --- B5.2: ошибки launchctl пробрасываются ---------------------------------------

{
  const calls = [];
  await runLaunchctl(async (args) => void calls.push(args), ["load", "-w", plist]);
  check("успешный запуск вызывает runner один раз", calls.length === 1, JSON.stringify(calls));

  const failure = Object.assign(new Error("Command failed"), {
    code: 1,
    stdout: "",
    stderr: "Invalid property list\n",
  });
  let thrown = null;
  try {
    await runLaunchctl(async () => {
      throw failure;
    }, ["load", "-w", plist]);
  } catch (err) {
    thrown = err;
  }
  check("битый plist даёт ошибку установки", thrown instanceof Error);
  check(
    "ошибка содержит команду launchctl",
    Boolean(thrown && thrown.message.includes(`launchctl load -w ${plist}`)),
    thrown?.message,
  );
  check(
    "ошибка содержит exit code и stderr",
    Boolean(thrown && thrown.message.includes("код 1") && thrown.message.includes("Invalid property list")),
    thrown?.message,
  );
  check("исходная ошибка сохранена в cause", thrown?.cause === failure);
}

{
  const failure = Object.assign(new Error("spawn launchctl ENOENT"), { code: "ENOENT" });
  const message = describeLaunchctlError(["unload", plist], failure);
  check(
    "без stderr используется message, код сохраняется",
    message.includes("код ENOENT") && message.includes("spawn launchctl ENOENT"),
    message,
  );
}

{
  let called = 0;
  await runLaunchctl(
    async () => {
      called++;
      throw Object.assign(new Error("Could not find specified service"), { code: 113 });
    },
    ["unload", plist],
    { tolerateFailure: true },
  );
  check("tolerateFailure: unload незагруженного агента не падает", called === 1);
}

if (failures > 0) {
  console.error(`\n${failures} проверка(и) провалена.`);
  process.exit(1);
}
console.log("Все проверки пройдены (mac launchctl).");
