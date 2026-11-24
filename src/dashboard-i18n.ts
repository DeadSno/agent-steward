/**
 * Перевод строк веб-дашборда.
 *
 * Исторически разметка дашборда собиралась в `src/server.ts` как один большой
 * шаблон с жёстко зашитыми русскими строками (включая строки внутри встроенного
 * клиентского JS). Чтобы снимок дашборда в README соответствовал выбранному
 * языку интерфейса, перевод применяется к уже собранному HTML: русские фразы
 * заменяются на английские до отдачи страницы браузеру.
 *
 * Для локали `ru` HTML возвращается без изменений. Для `en` используется
 * словарь ниже; `zh`/`tr` сейчас получают английский текст как fallback
 * (русского в дашборде больше нет, полноценные каталоги — следующий шаг).
 */
import { getLocale } from "./i18n.js";

/** Английские equivalents строк дашборда. Ключ — исходный русский текст. */
const EN: Record<string, string> = {
  // Шапка иcards
  "Локальный веб-дашборд": "Local web dashboard",
  "профиль <b>": "profile <b>",
  "Скачать БД": "Download DB",
  "Удалить клоны и агрегаторы матриц, чьи родители уже удалены":
    "Delete clones and matrix aggregators whose parents were removed",
  "Осиротевшие клоны": "Orphaned clones",
  "Обновлено: ": "Updated: ",
  // Карточки метрик
  "Всего запусков": "Total runs",
  "Успешных": "Successful",
  "Ошибок": "Errors",
  "Частичных": "Partial",
  "Задач в системе": "Tasks in system",
  "Всего токенов": "Total tokens",
  "Примерная стоимость": "Estimated cost",
  "Ошибки и таймауты. Частичные выполнения считаются отдельно.":
    "Errors and timeouts. Partial runs are counted separately.",
  "Частичные выполнения (partial): ответ получен, но проверка не прошла":
    "Partial runs (partial): response received but check failed",
  // Граф зависимостей
  "Граф зависимостей (DAG)": "Dependency graph (DAG)",
  "Слева — задачи без зависимостей, справа — задачи, которые ждут их успешного завершения. Граф можно прокручивать по горизонтали.":
    "On the left are tasks without dependencies, on the right are tasks waiting for them to finish. The graph scrolls horizontally.",
  "Граф зависимостей задач": "Task dependency graph",
  // Таблица задач
  "Задачи планировщика": "Scheduler tasks",
  "Имя": "Name",
  "Статус": "Status",
  "Workspace": "Workspace",
  "Модель": "Model",
  "Приоритет": "Priority",
  "Зависимости": "Dependencies",
  "Метрики": "Metrics",
  "Действия": "Actions",
  "Загрузка…": "Loading…",
  "Таблица шире экрана — прокрутите её влево-вправо.":
    "The table is wider than the screen — scroll it horizontally.",
  "Без workspace": "No workspace",
  "Фильтр задач по workspace": "Filter tasks by workspace",
  "📦 0 workspace · 0 задач": "📦 0 workspace · 0 tasks",
  // Статусы и кнопки
  "✅ Успех": "✅ Success",
  "🔴 Ошибка": "🔴 Error",
  "🟠 Частично": "🟠 Partial",
  "🟡 Выполняется": "🟡 Running",
  "⚪ Неизвестно": "⚪ Unknown",
  "🟢 Готова": "🟢 Ready",
  "⚪ Не запускалась": "⚪ Never run",
  "🧟 Нет в планировщике": "🧟 Not in scheduler",
  "⏸ Пауза": "⏸ Paused",
  "Задача поставлена на паузу": "Task paused",
  "Задача создана, но ещё ни разу не запускалась": "Task created but never run",
  "Определение есть в БД, но задачи нет в планировщике ОС":
    "Definition exists in DB but no task in the OS scheduler",
  "▶ Запустить": "▶ Run",
  "🗑 Удалить": "🗑 Delete",
  "⛔ Отменить": "⛔ Cancel",
  "🧪 Симуляция": "🧪 Simulate",
  "📦 Матрицы": "📦 Matrices",
  "Показать/скрыть клоны": "Show/hide clones",
  "Показать/скрыть клоны матрицы": "Show/hide matrix clones",
  "Показать все (": "Show all (",
  "Свернуть историю": "Collapse history",
  "Удалить задачу ": "Delete task ",
  "Удалить матрицу ": "Delete matrix ",
  "Удалить матрицу вместе со всеми клонами": "Delete matrix with all clones",
  "вместе со всеми клонами и агрегатором?": "along with all clones and the aggregator?",
  "Отменить выполняющиеся клоны матрицы": "Cancel running matrix clones",
  "Клон удаляется только вместе с матрицей": "A clone can only be deleted with its matrix",
  "Только родители матриц и их клоны": "Only matrix parents and their clones",
  "Ошибка очистки": "Cleanup error",
  // История
  "История выполнений": "Run history",
  "Запусков пока нет.": "No runs yet.",
  "Нет запусков за период.": "No runs in this period.",
  // Аналитика
  "Аналитика за период": "Analytics for period",
  "Аналитика недоступна": "Analytics unavailable",
  "Аналитика недоступна.": "Analytics unavailable.",
  "Топ задач по стоимости": "Top tasks by cost",
  "Матрицы": "Matrices",
  "Матриц за период не запускалось.": "No matrices ran in this period.",
  "Нет данных за период.": "No data for this period.",
  "Ср. длительность: <b>": "Avg. duration: <b>",
  "Стоимость: <b>": "Cost: <b>",
  "Токены: <b>": "Tokens: <b>",
  "Успех: <b class=": "Success: <b class=",
  "Запусков: <b>": "Runs: <b>",
  "Окно: <b>": "Window: <b>",
  "Сэкономлено: <b>": "Saved: <b>",
  "Количество запусков по дням за период": "Runs per day in the period",
  // What-If
  "What-If: Анализ моделей": "What-If: Model analysis",
  "Симуляция…": "Simulating…",
  "Симуляция не удалась": "Simulation failed",
  "Оценка": "Estimate",
  "Оценка: ": "Estimate: ",
  "Σ Оценка конвейера: ": "Σ Pipeline estimate: ",
  "Стоимость": "Cost",
  "Токенов": "Tokens",
  "Успех": "Success",
  "Задача": "Task",
  "Клонов": "Clones",
  "Матрица": "Matrix",
  "Команда": "Command",
  "Триггер": "Trigger",
  "Запусков": "Runs",
  "Средняя длительность": "Avg. duration",
  "Пока нет запусков с данными о модели.": "No runs with model data yet.",
  "Модели для сравнения — те, что уже запускались:": "Models available for comparison are those already run:",
  "Модели и цены — из OpenCode (ваши доступные модели):":
    "Models and prices come from OpenCode (your available models):",
  "OpenCode недоступен, показаны модели по умолчанию:":
    "OpenCode unavailable, showing default models:",
  "Если бы все запуски выполнялись через <b>": "If all runs used <b>",
  "по эталонной цене $": "at reference price $",
  "за 1k токенов.": "per 1k tokens.",
  "</b>, это стоило бы ~<b>": "</b>, it would have cost ~<b>",
  "</b>, фактическая стоимость: <b>": "</b>, actual cost: <b>",
  "</b>, токенов: <b>": "</b>, tokens: <b>",
  "$/1M токенов).": "$/1M tokens).",
  "токенов без записанной стоимости, ": "tokens without recorded cost, ",
  "токенов · ": "tokens · ",
  "методика": "method",
  "оценка": "estimate",
  // Unterminated/fragment phrases
  "вместе со всеми клонами": "with all clones",
  "клонов, стратегия: ": "clones, strategy: ",
  "из 10": "of 10",
  "запусков, ": "runs, ",
  "успешных": "successful",
  "· частично: ": "· partial: ",
  "· ❌ ошибок: ": "· ❌ errors: ",
  "· ⏳ в работе: ": "· ⏳ running: ",
  "· 📦 матриц: ": "· 📦 matrices: ",
  "· зависит от: ": "· depends on: ",
  "Зависит от: ": "Depends on: ",
  ": всего ": ": total ",
  ", успех ": ", success ",
  ", частично ": ", partial ",
  ", ошибок ": ", errors ",
  ", одновременно: ": ", simultaneously: ",
  ", переопределено workspace: ": ", workspace overridden: ",
  "из 10 ": "of 10 ",
  "Приоритет: ": "Priority: ",
  "Модель: ": "Model: ",
  "Дашборд: ": "Dashboard: ",
  "Дашборд: метрики недоступны": "Dashboard: metrics unavailable",
  "Дашборд: не удалось загрузить": "Dashboard: failed to load",
  "| статус: ": "| status: ",
  "↓": "↓",
  // Прочее
  "(папка проекта)": "(project folder)",
  "(пусто)": "(empty)",
  "↪ продолжение": "↪ continuation",
  "Высокий": "High",
  "Обычный": "Normal",
  "Низкий": "Low",
  "Критический": "Critical",
  "Готово": "Ready",
  "мин": "min",
  "мс": "ms",
  "дн.": "d.",
  "ток.": "tokens.",
  "и href=": "and href=",
  "начальная задача": "initial task",
  "Сервер вернул не JSON. Проверьте консоль.": "Server returned non-JSON. Check the console.",
  "Сервер вернул не JSON. URL: ": "Server returned non-JSON. URL: ",
  "Сервер прислал невалидный JSON. URL: ": "Server sent invalid JSON. URL: ",
  "Не удалось получить данные дашборда: ": "Failed to get dashboard data: ",
  "Не удалось выполнить действие": "Failed to perform action",
  "Не удалось загрузить список задач — остальные блоки обновлены. Подробности в консоли (F12).":
    "Failed to load the task list — other sections updated. See console (F12).",
  ">❌ Ошибка загрузки данных: ": ">❌ Failed to load data: ",
  "Ошибка: ": "Error: ",
  ">Ошибка: ": ">Error: ",
  "⚠ Предупреждения:": "⚠ Warnings:",
  "В ответе нет заголовка x-plugin-dashboard — возможно, это не дашборд плагина.":
    "Response has no x-plugin-dashboard header — this may not be the plugin dashboard.",
  "Ответ пришёл не от дашборда плагина: нет заголовка x-plugin-dashboard. ":
    "Response did not come from the plugin dashboard: no x-plugin-dashboard header. ",
  "Откройте консоль браузера (F12) — там тело ответа сервера.":
    "Open the browser console (F12) to see the server response body.",
  "Добавьте localhost в исключения или смените порт.":
    "Add localhost to exceptions or change the port.",
  "Похоже, на этом порту работает другой сервис.":
    "Looks like another service is running on this port.",
  "Похоже, ваш антивирус блокирует соединение. ":
    "Looks like your antivirus is blocking the connection. ",
  "Похоже, соединение перехвачено антивирусом. URL: ":
    "Looks like the connection is intercepted by antivirus. URL: ",
  "недоступен, использую ": "unavailable, using ",
  "👁️ файл: ": "👁️ file: ",
  "⟳ сессия": "⟳ session",
  "Переиспользуемая сессия OpenCode": "Reusable OpenCode session",
  "Продолжение последней сессии OpenCode (--continue)": "Continue last OpenCode session (--continue)",
  "Dry-Run: симуляция конвейера без запуска": "Dry-Run: simulate pipeline without launching",
  "Данные обновляются автоматически каждые 5 секунд": "Data refreshes automatically every 5 seconds",
  "БД: ✅ SQLite (WAL)": "DB: ✅ SQLite (WAL)",
  "🧹 Нет в планировщике": "🧟 Not in scheduler",
};

/** Языки, у которых есть перевод дашборда; остальные получают английский. */
const LOCALES: Record<string, Record<string, string>> = {
  ru: {},
  en: EN,
  zh: EN,
  tr: EN,
};

/**
 * Короткие русские слова и шаблоны, которые нельзя переводить подстрокой
 * (иначе «задач» испортит «задачи»). Применяются после словаря, по границам слов.
 */
const EN_REGEX_RULES: [RegExp, string][] = [
  // \b не работает с кириллицей (JS считает словыми только ASCII-буквы),
  // поэтому границы задаём явно.
  [/(^|[\s(\u00a0])задач(?=$|[\s).,·\u00a0])/g, "$1tasks"],
  [/(^|[\s>\u00a0])Все(?=$|[\s<.,·\u00a0])/g, "$1All"],
  [/Всего:/g, "Total:"],
  // Литералы внутри встроенного клиентского JS: ' задач', ' с'.
  [/(['"]) задач\1/g, "$1 tasks$1"],
  [/(['"]) с\1/g, "$1 s$1"],
  [/(\d+)\s+с(?=$|[\s.,·<"'])/g, "$1 s"],
  [
    /не задан workdir задачи — снимок дерева/g,
    "workdir not set for the task — tree snapshot",
  ],
  [/qualityGate не задан — worktree-snapshot/g, "qualityGate not set — worktree-snapshot"],
  [/из 3 клонов завершился с ошибкой/g, "of 3 clones finished with an error"],
];

/**
 * Переводит собранный HTML дашборда. Длинные фразы идут первыми, чтобы
 * короткие подстроки не «съедали» их части.
 */
export function localizeDashboardHtml(html: string, locale: string = getLocale()): string {
  const dictionary = locale === "ru" ? LOCALES.ru : (LOCALES[locale] ?? EN);
  let result = html;
  const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (result.includes(key)) result = result.split(key).join(dictionary[key]);
  }
  if (dictionary !== LOCALES.ru) {
    for (const [pattern, replacement] of EN_REGEX_RULES) {
      result = result.replace(pattern, replacement);
    }
  }
  return result;
}
