# PL-42 — алиас `eventName` для `mcpEvent`

## Проблема

`schedule_task` с `triggerType: "mcp-event"` требовал `mcpEvent.event`, тогда как
`emit_event` и большинство примеров в README/docs используют `eventName`.
Копирование примера в задачу приводило к ошибке `tool.error.mcpEventRequired`
с советом указать `mcpEvent.event`, что не совпадало с документацией.

## Что изменено

- `src/index.ts` — Zod-схемы `scheduleTaskSchema`, `updateTaskSchema`,
  `manageTemplatesSchema`: в `mcpEvent` оба поля (`event`, `eventName`)
  необязательны и описаны как алиасы друг друга.
- `src/index.ts` — новая функция `normalizeMcpEventTrigger()`: приводит вход
  к каноническому `{ server, event, filter? }`. `event` имеет приоритет, если
  заданы оба поля; значения обрезаются по пробелам; пустой `filter`
  отбрасывается.
- `src/index.ts` — `schedulerCreateTask()` использует общую нормализацию,
  проверка «хотя бы одно имя» осталась после неё (`tool.error.mcpEventRequired`).
- `locales/{ru,en,zh}.json` — сообщение об ошибке упоминает оба имени.
- `test-agent-tools.mjs` — 5 проверок: схема принимает оба варианта, alias
  создаёт событие, `event` работает как раньше с `server`/`filter`, при
  конфликте побеждает `event`, без имён возвращается ошибка с обоими именами,
  и путь создания использует общую нормализацию.

`update_task` передаёт `input.mcpEvent ?? previous.mcpEvent` в
`schedulerCreateTask()`, поэтому алиас работает и при обновлении задачи без
дублирования логики.

## Проверка

```
npm run build          # OK
node test-agent-tools.mjs   # 49/49
node test-docs.mjs          # 113/113
```

## Наблюдения по плагину (вне задачи)

- `run_task_now`/`emit_event` в Code Mode упираются в in-process shutdown-gate:
  `{"success":false,"error":"Плагин выгружается: новые запуски не принимаются…"}`.
  Запуск через `schtasks /Run /TN "\OpenCode\agent-steward\<task>"` работает.
- `schtasks /End` оставляет запись прогона в статусе `running` навсегда.
- Free-модель `mimo-v2.6-flash-free` зависла на `ECONNRESET`; прогон на
  `deepseek-v4.1-flash-free` дошёл до правок, но упёрся в `Free usage limit
  reached` до создания ROADMAP/CHANGELOG/отчёта — артефакты дописаны вручную.
