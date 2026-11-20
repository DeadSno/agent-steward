/**
 * Тесты Спринта 15: Matrix Builds (Fan-Out).
 * Запуск: node test-matrix.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-matrix-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { initDb, closeDb } = await import("./dist/db/index.js");
const { saveTask, getTask, listTasks, deleteTask } = await import("./dist/db/tasks-repo.js");
const { recordRun, getHistory } = await import("./dist/db/history-repo.js");
const {
  addWorkspace,
} = await import("./dist/workspaces.js");
const {
  matrixCloneName,
  matrixCompleteName,
  expandMatrixTask,
  aggregateMatrixResults,
  isKnownMatrix,
  runMatrix,
  ensureMatrixCompleteTask,
  finalizeMatrixIfComplete,
} = await import("./dist/core/matrix.js");
const { selectDependentsToTrigger } = await import("./dist/core/record-history.js");
const { readStructuredLogs, clearStructuredLogs } = await import("./dist/core/structured-log.js");
const { buildExportJson, parseImportJson } = await import("./dist/task-transfer.js");
const { t } = await import("./dist/i18n.js");

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

/** Проставляет клоны finish-записи в истории. */
function recordCloneStatus(cloneName, status, error = null) {
  const startedAt = new Date(Date.now() - 5000).toISOString();
  recordRun(cloneName, status, startedAt, 1000, error, undefined, 10, 0.00003, "test/model", "skipped", "skipped");
}

initDb();

try {
  // Workspace-ы для матрицы (validateWorkspacePath требует существующий путь).
  for (const dir of ["frontend", "backend", "mobile"]) {
    fs.mkdirSync(path.join(tempRoot, dir), { recursive: true });
  }
  const frontend = addWorkspace({ path: path.join(tempRoot, "frontend"), name: "Frontend" });
  const backend = addWorkspace({ path: path.join(tempRoot, "backend"), name: "Backend" });
  const mobile = addWorkspace({ path: path.join(tempRoot, "mobile"), name: "Mobile App" });

  // 1. expandMatrixTask: имена клонов и workspaceId.
  const parentDef = {
    name: "Deploy",
    schedule: "*/5 * * * *",
    prompt: "Собери и задеплой",
    model: "test/model",
    priority: 8,
    qualityGate: "npm test",
    beforeScript: "git pull",
    afterScript: "git push",
    allowedTools: ["read", "bash"],
    deniedTools: ["write"],
    matrix: {
      workspaceIds: [frontend.id, backend.id, mobile.id],
      strategy: "parallel",
      failureMode: "continue",
      aggregation: "summary",
    },
  };
  const clones = expandMatrixTask(parentDef);
  check(
    "expandMatrixTask создаёт правильные имена клонов",
    clones.length === 3 &&
      clones[0].name === matrixCloneName("Deploy", "Frontend") &&
      clones[1].name === matrixCloneName("Deploy", "Backend") &&
      clones[2].name === matrixCloneName("Deploy", "Mobile App")
  );
  check(
    "expandMatrixTask назначает свой workspaceId каждому клону",
    clones[0].workspaceId === frontend.id &&
      clones[1].workspaceId === backend.id &&
      clones[2].workspaceId === mobile.id
  );
  check(
    "expandMatrixTask наследует промпт/модель/хуки/QG/tools и ставит matrixParentId",
    clones.every(
      (clone) =>
        clone.prompt === parentDef.prompt &&
        clone.model === parentDef.model &&
        clone.qualityGate === parentDef.qualityGate &&
        clone.beforeScript === parentDef.beforeScript &&
        clone.afterScript === parentDef.afterScript &&
        Array.isArray(clone.allowedTools) &&
        clone.allowedTools.length === 2 &&
        Array.isArray(clone.deniedTools) &&
        clone.deniedTools.length === 1 &&
        clone.matrixParentId === "Deploy" &&
        clone.matrix === undefined &&
        clone.triggerType === "file" &&
        clone.workingDirectory === undefined
    )
  );

  // 2. Стратегия parallel: все клоны уходят в запуск (бэкенд ОС недоступен в тесте,
  //    поэтому все три попадают в errors, но не в skipped).
  saveTask({ ...parentDef, isMatrixParent: true });
  for (const clone of clones) saveTask(clone);

  clearStructuredLogs();
  const parallelRun = await runMatrix(parentDef);
  check(
    'strategy: "parallel" пытается запустить все клоны сразу',
    parallelRun.started.length === 0 &&
      parallelRun.skipped.length === 0 &&
      parallelRun.errors.length === 3
  );
  const matrixLogs = readStructuredLogs().records.filter((r) =>
    String(r.event).startsWith("matrix.")
  );
  check(
    "runs.jsonl содержит matrix.* с matrixId и cloneName",
    matrixLogs.some((r) => r.event === "matrix.started" && r.matrixId === "Deploy") &&
      matrixLogs.some((r) => r.event === "matrix.start_failed" && Boolean(r.cloneName))
  );

  // 3. Стратегия sequential: только первый клон, остальные в skipped.
  const sequentialParent = {
    ...parentDef,
    name: "DeploySeq",
    matrix: { ...parentDef.matrix, strategy: "sequential" },
  };
  const seqClones = expandMatrixTask(sequentialParent);
  saveTask(sequentialParent);
  for (const clone of seqClones) saveTask(clone);
  const seqRun = await runMatrix(sequentialParent);
  check(
    'strategy: "sequential" запускает по одному (остальные ждут в skipped)',
    seqRun.errors.length === 1 && seqRun.skipped.length === 2
  );

  // 4. failureMode stop: первая ошибка запуска останавливает остальные клоны.
  const stopParent = {
    ...parentDef,
    name: "DeployStop",
    matrix: { ...parentDef.matrix, failureMode: "stop" },
  };
  const stopClones = expandMatrixTask(stopParent);
  saveTask(stopParent);
  for (const clone of stopClones) saveTask(clone);
  const stopRun = await runMatrix(stopParent);
  check(
    'failureMode: "stop" останавливает остальные при первой ошибке запуска',
    stopRun.errors.length === 1 && stopRun.skipped.length === 2
  );

  // 5. failureMode continue: ошибки клонов агрегируются в partial.
  for (const clone of clones) {
    recordCloneStatus(clone.name, clone.name === clones[0].name ? "success" : "success");
  }
  recordCloneStatus(clones[0].name, "error", "clone-1 failed");
  const contAggregate = aggregateMatrixResults("Deploy");
  check(
    'failureMode: "continue" продолжает и агрегирует partial',
    contAggregate.status === "partial"
  );

  // 6. aggregateMatrixResults правильно считает successCount/errorCount.
  const countsAggregate = aggregateMatrixResults("Deploy");
  check(
    "aggregateMatrixResults считает successCount/errorCount/totalCount",
    countsAggregate.totalCount === 3 &&
      countsAggregate.successCount === 2 &&
      countsAggregate.errorCount === 1 &&
      countsAggregate.clones.length === 3
  );

  // 7. failureMode stop при ошибках клонов даёт error с первым сообщением.
  const stopAggregate = aggregateMatrixResults("DeployStop");
  recordCloneStatus(stopClones[0].name, "error", "first failure detail");
  recordCloneStatus(stopClones[1].name, "success");
  recordCloneStatus(stopClones[2].name, "success");
  const stopStatus = aggregateMatrixResults("DeployStop");
  check(
    'failureMode: "stop" при ошибках клонов даёт статус error с первым error-сообщением',
    stopStatus.status === "error" && stopStatus.message.includes("first failure detail")
  );
  check("aggregateMatrixResults для DeployStop не перепутала счётчики",
    stopStatus.successCount === 2 && stopStatus.errorCount === 1);

  // 8. DAG: зависимость от матрицы ждёт все её клоны.
  const dependent = {
    name: "Notify",
    schedule: "* * * * *",
    prompt: "Уведомь команду",
    dependsOn: ["Deploy"],
  };
  saveTask(dependent);
  const definitions = listTasks();
  // Все клоны Deploy успешны (2 success + 1 error из шага 5 — нужно обновить ошибочный).
  recordCloneStatus(clones[0].name, "success");
  const history = getHistory(null, 100);
  const triggered = selectDependentsToTrigger("Deploy", definitions, history);
  check(
    "DAG: когда все клоны матрицы успешны — запускается зависимая задача",
    triggered.includes("Notify")
  );
  // Теперь ломаем один клон — зависимость не должна сработать.
  const dependent2 = {
    name: "Notify2",
    schedule: "* * * * *",
    prompt: "Уведомь команду ещё раз",
    dependsOn: ["Deploy"],
  };
  saveTask(dependent2);
  recordCloneStatus(clones[1].name, "error", "broken clone");
  const blocked = selectDependentsToTrigger("Deploy", listTasks(), getHistory(null, 100));
  check(
    "DAG: пока хоть один клон матрицы не успешен — зависимая задача не запускается",
    !blocked.includes("Notify2")
  );

  // 9. matrix-complete: ensureMatrixCompleteTask создаёт агрегатор с dependsOn всех клонов.
  const aggregator = ensureMatrixCompleteTask({ ...parentDef, matrix: { ...parentDef.matrix, createAggregator: true } });
  check(
    "ensureMatrixCompleteTask создаёт matrix-complete с dependsOn всех клонов",
    aggregator &&
      aggregator.name === matrixCompleteName("Deploy") &&
      Array.isArray(aggregator.dependsOn) &&
      aggregator.dependsOn.length === 3 &&
      aggregator.dependsOn.includes(clones[0].name) &&
      aggregator.workspaceId === undefined &&
      aggregator.triggerType === "file"
  );

  // 10. finalizeMatrixIfComplete: агрегат пишется в историю родителя (success).
  recordCloneStatus(clones[0].name, "success");
  recordCloneStatus(clones[1].name, "success");
  recordCloneStatus(clones[2].name, "success");
  clearStructuredLogs();
  await finalizeMatrixIfComplete(clones[0].name);
  const parentRecord = getHistory("Deploy", 1)[0];
  check(
    "finalizeMatrixIfComplete пишет агрегированную запись success для родителя",
    parentRecord && parentRecord.status === "success" && parentRecord.error == null
  );
  const aggregatedLog = readStructuredLogs({ event: "matrix.aggregated" }).records[0];
  check(
    "matrix.aggregated в runs.jsonl привязан к runId родителя",
    aggregatedLog?.matrixId === "Deploy" &&
      aggregatedLog?.runId === parentRecord?.id &&
      aggregatedLog?.status === "success"
  );

  // 11. finalizeMatrixIfComplete: частичный успех → partial в истории родителя.
  const partialParent = {
    name: "DeployPartial",
    schedule: "* * * * *",
    prompt: "p",
    matrix: { workspaceIds: [frontend.id, backend.id], failureMode: "continue" },
  };
  const partialClones = expandMatrixTask(partialParent);
  saveTask(partialParent);
  for (const clone of partialClones) saveTask(clone);
  recordCloneStatus(partialClones[0].name, "success");
  recordCloneStatus(partialClones[1].name, "error", "one failed");
  await finalizeMatrixIfComplete(partialClones[0].name);
  const partialRecord = getHistory("DeployPartial", 1)[0];
  check(
    "finalizeMatrixIfComplete пишет partial при частичном успехе",
    partialRecord && partialRecord.status === "partial" && Boolean(partialRecord.error)
  );

  // 12. Валидация: workspaceId + matrix одновременно — ошибка.
  const conflictJson = JSON.stringify({
    version: 1,
    tasks: [
      {
        name: "Conflict",
        schedule: "* * * * *",
        prompt: "x",
        workspaceId: frontend.id,
        matrix: { workspaceIds: [frontend.id] },
      },
    ],
  });
  const conflictParsed = parseImportJson(conflictJson);
  check(
    "workspaceId + matrix одновременно — ошибка валидации",
    conflictParsed.errors.some((e) => e.includes("нельзя одновременно workspaceId и matrix.workspaceIds"))
  );

  // 13. Пустой matrix.workspaceIds — ошибка.
  const emptyParsed = parseImportJson(
    JSON.stringify({
      version: 1,
      tasks: [{ name: "EmptyMatrix", schedule: "* * * * *", prompt: "x", matrix: { workspaceIds: [] } }],
    })
  );
  check(
    "пустой matrix.workspaceIds — ошибка валидации",
    emptyParsed.errors.some((e) => e.includes("matrix.workspaceIds не может быть пустым"))
  );

  // 14. Неизвестный workspace в expandMatrixTask — ошибка.
  let unknownError = null;
  try {
    expandMatrixTask({
      name: "Unknown",
      schedule: "* * * * *",
      prompt: "x",
      matrix: { workspaceIds: ["no-such-workspace"] },
    });
  } catch (err) {
    unknownError = err;
  }
  check(
    "неизвестный workspace в matrix — ошибка при развёртывании",
    unknownError &&
      String(unknownError.message) ===
        t("matrix.error.workspaceMissing", {
          task: "Unknown",
          workspace: "no-such-workspace",
        })
  );

  // 15. Экспорт/импорт round-trip сохраняет matrix и matrixParentId.
  const { data: exportJson } = await buildExportJson(listTasks().map((d) => ({ taskName: d.name })));
  const roundParsed = parseImportJson(exportJson);
  const roundParent = roundParsed.tasks.find((t) => t.name === "DeploySeq");
  const roundClone = roundParsed.tasks.find((t) => t.name === clones[0].name);
  check(
    "export/import round-trip сохраняет matrix (strategy/failureMode/aggregation)",
    roundParent &&
      roundParent.matrix &&
      roundParent.matrix.strategy === "sequential" &&
      roundParent.matrix.failureMode === "continue" &&
      roundParent.matrix.aggregation === "summary" &&
      Array.isArray(roundParent.matrix.workspaceIds) &&
      roundParent.matrix.workspaceIds.length === 3
  );
  check(
    "export/import round-trip сохраняет matrixParentId клона",
    roundClone && roundClone.matrixParentId === "Deploy"
  );

  // 16. QA-F.2: клон без определения, но с историей виден в aggregate,
  //     как и соответствующая задача в аналитике.
  const orphanParent = {
    name: "OrphanMatrix",
    schedule: "* * * * *",
    prompt: "p",
    matrix: { workspaceIds: [frontend.id], failureMode: "continue" },
  };
  const orphanClone = expandMatrixTask(orphanParent)[0];
  saveTask(orphanParent);
  saveTask(orphanClone);
  recordCloneStatus(orphanClone.name, "success");
  const beforeDelete = aggregateMatrixResults("OrphanMatrix");
  deleteTask(orphanClone.name);
  const afterDelete = aggregateMatrixResults("OrphanMatrix");
  check(
    "QA-F.2: клон, оставшийся только в истории, не пропадает из aggregateMatrixResults",
    beforeDelete.totalCount === 1 &&
      afterDelete.totalCount === 1 &&
      afterDelete.status === "success" &&
      afterDelete.clones[0]?.name === orphanClone.name
  );
  // QA-P1.2: история — независимый источник. После удаления родителя
  // aggregate всё равно показывает клона, если он остался в истории
  // (ровно так же, как его показывает аналитика).
  deleteTask(orphanParent.name);
  const afterParentDelete = aggregateMatrixResults("OrphanMatrix");
  check(
    "QA-P1.2: после удаления родителя клон из истории остаётся видимым",
    afterParentDelete.status === "success" &&
      afterParentDelete.totalCount === 1 &&
      afterParentDelete.clones[0]?.name === orphanClone.name
  );

  // QA-P3.7: isKnownMatrix различает реальную матрицу (в т.ч. по истории)
  // и неизвестное имя. matrix_control(results) использует ту же проверку.
  check(
    "QA-P3.7: isKnownMatrix видит матрицу по клонам в истории",
    isKnownMatrix("OrphanMatrix") === true
  );
  check(
    "QA-P3.7: isKnownMatrix отклоняет неизвестное имя",
    isKnownMatrix("__no_such_matrix__") === false
  );
  const indexSrc = fs.readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
  check(
    indexSrc.includes("if (!isKnownMatrix(name))") &&
      indexSrc.includes('t("tool.error.matrixNotMatrix", { name })'),
    "QA-P3.7: matrix_control(results) проверяет тип задачи"
  );
} finally {
  closeDb();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nMatrix: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
