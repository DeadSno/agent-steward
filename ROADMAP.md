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
> **Нумерация.** Нумерация сохранена для преемственности ссылок; следующий раздел — 4.

Текущая версия: **agent-steward 0.0.8** (подготовка релиза 25.11.2026).
Legacy: `opencode-windows-scheduler@1.5.9`.

- Стратегия и позиционирование — [ROADMAP-STRATEGY.md](./ROADMAP-STRATEGY.md).
- Что уже сделано — [CHANGELOG.md](./CHANGELOG.md).
- Устройство и возможности — [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md), [docs/FEATURES.md](./docs/FEATURES.md).

Обозначения: ⬜ не начато · 🔄 в работе · ⏸️ внешнее действие.


---


## QA-находки (проверка работоспособности плагина 24.11.2026)

Все находки QA-D316-21…37 и все последующие QA-находки 25.11.2026 закрыты, удалены отсюда и перенесены в [CHANGELOG.md](./CHANGELOG.md). Ниже — только открытые находки, внесённые по факту воспроизведения 25.11.2026.

**QA-LAUNCH-1 — Сломанный путь загрузки плагина в глобальном конфиге** · P1 · ⬜
- [ ] `~/.config/opencode/opencode.jsonc:9` грузит плагин по `file:///C:/analytics/Системный аналитик теория/Системный анализ стажировка/qa-2411` — папки `qa-2411` не существует (есть `qa-2411-dev`). Инструменты плагина в Code Mode недоступны. Ранее путь уже правился (`opencode-windows-scheduler` → `qa-2411`, CHANGELOG:9/22) — регрессия. Починить путь и добавить fail-open preflight с предупреждением о stale-установке.

**QA-SUB-1 — Суб-агент упирается в лимит тарифа** · P2 · ⬜
- [ ] Суб-агент `explore` (`opencode/mimo-v2.6-flash-free`) завершился `Free usage limit reached`; лимит 1 суб-агента исчерпан (уже фиксировалось в CHANGELOG:17). Нужны явный local-agent fallback на Ollama (`hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M`, доступна на 127.0.0.1:11434; `qwen2.5:3b` при pull падает) и прозрачный statuses в ответе, чтобы задача не срывалась тихо.

**QA-BRIDGE-1 — Code Mode bridge открывает 8 из 34 инструментов** · P2 · ⬜
- [ ] Плагин регистрирует 34 инструмента, но в Code Mode catalog доступны только 8 (`src/index.ts:5284`, `CODE_MODE_BRIDGE_NOTE`). Проверить, какие инструменты теряются, и либо расширить мост, либо зафиксировать политику и причину в документации. Параллельно проверить плагин в вариантах с привязкой к ОС и без неё (HTTP/RPC `src/server.ts`: `/api/tasks`, `/api/history`, `/api/analytics`, `/api/health`, порт 3782) и результаты занести в CHANGELOG.

**QA-BASELINE-1 — Два набора в `test:parallel` падают на устаревших бейзлайнах** · P2 · ⬜
- [ ] Воспроизведение 25.11.2026: `npm run test:parallel` — 128/130, exit 1. `test-run-now.mjs` — 18/20: `QA-D316-20: early-return once снимает счётчик PL-106` и `единая функция снятия счётчика PL-106`. `test-tool-specs.mjs` — 46/52: снапшоты `get_history`/`schedule_task`/`schedule_advanced`/`update_task`/`update_advanced` не совпадают с текущими name+description+JSON-схемами, плюс `QA-PORT-4: core-профиль не тянет admin-инструменты` ожидает 10 инструментов core, а реестр отдаёт 11 (уже зафиксировано в CHANGELOG как 11). Падения не связаны с DEEP-1 (правки только в `savings.ts`, `test-budget.mjs`, доках): нужно обновить бейзлайны/снимки и исправить снятие счётчика PL-106 отдельной задачей, не смешивая с экономией верификации.

- [ ] **QA-D320-1** — устаревшие маркеры проверки QA-D316-20 в `test-run-now.mjs`: `npm test` падает 18/20 (`FAIL QA-D316-20: early-return once снимает счётчик PL-106`, `FAIL QA-D316-20: единая функция снятия счётчика PL-106`), хотя реализация `src/index.ts` корректно снимает per-checkout счётчик в `finally`. Тест ищет удалённый глобальный счётчик `activeNonIsolatedRuns++` и старую сигнатуру `releaseNonIsolatedRun(isolation.isolated)`. — P1. Действие: обновить проверку под `activeNonIsolatedByCheckout` / `releaseNonIsolatedRun(checkoutKey)`, сохранив инвариант «инкремент → try → early-return → finally», и прогнать `npm test`.


## Деталь 3.20 — Матрица покрытия стратегии и незакрытые контуры
`docs/CONCEPT.md` §11/§12/§13, `ROADMAP-STRATEGY.md`, `docs/ARCHITECTURE.md` Known limitations, `docs/EXECUTION-LOOP.md` §7–§9, `src/core/execution.ts`, `src/core/self-analysis.ts`, `src/db/capability-repo.ts`, `test-budget.mjs`, `test-permissions-policy.mjs`

Обоснование: спринты 40–47, экономика v2, Docker/SSH-модули, approvals, изоляция ядра и портативность уже закрыты и перенесены в CHANGELOG — повторно их в ROADMAP не вносим. Однако стратегия описывает не только модули, но и проверяемые критерии: CONCEPT §11 требует воспроизводимой петли обучения на фикс-наборе задач, §12 — управления cost of verification и прав вне write-scope, §13.2 — transport-независимого исполнения. Часть механизмов реализована, но не сведена в измеримый контур; часть осталась opt-in. Матрица ниже фиксирует, что именно ещё нужно закрыть, чтобы роадмап покрывал стратегию, а не только список файлов.

| Утверждение CONCEPT / стратегии | Покрытие | Остаток |
|---|---|---|
| §13.1 — Этап 1: dual V1/V2, единая поверхность | ✅ `setup`/`server`, 34 инструмента ↔ 61 RPC, CI на 3 ОС | — |
| §13.2 — Этап 2: Agent Executor Interface | ✅ AC-1.1…AC-1.5 (RunContext, StepExecutor, dry-run, паритет входов); EX-1.1 — runner через схему/CLI/RPC, fail-open на local; EX-1.2 — роли worker→reviewer и post-mortem/retry внутри execution loop; EX-1.3 — транспорт-независимость миссии на двух исполнителях доказана | — |
| §13.3 — Этап 3: MCP/API и совместимость с любым агентом | ✅ `./core`, `./mcp`, рецепты, verified-chat (S-1…S-6); AD-1 — адаптивность хоста и внешний контракт `agent-steward.external-contract@1.0` | — |
| §11.1–§11.4 — ad-hoc, local-first, гейт без irreversible, net-экономия | ✅ ROU-*, ARCH-4.*, E-*, EV-1.2 | Владелец, горизонт 28 дней и пороги зафиксированы в EXECUTION-LOOP §9 |
| §11.5–§11.7 — переиспользование примера, паритет, eval не деградировал | ✅ EV-1.1/EV-1.3 + AC-1.4/EV-2.2 | Версионированный набор из ledger и CI-gate с откатом работают |
| §12 — capped explore, staged LoRA | ✅ capped explore-бюджет и bandit (EV-2.3), LP-1.1/1.2/1.3 | Критерии датасета, офлайн-eval и shadow/canary с откатом зафиксированы; полный трафик не включался |
| §12 — cost of verification, права вне write-scope | ✅ SC-1.1 + DEEP-1: кэш проверок, per-check receipts и пересчёт net-экономии с инвариантом в `report.savings`/`honestEconomy`; SC-1.2: write-scope guard deny-by-default с явным opt-in и аудитом | — |

## Деталь 3.21 — Усиление в глубину (не расширение)
`src/core/savings.ts`, `src/core/permissions.ts`, `src/core/worktree.ts`, `src/core/audit.ts`, `src/core/self-analysis.ts`, `src/version.ts`, `src/gui.tsx`, `TEST-PLAN.md`, `test-budget.mjs`, `test-permissions-policy.mjs`, `test-self-analysis.mjs`, `test-gui-bundle.mjs`, `test-agent-tools.mjs`, `docs/SAFETY.md`, `docs/EXECUTION-LOOP.md`

Обоснование: модули стратегии (CONCEPT §11–§13, ROADMAP-STRATEGY) в основном закрыты, но несколько контуров доверия остаются непроверяемыми извне. Это не новые возможности, а углубление существующих: измеримость, аудируемость и воспроизводимость приёмки. Разбивка уточнена 25.11.2026: каждая подзадача даёт один проверяемый артефакт и закрывается своим тестом; SC-1.1/SC-1.2 уже заведены в Детали 3.20 и здесь не дублируются. DEEP-1 закрыт и перенесён в CHANGELOG. Порядок: сначала дешёвая диагностика установки (DEEP-3), затем изоляция (DEEP-2), затем дорогая приёмка (DEEP-4).

**Задача DEEP-2 — Write-scope между параллельными worktree** · P2 · ⬜ (продолжение SC-1.2)
- [ ] DEEP-2.1 Ввести identity write-заявки (worktree/session/id) и детерминированное обнаружение конкурирующих заявок в `src/core/worktree.ts`; регрессия в `test-permissions-policy.mjs`.
- [ ] DEEP-2.2 При конфликте — deny по умолчанию и событие в `src/core/audit.ts` с идентификаторами обеих заявок; регрессия в `test-permissions-policy.mjs`, обновить `docs/SAFETY.md`.

**Задача DEEP-3 — Версия установки видна до запуска задачи** · P2 · ⬜ (продолжение само-диагностики 1b18f55)
- [ ] DEEP-3.1 Поднимать `plugin.reason === "identity-mismatch"` / `plugin.staleInstallation` как предупреждение в `self_analysis`; регрессия в `test-self-analysis.mjs`.
- [ ] DEEP-3.2 Отображать то же предупреждение в GUI до запуска задачи; регрессия в `test-gui-bundle.mjs`.
- [ ] DEEP-3.3 Добавить fail-open preflight в `schedule_task`/`run_task_now`: предупреждение о stale-установке попадает в ответ до старта исполнения; регрессия в `test-agent-tools.mjs`.

**Задача DEEP-4 — Полная приёмка D01–D18 как воспроизводимая матрица** · P1 · ⬜
- [ ] DEEP-4.1 Свести три критерия («работает / доступ агента / доступ пользователя») к объективным артефактам для каждой D01–D18 и убрать criteria-хвост D17; `TEST-PLAN.md`, `test-docs.mjs`.
- [ ] DEEP-4.2 Прогнать D01–D06 (ядро/инструменты) по матрице и зафиксировать результаты; `TEST-PLAN.md`, точечные `test-*.mjs`.
- [ ] DEEP-4.3 Прогнать D07–D12 (оркестрация/DAG/качество) по матрице; `TEST-PLAN.md`, точечные `test-*.mjs`.
- [ ] DEEP-4.4 Прогнать D13–D18 (интеграция/OS/параллельные сборки, включая stale-установку) по матрице; `TEST-PLAN.md`, `test:worktree`, `test-portability-exports.mjs`.
- [ ] DEEP-4.5 Подвести итог: переключить статус «принято с ограничениями» только при 18/18 и перенести закрытые записи в CHANGELOG; `TEST-PLAN.md`, `CHANGELOG.md`.

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
