// P2-12.T3: локализация заголовков `schtasks /query /fo LIST`.
// Раньше таблица покрывала EN/RU/DE/FR/ES/IT/PL, но не ZH — на китайской
// Windows list_tasks возвращал пустые статусы. Проверяем все локали разом.
//
// Запуск: node test-schtasks-locales.mjs (после npm run build).
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { setTaskField } from "./dist/core/scheduler/windows.js";

const cases = [
  // English
  ["Folder", "folder", "\\OpenCode\\windows-scheduler"],
  ["TaskName", "taskName", "Daily"],
  ["Next Run Time", "nextRunTime", "18.11.2026 9:00"],
  ["Status", "status", "Ready"],
  ["Task To Run", "taskToRun", "powershell.exe"],
  // Russian
  ["Папка", "folder", "\\OpenCode"],
  ["Имя задачи", "taskName", "Daily"],
  ["Следующее время запуска", "nextRunTime", "18.11.2026 9:00"],
  ["Состояние", "status", "Готово"],
  ["Команда", "taskToRun", "powershell.exe"],
  // German
  ["Ordner", "folder", "\\OpenCode"],
  ["Aufgabenname", "taskName", "Daily"],
  ["Nächste Ausführungszeit", "nextRunTime", "18.11.2026 9:00"],
  // French
  ["Dossier", "folder", "\\OpenCode"],
  ["Nom de la tâche", "taskName", "Daily"],
  ["État", "status", "Prêt"],
  // Spanish
  ["Carpeta", "folder", "\\OpenCode"],
  ["Nombre de tarea", "taskName", "Daily"],
  ["Estado", "status", "Listo"],
  // Italian
  ["Cartella", "folder", "\\OpenCode"],
  ["Nome attività", "taskName", "Daily"],
  ["Stato", "status", "Pronto"],
  // Polish
  ["Nazwa zadania", "taskName", "Daily"],
  ["Stan", "status", "Gotowe"],
  // Chinese (zh-CN)
  ["文件夹", "folder", "\\OpenCode"],
  ["任务名", "taskName", "Daily"],
  ["任务名称", "taskName", "Daily"],
  ["要运行的任务", "taskToRun", "powershell.exe"],
  ["下次运行时间", "nextRunTime", "2026/11/18 9:00:00"],
  ["下一次运行时间", "nextRunTime", "2026/11/18 9:00:00"],
  ["状态", "status", "就绪"],
  ["登录模式", "logonMode", "交互式"],
  ["登录状态", "logonMode", "交互式"],
  ["上次运行时间", "lastRunTime", "2026/11/17 9:00:00"],
  ["上一次运行时间", "lastRunTime", "2026/11/17 9:00:00"],
  ["上次结果", "lastResult", "0"],
  ["作者", "author", "user"],
  ["注释", "comment", "test"],
];

for (const [key, field, value] of cases) {
  const task = {};
  setTaskField(task, key, value);
  assert.strictEqual(
    task[field],
    value,
    `заголовок «${key}» должен маппиться в ${field}`
  );
}

// V-1: кэш формата даты обязан хранить промис. Иначе параллельные createTask
// (триггеры `once`/file/MCP) видят null и запускают PowerShell по несколько раз.
const windowsSource = await readFile(
  new URL("./src/core/scheduler/windows.ts", import.meta.url),
  "utf8",
);
assert.match(
  windowsSource,
  /let windowsDateFormatCache: Promise<string> \| null = null;/,
  "кэш формата даты должен хранить Promise<string>, а не готовую строку",
);
assert.match(
  windowsSource,
  /windowsDateFormatCache = \(async \(\) => \{/,
  "параллельные вызовы должны кэшировать один и тот же async-результат",
);

console.log(`Schtasks locales: ${cases.length} заголовков (включая ZH) — OK.`);
