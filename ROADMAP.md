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
> **Нумерация.** Разделы 1–2 и детали 3.1–3.8 закрыты и перенесены в CHANGELOG,
> поэтому здесь первая открытая деталь — 3.9, а следующий раздел — 4. Нумерация
> сохранена для преемственности ссылок. Историческая «Деталь 3.8 — обратная связь
> пользователей (bug reports → GitHub Issues)» в CHANGELOG содержала только
> QA-находки (F-2/F-3/F-4); актуальные QA-находки — в разделе ниже.

Текущая версия: **agent-steward 0.0.6** (20.11.2026).
Legacy: `opencode-windows-scheduler@1.5.8`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.

---


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


### QA-находки, найденные при проверке работоспособности плагина

- [ ] PL-123 `dry_run` возвращает `estimatedDurationSec`/`estimatedTokens`/`estimatedCostUsd = null` и «Нет успешных запусков в истории» для новой задачи, хотя в общей истории 700+ успешных прогонов — `src/core/dry-run.ts` — P3. Действие: использовать глобальную историю как фолбэк оценки с пометкой об источнике. Обнаружено 23.11.2026.
- [ ] PL-124 история задачи остаётся `running` длительное время после того, как отчёт записан и дочерний `opencode` перестал потреблять CPU; финализация записи происходит только по таймауту 900 с — `src/core/record-history.ts`, `src/core/ps-wrapper.ts` — P2. Действие: детектировать завершение/простой дочернего процесса и финализировать запись сразу, добавить регрессию. Обнаружено 23.11.2026 на TOK-PROBE-OS/EVENT.
- [ ] PL-125 задачи, запущенные самим ОС-планировщиком (cron/once), полностью обходят бюджетный гейт: `checkBudgetGate` вызывается только в tool/RPC/manual-входах (`src/index.ts`), в `src/core/ps-wrapper.ts` бюджета нет; alt-ветка «бюджет исчерпан → задача пропущена» в sequence 4.1 для cron-пути ложна — `src/core/ps-wrapper.ts`, `src/core/record-history.ts`, `src/index.ts` — P2. Действие: enforce бюджета на registered-пути (wrapper или recorder до старта `opencode run`), добавить регрессию; см. задачу B-1. Обнаружено 23.11.2026 при аудите архитектуры и диаграмм.
- [ ] PL-126 задача с `worktree: true`, запущенная через `run_task_now`, зависает на стадии `prepared`: воркер не создаёт процесс и не создаёт worktree, лог содержит только «Task prepared» — `src/core/ps-wrapper.ts`, `src/core/worktree-run.ts`, `src/core/scheduler/run-now.ts` — P1. Действие: проверять результат `worktree-run.js create` до запуска агента, при ошибке падать с понятной причиной и чистить отдельный worktree; вручную `node dist/core/worktree-run.js --repo ... --task ...` работает. Обнаружено 23.11.2026 на зонде QA-STEW-PROBE-WT.
- [ ] PL-127 `scripts/pl-commit.ps1` не делает rebase при non-fast-forward push: при параллельном пуше в ту же ветку три попытки (`push`, `push#2`, `push#3`) получают reject, после чего helper пишет `FAIL push`, хотя коммит и quality gate зелёные; в `scripts/steward-commit.ps1` такой путь есть (PL-104) — `scripts/pl-commit.ps1` — P2. Действие: fetch + `rebase --autostash origin/dev` перед повторным push, как в steward-commit.ps1. Воспроизведено 23.11.2026 на QA-PL118-CLIXML когда параллельный агент запушил S3-D36.
- [ ] PL-128 дочерний процесс убит watchdog по таймауту (exit 124), но quality gate пройден: история получает статус `timeout`, post-flight помечается `error`, хотя PL-81 считает задачу успешной по вердикту гейта — `src/core/record-history.ts`, `src/core/ps-wrapper.ts` — P2. Действие: при gate=pass и exit=124 финализировать запись как success с причиной таймаута, не invalidating post-flight. Воспроизведено 23.11.2026 на QA-PL118-CLIXML.
- [ ] PL-129 `schedule_task` в core-профиле плагина не пробрасывает поля `mcpEvent` и `nextTaskOnSuccess` (а также остальные 18 «толстых» ключей `ADVANCED_SCHEMA_KEYS`): попытка создать MCP-event-зонд через `schedule_task` падает с «Для MCP-триггера нужно указать имя события», хотя `mcpEvent:{server,event}` передан; цепочки `nextTaskOnSuccess` из `.opencode/skills/roadmap-plugin-workflow/SKILL.md` в core-профиле невозможны — `src/core/tool-profile.ts`, `src/index.ts` — P2. Действие: либо документировать обязательный `schedule_advanced`/профиль `all` для event/chain, либо пробрасывать минимальные поля в core-схему; проверить в `test-agent-tools.mjs`. Обнаружено 23.11.2026 при проверке зондов Детали 3.13.
- [ ] PL-130 file-триггер срабатывает на каждую запись в наблюдаемый файл, включая собственные правки агента: зонд `DS313-FILE-PROBE` (watchPath — `ROADMAP.md`) за один сеанс получил 12 запусков (1 success, 11 error «Код возврата 1»), при этом `get_task_logs` содержит только общую строку об ошибке без причины падения агента — `src/core/file-watcher.ts`, `src/core/scheduler/run-now.ts`, `src/core/ps-wrapper.ts` — P3. Действие: дебаунс/игнорирование изменений, вызванных самим агентом, и логирование причины ошибки (например, лимита тарифа) вместо «Код возврата 1». Обнаружено 23.11.2026 при проверке зондов Детали 3.13.

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

> Деталь 3.13 — синхронизация документации и диаграмм после 3.10/3.11 — закрыта
> 23.11.2026: счётчики 32/59, четыре локали, список модулей и якоря сверены с кодом,
> DS-1…DS-5 перенесены в CHANGELOG. Актуальные находки проверки плагина — PL-129/PL-130.

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
