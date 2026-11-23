// PL-107: qualityGate линтит только файлы из SCOPE задачи.
// agent-steward экспортирует список -Files из afterScript в переменную
// AGENT_STEWARD_GATE_ALLOW_PATHS перед запуском gate-хука. Глобальный
// npm run lint падает на чужих незакоммиченных файлах общего worktree,
// поэтому гейт-task должен проверять только свои файлы:
//   node scripts/lint-task-files.mjs
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const LINTABLE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
const raw = process.env.AGENT_STEWARD_GATE_ALLOW_PATHS?.trim() ?? "";
const declared = raw
  .split("|")
  .map((item) => item.trim().replace(/\\/g, "/"))
  .filter(Boolean);

if (declared.length === 0) {
  console.error(
    "PL-107: AGENT_STEWARD_GATE_ALLOW_PATHS пуст. Укажите -Files в afterScript задачи."
  );
  process.exit(1);
}

const files = declared.filter((file) => LINTABLE.test(file) && fs.existsSync(file));
if (files.length === 0) {
  console.log("PL-107: в SCOPE задачи нет JS/TS-файлов - lint пропущен.");
  process.exit(0);
}

console.log(`PL-107: lint только файлов задачи (${files.length}): ${files.join(", ")}`);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["eslint", "--no-error-on-unmatched-pattern", ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) {
  console.error(`PL-107: не удалось запустить eslint: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
