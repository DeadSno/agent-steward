# 🗺️ Roadmap — agent-steward

> North Star: [docs/CONCEPT.md](./docs/CONCEPT.md) — верифицируемая локально-первая оркестрация агент-задач.
> Это не «планировщик». Планировщик/уведомления/аналитика — триггеры и обвязка, не ядро (§8 CONCEPT).
>
> Модель работы — канбан. Каждая задача разложена слоями:
> **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг).
> В работу берётся ровно одна подзадача: подзадача → отчёт → следующая подзадача.
>
> **В активном канбане только открытые задачи.** Закрытые уходят в [CHANGELOG.md](./CHANGELOG.md),
> а их иерархия «задача → подзадача» сохранена в архиве ниже — по каждому ID видно, что сделано и чем проверено.
>
> **Нумерация.** Нумерация сохранена для преемственности ссылок; следующий раздел — 4.

Текущая версия: **agent-steward 0.0.8** (подготовка релиза 25.11.2026).
Legacy: `opencode-windows-scheduler@1.5.9`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.

## Что делаем дальше

Курс не изменился: локально-первый framework-супервизор, который сначала перестаёт быть OpenCode-специфичным, а затем становится MCP-нативным ([ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md), CONCEPT §4/§8).

**Главное на сегодня:** все стратегические ставки уже подтверждены кодом и зелёными тестами. Открытых задач по P‑1…P‑5 и S‑1…S‑6 нет — они разобраны в архиве ниже. Дальше нужно только закрыть релизный чеклист (§5).

### Что означают ID

**Проект** — `agent-steward`: локально-первый framework-супервизор для агент-задач. Планировщик, уведомления и аналитика — лишь триггеры и обвязка, не ядро (CONCEPT §8). Работа идёт по модели **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг); в работу берётся ровно одна подзадача.

- **P-1** — изоляция ядра: `agent-steward/core`, `createToolSpecs`/`createRuntime` отделены от OpenCode, контракт 34 specs. ✅ Реализовано по коду: `src/core-entry.ts`, `src/tool-specs.ts`, `src/runtime.ts`, `test-tool-specs.mjs` 52/52, `test-watch-paths.mjs`.
- **P-2** — MCP-адаптер: `agent-steward mcp`, subpath `./core` и `./mcp`. ✅ Реализовано по коду: `src/mcp.ts`, `package.json`, `test-mcp-adapter.mjs` 10/10.
- **P-3** — универсальный harness: `AgentInvoker` + поле `harness`, runner local/docker/ssh через `invoke`. ✅ Реализовано по коду: `src/invokers/agent-invoker.ts`, `src/core-entry.ts`, `src/index.ts`, `test-invokers.mjs` 15/15.
- **P-4** — нативный dsh-плагин (`src/dsh.ts`, ctx.tools/jobs). ✅ Реализовано по коду: `src/dsh.ts`, `test-dsh-adapter.mjs` 7/7.
- **P-5** — `agent-steward serve`, standalone dashboard. ✅ Реализовано по коду: `src/serve.ts`, `src/cli.ts`, `test-dashboard.mjs`.
- **S-1** — открытый spec pipeline: `parsePipelineYaml`, CLI `pipeline describe`, docs/OPEN-SPEC.md. ✅ Реализовано по коду: `src/core/pipeline-open-spec.ts`, `test-open-spec.mjs`.
- **S-2** — capability-роутинг + flywheel: `agent-steward/router`, docs/ROUTER.md. ✅ Реализовано по коду: `src/router.ts`, `src/core/router/capability-math.ts`, `test-router.mjs` 29/29.
- **S-3** — reliability scorecard: objective gate outcomes, first-pass rate, token savings. ✅ Реализовано по коду: `src/core/reliability-scorecard.ts`, `test-scorecard.mjs` 43/43.
- **S-4** — библиотека gate-passed рецептов. ✅ Реализовано по коду: `src/core/recipes.ts`, `test-recipes.mjs` 44/44.
- **S-5** — верифицированный чат: ответ только при объективном gate/цитате/рецепте. ✅ Реализовано по коду: `src/core/verified-chat.ts`, `test-verified-chat.mjs` 43/43.
- **S-6** — scaffolding из gate-passed рецептов, CLI `agent-steward scaffold`. ✅ Реализовано по коду: `src/core/scaffold.ts`, `test-scaffold.mjs` 40/40.

**Входы аудита** — все находки QA-FULL‑01…06 и QA‑CI‑261/B12/NODE26 закрыты; статусы сверены с кодом и тестами, а не с CHANGELOG.

## Открытые задачи

- **⬜ Release-чеклист (§5)** — шесть шагов до релиза 0.0.8: версия==tag и CI, CHANGELOG/шапка/SECURITY, `test-docs` зелёный, GitHub release, шим/deprecation, критические баги аудита.
- Других открытых задач и QA-находок нет: бывшая Деталь 3.21 и все QA-строки закрыты и перенесены в CHANGELOG.

---

### Архив задач и подзадач (статус подтверждён кодом/тестами, не CHANGELOG)

> Выше — активный канбан только с открытыми строками. Ниже — иерархия уже выполненных работ: **задача → подзадача → объективный артефакт в коде/тесте**. «✅ по коду» означает, что файл/экспорт/поведение существует и покрыт зелёным тестом; CHANGELOG — только хроника изменений, а не источник статуса.

#### DEEP-1 Измеримость
- **DEEP-1.1** receipts — `src/core/savings.ts`, `test-budget.mjs` — ✅ по коду
- **DEEP-1.2** верификация и версия — `test-user-version.mjs`, `docs/EXECUTION-LOOP.md` — ✅ по коду

#### DEEP-2 Целостность
- **DEEP-2.1** identity — `src/core/worktree.ts`, `test-worktree.mjs` — ✅ по коду
- **DEEP-2.2** deny / разрешения — `src/core/permissions.ts`, `src/core/audit.ts`, `test-permissions-policy.mjs`, `test-audit.mjs` — ✅ по коду

#### DEEP-3 Доверие
- **DEEP-3.1** self_analysis — `test-self-analysis.mjs` — ✅ по коду
- **DEEP-3.2** GUI — `src/gui.tsx`, `test-gui-bundle.mjs` — ✅ по коду
- **DEEP-3.3** fail-open preflight — `test-agent-tools.mjs`, `schedule_task` / `run_task_now` — ✅ по коду

#### DEEP-4 Приёмка D01–D18
- **DEEP-4.1** матрица артефактов — `TEST-PLAN.md` §4.1, гейт в `test-docs.mjs` — ✅ по коду
- **DEEP-4.2** D01–D06 — `TEST-PLAN.md` §8.1, 29 точечных `test-*.mjs` — ✅ по коду
- **DEEP-4.3** D07–D12 — `TEST-PLAN.md` §8.1, 24 точечных `test-*.mjs` — ✅ по коду
- **DEEP-4.4** D13–D18 — `TEST-PLAN.md` §8.1, 22 теста + `test:parallel` + локали — ✅ по коду
- **DEEP-4.5** итог 18/18 — `TEST-PLAN.md` §8, гейт в `test-docs.mjs` — ✅ по коду

#### QA-CI
- **QA-CI-261** укорочение `schtasks /tr` — `src/core/ps-wrapper.ts`, `test-execution-hardening.mjs` — ✅ по коду
- **QA-CI-B12** стабилизация lease-теста — `test-run-journal.mjs` — ✅ по коду
- **QA-CI-NODE26** дренаж libuv-хендлов — `test-notifications-summary.mjs`, гейт в `test-docs.mjs` — ✅ по коду

#### QA-FULL
- **QA-FULL-01** база Node 26.4 — `package.json`, `.github/workflows/*.yml`, `test-docs.mjs` — ✅ по коду
- **QA-FULL-02** единый источник версии MCP — `src/mcp.ts`, `test-mcp-adapter.mjs` — ✅ по коду
- **QA-FULL-03** раздельные бакеты skipped/interrupted — `src/core/analytics.ts`, `src/db/metrics-repo.ts`, `test-metrics.mjs`, `test-sqlite.mjs` — ✅ по коду
- **QA-FULL-04** стратегия синхронизирована с канбаном — `ROADMAP-STRATEGY.md`, гейт в `test-docs.mjs` — ✅ по коду
- **QA-FULL-05** восстановление JSDoc — `src/runtime.ts`, гейт в `test-docs.mjs` — ✅ по коду
- **QA-FULL-06** пропуски PL-121 видны в истории — `src/db/history-repo.ts`, `src/history.ts`, `src/index.ts`, `src/server.ts`, `docs/SAFETY.md`, `test-sqlite.mjs` — ✅ по коду

#### ROADMAP
- **ROADMAP-CLARIFY** расшифровка ID — раздел «Что означают ID», гейт в `test-docs.mjs` — ✅ по коду
- **ROADMAP-ARCHIVE** архив задача → подзадача — этот раздел, гейт в `test-docs.mjs` — ✅ по коду

#### P — стратегические ставки
- **P-1** изоляция ядра — `src/core-entry.ts` (`createToolSpecs`, `createRuntimeCore`), `src/tool-specs.ts`, `src/runtime.ts`, `test-tool-specs.mjs`, `test-watch-paths.mjs` — ✅ по коду
- **P-2** MCP-адаптер — `src/mcp.ts`, subpath `./mcp` в `package.json`, `test-mcp-adapter.mjs` — ✅ по коду
- **P-3** универсальный harness — `src/invokers/agent-invoker.ts`, `src/core-entry.ts`, `test-invokers.mjs` — ✅ по коду
- **P-4** dsh-плагин — `src/dsh.ts`, `test-dsh-adapter.mjs` — ✅ по коду
- **P-5** serve — `src/serve.ts`, `src/cli.ts`, `test-dashboard.mjs` — ✅ по коду

#### S — проверенные возможности
- **S-1** Open spec — `src/core/pipeline-open-spec.ts`, `test-open-spec.mjs` — ✅ по коду
- **S-2** Router — `src/router.ts`, `src/core/router/capability-math.ts`, `test-router.mjs` — ✅ по коду
- **S-3** Scorecard — `src/core/reliability-scorecard.ts`, `test-scorecard.mjs` — ✅ по коду
- **S-4** Recipes — `src/core/recipes.ts`, `test-recipes.mjs` — ✅ по коду
- **S-5** Verified chat — `src/core/verified-chat.ts`, `test-verified-chat.mjs` — ✅ по коду
- **S-6** Scaffold — `src/core/scaffold.ts`, `test-scaffold.mjs` — ✅ по коду

---

# 4. Правила работы (канбан)

1. **Одна подзадача за раз.** Взял → сделал → отчёт → следующая подзадача.
2. **Слой не пропускается.** Деталь → задача → подзадача; подзадача закрывается только с тестом и документацией.
3. **Закрытое уходит из ROADMAP.** Выполненная задача/подзадача удаляется отсюда и попадает в CHANGELOG; иерархия остаётся в архиве выше.
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
