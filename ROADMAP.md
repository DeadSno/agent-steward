# 🗺️ Roadmap — agent-steward

> North Star: [docs/CONCEPT.md](./docs/CONCEPT.md) — верифицируемая локально-первая оркестрация агент-задач.
> Это не «планировщик». Планировщик/уведомления/аналитика — триггеры и обвязка, не ядро (§8 CONCEPT).
>
> Модель работы — канбан. Каждая задача разложена слоями:
> **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг).
> В работу берётся ровно одна подзадача: подзадача → отчёт → следующая подзадача.
> Приоритеты P0/P1/P2/P3. Спринты и версии к задачам не привязаны.

Текущая версия: **agent-steward 0.0.4** (18.11.2026).
Legacy: `opencode-windows-scheduler@1.5.8`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже выпущено — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ✅ готово · ⏸️ внешнее действие · ❌ опровергнуто.

---

# 1. Бэклог (аудит 18.11)

## Деталь 1.1 — Recovery и жизненный цикл запуска
`src/db/history-repo.ts`, `src/db/run-journal.ts`, `src/core/record-history.ts`, `src/db/schema.ts`

**Задача B1 — Recovery не трогает живые запуски** · P1 · ⬜

`recoverInterrupted()` помечает все `finished_at IS NULL` как `error` без проверки PID/владельца/возраста. Перезапуск плагина во время живого прогона финализирует его досрочно.

- [ ] B1.1 Миграция schema v8: `owner_pid`, `owner_host`, `owner_started_at` в `history` (аддитивно, идемпотентно)
- [ ] B1.2 Recorder `--start` пишет владельца (PID процесса-обёртки, host id, время старта)
- [ ] B1.3 `recoverInterrupted()`: пропускать живого владельца, добивать мёртвого или просроченного по возрасту
- [ ] B1.4 Подключить в startup + лог «восстановлено N, оставлено живым M»
- [ ] B1.5 Тесты: живой PID, мёртвый PID, legacy-строка без владельца, превышение возраста
- [ ] B1.6 Docs/CHANGELOG, счётчик schema в `test-docs`

## Деталь 1.2 — Ретраи
`src/core/ps-wrapper.ts`, `src/core/record-history.ts`

**Задача B2 — Один слой ретраев на Windows** · P1 · ⬜

PS-обёртка ретраит сама, recorder добавляет свои → `(1+N)²` вместо `1+N`, «ретрейт-штормы» и лишние деньги.

- [ ] B2.1 Убрать retry-цикл из PS-обёртки
- [ ] B2.2 Оставить единственным владельцем ретраев recorder (retryCount/retryDelay)
- [ ] B2.3 Тест: N ретраев = ровно N+1 запуск на Windows и POSIX
- [ ] B2.4 Docs: поведение ретраев на обеих полосах

## Деталь 1.3 — Dashboard HTTP
`src/server.ts`

**Задача B3 — XSS через атрибуты дашборда** · P1 · ⬜

`esc()` не экранирует кавычки, значения вставляются в `title=`/`style=`/`data-*` → скрипт в контексте дашборда с доступом к API.

- [ ] B3.1 `esc()` экранирует `"` и `'` для текстового и атрибутного контекста
- [ ] B3.2 Пройти все интерполяции в атрибуты (`title`, `style`, `data-*`, `href`)
- [ ] B3.3 Тест: payload с кавычками не ломает разметку и не исполняется
- [ ] B3.4 CSP-заголовок дашборда (defense in depth)

## Деталь 1.4 — Release CI
`.github/workflows/release.yml`

**Задача B16 — Publish только по тегу, permissions ужать** · P1 · ⬜

`workflow_dispatch` публикует в npm без проверки тега; `id-token: write` выдан всем job'ам.

- [ ] B16.1 Публикация только если ref — тег `v*`
- [ ] B16.2 `id-token: write` / `contents: write` только у publish-job
- [ ] B16.3 Guard: `package.json` version == тег
- [ ] B16.4 `workflow_dispatch` = dry-run без публикации

## Деталь 1.5 — Профили и порты
`src/server.ts`, `src/core/profile*.ts`

**Задача B4 — Порт профиля не пересекается с default** · P2 · ⬜

`allocateProfilePort()` начинает с 3782; `isOwnDashboardOn()` не сверяет профиль → второй профиль показывает данные чужого профиля.

- [ ] B4.1 `isOwnDashboardOn()` сверяет профиль/идентификатор инстанса
- [ ] B4.2 Аллокатор порта исключает порты всех профилей
- [ ] B4.3 Тест: два профиля одновременно, данные не смешиваются
- [ ] B4.4 Docs: нумерация портов профилей

## Деталь 1.6 — macOS launchd
`src/core/*launchd*`, `src/core/install-entry*`

**Задача B5 — `installEntry` уважает `paused` и пробрасывает ошибки `load`** · P2 · ⬜

`launchctl load -w` снимает паузу (гонка); ошибки `launchctl` глотаются → битый plist = задача молча не запланирована.

- [ ] B5.1 Не вызывать `load -w` для приостановленной задачи
- [ ] B5.2 Пробрасывать stderr/exit code `launchctl` в результат установки
- [ ] B5.3 Тест/ручная проверка: paused остаётся paused, битый plist даёт ошибку
- [ ] B5.4 Docs

## Деталь 1.7 — Lock-файлы
`src/core/lock.ts`, `src/core/ps-wrapper.ts`, POSIX-обёртка

**Задача B6 — Единый формат lock-токена Node ↔ PS ↔ bash** · P2 · ⬜

PS пишет `ISO|PID`, Node парсит `^(\d+)-` → год принимается за PID. PS не распознаёт Node-токен → вытесняет живой Node-лок.

- [ ] B6.1 Единый формат `<pid>-<iso>` + общий парсер
- [ ] B6.2 PS читает и Node-, и legacy-токен
- [ ] B6.3 bash читает оба формата
- [ ] B6.4 Тест interop: Node-лок не вытесняется PS, и наоборот
- [ ] B6.5 Docs

**Задача B7 — `.lock.d` вытесняется только по мёртвому PID** · P2 · ⬜

Каталог `.lock.d` старше 24 ч вытесняется без чтения pid-файла → дубль задачи после рестарта плагина.

- [ ] B7.1 Читать PID из `.lock.d` перед вытеснением
- [ ] B7.2 Возраст — только fallback при отсутствии PID
- [ ] B7.3 Тест: живой PID не вытесняется, мёртвый вытесняется
- [ ] B7.4 Docs

## Деталь 1.8 — POSIX crontab
`src/core/*cron*` (`stripBlock`)

**Задача B9 — `stripBlock` не режет чужой crontab** · P2 · ⬜

Незакрытый блок вырезает всё до EOF, включая пользовательские cron-задачи.

- [ ] B9.1 Удалять только строки внутри маркеров
- [ ] B9.2 Незакрытый блок → fail-closed, файл не трогаем
- [ ] B9.3 Тест: чужие cron-строки после блока сохраняются
- [ ] B9.4 Docs

## Деталь 1.9 — Legacy recorder
`src/core/record-history.ts`

**Задача B10 — Legacy-режим парсит usage из лога** · P2 · ⬜

Legacy-ветка не парсит `usage` из 11-го аргумента (`$LOG_FILE`) → токены и стоимость теряются.

- [ ] B10.1 Парсить usage из лог-файла
- [ ] B10.2 Graceful fallback, если usage нет
- [ ] B10.3 Тест на legacy-запись с usage
- [ ] B10.4 Docs

## Деталь 1.10 — Prompt / argv
`src/core/ps-wrapper.ts` (Windows и POSIX)

**Задача B11 — Промпт через `--` и off-by-one `131072`** · P2 · ⬜

Промпт передаётся без `--`; промпт с `-` парсится как флаг `opencode`. Проверка `-gt` вместо `>=`.

- [ ] B11.1 Вставить `--` перед промптом
- [ ] B11.2 `-ge` вместо `-gt` для лимита argv
- [ ] B11.3 Тест: промпт, начинающийся с `-`
- [ ] B11.4 Docs

## Деталь 1.11 — Durable runs / lease
`src/db/run-journal.ts`, `src/db/schema.ts`

**Задача B12 — Lease/owner на `run_steps`** · P2 · ⬜

`recoverInterruptedSteps()` помечает `failed` все `running`-шаги, включая живые чужие процессы. В `run_steps` нет владельца/lease (CONCEPT §5).

- [ ] B12.1 Колонки `owner_id`, `lease_until` в `run_steps` (schema v8)
- [ ] B12.2 Продление lease при выполнении шага
- [ ] B12.3 Recovery: `failed` только при истёкшем lease
- [ ] B12.4 Тест: два процесса, живой шаг не убивается
- [ ] B12.5 Docs

## Деталь 1.12 — Capability map (router)
`src/db/capability-repo.ts`

**Задача B13 — Decay + `first_pass_rate`** · P2 · ⬜

`success_rate` кумулятивный без затухания; `last_10_runs` не участвует в решении (CONCEPT §5, §6.3).

- [ ] B13.1 Затухание успеха (half-life)
- [ ] B13.2 `first_pass_rate` (успех с первой попытки)
- [ ] B13.3 Участие `last_10_runs` в выборе
- [ ] B13.4 Тест: старые успехи не перевешивают свежие провалы
- [ ] B13.5 Docs

## Деталь 1.13 — Дедуп уведомлений
`src/notifications.ts` (`tokenize`)

**Задача B14 — CJK-токенизатор дедупа** · P2 · ⬜

Regex вырезает CJK → китайские сообщения дают нулевой вектор, семантический дедуп для `zh` не работает.

- [ ] B14.1 Токенизация CJK (bigram или `Intl.Segmenter`)
- [ ] B14.2 Тест: zh-сообщения дают ненулевой вектор и дедупятся
- [ ] B14.3 Docs

## Деталь 1.14 — PS watchdog
`src/core/ps-wrapper.ts`

**Задача B8 — WMI-фолбэк таймаута** · P3 · ⬜

При сбое `Get-CimInstance` список процессов пуст → нет маркера и нет kill, таймаут fail-open; внуки теряются.

- [ ] B8.1 Фолбэк через `Get-Process`/`tasklist` при сбое CIM
- [ ] B8.2 Нет данных → fail-closed: kill по дереву процессов
- [ ] B8.3 Тест
- [ ] B8.4 Docs

## Деталь 1.15 — `at`-fallback
`src/core/at-fallback.ts`

**Задача B15 — маркер в cmdline (ложное срабатывание)** · P3 · ❌

Проверено по коду: маркер присутствует в cmdline весь жизненный цикл (`at-fallback.ts:111,143-146`), prune идёт через локальный реестр (`registry.save`, строка 296). Дефекта нет.

- [x] B15.1 Повторная проверка по коду — подтверждено, что маркер есть
- [x] B15.2 Закрыть как «не баг», зафиксировать в CHANGELOG (Known issues не требуется)

---

# 2. Задачи согласно архитектуре (Execution model)

agent-steward — execution engine с опциональной регистрацией триггеров. Четыре входа ведут в один путь исполнения; планировщик ОС — только полоса A (cron/once), а не центральный маршрут. Оркестрация (цепочки, DAG, ретраи, матрицы, эскалации) выполняется ядром и рекордером прямыми запусками обёрток.

## Деталь 2.1 — Ядро исполнения
`src/core/runtime.ts`, `src/core/run-*.ts`, `src/db/*`

**Задача AC-1 — Единый путь: createRun → план → маршрут → исполнение → GATE → ledger** · P2 · ⬜

- [ ] AC-1.1 Контракт `RunContext` (вход, задача, профиль, безопасность)
- [ ] AC-1.2 Абстракция исполнителя вместо OpenCode-специфичного транспорта
- [ ] AC-1.3 Dry-run план и трассировка маршрута
- [ ] AC-1.4 Тест: ad-hoc и registered проходят один путь
- [ ] AC-1.5 Docs

**Задача AC-2 — Quality Gate с before/after хуками** · ✅

- [x] AC-2.1 Гейт после прогона, поворот статуса при неудаче
- [x] AC-2.2 before/after хуки
- [x] AC-2.3 Тест гейта

**Задача AC-3 — История, метрики и аудит мутаций** · ✅

- [x] AC-3.1 `history` / `metrics` / `audit_log`
- [x] AC-3.2 Аудит через все интерфейсы (tools/RPC/GUI/CLI)
- [x] AC-3.3 Тест счётчиков

**Задача AC-4 — Durable DAG: journal, resume, идемпотентность, DLQ, пауза с инъекциями** · ✅

- [x] AC-4.1 `runs` / `run_steps` / `run_dlq` / `run_injections`, schema v7
- [x] AC-4.2 `BEGIN IMMEDIATE` + SAVEPOINT, идемпотентные ключи
- [x] AC-4.3 resume/pause, DLQ retry
- [x] AC-4.4 chaos-nightly
- [ ] AC-4.5 Lease на шагах (→ B12)

**Задача AC-5 — Router: 3 слоя (rules → capability-repo → planner/escalation/dispatch)** · ✅

- [x] AC-5.1 Известный тип не доходит до модели
- [x] AC-5.2 Capability-map из истории
- [x] AC-5.3 Тест маршрутизации
- [ ] AC-5.4 Decay и first_pass_rate (→ B13)

## Деталь 2.2 — Полоса A: Registered (ОС-планировщик, только cron/once)
`src/core/win-scheduler*`, `src/core/launchd*`, `src/core/posix*`

**Задача RA-1 — schtasks / launchd / crontab: регистрация и удаление** · ✅

- [x] RA-1.1 Windows Task Scheduler
- [x] RA-1.2 launchd
- [x] RA-1.3 crontab
- [ ] RA-1.4 macOS paused/ошибки `load` (→ B5)
- [ ] RA-1.5 Безопасный `stripBlock` (→ B9)

**Задача RA-2 — Legacy-алиасинг и one-shot** · ✅

- [x] RA-2.1 schtasks ONCE
- [x] RA-2.2 `at` + detached `sleep` fallback
- [x] RA-2.3 Совместимость со старыми записями

## Деталь 2.3 — Полоса B: Direct / Ad-hoc (без регистрации в ОС)
`src/core/*runtime*`, `src/core/chain*`, `src/core/matrix*`, `src/db/run-*`

**Задача AB-1 — `run_task_now`: прямой запуск обёртки** · ✅

- [x] AB-1.1 POSIX: `spawn("/bin/bash", [wrapper])`
- [x] AB-1.2 Windows: run-now API планировщика, но прямой запуск
- [x] AB-1.3 Тот же wrapper, что и у полосы A

**Задача AB-2 — Цепочки `nextTaskOnSuccess` / `nextTaskOnError`** · ✅

- [x] AB-2.1 Рекурсия через recorder
- [x] AB-2.2 Защита от циклов
- [x] AB-2.3 Тест

**Задача AB-3 — DAG-зависимости (`dependsOn`)** · ✅

- [x] AB-3.1 Запуск после успешных зависимостей
- [x] AB-3.2 Обработка провала зависимости
- [x] AB-3.3 Тест

**Задача AB-4 — Ретраи (`retryCount` / `retryDelay`)** · ✅

- [x] AB-4.1 Атомарный retry-счётчик
- [x] AB-4.2 Задержка между попытками
- [ ] AB-4.3 Убрать дубль на Windows (→ B2)

**Задача AB-5 — Матрицы** · ✅

- [x] AB-5.1 Fan-out `expandMatrixTask`
- [x] AB-5.2 Агрегация и sync
- [x] AB-5.3 Cancel и orphan cleanup

**Задача AB-6 — Пауза / resume** · ✅

- [x] AB-6.1 `resumeRun` в процессе хоста
- [x] AB-6.2 Инъекции контекста
- [x] AB-6.3 Тест

**Задача AB-7 — Escalation** · ✅

- [x] AB-7.1 Таблица переходов local → cloud → review → blocked
- [x] AB-7.2 Без вызова модели
- [x] AB-7.3 Тест

**Задача AB-8 — `run_mission` (CLI / GUI / RPC)** · P2 · ⬜

- [ ] AB-8.1 Спецификация ad-hoc миссии (гейт + safety-контракт)
- [ ] AB-8.2 CLI `agent-steward run`
- [ ] AB-8.3 RPC/GUI
- [ ] AB-8.4 Тест без регистрации в ОС
- [ ] AB-8.5 Docs

## Деталь 2.4 — Run wrapper (единица исполнения обеих полос)
`src/core/ps-wrapper.ts`, POSIX-обёртка

**Задача RW-1 — schedule-gate** · ✅

- [x] RW-1.1 poll-mode, IANA timezone
- [x] RW-1.2 окна запуска, defer/force-маркеры
- [x] RW-1.3 fail-closed на невалидном cron

**Задача RW-2 — Lock + watchdog timeout** · ⬜ (B6, B7)

- [ ] RW-2.1 Единый формат lock-токена (→ B6)
- [ ] RW-2.2 `.lock.d` только по мёртвому PID (→ B7)
- [ ] RW-2.3 Watchdog fail-closed (→ B8)

**Задача RW-3 — Env/secrets + политика** · ✅

- [x] RW-3.1 hybrid/secure/legacy
- [x] RW-3.2 AES-256-GCM секреты
- [x] RW-3.3 `OPENCODE_CONFIG_CONTENT` с правами задачи

**Задача RW-4 — `opencode run --auto` → Quality Gate → хуки** · ✅

- [x] RW-4.1 Единый для прямого и registered запуска
- [ ] RW-4.2 Промпт через `--` (→ B11)

**Задача RW-5 — One-shot cleanup** · ✅

- [x] RW-5.1 Windows: удаление OS-записи
- [x] RW-5.2 POSIX: удаление cron/at-записи

## Деталь 2.5 — Recorder process
`src/core/record-history.ts`

**Задача RC-1 — История / метрики → SQLite** · ✅

- [x] RC-1.1 На профиль, schema v7
- [x] RC-1.2 Атомарный retry-счётчик

**Задача RC-2 — Ретраи прямым запуском обёртки** · ✅

- [x] RC-2.1 Оркестрация в ядре, не в ОС
- [ ] RC-2.2 Единственный слой ретраев (→ B2)

**Задача RC-3 — Цепочки / DAG прямым запуском** · ✅

- [x] RC-3.1 `dependsOn`
- [x] RC-3.2 `nextTaskOnSuccess/Error`

**Задача RC-4 — Матрицы: агрегация** · ✅

- [x] RC-4.1 `runMatrix`
- [x] RC-4.2 `finalizeMatrixIfComplete`

**Задача RC-5 — One-shot cleanup (Windows)** · ✅

- [x] RC-5.1 Удаление OS-записи после прогона

**Задача RC-6 — Уведомления** · ✅

- [x] RC-6.1 webhook / Telegram / тосты
- [x] RC-6.2 Дедуп, 512-мерный FNV-1a, локальный триаж
- [ ] RC-6.3 CJK-токенизация (→ B14)

## Деталь 2.6 — Данные
`src/db/schema.ts`, `src/db/*-repo.ts`

**Задача DA-1 — SQLite WAL, миграции** · ✅

- [x] DA-1.1 `node:sqlite`, WAL
- [x] DA-1.2 `PRAGMA user_version`, аддитивные миграции
- [ ] DA-1.3 Schema v8 для owner/lease (→ B1, B12)

**Задача DA-2 — Таблицы** · ✅

- [x] DA-2.1 `tasks` / `history` / `metrics` / `settings` / `templates` / `workspaces`
- [x] DA-2.2 `audit_log` / `git_state` / `notification_*`
- [x] DA-2.3 `runs` / `run_steps` / `run_dlq` / `run_injections` / `capability_map`

**Задача DA-3 — Секреты AES-256-GCM** · ✅

- [x] DA-3.1 AAD=имя, 12-байт IV, ключ 0600/icacls
- [x] DA-3.2 Карантин и межпроцессный лок

## Деталь 2.7 — Триггеры в процессе (без ОС)
`src/triggers.ts`, `src/server.ts`

**Задача TR-1 — file (chokidar)** · ✅
- [x] TR-1.1 Watch, debounce, игноры

**Задача TR-2 — git (poll HEAD)** · ✅
- [x] TR-2.1 Коммиты, ветка, путь, игнор

**Задача TR-3 — mcp-event** · ✅
- [x] TR-3.1 Совпадение server + event → подписчики

**Задача TR-4 — webhook `/api/hooks`** · ✅
- [x] TR-4.1 HMAC, timestamp, raw-body, лимит тела

---

# 3. Остальные задачи (не бэклог и не архитектура)

## Деталь 3.1 — Pipeline-as-code
`src/core/pipeline-*.ts`, `src/cli.ts`, `docs/PIPELINE.md`

**Задача PI-1 — Спецификация `opencode.pipeline.yaml`** · ✅

- [x] PI-1.1 Типы `PipelineSpec` / `PipelineStep`
- [x] PI-1.2 DAG, matrix, QG, окна, политики, бюджеты

**Задача PI-2 — Парсер и валидатор** · ✅

- [x] PI-2.1 YAML → spec
- [x] PI-2.2 Валидатор: циклы, `needs`, cron, matrix, имена, модели
- [x] PI-2.3 `test-pipeline.mjs`

**Задача PI-3 — Идемпотентный diff/apply** · ✅

- [x] PI-3.1 `planPipelineApply` / `executePipelineApply`
- [x] PI-3.2 Маркеры `pipelineName` / `pipelineStepId`
- [x] PI-3.3 Без миграции БД

**Задача PI-4 — CLI `pipeline validate|apply|export`** · ✅ (`c55ecef`)

- [x] PI-4.1 `bin` в `package.json`
- [x] PI-4.2 Точки входа в `src/cli.ts`
- [x] PI-4.3 Smoke-тест пройден

**Задача PI-5 — Агент-инструменты/RPC** · ✅ (`c55ecef`)

- [x] PI-5.1 3 ToolSpec (`pipeline_validate|apply|export`)
- [x] PI-5.2 3 RPC-метода
- [x] PI-5.3 Счётчики 26→29 инструментов, 53→56 RPC

**Задача PI-6 — Документация** · P2 · ⬜

- [ ] PI-6.1 `docs/PIPELINE.md`
- [ ] PI-6.2 Пример `opencode.pipeline.yaml`
- [ ] PI-6.3 Раздел в README ru/en/zh

**Задача PI-7 — Приёмка** · P2 · ⬜

- [ ] PI-7.1 Полный `npm test`
- [ ] PI-7.2 `npm run build`
- [ ] PI-7.3 `npm run lint` (0 ошибок)
- [ ] PI-7.4 Коммит в `dev`

## Деталь 3.2 — Worktree-изоляция
`src/core/worktree*`

**Задача W-1 — Одноразовый git worktree на запуск** · P2 · ⬜
- [ ] W-1.1 Создание worktree под запуск
- [ ] W-1.2 Передача пути в контекст задачи
- [ ] W-1.3 Тест fan-out без Docker

**Задача W-2 — Политика очистки** · P2 · ⬜
- [ ] W-2.1 Удаление после прогона
- [ ] W-2.2 Защита от остатков и гонок

**Задача W-3 — Guard-условия** · P2 · ⬜
- [ ] W-3.1 Shell-guard
- [ ] W-3.2 Семантический guard

**Задача W-4 — Статус `skipped`** · P2 · ⬜
- [ ] W-4.1 Статус для пропущенных guard'ами
- [ ] W-4.2 Отображение в GUI/истории

## Деталь 3.3 — Экономика v2
`src/core/budget*`, `src/analytics*`

**Задача E-1 — Бюджеты день/неделя** · P2 · ⬜
- [ ] E-1.1 Лимиты и учёт
- [ ] E-1.2 Авто-пауза при превышении
- [ ] E-1.3 Алерт

**Задача E-2 — Per-task token budgets** · P2 · ⬜
- [ ] E-2.1 Лимит на задачу
- [ ] E-2.2 Остановка при превышении

**Задача E-3 — Token efficiency score** · P3 · ⬜
- [ ] E-3.1 Метрика и расчёт

**Задача E-4 — Прогноз и Grafana JSON** · P3 · ⬜
- [ ] E-4.1 Прогноз затрат
- [ ] E-4.2 Экспорт в Grafana

**Задача E-5 — Local vs cloud** · P3 · ⬜
- [ ] E-5.1 Разбивка запусков и стоимости

## Деталь 3.4 — Docker runner
`src/core/runner*`

**Задача D-1 — Runner local/docker/ssh** · P3 · ⬜
- [ ] D-1.1 Интерфейс runner
- [ ] D-1.2 Docker
- [ ] D-1.3 SSH

**Задача D-2 — Opt-in и обратная совместимость** · P3 · ⬜
- [ ] D-2.1 Без Docker работает как раньше

**Задача D-3 — Детерминизм вердикта** · P3 · ⬜
- [ ] D-3.1 Та же спека → тот же вердикт

## Деталь 3.5 — Approvals и окружения (0.1.0)
`src/core/approval*`, `src/core/environment*`

**Задача A-1 — R2/R3 approval-гейт** · P2 · ⬜
- [ ] A-1.1 Ручное подтверждение перед деплоем
- [ ] A-1.2 Аудит решений

**Задача A-2 — dev/staging/prod** · P2 · ⬜
- [ ] A-2.1 Изоляция сред
- [ ] A-2.2 Привязка задач к среде

**Задача A-3 — Артефакты запуска** · P3 · ⬜
- [ ] A-3.1 Отчёты/coverage как артефакты

**Задача A-4 — Docs-сайт** · P3 · ⬜
- [ ] A-4.1 Публикация документации

**Задача A-5 — 4-я локаль (tr)** · P3 · ⬜
- [ ] A-5.1 Переводы и тесты локалей

**Задача A-6 — Telegram pause/resume** · P3 · ⬜
- [ ] A-6.1 Команды бота
- [ ] A-6.2 Привязка к запускам

## Деталь 3.6 — Мульти-агентная оркестрация (0.2.x+)
`src/core/agents*`

**Задача M-1 — Context artifacts** · P3 · ⬜
- [ ] M-1.1 Сквозной контекст (CONCEPT §13.2)

**Задача M-2 — Crew / роли** · P3 · ⬜
- [ ] M-2.1 worker → reviewer

**Задача M-3 — Self-correcting retry** · P3 · ⬜
- [ ] M-3.1 Post-mortem и повтор

**Задача M-4 — Model fallback + confidence** · P3 · ⬜
- [ ] M-4.1 Фолбэк между моделями

**Задача M-5 — Tournament A/B** · P3 · ⬜
- [ ] M-5.1 Сравнение моделей и промптов

**Задача M-6 — CEP и входящие события** · P3 · ⬜
- [ ] M-6.1 Complex Event Processing

**Задача M-7 — Cross-run memory** · P3 · ⬜
- [ ] M-7.1 Память между прогонами

**Задача M-8 — Smart recipes** · P3 · ⬜
- [ ] M-8.1 Самонастраивающиеся конвейеры

## Деталь 3.7 — Инфраструктура и релиз (внешние действия)
`package.json`, npm, GitHub

**Задача X-1 — `npm deprecate` legacy** · P1 · ⏸️
- [ ] X-1.1 Депрекейт `opencode-windows-scheduler@1.5.8`

**Задача X-2 — Legacy 1.5.9 с `<0.1.0`** · P1 · ⏸️
- [ ] X-2.1 Upper bound, чтобы breaking 0.1.0 не прилетел

**Задача X-3 — `is_template: false`** · P3 · ⏸️
- [ ] X-3.1 Убрать из `package.json`

**Задача X-4 — Dependabot** · P2 · ⏸️
- [ ] X-4.1 Мерж #4 (plugin 2.3.0)
- [ ] X-4.2 OpenTUI 0.9.0

**Задача X-5 — Теги/релизы/версии** · P2 · ⏸️
- [ ] X-5.1 Привести теги к существующим релизам
- [ ] X-5.2 GitHub release для каждого тега

**Задача X-6 — `systemd` в keywords** · P3 · ⏸️
- [ ] X-6.1 Убрать, бэкенда нет

---

# 4. Правила работы (канбан)

1. **Одна подзадача за раз.** Взял → сделал → отчёт → следующая подзадача.
2. **Слой не пропускается.** Деталь → задача → подзадача; подзадача закрывается только с тестом и документацией.
3. **Нет спринтов.** Статусы ⬜ → 🔄 → ✅ независимо от релизов.
4. **Версия — следствие релиза, а не обещание.** `npm version` в момент релиза.
5. **Приоритет — по боли пользователя.** P1 = без этого нельзя рекомендовать плагин.
6. **Fail-open по умолчанию.** Необязательная подсистема при отказе деградирует, а не блокирует.
7. **Сверка с CONCEPT.md.** Четыре столпа (§4), без противоречий §8.
8. **Честность в маркетинге.** Оценки — с методикой рядом.

---

# 5. Release-чеклист

- [ ] `package.json` version == tag; CI verify зелёный.
- [ ] CHANGELOG обновлён; шапка ROADMAP и SECURITY.md supported versions в порядке.
- [ ] `test-docs` (инструменты/RPC/schema/сюиты/локали) зелёный.
- [ ] GitHub release создан для тега.
- [ ] Пока жив legacy: диапазон шима актуален, deprecation не снят.
- [ ] Критические баги аудита закрыты или документированы как known issues.
