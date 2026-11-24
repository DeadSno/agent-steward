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
