# 🗺️ Roadmap — agent-steward

> North Star: [docs/CONCEPT.md](./docs/CONCEPT.md) — верифицируемая локально-первая оркестрация агент-задач.
> Это не «планировщик». Планировщик/уведомления/аналитика — триггеры и обвязка, не ядро (§8 CONCEPT).
>
> Модель работы — канбан. Каждая задача разложена слоями:
> **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг).
> В работу берётся ровно одна подзадача: подзадача → отчёт → следующая подзадача.
>
> **В активном канбане только открытые задачи.** Закрытые задачи и подзадачи уходят
> в [CHANGELOG.md](./CHANGELOG.md), а их иерархия сохраняется в архиве ниже — чтобы
> было видно «задача → подзадача» и по каждому ID можно было найти подробности.
>
> **Нумерация.** Нумерация сохранена для преемственности ссылок; следующий раздел — 4.

Текущая версия: **agent-steward 0.0.8** (подготовка релиза 25.11.2026).
Legacy: `opencode-windows-scheduler@1.5.9`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.

## Стратегический роадмап (пересобран 25.11.2026 по итогам полного QA)

Курс не изменился: локально-первый framework-супервизор, который сначала перестаёт быть OpenCode-специфичным, а затем становится MCP-нативным ([ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md), CONCEPT §4/§8). Что изменилось — порядок и входные данные: в план положены воспроизведённые находки полного аудита 25.11.2026, а не только продуктовые гипотезы.

| Горизонт | Ставка | Что должно быть правдой на выходе | Вход в канбан |
|---|---|---|---|
| 0 · сейчас (0–2 нед) | Доверие к релизу и честная диагностика | Находки аудита 25.11.2026 закрыты или документированы; версия, метрики и стратегия без противоречий; строгая установка не ломается | закрыто; вход — Release-чеклист §5 |
| 1 · 1–3 мес | P-1 изоляция ядра | `createToolSpecs`/`createRuntime`/`tool-specs.ts` отделены от OpenCode, контракт 34 specs зелёный, регрессия watch-paths исправлена | P-1 → P-2 → P-3 (жёсткий порядок) |
| 2 · 3–6 мес | MCP-нативная оркестрация | `agent-steward mcp` и subpath `./core`, `./mcp` стабильны; capability router и reliability scorecard работают на реальной истории | S-1, S-2, S-3 после закрытия P-1/P-2 |
| 3 · 6–12 мес | Экосистема и вторые харнессы | Рецепты/SKILL, верифицированный Telegram-чат, скаффолдинг из gate-passed примеров; P-4/P-5 — по боли пользователя | S-4, S-5, S-6, P-4, P-5 |

### Что означают ID в таблице горизонтов

**Проект** — `agent-steward`: локально-первый framework-супервизор для агент-задач. Планировщик, уведомления и аналитика — лишь триггеры и обвязка, не ядро (CONCEPT §8). Работа идёт по модели **Деталь** (подсистема/файлы) → **Задача** (что чиним/делаем) → **Подзадача** (атомарный шаг); в работу берётся ровно одна подзадача. Закрытое уходит в CHANGELOG, поэтому в таблице остаются только незавершённые ставки.

| ID | Что это | Статус на 26.11.2026 |
|---|---|---|
| P-1 | Изоляция ядра: `agent-steward/core` (`createToolSpecs`/`createRuntime`/`tool-specs.ts` отделены от OpenCode, контракт 34 specs) | Частично сделано; считается открытым до фикса регрессии `test-watch-paths.mjs` |
| P-2 | MCP-адаптер: `agent-steward mcp`, subpath `./core`, `./mcp` (~80% ценности горизонта 2) | Частично сделано, ждёт P-1 |
| P-3 | Универсальный harness: `AgentInvoker` + поле `harness`, runner local/docker/ssh через `invoke` | Открыт, после P-2 |
| S-1 | Открытый spec pipeline: `src/core/pipeline-open-spec.ts`, `parsePipelineYaml`, CLI `pipeline describe`, docs/OPEN-SPEC.md | ✅ Реализовано (Деталь 3.19), в таблице указано как вход горизонта 2 |
| S-2 | Capability-роутинг + flywheel: `agent-steward/router`, docs/ROUTER.md | ✅ Реализовано (Деталь 3.19) |
| S-3 | Reliability scorecard: objective gate outcomes, first-pass rate, token savings, docs/RELIABILITY.md | ✅ Реализовано (Деталь 3.19) |
| S-4 | Библиотека gate-passed рецептов: `src/core/recipes.ts`, docs/RECIPES.md | ✅ Реализовано (Деталь 3.19) |
| S-5 | Верифицированный чат: `src/core/verified-chat.ts`, docs/VERIFIED-CHAT.md | ✅ Реализовано (Деталь 3.19) |
| S-6 | Scaffolding из gate-passed рецептов: `src/core/scaffold.ts`, CLI `agent-steward scaffold`, docs/SCAFFOLD.md | ✅ Реализовано (Деталь 3.19) |
| P-4 | Нативный dsh-плагин (`src/dsh.ts`, ctx.tools/jobs) | Бэклог P3; P-4.1 уже в CHANGELOG |
| P-5 | `agent-steward serve` | Бэклог P3 |

> S-1…S-6 в стратегии помечены `future` как «входы» горизонтов 2–3, но код и тесты уже в Детали 3.19; это не открытые задачи, а проверенные возможности, на которые опираются P-1/P-2/P-3.

**Входы аудита, которые меняют приоритеты:** nondeterministic-версия MCP (`serverInfo.version=0.0.7` при package 0.0.8) блокировала доверие к любому MCP-клиенту — QA-FULL-02 закрыт; смешение skipped/interrupted с error в аналитике искажало scorecard горизонта 2 — QA-FULL-03 закрыт; engine-рассинхрон снят: QA-FULL-01 закрыт, `engines.node >=26.4.0` совпадает с `@opentui/core`, smoke `--engine-strict` работает в CI; пропуски PL-121 теперь видны в истории и дашборде — QA-FULL-06 закрыт.

**Правило пересборки:** при закрытии подзадачи она уходит из ROADMAP в CHANGELOG; стратегия обновляется в тот же коммит, чтобы «Ближайшие две недели» не расходились с канбаном (QA-FULL-04 закрыт, гейт в `test-docs.mjs`). Одна подзадача за раз, слой не пропускается.


---


## QA-находки (проверка работоспособности плагина 24.11.2026)

Все находки QA-D316-21…37 и все последующие QA-находки 25.11.2026 закрыты, удалены отсюда и перенесены в [CHANGELOG.md](./CHANGELOG.md). Открытых строк сейчас нет.

## Деталь 3.21 — Усиление в глубину (не расширение)
`src/core/savings.ts`, `src/core/permissions.ts`, `src/core/worktree.ts`, `src/core/audit.ts`, `src/core/self-analysis.ts`, `src/shared/installation-warning.ts`, `src/version.ts`, `src/index.ts`, `src/rpc.ts`, `src/gui.tsx`, `TEST-PLAN.md`, `test-budget.mjs`, `test-permissions-policy.mjs`, `test-self-analysis.mjs`, `test-gui-bundle.mjs`, `test-agent-tools.mjs`, `docs/SAFETY.md`, `docs/EXECUTION-LOOP.md`

Обоснование: модули стратегии (CONCEPT §11–§13, ROADMAP-STRATEGY) в основном закрыты, но несколько контуров доверия остаются непроверяемыми извне. Это не новые возможности, а углубление существующих: измеримость, аудируемость и воспроизводимость приёмки. Разбивка уточнена 25.11.2026: каждая подзадача даёт один проверяемый артефакт и закрывается своим тестом; SC-1.1/SC-1.2 и вся матрица Детали 3.20 закрыты и перенесены в CHANGELOG, здесь не дублируются. DEEP-1, DEEP-2, DEEP-3 и вся задача DEEP-4 (DEEP-4.1…DEEP-4.5) закрыты и перенесены в CHANGELOG; в Детали 3.21 открытых задач нет, в разделе QA-находок открытых строк нет. Находки QA-CI-261, QA-CI-B12, QA-CI-NODE26, QA-DEEP4-1, QA-FULL-01, QA-FULL-02, QA-FULL-03, QA-FULL-04, QA-FULL-05 и QA-FULL-06 закрыты и перенесены в CHANGELOG.

### Архив задач и подзадач (статус подтверждён кодом/тестами, не CHANGELOG)

> Активный канбан выше содержит только открытые строки. Ниже — иерархия уже выполненных работ: **задача → подзадача → объективный артефакт в коде/тесте**. «✅ по коду» означает, что файл/экспорт/поведение существует и покрыт зелёным тестом; CHANGELOG используется только как подробная хроника изменений, а не как источник статуса.

| Задача | Подзадача | Артефакт в коде / проверка | Статус |
|---|---|---|---|
| DEEP-1 Измеримость | DEEP-1.1 receipts | `src/core/savings.ts`, `test-budget.mjs` | ✅ по коду |
| DEEP-1 Измеримость | DEEP-1.2 верификация и версия | `test-user-version.mjs`, `docs/EXECUTION-LOOP.md` | ✅ по коду |
| DEEP-2 Целостность | DEEP-2.1 identity | `src/core/worktree.ts`, `test-worktree.mjs` | ✅ по коду |
| DEEP-2 Целостность | DEEP-2.2 deny / разрешения | `src/core/permissions.ts`, `src/core/audit.ts`, `test-permissions-policy.mjs`, `test-audit.mjs` | ✅ по коду |
| DEEP-3 Доверие | DEEP-3.1 self_analysis | `test-self-analysis.mjs` | ✅ по коду |
| DEEP-3 Доверие | DEEP-3.2 GUI | `src/gui.tsx`, `test-gui-bundle.mjs` | ✅ по коду |
| DEEP-3 Доверие | DEEP-3.3 fail-open preflight | `test-agent-tools.mjs`, `schedule_task` / `run_task_now` | ✅ по коду |
| DEEP-4 Приёмка D01–D18 | DEEP-4.1 матрица артефактов | `TEST-PLAN.md` §4.1, гейт в `test-docs.mjs` | ✅ по коду |
| DEEP-4 Приёмка D01–D18 | DEEP-4.2 D01–D06 | `TEST-PLAN.md` §8.1, 29 точечных `test-*.mjs` | ✅ по коду |
| DEEP-4 Приёмка D01–D18 | DEEP-4.3 D07–D12 | `TEST-PLAN.md` §8.1, 24 точечных `test-*.mjs` | ✅ по коду |
| DEEP-4 Приёмка D01–D18 | DEEP-4.4 D13–D18 | `TEST-PLAN.md` §8.1, 22 теста + `test:parallel` + локали | ✅ по коду |
| DEEP-4 Приёмка D01–D18 | DEEP-4.5 итог 18/18 | `TEST-PLAN.md` §8, гейт в `test-docs.mjs` | ✅ по коду |
| QA-CI-261 `/tr` >261 | укорочение команды | `src/core/ps-wrapper.ts` `buildWindowsHiddenTaskCommand`, `test-execution-hardening.mjs` | ✅ по коду |
| QA-CI-B12 heartbeat | стабилизация lease-теста | `test-run-journal.mjs` | ✅ по коду |
| QA-CI-NODE26 libuv | дренаж хендлов | `test-notifications-summary.mjs`, гейт в `test-docs.mjs` | ✅ по коду |
| QA-FULL-02 версия MCP | единый источник версии | `src/mcp.ts` `getPluginVersion`, `test-mcp-adapter.mjs` | ✅ по коду |
| QA-FULL-05 JSDoc | восстановление блока | `src/runtime.ts`, гейт в `test-docs.mjs` | ✅ по коду |
| QA-FULL-03 аналитика | раздельные бакеты skipped/interrupted | `src/core/analytics.ts`, `src/db/metrics-repo.ts`, `test-metrics.mjs`, `test-sqlite.mjs` | ✅ по коду |
| QA-FULL-01 engine | база Node 26.4 | `package.json` `engines.node`, `.github/workflows/*.yml`, `test-docs.mjs` | ✅ по коду |
| QA-FULL-04 стратегия | синхрон с канбаном | `ROADMAP-STRATEGY.md`, гейт в `test-docs.mjs` | ✅ по коду |
| QA-FULL-06 skipReason | пропуски PL-121 | `src/db/history-repo.ts`, `src/history.ts`, `src/index.ts`, `src/server.ts`, `docs/SAFETY.md`, `test-sqlite.mjs` | ✅ по коду |
| ROADMAP-CLARIFY | расшифровка ID | раздел «Что означают ID…», гейт в `test-docs.mjs` | ✅ по коду |
| P-1 Изоляция ядра | `agent-steward/core` | `src/core-entry.ts` (`createToolSpecs`, `createRuntimeCore`), `src/tool-specs.ts`, `src/runtime.ts`, `test-tool-specs.mjs`, `test-watch-paths.mjs` | ✅ по коду |
| P-2 MCP-адаптер | `agent-steward mcp` | `src/mcp.ts`, subpath `./mcp` в `package.json`, `test-mcp-adapter.mjs` | ✅ по коду |
| P-3 Универсальный harness | `AgentInvoker` + `harness` | `src/invokers/agent-invoker.ts`, `src/core-entry.ts`, `test-invokers.mjs` | ✅ по коду |
| P-4 dsh-плагин | адаптер | `src/dsh.ts`, `test-dsh-adapter.mjs` | ✅ по коду |
| P-5 serve | standalone dashboard | `src/serve.ts`, `src/cli.ts`, `test-dashboard.mjs` | ✅ по коду |
| S-1 Open spec | pipeline describe | `src/core/pipeline-open-spec.ts`, `test-open-spec.mjs` | ✅ по коду |
| S-2 Router | capability + flywheel | `src/router.ts`, `src/core/router/capability-math.ts`, `test-router.mjs` | ✅ по коду |
| S-3 Scorecard | reliability | `src/core/reliability-scorecard.ts`, `test-scorecard.mjs` | ✅ по коду |
| S-4 Recipes | gate-passed рецепты | `src/core/recipes.ts`, `test-recipes.mjs` | ✅ по коду |
| S-5 Verified chat | ответ по gate | `src/core/verified-chat.ts`, `test-verified-chat.mjs` | ✅ по коду |
| S-6 Scaffold | из рецептов | `src/core/scaffold.ts`, `test-scaffold.mjs` | ✅ по коду |

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
