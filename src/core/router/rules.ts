/**
 * Слой 1 роутера — статические правила горячего пути (Спринт 36.5.a).
 *
 * Таблица «тип задачи → транспорт + исполнитель» отвечает на вопрос «как
 * выполнять шаг» без модели: 0 токенов, чистая функция, мгновенный ответ.
 * Модель (слой 3) сюда не заглядывает — она только разбивает миссию на шаги
 * с типами, а маршрут выбирается по этой таблице (и по Capability Map из
 * слоя 2, см. src/db/capability-repo.ts).
 *
 * Модуль намеренно не импортирует ничего: ни БД, ни локальную модель, ни
 * транспорт. Это гарантирует, что горячий путь не тянет за собой побочных
 * эффектов и не может случайно вызвать модель.
 */

/** Транспорт доставки шага. */
export type RouterTransport = "direct" | "mcp" | "cloud";

/** Исполнитель шага: локальный процесс или облачная модель. */
export type RouterExecutor = "local" | "cloud";

/** Правило статической маршрутизации для одного типа задачи. */
export interface StaticRouteRule {
  /** Тип шага в нормализованном виде (нижний регистр, подчёркивания). */
  taskType: string;
  transport: RouterTransport;
  executor: RouterExecutor;
  /** Почему правило выглядит именно так — для логов и отчётов. */
  description: string;
}

/**
 * Встроенная таблица слоя 1.
 *
 * Совпадает с docs/ARCHITECTURE.md → «Слой 1 — статические правила»: известные
 * операции обслуживаются локально и напрямую, внешние системы — через MCP,
 * облачная модель — только там, где локально сделать нельзя.
 */
export const STATIC_ROUTE_RULES: readonly StaticRouteRule[] = Object.freeze([
  {
    taskType: "read_file",
    transport: "direct",
    executor: "local",
    description: "Чтение файла — прямое обращение к ФС, модель не нужна.",
  },
  {
    taskType: "write_file",
    transport: "direct",
    executor: "local",
    description: "Запись файла — прямое обращение к ФС, модель не нужна.",
  },
  {
    taskType: "run_tests",
    transport: "direct",
    executor: "local",
    description: "Тесты запускаются локальным процессом.",
  },
  {
    taskType: "mission",
    transport: "direct",
    executor: "local",
    description: "Ad-hoc миссия исполняется локально через обёртку без регистрации в ОС.",
  },
  {
    taskType: "apply_diff",
    transport: "direct",
    executor: "local",
    description: "Патч применяется локально, без внешних вызовов.",
  },
  {
    taskType: "github_create_pr",
    transport: "mcp",
    executor: "local",
    description: "Внешняя система GitHub — транспорт MCP, исполнитель локальный.",
  },
  {
    taskType: "jira_update_task",
    transport: "mcp",
    executor: "cloud",
    description: "Jira доступна только через MCP и облачный исполнитель.",
  },
]);

const ROUTE_TABLE: ReadonlyMap<string, StaticRouteRule> = new Map(
  STATIC_ROUTE_RULES.map((rule) => [rule.taskType, rule]),
);

/**
 * Нормализует тип задачи: `Run Tests`, `run-tests`, ` RUN_TESTS ` → `run_tests`.
 * Нужна, потому что план миссии может прийти из модели в свободной форме.
 */
export function normalizeTaskType(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
}

/** Возвращает правило слоя 1 для типа задачи или `undefined`, если тип неизвестен. */
export function routeStaticStep(taskType: string): StaticRouteRule | undefined {
  if (typeof taskType !== "string" || taskType.trim() === "") {
    return undefined;
  }
  return ROUTE_TABLE.get(normalizeTaskType(taskType));
}

/** Есть ли для типа задачи статическое правило (0 токенов, без БД). */
export function isStaticTaskType(taskType: string): boolean {
  return routeStaticStep(taskType) !== undefined;
}

/** Снимок таблицы слоя 1 — для отчётов, GUI и тестов. */
export function listStaticRouteRules(): readonly StaticRouteRule[] {
  return STATIC_ROUTE_RULES;
}
