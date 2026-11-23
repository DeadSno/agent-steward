/**
 * Dry-Run (Спринт 14): симуляция конвейера задачи без реального запуска.
 *
 * Строит топологический порядок зависимостей, показывает фактические команды,
 * cwd, роли (ограничения инструментов) и оценки по последним запускам.
 * Никогда не исполняет команды — только анализ определений.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadTaskDefinitions } from "../task-transfer.js";
import { getHistory } from "../db/history-repo.js";
import { getWorkspace } from "../workspaces.js";
import { expandMatrixTask } from "./matrix.js";
import { nextRun, activeWindowState, assessCronWindowFeasibility, needsPollMode, windowFeasibilityReasonText } from "./schedule-v2.js";
import { checkGitTrigger } from "./git-trigger.js";
import { t } from "../i18n.js";
import type { TaskDefinition } from "../task-transfer.js";

/**
 * QV-9: cron срабатывает чаще, чем раз в 5 минут, круглосуточно.
 * Поддерживаются `* * * * *`, каждый N-ю минуту (N <= 5) и списки минут с
 * минимальным циклическим шагом <= 5. Часовой/дневной фильтр означает,
 * что задача не является «постоянным опросом» и отдельно не предупреждается.
 */
export function isFrequentCron(schedule: string): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return false;
  const [minute, hour, dom, month, dow] = parts;
  if (hour !== "*" || dom !== "*" || month !== "*" || dow !== "*") return false;
  if (minute === "*") return true;
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) return Number(step[1]) <= 5;
  const minutes = minute.split(",").map((m) => Number(m));
  if (minutes.length > 1 && minutes.every((n) => Number.isInteger(n) && n >= 0 && n < 60)) {
    const sorted = [...minutes].sort((a, b) => a - b);
    let minStep = 60 - sorted[sorted.length - 1] + sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      minStep = Math.min(minStep, sorted[i] - sorted[i - 1]);
    }
    return minStep <= 5;
  }
  return false;
}

/**
 * PL-49: минимальный интервал срабатывания cron в минутах для простых
 * выражений. Возвращает null, если интервал нельзя надёжно вывести.
 */
export function minimumCronIntervalMinutes(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  if (hour !== "*" || dom !== "*" || month !== "*" || dow !== "*") return null;
  if (minute === "*") return 1;
  const step = /^\*\/(\d+)$/.exec(minute);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 && n <= 60 ? n : null;
  }
  const minutes = minute.split(",").map((m) => Number(m));
  if (minutes.length > 1 && minutes.every((n) => Number.isInteger(n) && n >= 0 && n < 60)) {
    const sorted = [...minutes].sort((a, b) => a - b);
    let minStep = 60 - sorted[sorted.length - 1] + sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      minStep = Math.min(minStep, sorted[i] - sorted[i - 1]);
    }
    return minStep;
  }
  return null;
}

export interface DryRunRoleScoped {
  allowed?: string[];
  denied?: string[];
}

/**
 * Детали триггера (Спринт 27): чем задача запускается и не будет ли запуск
 * пропущен из-за окна/дней недели. Для git-триггера — состояние репозитория.
 */
export interface DryRunTriggerDetails {
  type: "manual" | "cron" | "file" | "git" | "mcp-event" | "once";
  /** Человекочитаемое объяснение условия запуска. */
  explanation: string;
  /** PL-50: cron не expressible в schtasks — ОС опрашивает его каждую минуту. */
  polling?: boolean;
  /** Состояние окна запуска и разрешённых дней недели (если заданы). */
  activeWindow?: {
    active: boolean;
    reason?: string;
    nextOpenAt: string | null;
  };
  /** Состояние git-триггера на момент dry-run. */
  git?: {
    branch: string | null;
    head: string | null;
    lastCommit: string | null;
    changedFiles: string[];
    matched: string[];
  };
  /** Настройки файлового триггера. */
  file?: {
    watchPath: string | null;
    globs: string[];
    ignore: string[];
  };
}

export interface DryRunTaskItem {
  name: string;
  order: number;
  /** PL-26/PL-30: реальный triggerType definition (совпадает с triggerDetails.type). */
  trigger: DryRunTriggerDetails["type"];
  /** Как задача попала в симуляцию: manual — корень, dag — через dependsOn. */
  entryMode: "manual" | "dag";
  cwd: string;
  command: string;
  workspace?: { name: string; path: string };
  preFlight?: string | null;
  postFlight?: string | null;
  qualityGate?: string | null;
  roleScoped?: DryRunRoleScoped | null;
  estimatedDurationSec?: number | null;
  estimatedCostUsd?: number | null;
  estimatedTokens?: number | null;
  /** Для клона матрицы — имя родителя-шаблона (Спринт 15). */
  matrixParent?: string;
  /** Режим сессии OpenCode (Спринт 24): new (по умолчанию), reuse, last. */
  session?: string | null;
  /** Идентификатор переиспользуемой сессии (только для session=reuse). */
  sessionId?: string | null;
  /**
   * Windows-режим входа (Спринт 27.5.4): false — задача интерактивная и идёт
   * только при активном входе пользователя (Interactive only); true — запуск
   * без входа через `/ru SYSTEM` (session 0, без профиля пользователя).
   * На Linux/macOS поле всегда false: cron работает без входа, launchd-агент —
   * только при входе.
   */
  runWhenLoggedOff?: boolean;
  /** Человекочитаемое пояснение к режиму входа (для отчёта dry-run). */
  logonMode?: string | null;
  /**
   * Эффективное расписание cron-задачи (Спринт 19): пояс, окно запуска и
   * ближайшие срабатывания с учётом часового пояса. Позволяет проверить
   * пересчёт cron до регистрации в ОС.
   */
  scheduleDetails?: {
    cron: string;
    timezone: string | null;
    notBefore: string | null;
    notAfter: string | null;
    pausedUntil: string | null;
    nextRuns: string[];
  };
  /** Детали триггера и причина возможного пропуска (Спринт 27). */
  triggerDetails?: DryRunTriggerDetails;
}

export interface DryRunTotals {
  estimatedDurationSec?: number | null;
  estimatedCostUsd?: number | null;
  estimatedTokens?: number | null;
}

export interface DryRunReport {
  success: boolean;
  taskName: string;
  tasks: DryRunTaskItem[];
  totals: DryRunTotals;
  warnings: string[];
}

/** Сколько последних успешных/любых запусков усредняем для оценки. */
const ESTIMATE_SAMPLE = 10;

/** Средняя цена за 1K токенов (должна совпадать с dashboards/server.ts). */
export const ESTIMATED_COST_PER_1K_TOKENS_USD = 0.003;

/**
 * PL-64: кириллица и CJK в одном промпте — типичный артефакт машинного
 * перевода/копипасты («报告和 run статус» в ARCH-6). Проверяем именно
 * СМЕШИВАНИЕ: чисто китайские, японские, корейские и чисто русские промпты
 * остаются допустимыми локалями и предупреждения не дают.
 */
const CYRILLIC_SCRIPT_RE = /\p{Script=Cyrillic}/u;
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;

/** PL-64: возвращает текст предупреждения или null, если скрипты не смешаны. */
export function mixedScriptPromptWarning(prompt: string): string | null {
  if (
    typeof prompt !== "string" ||
    !CYRILLIC_SCRIPT_RE.test(prompt) ||
    !CJK_SCRIPT_RE.test(prompt)
  ) {
    return null;
  }
  return (
    "PL-64: промпт содержит смешанные скрипты — CJK (иероглифы/кана/хангыль) и кириллицу в одном тексте. " +
    "Это обычно машинный перевод или копипаста; проверьте язык промпта до запуска. " +
    "Чисто китайские, японские, корейские и чисто русские промпты не затрагиваются."
  );
}

/** Опасные паттерны, о которых обязательно предупреждаем (ключи каталога). */
const DANGEROUS_PATTERNS: { test: RegExp; messageKey: string }[] = [
  { test: /rm\s+-rf\s+\/(?:\s|$)/, messageKey: "dryRun.danger.rmRoot" },
  { test: /git\s+push\s+.*--force(?:\s|$)/, messageKey: "dryRun.danger.forcePush" },
];

/**
 * PL-2.2: команды самопроверки, которые агент не выполнит без инструмента
 * shell. Если они есть в промпте, а shell запрещён, агент получает tool.blocked
 * и рапортует об «успешной проверке», ничего не проверив.
 *
 * PL-55: ищем именно повелительные команды и явные команды (в backticks,
 * отдельной строкой, после приглашения). Простое упоминание «тестов/results»
 * в описании — например, «результаты тестов GitHub Actions» — предупреждением
 * не считается. Кириллические паттерны используют Unicode-lookahead вместо \b:
 * в JS \b построен на ASCII-\w и с кириллицей не работает.
 */
const SELF_CHECK_PATTERNS: readonly RegExp[] = [
  // Повелительные команды: «run npm test», «run pytest», «run node check.js».
  /\brun\s+(?:npm\s+(?:test|run\s+[\w-]*test[\w-]*)|pytest|go\s+test|dotnet\s+test)\b/i,
  /\brun\s+node(?:\.exe)?\s+\S/i,
  // «выполни [команду] npm test», «запусти pytest», «прогони dotnet test».
  /(?:выполни|запусти|прогони)\s+(?:команду\s+)?npm\s+(?:test|run\s+[\w-]*test[\w-]*)\b/iu,
  /(?:выполни|запусти|прогони)\s+(?:команду\s+)?(?:pytest|go\s+test|dotnet\s+test)\b/iu,
  // «запусти тесты», «проверь себя».
  /запусти\s+(?:тесты|тест|проверки|проверку)(?![\p{L}\p{N}])/iu,
  /проверь\s+себя(?![\p{L}\p{N}])/iu,
  // Явная команда в backticks: `npm test`, `pytest`.
  /`\s*(?:npm\s+(?:test|run\s+[\w-]*test[\w-]*)|pytest|go\s+test|dotnet\s+test)\s*`/i,
  // Явная команда отдельной строкой или после приглашения: $ npm test, > pytest.
  /(?:^|[\r\n]|\$\s*|>\s*)\s*(?:npm\s+(?:test|run\s+[\w-]*test[\w-]*)|pytest|go\s+test|dotnet\s+test)\b/im,
];

/** PL-2.2: эффективный запрет shell с учётом legacy-режима и политик. */
function shellIsForbidden(def: TaskDefinition): boolean {
  if (def.legacyShell === true) return false;
  const isShell = (tool: string): boolean => /^(?:shell|bash)$/i.test(tool.trim());
  const allowed = Array.isArray(def.allowedTools) ? def.allowedTools : [];
  const denied = Array.isArray(def.deniedTools) ? def.deniedTools : [];
  if (allowed.length > 0) return !allowed.some(isShell);
  if (denied.length > 0) return denied.some(isShell);
  // Политика hybrid по умолчанию запрещает shell (см. SKILL.md §4).
  return true;
}

/**
 * PL-5.1: цепочка и DAG могут указывать на один и тот же переход. Тогда при
 * завершении шага он будет запущен дважды: как chainTarget и как зависимый.
 * Возвращаем имя конфликтующей задачи или null. Fail-open: нет данных — тишина.
 */
function findChainDagOverlap(
  def: TaskDefinition,
  allDefs: TaskDefinition[],
): string | null {
  const next = (def.nextTaskOnSuccess ?? "").trim();
  if (!next) return null;
  const nextLower = next.toLowerCase();

  // Случай 1: преемник прямо перечислен в dependsOn текущей задачи.
  if (
    (def.dependsOn ?? []).some(
      (dep) => (dep ?? "").trim().toLowerCase() === nextLower,
    )
  ) {
    return next;
  }

  // Случай 2 (типичная линейная цепочка): преемник сам зависит от текущей.
  const nextDef = allDefs.find((d) => d.name.toLowerCase() === nextLower);
  if (
    nextDef &&
    (nextDef.dependsOn ?? []).some(
      (dep) => (dep ?? "").trim().toLowerCase() === def.name.toLowerCase(),
    )
  ) {
    return next;
  }
  return null;
}

/**
 * PL-8.1: рабочая директория могла уйти вперёд с момента постановки задачи —
 * Quality Gate тогда проверяет уже другой код (расхождение счётчиков и т.п.).
 * Сравниваем время HEAD-коммита с createdAt задачи. Fail-open: нет git, нет
 * даты или команда недоступна — предупреждения нет.
 */
export function workingDirectoryDriftWarning(def: TaskDefinition, cwd: string): string | null {
  if (!def.createdAt || !cwd) return null;
  const created = new Date(def.createdAt).getTime();
  if (!Number.isFinite(created)) return null;
  try {
    const headIso = execFileSync("git", ["log", "-1", "--format=%cI"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    const headTime = new Date(headIso).getTime();
    if (!Number.isFinite(headTime) || headTime <= created) return null;
    return (
      `PL-8.1: рабочая директория ушла вперёд с момента постановки задачи (${def.createdAt}); ` +
      `HEAD датирован ${headIso}. Quality Gate может упасть на чужих правках. ` +
      "Зафиксируйте commit, на котором гейт считается валидным (например, проверьте HEAD внутри qualityGate), " +
      "или используйте изолированный worktree."
    );
  } catch {
    return null;
  }
}

/**
 * Свойства для описания триггера задачи в dry-run (Спринт 27).
 */
interface DescribeTriggerOptions {
  /** Задание задачи (может содержать новые поля Спринта 27). */
  def: TaskDefinition;
  /** Эффективная рабочая директория задачи. */
  cwd: string;
  /** Вычисляемый тип триггера для поля `trigger`. */
  triggerType: string;
  /** Куда накапливать предупреждения (префикс [task] добавится в цикле). */
  warnings: string[];
}

/**
 * Описывает триггер задачи: что запускает задачу, не будет ли запуск
 * пропущен из-за окна/дней недели, и (для git) состояние репозитория.
 * Не имеет побочных эффектов (для git используется persist: false).
 */
async function describeTrigger(opts: DescribeTriggerOptions): Promise<DryRunTriggerDetails> {
  const { def, cwd, triggerType, warnings } = opts;
  const policy: "skip" | "postpone" | "run" = def.windowPolicy ?? "postpone";

  const base: DryRunTriggerDetails = {
    type: triggerType as DryRunTriggerDetails["type"],
    explanation: "",
  };

  const hasWindow = Boolean((def.notBefore ?? "").trim() || (def.notAfter ?? "").trim());
  const hasDays = Array.isArray(def.activeDays) && def.activeDays.length > 0;

  switch (triggerType) {
    case "git": {
      try {
        const result = await checkGitTrigger(
          {
            name: def.name,
            cwd,
            branch: def.gitBranch ?? undefined,
            paths: def.gitPaths ?? undefined,
            ignore: def.gitIgnore ?? undefined,
          },
          { persist: false },
        );
        base.git = {
          branch: result.branch ?? null,
          head: result.head ?? null,
          lastCommit: result.from ?? null,
          changedFiles: result.files,
          matched: result.matched,
        };
        base.explanation = result.message;

        if (result.status === "no-repo") {
          warnings.push(t("dryRun.git.notRepo"));
        } else if (result.status === "branch-mismatch") {
          warnings.push(
            t("dryRun.git.branchMismatch", { branch: def.gitBranch ?? "" }),
          );
        }
      } catch (err: unknown) {
        base.explanation = t("dryRun.git.checkError", {
          error: err instanceof Error ? err.message : String(err),
        });
        warnings.push(base.explanation);
      }
      break;
    }

    case "file": {
      base.file = {
        watchPath: def.watchPath ?? null,
        globs: Array.isArray(def.watchGlobs) ? def.watchGlobs : [],
        ignore: Array.isArray(def.watchIgnore) ? def.watchIgnore : [],
      };
      const parts: string[] = [];
      if (def.watchPath) parts.push(`«${def.watchPath}»`);
      if (def.watchGlobs?.length)
        parts.push(t("dryRun.file.globs", { count: def.watchGlobs.length }));
      if (def.watchIgnore?.length)
        parts.push(t("dryRun.file.ignore", { count: def.watchIgnore.length }));
      base.explanation =
        parts.length > 0
          ? t("dryRun.file.trigger", { parts: parts.join("; ") })
          : t("dryRun.file.any");
      break;
    }

    case "mcp-event": {
      const ev = def.mcpEvent;
      base.explanation = ev?.event
        ? t("dryRun.mcp.event", {
          server: ev.server,
          event: ev.event,
          filter: ev.filter
            ? t("dryRun.mcp.filter", { filter: ev.filter })
            : "",
        })
        : t("dryRun.mcp.missing");
      break;
    }

    case "cron": {
      base.explanation = def.timezone
        ? t("dryRun.cronTimezone", {
          schedule: def.schedule,
          timezone: def.timezone,
        })
        : t("dryRun.cron", { schedule: def.schedule });
      // PL-50: показываем, что расписание не зарегистрировано напрямую
      // в schtasks, а проверяется минутным poll с schedule gate в обёртке.
      if (def.schedule && needsPollMode(def.schedule, def.timezone ?? undefined)) {
        base.polling = true;
      }
      break;
    }

    case "once": {
      base.explanation = def.runAt
        ? t("dryRun.once.at", { runAt: def.runAt })
        : t("dryRun.once");
      break;
    }

    case "manual":
    default: {
      base.explanation = t("dryRun.manual");
      break;
    }
  }

  // Окно запуска и дни недели (если заданы).
  if (hasWindow || hasDays) {
    const state = activeWindowState(new Date(), {
      notBefore: def.notBefore ?? undefined,
      notAfter: def.notAfter ?? undefined,
      days: def.activeDays ?? undefined,
      timeZone: def.timezone ?? undefined,
    });
    base.activeWindow = {
      active: state.active,
      ...(state.reason ? { reason: state.reason } : {}),
      nextOpenAt: state.nextOpenAt ? state.nextOpenAt.toISOString() : null,
    };

    if (!state.active && policy !== "run") {
      const reason = state.reason ?? t("dryRun.window.outside");
      if (policy === "skip") {
        warnings.push(t("dryRun.window.skip", { reason }));
      } else {
        // postpone — переносим на ближайшее открытие.
        const iso = base.activeWindow.nextOpenAt ?? null;
        warnings.push(
          iso
            ? t("dryRun.window.postpone", { reason, nextOpenAt: iso })
            : t("dryRun.window.noOpening", { reason }),
        );
      }
    } else if (!state.active && policy === "run") {
      warnings.push(
        t("dryRun.window.run", {
          reason: state.reason ?? t("dryRun.window.outside"),
        }),
      );
    }

    // P2-24: даже если сейчас окно откроется, cron может никогда в него не
    // попадать (например, daily 09:00 при окне 22:00–06:00). Предупреждаем
    // заранее — иначе задача молча не выполняется из-за лимита переноса 12 ч.
    if ((def.triggerType ?? "cron") === "cron" && def.schedule) {
      const feasibility = assessCronWindowFeasibility(
        def.schedule,
        {
          notBefore: def.notBefore ?? undefined,
          notAfter: def.notAfter ?? undefined,
          days: def.activeDays ?? undefined,
          timeZone: def.timezone ?? undefined,
        },
        policy,
      );
      if (!feasibility.feasible) {
        warnings.push(
          t("dryRun.window.unreachable", {
            cron: def.schedule,
            reason: windowFeasibilityReasonText(feasibility.reason),
          }),
        );
      }
    }
  }

  return base;
}

/**
 * Симулирует конвейер задачи: сама задача + все зависимости (dependsOn)
 * в топологическом порядке. Возвращает отчёт без реального запуска.
 */
export async function simulatePipeline(taskName: string): Promise<DryRunReport> {
  const warnings: string[] = [];

  const allDefs = await loadTaskDefinitions();
  const rootLower = taskName.trim().toLowerCase();
  const root = allDefs.find((d) => d.name.toLowerCase() === rootLower);
  if (!root) {
    throw new Error(t("dryRun.taskNotFound", { task: taskName }));
  }

  // Собираем подграф зависимостей рекурсивно, обнаруживая циклы.
  const byLower = new Map<string, TaskDefinition>(allDefs.map((d) => [d.name.toLowerCase(), d]));
  const visited = new Map<string, TaskDefinition>(); // lower -> def
  const visiting = new Set<string>();
  const warningsPerTask = new Map<string, string[]>();

  const collect = (lowerName: string): TaskDefinition | undefined => {
    if (visiting.has(lowerName)) {
      const list = warningsPerTask.get(lowerName) ?? [];
      list.push(t("dryRun.cycle", { task: lowerName }));
      warningsPerTask.set(lowerName, list);
      return undefined;
    }
    const cached = visited.get(lowerName);
    if (cached) return cached;
    const def = byLower.get(lowerName);
    if (!def) {
      const list = warningsPerTask.get(lowerName) ?? [];
      list.push(t("dryRun.dependencyMissing", { task: lowerName }));
      warningsPerTask.set(lowerName, list);
      return undefined;
    }
    visiting.add(lowerName);
    for (const dep of def.dependsOn ?? []) {
      const depLower = (dep ?? "").trim().toLowerCase();
      if (depLower) collect(depLower);
    }
    visiting.delete(lowerName);
    visited.set(lowerName, def);
    return def;
  };

  collect(root.name.toLowerCase());

  // Топологический порядок: сначала зависимости (Kahn поверх собранного подграфа).
  const ordered: TaskDefinition[] = [];
  {
    const pending = [...visited.values()];
    const emitted = new Set<string>();
    let progress = true;
    while (pending.length > 0 && progress) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const def = pending[i];
        const deps = (def.dependsOn ?? []).map((d) => (d ?? "").trim().toLowerCase()).filter(Boolean);
        const unmet = deps.filter((d) => visited.has(d) && !emitted.has(d));
        if (unmet.length === 0) {
          ordered.push(def);
          emitted.add(def.name.toLowerCase());
          pending.splice(i, 1);
          i--;
          progress = true;
        }
      }
    }
    // Если остались (цикл), добавляем как есть — предупреждение уже записано.
    for (const leftover of pending) ordered.push(leftover);
  }

  const history = getHistory(null, 1000);
  const historyByTask = new Map<string, typeof history>();
  for (const record of history) {
    const list = historyByTask.get(record.taskName.toLowerCase()) ?? [];
    list.push(record);
    historyByTask.set(record.taskName.toLowerCase(), list);
  }

  const tasks: DryRunTaskItem[] = [];
  let totalDuration: number | null = 0;
  let totalCost: number | null = 0;
  let totalTokens: number | null = 0;

  // Matrix (Спринт 15): родитель сам не выполняется — вместо него в отчёте
  // показываем клоны, по одному на workspace, с их cwd и оценками.
  const units: { def: TaskDefinition; matrixParent?: string }[] = [];
  for (const def of ordered) {
    if (def.matrix) {
      try {
        const clones = expandMatrixTask(def);
        warnings.push(
          t("dryRun.matrix.parent", { name: def.name, count: clones.length }),
        );
        for (const clone of clones) units.push({ def: clone, matrixParent: def.name });
      } catch (err: unknown) {
        const list = warningsPerTask.get(def.name.toLowerCase()) ?? [];
        list.push(
          t("dryRun.matrix.expandError", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
        warningsPerTask.set(def.name.toLowerCase(), list);
        warnings.push(`[${def.name}] ${list[list.length - 1]}`);
      }
      continue;
    }
    units.push({ def });
  }

  // Родители матриц с параллельной стратегией: их клоны считаются max, не sum.
  const parallelMatrixParents = new Set(
    allDefs
      .filter((d) => d.matrix && (d.matrix.strategy ?? "parallel") !== "sequential")
      .map((d) => d.name.toLowerCase()),
  );
  const parallelGroups = new Map<string, { maxDuration: number }>();

  for (let index = 0; index < units.length; index++) {
    const { def, matrixParent } = units[index];
    const lower = def.name.toLowerCase();
    const taskWarnings = warningsPerTask.get(lower) ?? [];

    // cwd: workspace имеет приоритет над workingDirectory (как в schedulerCreateTask).
    const workspace = def.workspaceId ? getWorkspace(def.workspaceId) : undefined;
    const cwd = workspace?.path || def.workingDirectory || def.workdir || "";
    if (!cwd) {
      taskWarnings.push(t("dryRun.cwdImplicit"));
    } else {
      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) {
          taskWarnings.push(t("dryRun.cwdNotDir", { path: cwd }));
        }
      } catch {
        taskWarnings.push(t("dryRun.cwdMissing", { path: cwd }));
      }
    }

    // PL-8.1: HEAD мог уйти вперёд с момента постановки задачи — гейт проверяет
    // уже другой код. Предупреждаем и советуем зафиксировать commit.
    const drift = workingDirectoryDriftWarning(def, cwd);
    if (drift) taskWarnings.push(drift);

    // PL-26/PL-30: trigger отражает реальный triggerType задачи и совпадает
    // с triggerDetails.type. Режим входа в симуляцию вынесен в entryMode,
    // чтобы не подменять тип триггера значениями manual/dag.
    const triggerType = def.triggerType ?? "cron";
    const trigger = triggerType as DryRunTaskItem["trigger"];
    const entryMode: DryRunTaskItem["entryMode"] =
      lower === rootLower || (matrixParent && matrixParent.toLowerCase() === rootLower)
        ? "manual"
        : "dag";

    // Детали триггера (Спринт 27): состояние окна/дней недели, git-статус.
    const triggerDetails = await describeTrigger({
      def,
      cwd,
      triggerType,
      warnings: taskWarnings,
    });

    // Команда, которую выполнит обёртка.
    const modelArg = def.model ? ` --model ${def.model}` : "";
    const promptPreview = (def.prompt ?? "").replace(/\s+/g, " ").trim();
    const command = `opencode run${modelArg} "${promptPreview}"`;

    // Оценки: среднее по последним ESTIMATE_SAMPLE записям истории.
    const records = (historyByTask.get(lower) ?? []).filter((r) => r.status === "success");
    let estimatedDurationSec: number | null = null;
    let estimatedCostUsd: number | null = null;
    let estimatedTokens: number | null = null;
    if (records.length === 0) {
      taskWarnings.push(t("dryRun.noHistory"));
    } else {
      const sample = records.slice(0, ESTIMATE_SAMPLE);
      const avg = (pick: (r: (typeof sample)[number]) => number | null | undefined) => {
        const values = sample.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
        return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };
      const avgMs = avg((r) => r.durationMs);
      if (avgMs != null) estimatedDurationSec = Math.round(avgMs / 100) / 10;
      estimatedTokens = avg((r) => r.tokens) ?? null;
      if (estimatedTokens != null) {
        estimatedCostUsd = (estimatedTokens / 1000) * ESTIMATED_COST_PER_1K_TOKENS_USD;
      }
    }

    // Проверяем опасные паттерны в промпте и хуках.
    const scanned = [def.prompt, def.beforeScript, def.afterScript, def.qualityGate]
      .filter((s): s is string => typeof s === "string")
      .join("\n")
      .toLowerCase();
    for (const { test, messageKey } of DANGEROUS_PATTERNS) {
      if (test.test(scanned)) {
        taskWarnings.push(
          t("dryRun.dangerPattern", { message: t(messageKey) }),
        );
      }
    }

    // PL-5.1: nextTaskOnSuccess и dependsOn на одну задачу = дубль запуска.
    const overlap = findChainDagOverlap(def, allDefs);
    if (overlap) {
      taskWarnings.push(
        `PL-5.1: nextTaskOnSuccess="${overlap}" и dependsOn указывают на одну задачу: ` +
          `при завершении "${def.name}" шаг "${overlap}" будет запущен дважды. ` +
          "Используйте только один механизм перехода (nextTaskOnSuccess ИЛИ dependsOn; см. SKILL.md §6).",
      );
    }

    // PL-2.2: самопроверка через node/тесты при запрещённом shell — источник
    // tool.blocked в аудите и ложного «проверено» в отчёте агента.
    if (
      shellIsForbidden(def) &&
      typeof def.prompt === "string" &&
      SELF_CHECK_PATTERNS.some((pattern) => pattern.test(def.prompt ?? ""))
    ) {
      taskWarnings.push(
        "PL-2.2: промпт требует самопроверки (node/тесты), но shell запрещён: добавьте shell в allowedTools или перенесите проверки в qualityGate/afterScript.",
      );
    }

    // PL-64: смешанные CJK/кириллица в промпте — предупреждаем до запуска,
    // не прерывая симуляцию. Только промпт: хуки/скрипты могут содержать
    // китайский текст легитимно (например, вывод локализованной команды).
    const scriptWarning = mixedScriptPromptWarning(def.prompt ?? "");
    if (scriptWarning) taskWarnings.push(scriptWarning);

    // QV-9: частый cron + тяжёлый промпт (`opencode run`) — антипаттерн из
    // SKILL.md: каждый тик поднимает полную сессию агента и сжигает квоту.
    if (
      triggerType === "cron" &&
      def.schedule &&
      isFrequentCron(def.schedule) &&
      /\bopencode\s+run\b/i.test(def.prompt ?? "")
    ) {
      taskWarnings.push(
        `QV-9: cron "${def.schedule}" запускает opencode run чаще, чем раз в 5 минут: ` +
          "каждый тик поднимает полную сессию агента. Используйте редкое расписание или событийный триггер (mcp-event/file/git).",
      );
    }

    // PL-49: таймаут длиннее интервала cron — следующий тик наступит до
    // завершения текущего, и запуск будет пропущен (lock-skip).
    const intervalMinutes = triggerType === "cron" && def.schedule
      ? minimumCronIntervalMinutes(def.schedule)
      : null;
    if (
      intervalMinutes !== null &&
      typeof def.timeoutSeconds === "number" &&
      def.timeoutSeconds > intervalMinutes * 60
    ) {
      taskWarnings.push(
        `PL-49: timeoutSeconds=${def.timeoutSeconds}с больше интервала cron "${def.schedule}" ` +
          `(${intervalMinutes} мин): следующий тик наступит до завершения текущего прогона. ` +
          "Увеличьте интервал или уменьшите таймаут.",
      );
    }

    // PL-50: cron вне подмножества schtasks тикает каждую минуту — это не
    // частота задачи, а частота опроса planner'а; без пометки легко ошибиться.
    if (triggerDetails.polling) {
      taskWarnings.push(
        `PL-50: cron "${def.schedule}" не выражается в планировщике ОС: ` +
          "записана ежеминутная проверка с schedule gate. Фактическая частота запуска — по cron, но каждую минуту создаётся ProcessID для проверки расписания.",
      );
    }

    const roleScoped: DryRunRoleScoped | null =
      Array.isArray(def.allowedTools) && def.allowedTools.length > 0
        ? { allowed: def.allowedTools, denied: def.deniedTools }
        : Array.isArray(def.deniedTools) && def.deniedTools.length > 0
          ? { allowed: undefined, denied: def.deniedTools }
          : null;

    // Эффективное расписание cron-задачи (Спринт 19): ближайшие срабатывания
    // считаем в часовом поясе задачи, чтобы dry-run показывал то же время, что
    // увидит планировщик после регистрации.
    let scheduleDetails: DryRunTaskItem["scheduleDetails"];
    if (triggerType === "once" && def.runAt) {
      // Для разовой задачи dry-run показывает единственное запланированное время.
      scheduleDetails = {
        cron: "once",
        timezone: def.timezone ?? null,
        notBefore: def.notBefore ?? null,
        notAfter: def.notAfter ?? null,
        pausedUntil: def.pausedUntil ?? null,
        nextRuns: [def.runAt],
      };
    } else if (triggerType === "cron" && def.schedule) {
      const runs: string[] = [];
      try {
        let cursor = new Date();
        for (let i = 0; i < 3; i++) {
          const next = nextRun(def.schedule, cursor, def.timezone);
          if (!next) break;
          runs.push(next.toISOString());
          cursor = next;
        }
      } catch {
        taskWarnings.push(
          t("dryRun.cronParseError", { schedule: def.schedule }),
        );
      }
      scheduleDetails = {
        cron: def.schedule,
        timezone: def.timezone ?? null,
        notBefore: def.notBefore ?? null,
        notAfter: def.notAfter ?? null,
        pausedUntil: def.pausedUntil ?? null,
        nextRuns: runs,
      };
    }

    tasks.push({
      name: def.name,
      order: index,
      trigger,
      entryMode,
      session: def.session ?? "new",
      sessionId: def.session === "reuse" ? def.sessionId ?? null : null,
      // Спринт 27.5.4: показываем режим входа до регистрации в ОС.
      runWhenLoggedOff: def.runWhenLoggedOff === true,
      logonMode: def.runWhenLoggedOff === true ? "background" : "interactive",
      cwd,
      command,
      workspace: workspace ? { name: workspace.name, path: workspace.path } : undefined,
      preFlight: def.beforeScript ?? null,
      postFlight: def.afterScript ?? null,
      qualityGate: def.qualityGate ?? null,
      roleScoped,
      estimatedDurationSec,
      estimatedCostUsd: estimatedCostUsd != null ? Math.round(estimatedCostUsd * 10000) / 10000 : null,
      estimatedTokens: estimatedTokens != null ? Math.round(estimatedTokens) : null,
      ...(matrixParent ? { matrixParent } : {}),
      ...(scheduleDetails ? { scheduleDetails } : {}),
      ...(triggerDetails ? { triggerDetails } : {}),
    });

    if (taskWarnings.length > 0) {
      for (const warning of taskWarnings) {
        warnings.push(`[${def.name}] ${warning}`);
      }
    }

    // Суммируем оценки (null не ломает сумму). Для параллельных матриц
    // длительность берём максимумом по группе, а не суммой клонов.
    if (matrixParent && parallelMatrixParents.has(matrixParent.toLowerCase())) {
      const key = matrixParent.toLowerCase();
      const current = parallelGroups.get(key) ?? { maxDuration: 0 };
      current.maxDuration = Math.max(current.maxDuration, estimatedDurationSec ?? 0);
      parallelGroups.set(key, current);
    } else if (totalDuration != null) {
      totalDuration = totalDuration + (estimatedDurationSec ?? 0);
    }
    if (totalTokens != null) totalTokens = totalTokens + (estimatedTokens ?? 0);
    if (totalCost != null) totalCost = totalCost + (estimatedCostUsd ?? 0);
  }

  for (const group of parallelGroups.values()) {
    if (totalDuration != null) totalDuration = totalDuration + group.maxDuration;
  }

  const hasAnyEstimate = tasks.some(
    (t) => t.estimatedDurationSec != null || t.estimatedCostUsd != null || t.estimatedTokens != null,
  );
  const totals: DryRunTotals = hasAnyEstimate
    ? {
      estimatedDurationSec: totalDuration != null ? Math.round(totalDuration * 10) / 10 : null,
      estimatedCostUsd: totalCost != null ? Math.round(totalCost * 10000) / 10000 : null,
      estimatedTokens: totalTokens != null ? Math.round(totalTokens) : null,
    }
    : { estimatedDurationSec: null, estimatedCostUsd: null, estimatedTokens: null };

  return {
    success: true,
    taskName: root.name,
    tasks,
    totals,
    warnings,
  };
}
