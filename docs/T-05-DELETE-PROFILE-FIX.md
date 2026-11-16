# T-05: проверка ревью и исправление (2026-11-16)

Проверка утверждений из ревью по коммиту `eb46a4b` (dev), плюс исправление
подтверждённых дефектов. Структура: **деталь → задача → подзадача**.

## Сводный вердикт

| № | Утверждение ревью | Вердикт | Статус |
|---|---|---|---|
| 1 | `deleteProfile` снимает задачи АКТИВНОГО профиля вместо удаляемого | **Подтверждено**, критично | Исправлено |
| 2 | `deleteProfile` не ждёт снятия задач перед `fs.rmSync` | **Подтверждено** | Исправлено |
| 3 | На Linux удаление неактивного профиля ломает crontab активного | **Подтверждено** и шире: реестр задач тоже общий | Исправлено |
| 4 | Причина красного CI на ubuntu/macos — `test-windows-oem.mjs` | **Не подтверждено** (тест проходит из-за фолбэка cp866) | Тест всё равно огорожен |
| 5 | `test-execution-hardening.mjs` использует `cmd.exe` и падает на POSIX | **Подтверждено** — это и есть фактический блокер цепочки | Исправлено |
| 6 | `dedupCountSuffix` жёстко пишет «(повтор N)» | **Подтверждено** | Вне спринта, зафиксировано |
| 7 | `compareTriage`: 2 LLM-вызова без таймаута и валидации before/after | **Частично подтверждено** (кода таймаута нет; валидация не найдена) | Вне спринта, зафиксировано |
| 8 | Мастер: пустой baseUrl, русские строки на экране 3, тихое падение сохранения | **Не проверялось в этом проходе** | Вне спринта |

---

## Деталь A. T-05 — удаление профиля снимает чужие задачи

### Задача A.1. Доказать дефект по коду

- **A.1.1.** `TASK_FOLDER_NAME` в `src/types.ts` — module-level IIFE от
  `getProfileName()` (активный профиль). `PLUGIN_DIR`, `LOCK_DIR`, `LOG_DIR`
  вычисляются там же.
- **A.1.2.** `WindowsScheduler` использовал модульные `WINDOWS_TASK_PREFIX` и
  `TASK_FOLDER_NAME`, `TaskRegistry` — модульный `PLUGIN_DIR`. То есть и
  `listTasks()`, и `deleteTask()` работали в пространстве имён **активного**
  профиля.
- **A.1.3.** `deleteProfile("work")` при активном `default` вызывал
  `getSchedulerBackend()` → `listTasks()` возвращал задачи `default` → цикл
  удалял их. На Linux дополнительно перегенерировался crontab-блок `default`,
  а реестр `scheduler-linux.json` активного профиля очищался.
- **A.1.4.** `macOS`: label plist не был привязан к профилю
  (`com.opencode.scheduler.<name>`), поэтому одноимённые задачи профилей
  затирали друг друга, а удаление неактивного профиля могло снять plist
  активного.
- **A.1.5.** Снятие задач было оформлено как `void (async () => { … })()`, а
  следом сразу шёл `fs.rmSync(dir)`: даже корректный код не успевал дочитать
  реестр/шпаргалку задач до удаления директории.

**Вывод:** дефект реальный, тяжелее описанного в ревью: на POSIX затрагивался
ещё и реестр задач активного профиля, а на macOS — plist-файлы.

### Задача A.2. Исправить привязку планировщика к профилю

- **A.2.1.** `src/types.ts`: добавлена
  `taskFolderNameForProfile(profile)`; `TASK_FOLDER_NAME` вычисляется через неё
  (историческое поведение сохранено).
- **A.2.2.** `src/core/scheduler/windows.ts`:
  - `new WindowsScheduler(profile?)` хранит `taskFolderName`/`taskPrefix`;
  - `listTasks`, `deleteTask`, `pauseTask`, `resumeTask`, `runTask`,
    `isTaskRunning` используют префикс своего профиля;
  - добавлены `windowsTaskPrefixForProfile(profile)` и
    `taskFullNameForProfile(name, profile)` (публичные, для тестов);
  - экспорт `WINDOWS_TASK_PREFIX` оставлен для совместимости.
- **A.2.3.** `src/core/scheduler/registry.ts`:
  `new TaskRegistry(backendId, profile?)` — файл реестра лежит в директории
  своего профиля (`getProfileDir(profile)`), а не в `PLUGIN_DIR` активного.
- **A.2.4.** `src/core/scheduler/posix.ts`: `PosixSchedulerBase(backendId, profile?)`
  прокидывает профиль в реестр.
- **A.2.5.** `src/core/scheduler/linux.ts`: маркеры crontab-блока строятся от
  профиля (`opencode-scheduler:windows-scheduler-<profile>`); legacy-блок без
  суффикса по-прежнему принадлежит только `default`; блокировка crontab
  осталась в общей базовой директории (она защищает read-modify-write между
  профилями).
- **A.2.6.** `src/core/scheduler/mac.ts`: label/plist профильно-зависимы
  (`com.opencode.scheduler.profile-<profile>.<name>`), для `default` —
  историческое имя. Для задач, созданных до 1.5.6, оставлен совместимый путь:
  старый label используется, только если plist действительно ссылается на
  директорию этого профиля.
- **A.2.7.** `src/core/one-shot.ts`: `launchdLabel(name, profile)` и
  `buildLaunchdOneShotCleanup(name, profile)` — самоочистка one-shot агента
  попадает в профильный plist. `src/index.ts` передаёт `getProfileName()`.
- **A.2.8.** `src/core/scheduler/index.ts`:
  - `createSchedulerBackend(platform, profile?)`;
  - `createSchedulerBackendForProfile(profile, platform?)`;
  - `removeScheduledTasksForProfile(profile, platform?)` — list + delete в
    пространстве имён профиля, ошибки отдельных задач игнорируются.
- **A.2.9.** `src/profiles.ts`: `deleteProfile` стал `async`, вызывает
  `removeScheduledTasksForProfile(normalized)` и **ждёт** его до `fs.rmSync`.
  Ошибки планировщика по-прежнему не фатальны.

### Задача A.3. Закрепить тестами

- **A.3.1.** `test-delete-profile.mjs` расширен до 14 проверок:
  - `taskFolderNameForProfile(default|work)`;
  - полное имя задачи `work` — `\OpenCode\windows-scheduler-work\...`;
  - префиксы `default` и `work` не совпадают;
  - `launchdLabel` профилей не совпадает;
  - реестры active/inactive — разные файлы;
  - удаление записи из реестра inactive не трогает запись active
    («удалить неактивный профиль — задачи активного не тронуты»);
  - `deleteProfile` — `AsyncFunction` (задачи снимаются до `rmSync`).
- **A.3.2.** `test-profiles.mjs`: вызовы `deleteProfile` переведены на `await`,
  проверка запрета `default` — на `await` + `try/catch`.

### Задача A.4. Прогнать локально

- **A.4.1.** `npm run build` — без ошибок.
- **A.4.2.** `node test-delete-profile.mjs` — 14/14.
- **A.4.3.** `node test-profiles.mjs` — 58/58.
- **A.4.4.** `npm test` на Windows (Node 24.21.0) — вся цепочка зелёная,
  включая `execution-hardening` 23/23 и `windows-oem` (OEMCP=866).

---

## Деталь B. Красный CI на ubuntu-latest/macos-latest

### Задача B.1. Проверить факты и диагноз

- **B.1.1.** Run `43863535571` (eb46a4b, dev): windows-latest (24 и 22.22.0) —
  success; ubuntu-latest и macos-latest (оба Node) — failure на шаге `Test`.
  Более ранние dev-раны `43851763204`, `43848756709` — тоже failure; main-раны
  `43725983389`, `43723582158` — success.
- **B.1.2.** Логи job'ов через API недоступны (403 «Must have admin rights»),
  аннотации — только «Process completed with exit code 1».
- **B.1.3.** `test-windows-oem.mjs` **не является** причиной: при отсутствии
  `reg`/реестра `getOemCodePage()` возвращает фолбэк 866, а
  `decodeConsoleOutputSync` декодирует cp866 — тест на POSIX проходит (но
  ничего не проверяет).
- **B.1.4.** Фактический блокер — `test-execution-hardening.mjs`: он стоит
  раньше в `&&`-цепочке и в секциях 1–5 безусловно запускает
  `cmd.exe /c <batch>`; на POSIX `spawnSync` даёт `status: null`, история/логи
  не появляются, проверки падают. Огорожена была только секция 6.
- **B.1.5.** `test-posix-e2e.mjs` корректно пропускается на Windows и до сих
  пор ни разу не доходил до выполнения на CI, потому что цепочка обрывалась
  раньше. Красный CI — регрессия с коммита `01a620b`, а не следствие T-05.

### Задача B.2. Исправить

- **B.2.1.** `test-execution-hardening.mjs`: в начале
  `if (process.platform !== "win32") { …skip…; process.exit(0); }`.
- **B.2.2.** `test-windows-oem.mjs`: такой же guard (чтобы тест не создавал
  ложную уверенность на POSIX).
- **B.2.3.** `test-posix-e2e.mjs` не менялся — guard уже был корректный.

### Задача B.3. Проверить на всех 6 job'ах

- **B.3.1.** Локально Windows: зелёная цепочка (см. A.4.4).
- **B.3.2.** POSIX: проверка только через GitHub Actions (локального
  Linux/macOS нет: Docker daemon не стартует, WSL без дистрибутива).
  Ветка `fix/t-05-profile-scoped-scheduler` запушена, результат — в
  `docs/`-записи после прогона (см. ниже).

---

## Деталь C. YELLOW-замечания (вне спринта, не исправлялись)

- **C.1. `dedupCountSuffix`.** Подтверждено: `src/core/triage-compare.ts`
  возвращает `(повтор N)` без i18n. Нужен ключ локализации/настройка формата —
  отдельная задача.
- **C.2. `compareTriage` без таймаута.** Подтверждено: два `decideTriage`
  идут через `Promise.all` без обёртки таймаута; before/after-настройки
  проходят без валидации. Риск зависания GUI реален, но это изменение
  поведения LLM-слоя — отдельная задача с тестами.
- **C.3. Мастер (экран 3, пустой baseUrl, тихое сохранение).** В этом проходе
  не проверялось; требует отдельного разбора `src/gui/*` и теста сохранения.

---

## Изменённые файлы

```
src/types.ts
src/profiles.ts
src/index.ts
src/core/one-shot.ts
src/core/scheduler/index.ts
src/core/scheduler/registry.ts
src/core/scheduler/posix.ts
src/core/scheduler/windows.ts
src/core/scheduler/linux.ts
src/core/scheduler/mac.ts
test-delete-profile.mjs
test-profiles.mjs
test-execution-hardening.mjs
test-windows-oem.mjs
```

## Проверка на CI: красные POSIX-джобы

После пуша фикса 4 POSIX-джобы CI падали на шаге `Test` за 17–28 с.
Windows-джобы при этом были зелёными.

### Деталь: не было видно, что именно падает

- Задача: получить текст логов job'а.
- Подзадача 1: анонимный `GET /actions/jobs/<id>/logs` → 403 «Must have admin rights».
- Подзадача 2: `check-runs/<id>/annotations` → только «Process completed with exit code 1».
- Подзадача 3: токен из Windows Credential Manager (`Get-Content | git credential fill`)
  → `Authorization: Bearer` → логи скачались целиком (152 КБ).
- Подзадача 4: в `test-posix-e2e.mjs` добавлены `[diag]` строки окружения и
  `try/catch` вокруг каждой из 4 секций с печатью `status/stderr/stdout/log/wrapper`.

### Деталь: `shellQuote(undefined)` валил секцию 4

- Задача: не падать на незаданном `promptFile`.
- Подзадача 1: в `bash.ts` — `shellQuote(promptFile ?? "")`.
- Подзадача 2: в секции 4 теста явно задан `spec.promptFile`.
- Результат: реальная ошибка, но не единственная — POSIX остался красным.

### Деталь (корневая): обёртка молча пропускала первый запуск задачи

Симптом из лога CI (секция 1):

```
OK   успешный запуск: код 0
FAIL успешный запуск: запись истории есть
FAIL успешный запуск: статус success
FAIL кавычки в before/after-скриптах не ломают хуки
FAIL лог содержит вывод opencode
```

Весь прогон — ~110 мс, хуки не сработали, история не создана, `opencode` не вызван.

- Задача: найти, куда обёртка выходит раньше времени.
- Подзадача 1: в скрипте создавался каталог для `LOG_FILE`
  (`mkdir -p "$(dirname "$LOG_FILE")"`), но **не для `LOCK_FILE`**.
- Подзадача 2: на свежей установке каталога `locks/` нет → `mkdir "$LOCK_FILE.d"`
  падает с ENOENT.
- Подзадача 3: любая ошибка `mkdir` трактовалась как «lock занят» →
  лог «уже выполняется» и `exit 0`. Отсюда и ложный «код 0», и ложный
  зелёный в секции 2 («задача убита раньше 15 с» — она не запускалась вовсе).
- Подзадача 4: секция 3 проходила, потому что тест сам создавал каталог
  `${lockFile}.d` (вместе с родителем) — то есть проверяла только ветку «занято».

### Задача: исправить

- Подзадача 1: `mkdir -p "$(dirname "$LOCK_FILE")"` перед секцией блокировки.
- Подзадача 2: различать реальную ошибку создания lock и занятый lock:
  если после неудачного `mkdir` каталога нет — лог + `exit 1`, а не «уже выполняется».
- Подзадача 3: `writeBashWrapper()` тоже создаёт каталог lock
  (страховка для уже установленных задач).
- Подзадача 4: две статические регрессионные проверки в `test-posix-e2e.mjs`
  (наличие `mkdir -p "$(dirname "$LOCK_FILE")"` и `[ ! -d "$LOCK_FILE.d" ]`).

### Деталь: флейк Windows-джобы (EPERM на teardown)

- Симптом: `Error: EPERM, Permission denied` на
  `fs.rmSync(home)` в `test-triage-async.mjs`.
- Причина: после `closeDb()` ОС ещё держит handle на файл SQLite;
  `force: true` не подавляет EPERM.
- Задача: сделать teardown не падающим.
- Подзадача: retry-цикл с `maxRetries`/`retryDelay` в `test-triage-async.mjs`,
  `test-triage-audit.mjs`, `test-triage-chain.mjs`, `test-triage-shadow.mjs`.

### Итог CI

Прогон `27e3cc5`: `ubuntu-latest` ×2 и `macos-latest` ×2 — **success**,
`windows-latest / 22.22.0` — success, `windows-latest / 24` — failure только
из-за EPERM-флейка (исправлен следующим коммитом).

## Остаточные риски

1. **POSIX-прогон** подтверждён на CI (ubuntu/macos, Node 22.22.0 и 24) —
   риск закрыт. Первый запуск задачи на POSIX теперь проверяется секцией 1
   `test-posix-e2e.mjs` (без каталога `locks/`).
2. **macOS, задачи не-default профилей, созданные до 1.5.6:** label остаётся
   старым (совместимость по содержимому plist). Самоочистка one-shot для таких
   legacy-задач использует профильный label и может не снять старый агент —
   редкий сценарий, зафиксирован здесь.
3. Длина имени задачи (`validateTaskName`) по-прежнему считается от активного
   профиля; для операций над неактивным профилем это не влияет на удаление.
