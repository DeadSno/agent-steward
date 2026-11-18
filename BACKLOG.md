# BACKLOG — подтверждённые ошибки/доработки agent-stewed (ветка dev)

**Источник:** полный аудит среза ветки dev (HEAD 4c7ae055 от 17.11.2026 11:09 UTC).
**Подтверждение:** все 17 findings проверены на живой Windows-машине и по коду HEAD — см. [AUDIT-VERIFICATION.md](./AUDIT-VERIFICATION.md). Опровергнутых нет.
**Метод:** каждый finding проверен по коду/реестру (помечено «подтверждено»), не предположено.
**Схема:** Деталь → Задача → Подзадача. В работу берётся **1 подзадача за раз**; после выполнения — отчёт, затем следующая подзадача.
**Параллельно:** улучшения/фиксы/доработки добавляются в бэклог (P3) или спринт (P0–P2) в зависимости от важности.

---

## Статусы

| Метка | Значение |
|-------|----------|
| `🔴 P0` | Сломано прямо сейчас, у пользователей (критично) |
| `🟠 P1` | Реальные баги планировщика (код проверен, CI не ловит) |
| `🟡 P2` | Средние проблемы и несоответствия |
| `🔵 P3` | Улучшения / фиксы / доработки (по желанию) |
| `☐` | Запланировано (в бэклоге/спринте) |
| `⏳` | В работе (1 подзадача) |
| `✅` | Выполнено (с отчётом) |
| `⏸️` | Блокировано / требует доступа (npm publish, GitHub репо и т.п.) |

---

## 🔴 P0 — критично, сломано прямо сейчас

### Деталь P0-1: Published-шим opencode-windows-scheduler@1.5.7 не устанавливается (ETARGET)

**Подтверждено:** `legacy/package.json:40` — `"agent-steward": "^1.5.6"`; в npm publicado только `agent-steward@0.0.0-stage, 0.0.1, 0.0.2`. Диапазон `^1.5.6` не удовлетворяется ничем → `npm install opencode-windows-scheduler` падает с ETARGET.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-1.T1 | P0-1.T1.1 | Заменить `"agent-steward": "^1.5.6"` → `"agent-steward": "^0.0.2"` в `legacy/package.json` | ✅ |
| | P0-1.T1.2 | Добавить запись о `npm deprecate opencode-windows-scheduler@1.5.7` в CHANGELOG/скрипт релиза | ✅ |
| | P0-1.T1.3 | Добавить smoke-job в CI: `npm i opencode-windows-scheduler` в чистую директорию | ✅ |
| P0-1.T2 | P0-1.T2.1 | Опубликовать `agent-steward` версии, продолжающей линейку (2.0.0 или 0.0.3) — требует npm publish доступа | ✅ |
| | P0-1.T2.2 | Либо выпустить шим `1.5.8` с зависимостью `>=0.0.2` | ✅ |
| | P0-1.T2.3 | Задепрекейтить `opencode-windows-scheduler@1.5.7` через `npm deprecate` | ✅ |

---

### Деталь P0-2: Шим ломает TUI/GUI для пользователей старого имени

**Подтверждено:** `legacy/package.json:24-27` — все три subpath (`.`, `./tui`, `./gui-experimental`) ведут на `./index.js`; `files` содержит только `index.js` и `README.md`. OpenCode, загружая `opencode-windows-scheduler/tui`, получит backend-модуль вместо TUI/GUI.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-2.T1 | P0-2.T1.1 | Создать `legacy/tui.js`: `export * from "agent-steward/tui"; export { default } from "agent-steward/tui";` | ✅ |
| | P0-2.T1.2 | Создать `legacy/gui-experimental.cjs`: `module.exports = require("agent-steward/gui-experimental")` | ✅ |
| | P0-2.T1.3 | Обновить `exports` в `legacy/package.json` — маппинг `./tui` → `./tui.js`, `./gui-experimental` → `./gui-experimental.cjs` | ✅ |
| | P0-2.T1.4 | Добавить новые файлы в массив `files` в `legacy/package.json` | ✅ |

---

### ✅ Задача P0-3: «RPC is unavailable: opencode-windows-scheduler» в GUI

**Симптом:** панель «Планировщик» вместо данных показывает «Ошибка загрузки задач: RPC is unavailable: opencode-windows-scheduler»; сохранение настроек — та же ошибка. Повторяется каждые 5 секунд.

**Причина:** `Rpc.define({ id })` в `src/rpc.ts` — это и есть ключ реестра RPC. Сервер регистрирует обработчики как `ctx.rpc.register(SchedulerRpc, handlers)` под `SchedulerRpc.id`, а GUI строит URL `/api/rpc/<SchedulerRpc.id>/<method>` из **своего заранее собранного бандла** `gui-experimental.cjs`. При массовом переименовании id в `src/rpc.ts` стал `agent-steward`, а бандл остался с `opencode-windows-scheduler` → `Rpc.call` не находил запись и отдавал 400 `rpc.unavailable`.

**Подтверждение (лог `~/.local/share/opencode/log/opencode.log`):**
`POST /api/rpc/opencode-windows-scheduler/get_tasks → 400` каждые 5 секунд; при этом плагин загружался без ошибок.

**Исправление:**
- `src/rpc.ts`: id канала возвращён в `opencode-windows-scheduler` (совпадает с plugin id; менять нельзя).
- `npm run build:gui`: пересобран `gui-experimental.cjs` (раньше `npm run build` = только `tsc`, GUI-бандл оставался старым).
- `test-docs.mjs`: добавлен инвариант «id RPC-канала = plugin id = id в собранном бандле», чтобы рассинхрон ловился тестом.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P0-3.T1 | P0-3.T1.1 | Вернуть `SchedulerRpc.id = "opencode-windows-scheduler"` | ✅ |
| | P0-3.T1.2 | Пересобрать GUI-бандл (`npm run build:gui`) | ✅ |
| | P0-3.T1.3 | Инвариант в `test-docs.mjs`: src/rpc.ts = src/index.ts = gui-experimental.cjs | ✅ |
| | P0-3.T1.4 | Проверить в живом OpenCode: 200 на `/api/rpc/.../get_tasks` после перезапуска окна | ✅ |

**Подтверждение на живой машине (17.11.2026):** после перезапуска окна панель «Планировщик» показала задачи, ошибка «RPC is unavailable» не появляется. В логе после 13:01Z нет ни одного `POST /api/rpc/... → 400` (последний — 12:52:29Z, до фикса) и нет записи `RPC is unavailable`; OpenCode логирует только неуспешные RPC-ответы, поэтому успешные вызовы в лог не попадают.

---

## 🟠 P1 — реальные баги планировщика

### Деталь P1-3: Windows: `*/N * * * *` срабатывает не в те минуты

**Подтверждено:** `cron-to-schtasks.ts:126-129` — для N, делящих 60, возвращается `/sc MINUTE /mo N` без `/st`; `windows.ts:339-341` — gate не подключается для N|60 (комментарий в коде ложно утверждает, что семантики совпадают). schtasks якорит MINUTE на момент создания задачи.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-3.T1 | P1-3.T1.1 | В `cron-to-schtasks.ts` для паттерна 2 добавить `startTime: "00:00"` в `CronConversion` | ✅ |
| | P1-3.T1.2 | Обновить комментарий в коде — убрать ложное предположение о gate для N|60 | ✅ |
| | P1-3.T1.3 | Добавить unit-тесты: `*/15`, `*/30`, `*/60` проверяют наличие `/st 00:00` | ✅ |

---

### Деталь P1-4: POSIX: gate переноса окна убивается watchdog'ом → задача выполняется ВНЕ окна

**Подтверждено:** `bash.ts:233-238` — gate обёрнут в `run_with_timeout "$GATE_TIMEOUT_SECONDS"` (дефолт 300 с); только `exit 3` блокирует запуск. `schedule-gate.ts:46` — `MAX_POSTPONE_MS = 12 ч`, код возврата 124/137/143 ≠ 3 → враппер считает «можно запускать».

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-4.T1 | P1-4.T1.1 | Вынести `schedule-gate` из `run_with_timeout` или установить `GATE_TIMEOUT_SECONDS` ≥ 12 ч + запас | ✅ |
| | P1-4.T1.2 | Либо трактовать коды 124/137/143 как «skip» (exit 0) в bash-обёртке — не требуется, выбрано решение T1.1 | ✅ |
| | P1-4.T1.3 | Либо реализовать перенос без сна — через defer-файл и повторную проверку на каждом минутном тике — не требуется, выбрано решение T1.1 | ✅ |
| | P1-4.T1.4 | Исправить оставшийся defer-файл (stale-TTL до 25 часов) — не требуется, gate уже удаляет defer после пробуждения | ✅ |

---

### Деталь P1-5: Linux/macOS: задачи с чужой IANA-таймзоной не запускаются никогда

**Подтверждено:** `linux.ts:51` — `needsPollMode(entry.schedule)` без tz; `mac.ts` не учитывает tz вообще. В `types.ts:36` уже есть `timezone?: string` в `CreateTaskOptions`, но POSIX-бэкенды не используют его.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-5.T1 | P1-5.T1.1 | Убедиться, что `RegistryEntry` содержит `timezone` (добавлено в `registry.ts`) | ✅ |
| | P1-5.T1.2 | `linux.ts` `cronLine()` — передавать `tz` в `needsPollMode(schedule, tz)` | ✅ |
| | P1-5.T1.3 | `linux.ts` — при `tz ≠` системной включать `* * * * *` + gate (poll) — `needsPollMode` уже возвращает `true` для чужой зоны | ✅ |
| | P1-5.T1.4 | `mac.ts` `buildPlist()` — при чужой IANA-зоне `StartInterval 60` + gate | ✅ |
| | P1-5.T1.5 | `posix.ts` `createTask` — сохранять `options.timezone` в `RegistryEntry` | ✅ |

---

### Деталь P1-6: macOS: расширенный cron вообще не создаётся + `*/N` не выровнен

**Подтверждено:** `mac.ts:118` — `cronToLaunchdSchedule(entry.schedule)` напрямую без `try/catch` с poll-fallback; бросает ошибку для списков, диапазонов, `L`, `#`, `@daily` и др.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-6.T1 | P1-6.T1.1 | Оборачивать `cronToLaunchdSchedule` в `try/catch`, при ошибке ставить `StartInterval 60` (gate уже есть через `buildScheduleGate`) | ✅ |
| | P1-6.T1.2 | Для `*/N` — `StartCalendarInterval` с массивом минут `0, N, 2N, …` (выравнивание по cron-сетке; `StartInterval 60` без gate запускал бы каждую минуту) | ✅ |
| | P1-6.T1.3 | Добавить тесты для неконвертируемых cron и `*/N` на macOS (`test-mac-cron.mjs`: `* * * * *`, `*/15`, `*/7`, `@daily`, фиксированные день/месяц, списки, диапазоны, `L`, `5#2`, `*/0`, число полей) | ✅ |

---

### Деталь P1-7: Linux one-shot: id задания `at` ищется не в том потоке

**Подтверждено:** `linux.ts:205` — парсит только `stdout` (`/job\s+(\d+)/i`), GNU `at` печатает `job N` в `stderr`. `test-posix-e2e.mjs` не покрывает `at` (0 упоминаний).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-7.T1 | P1-7.T1.1 | Объединить `stdout` + `stderr` перед regex `/job\s+(\d+)/i` в `scheduleAt()` | ✅ |
| | P1-7.T1.2 | Добавить fallback, если `at` не установлен (`at-fallback.ts`: ENOENT → отвязанный `/bin/bash -c "sleep N; <cmd>"`, id `pid:<pid>`; `cancelAt` снимает процесс; предупреждение о том, что fallback не переживает перезагрузку; `test-at-fallback.mjs`) | ✅ |
| | P1-7.T1.3 | Добавить e2e-проверку с реальным `at` (требует живой машины — невыполнимо в песочнице без Node) | ⏸️ |

---

### Деталь P1-8: Windows: дата `/sd` захардкожена под русскую локаль

**Подтверждено:** `one-shot.ts:129` — `DD.MM.YYYY` (комментарий признаёт русскую локаль); `windows.ts:329` — заглушка `/sc ONCE /sd 31.12.2099`. На en-US (M/d/yyyy) «31.12.2099» невалидна.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P1-8.T1 | P1-8.T1.1 | Определять формат даты через PowerShell `((Get-Culture).DateTimeFormat.ShortDatePattern)` | ✅ |
| | P1-8.T1.2 | Либо регистрировать задачи через `Register-ScheduledTask` (culture-invariant) — не требуется, выбрано решение T1.1 | ✅ |
| | P1-8.T1.3 | Заменить заглушку «никогда» `31.12.2099` на ONCE-дату, вычисленную в формате локали | ✅ |
| | P1-8.T1.4 | Добавить тесты для en-US/zh-CN локалей — невыполнимо в песочнице без Node | ⏸️ |

---

## 🟡 P2 — средние проблемы и несоответствия

### Деталь P2-9: package-lock.json не перегенерирован после переименования

**Подтверждено:** корень лока — `opencode-windows-scheduler@1.5.6` против `agent-steward@0.0.2` в `package.json`; зависимости при этом совпадают.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-9.T1 | P2-9.T1.1 | Регенерировать `package-lock.json` (`npm install`) — выполнено, лок перегенерирован (пришёлся `npm install` прошёл успешно) | ✅ |
| | P2-9.T1.2 | Закоммитить обновлённый лок — требует git commit (репо не инициализирован локально) | ⏸️ |

---

### Деталь P2-10: exports без условия types; плавающие >= у OpenTUI; корневой index.js — мёртвый код

**Подтверждено:** `package.json:40-43` — `exports` без `"types"`; `package.json:143-144` — `"@opentui/core": ">=0.8.1"`, `"@opentui/solid": ">=0.8.1"`; `index.js:1` — `export { default } from './dist/index.js'` (теряет named-экспорты).

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-10.T1 | P2-10.T1.1 | Добавить `"types": "./dist/index.d.ts"` в условие `exports["."]` | ✅ |
| | P2-10.T1.2 | Добавить `"./package.json": "./package.json"` в `exports` | ✅ |
| P2-10.T2 | P2-10.T2.1 | Заменить `">=0.8.1"` на `"0.8.4"` или `"~0.8.4"` для `@opentui/core` и `@opentui/solid` | ✅ |
| P2-10.T3 | P2-10.T3.1 | Привести корневой `index.js` к `export * + default` (как в legacy) или удалить | ✅ |

---

### Деталь P2-11: PowerShell-инъекция через поля `model` / `workspaceName`

**Подтверждено:** `ps-wrapper.ts:961-969` — `safeModel = model.replace(/[\r\n"]+/g, "")` убирает только кавычки/переносы, `$`, backtick, `()` остаются; `-Model "${safeModel}"` в двойных кавычках → subexpression раскрывается.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-11.T1 | P2-11.T1.1 | Валидировать `model` по `^[A-Za-z0-9._:/-]+$` (provider/model id) | ✅ |
| | P2-11.T1.2 | Для строк в `psArgs` использовать одинарные кавычки с удвоением `'` либо `-EncodedCommand`/файл аргументов | ✅ |
| | P2-11.T1.3 | Применить ту же валидацию к `workspaceName` | ✅ (base64 — символы не ограничиваем, чтобы не ломать кириллицу/пробелы) |

---

### Деталь P2-12: мелкие баги кода

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-12.T1 | P2-12.T1.1 | `posix.ts runTask()` — добавить слушатель `error` на `spawn` (ENOENT при удалённой рабочей директории) | ✅ |
| P2-12.T2 | P2-12.T2.1 | `mac.ts` one-shot — добавить guard `now >= runAt` во враппер (StartCalendarInterval без года срабатывает в ближайшую годовщину) | ✅ |
| P2-12.T3 | P2-12.T3.1 | `windows.ts setTaskField()` — добавить китайский маппинг заголовков CSV schtasks (zh-Windows) | ✅ + нормализация пробелов в EN-ключах («Next Run Time» раньше не маппился вообще; `test-schtasks-locales.mjs` 38 заголовков, в цепочке npm test) |
| P2-12.T4 | P2-12.T4.1 | `types.ts validateTaskName` — исправить комментарий арифметики (префикс 28 → 209, не 30 → 207) | ✅ (также исправлен комментарий в test-task-name-limit.mjs: 29→208 → 28→209; префикс подтверждён запуском: WINDOWS_TASK_PREFIX = `\OpenCode\windows-scheduler\`, 28 символов) |
| P2-12.T5 | P2-12.T5.1 | `cron-to-schtasks.ts previousRunTime()` — мёртвый код (не используется, catch-up не реализован): удалить или доделать catch-up | ✅ удалён (использований в src/ и тестах нет; восстановим из git при реализации catch-up) |
| P2-12.T6 | P2-12.T6.1 | `vite.config.ts` — исправить комментарий (бандл пишется в корень `./gui-experimental.cjs`, не в `dist/`) | ✅ |

---

### Деталь P2-13: Инструмент `self_analysis` «потерян» в документации и тестах

**Подтверждено:** в коде 26 инструментов (`createToolHandlers`, `test-self-analysis.mjs` существует), но не в цепочке `npm test` (63 сюиты); README говорит «25 agent tools»; `test-docs.mjs` хардкодит «22 инструмента».

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-13.T1 | P2-13.T1.1 | Добавить строку `self_analysis` в `README.md`, `README.ru.md`, `README.zh.md`, `docs/FEATURES.md` | ✅ |
| | P2-13.T1.2 | Исправить счетчики инструментов (25 → 26) во всех README | ✅ |
| P2-13.T2 | P2-13.T2.1 | Добавить `node test-self-analysis.mjs` в цепочку `npm test` | ✅ |
| | P2-13.T2.2 | Обновить `test-docs.mjs` — брать количество инструментов из реестра кода, а не хардкодить | ✅ |
| | P2-13.T2.3 | Обновить числовые заявления (67 сюит вместо 58/56) | ✅ |

**Результат (17.11.2026):** `self_analysis` описан во всех README (`days?`, `topLimit?`, `includeAnomalies?`) и в `docs/FEATURES.md` / `FEATURES.zh.md` («Twenty-six tools» / «二十六个工具»). Счётчики: 26 инструментов в `README.md`, `docs/README.ru.md` (был уже 26), `docs/README.zh.md`; 67 сюит во всех трёх README. `test-self-analysis.mjs` (48 проверок) добавлен в `npm test`. `test-docs.mjs` теперь берёт список инструментов из `src/index.ts` (`name: "<tool>"`) и падает, если инструмент реестра не описан в FEATURES или если счётчик в README разошёлся с реестром. Прогон: `test-docs` 88/88, `test-self-analysis` 48/48.

---

### Деталь P2-14: GitHub-метаданные репозитория

**Подтверждено:** `package.json:7` — `homepage` на npm (старый broken-шим); description про «OpenCode v2 plugin» — проект dual V1/V2.

| Задача | Подзадача | Описание | Статус |
|--------|-----------|----------|--------|
| P2-14.T1 | P2-14.T1.1 | Изменить `homepage` с npm на `agent-steward` GitHub | ✅ |
| | P2-14.T1.2 | Синхронизировать `description` с README (dual V1/V2) | ✅ |

**Результат (17.11.2026):** `homepage` уже указывал на `https://github.com/DeadSno/agent-steward#readme` (совпадает с `repository` и `bugs`). `description` переписана под обе линии: «OpenCode plugin for V1 and V2: …» вместо «OpenCode v2 plugin …».

---

## 🔵 P3 — улучшения (бэклог, по важности)

| # | Улучшение | Куда | Статус |
|---|-----------|------|--------|
| P3-1 | Dependabot/Renovate + job `npm ci --dry-run` на свежем npm (ловит дрейф лока и плавающие `>=`) | Бэклог | ✅ |
| P3-2 | ESLint + lint-job (конфиг `.eslintrc.json` → `eslint.config.mjs` ESLint v10 flat config, скрипт `lint`/`lint-job` в package.json, шаг `Lint` в CI; `no-unsafe-*` и `no-unused-vars` — warn, не блокируют) | Бэклог | ✅ |
| P3-3 | Бампнуть majors actions: `checkout@v4`/`setup-node@v4` → v5+ (актуально на ноябрь 2026) | Бэклог | ✅ |
| P3-4 | PRAGMA `user_version` в SQLite — схема эволюционирует ad-hoc ALTER'ами, без версии схемы будущие миграции усложнятся (введены `SCHEMA_VERSION`, `getSchemaVersion()`, ступени `MIGRATIONS`, health отдаёт `schemaVersion`/`expectedSchemaVersion`, тест `test-user-version.mjs`) | Бэклог | ✅ |
| P3-5 | Release-workflow гоняет тесты только на ubuntu для тега — требовать зелёный CI тега или гонять матрицу (добавлен job `verify` с матрицей windows/ubuntu, `publish` зависит от него через `needs: verify`; macOS проверяется обычным CI на каждом push и в релизной матрице не дублируется — очередь macOS-раннеров блокировала publish) | Спринт (релизный риск) | ✅ |
| P3-6 | Шаблоны issues/PR, `test:triage-compare`-скрипт (сюита есть, ярлыка нет), `pretest:parallel`-билд для DX (добавлены `.github/ISSUE_TEMPLATE/*`, `pull_request_template.md`, скрипты `test:triage-compare` и `pretest:parallel`; инварианты в `test-docs`) | Бэклог | ✅ |
| P3-7 | В `test-docs` добавить проверку паритета zh (сейчас ru/en; zh покрыт `test-i18n` — продублировать контракт явно) | Бэклог | ✅ |
| P3-8 | Комментарий в `test-task-name-limit.mjs:1-3` («префикс = 29 → 208») неверен: фактически 28 → 209 (как и комментарий в `types.ts`) — поправить оба комментария | Бэклог | ✅ |
| P3-9 | Документация содержала устаревшие пользовательские пути `windows-scheduler` (CROSS_PLATFORM ru/en/zh, FAQ ru/en/zh, FEATURES en/zh, ARCHITECTURE) — приведены к `agent-steward` с пометкой о legacy-алиасинге; `test-docs` 96/96 | Бэклог | ✅ |
| P3-10 | GUI вызывал `get_shadow_report`, `reset_shadow_report`, `test_local_ai`, но методы отсутствовали в `SchedulerRpc.methods` → `TypeError: f.get_shadow_report is not a function` в Desktop; схемы добавлены, в `test-docs` введён инвариант «каждый `rpc.<method>` из gui.tsx объявлен в rpc.ts» | Бэклог | ✅ |
| P3-11 | Durable DAG, подзадача 36.1.a: `SCHEMA_VERSION` 2, таблицы `runs`/`run_steps` (status, attempt, idempotency_key, timestamps), миграционная ступень v2; репозиторий `src/db/runs-repo.ts` с валидацией переходов и `retryStep`; тест `test-run-state.mjs` в цепочке `npm test`; раздел «Durable run state» в ARCHITECTURE | Спринт 36 | ✅ |
| P3-12 | Durable DAG, подзадача 36.1.b: модуль `src/db/run-journal.ts` — каждый переход шага пишется в БД до и после тела (`beginStepAttempt`, `runStepStatefully`, `recordStepSuccess/Failure`); `recoverInterruptedSteps` помечает зависшие `running` как `failed`, сохраняя `attempt`; `PRAGMA synchronous = NORMAL` в WAL; тест `test-run-journal.mjs` с реальным `kill -9` посреди шага в цепочке `npm test` | Спринт 36 | ✅ |
| P3-13 | Durable DAG, подзадача 36.2: resume с середины — `SCHEMA_VERSION` 3 и колонка `run_steps.position` (миграция бэкфиллит порядок), `src/db/run-resume.ts` (`findResumeStep`, `resumeRunSync`/`resumeRun`, `reopenRun` failed → running), пропуск завершённых шагов, валидация обработчиков до побочных эффектов, `test-run-resume.mjs` с `kill -9` посреди линейной цепочки | Спринт 36 | ✅ |
| P3-14 | Durable DAG, подзадача 36.3: идемпотентные ключи шагов — `SCHEMA_VERSION` 4, частичный уникальный индекс `idx_run_steps_key_unique (run_id, idempotency_key)` с дедупликацией легаси-ключей в миграции; `src/db/step-idempotency.ts` (`runStepOnce`/`runStepOnceAsync`, replay из `output_json` без повторного тела, `IdempotencyConflictError`, `StepInFlightError`, retry failed с `attempt + 1`); тест `test-step-idempotency.mjs` (44 проверки, включая параллельные вызовы и переоткрытие БД) | Спринт 36 | ✅ |
| P3-15 | Durable DAG, подзадача 36.4: DLQ — `SCHEMA_VERSION` 5 и таблица `run_dlq` (snapshot `error`/`attempts`, статусы `open`/`retried`/`discarded`, частичный уникальный индекс `idx_run_dlq_open_unique`); `src/db/run-dlq.ts` (`scanDeadLetters` с порогом попыток, `retryDeadLetter` с переоткрытием запуска, `discardDeadLetter`, `listDeadLetters`/`countDeadLetters`); вложенные `withTransaction` через `SAVEPOINT`; тест `test-run-dlq.mjs` | Спринт 36 | ✅ |
| P3-16 | Роутер, подзадача 36.5.a: слой 1 — статические правила горячего пути — `src/core/router/rules.ts` (`STATIC_ROUTE_RULES`, `routeStaticStep`, `normalizeTaskType`, `isStaticTaskType`, `listStaticRouteRules`); модуль без импортов, неизвестный тип уходит слою 2; тест `test-router-rules.mjs` (22 проверки, 1000 маршрутизаций < 50 мс) | Спринт 36 | ✅ |
| P3-17 | Роутер, подзадача 36.5.b: слой 2 — Capability Map — `SCHEMA_VERSION` 6 и таблица `capability_map` (`success_rate`, `avg_cost_usd`, `avg_time_ms`, `last_10_runs`); `src/db/capability-repo.ts` (`recordCapabilityOutcome` со скользящими средними, `decideCapabilityRoute` с порогами 0.85/0.30 и `explore` при < 3 исходах, `getCapability`/`listCapabilities`); тест `test-capability-map.mjs` | Спринт 36 | ✅ |
| P3-18 | Роутер, подзадача 36.5.c: слой 3 — декомпозиция миссии — `src/core/router/planner.ts` (`planMission` вызывает декомпозер один раз на миссию, `planMissionSync` и `decomposeHeuristically` без модели, `needsDecomposition`); шаг содержит только `stepName`+`taskType`, маршрут остаётся слоям 1–2, неизвестные типы идут в `ambiguousTaskTypes`; тест `test-planner.mjs` | Спринт 36 | ✅ |
| P3-19 | Роутер, подзадача 36.5.d: эскалация при провале гейта — `src/core/router/escalation.ts` (`escalateAfterGate`: `local → cloud → review → blocked` по таблице переходов, `nextGateTarget`, `isEscalationExhausted`, `escalationChain`, без БД и модели); сборка маршрута `src/core/router/dispatch.ts` (`routeStep`: слой 1 → слой 2, `review`/`explore` без транспорта); тест `test-escalation.mjs` | Спринт 36 | ✅ |
| P3-20 | Роутер, подзадача 36.5.e: маршрутизация без модели для известных типов — `test-router-dispatch.mjs` доказывает, что статика отвечает до инициализации БД, не пишет в `capability_map`, а `dispatch.ts` не импортирует planner; 1000 маршрутов укладываются в миллисекунды | Спринт 36 | ✅ |
| P3-21 | Chaos-тест nightly, задача 36.5: `test-chaos-dag.mjs` убивает `SIGKILL` дочерний процесс посреди DAG-цепочки (`build`, затем `test`), проверяет durable-состояние до и после `recoverInterruptedSteps`, resume с прерванного шага с `attempt = 2`, отсутствие повторных вызовов завершённых шагов и `PRAGMA integrity_check`; `.github/workflows/nightly.yml` запускает тест по cron на windows-latest и ubuntu-latest; `npm run test:chaos` | Спринт 36 | ✅ |
| P3-22 | DLQ в GUI, задача 36.6: `src/core/dlq-api.ts` (фасад `listDlq`/`retryDlq`/`discardDlq`, нормализация фильтра `open/all/retried/discarded` и лимита), RPC `list_dlq`/`retry_dlq`/`discard_dlq` в `src/rpc.ts` и `src/index.ts`, аудит `dlq.retry`/`dlq.discard`, панель «♻️ Dead-letter queue» в `src/gui.tsx` (счётчик открытых, фильтр, таблица created/run+step/reason/attempts/error, retry и discard с подтверждением, тосты), локали ru/en/zh, `test-dlq-gui.mjs` | Спринт 36 | ✅ |
| P3-23 | Пауза с инъекцией контекста, задача 36.7: схема v7 — таблица `run_injections` (comment/file/artifact, автор, metadata, consumed_at), статус `paused` и `pauseRunRecord` с переходами RUN_TRANSITIONS; `src/db/run-context.ts` (`pauseRun`, `listRunInjections`, `pendingInjectionsForStep`, `consumeInjections`, `consumeOrphanInjections`, `SENSITIVE_KEY_RE`, `MAX_INJECTION_CONTENT`); `pauseRun` запрещена при running-шаге, терминальном запуске, завершённом/несуществующем шаге, без незавершённых шагов; секреты маскируются при записи (`redactSecretsInText`, JSON-ключи); `StepHandler` получает `StepContext {injections}`, `ResumeResult.injected`, вставки потребляются один раз при успешном шаге, `finalize` снимает осиротевшие вставки; тест `test-run-context.mjs` | Спринт 36 | ✅ |

---

## ✅ Что проверено и в порядке (для баланса)

Локали en/ru/zh — по 778 ключей, полный паритет. Криптография секретов (AES-256-GCM), permissions, lock-менеджер, cron-движок Vixie OR, двойной вход V1/V2, зависимости актуальны, CI/Release матрица, skill — подтверждено в аудите, изменений не требует.

---

## Порядок работы

1. Берётся **1 подзадача** из списка выше (начиная с P0, затем P1, P2, P3).
2. Подзадача выполняется (код/документация/конфиг).
3. Пишется отчёт о выполнении (что сделано, файлы, проверка).
4. Переходим к следующей подзадаче.
5. Параллельно новые улучшения/фиксы добавляются в бэклог (P3) или спринт (P0–P2).
