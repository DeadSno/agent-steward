/**
 * Деталь 3.19 / S-4: библиотека gate-passed рецептов.
 *
 * Рецепт попадает в библиотеку только вместе с объективным доказательством
 * пройденного гейта (команда, дата, коммит). Модуль чистый: он разбирает YAML
 * через общий парсер, но не читает БД, диск, сеть и не запускает команды.
 * Проверка рецепта — это сверка трёх фактов: YAML валиден, объявленный гейт
 * есть в шаге pipeline, а доказательство этого гейта помечено objective/passed.
 */
import { parsePipelineYaml } from "./pipeline-io.js";
import type { PipelineIssue, PipelineSpec } from "./pipeline-spec.js";

export const RECIPE_LIBRARY_VERSION = "1.0";
export const RECIPE_LIBRARY_FORMAT = "agent-steward.gate-passed-recipes";
export const RECIPES_METHODOLOGY_URL = "docs/RECIPES.md#methodology";

/** Доказательство объективного гейта из реального прогона. */
export interface RecipeGateEvidence {
  /** Команда гейта, зафиксированная в YAML шага. */
  command: string;
  /** Всегда true: рецепт без объективного прогона в библиотеку не берётся. */
  passed: true;
  /** Всегда true: самооценка модели доказательством не является. */
  objective: true;
  /** Идентификатор проверки (обычно имя test-*.mjs). */
  source: string;
  /** ISO-8601 дата зафиксированного прогона. */
  recordedAt: string;
  /** Коммит, в котором гейт был пройден. */
  commit?: string;
}

/** Один объективный гейт рецепта и его доказательство. */
export interface RecipeGate {
  stepId: string;
  command: string;
  evidence: RecipeGateEvidence;
}

/** Готовый рецепт: pipeline YAML + доказательства его гейтов. */
export interface GatePassedRecipe {
  id: string;
  title: string;
  taskType: string;
  description: string;
  yaml: string;
  gates: RecipeGate[];
  tags: string[];
}

export interface RecipeVerification {
  kind: "recipe-verification";
  recipeId: string;
  ok: boolean;
  gateCount: number;
  verifiedGates: number;
  issues: PipelineIssue[];
  reasons: string[];
  methodologyUrl: string;
}

export interface RecipeLibrary {
  kind: "recipe-library";
  version: string;
  format: string;
  methodologyUrl: string;
  recipeCount: number;
  recipes: GatePassedRecipe[];
}

const OPEN_SPEC_RECIPE_YAML = `version: 1
name: open-spec-recipe
description: Открытое описание DAG с объективным гейтом (S-1).
defaults:
  timeoutSeconds: 300
  allowedTools: [read, shell]
steps:
  - id: describe
    schedule: "0 3 * * *"
    prompt: >
      Разобрать opencode.pipeline.yaml и напечатать vendor-neutral описание DAG,
      гейтов и бюджетов; ничего не применять и не менять задачи.
    qualityGate: node test-open-spec.mjs
`;

const ROUTER_RECIPE_YAML = `version: 1
name: capability-router-recipe
description: Capability-роутинг с обучением по first-pass частоте (S-2).
defaults:
  timeoutSeconds: 300
  allowedTools: [read, shell]
steps:
  - id: route
    schedule: "0 4 * * *"
    prompt: >
      Построить решение о маршруте по профилю capability и зафиксировать
      snaphot роутера; статические правила остаются приоритетными по умолчанию.
    qualityGate: node test-router.mjs
`;

const SCORECARD_RECIPE_YAML = `version: 1
name: reliability-scorecard-recipe
description: Публичная метрика по объективным гейтам и токенам (S-3).
defaults:
  timeoutSeconds: 300
  allowedTools: [read, shell]
steps:
  - id: scorecard
    schedule: "0 5 * * *"
    prompt: >
      Собрать входные данные о прогонах и объективных гейтах, построить
      scorecard и напечатать methodologyUrl рядом с метрикой.
    qualityGate: node test-scorecard.mjs
`;

const RECIPES: GatePassedRecipe[] = [
  {
    id: "open-spec",
    title: "Открытый spec pipeline",
    taskType: "pipeline-spec",
    description:
      "Рецепт-describe: DAG, гейты и бюджеты в открытом формате. Гейт пройден в S-1.",
    yaml: OPEN_SPEC_RECIPE_YAML,
    tags: ["pipeline", "open-spec", "dag"],
    gates: [
      {
        stepId: "describe",
        command: "node test-open-spec.mjs",
        evidence: {
          command: "node test-open-spec.mjs",
          passed: true,
          objective: true,
          source: "test-open-spec.mjs",
          recordedAt: "2026-11-24T00:00:00.000Z",
          commit: "9db0d75",
        },
      },
    ],
  },
  {
    id: "capability-router",
    title: "Capability-роутинг с flywheel",
    taskType: "routing",
    description:
      "Рецепт маршрутизации: статические правила, first-pass частота и затухающая надёжность. Гейт пройден в S-2.",
    yaml: ROUTER_RECIPE_YAML,
    tags: ["router", "capability", "flywheel"],
    gates: [
      {
        stepId: "route",
        command: "node test-router.mjs",
        evidence: {
          command: "node test-router.mjs",
          passed: true,
          objective: true,
          source: "test-router.mjs",
          recordedAt: "2026-11-24T00:00:00.000Z",
          commit: "bb9f567",
        },
      },
    ],
  },
  {
    id: "reliability-scorecard",
    title: "Scorecard надёжности",
    taskType: "metrics",
    description:
      "Рецепт метрики: только объективные гейты и сэкономленные токены, score=null без выборки. Гейт пройден в S-3.",
    yaml: SCORECARD_RECIPE_YAML,
    tags: ["scorecard", "metrics", "gates"],
    gates: [
      {
        stepId: "scorecard",
        command: "node test-scorecard.mjs",
        evidence: {
          command: "node test-scorecard.mjs",
          passed: true,
          objective: true,
          source: "test-scorecard.mjs",
          recordedAt: "2026-11-24T00:00:00.000Z",
          commit: "16e5606",
        },
      },
    ],
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function stepKey(stepId: string, command: string): string {
  return `${stepId.trim().toLowerCase()}\u0000${normalizedCommand(command)}`;
}

/** Все рецепты библиотеки в детерминированном порядке (копии, не оригиналы). */
export function listRecipes(): GatePassedRecipe[] {
  return [...RECIPES]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((recipe) => clone(recipe));
}

/** Рецепт по id или `undefined`. Возвращается копия. */
export function getRecipe(id: string): GatePassedRecipe | undefined {
  const found = RECIPES.find((recipe) => recipe.id === id);
  return found ? clone(found) : undefined;
}

/** Метаданные библиотеки для публичного/CLI-вывода. */
export function getRecipeLibrary(): RecipeLibrary {
  return {
    kind: "recipe-library",
    version: RECIPE_LIBRARY_VERSION,
    format: RECIPE_LIBRARY_FORMAT,
    methodologyUrl: RECIPES_METHODOLOGY_URL,
    recipeCount: RECIPES.length,
    recipes: listRecipes(),
  };
}

/**
 * Проверяет, что рецепт действительно gate-passed: YAML валиден, каждый
 * объективный гейт шага имеет доказательство, а доказательство совпадает
 * с командой гейта. Ничего не выполняет и не мутирует вход.
 */
export function verifyRecipe(recipe: GatePassedRecipe): RecipeVerification {
  const issues: PipelineIssue[] = [];
  const reasons: string[] = [];
  const result: RecipeVerification = {
    kind: "recipe-verification",
    recipeId: recipe.id,
    ok: false,
    gateCount: recipe.gates?.length ?? 0,
    verifiedGates: 0,
    issues,
    reasons,
    methodologyUrl: RECIPES_METHODOLOGY_URL,
  };

  if (!recipe.id?.trim()) reasons.push("Не указан id рецепта.");
  if (!recipe.title?.trim()) reasons.push("Не указано название рецепта.");
  if (!recipe.taskType?.trim()) reasons.push("Не указан тип задачи рецепта.");
  if (!Array.isArray(recipe.gates) || recipe.gates.length === 0) {
    reasons.push("Рецепт не объявляет ни одного объективного гейта.");
  }
  if (typeof recipe.yaml !== "string" || recipe.yaml.trim().length === 0) {
    reasons.push("Не указан pipeline YAML рецепта.");
    return result;
  }

  const parsed = parsePipelineYaml(recipe.yaml);
  if (!parsed.ok || !parsed.spec) {
    for (const issue of parsed.errors) {
      issues.push({ path: `yaml.${issue.path}`, message: issue.message });
    }
    reasons.push("Pipeline YAML рецепта не прошёл валидацию.");
    return result;
  }
  for (const issue of parsed.warnings) {
    issues.push({ path: `yaml.${issue.path}`, message: issue.message });
  }

  const spec: PipelineSpec = parsed.spec;
  const byId = new Map<string, PipelineSpec["steps"][number]>();
  for (const step of spec.steps) {
    byId.set(step.id.trim().toLowerCase(), step);
  }

  const covered = new Set<string>();
  const seenGates = new Set<string>();
  recipe.gates.forEach((gate, index) => {
    const path = `gates[${index}]`;
    if (!gate.stepId?.trim()) {
      reasons.push(`${path}: не указан stepId.`);
      return;
    }
    const gateKey = gate.stepId.trim().toLowerCase();
    if (seenGates.has(gateKey)) {
      reasons.push(`${path}: гейт для шага «${gate.stepId}» объявлен повторно.`);
      return;
    }
    seenGates.add(gateKey);

    const step = byId.get(gateKey);
    if (!step) {
      reasons.push(`${path}: шаг «${gate.stepId}» отсутствует в pipeline YAML.`);
      return;
    }
    if (!gate.command?.trim() || normalizedCommand(step.qualityGate ?? "") !== normalizedCommand(gate.command)) {
      reasons.push(
        `${path}: команда гейта не совпадает с qualityGate шага «${gate.stepId}».`,
      );
      return;
    }

    const evidence = gate.evidence;
    if (evidence?.passed !== true || evidence.objective !== true) {
      reasons.push(`${path}: доказательство не помечено как objective/passed.`);
      return;
    }
    if (normalizedCommand(evidence.command ?? "") !== normalizedCommand(gate.command)) {
      reasons.push(`${path}: команда в доказательстве отличается от команды гейта.`);
      return;
    }
    if (!evidence.source?.trim()) {
      reasons.push(`${path}: не указан источник доказательства.`);
      return;
    }
    if (!Number.isFinite(Date.parse(evidence.recordedAt ?? ""))) {
      reasons.push(`${path}: некорректная дата доказательства.`);
      return;
    }

    covered.add(stepKey(step.id, gate.command));
    result.verifiedGates += 1;
  });

  for (const step of spec.steps) {
    const qualityGate = step.qualityGate?.trim();
    if (qualityGate && !covered.has(stepKey(step.id, qualityGate))) {
      reasons.push(
        `Шаг «${step.id}» объявляет гейт «${qualityGate}», но не имеет gate-passed доказательства.`,
      );
    }
  }

  result.ok = reasons.length === 0;
  return result;
}

/** Проверка рецепта по id. `undefined`, если id неизвестен. */
export function verifyRecipeById(id: string): RecipeVerification | undefined {
  const recipe = getRecipe(id);
  return recipe ? verifyRecipe(recipe) : undefined;
}

/** Проверка всей библиотеки; результат детерминирован по id рецептов. */
export function verifyAllRecipes(): RecipeVerification[] {
  return listRecipes().map((recipe) => verifyRecipe(recipe));
}
