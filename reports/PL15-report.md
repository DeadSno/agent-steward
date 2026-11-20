# PL15 — отчёт исполнителя Детали 1.5 ROADMAP.md (20.11.2026)

Ветка: `dev`. ОС: Windows. Задача: закрыть открытые находки PL-1.1, PL-1.2,
PL-2.1, PL-2.2, PL-3.1, PL-3.2, PL-4.1 без изменения поведения остального плагина.

## Статусы находок

| ID | Статус | Что сделано / причина |
| --- | --- | --- |
| PL-1.1 | сделано | В `src/index.ts` (`runTaskEntry`) вместо плоской строки бросается `PluginShutdownError` с `code='PLUGIN_SHUTTING_DOWN'`, неизменным `message` («Плагин выгружается: новые запуски не принимаются. Повторите после перезапуска.») и `hint` (повтор после перезапуска; для once/cron — `locks/<slug>.lock.force` + `Start-ScheduledTask`/`schtasks /run` либо отложенный запуск). Схема поля `name` инструмента `run_task_now` дополнена описанием этого кода. Ограничение: MCP-обёртка по-прежнему сериализует в результат только `message` (совместимость); `code`/`hint` доступны на объекте ошибки внутренним вызывающим — изменение сериализации выходит за объявленный под-scope `src/index.ts`. |
| PL-1.2 | сделано | В `skills/scheduled-job-best-practices/references/recipes.md` добавлен раздел 9: обходной путь через `schtasks /run` / `Start-ScheduledTask`, force-маркер `locks/<slug>.lock.force`, снятие маркера обёрткой, предупреждение о дублях при комбинировании путей и явная проверка `get_history`/`get_task_logs` и `nextTask`-цепочек после рестарта плагина. |
| PL-2.1 | сделано | В `SKILL.md` §4 зафиксировано правило: если промпт требует самопроверки через `node`/`npm test`/`pytest` — сразу дать `shell` в `allowedTools` либо перенести проверки целиком в `qualityGate`/`afterScript`; добавлены строка в таблицу антипаттернов и пункт финального чек-листа. |
| PL-2.2 | сделано | В `src/core/dry-run.ts` добавлено предупреждение, когда промпт содержит команды проверки (`npm test`, `node`, `pytest`, `go/dotnet test`, `test`, «тест»), а shell эффективно запрещён (`allowedTools`/`deniedTools`/политика hybrid; исключение — `legacyShell: true`). Новые ключи i18n не вводились: каталоги локалей вне SCOPE. |
| PL-3.1 | сделано | В `SKILL.md` §3 добавлен шаблон промпта для правок планирующих документов: точный формат строки ROADMAP, обязательные бэктики только для существующих файлов и явный чек-лист артефактов (ROADMAP, CHANGELOG, TEST-PLAN §5, отчёт, команды верификации). Обновлён финальный чек-лист. |
| PL-3.2 | сделано | `test-test-plan.mjs` расширен двумя проверками: закрытые `Деталь 1.4 / TP-3…TP-6` отсутствуют в `ROADMAP.md` (ни заголовок, ни строки `[ ]`/`[x]`) и зафиксированы в `CHANGELOG.md`. Проген: 19/19. |
| PL-4.1 | частично: сделано в `get_analytics` | В `src/index.ts` счётчик `tool.blocked` добавлен в отчёт MCP `get_analytics` и RPC `get_analytics` за то же окно `days`, что и аналитика, как нейтральная метрика корректности прав (поле `report.toolBlocked`, не ошибка). Дашборд не изменён: он берёт аналитику из `GET /api/analytics` (`src/server.ts`) и рендерит её в `src/gui.tsx` — оба файла вне SCOPE, поэтому без их правки счётчик в UI не появится. |

## Затронутые файлы

- `src/index.ts` — `PluginShutdownError`, `runTaskEntry`, описание `run_task_now.name`, счётчик `toolBlocked` в MCP/RPC `get_analytics`.
- `src/core/dry-run.ts` — детектор команд самопроверки и предупреждение при запрещённом shell.
- `skills/scheduled-job-best-practices/SKILL.md` — правила PL-2.1/PL-2.2 и шаблон промпта PL-3.1.
- `skills/scheduled-job-best-practices/references/recipes.md` — обходной путь PL-1.2.
- `test-test-plan.mjs` — проверки PL-3.2.
- `reports/PL15-report.md` — настоящий отчёт.

`ROADMAP.md`, `CHANGELOG.md`, `package.json`, `scripts/`, `dist/`, `gui-experimental.cjs`,
`legacy/` не редактировались. Коммит и push не выполнялись. Суб-агенты не спавнились.
`eslint --fix` не запускался; `as any`, `@ts-ignore`, `eslint-disable` не добавлялись.

## Верификация

| Команда | Результат |
| --- | --- |
| `npm run build` | exit 0, 0 ошибок `tsc` |
| `node test-test-plan.mjs` | 19/19 проверок, `TEST-PLAN.md: OK` (включая две новые проверки PL-3.2) |
| `npm run lint:baseline` | exit 0, «новых предупреждений нет — 355 warning (baseline 543, -188)», не хуже базовой линии |
| `node test-docs.mjs` (доп.) | 109/109, `Docs: OK` — счётчики инструментов/RPC и мета-гейт не сломаны |
| `node test-run-now.mjs` (доп.) | 8/8 OK — запуск «сейчас» и force-маркеры работают |

Итог: 7 находок обработаны (6 полностью, PL-4.1 — в части `get_analytics`;
визуализация в дашборде требует правки файлов вне SCOPE).
