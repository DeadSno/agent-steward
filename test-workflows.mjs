import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const workflowsDir = path.join(process.cwd(), ".github", "workflows");
if (!fs.existsSync(workflowsDir)) {
  console.error("FAIL .github/workflows не найден");
  process.exit(1);
}

const files = fs
  .readdirSync(workflowsDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));

let checks = 0;
let failed = 0;

function check(ok, label) {
  checks += 1;
  if (ok) {
    console.log(`OK   ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}`);
  }
}

if (files.length === 0) {
  console.error("FAIL в .github/workflows нет YAML-файлов");
  process.exit(1);
}

for (const file of files) {
  const fullPath = path.join(workflowsDir, file);
  let doc;
  try {
    doc = parse(fs.readFileSync(fullPath, "utf8"));
    check(true, `${file}: YAML разбирается`);
  } catch (err) {
    check(false, `${file}: YAML не разбирается: ${err.message}`);
    continue;
  }

  check(
    doc && typeof doc === "object" && typeof doc.name === "string" && doc.name.length > 0,
    `${file}: есть name`,
  );
  check(
    doc && typeof doc === "object" && doc.on !== undefined,
    `${file}: есть триггер on`,
  );

  const jobs = doc && typeof doc === "object" ? doc.jobs : undefined;
  check(
    jobs && typeof jobs === "object" && Object.keys(jobs).length > 0,
    `${file}: есть jobs`,
  );
  if (!jobs || typeof jobs !== "object") continue;

  for (const [jobId, job] of Object.entries(jobs)) {
    check(
      job && typeof job === "object" && job["runs-on"] !== undefined,
      `${file}: job "${jobId}" имеет runs-on`,
    );
    check(
      job && typeof job === "object" && Array.isArray(job.steps) && job.steps.length > 0,
      `${file}: job "${jobId}" имеет steps`,
    );
    if (!job || typeof job !== "object" || !Array.isArray(job.steps)) continue;

    job.steps.forEach((step, index) => {
      const label = `${file}: job "${jobId}" шаг ${index + 1}`;
      const hasRun = step && typeof step === "object" && typeof step.run === "string";
      const hasUses = step && typeof step === "object" && typeof step.uses === "string";
      check(hasRun || hasUses, `${label} содержит run или uses`);
      if (hasRun) {
        check(step.run.trim().length > 0, `${label} run не пустой`);
      }
    });
  }
}

if (failed > 0) {
  console.error(`\nПровалено проверок: ${failed} из ${checks}`);
  process.exit(1);
}
console.log(`\nВсе проверки пройдены (workflows): ${checks}/${checks}.`);
