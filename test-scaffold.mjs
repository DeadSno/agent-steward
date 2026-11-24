// Деталь 3.19 / S-6: scaffolding проекта из gate-passed рецептов одной командой.
//
// Проверяем:
//  - формат, версию, методику и публичный экспорт из agent-steward/core;
//  - отказ разворачивать рецепт, не прошедший verifyRecipe();
//  - созданные файлы (pipeline YAML, README с доказательствами, verify-gates.mjs);
//  - детерминизм, отсутствие мутаций, защиту от перезаписи и --force;
//  - автономный прогон сгенерированного verify-gates.mjs (успех и провал);
//  - CLI `scaffold <recipe-id> --out <dir> [--force] [--json]` и exit-коды.
//
// Запуск: node test-scaffold.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname);
let passed = 0;
let failed = 0;
const assert = (message, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log(`OK   ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL ${message}${detail ? `: ${detail}` : ""}`);
  }
};

const sc = await import("./dist/core/scaffold.js");
const recipes = await import("./dist/core/recipes.js");
const core = await import("./dist/core-entry.js");
const pipelineIo = await import("./dist/core/pipeline-io.js");
const {
  scaffoldFromRecipe,
  scaffoldFromRecipeId,
  SCAFFOLD_FORMAT,
  SCAFFOLD_GATE_SCRIPT,
  SCAFFOLD_METHODOLOGY_URL,
  SCAFFOLD_PIPELINE_FILE,
  SCAFFOLD_README_FILE,
  SCAFFOLD_VERSION,
} = sc;

const OK_CMD = `node -e "process.exit(0)"`;
const FAIL_CMD = `node -e "process.exit(1)"`;

function makeRecipe(id = "fixture", command = OK_CMD) {
  const yaml = `version: 1
name: scaffold-fixture
description: Тестовый рецепт для проверки scaffolding.
defaults:
  timeoutSeconds: 60
steps:
  - id: check
    schedule: "0 6 * * *"
    prompt: Проверить окружение.
    qualityGate: ${command}
`;
  return {
    id,
    title: "Fixture recipe",
    taskType: "fixture",
    description: "Рецепт с объективным гейтом для теста scaffolding.",
    yaml,
    tags: ["fixture"],
    gates: [
      {
        stepId: "check",
        command,
        evidence: {
          command,
          passed: true,
          objective: true,
          source: "test-scaffold.mjs",
          recordedAt: "2026-11-24T00:00:00.000Z",
          commit: "ec02bd0",
        },
      },
    ],
  };
}

assert("формат и версия результата зафиксированы", SCAFFOLD_FORMAT === "agent-steward.scaffold" && SCAFFOLD_VERSION === "1.0");
assert("ссылка на методику рядом с результатом", SCAFFOLD_METHODOLOGY_URL.includes("docs/SCAFFOLD.md#methodology"));
assert("имена создаваемых файлов зафиксированы", SCAFFOLD_PIPELINE_FILE === "opencode.pipeline.yaml" && SCAFFOLD_README_FILE === "README.md" && SCAFFOLD_GATE_SCRIPT === "verify-gates.mjs");
assert("публичный экспорт из agent-steward/core", typeof core.scaffoldFromRecipe === "function" && typeof core.scaffoldFromRecipeId === "function" && core.SCAFFOLD_FORMAT === SCAFFOLD_FORMAT);

const fixture = makeRecipe();
assert("фикстура сама проходит verifyRecipe", recipes.verifyRecipe(fixture).ok === true);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "steward-scaffold-"));
try {
  const dirA = path.join(tempRoot, "project-a");
  const before = JSON.stringify(fixture);
  const result = scaffoldFromRecipe(fixture, dirA);
  assert("kind/version/format/methodologyUrl публикуются", result.kind === "scaffold" && result.version === SCAFFOLD_VERSION && result.format === SCAFFOLD_FORMAT && result.methodologyUrl === SCAFFOLD_METHODOLOGY_URL);
  assert("recipeId и абсолютный targetDir корректны", result.recipeId === "fixture" && result.targetDir === path.resolve(dirA));
  assert("созданы ровно три файла в детерминированном порядке", JSON.stringify(result.files) === JSON.stringify([SCAFFOLD_PIPELINE_FILE, SCAFFOLD_README_FILE, SCAFFOLD_GATE_SCRIPT]));
  assert("гейты результата подтверждены", result.gateCount === 1 && result.verifiedGates === 1);

  const yamlWritten = fs.readFileSync(path.join(dirA, SCAFFOLD_PIPELINE_FILE), "utf8");
  assert("pipeline YAML совпадает с рецептом", yamlWritten === fixture.yaml.trimEnd() + "\n");
  const parsed = pipelineIo.parsePipelineYaml(yamlWritten);
  assert("созданный pipeline YAML валиден", parsed.ok === true && parsed.spec.steps.length === 1, JSON.stringify(parsed.errors));
  assert("qualityGate сохранён в YAML", parsed.spec.steps[0].qualityGate === OK_CMD);

  const readme = fs.readFileSync(path.join(dirA, SCAFFOLD_README_FILE), "utf8");
  assert("README contains заголовок и id рецепта", readme.includes("# Fixture recipe") && readme.includes("fixture"));
  assert("README содержит доказательства гейта", readme.includes(OK_CMD) && readme.includes("2026-11-24T00:00:00.000Z") && readme.includes("ec02bd0"));
  assert("README ссылается на методику и ограничение доказательств", readme.includes(SCAFFOLD_METHODOLOGY_URL) && readme.includes("снимок объективного прогона"));

  const script = fs.readFileSync(path.join(dirA, SCAFFOLD_GATE_SCRIPT), "utf8");
  assert("verify-gates.mjs содержит команду гейта", script.includes(JSON.stringify(OK_CMD)) && script.includes("process.exit(failed > 0 ? 1 : 0)"));
  const gateRun = spawnSync(process.execPath, [path.join(dirA, SCAFFOLD_GATE_SCRIPT)], { encoding: "utf8", cwd: dirA });
  assert("verify-gates.mjs проходит при успешном гейте", gateRun.status === 0 && gateRun.stdout.includes("OK check") && gateRun.stdout.includes("пройдено: 1"), gateRun.stderr);

  assert("входной рецепт не мутируется", JSON.stringify(fixture) === before);

  const dirB = path.join(tempRoot, "project-b");
  scaffoldFromRecipe(fixture, dirB);
  const identical = result.files.every((name) => fs.readFileSync(path.join(dirA, name)).equals(fs.readFileSync(path.join(dirB, name))));
  assert("результат побайтово детерминирован", identical);

  let clobber = null;
  try { scaffoldFromRecipe(fixture, dirA); } catch (err) { clobber = err; }
  assert("существующие файлы не перезаписываются", clobber instanceof Error && /уже существуют/.test(clobber.message));
  const forced = scaffoldFromRecipe(fixture, dirA, { overwrite: true });
  assert("overwrite:true разрешает перезапись", forced.files.length === 3 && forced.recipeId === "fixture");

  const dirC = path.join(tempRoot, "project-c");
  const noScript = scaffoldFromRecipe(fixture, dirC, { includeGateScript: false });
  assert("includeGateScript:false убирает скрипт", noScript.files.length === 2 && !fs.existsSync(path.join(dirC, SCAFFOLD_GATE_SCRIPT)));

  const bad = makeRecipe("bad", OK_CMD);
  bad.gates[0].evidence.passed = false;
  let refused = null;
  try { scaffoldFromRecipe(bad, path.join(tempRoot, "bad-project")); } catch (err) { refused = err; }
  assert("рецепт без gate-passed доказательства отклоняется", refused instanceof Error && /gate-passed/.test(refused.message));

  let missing = null;
  try { scaffoldFromRecipeId("nope", path.join(tempRoot, "nope")); } catch (err) { missing = err; }
  assert("неизвестный id рецепта отклоняется", missing instanceof Error && /не найден/.test(missing.message));

  const byId = scaffoldFromRecipeId("open-spec", path.join(tempRoot, "from-id"));
  assert("scaffoldFromRecipeId берёт рецепт из библиотеки S-4", byId.recipeId === "open-spec" && byId.verifiedGates === 1 && fs.existsSync(path.join(tempRoot, "from-id", SCAFFOLD_PIPELINE_FILE)));

  const invalidCalls = [
    ["пустой recipe", () => scaffoldFromRecipe({ ...fixture, id: "  " }, path.join(tempRoot, "x"))],
    ["пустой targetDir", () => scaffoldFromRecipe(fixture, "  ")],
    ["overwrite строкой", () => scaffoldFromRecipe(fixture, path.join(tempRoot, "y"), { overwrite: "yes" })],
    ["includeGateScript числом", () => scaffoldFromRecipe(fixture, path.join(tempRoot, "z"), { includeGateScript: 1 })],
    ["пустой id в scaffoldFromRecipeId", () => scaffoldFromRecipeId("", path.join(tempRoot, "w"))],
  ];
  for (const [label, fn] of invalidCalls) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(`валидация: ${label}`, threw);
  }

  const failing = makeRecipe("failing", FAIL_CMD);
  const dirFail = path.join(tempRoot, "failing-project");
  scaffoldFromRecipe(failing, dirFail);
  const failRun = spawnSync(process.execPath, [path.join(dirFail, SCAFFOLD_GATE_SCRIPT)], { encoding: "utf8", cwd: dirFail });
  assert("verify-gates.mjs падает при проваленном гейте", failRun.status === 1 && failRun.stdout.includes("FAIL check"), failRun.stderr);

  const cliBase = path.join(root, "dist/cli.js");
  const cliJson = spawnSync(process.execPath, [cliBase, "scaffold", "capability-router", "--out", path.join(tempRoot, "cli-json"), "--json"], { encoding: "utf8", cwd: root });
  assert("CLI scaffold --json exit 0", cliJson.status === 0, cliJson.stderr);
  const cliResult = JSON.parse(cliJson.stdout);
  assert("CLI вернул тот же контракт", cliResult.recipeId === "capability-router" && cliResult.files.length === 3 && cliResult.verifiedGates === 1);
  const cliHuman = spawnSync(process.execPath, [cliBase, "scaffold", "reliability-scorecard", "--out", path.join(tempRoot, "cli-human")], { encoding: "utf8", cwd: root });
  assert("CLI печатает сводку и файлы", cliHuman.status === 0 && cliHuman.stdout.includes("OK рецепт") && cliHuman.stdout.includes(SCAFFOLD_PIPELINE_FILE), cliHuman.stderr);
  const cliForced = spawnSync(process.execPath, [cliBase, "scaffold", "capability-router", "--out", path.join(tempRoot, "cli-json"), "--force"], { encoding: "utf8", cwd: root });
  assert("CLI --force перезаписывает", cliForced.status === 0, cliForced.stderr);
  const cliUnknown = spawnSync(process.execPath, [cliBase, "scaffold", "nope", "--out", path.join(tempRoot, "cli-unknown")], { encoding: "utf8", cwd: root });
  assert("CLI неизвестный рецепт даёт exit 1", cliUnknown.status === 1 && cliUnknown.stderr.includes("не найден"));
  const cliNoOut = spawnSync(process.execPath, [cliBase, "scaffold", "open-spec"], { encoding: "utf8", cwd: root });
  assert("CLI без --out даёт exit 2", cliNoOut.status === 2);
  const cliNoArgs = spawnSync(process.execPath, [cliBase, "scaffold"], { encoding: "utf8", cwd: root });
  assert("CLI без аргументов даёт exit 2", cliNoArgs.status === 2);
  const cliHelp = spawnSync(process.execPath, [cliBase, "scaffold", "--help"], { encoding: "utf8", cwd: root });
  assert("CLI scaffold --help печатает usage", cliHelp.status === 0 && cliHelp.stdout.includes("scaffold <recipe-id>"));
  const blockedFile = path.join(tempRoot, "not-a-dir");
  fs.writeFileSync(blockedFile, "occupied", "utf8");
  const cliFileTarget = spawnSync(process.execPath, [cliBase, "scaffold", "open-spec", "--out", blockedFile], { encoding: "utf8", cwd: root });
  assert("CLI файл вместо каталога даёт exit 1", cliFileTarget.status === 1);
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} проверок scaffolding пройдено.`);
process.exit(failed > 0 ? 1 : 0);