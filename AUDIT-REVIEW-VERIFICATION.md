# Аудит и план исправлений: opencode-windows-scheduler

> Источник 주장: ревью (перечисленные 9 пунктов + остаточные T-05).
> Методика: каждое утверждение проверено против реального кода репозитория
> (`package.json`, `tsconfig.json`, `src/**`, `.github/workflows/*`, `README.md`,
> `docs/T-05-DELETE-PROFILE-FIX.md`). Ниже — подтверждённые факты, приговор
> (подтверждено / не подтверждено / не баг), ссылки на строки и план работ.

---

## 0. Итоговый сводный вердикт

| № | Утверждение ревью | Вердикт | Статус | Приоритет |
|---|-------------------|---------|--------|-----------|
| 1 | `exports["."]` / `exports["./tui"]` указывают на `.ts` файлы | **Подтверждено** | ✅ Исправлено (T-1) | 🔴 Критично |
| 2 | `--auto` всегда + опасные инструменты разрешены по умолчанию | **Подтверждено** | ✅ Исправлено (T-2) | 🔴 Критично |
| 3 | `x-scheduler-client` доверяется без проверки Origin | **Подтверждено** | ✅ Исправлено (T-3) | 🟠 Высоко |
| 4 | `chmodPrivate` — no-op на Windows, ключ без DPAPI/ACL | **Подтверждено** | ✅ Исправлено (T-4) | 🟠 Высоко |
| 5 | `writePromptFile` / `lockFilePath` не санитизируют внутри себя | **Подтверждено (частично)** | ✅ Исправлено (T-5) | 🟡 Средне |
| 6 | README "Runs without OpenCode open" неполно для file/git/mcp-event | **Подтверждено** | ✅ Исправлено (T-6) | 🟡 Средне |
| 7 | `npm test` — длинная последовательная цепочка через `&&` | **Подтверждено** | ⏸ Осознанно не меняем (T-7) | 🟡 Средне |
| 8 | `release.yml` не запускает `npm run test:en` | **Подтверждено** | ✅ Исправлено (T-8) | 🟡 Средне |
| 9 | "25 agent tools" vs "25 tools" — несоответствие | **Не подтверждено** | Ничего не делать | 🟢 Низко |

---

## 1. Детали (проверенные утверждения)

### 1.1. exports указывает на TypeScript-файлы — ПОДТВЕРЖДЕНО (Критично)

**Где:**
- `package.json:37` — `"main": "dist/index.js"`
- `package.json:40-44`:
  ```json
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx",
    "./gui-experimental": "./gui-experimental.cjs"
  }
  ```
- `tsconfig.json:19` — `"exclude": ["node_modules", "dist", "src/tui.tsx", "src/gui.tsx"]`
- `dist/` содержит `index.js`, но **нет** `tui.js` (подтверждено чтением директории `dist`)

**Что происходит:**
Node.js при импорте пакета по имени отдаёт приоритет полю `exports` и игнорирует `main`.
`import("opencode-windows-scheduler")` → Node попытается загрузить `src/index.ts` →
`ERR_UNKNOWN_FILE_EXTENSION` (если загрузчик не поддерживает TypeScript).
`./tui` указывает на `src/tui.tsx`, который исключён из `tsconfig` — скомпилированной версии не существует.
Пакет фактически неработоспособен для стандартного импорта.

**Рекомендация (подтверждена):** заменить `exports["."]` на `./dist/index.js`, `exports["./tui"]` — на
скомпилированный `./dist/tui.js` (или убрать точку `./tui`, если TUI не доставляется в npm-пакете).

---

### 1.2. --auto в PowerShell-обёртке и default permissions — ПОДТВЕРЖДЕНО (Критично)

**Где:**
- `src/core/ps-wrapper.ts:614` — `$opencodeArgs = @("run", "--auto")` (всегда, без условий)
- `src/core/ps-wrapper.ts:528-539` — `$defaultPermissions` разрешает **все** инструменты с `effect = "allow"`:
  `read`, `edit`, `glob`, `grep`, `shell`, `subagent`, `skill`, `question`, `webfetch`, `websearch`
- `src/core/ps-wrapper.ts:542-562` — ограничение возможно только через `$DeniedTools` или `$AllowedTools`,
  которые передаются опционально из задачи

**Что происходит:**
Если пользователь не задал `allowedTools`/`deniedTools`, по умолчанию разрешены опасные инструменты
(`shell`/`bash`, `edit`/`write`). Фоновая задача (запущенная через schtasks, автономно) может выполнить
разрушительные команды без подтверждения. Это особенно рискованно для CI/CD-оркестратора.

**Рекомендация (подтверждена):**
- явно задокументировать, какие permissions действуют по умолчанию;
- ограничить опасные инструменты, требуя явного `allowedTools` для их использования;
- либо сделать `--auto` опциональным (включать только при явном `autoApprove: true` в задаче).

---

### 1.3. Доверие по заголовку x-scheduler-client — ПОДТВЕРЖДЕНО (Высоко)

**Где:**
- `src/server.ts:313-315`:
  ```ts
  export function isDashboardRequestTrusted(req: http.IncomingMessage): boolean {
    const headers = req.headers ?? {};
    if (headers["x-scheduler-client"]) return true;
    ...
  }
  ```
- `src/server.ts:734` — вызов `isDashboardRequestTrusted(req)` для всего `/api/*` (кроме `/api/hooks`)

**Что происходит:**
Запрос считается доверенным **сразу**, если присутствует заголовок `x-scheduler-client` — до任何 проверки `Origin`.
Если злоумышленник может заставить браузер отправить этот заголовок (XSS на странице дашборда, или CORS
настроен слишком разрешающе и позволяет установить произвольные заголовки), защита обходитсz. Даже при
внешнем `Origin` заголовок принимается без проверки.

**Рекомендация (подтверждена):**
- убедиться, что CORS не разрешает произвольные источники;
- не принимать `x-scheduler-client` от запросов с внешним `Origin` — проверять Origin **даже при наличии**
  заголовка (defence-in-depth).

---

### 1.4. Шифрование секретов на Windows — ПОДТВЕРЖДЕНО (Высоко)

**Где:**
- `src/core/secrets.ts:88-95`:
  ```ts
  function chmodPrivate(file: string): void {
    if (process.platform === "win32") return;
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  ```
- `src/core/secrets.ts:113` — ключ записывается с `mode: 0o600`, но на Windows биты режима largely ignored;
  фактически ACL определяют доступ.

**Что происходит:**
На POSIX ключ получает права 0600. На Windows `chmodPrivate` — no-op. Ключ `secrets.key` может быть доступен
другим пользователям или процессам в зависимости от ACL. Шифрование AES-256-GCM не защищает от локального
чтения ключа, если ключ доступен.

**Рекомендация (подтверждена):**
- использовать DPAPI (Data Protection API) для защиты ключа на Windows, или
- явно выставлять ACL через `icacls`, ограничивая доступ текущему пользователю;
- как минимум задокументировать это ограничение.

---

### 1.5. Path traversal в writePromptFile и lockFilePath — ПОДТВЕРЖДЕНО (частично, Средне)

**Где:**
- `src/core/ps-wrapper.ts:762-771` — `writePromptFile(taskName, prompt)`:
  ```ts
  const promptPath = path.join(promptDir, `${taskName}.txt`);
  ```
  `sanitizeName` **не вызывается внутри** функции.
- `src/core/ps-wrapper.ts:776-778` — `lockFilePath(taskName)`:
  ```ts
  return path.join(PLUGIN_DIR, "locks", `${taskName}.lock`);
  ```
  `sanitizeName` **не вызывается внутри** функции.

**Что происходит:**
На текущих вызовах (`src/index.ts:5378-5379`, `src/index.ts:5454`, `src/core/ps-wrapper.ts:1036`,
`src/task-transfer.ts:298`) `sanitizeName` применяется на уровне вызывающего кода. Но сами функции
экспортированы и не защищают себя — если когда-нибудь будут вызваны с недоверенным `taskName` (содержащим
`../`), файл промпта или lock-файл может быть создан вне ожидаемого каталога. Это defence-in-depth разрыв.

**Рекомендация (подтверждена):** внутри `writePromptFile` и `lockFilePath` явно вызывать
`sanitizeName` (или `validateTaskName`) перед построением пути.

---

### 1.6. README "Runs without OpenCode open" неполно — ПОДТВЕРЖДЕНО (Средне)

**Где:**
- `README.md:32` — "**Runs without OpenCode open** - jobs are registered with the native OS scheduler..."
- `README.md:218` — "Yes. Jobs are registered with the native OS scheduler, so they run without an open OpenCode window."
- `src/core/file-watcher.ts` и `src/core/git-trigger.ts` существуют (подтверждено) — `FileWatchManager` и
  `GitTriggerManager` работают внутри процесса плагина.
- `src/index.ts:85-86` — импорт `FileWatchManager`, `GitTriggerManager`.

**Что происходит:**
Утверждение верно для cron/one-shot (через нативный планировщик ОС), но **неверно** для триггеров
`file` (chokidar), `git` (GitTriggerManager) и `mcp-event` — они требуют запущенного OpenCode (процесса
плагина). Читатели README могут получить ложные ожидания.

**Рекомендация (подтверждена):** уточнить в README, что file/git/mcp-event триггеры требуют запущенного
OpenCode, а только cron/one-shot работают через нативный планировщик без открытого окна.

---

### 1.7. Длинная последовательная цепочка npm test — ПОДТВЕРЖДЕНО (Средне)

**Где:**
- `package.json:75` — скрипт `test` запускает 47 наборов последовательно через `&&`.
- `package.json:198` — `npm test # 47 test suites, 600+ checks`
- `package.json:125` — `test:en` существует: `"test:en": "node scripts/test-locale.mjs en"`

**Что ocurre:**
Надёжно, но медленно. При таймауте CI в 25 минут (для Windows/macOS) может не хватить времени.

**Рекомендация (подтверждена):** рассмотреть параллельный запуск (например, `npm-run-all`) или разбить
тесты на группы.

---

### 1.8. release.yml не запускает тесты локализации — ПОДТВЕРЖДЕНО (Средне)

**Где:**
- `.github/workflows/release.yml:56` — `run: npm test` (только `npm test`)
- `.github/workflows/ci.yml:48-50` — `npm run test:en` запускается, но только на `ubuntu-latest`

**Что ocurre:**
В релизовом workflow выполняется `npm test`, но не `npm run test:en`. Если в релизной ветке сломается
английская локализация, это не будет поймано перед публикацией.

**Рекомендация (подтверждена):** добавить `npm run test:en` перед публикацией в `release.yml`.

---

### 1.9. Количество инструментов в README — НЕ ПОДТВЕРЖДЕНО как баг (Низко)

**Где:**
- `README.md:52` — "25 agent tools"
- `README.md:99` — "25 tools"

**Проверка:** в таблице инструментов (строки 103-127) перечислено ровно 25 инструментов:
1. schedule_task, 2. list_tasks, 3. update_task, 4. delete_task, 5. run_task_now, 6. pause_task,
7. resume_task, 8. get_history, 9. get_task_logs, 10. dry_run, 11. manage_workspaces, 12. matrix_control,
13. get_metrics, 14. get_analytics, 15. manage_settings, 16. manage_local_ai, 17. manage_templates,
18. manage_profiles, 19. transfer_tasks, 20. send_notification, 21. get_dashboard_info,
22. cleanup_history, 23. manage_secrets, 24. get_audit_log, 25. emit_event.

Оба упоминания say "25" и фактически 25. Несоответствия нет, баг не подтверждён. Ничего не делать.

---

## 2. Задачи (что нужно сделать)

| ID | Задача | Приоритет | Отголосок к ревью |
|----|--------|-----------|-------------------|
| T-1 | Исправить `exports` в `package.json` (указать на `dist/`) | 🔴 Критично | Пункт 1 |
| T-2 | Сделать `--auto` опциональным и ограничить default permissions | 🔴 Критично | Пункт 2 |
| T-3 | Усилить проверку `x-scheduler-client` с учётом `Origin` | 🟠 Высоко | Пункт 3 |
| T-4 | Защитить `secrets.key` на Windows (DPAPI или ACL) | 🟠 Высоко | Пункт 4 |
| T-5 | Добавить `sanitizeName` внутрь `writePromptFile` и `lockFilePath` | 🟡 Средне | Пункт 5 |
| T-6 | Уточнить README про триггеры file/git/mcp-event | 🟡 Средне | Пункт 6 |
| T-7 | Параллелизировать или разбить `npm test` | 🟡 Средне | Пункт 7 |
| T-8 | Добавить `npm run test:en` в `release.yml` | 🟡 Средне | Пункт 8 |

---

## 3. Подзадачи (конкретные шаги исполнения)

### Задача T-1: Исправить exports в package.json

**T-1.1.** Заменить `".": "./src/index.ts"` на `".": "./dist/index.js"`.
**T-1.2.** Заменить `"./tui": "./src/tui.tsx"` на `"./tui": "./dist/tui.js"` **или** удалить точку `"./tui"` из `exports`, если TUI не входит в поставку npm-пакета (в `dist` нет `tui.js`, так как `src/tui.tsx` исключён из `tsconfig`).
**T-1.3.** Проверить, что `dist/index.js` существует после `npm run build` (уже есть).
**T-1.4.** Проверить, что `import("opencode-windows-scheduler")` работает после сборки (не падает с `ERR_UNKNOWN_FILE_EXTENSION`).
**T-1.5.** (Опционально) Исключить `src` из поля `files`, если `exports` теперь указывает на `dist` и исходники не нужны потребителю.

### Задача T-2: --auto опциональный / ограничить default permissions

**T-2.1.** В `src/core/ps-wrapper.ts` задокументировать, какие permissions действуют по умолчанию (комментарий рядом с `$defaultPermissions`).
**T-2.2.** ~~Добавить `autoApprove: boolean`.~~ **Заменено политикой:** вместо отдельного флага введена `permissions.defaultPolicy` (`hybrid`/`secure`/`legacy`) и переходный per-task `legacyShell`; `--auto` остаётся, но опасные действия запрещаются политикой.
**T-2.3.** ~~Передавать `--auto` только при `autoApprove`.~~ **Сделано иначе:** `--auto` сохранён (задача всё равно автономна), но `shell` и `question` по умолчанию `deny` в hybrid; включаются только явным `allowedTools` или `legacyShell`.
**T-2.4.** ✅ Сделано: hybrid запрещает `shell` и `question`, secure дополнительно `edit`/`webfetch`/`websearch`/`subagent`.
**T-2.5.** ✅ Сделано: конфиг прав генерируется резолвером `src/core/permissions.ts` и передаётся через `OPENCODE_CONFIG_CONTENT` (файл `opencode.jsonc` сознательно не создаётся).
**T-2.6.** ✅ Сделано: `test-permissions-policy.mjs` — 28 проверок (hybrid/secure/legacy, deniedTools, allowedTools, legacyShell).

### Задача T-3: Усилить проверку x-scheduler-client

**T-3.1.** ✅ В `src/server.ts` функция `isDashboardRequestTrusted` проверяет `Origin` первым: внешний/`null` Origin → `false` **даже при наличии** `x-scheduler-client`.
**T-3.2.** ✅ Проверено: сервер не отдаёт CORS-заголовков и не отвечает на preflight; заголовок `x-scheduler-client` больше не является основанием для доверия.
**T-3.3.** ✅ Добавлен `test-dashboard-trust.mjs` (10 проверок): внешний Origin + заголовок → `false`, `Origin: null`/`file://` → `false`, локальный Origin/Host → `true`, DNS-rebinding Host → `false`.
**T-3.4.** ✅ `SECURITY.md`, п.5: Origin-first, заголовок не обходит проверку, loopback-only.

### Задача T-4: Защитить secrets.key на Windows

**T-4.1.** В `src/core/secrets.ts` заменить `chmodPrivate` no-op на Windows на использование DPAPI (через `node:child_process` с `cryptunprotectdata`/`cryptprotectdata` или нативный модуль) **или** явное выставление ACL через `icacls`.
**T-4.2.** Ограничить доступ к `secrets.key` текущему пользователю (Full Control только для владельца).
**T-4.3.** ✅ Задокументировано в `SECURITY.md` (п.6) и `README.md` («How do I store secrets?»): POSIX 0600, Windows ACL, best-effort предупреждение при сбое.
**T-4.4.** ✅ `test-secrets.mjs`: на Windows проверяет `icacls` (нет `(I)`, есть текущий пользователь, нет `BUILTIN\Users`), на POSIX — режим 0600. Всего 45 проверок.

### Задача T-5: sanitizeName внутри writePromptFile и lockFilePath

**T-5.1.** В `src/core/ps-wrapper.ts` импортировать `sanitizeName` (уже импортировано на строке 3).
**T-5.2.** В `writePromptFile(taskName, prompt)` вызвать `sanitizeName(taskName)` перед построением пути.
**T-5.3.** В `lockFilePath(taskName)` вызвать `sanitizeName(taskName)` перед построением пути.
**T-5.4.** Убедиться, что существующие вызовы с уже-санитизированным именем не ломаются (дедубликация санитизации безопасна).
**T-5.5.** ✅ `test-path-safety.mjs` (13 проверок): `../../evil`, `..\..\evil`, `/etc/passwd`, `a/b/c` остаются внутри `PLUGIN_DIR/locks` и `PLUGIN_DIR/prompts`.

### Задача T-6: Уточнить README

**T-6.1.** В разделе FAQ ("Does it work when OpenCode is closed?") и разделе "Why" уточнить:
- cron/one-shot — работают без открытого OpenCode (нативный планировщик);
- file / git / mcp-event триггеры — требуют запущенного OpenCode (процесс плагина).
**T-6.2.** ✅ В FAQ добавлена таблица trigger types: cron/once — без OpenCode; file/git/mcp-event/webhook — нужен процесс плагина.

### Задача T-7: Параллелизировать или разбить npm test

**T-7.1.** ✅ Оценено: почти все suite используют общий порт дашборда `3782`, общий `PLUGIN_DIR`/SQLite и временные каталоги; безопасного параллелизма без рефакторинга нет.
**T-7.2.** ⏸ Не делаем: `test:parallel` даст флейки из-за общего порта/БД. Выигрыш не оправдывает нестабильность.
**T-7.3.** ⏸ Не делаем по той же причине. Таймаут release вместо этого увеличен (T-8.2), CI — 25 минут остаётся.

### Задача T-8: Добавить test:en в release.yml

**T-8.1.** В `.github/workflows/release.yml` после шага "Test" добавить шаг "Test in English locale" с `run: npm run test:en`.
**T-8.2.** ✅ Таймаут release увеличен с 20 до 40 минут (`release.yml`) с комментарием про два полных прогона.

---

## 4. Остаточные проблемы (T-05)

Взято из `docs/T-05-DELETE-PROFILE-FIX.md`, раздел C (YELLOW-замечания). Все пункты перепроверены по коду и исправлены в этом проходе.

| ID | Проблема | Место | Статус |
|----|----------|-------|--------|
| R-1 | `dedupCountSuffix` hardcoded `(повтор N)` без i18n | `src/core/triage-compare.ts` | ✅ Исправлено: `t("notify.dedup.count", { count })` |
| R-2 | `compareTriage`: 2 LLM-вызова без внешнего таймаута (`Promise.all`) | `src/core/triage-compare.ts` | ✅ Исправлено: внешний дедлайн 75 с (`timeoutDecision` → `failure: "timeout"`); внутренний `timeoutMs` классификатора сохранён |
| R-3 | `compareTriage`: before/after не валидируются перед `decideTriage` | `src/core/triage-compare.ts` | ✅ Исправлено: `normalizeTriageSettings` для обоих наборов |
| R-4 | Мастер: OpenAI baseUrl пуст (экран 3) | `src/gui.tsx` | ✅ Исправлено: поле Base URL + валидация для OpenAI |
| R-5 | Мастер: hardcoded русские строки на экране 3 | `src/gui.tsx` | ✅ Исправлено: 8 ключей `localAi.wizard.rule.*` в ru/en |
| R-6 | Мастер: тихое падение сохранения (catch без toast/alert) | `src/gui.tsx` | ✅ Исправлено: `persistSettings` → boolean, ошибка показывается, мастер не закрывается |

Проверка: `node test-triage-compare.mjs` — 23/23 (включая таймаут, битые настройки и локализованный суффикс); `node scripts/test-locale.mjs en` — 55 сюит зелёные.

---

## 5. Методика верификации (как перепроверить)

Каждое утверждение выше можно перепроверить независимо:

1. **exports:** `cat package.json` → проверить `exports` и `main`; `cat tsconfig.json` → проверить `exclude`; `ls dist/` → убедиться, что нет `tui.js`.
2. **--auto / permissions:** `cat src/core/ps-wrapper.ts` → строки 528-539 (defaultPermissions), 614 (`--auto`).
3. **x-scheduler-client:** `cat src/server.ts` → строки 313-315 (`isDashboardRequestTrusted`).
4. **secrets на Windows:** `cat src/core/secrets.ts` → строки 88-95 (`chmodPrivate` no-op на win32).
5. **Path traversal:** `cat src/core/ps-wrapper.ts` → строки 762-778 (нет `sanitizeName` внутри функций).
6. **README claim:** `cat README.md` → строки 32, 218; подтвердить существование `src/core/file-watcher.ts` и `src/core/git-trigger.ts`.
7. **npm test:** `cat package.json` → строка 75 (47 тестов через `&&`).
8. **release.yml:** `cat .github/workflows/release.yml` → строка 56 (только `npm test`, нет `test:en`).
9. **Инструменты:** посчитать строки `name: "..."` в регистрации инструментов `src/index.ts` (строки 3518+) — должно быть 25.

---

## 6. Рекомендуемый порядок работ

1. **T-1** (Критично) — без этого пакет не импортируется стандартным способом.
2. **T-2** (Критично) — без этого автономные задачи могут выполнять опасные команды без подтверждения.
3. **T-3** (Высоко) — защита дашборда от CSRF/XSS.
4. **T-4** (Высоко) — защита ключа шифрования на Windows.
5. **T-5, T-6, T-7, T-8** (Средне) — defence-in-depth, документация, ускорение CI, покрытие локализации.

---

## 7. Журнал выполнения

Версия пакета оставлена **1.5.5** (bump не делался по указанию владельца).

| Задача | Что сделано | Проверка |
|--------|-------------|----------|
| T-1 | `exports["."] = "./dist/index.js"`; мёртвая точка `"./tui"` удалена; `src` оставлен в `files` из-за `declarationMap` | `npm run build`; `import("opencode-windows-scheduler")` через junction — OK, 21 экспорт |
| T-2 | `src/core/permissions.ts` (единый резолвер), `permissions.defaultPolicy` в настройках/RPC/GUI, `legacyShell` в задаче, `--auto` + вычисленный конфиг через `OPENCODE_CONFIG_CONTENT`, аудит `tool.blocked` с `reason: "default-policy"`, логи политики в PS/bash-обёртках | `test-permissions-policy.mjs` 28/28; `test-audit.mjs` 33/33; `test-role-scoped.mjs` 17/17 |
| T-3 | `isDashboardRequestTrusted`: Origin проверяется первым, `x-scheduler-client` больше не обходит проверку; SECURITY.md п.5 обновлён; добавлен отдельный тест доверия | `test-dashboard-trust.mjs` 10/10 (внешний/null Origin + header → false, локальный Origin/Host → true, DNS rebinding → false); `test-dashboard.mjs` — зелёный |
| T-4 | `icacls /inheritance:r /grant:r <user>:F` для `secrets.key` на Windows; миграция существующего ключа при чтении; ограничение описано в SECURITY.md и README | `test-secrets.mjs` 45/45, включая ACL: наследование отключено, только `DESKTOP-H4A2TAT\TshK`, `BUILTIN\Users` отсутствует |
| T-5 | `sanitizeName` внутри `writePromptFile` и `lockFilePath` | `test-path-safety.mjs` 13/13: hostile-имена `../../evil`, `..\..\evil`, `/etc/passwd`, `a/b/c` остаются внутри `PLUGIN_DIR` |
| T-6 | README: триггеры + таблица trigger types, политика прав, ACL ключа, `legacyShell` | `test-docs.mjs` 45/45 |
| T-7 | Осознанно не менялось: тесты делят порт дашборда 3782 и глобальные каталоги/БД; параллельный запуск без рефакторинга даёт флейки. Вместо этого увеличен таймаут release | — |
| T-8 | `release.yml`: шаг `npm run test:en` после `npm test`; `timeout-minutes` поднят с 20 до 40 | `scripts/test-locale.mjs en` — 55 сюит зелёные |
| R-1…R-6 | См. раздел 4 | `test-triage-compare.mjs` 23/23 |

Финальная проверка: `npx tsc --noEmit` — OK, `npm run build` — OK, `node scripts/test-locale.mjs en` — **58/58 сюит зелёные** (включая новые `test-dashboard-trust.mjs` 10/10 и `test-path-safety.mjs` 13/13).

Все пункты требуют повторной перепроверки после внесения изменений (см. раздел 5).