import { preferNewFolderTasks } from "./dist/core/scheduler/windows.js";

let passed = 0;
let failed = 0;

function check(ok, name, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`ok - ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL - ${name}${detail ? ` (${detail})` : ""}`);
  }
}

const NEW = "\\Agent-Steward\\";
const OLD = "\\Windows-Scheduler\\";

console.log("QW-15.2: приоритет новой папки задач Windows");

const legacyFirst = preferNewFolderTasks(
  [
    { taskName: OLD + "nightly", status: "Ready" },
    { taskName: NEW + "nightly", status: "Disabled" },
  ],
  NEW,
  OLD,
);
check(
  legacyFirst.length === 1 &&
    legacyFirst[0].taskName === NEW + "nightly" &&
    legacyFirst[0].status === "Disabled",
  "legacy-дубль первым: побеждает запись из новой папки вместе с её статусом",
  JSON.stringify(legacyFirst),
);

const newFirst = preferNewFolderTasks(
  [
    { taskName: NEW + "nightly", status: "Disabled" },
    { taskName: OLD + "nightly", status: "Ready" },
  ],
  NEW,
  OLD,
);
check(
  newFirst.length === 1 && newFirst[0].taskName === NEW + "nightly",
  "новая запись первым: результат не зависит от порядка вывода schtasks",
  JSON.stringify(newFirst),
);

const caseInsensitive = preferNewFolderTasks(
  [
    { taskName: OLD + "Nightly" },
    { taskName: NEW + "nightly" },
  ],
  NEW,
  OLD,
);
check(
  caseInsensitive.length === 1 && caseInsensitive[0].taskName === NEW + "nightly",
  "коллизия регистрозаввисимых имён тоже разрешается в пользу новой папки",
  JSON.stringify(caseInsensitive),
);

const distinct = preferNewFolderTasks(
  [
    { taskName: OLD + "alpha" },
    { taskName: NEW + "beta" },
    { taskName: OLD + "gamma" },
  ],
  NEW,
  OLD,
);
check(
  distinct.length === 3,
  "разные короткие имена не схлопываются",
  JSON.stringify(distinct),
);

console.log(`\nWindows list dedup: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
