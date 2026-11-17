# Отчёт о проверке потенциальных багов и зон риска

## Методология

Каждое утверждение из списка проверено против реального исходного кода в репозитории `opencode-windows-scheduler`. Признаки:
- ✅ **Подтверждён** — баг найден в коде, указаны файл и строки.
- ❌ **Не подтверждён** — Protection уже реализована в коде, утверждение неверно.
- ⚠️ **Частично** — проблема есть, но не в том виде, который описан, или требует уточнения.

Все ссылки на строки относятся к состоянию кода на момент проверки.

---

## 1. Безопасность секретов на Windows (T-4) — secrets.ts

**Статус: ❌ Не подтверждён (защита уже реализована)**

Утверждение: защита `secrets.key` на Windows не проверена, используется только `chmodPrivate`, который на Windows не работает.

Код в `src/core/secrets.ts`:
- Функция `chmodPrivate` (стр. 134–144): на `win32` вызывает `restrictWindowsAcl(file)`, которая запускает `icacls <file> /inheritance:r /grant:r <user>:F` (стр. 113–132).
- `loadKey` вызывает `chmodPrivate(SECRETS_KEY_FILE)` при создании и при чтении ключа (стр. 159, 166).
- `writeFileSafe` вызывает `chmodPrivate(SECRETS_FILE)` после атомарной записи (стр. 262).

Вывод: ACL через `icacls` на Windows применяется. Утверждение о том, что protección не реализована, неверно.

---

## 2. Path traversal в других местах

**Статус: ⚠️ Частично подтверждён**

- `writePromptFile` в `src/core/wrappers/bash.ts` (стр. 799–808) и `src/core/ps-wrapper.ts` (стр. 799–808) — использует `sanitizeName(taskName)`. ✅
- `lockFilePath` в `src/core/ps-wrapper.ts` (стр. 816–818) — использует `sanitizeName(taskName)`. ✅
- `matrixCloneName` в `src/core/matrix.ts` (стр. 30–39): санитизируется только `workspaceName`, **не санитизируется `parentName`**. Имя клона собирается как `${parent}-matrix-${safeWs}` и затем проходит `validateTaskName`, но сам `parentName` может содержать `../` на этапе формирования имени, прежде чем дойдёт до валидации.

Требуется аудит остальных путей (логи, временные файлы, БД) — но критического несантизированного вставки `taskName` в путь вне `matrixCloneName` не найдено.

---

## 3. Обработка таймаутов и «зависших» процессов — ps-wrapper.ts

**Статус: ❌ Не подтверждён (fallback уже реализован)**

Утверждение: на Windows `Stop-Process` не завершает всё дерево, нужен `taskkill /T /F`.

Код в `src/core/ps-wrapper.ts` (стр. 291–311, функция `Invoke-OpenCodeOnce`):
- Сторожевой job обходит дерево процессов через `Get-CimInstance Win32_Process`.
- Убивает дочерние процессы через `taskkill.exe /F /T /PID $targetId` (стр. 310).

Вывод: fallback `taskkill /T /F` уже есть. Требуются только тесты на сценарий с «зависшими» дочерними процессами (process improvement, не баг).

---

## 4. Конкурентность и блокировки — lock.ts, ps-wrapper.ts

**Статус: ❌ Не подтверждён (stale lock уже обрабатывается)**

Код в `src/core/lock.ts`:
- `LockManager.initialize()` чистит lock-файлы старше `STALE_LOCK_MAX_AGE_MS` (24 часа) при старте (стр. 39–86).
- `withLockWait` вытесняет осиротевший lock атомарным `rename` (стр. 170–219).

Код в `src/core/ps-wrapper.ts` (стр. 119–188): PowerShell-обёртка проверяет PID владельца lock и возраст файла, при необходимости делает `Move-Item` в `.stale-*` имя.

Вывод: протухшие блокировки освобождаются. Требуются тесты (улучшение процесса, не баг).

---

## 5. Соответствие README фактическому поведению

**Статус: требует ручной проверки README и сетевого трафика**

Не является кодовым багом. Требует отдельной проверки: фоновые процессы не должны отправлять сетевых запросов, кроме явно настроенных уведомлений.

---

## 6. Длинная последовательная цепочка тестов (T-7)

**Статус: улучшение процесса, не баг**

`npm test` запускает 47 наборов последовательно через `&&` (см. `test-run.log` стр. 2). Рекомендация: распараллелить через `npm-run-all` или разбить на группы.

---

## 7. Отсутствие test:en в release-workflow (T-8)

**Статус: улучшение процесса, не баг**

В `.github/workflows/release.yml` выполняется только `npm test`, не `npm run test:en`. Требуется добавить шаг `npm run test:en` перед публикацией.

---

## 🚨 Критические баги (подтверждены в коде)

### Деталь 1: Полная поломка ротации сессий (session=reuse с sessionMaxRuns)

**Файл:** `src/core/session.ts`, функция `rotateSessionIfNeeded` (стр. 80–115)

**Что подтверждено в коде:**
- Функция удаляет сессию через `opencode session delete <sessionId>` (стр. 91–94).
- Затем сохраняет `sessionId: undefined` и `sessionRunCount: 0` (стр. 99–103).
- Оболочка (bash/ps1) генерируется один раз при создании задачи и содержит `SESSION_ID` жестко зашитым (см. `src/core/wrappers/bash.ts` стр. 145, `src/core/ps-wrapper.ts` стр. 51–52, 651–658). Оболочка **не регенерируется** после ротации.
- После сброса `sessionId` в `undefined` следующая ротация не сможет удалить сессию (ей нужен ID для `opencode session delete`).

**Последствия:**
1. На следующем запуске оболочка передаст OpenCode удалённый `sessionId` → ошибка `session not found`.
2. Реальная сессия OpenCode будет расти бесконечно, а «ротация» будет только сбрасывать счётчик в БД.

---

### Деталь 2: get_history RPC игнорирует историю старше 200 запусков

**Файлы:** `src/index.ts` (стр. 4268–4285), `src/history.ts` (стр. 75–97), `src/db/history-repo.ts` (стр. 291–314)

**Что подтверждено в коде:**
- `loadHistory()` в `src/history.ts` вызывает `getHistory(null, 200)` — жестко зашито 200 записей глобально (стр. 76).
- RPC-хендлер `get_history` в `src/index.ts` (стр. 4268–4285) вызывает `loadHistory()`, затем фильтрует в памяти JS по `taskName` и `status`, и только потом режет `slice(0, max)`.
- Если задача не запускалась в последних 200 глобальных записях, фильтр вернёт пустой массив, даже если у задачи есть более старая история.
- `getHistory(taskName, limit)` в `src/db/history-repo.ts` (стр. 291–314) поддерживает фильтрацию по `taskName` на уровне SQL (`WHERE lower(task_name) = lower(?)`), но RPC-хендлер её не использует.

**Последствие:** `get_history({ taskName: "old-task" })` возвращает пустой массив для старых задач.

---

### Деталь 3: Ошибка в schedule-gate — запуск вне окна при nextOpenAt = null

**Файл:** `src/core/schedule-gate.ts` (стр. 190–193)

**Что подтверждено в коде:**
```ts
const wait = state.nextOpenAt
  ? Math.max(0, state.nextOpenAt.getTime() - now.getTime())
  : 0;
if (wait <= 0) return 0;
```
- `activeWindowState` возвращает `nextOpenAt: null`, когда `nextWindowOpenAt` не находит открытие окна в пределах 8 дней (`src/core/schedule-v2.ts` стр. 535–549).
- Если `state.active === false` (вне окна) и `state.nextOpenAt === null`, то `wait = 0`, и условие `wait <= 0` возвращает `0` — **разрешает запуск**, хотя задача должна быть пропущена или отложена.

**Последствие:** задача запускается вне окна запуска, когда окна не найдено в пределах сканирования.

---

### Деталь 4: Логическая ошибка в candidatesOnDay (cron)

**Файл:** `src/core/schedule-v2.ts`, функция `candidatesOnDay` (стр. 336–359)

**Что подтверждено в коде:**
```ts
if (notBefore && notAfter) {
  if (hour < notBefore.hour || (hour === notBefore.hour && minute < notBefore.minute)) continue;
}
if (notAfter) {
  if (hour > notAfter.hour || (hour === notAfter.hour && minute > notAfter.minute)) continue;
}
```
- `notBefore` применяется **только если задан и `notAfter`**. Если `notAfter === null`, `notBefore` полностью игнорируется.
- В `nextRun` есть страховочная проверка `if (at.getTime() > base) return at;` (стр. 380), которая отсеивает раннее время, но сама хелпер-функция содержит грубую логическую ошибку.

**Последствие:** при любом использовании `candidatesOnDay` с `notBefore` без `notAfter` фильтр `notBefore` не сработает.

---

### Деталь 5: sessionMaxRuns валидация противоречит описанию

**Файлы:** `src/index.ts` (стр. 272–280, 535–543, 1877–1887), `src/task-transfer.ts` (стр. 585–596)

**Что подтверждено в коде:**
- Zod-схема в `index.ts` (стр. 272–280): `sessionMaxRuns: z.number().int().min(1).max(10000).optional()` с описанием `"Unset/0 — no limit."`
- При обновлении (стр. 535–543): та же схема `.min(1)`.
- В `updateTaskFromInput` (стр. 1877–1887): `if (sessionMaxRuns !== undefined && (!Number.isInteger(sessionMaxRuns) || sessionMaxRuns < 1))` — возвращает ошибку.
- В `task-transfer.ts` `parseImportJson` (стр. 585–596): `if (typeof raw === "number" && Number.isFinite(raw) && raw >= 1)` — иначе ошибка `sessionMaxRuns должен быть целым числом ≥ 1`.

**Последствие:** пользователь не может явно передать `0` для снятия лимита, хотя документация это разрешает (`Unset/0 — no limit`).

---

## ⚠️ Средние и мелкие баги (подтверждены в коде)

### Деталь 6: Telegram fallback без логирования

**Файл:** `src/core/telegram.ts`, функция `sendTelegramMessage` (стр. 396–407)

**Что подтверждено в коде:**
- При HTTP 400 с ошибкой "can't parse entities" код устанавливает `downgradedParseMode = true`, `parseModeForChunk = ""` и повторяет запрос без разметки.
- **Нет `console.warn` или любого другого логирования** при этом понижении. Пользователь никогда не узнает, что в его шаблоне битая разметка.

---

### Деталь 7: normalizeTriageRule — отсутствует флаг `u` в RegExp

**Файл:** `src/settings.ts`, функция `normalizeTriageRule` (стр. 786–792)

**Что подтверждено в коде:**
```ts
if (operator === "regex") {
  try {
    new RegExp(String(ruleValue), "i");
  } catch {
    return null;
  }
}
```
- Флаг `u` (unicode) отсутствует. Регулярные выражения с юникод-символами могут работать некорректно или падать.

---

### Деталь 8: Коллизии имен клонов в Matrix — молчаливый пропуск

**Файл:** `src/core/matrix.ts`, функция `expandMatrixTask` (стр. 55–126)

**Что подтверждено в коде (стр. 77):**
```ts
if (usedNames.has(name.toLowerCase())) continue;
usedNames.add(name.toLowerCase());
```
- Если два workspace имеют одинаковое имя, второй клон **молча пропускается**. Лучше бросать ошибку или добавлять ID workspace к имени клона.

---

### Деталь 9: Устаревшая схема ScheduleJobArgs запрещает кириллицу

**Файл:** `src/types.ts`, схема `ScheduleJobArgs` (стр. 112–134)

**Что подтверждено в коде:**
```ts
name: z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_\-]+$/, "Имя задачи должно содержать только буквы, цифры, подчёркивание и дефис")
```
- Регулярное выражение `/^[A-Za-z0-9_\-]+$/` запрещает кириллицу.
- Актуальная `validateTaskName` в том же файле (стр. 77–106) поддерживает кириллицу через `\p{L}` с флагом `u`.

**Последствие:** прямое противоречие между старой схемой и актуальной валидацией.

---

### Деталь 10: update_task не обновляет зависимости при переименовании

**Файл:** `src/index.ts`, функция `updateTaskFromInput` (стр. 1795+)

**Что подтверждено в коде:**
- `updateTaskFromInput` обновляет определение задачи, включая изменение имени (через `saveTask` с `WHERE lower(name) = lower(?)`).
- **Нет кода**, который обновил бы ссылки на переименованную задачу в полях `dependsOn` и `nextTaskOnSuccess` других задач.
- Сравнение в БД case-insensitive, но имена в зависимостях остаются со старым регистром, что создаёт путаницу при экспорте/импорте.

---

## 🛠 Улучшения (подтверждены в коде)

### Деталь 11: Передача промпта через argv (ограничение 128 КБ)

**Файл:** `src/core/wrappers/bash.ts` (стр. 314–321, 363–383)

**Что подтверждено в коде:**
- Промпт передается как аргумент `opencode run --auto "$PROMPT"` (стр. 380).
- Проверка размера: `if [ "$PROMPT_BYTES" -gt 131072 ]` — выход с ошибкой (стр. 318–321).
- Нет альтернативы через stdin или `--prompt-file`.

**Улучшение:** если OpenCode CLI поддерживает чтение промпта из stdin или через `--prompt-file`, использовать это для снятия лимита 128 КБ.

---

### Деталь 12: Производительность loadHistory() — хардкод 200

**Файл:** `src/history.ts`, функция `loadHistory` (стр. 75–97)

**Что подтверждено в коде:**
```ts
export async function loadHistory(): Promise<HistoryRecord[]> {
  return getHistory(null, 200).map(...)
}
```
- Лимит `200` жестко зашит. Для дашборда и аналитики используется `getHistory(null, 20000)` напрямую (см. `src/index.ts` стр. 4338).

**Улучшение:** сделать лимит динамическим параметром функции `loadHistory`.

---

### Деталь 13: schedule-gate — сон процесса до 12 часов

**Файл:** `src/core/schedule-gate.ts` (стр. 219–224)

**Что подтверждено в коде:**
```ts
let remaining = wait;
while (remaining > 0) {
  const chunk = Math.min(remaining, 60_000);
  await sleepMs(chunk);
  remaining -= chunk;
}
```
- Node.js процесс удерживается в памяти в состоянии `await sleep` до 12 часов (`MAX_POSTPONE_MS`, стр. 46).

**Улучшение:** для Linux/macOS использовать системный `sleep` или `at`, для Windows — перерегистрировать триггер в Task Scheduler, а не держать висящий процесс.

---

### Деталь 14: saveTask — конфликт первичного ключа при смене регистра имени

**Файл:** `src/db/tasks-repo.ts`, функция `saveTask` (стр. 105–118)

**Что подтверждено в коде:**
```ts
if (existing) {
  instance.prepare(
    "UPDATE tasks SET name = ?, definition_json = ?, created_at = ?, updated_at = ?, matrix_parent_id = ?, is_matrix_parent = ? WHERE name = ?"
  ).run(definition.name, json, createdAt, now, matrixParentId, isMatrixParent, existing.name);
}
```
- PRIMARY KEY `name TEXT` в SQLite чувствителен к регистру (BINARY collation по умолчанию).
- Если агент передаст `MyTask` вместо уже существующего `mytask`, `saveTask` найдёт существующую запись через `WHERE lower(name) = lower(?)` (стр. 69–72), но `UPDATE ... SET name = 'MyTask' WHERE name = 'mytask'` создаст дубликат или упадёт с нарушением PRIMARY KEY, если `MyTask` уже существует.

**Улучшение:** приводить `name` к каноническому виду (тому, что уже есть в БД) перед UPDATE.

---

## Сводная таблица

| # | Деталь | Статус | Файл | Строки |
|---|--------|--------|------|--------|
| 1 | Т-4 Секреты Windows ACL | ❌ Не баг (уже есть) | `src/core/secrets.ts` | 113–166 |
| 2 | Path traversal | ⚠️ Частично | `src/core/matrix.ts` | 30–39 |
| 3 | Таймауты / taskkill | ❌ Не баг (уже есть) | `src/core/ps-wrapper.ts` | 291–311 |
| 4 | Stale lock | ❌ Не баг (уже есть) | `src/core/lock.ts` | 39–219 |
| 5 | README vs поведение | — Ручная проверка | — | — |
| 6 | Последовательные тесты | — Улучшение процесса | `package.json` | test script |
| 7 | test:en в release | — Улучшение процесса | `.github/workflows/release.yml` | — |
| C1 | Ротация сессий сломана | ✅ Баг | `src/core/session.ts` | 80–115 |
| C2 | get_history > 200 записей | ✅ Баг | `src/index.ts`, `src/history.ts` | 4268–4285, 75–97 |
| C3 | schedule-gate nextOpenAt=null | ✅ Баг | `src/core/schedule-gate.ts` | 190–193 |
| C4 | candidatesOnDay notBefore | ✅ Баг | `src/core/schedule-v2.ts` | 349–351 |
| C5 | sessionMaxRuns min(1) | ✅ Баг | `src/index.ts`, `src/task-transfer.ts` | 272–280, 585–596 |
| M1 | Telegram нет лога при fallback | ✅ Баг | `src/core/telegram.ts` | 396–407 |
| M2 | normalizeTriageRule нет флага u | ✅ Баг | `src/settings.ts` | 786–792 |
| M3 | Matrix коллизии имён клонов | ✅ Баг | `src/core/matrix.ts` | 77 |
| M4 | ScheduleJobArgs нет кириллицы | ✅ Баг | `src/types.ts` | 113–116 |
| M5 | update_task не обновляет зависимости | ✅ Баг | `src/index.ts` | 1795+ |
| A1 | Промпт через argv 128KB | ✅ Ограничение | `src/core/wrappers/bash.ts` | 314–321, 363–383 |
| A2 | loadHistory() хардкод 200 | ✅ Ограничение | `src/history.ts` | 75–77 |
| A3 | schedule-gate сон до 12ч | ✅ Ограничение | `src/core/schedule-gate.ts` | 219–224 |
| A4 | saveTask конфликт регистра PK | ✅ Риск | `src/db/tasks-repo.ts` | 105–118 |

---

## Рекомендация по приоритету исправления

1. **C1** Ротация сессий — критично, ломает переиспользование сессий.
2. **C2** get_history — ломает получение старой истории по задаче.
3. **C3** schedule-gate — позволяет запуск вне окна.
4. **C4** candidatesOnDay — логическая ошибка в хелпере.
5. **C5** sessionMaxRuns — противоречие документации и кода.
6. **M1–M5** — средние баги, исправлять после критичных.
7. **A1–A4** — архитектурные улучшения.
