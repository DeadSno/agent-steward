// Деталь 3.19 / S-1: открытый spec pipeline.
//
// Проверяем:
//  - преобразование opencode.pipeline.yaml в vendor-neutral DAG/гейты/бюджеты;
//  - наследование defaults, рёбра зависимостей и детерминированность вывода;
//  - публичный экспорт из agent-steward/core;
//  - CLI `pipeline describe` в JSON и человекочитаемом режиме.
//
// Запуск: node test-open-spec.mjs (после npm run build).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname);
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exitCode = 1;
  } else {
    console.log("OK: " + msg);
  }
};

const yaml = `version: 1
name: Open spec demo
description: DAG с объективным гейтом
defaults:
  trigger: dag
  timeoutSeconds: 120
  retryCount: 1
  model: opencode/hy4-flash-free
  allowedTools: [read, shell]
steps:
  - id: build
    trigger: cron
    schedule: "0 3 * * *"
    prompt: Собрать проект
    qualityGate: node -e "process.exit(0)"
  - id: test
    needs: [build]
    prompt: Прогнать тесты
    qualityGate: node test-docs.mjs
    timeoutSeconds: 300
  - id: deploy
    needs: [build, test]
    prompt: Опубликовать артефакт
    deniedTools: [shell]
`;

const { parsePipelineYaml } = await import("./dist/core/pipeline-io.js");
const parsed = parsePipelineYaml(yaml);
assert(parsed.ok, `pipeline валиден (${parsed.errors.map((e) => e.message).join("; ")})`);
assert(Boolean(parsed.spec), "спека получена");
if (!parsed.spec) process.exit(2);

const { OPEN_PIPELINE_FORMAT, OPEN_PIPELINE_SPEC_VERSION, toOpenPipelineSpec } =
  await import("./dist/core/pipeline-open-spec.js");
const open = toOpenPipelineSpec(parsed.spec);

assert(open.format === OPEN_PIPELINE_FORMAT && open.version === "1.0", "формат и версия открытого spec");
assert(open.source.format === "opencode.pipeline.yaml" && open.source.version === 1, "источник spec зафиксирован");
assert(open.dag.nodes.length === 3, "DAG содержит три узла");
assert(open.dag.nodes[0].taskName === "Open spec demo build", "имя задачи по умолчанию сохранено");
assert(open.dag.nodes[0].trigger === "cron", "явный trigger шага не перезаписан defaults");
assert(open.dag.nodes[1].trigger === "dag", "defaults.trigger унаследован");
assert(open.dag.nodes[1].budget.timeoutSeconds === 300, "явный таймаут шага побеждает defaults");
assert(open.dag.nodes[2].budget.timeoutSeconds === 120, "таймаут унаследован из defaults");
assert(open.dag.nodes[2].budget.retries === 1, "повторы унаследованы из defaults");
assert(open.dag.nodes[0].tools.allowed.join(",") === "read,shell", "allowedTools унаследованы");
assert(open.dag.nodes[2].tools.denied.includes("shell"), "deniedTools шага сохранены");
assert(open.gates.length === 2, "только два шага с qualityGate попали в гейты");
assert(open.gates[0].stepId === "build" && open.gates[1].stepId === "test", "гейты в порядке шагов");
assert(open.gates[0].kind === "qualityGate" && open.gates[0].command.includes("process.exit(0)"), "команда гейта сохранена");
assert(open.dag.edges.length === 3, "три ребра зависимостей");
assert(open.dag.edges.some((e) => e.from === "build" && e.to === "test"), "ребро build → test");
assert(open.dag.edges.some((e) => e.from === "test" && e.to === "deploy"), "ребро test → deploy");
assert(open.budgets.steps === 3 && open.budgets.gates === 2, "сводка budgets");
assert(open.budgets.maxTimeoutSeconds === 300, "максимальный таймаут шага");
assert(open.budgets.totalTimeoutSeconds === 540, "суммарный таймаут 120 + 300 + 120");
assert(open.budgets.maxRetries === 1, "максимум повторов");
assert(typeof open.methodologyUrl === "string" && open.methodologyUrl.includes("OPEN-SPEC.md"), "методика рядом с метрикой");

const again = toOpenPipelineSpec(parsed.spec);
assert(JSON.stringify(again) === JSON.stringify(open), "преобразование детерминировано");
assert(!("description" in parsed.spec.steps[0]), "исходная спека не мутирована");

const core = await import("./dist/core-entry.js");
assert(typeof core.toOpenPipelineSpec === "function", "публичный экспорт из agent-steward/core");
assert(core.OPEN_PIPELINE_FORMAT === "agent-steward.open-pipeline", "константа формата доступна публично");
assert(typeof core.parsePipelineYaml === "function", "парсер YAML доступен публично");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sched-open-spec-"));
const yamlPath = path.join(tempRoot, "opencode.pipeline.yaml");
fs.writeFileSync(yamlPath, yaml, "utf8");
try {
  const json = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "pipeline", "describe", yamlPath, "--json"], {
    encoding: "utf8",
    cwd: root,
  });
  assert(json.status === 0, `CLI describe --json exit 0 (${json.stderr.slice(0, 200)})`);
  const fromCli = JSON.parse(json.stdout);
  assert(fromCli.format === OPEN_PIPELINE_FORMAT && fromCli.dag.nodes.length === 3, "CLI вернул открытый spec");

  const human = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "pipeline", "describe", yamlPath], {
    encoding: "utf8",
    cwd: root,
  });
  assert(human.status === 0 && human.stdout.includes("DAG: 3 узлов"), "CLI describe печатает сводку");

  const missing = spawnSync(process.execPath, [path.join(root, "dist/cli.js"), "pipeline", "describe", path.join(tempRoot, "missing.yaml")], {
    encoding: "utf8",
    cwd: root,
  });
  assert(missing.status === 1, "несуществующий файл даёт exit 1");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
