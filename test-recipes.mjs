// Деталь 3.19 / S-4: библиотека gate-passed рецептов.
//
// Проверяем:
//  - каждый рецепт проходит валидацию YAML и имеет объективное доказательство гейта;
//  - verifyRecipe отклоняет подменённое доказательство и непокрытый гейт;
//  - список/записи возвращаются копиями, вывод детерминирован;
//  - публичный экспорт из agent-steward/core и CLI `recipes list/verify`.
//
// Запуск: node test-recipes.mjs (после npm run build).
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname);
let passed = 0;
let failed = 0;
const assert = (message, cond) => {
  if (cond) {
    passed += 1;
    console.log(`OK   ${message}`);
  } else {
    failed += 1;
    console.error(`FAIL ${message}`);
  }
};

const recipes = await import("./dist/core/recipes.js");
const core = await import("./dist/core-entry.js");
const { parsePipelineYaml } = await import("./dist/core/pipeline-io.js");
const {
  RECIPE_LIBRARY_FORMAT,
  RECIPE_LIBRARY_VERSION,
  RECIPES_METHODOLOGY_URL,
  getRecipe,
  getRecipeLibrary,
  listRecipes,
  verifyAllRecipes,
  verifyRecipe,
  verifyRecipeById,
} = recipes;

assert(
  "формат, версия и методика библиотеки зафиксированы",
  RECIPE_LIBRARY_FORMAT === "agent-steward.gate-passed-recipes" &&
    RECIPE_LIBRARY_VERSION === "1.0" &&
    RECIPES_METHODOLOGY_URL.includes("docs/RECIPES.md#methodology"),
);
assert(
  "публичный экспорт из agent-steward/core",
  typeof core.listRecipes === "function" &&
    typeof core.verifyRecipe === "function" &&
    core.RECIPE_LIBRARY_FORMAT === RECIPE_LIBRARY_FORMAT,
);

const library = getRecipeLibrary();
assert(
  "метаданные библиотеки согласованы со списком",
  library.kind === "recipe-library" &&
    library.recipeCount === 3 &&
    library.recipes.length === library.recipeCount &&
    library.methodologyUrl === RECIPES_METHODOLOGY_URL,
);
const ids = library.recipes.map((recipe) => recipe.id);
assert(
  "рецепты отсортированы по id",
  JSON.stringify(ids) === JSON.stringify(["capability-router", "open-spec", "reliability-scorecard"]),
);
assert(
  "у каждого рецепта есть тип, описание и теги",
  library.recipes.every(
    (recipe) =>
      recipe.title.trim().length > 0 &&
      recipe.taskType.trim().length > 0 &&
      recipe.description.trim().length > 0 &&
      recipe.tags.length > 0,
  ),
);

const listed = listRecipes();
listed[0].title = "MUTATED";
listed[0].gates[0].evidence.passed = false;
const fresh = getRecipe(listed[0].id);
assert("listRecipes возвращает копии", fresh.title !== "MUTATED" && fresh.gates[0].evidence.passed === true);
const copy = getRecipe("open-spec");
copy.gates[0].evidence.command = "MUTATED";
assert("getRecipe возвращает копию", getRecipe("open-spec").gates[0].evidence.command !== "MUTATED");
assert("неизвестный id возвращает undefined", getRecipe("missing-recipe") === undefined);

for (const recipe of library.recipes) {
  const parsed = parsePipelineYaml(recipe.yaml);
  assert(
    `YAML рецепта «${recipe.id}» валиден`,
    parsed.ok && parsed.spec !== undefined,
    JSON.stringify(parsed.errors),
  );
  const gatedSteps = (parsed.spec?.steps ?? []).filter((step) => step.qualityGate?.trim());
  assert(
    `рецепт «${recipe.id}» содержит ровно один объективный гейт`,
    gatedSteps.length === 1 && recipe.gates.length === 1,
  );
  const gate = recipe.gates[0];
  assert(
    `гейт рецепта «${recipe.id}» совпадает с qualityGate шага`,
    gate.command === gatedSteps[0]?.qualityGate && gate.stepId === gatedSteps[0]?.id,
  );
  assert(
    `доказательство рецепта «${recipe.id}» объективно и привязано к коммиту`,
    gate.evidence.passed === true &&
      gate.evidence.objective === true &&
      gate.evidence.command === gate.command &&
      gate.evidence.source.trim().length > 0 &&
      Number.isFinite(Date.parse(gate.evidence.recordedAt)) &&
      /^[0-9a-f]{7,40}$/.test(gate.evidence.commit ?? ""),
  );
}

const original = getRecipe("open-spec");
const originalSnapshot = structuredClone(original);
const verified = verifyRecipe(original);
assert(
  "verifyRecipe: эталонный рецепт подтверждён",
  verified.ok &&
    verified.kind === "recipe-verification" &&
    verified.recipeId === "open-spec" &&
    verified.gateCount === 1 &&
    verified.verifiedGates === 1 &&
    verified.reasons.length === 0 &&
    verified.issues.length === 0 &&
    verified.methodologyUrl === RECIPES_METHODOLOGY_URL,
);
assert("verifyRecipe не мутирует вход", JSON.stringify(original) === JSON.stringify(originalSnapshot));
assert(
  "verifyRecipeById находит рецепт",
  verifyRecipeById("capability-router")?.ok === true,
);
assert("verifyRecipeById на неизвестный id", verifyRecipeById("missing") === undefined);

const all = verifyAllRecipes();
assert(
  "вся библиотека gate-passed",
  all.length === 3 && all.every((item) => item.ok && item.verifiedGates === item.gateCount),
);
assert("проверка библиотеки детерминирована", JSON.stringify(verifyAllRecipes()) === JSON.stringify(all));

const notPassed = structuredClone(original);
notPassed.gates[0].evidence.passed = false;
const failedPassed = verifyRecipe(notPassed);
assert(
  "самооценка без objective/passed отклоняется",
  !failedPassed.ok && failedPassed.verifiedGates === 0 && failedPassed.reasons.some((r) => r.includes("objective/passed")),
);

const wrongCommand = structuredClone(original);
wrongCommand.gates[0].evidence.command = "node test-docs.mjs";
assert(
  "подмена команды в доказательстве отклоняется",
  !verifyRecipe(wrongCommand).ok && verifyRecipe(wrongCommand).reasons.some((r) => r.includes("отличается")),
);

const badDate = structuredClone(original);
badDate.gates[0].evidence.recordedAt = "not-a-date";
assert(
  "некорректная дата доказательства отклоняется",
  !verifyRecipe(badDate).ok && verifyRecipe(badDate).reasons.some((r) => r.includes("дата доказательства")),
);

const emptyGates = structuredClone(original);
emptyGates.gates = [];
assert(
  "рецепт без гейтов не считается gate-passed",
  !verifyRecipe(emptyGates).ok && verifyRecipe(emptyGates).reasons.some((r) => r.includes("ни одного объективного гейта")),
);

const noGateInYaml = structuredClone(original);
noGateInYaml.yaml = noGateInYaml.yaml.replace("    qualityGate: node test-open-spec.mjs\n", "");
const missingGate = verifyRecipe(noGateInYaml);
assert(
  "гейт, исчезнувший из YAML, ломает рецепт",
  !missingGate.ok && missingGate.reasons.some((r) => r.includes("qualityGate")),
);

const extraGateYaml = original.yaml +
  "  - id: extra\n    trigger: dag\n    needs: [describe]\n    prompt: Extra step\n    qualityGate: node test-docs.mjs\n";
const extraGate = structuredClone(original);
extraGate.yaml = extraGateYaml;
const uncovered = verifyRecipe(extraGate);
assert(
  "непокрытый доказательством гейт отклоняется",
  !uncovered.ok && uncovered.reasons.some((r) => r.includes("не имеет gate-passed доказательства")),
);

const brokenYaml = structuredClone(original);
brokenYaml.yaml = "version: 1\nname: broken\nsteps: []\n";
const invalid = verifyRecipe(brokenYaml);
assert(
  "невалидный YAML отклоняется с issues",
  !invalid.ok && invalid.issues.length > 0 && invalid.reasons.some((r) => r.includes("не прошёл валидацию")),
);

const cli = (args) =>
  spawnSync(process.execPath, [path.join(root, "dist/cli.js"), ...args], {
    cwd: root,
    encoding: "utf8",
  });

const listJson = cli(["recipes", "list", "--json"]);
assert("CLI recipes list --json: exit 0", listJson.status === 0, listJson.stderr);
const listPayload = JSON.parse(listJson.stdout);
assert(
  "CLI recipes list --json: три рецепта",
  listPayload.recipeCount === 3 && listPayload.recipes.length === 3,
);

const filtered = cli(["recipes", "list", "--task-type", "routing", "--json"]);
assert("CLI recipes list --task-type: exit 0", filtered.status === 0, filtered.stderr);
const filteredPayload = JSON.parse(filtered.stdout);
assert(
  "CLI recipes list --task-type: фильтр работает",
  filteredPayload.recipeCount === 1 && filteredPayload.recipes[0].id === "capability-router",
);

const verifyAllCli = cli(["recipes", "verify", "--json"]);
assert("CLI recipes verify --json: exit 0", verifyAllCli.status === 0, verifyAllCli.stderr);
const verifyAllPayload = JSON.parse(verifyAllCli.stdout);
assert(
  "CLI recipes verify --json: все подтверждены",
  Array.isArray(verifyAllPayload) && verifyAllPayload.length === 3 && verifyAllPayload.every((item) => item.ok),
);

const verifyOneCli = cli(["recipes", "verify", "open-spec", "--json"]);
assert("CLI recipes verify <id> --json: exit 0", verifyOneCli.status === 0, verifyOneCli.stderr);
const verifyOnePayload = JSON.parse(verifyOneCli.stdout);
assert("CLI recipes verify <id>: ok=true", verifyOnePayload.recipeId === "open-spec" && verifyOnePayload.ok === true);

const unknownCli = cli(["recipes", "verify", "missing-recipe", "--json"]);
assert("CLI recipes verify <unknown>: exit 1", unknownCli.status === 1, unknownCli.stderr);

const humanCli = cli(["recipes", "verify", "open-spec"]);
assert("CLI recipes verify human: OK в выводе", humanCli.status === 0 && humanCli.stdout.includes("OK open-spec"));

const noSubcommand = cli(["recipes"]);
assert("CLI recipes без подкоманды: exit 2", noSubcommand.status === 2);

console.log(`\nИтого: ${passed} OK, ${failed} FAIL`);
if (failed > 0) process.exitCode = 1;
