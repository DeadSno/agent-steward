# Announcements — куда и как рассказывать об agent-steward

Состояние на 27.11.2026, актуальная версия **0.0.11** (исправлен регистр `mcpName` для официального MCP Registry); публикация в MCP Registry выполнена релизом `v0.0.11`: запись `io.github.DeadSno/agent-steward` v0.0.11 активна, X-7 закрыт. Документ содержит фактическую карту каналов и готовые тексты. Обозначения: ✅ выполнено, 🟡 нужно действие человека (нет учётки/доступа), ⚪ канал неприменим или соответствует не всем критериям.

> Позиционирование: `agent-steward` — не только плагин. Это локально-первый фреймворк оркестрации с **полноценным MCP-сервером** (`agent-steward mcp`, stdio, 34 инструмента + `batch_call`, ресурс и промпт), OpenCode V1/V2-плагином, CLI и standalone-режимом как равноправными точками входа. Во всех текстах это нужно говорить прямо.

> Важно: в PyPI есть unrelated-пакет `agent-steward`, а на GitHub — ~204 репозитория с таким именем. Всегда указывайте `DeadSno/agent-steward` и ссылку на https://www.npmjs.com/package/agent-steward.

## Карта каналов

| Канал | Где | Статус | Следующее действие |
|---|---|---|---|
| GitHub About / topics | https://github.com/DeadSno/agent-steward | ✅ | Описание переведено на MCP-first формулировку: framework с MCP-сервером и OpenCode V1/V2-плагином как точками входа; 20 topical-меток, включая `mcp` и `model-context-protocol` |
| GitHub Discussions | https://github.com/DeadSno/agent-steward/discussions | ✅ | Включены 26.11.2026: Announcements https://github.com/DeadSno/agent-steward/discussions/12 и Show and tell https://github.com/DeadSno/agent-steward/discussions/13 |
| README en/ru/zh | https://github.com/DeadSno/agent-steward#readme | ✅ | Добавлены разделы «MCP server» / «MCP-сервер» / «MCP 服务器» с конфигом `npx -y agent-steward mcp` и ссылкой на `docs/mcp-setup.md` |
| Профиль GitHub | https://github.com/DeadSno/DeadSno | ✅ | README профиля обновлён: агент-оркестрация с MCP-сервером, а не «плагин для OpenCode» |
| GitHub Wiki | https://github.com/DeadSno/agent-steward/wiki | 🟡 | Wiki включена, но git-репозиторий wiki не создан (clone/push дают 404); первую страницу нужно завести через веб-интерфейс |
| npm | https://www.npmjs.com/package/agent-steward | ✅ | `0.0.10` опубликован workflow (run `45784589913`, shasum `2021e825f0cf0dd1058e86bcb18aade367710cf9`); `0.0.11` исправляет регистр `mcpName` и публикуется тегом `v0.0.11` через release workflow |
| awesome-opencode | PR [#1063](https://github.com/awesome-opencode/awesome-opencode/pull/1063) | ✅ | Тело обновлено до v0.0.9; [комментарий-апдейт](https://github.com/awesome-opencode/awesome-opencode/pull/1063#issuecomment-7185920579) и [MCP-first уточнение](https://github.com/awesome-opencode/awesome-opencode/pull/1063#issuecomment-7186242015); ждём ревью мейнтейнеров |
| Официальные доки OpenCode | PR [#65334](https://github.com/anomalyco/opencode/pull/65334) | ✅ | Исправлены опечатка `^Ggent-steward` и версия v0.0.6 → v0.0.9; [комментарий-апдейт](https://github.com/anomalyco/opencode/pull/65334#issuecomment-7185920463) и [MCP-first уточнение](https://github.com/anomalyco/opencode/pull/65334#issuecomment-7186239431); ждём ревью |
| OpenDock / opencode.im | https://www.opendock.net/plugins/agent-steward/ · https://opencode.im/plugin/agent-steward | 🟡 | Страницы есть, но показывают v0.0.8; отправить запрос на обновление (шаблон ниже) |
| Hacker News | https://news.ycombinator.com/newstory | 🟡 | Show HN: текст готов ниже; нужен аккаунт и публикация вручную; searches по `agent-steward` пока дают 0 hits |
| Reddit | r/sideproject, r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding | 🟡 | Тексты готовы ниже; публикация вручную (нужен аккаунт с историей, иначе автоудаление спама) |
| DEV Community | https://dev.to/new | 🟡 | План статьи готов ниже; публикация вручную |
| Lobsters | https://lobste.rs/new | 🟡 | Короткий post готов ниже; нужен аккаунт/приглашение |
| Product Hunt | https://www.producthunt.com/posts/new | 🟡 | Прямой доступ проверен не был (403); проверить вручную, есть ли аккаунт и подходит ли формат |
| Habr / Telegram-каналы | https://habr.com/ru/newtopic/ | 🟡 | Русскоязычные тексты готовы ниже; публикация вручную |
| GitHub Pages | — | ⚪ | `has_pages=false`; для сайта нужно отдельно включать Pages и публиковать статику |
| `github.com/topics/opencode-plugin` | https://github.com/topics/opencode-plugin | ⚪ | Проект есть в поиске по теме, но не на первой странице: 4 звёзды — мало для заметности |
| awesome-selfhosted | https://github.com/awesome-selfhosted/awesome-selfhosted | ⚪ | Перед PR сверить критерии: это плагин/фреймворк, а не отдельный self-hosted сервис |
| Официальный MCP Registry | https://registry.modelcontextprotocol.io/v0.1/servers?search=agent-steward | ✅ | Запись `io.github.DeadSno/agent-steward` v0.0.11 активна (publishedAt 09:05:18Z, isLatest=true); job `publish-mcp` `139799474235` в run `45787404530` зелёный после исправления регистра `mcpName` |
| Glama | https://glama.ai/mcp/servers | 🟡 | Добавлен `glama.json` с `maintainers: ["DeadSno"]`; индексация автоматическая, подтверждение заявки — ручной вход |
| mcp.so / mcpservers.org / mcpmarket / cursor.directory | web forms | 🟡 | Только ручные формы с аккаунтом; Free/платные варианты и сроки проверки сверить на месте |
| PulseMCP | https://www.pulsemcp.com/submit | ⚪ | Приём новых заявок приостановлен с сентября 2026; каталог импортирует данные из официального реестра |
| Smithery | https://smithery.ai/new | ⚪ | Онбординг удалён 31.10.2026 (`/new` возвращает 403); каталог доступен только для чтения |
| GitHub MCP Registry | https://github.com/mcp | ⚪ | Кураторский список без документированной формы отправки; подать нечем |
| punkpeye/awesome-mcp-servers | https://github.com/punkpeye/awesome-mcp-servers | 🟡 | PR возможен, но перед мержем требуется бейдж/обратная ссылка на страницу Glama; сначала индексация в Glama |
| Docker MCP catalog | https://github.com/docker/mcp-registry | ⚪ | Нужен Dockerfile/опубликованный OCI-образ; сейчас дистрибутив только npm |
| AlternativeTo | https://alternativeto.net | 🟡 | Ручная форма; готовый текст positioning использовать из раздела выше |

## MCP-реестры: подготовленные файлы и блокеры

В корне репозитория добавлены:

- `server.json` — метаданные для [официального MCP Registry](https://registry.modelcontextprotocol.io): имя `io.github.DeadSno/agent-steward`, npm-пакет `agent-steward@0.0.11`, транспорт `stdio`, ссылка на репозиторий. Проверка: `mcp-publisher validate` (CLI ставится из [релизов](https://github.com/modelcontextprotocol/registry/releases)).
- `glama.json` — маркер владельца для [Glama](https://glama.ai/mcp/servers): `maintainers: ["DeadSno"]`. После индексации репозитория можно подтвердить заявку и получить бейдж, который требуется для PR в `punkpeye/awesome-mcp-servers`.

**Публикация в официальный реестр:** реестр сверяет `server.json` с полем `mcpName` в *опубликованном* npm-пакете, и пространство имён GitHub регистрочувствительно. В `0.0.10` npm-пакет был опубликован (shasum `2021e825f0cf0dd1058e86bcb18aade367710cf9`), но `publish-mcp` сначала ждал 5 минут появления версии через `npm view` (зеркало отставало), а после повтора получил HTTP 403: OIDC разрешал `io.github.DeadSno/*`, а `mcpName` и `server.json:name` использовали `io.github.deadsno/...`. В `0.0.11` регистр исправлен на `io.github.DeadSno/agent-steward`, шаг ожидания проверяет прямой `https://registry.npmjs.org/agent-steward/<version>` 60 раз по 10 с. Публикацию npm выполняет release workflow по тегу `v0.0.11`, затем job `publish-mcp` делает `mcp-publisher validate`, `login github-oidc` и `publish`. Проверка после прогона: `npm view agent-steward@0.0.11 mcpName` и запрос к `https://registry.modelcontextprotocol.io/v0.1/servers?search=agent-steward`. Официальный реестр канонический: Glama, PulseMCP и mcp.so подхватывают записи оттуда автоматически.

## Запрос на обновление в каталогах (OpenDock / opencode.im)

> Hi! The `agent-steward` listing still shows v0.0.8, while npm latest is **v0.0.11** (published 26.11.2026). The positioning has also changed: it is a local-first agent orchestration framework with a full **MCP stdio server** (`agent-steward mcp`, 34 tools), an OpenCode V1/V2 plugin, CLI and standalone as entry points — not just a plugin. Could you refresh the version/description (and add an MCP section if the catalog supports it)? Repo: https://github.com/DeadSno/agent-steward — npm: https://www.npmjs.com/package/agent-steward — MCP setup: https://github.com/DeadSno/agent-steward/blob/dev/docs/mcp-setup.md. Thanks!

## Hacker News — Show HN

**Title:** Show HN: agent-steward – local-first MCP server for scheduling AI agents (cron, DAG, matrix)

**Text:**

> I built agent-steward because cron wrappers around AI agents felt too thin for real work. It is a local-first agent orchestration framework with a real MCP stdio server (`agent-steward mcp`, 34 tools + `batch_call`); the same core also runs as an OpenCode V1/V2 plugin, CLI or standalone.
>
> - Cron and one-shot jobs are registered in the native OS scheduler (Windows Task Scheduler, launchd, crontab), so they survive reboots and run with the editor closed.
> - DAG dependencies, matrix fan-out across repositories, quality gates and webhook/file/git/MCP triggers.
> - SQLite history, metrics, audit log and a local web dashboard. No SaaS, no telemetry, no account.
> - MIT, ru/en/zh/tr, Windows/macOS/Linux.
>
> MCP config: `{"mcpServers":{"agent-steward":{"command":"npx","args":["-y","agent-steward","mcp"]}}}`
>
> Repo: https://github.com/DeadSno/agent-steward
> npm: https://www.npmjs.com/package/agent-steward
> MCP setup: https://github.com/DeadSno/agent-steward/blob/dev/docs/mcp-setup.md
>
> Happy to answer questions about the scheduler backends, the MCP tool surface or the pipeline-as-code format.

## Reddit

**r/sideproject** — title: `I built a local-first scheduler for AI agents that runs with the editor closed`

> I wanted scheduled agent jobs that survive reboots, so I built agent-steward. It registers cron/one-shot jobs in the native OS scheduler (Task Scheduler / launchd / crontab), and adds DAG pipelines, matrix builds across repos, quality gates and a local dashboard with SQLite history. Everything stays on your machine — no telemetry, MIT. Exposed as an MCP server (stdio), an OpenCode plugin, CLI and standalone.
>
> Repo: https://github.com/DeadSno/agent-steward · npm: https://www.npmjs.com/package/agent-steward
>
> Curious how other people handle retries and dependencies for their agent jobs.

**r/LocalLLaMA** — title: `Local-first agent orchestration: OS-scheduled jobs, SQLite history, no telemetry`

> Sharing a tool I've been building: agent-steward runs AI agent jobs as workflows on your own machine. Jobs are registered in the OS scheduler, so cron/one-shot runs work with the editor closed; DAGs, matrix fan-out and quality gates are available too. History and metrics live in SQLite, with an optional local dashboard. There is a local-agent path in the docs for people who don't want a cloud provider. MIT, Windows/macOS/Linux; MCP server (stdio) plus OpenCode plugin/CLI/standalone.
>
> https://github.com/DeadSno/agent-steward

**r/ClaudeAI / r/ChatGPTCoding** — title: `Scheduled agent jobs that actually survive reboots: cron + DAG + matrix`

> If you use coding agents for repetitive work, this might help. agent-steward is a local-first orchestration framework: schedule cron/one-shot jobs via the native OS scheduler, chain them into DAG pipelines, fan one template out across repositories and gate success on a command like `npm test`. Local SQLite history and dashboard, no telemetry, MIT. It is an MCP server (stdio, 34 tools) first, and also an OpenCode V1/V2 plugin, CLI or standalone.
>
> https://github.com/DeadSno/agent-steward · https://www.npmjs.com/package/agent-steward

## DEV Community — план статьи

Title: `From cron wrappers to local-first agent orchestration: what I learned building agent-steward`

1. Why a cron wrapper wasn't enough: no dependencies, no retries, no visibility.
2. Native OS scheduler as the source of truth (Windows Task Scheduler / launchd / crontab) — why jobs keep running with the editor closed.
3. Workflow primitives: `dependsOn` DAGs, matrix fan-out, quality gates, notification channels.
4. Local observability: SQLite history, metrics, audit log, dashboard.
5. Pipeline-as-code example (`opencode.pipeline.yaml`) and `dry_run`.
6. MCP as a first-class surface: `agent-steward mcp` over stdio, 34 tools + `batch_call`, resource/prompt, client configs for Cursor/VS Code/JetBrains.
7. What's next; links to repo/npm/MCP setup. Avoid claiming it is only a plugin — the core runs as an MCP server, OpenCode plugin, CLI and standalone.

## Lobsters

**Title:** `agent-steward – local-first MCP server for agent orchestration with OS-scheduled jobs`

> Local-first framework for agent workflows, exposed primarily as an MCP stdio server (`agent-steward mcp`, 34 tools): cron/one-shot jobs in the native OS scheduler, DAG dependencies, matrix builds, quality gates, SQLite history and a local dashboard. Also an OpenCode V1/V2 plugin, CLI and standalone. MIT. https://github.com/DeadSno/agent-steward · MCP setup: https://github.com/DeadSno/agent-steward/blob/dev/docs/mcp-setup.md

## Product Hunt (проверить вручную)

Tagline: `Local-first MCP server for scheduling and orchestrating AI agents`
Description: `An MCP stdio server (34 tools) for agent jobs on the native OS scheduler — cron, one-shot, DAG pipelines, matrix builds and quality gates. Local SQLite history and dashboard. No telemetry, MIT. Also an OpenCode plugin, CLI and standalone.`

## Habr (русский)

**Заголовок:** `agent-steward: локально-первая оркестрация задач ИИ-агента с планировщиком ОС`

**Начало:**

> Большинство планировщиков для ИИ-агентов — это обёртки над cron: запустили промпт, записали лог. В agent-steward задача рассматривается как рабочий процесс: зависимости DAG, матричные сборки по нескольким репозиториям, quality gate на команду (`npm test`) и локальная история в SQLite.
>
> Ключевое отличие — cron- и разовые задачи регистрируются в нативном планировщике ОС (Планировщик Windows, launchd, crontab), поэтому переживают перезагрузку и работают с закрытым редактором. Agent-steward — это не просто плагин: доступны полноценный MCP-сервер (`agent-steward mcp`, stdio, 34 инструмента), плагин OpenCode V1/V2, CLI и standalone. Никакой телеметрии и аккаунтов, лицензия MIT.
>
> Репозиторий: https://github.com/DeadSno/agent-steward · пакет: https://www.npmjs.com/package/agent-steward · MCP-настройка: https://github.com/DeadSno/agent-steward/blob/dev/docs/mcp-setup.md

## Telegram (короткий пост)

> agent-steward 0.0.11 — локально-первый фреймворк оркестрации ИИ-агентов с MCP-сервером (stdio, 34 инструмента), плагином OpenCode V1/V2, CLI и standalone. Cron/разовые задачи в системном планировщике ОС (работают с закрытым редактором), DAG, матричные сборки, quality gates, история в SQLite и локальный дашборд. MIT, без телеметрии.
> GitHub: https://github.com/DeadSno/agent-steward
> npm: https://www.npmjs.com/package/agent-steward

## Что делать после публикации

1. Зафиксировать ссылку на пост в CHANGELOG записью `docs(announce)` и в этом файле заменить статус 🟡 на ✅ с URL.
2. Повторить проверку упоминаний: `agent-steward` в поиске GitHub, DDG и HN (Algolia) — новые площадки должны индексироваться в течение дней.
3. Не путать с PyPI-тёзкой: в тексте всегда полный репозиторий `DeadSno/agent-steward` и npm-ссылка.

См. также: [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md) (X-6), [CHANGELOG.md](../CHANGELOG.md).
