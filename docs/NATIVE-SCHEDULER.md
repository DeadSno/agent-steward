# AD-1.1 — Режим `nativeScheduler`

Плагин поддерживает два источника триггера фоновых задач:

| Режим | Кто будит задачу | Что сохраняется |
|---|---|---|
| `polling` (по умолчанию) | `schtasks` / `cron` / `launchd` | ledger, DLQ, бюджеты, approval, execution loop |
| `native` | хост OpenCode через свой планировщик/событие | те же инварианты — хост только доставляет триггер |

Это **не новый движок**: нативный бэкенд (`src/core/scheduler/native.ts`) пишет
в тот же `TaskRegistry`, что и POSIX-бэкенды, а запуск делегирует колбэку
рантайма `run_task_now` → `RunContext` → `buildExecutionPlan` →
`executeExecutionPlan`. Ledger (`scheduler.db`), DLQ, дневные/недельные бюджеты,
approval и все гейты остаются в ядре и не дублируются в хосте.

## Настройка

В `settings.json`:

```json
{
  "nativeScheduler": { "mode": "auto", "host": "" }
}
```

- `polling` — принудительно старый путь (независимо от хоста).
- `native` — принудительно нативный путь; требует подтверждённой capability.
- `auto` (по умолчанию) — нативный путь только если хост объявил capability.

Capability объявляется переменными окружения:

- `OPENCODE_NATIVE_SCHEDULER=1` (или `true`/`on`/`yes`) — хост готов будить задачи.
- `OPENCODE_NATIVE_SCHEDULER_HOST=...` — имя хоста (по умолчанию `opencode-native`).
- `OPENCODE_NATIVE_SCHEDULER_CAPS=ledger,dlq,budgets,approval,execution-loop` —
  список capability. Если список задан, но пропускает любой из обязательных
  инвариантов, capability считается недоступной (fail-closed).

## Привязка к ОС

Режим платформо-независим: `detectNativeSchedulerHost(env, platform)` принимает
ОС только для информационного поля `platform` в контракте хоста. Тесты
`test-native-scheduler.mjs` проверяют и `win32`, и `linux`, и `darwin`, а также
работу без явной ОС. При отсутствии capability `auto` всегда откатывается на
`polling` — поведение существующих установок не меняется.

## Ограничения

- Рантайм должен зарегистрировать фабрику нативного бэкенда
  (`registerNativeSchedulerFactory`) с реестром и колбэком запуска; иначе выбор
  `native` завершается `NativeSchedulerUnavailableError`, а не тихим обходом ядра.
- Текущая версия OpenCode не объявляет нативный планировщик, поэтому на
  практике работает `polling`. Режим подготовлен заранее как ответ на триггер
  пересмотра из CONCEPT §13.
