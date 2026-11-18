/**
 * Спринт 32 (Pipeline-as-code, 0.0.5): формат `opencode.pipeline.yaml`
 * и его валидация.
 *
 * Pipeline описывает DAG шагов декларативно, чтобы его можно было
 * ревьюить в PR. Модуль намеренно не трогает БД и планировщик ОС:
 * здесь только типы и чистая валидация. Маппинг в TaskDefinition и
 * идемпотентный apply — задачи P2-33.T2.
 */
import {
  isValidIanaTimeZone,
  normalizeCron,
  parseCron,
  validateLaunchWindow,
} from "./schedule-v2.js";
import { validateModelId, validateTaskName } from "../types.js";

/** Версия формата, которую понимает этот модуль. */
export const PIPELINE_VERSION = 1;
/** Защита от случайно огромного файла: шагов в одном pipeline. */
export const MAX_PIPELINE_STEPS = 200;
/** Максимальная длина id шага (id попадает в имена задач и логи). */
export const MAX_STEP_ID_LENGTH = 64;

/**
 * Чем запускается шаг.
 *
 * `dag` — шаг без собственного триггера: он запускается только как
 * зависимость другого шага (`needs` непустой). Это позволяет описывать
 * pipeline целиком, не придумывая каждому шагу cron.
 */
export type PipelineTrigger =
  | "cron"
  | "file"
  | "git"
  | "mcp-event"
  | "once"
  | "dag";

export type PipelineMatrixStrategy = "parallel" | "sequential";
export type PipelineMatrixFailureMode = "continue" | "stop";
export type PipelineMatrixAggregation = "summary" | "per-task";
export type PipelineWindowPolicy = "skip" | "postpone" | "run";

/** Fan-out матрицы в терминах pipeline-файла. */
export interface PipelineMatrix {
  /** Имена или id workspace, по одному клону на каждый. */
  workspaces: string[];
  strategy?: PipelineMatrixStrategy;
  failureMode?: PipelineMatrixFailureMode;
  aggregation?: PipelineMatrixAggregation;
  /** Максимум одновременно выполняющихся клонов. */
  concurrency?: number;
  createAggregator?: boolean;
}

/** Значения по умолчанию для всех шагов pipeline. */
export interface PipelineDefaults {
  schedule?: string;
  trigger?: PipelineTrigger;
  model?: string;
  priority?: number;
  timeoutSeconds?: number;
  workingDirectory?: string;
  retryCount?: number;
  retryDelay?: number;
  allowedTools?: string[];
  deniedTools?: string[];
  timezone?: string;
}

/** Один шаг pipeline. */
export interface PipelineStep {
  /** Уникальный стабильный идентификатор шага (латиница/кириллица, цифры, `. _ -`). */
  id: string;
  /** Имя задачи в планировщике; по умолчанию `<pipeline> <id>`. */
  name?: string;
  prompt: string;
  /** id шагов, которые должны успешно завершиться раньше. */
  needs?: string[];
  /** Cron-выражение (для trigger: cron). */
  schedule?: string;
  trigger?: PipelineTrigger;
  /** ISO-8601 для trigger: once. */
  runAt?: string;
  model?: string;
  priority?: number;
  timeoutSeconds?: number;
  workingDirectory?: string;
  workspaceId?: string;
  retryCount?: number;
  retryDelay?: number;
  qualityGate?: string;
  beforeScript?: string;
  afterScript?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  matrix?: PipelineMatrix;
  timezone?: string;
  notBefore?: string;
  notAfter?: string;
  activeDays?: number[];
  windowPolicy?: PipelineWindowPolicy;
}

/** Корневой документ `opencode.pipeline.yaml`. */
export interface PipelineSpec {
  version: typeof PIPELINE_VERSION;
  name: string;
  description?: string;
  defaults?: PipelineDefaults;
  steps: PipelineStep[];
}

/** Одна находка валидатора. */
export interface PipelineIssue {
  /** Путь до поля: `steps[2].schedule`, `defaults.model` и т.п. */
  path: string;
  message: string;
}

/** Результат валидации: ошибки блокируют apply, предупреждения — нет. */
export interface PipelineValidationResult {
  ok: boolean;
  errors: PipelineIssue[];
  warnings: PipelineIssue[];
}

const TRIGGERS: ReadonlySet<string> = new Set([
  "cron",
  "file",
  "git",
  "mcp-event",
  "once",
  "dag",
]);
const MATRIX_STRATEGIES: ReadonlySet<string> = new Set(["parallel", "sequential"]);
const MATRIX_FAILURE_MODES: ReadonlySet<string> = new Set(["continue", "stop"]);
const MATRIX_AGGREGATIONS: ReadonlySet<string> = new Set(["summary", "per-task"]);
const WINDOW_POLICIES: ReadonlySet<string> = new Set(["skip", "postpone", "run"]);

const TOP_LEVEL_KEYS = new Set(["version", "name", "description", "defaults", "steps"]);
const DEFAULTS_KEYS = new Set([
  "schedule",
  "trigger",
  "model",
  "priority",
  "timeoutSeconds",
  "workingDirectory",
  "retryCount",
  "retryDelay",
  "allowedTools",
  "deniedTools",
  "timezone",
]);
const STEP_KEYS = new Set([
  "id",
  "name",
  "prompt",
  "needs",
  "schedule",
  "trigger",
  "runAt",
  "model",
  "priority",
  "timeoutSeconds",
  "workingDirectory",
  "workspaceId",
  "retryCount",
  "retryDelay",
  "qualityGate",
  "beforeScript",
  "afterScript",
  "allowedTools",
  "deniedTools",
  "matrix",
  "timezone",
  "notBefore",
  "notAfter",
  "activeDays",
  "windowPolicy",
]);
const MATRIX_KEYS = new Set([
  "workspaces",
  "workspaceIds",
  "strategy",
  "failureMode",
  "aggregation",
  "concurrency",
  "createAggregator",
]);

const STEP_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u;
const PIPELINE_NAME_RE = /^[\p{L}\p{N}_. -]+$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** Имя задачи по умолчанию для шага pipeline. */
export function pipelineStepTaskName(pipelineName: string, stepId: string): string {
  return `${pipelineName.trim()} ${stepId.trim()}`;
}

/**
 * Валидирует произвольный разобранный YAML.
 *
 * Не бросает исключений: все проблемы складываются в `errors`/`warnings`,
 * чтобы CLI мог напечатать их списком и вернуть exit code.
 */
export function validatePipelineSpec(input: unknown): PipelineValidationResult {
  const errors: PipelineIssue[] = [];
  const warnings: PipelineIssue[] = [];
  const err = (path: string, message: string): void => {
    errors.push({ path, message });
  };
  const warn = (path: string, message: string): void => {
    warnings.push({ path, message });
  };

  if (!isPlainObject(input)) {
    err("$", "Ожидался объект pipeline (корень YAML-документа).");
    return { ok: false, errors, warnings };
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      warn(key, "Неизвестное поле pipeline — будет проигнорировано.");
    }
  }

  if (input.version !== PIPELINE_VERSION) {
    err(
      "version",
      `Поддерживается только version: ${PIPELINE_VERSION} (получено: ${JSON.stringify(input.version)}).`,
    );
  }

  let pipelineName: string | null = null;
  if (!isNonEmptyString(input.name)) {
    err("name", "Укажите непустое имя pipeline.");
  } else {
    const name = input.name.trim();
    if (name.length > 120) {
      err("name", `Имя pipeline слишком длинное (${name.length} символов, максимум 120).`);
    } else if (/[\u0000-\u001f\u007f]/.test(name)) {
      err("name", "Имя pipeline не должно содержать управляющие символы.");
    } else if (!PIPELINE_NAME_RE.test(name)) {
      err(
        "name",
        "Имя pipeline может содержать буквы, цифры, пробел, «_», «-» и «.».",
      );
    } else {
      pipelineName = name;
    }
  }

  if (input.description !== undefined && typeof input.description !== "string") {
    err("description", "description должен быть строкой.");
  }

  let defaults: Record<string, unknown> | null = null;
  if (input.defaults !== undefined) {
    if (!isPlainObject(input.defaults)) {
      err("defaults", "defaults должен быть объектом.");
    } else {
      defaults = input.defaults;
      validateDefaults(defaults, err, warn);
    }
  }

  const steps = input.steps;
  if (!Array.isArray(steps)) {
    err("steps", "steps должен быть массивом шагов.");
    return { ok: false, errors, warnings };
  }
  if (steps.length === 0) {
    err("steps", "Pipeline должен содержать хотя бы один шаг.");
  }
  if (steps.length > MAX_PIPELINE_STEPS) {
    err(
      "steps",
      `Слишком много шагов: ${steps.length}, максимум ${MAX_PIPELINE_STEPS}.`,
    );
  }

  const idToIndex = new Map<string, number>();
  const usedTaskNames = new Map<string, number>();
  const needsByStep: { path: string; id: string; needs: string[] }[] = [];

  steps.forEach((raw, index) => {
    const path = `steps[${index}]`;
    if (!isPlainObject(raw)) {
      err(path, "Шаг должен быть объектом.");
      return;
    }

    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.has(key)) {
        warn(`${path}.${key}`, "Неизвестное поле шага — будет проигнорировано.");
      }
    }

    const rawId = raw.id;
    let stepId: string | null = null;
    if (!isNonEmptyString(rawId)) {
      err(`${path}.id`, "Укажите непустой id шага.");
    } else {
      const id = rawId.trim();
      if (id.length > MAX_STEP_ID_LENGTH) {
        err(
          `${path}.id`,
          `id шага слишком длинный (${id.length}, максимум ${MAX_STEP_ID_LENGTH}).`,
        );
      } else if (!STEP_ID_RE.test(id)) {
        err(
          `${path}.id`,
          "id шага может содержать буквы, цифры, «_», «-» и «.» и должен начинаться с буквы или цифры.",
        );
      } else {
        const key = id.toLowerCase();
        const previous = idToIndex.get(key);
        if (previous !== undefined) {
          err(`${path}.id`, `id «${id}» уже используется шагом steps[${previous}].`);
        } else {
          idToIndex.set(key, index);
          stepId = id;
        }
      }
    }

    if (!isNonEmptyString(raw.prompt)) {
      err(`${path}.prompt`, "Укажите непустой prompt шага.");
    }

    // Имя задачи: явное или автоматическое. Планировщик сравнивает имена
    // без учёта регистра, поэтому коллизии проверяем по lower-case.
    let effectiveName: string | null = null;
    if (raw.name !== undefined) {
      if (!isNonEmptyString(raw.name)) {
        err(`${path}.name`, "name должен быть непустой строкой.");
      } else {
        const nameError = validateTaskName(raw.name);
        if (nameError) {
          err(`${path}.name`, nameError);
        } else {
          effectiveName = raw.name.trim();
        }
      }
    } else if (pipelineName && stepId) {
      const candidate = pipelineStepTaskName(pipelineName, stepId);
      const nameError = validateTaskName(candidate);
      if (nameError) {
        err(
          `${path}.name`,
          `Автоматическое имя задачи «${candidate}» недопустимо: ${nameError}`,
        );
      } else {
        effectiveName = candidate;
      }
    }
    if (effectiveName) {
      const key = effectiveName.toLowerCase();
      const previous = usedTaskNames.get(key);
      if (previous !== undefined) {
        err(
          `${path}.name`,
          `Имя задачи «${effectiveName}» уже используется шагом steps[${previous}].`,
        );
      } else {
        usedTaskNames.set(key, index);
      }
    }

    const needs: string[] = [];
    if (raw.needs !== undefined) {
      if (!Array.isArray(raw.needs)) {
        err(`${path}.needs`, "needs должен быть массивом id шагов.");
      } else {
        const seen = new Set<string>();
        raw.needs.forEach((need, needIndex) => {
          if (!isNonEmptyString(need)) {
            err(`${path}.needs[${needIndex}]`, "needs должен содержать непустые id шагов.");
            return;
          }
          const trimmed = need.trim();
          const key = trimmed.toLowerCase();
          if (seen.has(key)) {
            err(`${path}.needs[${needIndex}]`, `Зависимость «${trimmed}» указана повторно.`);
            return;
          }
          seen.add(key);
          if (stepId && key === stepId.toLowerCase()) {
            err(`${path}.needs[${needIndex}]`, "Шаг не может зависеть от самого себя.");
            return;
          }
          needs.push(trimmed);
        });
      }
    }
    if (stepId) {
      needsByStep.push({ path, id: stepId, needs });
    }

    const stepTrigger = raw.trigger ?? defaults?.trigger ?? "cron";
    const hasSchedule = raw.schedule !== undefined || defaults?.schedule !== undefined;
    validateTriggerAndSchedule(
      path,
      stepTrigger,
      raw.schedule ?? defaults?.schedule,
      raw.runAt,
      needs.length,
      hasSchedule,
      err,
      warn,
    );

    validateModelField(raw.model, `${path}.model`, err);
    validateOptionalInteger(raw.priority, `${path}.priority`, 0, 10, err);
    validateOptionalInteger(raw.timeoutSeconds, `${path}.timeoutSeconds`, 1, undefined, err);
    validateOptionalInteger(raw.retryCount, `${path}.retryCount`, 0, undefined, err);
    validateOptionalInteger(raw.retryDelay, `${path}.retryDelay`, 0, undefined, err);
    validateOptionalString(raw.workingDirectory, `${path}.workingDirectory`, err);
    validateOptionalString(raw.workspaceId, `${path}.workspaceId`, err);
    validateOptionalString(raw.qualityGate, `${path}.qualityGate`, err);
    validateOptionalString(raw.beforeScript, `${path}.beforeScript`, err);
    validateOptionalString(raw.afterScript, `${path}.afterScript`, err);
    validateTools(raw.allowedTools, `${path}.allowedTools`, true, err);
    validateTools(raw.deniedTools, `${path}.deniedTools`, false, err);

    if (raw.matrix !== undefined) {
      validateMatrix(raw.matrix, `${path}.matrix`, raw.workspaceId, err, warn);
    }

    if (raw.timezone !== undefined) {
      if (!isNonEmptyString(raw.timezone) || !isValidIanaTimeZone(raw.timezone)) {
        err(`${path}.timezone`, `Неизвестный IANA-часовой пояс: ${JSON.stringify(raw.timezone)}.`);
      }
    }
    const windowError = validateLaunchWindow(
      typeof raw.notBefore === "string" ? raw.notBefore : null,
      typeof raw.notAfter === "string" ? raw.notAfter : null,
    );
    if (windowError) {
      err(`${path}.notBefore`, windowError);
    }
    if (raw.activeDays !== undefined) {
      if (
        !Array.isArray(raw.activeDays) ||
        raw.activeDays.some((day) => !isInteger(day) || day < 0 || day > 6)
      ) {
        err(`${path}.activeDays`, "activeDays — массив целых чисел 0…6 (0 = воскресенье).");
      }
    }
    if (raw.windowPolicy !== undefined && !WINDOW_POLICIES.has(String(raw.windowPolicy))) {
      err(`${path}.windowPolicy`, "windowPolicy: skip | postpone | run.");
    }
  });

  // Ссылки на несуществующие шаги.
  for (const entry of needsByStep) {
    entry.needs.forEach((need, needIndex) => {
      if (!idToIndex.has(need.toLowerCase())) {
        err(
          `${entry.path}.needs[${needIndex}]`,
          `Шаг «${need}» не найден среди id шагов pipeline.`,
        );
      }
    });
  }

  const cycle = findDependencyCycle(needsByStep);
  if (cycle) {
    err("steps", `Циклическая зависимость: ${cycle.join(" → ")}.`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function validateDefaults(
  defaults: Record<string, unknown>,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  for (const key of Object.keys(defaults)) {
    if (!DEFAULTS_KEYS.has(key)) {
      warn(`defaults.${key}`, "Неизвестное поле defaults — будет проигнорировано.");
    }
  }
  if (defaults.schedule !== undefined) {
    validateCron(defaults.schedule, "defaults.schedule", err);
  }
  if (defaults.trigger !== undefined) {
    if (!TRIGGERS.has(String(defaults.trigger))) {
      err("defaults.trigger", "trigger: cron | file | git | mcp-event | once | dag.");
    } else if (defaults.trigger === "dag" || defaults.trigger === "once") {
      warn(
        "defaults.trigger",
        `trigger: ${String(defaults.trigger)} в defaults применяется ко всем шагам — обычно его задают на шаге.`,
      );
    }
  }
  validateModelField(defaults.model, "defaults.model", err);
  validateOptionalInteger(defaults.priority, "defaults.priority", 0, 10, err);
  validateOptionalInteger(defaults.timeoutSeconds, "defaults.timeoutSeconds", 1, undefined, err);
  validateOptionalInteger(defaults.retryCount, "defaults.retryCount", 0, undefined, err);
  validateOptionalInteger(defaults.retryDelay, "defaults.retryDelay", 0, undefined, err);
  validateOptionalString(defaults.workingDirectory, "defaults.workingDirectory", err);
  validateTools(defaults.allowedTools, "defaults.allowedTools", true, err);
  validateTools(defaults.deniedTools, "defaults.deniedTools", false, err);
  if (defaults.timezone !== undefined) {
    if (!isNonEmptyString(defaults.timezone) || !isValidIanaTimeZone(defaults.timezone)) {
      err("defaults.timezone", `Неизвестный IANA-часовой пояс: ${JSON.stringify(defaults.timezone)}.`);
    }
  }
}

function validateTriggerAndSchedule(
  path: string,
  trigger: unknown,
  schedule: unknown,
  runAt: unknown,
  needsCount: number,
  hasSchedule: boolean,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  if (!TRIGGERS.has(String(trigger))) {
    err(`${path}.trigger`, "trigger: cron | file | git | mcp-event | once | dag.");
    return;
  }
  if (trigger === "dag") {
    if (needsCount === 0) {
      err(
        `${path}.trigger`,
        "trigger: dag допустим только для шага с непустым needs — иначе шаг никогда не запустится.",
      );
    }
    if (schedule !== undefined) {
      warn(`${path}.schedule`, "schedule игнорируется при trigger: dag.");
    }
    return;
  }
  if (trigger === "once") {
    if (!isNonEmptyString(runAt)) {
      err(`${path}.runAt`, "Для trigger: once нужен runAt (ISO-8601).");
    } else if (Number.isNaN(Date.parse(runAt))) {
      err(`${path}.runAt`, "runAt должен быть корректной ISO-8601 датой.");
    }
    if (schedule !== undefined) {
      warn(`${path}.schedule`, "schedule игнорируется при trigger: once.");
    }
    return;
  }
  if (trigger === "cron") {
    if (!hasSchedule) {
      err(
        `${path}.schedule`,
        "Для trigger: cron нужен schedule (в шаге или defaults.schedule); для DAG-шага без своего cron используйте trigger: dag.",
      );
    } else if (schedule !== undefined) {
      validateCron(schedule, `${path}.schedule`, err);
    }
    return;
  }
  // file / git / mcp-event: расписание не требуется.
  if (schedule !== undefined) {
    warn(`${path}.schedule`, `schedule игнорируется при trigger: ${String(trigger)}.`);
  }
}

function validateCron(
  value: unknown,
  path: string,
  err: (path: string, message: string) => void,
): void {
  if (!isNonEmptyString(value)) {
    err(path, "schedule должен быть непустой cron-строкой.");
    return;
  }
  try {
    parseCron(normalizeCron(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    err(path, `Некорректный cron «${value}»: ${message}`);
  }
}

function validateModelField(
  value: unknown,
  path: string,
  err: (path: string, message: string) => void,
): void {
  if (value === undefined) return;
  if (!isNonEmptyString(value)) {
    err(path, "model должен быть непустой строкой вида provider/model.");
    return;
  }
  const modelError = validateModelId(value);
  if (modelError) {
    err(path, modelError);
  }
}

function validateOptionalString(
  value: unknown,
  path: string,
  err: (path: string, message: string) => void,
): void {
  if (value !== undefined && typeof value !== "string") {
    err(path, "Ожидалась строка.");
  }
}

function validateOptionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number | undefined,
  err: (path: string, message: string) => void,
): void {
  if (value === undefined) return;
  if (!isInteger(value)) {
    err(path, "Ожидалось целое число.");
    return;
  }
  if (value < min) {
    err(path, `Значение должно быть не меньше ${min}.`);
  }
  if (max !== undefined && value > max) {
    err(path, `Значение должно быть не больше ${max}.`);
  }
}

function validateTools(
  value: unknown,
  path: string,
  requireNonEmpty: boolean,
  err: (path: string, message: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    err(path, "Ожидался массив имён инструментов.");
    return;
  }
  if (requireNonEmpty && value.length === 0) {
    err(path, "Пустой список allowedTools запрещён: «разрешено ничего» не имеет смысла.");
    return;
  }
  value.forEach((tool, index) => {
    if (!isNonEmptyString(tool)) {
      err(`${path}[${index}]`, "Имя инструмента должно быть непустой строкой.");
    }
  });
}

function validateMatrix(
  value: unknown,
  path: string,
  workspaceId: unknown,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): void {
  if (!isPlainObject(value)) {
    err(path, "matrix должен быть объектом.");
    return;
  }
  for (const key of Object.keys(value)) {
    if (!MATRIX_KEYS.has(key)) {
      warn(`${path}.${key}`, "Неизвестное поле matrix — будет проигнорировано.");
    }
  }
  if (value.workspaces !== undefined && value.workspaceIds !== undefined) {
    err(path, "Укажите что-то одно: matrix.workspaces или matrix.workspaceIds.");
  }
  const workspaces = value.workspaces ?? value.workspaceIds;
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    err(`${path}.workspaces`, "matrix.workspaces — непустой массив workspace.");
  } else {
    const seen = new Set<string>();
    workspaces.forEach((workspace, index) => {
      if (!isNonEmptyString(workspace)) {
        err(`${path}.workspaces[${index}]`, "Ожидалось непустое имя/id workspace.");
        return;
      }
      const key = workspace.trim().toLowerCase();
      if (seen.has(key)) {
        err(`${path}.workspaces[${index}]`, `Workspace «${workspace}» указан повторно.`);
      }
      seen.add(key);
    });
  }
  if (value.strategy !== undefined && !MATRIX_STRATEGIES.has(String(value.strategy))) {
    err(`${path}.strategy`, "strategy: parallel | sequential.");
  }
  if (value.failureMode !== undefined && !MATRIX_FAILURE_MODES.has(String(value.failureMode))) {
    err(`${path}.failureMode`, "failureMode: continue | stop.");
  }
  if (value.aggregation !== undefined && !MATRIX_AGGREGATIONS.has(String(value.aggregation))) {
    err(`${path}.aggregation`, "aggregation: summary | per-task.");
  }
  validateOptionalInteger(value.concurrency, `${path}.concurrency`, 1, undefined, err);
  if (value.createAggregator !== undefined && typeof value.createAggregator !== "boolean") {
    err(`${path}.createAggregator`, "createAggregator должен быть boolean.");
  }
  if (workspaceId !== undefined) {
    err(path, "matrix нельзя сочетать с workspaceId: матрица сама задаёт workspace для клонов.");
  }
}

function findDependencyCycle(
  entries: { path: string; id: string; needs: string[] }[],
): string[] | null {
  const graph = new Map<string, string[]>();
  const display = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    display.set(key, entry.id);
    graph.set(
      key,
      entry.needs.map((need) => need.toLowerCase()),
    );
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GRAY);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) {
      if (!graph.has(dependency)) continue;
      const state = color.get(dependency) ?? WHITE;
      if (state === GRAY) {
        const start = stack.indexOf(dependency);
        return [...stack.slice(start), dependency].map(
          (key) => display.get(key) ?? key,
        );
      }
      if (state === WHITE) {
        const found = visit(dependency);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const key of graph.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) {
      const found = visit(key);
      if (found) return found;
    }
  }
  return null;
}
