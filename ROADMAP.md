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


- [ ] PL-126 задача с `worktree: true`, запущенная через `run_task_now`, зависает на стадии `prepared`: воркер не создаёт процесс и не создаёт worktree, лог содержит только «Task prepared» — `src/core/ps-wrapper.ts`, `src/core/worktree-run.ts`, `src/core/scheduler/run-now.ts` — P1. Действие: проверять результат `worktree-run.js create` до запуска агента, при ошибке падать с понятной причиной и чистить отдельный worktree; вручную `node dist/core/worktree-run.js --repo ... --task ...` работает. Обнаружено 23.11.2026 на зонде QA-STEW-PROBE-WT.
- [ ] PL-127 `scripts/pl-commit.ps1` не делает rebase при non-fast-forward push: при параллельном пуше в ту же ветку три попытки (`push`, `push#2`, `push#3`) получают reject, после чего helper пишет `FAIL push`, хотя коммит и quality gate зелёные; в `scripts/steward-commit.ps1` такой путь есть (PL-104) — `scripts/pl-commit.ps1` — P2. Действие: fetch + `rebase --autostash origin/dev` перед повторным push, как в steward-commit.ps1. Воспроизведено 23.11.2026 на QA-PL118-CLIXML когда параллельный агент запушил S3-D36.
- [ ] PL-129 `schedule_task` в core-профиле плагина не пробрасывает поля `mcpEvent` и `nextTaskOnSuccess` (а также остальные 18 «толстых» ключей `ADVANCED_SCHEMA_KEYS`): попытка создать MCP-event-зонд через `schedule_task` падает с «Для MCP-триггера нужно указать имя события», хотя `mcpEvent:{server,event}` передан; цепочки `nextTaskOnSuccess` из `.opencode/skills/roadmap-plugin-workflow/SKILL.md` в core-профиле невозможны — `src/core/tool-profile.ts`, `src/index.ts` — P2. Действие: либо документировать обязательный `schedule_advanced`/профиль `all` для event/chain, либо пробрасывать минимальные поля в core-схему; проверить в `test-agent-tools.mjs`. Обнаружено 23.11.2026 при проверке зондов Детали 3.13.
- [ ] PL-130 file-триггер срабатывает на каждую запись в наблюдаемый файл, включая собственные правки агента: зонд `DS313-FILE-PROBE` (watchPath — `ROADMAP.md`) за один сеанс получил 12 запусков (1 success, 11 error «Код возврата 1»), при этом `get_task_logs` содержит только общую строку об ошибке без причины падения агента — `src/core/file-watcher.ts`, `src/core/scheduler/run-now.ts`, `src/core/ps-wrapper.ts` — P3. Действие: дебаунс/игнорирование изменений, вызванных самим агентом, и логирование причины ошибки (например, лимита тарифа) вместо «Код возврата 1». Обнаружено 23.11.2026 при проверке зондов Детали 3.13.
- [ ] PL-131 CLI `dist/core/gate-integrity.js` не запускается через симлинк/junction: self-exec-проверка сравнивает `path.resolve(process.argv[1])` с `import.meta.url`, не нормализуя реальный путь, поэтому при вызове через junction `process.exitCode` не выставляется и команда возвращает 0 даже на неверных аргументах (`node dist/core/gate-integrity.js verify` → 0 вместо 2; `worktree-verify` → 0 вместо 2). Из-за этого 4 проверки в `test-execution-pipeline.mjs` падают при прогоне из worktree с `dist`-junction, хотя в реальном каталоге проходят (проверено: копия `dist` + `node_modules`-junction в обычной папке — 0 провалов) — `dist/core/gate-integrity.js` (источник `src/core/gate-integrity.ts`) — P3. Действие: сравнивать реальные пути через `fs.realpathSync` (или убрать self-exec-гвард в пользу явного main), добавить регрессию на запуск через symlink. Обнаружено 23.11.2026 при финальном `npm test` Детали 3.13 (workaround — запускать тесты из реального чек-аута).
- [ ] PL-132 `scripts/pl-commit.ps1` после non-fast-forward делает `git rebase --autostash origin/dev`, который переигрывает все локальные коммиты ветки, уже присутствующие в `origin/dev` под другими хэшами: на задаче B-1 ветка `b312-3-12` (база `4a86907`) упёрлась в конфликты `CHANGELOG.md`/`ROADMAP.md` на коммите PL-122, после чего `git rebase --quit` оставил отсоединённый HEAD и неразрешённый индекс (`UU`), а пуш не состоялся — `scripts/pl-commit.ps1` — P2. Действие: при конфликте делать `git rebase --abort` (чистое состояние) и накатывать только новый коммит `cherry-pick` поверх свежего `origin/dev`, затем повторить пуш; добавить регрессию на расходящуюся ветку. Воспроизведено 23.11.2026 на B-1 (журнал `pl-commit.log`, 20:41:39–20:41:43).
- [ ] PL-133 ролевая политика задачи с `allowedTools:["shell"]` запрещает `read`/`grep`/`skill`, хотя промпт той же задачи просит загрузить скилл репозитория: дочерний агент B-1 ~10 минут тратил на попытки «load the specialized skill» / «explore the repository state» без продвижения — `src/core/ps-wrapper.ts` (генерация `OPENCODE_CONFIG_CONTENT` и политик), `.opencode/skills/agent-steward-dev/SKILL.md` — P3. Действие: либо автоматически добавлять `read`/`grep`/`skill` в `allowedTools`, когда промпт упоминает скилл, либо не требовать загрузку скилла в промптах shell-only задач. Обнаружено 23.11.2026 на OS-прогоне B-1.
- [ ] PL-134 история задачи остаётся `running` без прогресса, когда дочерний `opencode` жив, но не пишет в лог и почти не потребляет CPU (B-1: 25+ мин, лог застыл на 44 строках, CPU процесса ≈0,36 с, нет heartbeat и автофинализации) — `src/core/record-history.ts`, `src/core/ps-wrapper.ts` — P2. Действие: добавить heartbeat/детект простоя с понятной причиной («агент не отвечает») и досрочной финализацией записи, отличая от PL-124 (процесс завершён) и PL-126 (завис до старта). Обнаружено 23.11.2026 на OS-прогоне B-1.

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

**Задача B-3 — Диета описаний manage_* (admin-профиль)** · P3 · ⬜
- [ ] B-3.1 Сократить описания manage_* без потери PL-70-контракта; замер `measureToolSurface` + gpt-tokenizer до/после (admin сейчас ≈13.4k токенов)

> Деталь 3.13 — синхронизация документации и диаграмм после 3.10/3.11 — закрыта
> 23.11.2026: счётчики 32/59, четыре локали, список модулей и якоря сверены с кодом,
> DS-1…DS-5 перенесены в CHANGELOG. Актуальные находки проверки плагина — PL-129/PL-130/PL-131.

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
