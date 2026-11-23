# DOC-1A — полная проверка документации через OS-bound задачу

- **Дата:** 2026-11-23 09:23–09:36 UTC (12:23–12:36 +03:00)
- **Ветка:** `dev`
- **Задача планировщика:** `DOC-1A - Docs audit OS bound`
- **Trigger:** `cron` `0 3 * * *`, запуск вручную через `run_task_now`
- **Модель прогона:** `mimo-v2.6-flash-free` (модель по умолчанию, НЕ `opencode/hy4-flash-free`)
- **Итог:** ❌ `error` — дочерний агент упёрся в лимит Free-модели, обёртка при обработке этой ошибки упала сама

> Отчёт восстановлен вручную: дочерний агент проделал основную часть сверки, но
> до завершения не дошёл и файл не записал. Ниже — факты из лога прогона,
> подтверждённые повторной проверкой исходников в этой сессии.

## 1. Проверка триггера и OS-привязки

| Проверка | Результат |
|---|---|
| `dry_run` до запуска | успешно, замечаний нет |
| `schtasks /query /tn "\OpenCode\agent-steward\DOC-1A - Docs audit OS bound" /v /fo list` | задача **реально зарегистрирована в Планировщике заданий Windows**, папка `\OpenCode\agent-steward\`, Next Run `24.11.2026 3:00:00`, Status `Enabled`, Last Run `23.11.2026 12:23:23`, Last Result `267009` (0x41301 — «задача всё ещё выполняется») |
| `run_task_now` | запуск 09:23:23Z, история содержит запись `running` → `error` |
| Запись в `get_audit_log` | `task.create` / `task.run` / `task.update`, actor `mcp` |
| Quality Gate | **не выполнялся обёрткой**: дочерний процесс завершился ненулевым кодом, гейт по дизайну запускается только при успехе |
| Post-flight | выполнен всегда (`postFlightStatus: success`), но коммит не состоялся — маркер `doc1a.passed` не был создан |

Дочерний агент внутри прогона сам запустил верификацию:

| Команда агента | Exit code |
|---|---|
| `node test-docs.mjs` | 0 (129/129) |
| `node test-i18n.mjs` | 0 (75/75) |
| `npm run build` | 0 |

## 2. Подтверждённые расхождения документации

1. **`.opencode/skills/release-check/SKILL.md:38`** — «30 MCP-инструментов / 57 RPC-методов / **115** наборов». Фактически в `npm test` — **116** уникальных `node test-*.mjs` (на диске 121 файл). Аналогичные счётчики в `.opencode/skills/agent-steward-dev/SKILL.md:61` и `.opencode/skills/docs-sync/SKILL.md:28` уже равны 116. `test-docs.mjs` проверяет в `release-check` только tools/RPC, не suites — поэтому расхождение прошло через мета-гейт. **Исправлено: 115 → 116.**
2. **`docs/EXECUTION-LOOP.md`** — актуальный документ целевого цикла исполнения, но `docs/ARCHITECTURE.md` на него **не ссылается ни разу** (`grep EXECUTION-LOOP` → 0 совпадений); связь есть только из `ROADMAP.md:52` и `.opencode/skills/docs-sync/SKILL.md`. Это разрыв самодостаточности: читающий архитектуру не видит описания цикла. **Добавлена перекрёстная ссылка.**
3. **`docs/V1-V2-COMPATIBILITY-PLAN.md`** — завершённый план версии `1.5.6` (текущая версия пакета `0.0.6`), содержит устаревшие числа (например, «26 инструментов» в матрице поверхностей). Фактическое состояние зафиксировано в `docs/COMPATIBILITY.md`. **Удалён как ненужная и устаревшая документация**, ссылки в `COMPATIBILITY.md` и `docs-sync/SKILL.md` заменены на указание к актуальному документу.
4. **`docs/ZH-LOCALE-PLAN.md`** — план локали `zh`: S22 «Приёмочный отчёт» выполнен 17.11.2026, «План закрыт»; внешних входящих ссылок нет. **Удалён как ненужная документация.**

Исторические числа `29/115/109` в `CHANGELOG.md` и `ROADMAP.md` — корректная хроника этапов, не тронуты.

Счётчики, признанные корректными: **30** tools (`src/index.ts`), **57** RPC (`SchedulerRpc.methods`), **116** suites (`npm test`), 772 ключа локалей, Node **≥22.22.0**, `SCHEMA_VERSION=14`.

## 3. Найденные баги плагина (воспроизведены по факту)

| ID | Находка | Доказательство |
|---|---|---|
| PL-86 | Генератор `.cmd`-обёртки не передаёт `-Workdir` в `run-task.ps1`: в `src/core/ps-wrapper.ts:1391-1392` путь используется только для `cd /d`. Параметр `$Workdir` остаётся пустым, поэтому (а) snapshot/worktree-проверки гейта молча пропускаются (`preFlightStatus: skipped`), (б) обработчик исчерпания квоты PL-83 на строке 941 делает `Join-Path $Workdir ...` **вне `try/catch`** и падает с `Cannot bind argument to parameter 'Path' because it is an empty string.` | Лог: сразу после `Error: Free usage limit reached.` — `Ошибка выполнения задачи ...: Cannot bind argument to parameter 'Path' because it is an empty string.`; сгенерированный `.cmd` не содержит `-Workdir`; строка 941 вне защищённого блока |
| PL-87 | Лимит Free-модели маскируется ошибкой обёртки: вместо внятного сообщения PL-83 «квота исчерпана, перезапустите с другой моделью» пользователь видит бессмысленный `Path`-error. Дополнительно подтверждено падением суб-агента с `Free usage limit reached` | Лог DOC-1A и завершение суб-агента `ses_df8499f14ffdSfTbrfgfxREnCK` |
| PL-88 | `schedule_task` / `update_task` принимают модель без `provider/`-префикса: схема `src/index.ts:540-545` — просто `z.string().optional()`, формат не проверяется. Прогон DOC-1B с `model: hy4-flash-free` упал за 4 с с `Invalid model reference: hy4-flash-free`; после смены на `opencode/hy4-flash-free` работает | `get_history` DOC-1B: `Код возврата 1`, лог `Error: Invalid model reference: hy4-flash-free` |

Проверка PL-60: в записях аудита, созданных этой сессией (`task.create` 1417/1418, `task.update` 1419), ложных `tool.blocked tool:"*"` **нет** — исправление работает. Старые записи 1391–1414 относятся к периоду до фикса.

## 4. Верификация после правок

- `node test-docs.mjs` — 129/129, exit 0
- `node test-i18n.mjs` — 75/75, exit 0
- `npm run build` — exit 0
