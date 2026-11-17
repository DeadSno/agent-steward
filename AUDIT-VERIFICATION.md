# Подтверждение findings аудита (qwen-4-max)

**Репозиторий:** DeadSno/agent-steward, ветка `dev`
**Проверенный срез:** `4c7ae05` (HEAD на момент проверки; на 3 docs-коммита новее npm-версии `agent-steward@0.0.2`, gitHead `a4b6927`)
**Дата проверки:** 17.11.2026
**Машина проверки:** Windows, Node v24.21.0, npm 12.2.0, git 2.56.1.windows.1, локаль `ru-RU` (`ShortDatePattern = dd.MM.yyyy`)

## Метод

Каждый finding проверялся тремя независимыми способами, где это возможно:

1. **Код на HEAD** — `git show HEAD:<path>` (не рабочее дерево, чтобы не спутать с уже внесёнными правками).
2. **Живой запуск** — `schtasks`, `npm view`, GitHub API на этой Windows-машине.
3. **Документация** — сверка обещаний README/CROSS_PLATFORM/MIGRATION с фактическим кодом.

Ограничения:
- Linux/macOS-бинари (`at`, `crontab`, `launchctl`) на Windows не запускались. Для P1-7 подтверждён код + документированное поведение GNU `at`; e2e требует живой Linux.
- Крупные UI/RPC-модули (`gui.tsx`, `rpc.ts`, `server.ts`, `notifications.ts`, `matrix.ts`) не перечитывались построчно — findings их не касаются.

## Сводка

| Вердикт | Кол-во |
|---------|--------|
| Подтверждено | **17 из 17** |
| Опровергнуто | 0 |
| Уточнено (формулировка/детали) | 2 (P2-12d, P1-5) |

Ни один finding не оказался ложным. Часть уже исправлена в рабочем дереве (см. «Статус исправлений»); исправления не публиковались.

---

## 🔴 P0

### P0-1 — Шим `opencode-windows-scheduler@1.5.7` не устанавливается

**Вердикт: ПОДТВЕРЖДЕНО (живой npm-реестр).**

```
npm view opencode-windows-scheduler version dependencies
# 1.5.7  { "agent-steward": "^1.5.6" }

npm view agent-steward versions
# [ "0.0.0-stage", "0.0.1", "0.0.2" ]   (latest = 0.0.2)
```

Диапазон `^1.5.6` не удовлетворяется ни одной опубликованной версией → `npm install opencode-windows-scheduler` падает с `ETARGET`. В `legacy/package.json` на HEAD та же зависимость `^1.5.6`. Promise в `docs/MIGRATION.md` («New installs resolve to agent-steward automatically») не выполняется.

### P0-2 — Шим ломает TUI/GUI

**Вердикт: ПОДТВЕРЖДЕНО (код).**

`legacy/package.json` на HEAD:

```json
"exports": {
  ".": "./index.js",
  "./tui": "./index.js",
  "./gui-experimental": "./index.js"
}
```

`legacy/index.js` = `export * from "agent-steward"; export { default } from "agent-steward"` — это backend-вход. При этом основной пакет отдаёт `./tui` → `src/tui.tsx` (`{ ...v2Tui, tui: tuiV1 }`) и `./gui-experimental` → CJS-бандл GUI. Загрузка `opencode-windows-scheduler/tui` вернёт backend-модуль → V1 не найдёт `tui`, V2 вызовет backend-setup() с TUI-контекстом.

---

## 🟠 P1

### P1-3 — Windows `*/N * * * *` срабатывает не в те минуты

**Вердикт: ПОДТВЕРЖДЕНО (живой `schtasks` + код).**

Живой эксперимент:

```
schtasks /create /tn TestNoSt /sc MINUTE /mo 15 ...
# StartBoundary = 2026-11-17T14:52:00  (момент создания)

schtasks /create /tn TestSt /sc MINUTE /mo 15 /st 00:00 ...
# StartBoundary = 2026-11-17T00:00:00
```

То есть без `/st` расписание якорится на момент создания (`:07, :22, :37, :52`), а cron означает `:00/:15/:30/:45`. В `cron-to-schtasks.ts` на HEAD паттерн MINUTE-step не возвращал `startTime`; `windows.ts` для N|60 не подключает gate, поэтому ошибка ничем не компенсируется. Комментарий «семантики совпадают» неверен: делимость необходима, но недостаточна — нужен выровненный старт.

### P1-4 — POSIX: gate переноса окна убивается watchdog'ом

**Вердикт: ПОДТВЕРЖДЕНО (код).**

`bash.ts` на HEAD оборачивает gate в `run_with_timeout "$GATE_TIMEOUT_SECONDS"` (default 300 с), а `schedule-gate.ts` в режиме `postpone` спит до `MAX_POSTPONE_MS = 12 ч`. По истечении 300 с watchdog убивает gate; ненулевой код возврата ≠ 3 → враппер считает «можно запускать» и запускает задачу вне окна `notBefore/notAfter`. На Windows гейт в `.cmd` без таймаута — там перенос работает.

Точный код возврата при убийстве зависит от реализации `run_with_timeout` (124/137/143); механизм подтверждён независимо от конкретного кода.

### P1-5 — Linux/macOS: чужая IANA-таймзона → задача не запускается

**Вердикт: ПОДТВЕРЖДЕНО (код + документация). Уточнение: `CreateTaskOptions.timezone` уже существовал, но POSIX-бэкенды его игнорировали.**

- `linux.ts` на HEAD: `needsPollMode(entry.schedule)` — без `tz`. Для `0 9 * * *` + `America/New_York` в crontab пишется нативная строка, срабатывающая в 09:00 системного времени.
- `schedule-gate` при этом получает `tz` из `src/index.ts:5693` (`buildScheduleGate(schedule, normalizedTz, ...)`) и проверяет «сейчас 09:00 в NY?» → `exit 3` каждый день. Итог: задача не запускается никогда.
- `mac.ts` таймзону не учитывал вообще.
- `RegistryEntry` на HEAD не имел `timezone`; `posix.ts createTask` не сохранял `options.timezone`.

Документация (`CROSS_PLATFORM.md:96,108-109`, `README.md:44`) обещает minute-poll + gate — на POSIX не реализовано.

### P1-6 — macOS: расширенный cron не создаётся + `*/N` не выровнен

**Вердикт: ПОДТВЕРЖДЕНО (код).**

`mac.ts cronToLaunchdSchedule` на HEAD поддерживает только `*`, `*/N`, `M`, `M H`, `M H D`. Списки (`0 9 * * 1,3`), диапазоны, `L`, `#`, `@daily` → `throw new Error("Неподдерживаемое cron-выражение для launchd.")`. `buildPlist` вызывает её напрямую, без `try/catch` → `schedule_task` падает. `*/N` → `StartInterval N*60`, который отсчитывается от момента загрузки агента, а не от сетки cron.

### P1-7 — Linux one-shot: id `at` ищется не в том потоке

**Вердикт: ПОДТВЕРЖДЕНО (код; e2e на Windows невозможен).**

`linux.ts` на HEAD: `const match = /job\s+(\d+)/i.exec(stdout);`. GNU `at` печатает `job N at ...` в **stderr**. Задание создаётся, но парсер возвращает ошибку «at не вернул id задания»; `atJobId` не попадает в реестр → one-shot нельзя отменить через pause/delete. `test-posix-e2e.mjs` не содержит упоминаний `at`.

### P1-8 — Windows: дата `/sd` захардкожена под русскую локаль

**Вердикт: ПОДТВЕРЖДЕНО (живой `schtasks` + код).**

На этой машине (`ru-RU`):

```
schtasks /create /sc ONCE /sd "12/31/2099" ...  → ошибка: недопустимое значение даты
schtasks /create /sc ONCE /sd "31.12.2099" ...  → успех
```

`one-shot.ts buildWindowsOneShotFlags` на HEAD жёстко формирует `DD.MM.YYYY`; `windows.ts` L329 содержит заглушку `/sc ONCE /sd 31.12.2099` для file/git/mcp. На `en-US` (`M/d/yyyy`) обе конструкции невалидны → создание one-shot и событийных задач падает.

---

## 🟡 P2

### P2-9 — package-lock.json не перегенерирован

**Вердикт: ПОДТВЕРЖДЕНО.** Корень лока на HEAD: `opencode-windows-scheduler@1.5.6`; `package.json`: `agent-steward@0.0.2`.

### P2-10 — exports без types; плавающие `>=`; мёртвый index.js

**Вердикт: ПОДТВЕРЖДЕНО.** `exports["."] = "./dist/index.js"` без `"types"`; `@opentui/core` и `@opentui/solid` — `">=0.8.1"`; корневой `index.js` реэкспортирует только default, теряя named-экспорты.

### P2-11 — PowerShell-инъекция через `model` / `workspaceName`

**Вердикт: ПОДТВЕРЖДЕНО.** `ps-wrapper.ts:962`: `model.replace(/[\r\n"]+/g, "")`; `:964`: `-Model "${safeModel}"`. Символы `$`, backtick, `()` не удаляются → PowerShell раскрывает subexpression. Bash-сторона безопасна (`shellQuote`).

### P2-12 — мелкие баги

| Подпункт | Вердикт | Доказательство |
|----------|---------|----------------|
| a) `posix.ts runTask` без `child.on("error")` | ПОДТВЕРЖДЕНО | `spawn("/bin/bash", ..., { detached:true, stdio:"ignore", cwd: entry.workingDirectory })` + `unref()`; при удалённом cwd асинхронный `ENOENT` станет uncaught. |
| b) macOS one-shot без года и без guard `runAt` | ПОДТВЕРЖДЕНО | `buildLaunchdCalendar` возвращает `{Month, Day, Hour, Minute}` без `Year`; `runAt` встречается только в `posix.ts:43`; задача с `runAt` > года сработает в ближайшую годовщину. |
| c) нет китайских заголовков CSV в `setTaskField` | ПОДТВЕРЖДЕНО | Маппинг есть для EN/RU/DE/ES/IT/PL; grep `任务|状态|文件夹` — пусто. |
| d) комментарий `validateTaskName` | ПОДТВЕРЖДЕНО С УТОЧНЕНИЕМ | Комментарий: «префикс 30 → 207». Фактически `1+8+1+17+1 = 28`, лимит `237−28 = 209`. **Код считает динамически и верен; неверен только комментарий.** |
| e) `previousRunTime` — мёртвый код | ПОДТВЕРЖДЕНО | Экспортируется (`cron-to-schtasks.ts:202`), других использований `git grep` не находит. |
| f) комментарий `vite.config.ts` | ПОДТВЕРЖДЕНО | Комментарий «пишет `dist/gui-experimental.cjs`», фактически `outFile: "./gui-experimental.cjs"` (корень). |

### P2-13 — `self_analysis` потерян в документации и тестах

**Вердикт: ПОДТВЕРЖДЕНО.** В коде 26 инструментов (`createToolHandlers`, `self_analysis` — `src/index.ts:3899`). В документации: `README.md:52` — «25 agent tools», `:126` — «26 tools»; `docs/README.ru.md:49,109` — «26»; `docs/README.zh.md:52,118` — «25»; `docs/FEATURES.md` — `self_analysis` отсутствует. `test-docs.mjs:37` — label «все 22 инструмента агента». Скрипт `test:self-analysis` есть в `package.json`, но `test-self-analysis.mjs` не входит в цепочку `test`. Числа сюит (58/56) устарели: фактически **65** файлов `test-*.mjs` (на момент проверки, включая новый `test-cron-to-schtasks.mjs`).

### P2-14 — GitHub-метаданные

**Вердикт: ПОДТВЕРЖДЕНО (GitHub API).** `api.github.com/repos/DeadSno/agent-steward`: `homepage = https://www.npmjs.com/package/opencode-windows-scheduler`, `description` — «OpenCode v2 plugin…» (проект dual V1/V2).

---

## 🔵 P3

**Вердикт: ПОДТВЕРЖДЕНО.**

- Нет ESLint-конфига и lint-скрипта (при наличии `eslint-disable` комментариев).
- Нет Dependabot/Renovate.
- Нет `PRAGMA user_version` в `src`.
- Нет шаблонов issue/PR (`.github` содержит только `workflows/ci.yml` и `workflows/release.yml`).
- `actions/checkout@v4`, `actions/setup-node@v4`.
- Release-workflow (`ubuntu-latest`) для тега гоняет `test:parallel` + `:en` + `:zh`; Windows-матрица на теге не проверяется.
- `CROSS_PLATFORM.md:133` («gui ~47.7 kB») и `:142` («.sh wrappers and crontab/launchd were never executed») устарели — CI гоняет posix-e2e.

---

## Новые находки, выявленные при подтверждении

1. **`CreateTaskOptions.timezone` существовал, но не доходил до POSIX.** Это уточняет P1-5: проблема не в отсутствии поля, а в том, что `posix.ts` его не сохранял, а `linux.ts`/`mac.ts` не читали.
2. **Регрессия в первой версии фикса macOS (исправлена).** Замена `*/N → StartInterval N*60` на `StartInterval 60` запускала бы задачу каждую минуту, потому что для нативного `*/N` gate не создаётся. Исправлено на массив `StartCalendarInterval` с минутами `0, N, 2N, …`. Урок: `StartInterval 60` допустим только там, где гарантированно есть gate (чужой tz или неконвертируемый cron).
3. **Чужая незакоммиченная работа в дереве.** `ROADMAP.md`, `ROADMAP-STRATEGY.md`, `docs/ARCHITECTURE.md` изменены, но не мной. Не перезаписывать без согласования.
4. **Фактическое число тестовых сюит — 65, не 63.** Расхождение с аудитом из-за подсчёта и нового `test-cron-to-schtasks.mjs`.

## Что проверено и оказалось в порядке

- Локали `en/ru/zh` — по **778** ключей, полный паритет (проверено скриптом).
- Криптография секретов, permissions, lock-менеджер, cron-движок Vixie OR, двойной вход V1/V2 — соответствуют заявленному (по аудиту; выборочно сверено с кодом).
- `@opencode-ai/plugin@1.19.5`, `chokidar@6.0.0`, `iconv-lite@0.7.3`, `zod@4.6.7`, Node 22.22.0 — существуют и совместимы.
- `npm run build` на текущем дереве — успешно.

## Статус исправлений (рабочее дерево, не опубликовано)

| ID | Статус | Комментарий |
|----|--------|-------------|
| P0-1 | ✅ код / ⏸️ публикация | `legacy` dep → `^0.0.2`, CHANGELOG, CI shim-smoke. Нужен `npm publish`/`npm deprecate`. |
| P0-2 | ✅ | `legacy/tui.js`, `legacy/gui-experimental.cjs`, exports + files. |
| P1-3 | ✅ | `startTime: "00:00"` + тест `test-cron-to-schtasks.mjs` (13/13). |
| P1-4 | ✅ | gate вынесен из `run_with_timeout`. |
| P1-5 | ✅ | `timezone` в `RegistryEntry`, `linux.cronLine(..., tz)`, `posix.createTask` сохраняет tz, `mac` учитывает tz. |
| P1-6 | ✅ | `try/catch` → poll; `*/N` → выровненный `StartCalendarInterval`; тест не добавлен. |
| P1-7 | ✅ код / ⏸️ e2e | парсинг `stdout+stderr`; e2e нужен Linux. |
| P1-8 | ✅ | определение формата через PowerShell + динамическая «никогда»-дата. |
| P2-9 | ✅ лок / ⏸️ коммит | лок перегенерирован. |
| P2-10 | ✅ | `types`, `./package.json`, `@opentui` 0.8.4, `index.js`. |
| P2-11 | ☐ | не начато. |
| P2-12 | ☐ | не начато. |
| P2-13 | ☐ | не начато. |
| P2-14 | ☐ | не начато (требует прав в настройках GitHub). |
| P3 | ☐ | бэклог. |

## Ограничения подтверждения

- P1-7: поведение GNU `at` (stderr) подтверждено документацией и кодом, но не живым запуском на Linux.
- P1-5/P1-6: `crontab`/`launchd` на Windows не запускались; проверены генерация строк/plist и сборка.
- P1-4: конкретный код возврата watchdog'а не измерялся; механизм подтверждён по коду.
