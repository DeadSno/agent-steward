# PL-43 structured list_tasks output

- Дата: 2026-11-20
- Trigger: `once` (однократная задача без регулярного расписания ОС)
- Ветка: `dev`
- Статус: закрыта, маркер гейта `pl43-gate.passed` создан после зелёного прогона

## Проблема

В Code Mode `list_tasks` возвращал только JSON-строку в `content`, в отличие от
остальных MCP-инструментов плагина: структурированный `output` в спецификации
инструмента отсутствовал. Клиент V2 не мог получить типизированный результат
без ручного `JSON.parse`.

## Таблица изменений

| Файл | Изменение |
|---|---|
| `src/index.ts` | Добавлена `listTasksOutputSchema = z.object({ success, message, tasks, osAvailable, osError? })` рядом с `listTasksSchema`. |
| `src/index.ts` | `ToolSpec` получил необязательное поле `output?: z.ZodTypeAny`; оно пробрасывается в V2-регистрацию `editor.add({ name, input, output, description, options, execute })`. |
| `src/index.ts` | Спецификация `list_tasks` получила `output: listTasksOutputSchema`; description дополнено указанием на структурированный output в Code Mode и строковый `content` для совместимости. |
| `src/index.ts` | `listTasksExecute` в обеих ветках (пустой и непустой список) возвращает `{ output: payload, content: JSON.stringify(payload) }` — один и тот же объект в обоих полях. |
| `src/index.ts` | `wrapExecute` в ветке ошибки тоже пробрасывает `output` наряду с `content`, чтобы формат результата был единообразным. |
| `test-execution-hardening.mjs` | Проверки: схема `output` у spec `list_tasks` определена, `output` доходит до V2-регистрации, `execute` возвращает `output` с массивом `tasks`, `content` — валидный JSON того же payload. Добавлена изоляция от маркера `AGENT_STEWARD_CHILD_RUN` (задача запускается внутри обёртки планировщика). |
| `test-v1-integration.mjs` | Регрессия V1: `toV1ToolResult` по-прежнему отдаёт JSON-строку в `output`, поле `content` в V1 не пробрасывается, внутри строки есть `success` и массив `tasks`. Добавлена та же изоляция от child-run маркера. |
| `ROADMAP.md` | Удалена закрытая строка PL-43. |
| `CHANGELOG.md` | Добавлена одна запись PL-43 в начало списка `### Added`; существующие записи не изменены. |

## V1 / V2

Общие обработчики (`createToolSpecs`) теперь несут и схему `output`, но линии
потребляют её по-разному:

- **V2 (Code Mode):** `editor.add` получает `output: listTasksOutputSchema`, поэтому
  инструмент объявляет типизированный результат; `Tool.Result.output` содержит тот же
  объект payload, что и `content`.
- **V1:** `tool()` не имеет параметра `output`, поле из `ToolSpec` на адаптер не
  влияет. `toV1ToolResult` приоритетно берёт строковый `content` и возвращает
  `{ output: "<json>" }`. Добавленный в `wrapExecute` объектный `output` в V1
  не используется (ветка `typeof content === "string"` срабатывает раньше),
  поэтому контракт V1 не изменился.

## Верификация

| Команда | Результат |
|---|---|
| `npm run build` | OK (tsc, без ошибок) |
| `node test-execution-hardening.mjs` | 36/36 проверок, включая 7 новых по PL-43 |
| `node test-v1-integration.mjs` | все проверки пройдены, V1 output — строка |
| `node test-docs.mjs` | 113/113 проверок |
| `npm run build && node test-execution-hardening.mjs && node test-v1-integration.mjs && echo OK>pl43-gate.passed` | зелёный прогон, маркер `pl43-gate.passed` создан |

Создание маркера гейта выполнено только после успешного прохождения всех трёх
команд цепочки. `git commit` и `git push` не выполнялись — их делает afterScript
планировщика.
