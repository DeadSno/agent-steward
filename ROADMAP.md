# 🗺️ Roadmap — agent-steward

> North Star: [docs/CONCEPT.md](./docs/CONCEPT.md) — верифицируемая локально-первая оркестрация агент-задач.
> Это не «планировщик». Планировщик/уведомления/аналитика — триггеры и обвязка, не ядро (§8 CONCEPT).
>
> Модель работы — канбан. Каждая задача разложена слоями:
> **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг).
> В работу берётся ровно одна подзадача: подзадача → отчёт → следующая подзадача.
>
> **В ROADMAP только открытые задачи.** Закрытые задачи и подзадачи удаляются отсюда
> и фиксируются в [CHANGELOG.md](./CHANGELOG.md) — больше нигде.
>
> **Нумерация.** Нумерация сохранена для преемственности ссылок: первая открытая
> деталь — 3.9, следующий раздел — 4.

Текущая версия: **agent-steward 0.0.6** (20.11.2026).
Legacy: `opencode-windows-scheduler@1.5.9`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.

---


**Задача X-4 — Dependabot** · P2 · ⏸️
- [ ] X-4.1 Мерж #4 (plugin 2.3.0)
- [ ] X-4.2 OpenTUI 0.9.0
  > Блокировка (2026-11-24): PR #4 открыт (base `main` отстаёт от `dev` на 138 коммитов, head `89c2b89`), но в CI 2 из 10 джобов отменены (macOS, node 22/24) — по `docs/RELEASE-RUNBOOK.md` при незелёном CI мерж запрещён. `gh` CLI и `GH_TOKEN` отсутствуют; обновление OpenTUI 0.9.0 по runbook разрешено только после зелёного PR #4.

### QA-находки, найденные при верификации плагина (24.11.2026)

- [ ] PL-140 при провале Quality Gate история и лог содержат только «Quality Gate провален. Код возврата 1» без причины, хотя вывод гейта (например, «Agent tools: 88/89 проверок пройдено») уже есть в журнале: реальный прогон плагина `QA-PL129-CORE-PROFILE` 24.11.2026 ушёл в error с неинформативной строкой — `src/core/ps-wrapper.ts:1379-1381`. PL-130 добавил извлечение причины только для ошибки дочернего агента, ветка гейта не тронута. Действие: переиспользовать санитизатор PL-130 для вывода гейта (последние осмысленные строки, ANSI-strip, лимит 200 символов), писать «Quality Gate провален. Код возврата N. Причина: ...» в `errorMessage` и `Write-Log`; регрессия в `test-execution-hardening.mjs`. Обнаружено при разборе логов плагина. — P2
- [ ] PL-141 исправление PL-133 сделало `allowedTools` нестрогим: `resolvePermissions` автоматически добавляет `read`/`glob`/`grep`/`skill` к любому непустому `allowedTools` (`src/core/permissions.ts:599-608`). Задача с `allowedTools:["shell"]`, намеренно запрещавшая чтение файлов (например, `.env`), теперь получает эти права; запрет возможен только через явный `deniedTools`. Действие: добавить режим строгого allowlist (например, `strictAllowedTools` / `allowlistMode:"strict"`, default false для совместимости) и/или явно документировать ограничение в `docs/ARCHITECTURE.md`, `docs/FEATURES.md` и локалях; регрессия на конфигурации с секретами в `test-permissions-policy.mjs`. — P2
- [ ] PL-142 PL-135 закрыт лишь частично: `scripts/pl-commit.ps1:72-89` проверяет exit-код только `npm run build`; `npm run lint` и declared quality gate не проверяются, а маркер гейта удаляется до верификации (строка 59). Сломанный линтер или stale/поддельный маркер по-прежнему пушит в `dev`, хотя исходная находка требовала проверки `build`/`lint` либо refuse push без маркера успешного gate. Действие: проверять build+lint (или параметр списка команд), не удалять маркер до успешной верификации, добавить регрессию в `test-execution-hardening.mjs`. — P2
- [ ] PL-143 PL-130 подавляет изменения наблюдаемого файла в течение 15 с по имени задачи без различения автора и без лога: `src/core/file-watcher.ts:20,66-72`, `src/index.ts:5026-5032`. Осмысленная правка `ROADMAP.md` пользователем или другим агентом в этом окне молча теряется — файловый триггер не срабатывает и не пишет причину пропуска. Действие: логировать подавление и сделать окно настраиваемым через env (`AGENT_STEWARD_FILE_SELF_WRITE_SUPPRESS_MS`), либо сузить подавление до подтверждённого self-write; регрессия в `test-watch-paths.mjs`. — P3
- [ ] PL-144 SCOPE-парсер считает русскую прозу путём: `src/core/scheduler/run-now.ts:20-25`, комментарий PL-120 обещает «кириллическая проза — не путь», но `pathRun` включает `а-яёА-ЯЁ`; воспроизведено при создании задачи TPAUDIT-OS-CronProbe 24.11.2026 — `SCOPE: только TEST-PLAN.md` отвергнуто pre-flight как «несуществующие пути: только», обход — `SCOPE: \`TEST-PLAN.md\``. Действие: убрать кириллицу из `pathRun` или требовать path-подобность (наличие `/`, `\`, `.` или расширения), регрессия в `test-execution-hardening.mjs` / `test-agent-tools.mjs`. — P2
- [ ] PL-145 Скилл `scheduled-job-best-practices` рекомендует недоступный в core-профиле вызов: `skills/scheduled-job-best-practices/SKILL.md:39`, `references/triggers-and-prompts.md:16,29-36` учат `schedule_task` + `mcpEvent`, тогда как PL-129 осознанно исключил `mcpEvent` из core-схемы; реальный вызов 24.11.2026 вернул ошибку с подсказкой про `schedule_advanced`. Действие: добавить в таблицы триггеров сноску про core/admin-профиль и `AGENT_STEWARD_TOOL_PROFILE=all`, пример per `schedule_advanced`; регрессия в `test-docs.mjs`. — P3
- [ ] PL-146 Пропуск файлового триггера из-за PL-121 не оставляет durable-записи: `src/core/ps-wrapper.ts:350-358` при занятом checkout-lock пишет только лог «PL-121: в чек-ауте ... уже идёт другая задача — запуск пропущен», завершается `exit 0` и не делает запись в историю; воспроизведено 24.11.2026 на TPAUDIT-FILE-WatchProbe (первый touch события потеряно, `get_history` пуст, второй touch прошёл успешно). Действие: писать skip-запись в историю с причиной PL-121 и/или ставить событие в очередь повторного запуска; регрессия в `test-execution-hardening.mjs`. — P3
- [ ] PL-147 TEST-PLAN.md:815.asserts 17 проверок для `test-test-plan.mjs`, хотя актуальный прогон 24.11.2026 даёт 19/19 (19 вызовов `check()` в `test-test-plan.mjs:62-94`). Действие: заменить 17→19, добавить запись в CHANGELOG. — P3
- [ ] PL-148 TEST-PLAN.md §7.4 (строки 910-928) устарел: E-3/E-4/E-5, A-1, X-3, X-6 помечены ⬜/⏸️, хотя CHANGELOG.md фиксирует E-3.1, E-4.1/E-4.2, E-5.1, PL-95+PL-103 (A-1), X-3.1/X-6.1 закрытыми и удалёнными из ROADMAP. Действие: обновить статусы и ссылки на CHANGELOG, оставить открытыми только реально числящиеся в ROADMAP X-1/X-2/X-4/X-5, D-1…D-3, A-2…A-6, M-1…M-8. — P3
- [ ] PL-149 Шапка TEST-PLAN.md:3 содержит «Дата: 20.11.2026», устаревшую на дату аудита 24.11.2026; `test-test-plan.mjs:66` жёстко проверяет старую дату. Действие: обновить дату в плане и в проверке 66 (+ её имя), прогнать `node test-test-plan.mjs`, добавить запись в CHANGELOG. — P3

## Деталь 3.9 — Портабельность: OpenCode → MCP / dsh / ACP (0.2.x+)
`src/core/`, `src/adapters/`, `src/invokers/`, `src/cli.ts`

> Цель: тот же функционал в Cursor, VS Code, IDEA и DeepSeek Harness без форков
> и без потери совместимости с OpenCode V1/V2. Архитектура уже на ~70% готова:
> всего 8 `@opencode`-импортов в `src/`, ядро не знает про инструменты/RPC.
> Детали обоснования — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md), Этап 2/3.

**Задача P-1 — Изоляция ядра (Phase 0)** · P2 · ⬜
- [ ] P-1.1 Вынести `createToolSpecs` в `src/tool-specs.ts`, `createRuntime` — в `src/runtime.ts`
- [ ] P-1.2 Контракт-тест: снимок 32 имён/схем инструментов, паритет с RPC-поверхностью
- [ ] P-1.3 Проверить: 130+ существующих тестов зелёные, поведение OpenCode не изменилось

**Задача P-2 — MCP-адаптер (Phase 1, ~80% ценности)** · P2 · ⬜
- [ ] P-2.1 Bin `agent-steward mcp`: `McpServer` + `StdioServerTransport`, 32 `registerTool`
- [ ] P-2.2 SKILL.md как MCP resource/prompt (`@modelcontextprotocol/server`, zod v4)
- [ ] P-2.3 Сниппеты конфига: `.cursor/mcp.json`, `.vscode/mcp.json`, IDEA MCP Server
- [ ] P-2.4 Тест: та же спека инструментов, что и в OpenCode-адаптере

**Задача P-3 — Agent Invoker + поле `harness` (Phase 2)** · P3 · ⬜
- [ ] P-3.1 Порт `AgentInvoker`: `invoke`/`buildCommand`, `UsageParser`, `ToolPolicy.toHarnessConfig()`
- [ ] P-3.2 Параметризовать `ps-wrapper`/`bash`: `$AgentCommandPath`/`$AgentArgs` вместо хардкода `opencode run`
- [ ] P-3.3 Invoker'ы: `opencode-cli` (по умолчанию), `dsh-headless`, `acp`, `cursor-cli`
- [ ] P-3.4 Поле `harness` в задаче, default `opencode`, полная обратная совместимость

**Задача P-4 — Нативный dsh-плагин (Phase 3)** · P3 · ⬜
- [ ] P-4.1 `defineTool` ×32 через `ctx.tools.register`, `ctx.jobs` для фоновых запусков
- [ ] P-4.2 Копия SKILL.md в `.agents/skills/`
- [ ] P-4.3 Зафиксировать версию dsh (developer preview — breaking changes), контракт-тест

**Задача P-5 — Serve + тонкие расширения (Phase 4)** · P3 · ⬜
- [ ] P-5.1 Bin `agent-steward serve` — дашборд без OpenCode
- [ ] P-5.2 Опциональные VS Code / JetBrains extension только для UX
- [ ] P-5.3 Subpath exports `./core`, `./mcp`, `./dsh` (без монорепо — 130 тестов остаются рабочими)

## Деталь 3.12 — Бюджет: жёсткий enforcement и маршрутизация (0.0.7+)
`src/core/ps-wrapper.ts`, `src/core/record-history.ts`, `src/core/budget.ts`, `src/core/dry-run.ts`, `src/index.ts`

> Экономика токенов: телеметрия и рекомендации готовы, enforcement и автоприменение — нет.

---

# 4. Правила работы (канбан)

1. **Одна подзадача за раз.** Взял → сделал → отчёт → следующая подзадача.
2. **Слой не пропускается.** Деталь → задача → подзадача; подзадача закрывается только с тестом и документацией.
3. **Закрытое уходит из ROADMAP.** Выполненная задача/подзадача удаляется отсюда и попадает в CHANGELOG.
4. **Нет спринтов.** Статусы ⬜ → 🔄 → ✅ независимо от релизов.
5. **Версия — следствие релиза, а не обещание.** `npm version` в момент релиза.
6. **Приоритет — по боли пользователя.** P1 = без этого нельзя рекомендовать плагин.
7. **Fail-open по умолчанию.** Необязательная подсистема при отказе деградирует, а не блокирует.
8. **Сверка с CONCEPT.md.** Четыре столпа (§4), без противоречий §8.
9. **Честность в маркетинге.** Оценки — с методикой рядом.

---

# 5. Release-чеклист

- [ ] `package.json` version == tag; CI verify зелёный.
- [ ] CHANGELOG обновлён; шапка ROADMAP и SECURITY.md supported versions в порядке.
- [ ] `test-docs` (инструменты/RPC/schema/сюиты/локали) зелёный.
- [ ] GitHub release создан для тега.
- [ ] Пока жив legacy: диапазон шима актуален, deprecation не снят.
- [ ] Критические баги аудита закрыты или документированы как known issues.
