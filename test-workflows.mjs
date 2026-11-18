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

// B16: политика релиза. Проверки структурные — YAML уже разобран выше, поэтому
// регрессия в release.yml падает здесь, а не на реальном `npm publish`.
const releaseName = files.find((name) => name === "release.yml" || name === "release.yaml");
check(Boolean(releaseName), "release: файл .github/workflows/release.yml существует");
if (releaseName) {
  const releaseDoc = parse(fs.readFileSync(path.join(workflowsDir, releaseName), "utf8"));
  const releaseJobs = releaseDoc.jobs ?? {};
  const jobIf = (job) => String(job?.if ?? "");
  const runsOf = (job) =>
    (Array.isArray(job?.steps) ? job.steps : []).filter((step) => typeof step?.run === "string");
  const realPublish = (step) => /\bnpm publish\b/.test(step.run) && !/--dry-run/.test(step.run);
  const publishJob = releaseJobs.publish;
  const dryRunJob = releaseJobs["dry-run"] ?? releaseJobs.dry_run;

  check(
    !releaseDoc.permissions ||
      !Object.values(releaseDoc.permissions).some((level) => level === "write"),
    "release: workflow-level permissions без write",
  );
  check(
    publishJob?.permissions?.["id-token"] === "write" &&
      publishJob?.permissions?.contents === "write",
    "release: publish-job получает id-token: write и contents: write",
  );
  check(
    Object.entries(releaseJobs).every(
      ([id, job]) => id === "publish" || job?.permissions?.["id-token"] !== "write",
    ),
    "release: id-token: write только у publish-job",
  );
  check(
    jobIf(publishJob).includes("github.event_name == 'push'") &&
      jobIf(publishJob).includes("startsWith(github.ref, 'refs/tags/v')"),
    "release: publish-job только для push по тегу v*",
  );
  check(
    runsOf(publishJob).filter(realPublish).length === 1,
    "release: ровно один реальный npm publish — в publish-job",
  );
  check(Boolean(dryRunJob), "release: есть dry-run job для workflow_dispatch");
  if (dryRunJob) {
    check(
      jobIf(dryRunJob).includes("github.event_name == 'workflow_dispatch'"),
      "release: dry-run запускается только вручную",
    );
    check(
      dryRunJob?.permissions?.["id-token"] !== "write",
      "release: dry-run без id-token: write",
    );
    check(
      runsOf(dryRunJob).some((step) => /npm pack --dry-run/.test(step.run)),
      "release: dry-run проверяет упаковку через npm pack --dry-run",
    );
    check(
      runsOf(dryRunJob).every((step) => !/\bnpm publish\b/.test(step.run)),
      "release: dry-run не вызывает npm publish (не трогает реестр)",
    );
  }
  const guardStep = runsOf(releaseJobs.verify).find((step) =>
    /version/i.test(String(step.name ?? "")),
  );
  check(
    Boolean(guardStep) &&
      /package\.json/.test(guardStep.run) &&
      /GITHUB_REF_NAME/.test(guardStep.run),
    "release: guard сверяет version из package.json с тегом",
  );
}

if (failed > 0) {
  console.error(`\nПровалено проверок: ${failed} из ${checks}`);
  process.exit(1);
}
console.log(`\nВсе проверки пройдены (workflows): ${checks}/${checks}.`);
