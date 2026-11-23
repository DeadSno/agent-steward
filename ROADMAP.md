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

Текущая версия: **agent-steward 0.0.6** (20.11.2026).
Legacy: `opencode-windows-scheduler@1.5.8`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.

---

# 3. Остальные задачи (не бэклог и не архитектура)

## Деталь 3.5 — Approvals и окружения (0.1.0)
`src/core/approval*`, `src/core/environment*`

## Деталь 3.6 — Мульти-агентная оркестрация (0.2.x+)
`src/core/agents*`

## Деталь 3.7 — Инфраструктура и релиз (внешние действия)
`package.json`, npm, GitHub

**Задача X-1 — `npm deprecate` legacy** · P1 · ⏸️
- [ ] X-1.1 Депрекейт `opencode-windows-scheduler@1.5.8`

**Задача X-2 — Legacy 1.5.9 с `<0.1.0`** · P1 · ⏸️
- [ ] X-2.1 Upper bound, чтобы breaking 0.1.0 не прилетел

**Задача X-4 — Dependabot** · P2 · ⏸️
- [ ] X-4.1 Мерж #4 (plugin 2.3.0)
- [ ] X-4.2 OpenTUI 0.9.0

**Задача X-5 — Теги/релизы/версии** · P2 · ⏸️
- [ ] X-5.1 Привести теги к существующим релизам
- [ ] X-5.2 GitHub release для каждого тега

## Деталь 3.8 — Обратная связь от пользователей (bug reports → GitHub Issues)
`src/core/feedback.ts`, `src/settings.ts`, `src/index.ts`, `infra/feedback-worker/`

### QA-находки, найденные при проверке работоспособности плагина

- [ ] PL-119 pre-flight `schedule_task` отклоняет SCOPE-пути файлов, которые задача должна создать: `src/core/environment.ts`, `locales/tr.json` не существовали до запуска — `src/core/scheduler/run-now.ts` — P2. Действие: разрешить create-intent (явный список создаваемых файлов или `filesCreate`) и не требовать их существования на этапе планирования; сейчас обход — заранее создавать заглушки. Обнаружено 23.11.2026.
- [ ] PL-120 парсер SCOPE проглатывает хвост строки с прозой: путь `docs/FEATURES.md. Файл src/core/agents.ts — заглушка...` разбирается как один несуществующий путь и задача отклоняется — `src/core/scheduler/run-now.ts` — P2. Действие: требовать, чтобы строка SCOPE заканчивалась последним путём, и/или ужесточить парсер (стоп по первому не-пути), добавить регрессию. Обнаружено 23.11.2026.
- [ ] PL-121 параллельные задачи в одном чек-ауте падают на Quality Gate с общим сообщением «рабочее дерево изменилось во время прогона»: код написан, но afterScript не коммитит — `src/core/scheduler/run-now.ts`, `src/core/ps-wrapper.ts` — P1. Действие: делать уникальный worktree для каждой параллельной задачи или явно блокировать запуск до старта с понятной причиной; в сообщении гейта указывать конкретные изменившиеся пути. Воспроизведено 23.11.2026 одновременно в 5 задачах (PL-106 в новой форме).
- [ ] PL-122 `dry_run` выдаёт предупреждение PL-117 о неполном SCOPE (`ROADMAP.md`, `CHANGELOG.md`) для read-only задач-зондов, которые только запускают `test-docs.mjs` в qualityGate и не меняют документацию — `src/core/dry-run.ts` — P3. Действие: предупреждать только когда манифест задачи/afterScript реально пишет в эти файлы. Обнаружено 23.11.2026 при проверке TOK-PROBE-OS/EVENT.
- [ ] PL-123 `dry_run` возвращает `estimatedDurationSec`/`estimatedTokens`/`estimatedCostUsd = null` и «Нет успешных запусков в истории» для новой задачи, хотя в общей истории 700+ успешных прогонов — `src/core/dry-run.ts` — P3. Действие: использовать глобальную историю как фолбэк оценки с пометкой об источнике. Обнаружено 23.11.2026.
- [ ] PL-124 история задачи остаётся `running` длительное время после того, как отчёт записан и дочерний `opencode` перестал потреблять CPU; финализация записи происходит только по таймауту 900 с — `src/core/record-history.ts`, `src/core/ps-wrapper.ts` — P2. Действие: детектировать завершение/простой дочернего процесса и финализировать запись сразу, добавить регрессию. Обнаружено 23.11.2026 на TOK-PROBE-OS/EVENT.
- [ ] PL-125 задачи, запущенные самим ОС-планировщиком (cron/once), полностью обходят бюджетный гейт: `checkBudgetGate` вызывается только в tool/RPC/manual-входах (`src/index.ts`), в `src/core/ps-wrapper.ts` бюджета нет; alt-ветка «бюджет исчерпан → задача пропущена» в sequence 4.1 для cron-пути ложна — `src/core/ps-wrapper.ts`, `src/core/record-history.ts`, `src/index.ts` — P2. Действие: enforce бюджета на registered-пути (wrapper или recorder до старта `opencode run`), добавить регрессию; см. задачу B-1. Обнаружено 23.11.2026 при аудите архитектуры и диаграмм.

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

> Продолжение экономики токенов (закрытые Детали 3.10/3.11 — в CHANGELOG):
> телеметрия и рекомендации готовы, enforcement и автоприменение — нет.

**Задача B-1 — Бюджетный гейт на registered-пути (PL-125)** · P2 · ⬜
- [ ] B-1.1 Проверять бюджет до старта `opencode run` в wrapper/recorder для cron/once-триггеров; при исчерпании — пропуск с понятной причиной и записью в историю
- [ ] B-1.2 Регрессия: cron-запуск при исчерпанном бюджете не стартует; manual/tool-входы не сломаны

**Задача B-2 — Actionable model routing** · P3 · ⬜
- [ ] B-2.1 Применять `recommendModelForTask` не только советом в `dry_run`: предупреждение при `schedule_task`/`update_task` и опциональный автовыбор по явному флагу задачи
- [ ] B-2.2 Регрессия: явно заданная модель никогда не переопределяется

**Задача B-3 — Диета описаний manage_* (admin-профиль)** · P3 · ⬜
- [ ] B-3.1 Сократить описания manage_* без потери PL-70-контракта; замер `measureToolSurface` + gpt-tokenizer до/после (admin сейчас ≈13.4k токенов)

## Деталь 3.13 — Синхронизация документации и диаграмм после 3.10/3.11 (0.0.7+)
`docs/ARCHITECTURE.md`, `docs/ARCHITECTURE-DIAGRAMS.md`, `docs/ARCHITECTURE-DIAGRAMS-SEQUENCES.md`, `docs/ARCHITECTURE-DIAGRAMS-STATES.md`, `ROADMAP-STRATEGY.md`, `docs/CONCEPT.md`, `docs/EXECUTION-LOOP.md`

> Аудит 23.11.2026: каркас документов корректен, но после быстрых итераций
> накопился дрейф — устаревшие счётчики, висячие ссылки на закрытые задачи
> и одна содержательная ошибка в sequence 4.1.

**Задача DS-3 — Счётчики, локали и висячие ссылки** · P2 · ⬜
- [ ] DS-3.1 `docs/ARCHITECTURE.md`: «30-tool registry» → 32, RPC «57 methods» → 59, добавить локаль `tr` в Localization и settings
- [ ] DS-3.2 `docs/ARCHITECTURE-DIAGRAMS.md`: список файлов core дополнить `agents.ts`, `approval-api.ts`, `environment.ts`, `runner.ts`, `runner-docker.ts`, `runner-ssh.ts`, `tool-profile.ts` (71 → 78 модулей); убрать висячие ссылки на PL-90/65/66/79/82, D-1…D-3, E-3…E-5 (закрыты/удалены); обновить gap-analysis (runner'ы уже в коде)
- [ ] DS-3.3 `ROADMAP-STRATEGY.md`: метрики 30/57 → 32/59, локали {ru,en,zh} → 4 каталога с tr, убрать ссылку на закрытую Деталь 3.10 и «телеметрия нулевая», обновить статусы Этапа 2 (approvals закрыты)
- [ ] DS-3.4 `docs/CONCEPT.md` §12: hash-chain реализован (`verifyGateOutcomeChain`) — обновить статус 🔄; `docs/EXECUTION-LOOP.md`: §1 отметить закрытие durable-run (ARCH-1.1), §3 DDL пометить как целевую схему (economy-колонок в `gate_outcomes` пока нет)

**Задача DS-4 — Описать функционал 3.10/3.11 в ARCHITECTURE.md** · P2 · ⬜
- [ ] DS-4.1 Профили инструментов `core`/`admin`/`all` + `AGENT_STEWARD_TOOL_PROFILE`, split `schedule_advanced`/`update_advanced`, offline-fallback `estimateRunUsage` + событие `usage.offline_estimate`, `compact` в `get_history`, KPI `tokenEfficiency` в metrics, preflight skip-risk и `recommendModelForTask` в `dry_run`
- [ ] DS-4.2 Дополнить таблицу модулей: `execution.ts`, `mission.ts`, `budget.ts`, `savings.ts`, `tool-profile.ts`, `usage-surface.ts`, `opencode-usage.ts`, `approval-api.ts`, `runner*.ts`, `agents.ts`, `environment.ts` и др.
- [ ] DS-4.3 Обновить «Known limitations (execution)»: owner_pid v8 и `recoverStaleRunningOnRecorderStart` уже есть; добавить PL-124 (история висит `running` до таймаута)

**Задача DS-5 — Структура и устойчивость документов** · P3 · ⬜
- [ ] DS-5.1 ROADMAP: пояснить отсутствие разделов 1–2 (нумерация начинается с 3) или перенумеровать; привести заголовок Детали 3.8 в соответствие с содержимым (только QA-находки)
- [ ] DS-5.2 Компонентная диаграмма 3: заменить якоря по номерам строк (`execution.ts:213` и т.п.) на якоря по именам функций — номера дрейфуют при каждом коммите
- [ ] DS-5.3 Расширить `test-docs.mjs`: проверять счётчики инструментов/RPC и список модулей в ARCHITECTURE.md и диаграммах, чтобы дрейф ловился CI

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
