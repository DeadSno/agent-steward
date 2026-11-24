/**
 * Деталь 3.19 / S-6: scaffolding проекта из gate-passed рецептов одной командой.
 *
 * Модуль берёт рецепт из библиотеки S-4, перед записью проверяет его
 * верификатором `verifyRecipe()` и создаёт минимальный чек-аут: pipeline YAML,
 * README с доказательствами гейтов и самостоятельный `verify-gates.mjs`.
 * Зависимостей от БД, HTTP и OpenCode нет; файловая запись — единственная
 *opia модуля (это и есть его назначение). Запись детерминирована: во
 * сгенерированных файлах нет текущего времени, поэтому одинаковый рецепт
 * даёт побайтово одинаковый результат.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRecipe, verifyRecipe, type GatePassedRecipe } from "./recipes.js";

export const SCAFFOLD_VERSION = "1.0";
export const SCAFFOLD_FORMAT = "agent-steward.scaffold";
export const SCAFFOLD_METHODOLOGY_URL = "docs/SCAFFOLD.md#methodology";
export const SCAFFOLD_PIPELINE_FILE = "opencode.pipeline.yaml";
export const SCAFFOLD_README_FILE = "README.md";
export const SCAFFOLD_GATE_SCRIPT = "verify-gates.mjs";

export interface ScaffoldOptions {
  /** Перезаписать уже существующие файлы. По умолчанию false (защита от потери данных). */
  overwrite?: boolean;
  /** Создать `verify-gates.mjs`. По умолчанию true. */
  includeGateScript?: boolean;
}

export interface ScaffoldResult {
  kind: "scaffold";
  version: string;
  format: string;
  recipeId: string;
  /** Абсолютный путь к каталогу проекта. */
  targetDir: string;
  /** Относительные пути записанных файлов в детерминированном порядке. */
  files: string[];
  gateCount: number;
  verifiedGates: number;
  methodologyUrl: string;
}

function mdCell(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function renderReadme(recipe: GatePassedRecipe): string {
  const gates = recipe.gates
    .map(
      (gate) =>
        `| ${mdCell(gate.stepId)} | \`${mdCell(gate.command)}\` | ${mdCell(gate.evidence.source)} | ${mdCell(gate.evidence.recordedAt)} | \`${mdCell(gate.evidence.commit ?? "—")}\` |`,
    )
    .join("\n");
  return [
    `# ${recipe.title}`,
    "",
    `Рецепт: \`${recipe.id}\` · тип задачи: \`${recipe.taskType}\`.`,
    "",
    recipe.description.trim(),
    "",
    "## Объективные гейты",
    "",
    "| Шаг | Команда | Источник | Зафиксировано | Коммит |",
    "|---|---|---|---|---|",
    gates,
    "",
    "## Проверка",
    "",
    "```sh",
    `agent-steward pipeline validate ${SCAFFOLD_PIPELINE_FILE}`,
    "```",
    "",
    "Гейты можно перепроверить автономно (без БД и плагина):",
    "",
    "```sh",
    `node ${SCAFFOLD_GATE_SCRIPT}`,
    "```",
    "",
    "## Ограничение доказательств",
    "",
    "Гейты рецепта — снимок объективного прогона на момент публикации, а не",
    "гарантия на текущем чек-ауте. `verify-gates.mjs` заново запускает команды",
    "гейтов; без установленных зависимостей проекта прогон может завершиться",
    "ошибкой — это не опровержение рецепта, а отсутствие окружения.",
    "",
    `Методика: ${SCAFFOLD_METHODOLOGY_URL}`,
    "",
  ].join("\n");
}

function renderGateScript(recipe: GatePassedRecipe): string {
  const gates = recipe.gates.map((gate) => ({
    stepId: gate.stepId,
    command: gate.command,
  }));
  return [
    "#!/usr/bin/env node",
    `// Сгенерировано agent-steward из gate-passed рецепта «${recipe.id}».`,
    'import { spawnSync } from "node:child_process";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const here = path.dirname(fileURLToPath(import.meta.url));",
    `const gates = ${JSON.stringify(gates, null, 2)};`,
    "let failed = 0;",
    "for (const gate of gates) {",
    '  const run = spawnSync(gate.command, { cwd: here, shell: true, stdio: "inherit" });',
    "  const ok = run.status === 0 && !run.error;",
    "  if (!ok) failed += 1;",
    '  console.log(`${ok ? "OK" : "FAIL"} ${gate.stepId}: ${gate.command}`);',
    "}",
    "console.log(`Гейтов: ${gates.length}, пройдено: ${gates.length - failed}`);",
    "process.exit(failed > 0 ? 1 : 0);",
    "",
  ].join("\n");
}

/**
 * Разворачивает рецепт в каталоге `targetDir`.
 *
 * Перед записью рецепт обязан пройти `verifyRecipe()` — так в свежий проект
 * не попадёт «пример ради примера». Существующие файлы не перезаписываются
 * без `overwrite: true`. Входной рецепт не мутируется.
 */
export function scaffoldFromRecipe(
  recipe: GatePassedRecipe,
  targetDir: string,
  options: ScaffoldOptions = {},
): ScaffoldResult {
  if (!recipe || typeof recipe !== "object" || !recipe.id?.trim()) {
    throw new Error("Не указан рецепт для scaffolding.");
  }
  if (typeof targetDir !== "string" || targetDir.trim().length === 0) {
    throw new Error("Не указан каталог назначения для scaffolding.");
  }
  if (options.overwrite !== undefined && typeof options.overwrite !== "boolean") {
    throw new Error("overwrite должен быть boolean.");
  }
  if (options.includeGateScript !== undefined && typeof options.includeGateScript !== "boolean") {
    throw new Error("includeGateScript должен быть boolean.");
  }

  const verification = verifyRecipe(recipe);
  if (!verification.ok) {
    throw new Error(
      `Рецепт «${recipe.id}» не прошёл проверку gate-passed: ${verification.reasons.join(" ")}`,
    );
  }

  const includeGateScript = options.includeGateScript ?? true;
  const files: Record<string, string> = {
    [SCAFFOLD_PIPELINE_FILE]: `${recipe.yaml.trimEnd()}\n`,
    [SCAFFOLD_README_FILE]: renderReadme(recipe),
  };
  if (includeGateScript) {
    files[SCAFFOLD_GATE_SCRIPT] = renderGateScript(recipe);
  }

  const resolvedTarget = path.resolve(targetDir);
  const overwrite = options.overwrite ?? false;
  const collisions = Object.keys(files)
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => !overwrite && existsSync(path.join(resolvedTarget, name)));
  if (collisions.length > 0) {
    throw new Error(
      `Файлы уже существуют: ${collisions.join(", ")}. Используйте overwrite: true или --force.`,
    );
  }

  mkdirSync(resolvedTarget, { recursive: true });
  for (const name of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    writeFileSync(path.join(resolvedTarget, name), files[name], "utf8");
  }

  return {
    kind: "scaffold",
    version: SCAFFOLD_VERSION,
    format: SCAFFOLD_FORMAT,
    recipeId: recipe.id,
    targetDir: resolvedTarget,
    files: Object.keys(files).sort((a, b) => a.localeCompare(b)),
    gateCount: verification.gateCount,
    verifiedGates: verification.verifiedGates,
    methodologyUrl: SCAFFOLD_METHODOLOGY_URL,
  };
}

/** Разворачивает рецепт по id из библиотеки S-4. */
export function scaffoldFromRecipeId(
  id: string,
  targetDir: string,
  options: ScaffoldOptions = {},
): ScaffoldResult {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error("Не указан id рецепта.");
  }
  const recipe = getRecipe(id);
  if (!recipe) {
    throw new Error(`Рецепт «${id}» не найден в библиотеке gate-passed рецептов.`);
  }
  return scaffoldFromRecipe(recipe, targetDir, options);
}
