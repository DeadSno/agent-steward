# Announcements — куда и как рассказывать об agent-steward

Состояние на 26.11.2026, актуальная версия **0.0.9**. Документ содержит фактическую карту каналов и готовые тексты. Обозначения: ✅ выполнено, 🟡 нужно действие человека (нет учётки/доступа), ⚪ канал неприменим или соответствует не всем критериям.

> Важно: в PyPI есть unrelated-пакет `agent-steward`, а на GitHub — ~204 репозитория с таким именем. Всегда указывайте `DeadSno/agent-steward` и ссылку на https://www.npmjs.com/package/agent-steward.

## Карта каналов

| Канал | Где | Статус | Следующее действие |
|---|---|---|---|
| GitHub About / topics | https://github.com/DeadSno/agent-steward | ✅ | Описание переведено на формулировку «framework с OpenCode-плагином как текущим входом»; 18 topical-меток сохранены |
| npm | https://www.npmjs.com/package/agent-steward | ✅ | Описание пакета уже в framework-формулировке; `latest = 0.0.9` |
| awesome-opencode | PR [#1063](https://github.com/awesome-opencode/awesome-opencode/pull/1063) | ✅ | Тело обновлено до v0.0.9, добавлен комментарий-апдейт 26.11; ждём ревью мейнтейнеров (автор PR не может мержить) |
| Официальные доки OpenCode | PR [#65334](https://github.com/anomalyco/opencode/pull/65334) | ✅ | Исправлены опечатка `^Ggent-steward` и версия v0.0.6 → v0.0.9, добавлен комментарий-апдейт; ждём ревью |
| OpenDock / opencode.im | https://www.opendock.net/plugins/agent-steward/ · https://opencode.im/plugin/agent-steward | 🟡 | Страницы есть, но показывают v0.0.8; отправить запрос на обновление (шаблон ниже) |
| Hacker News | https://news.ycombinator.com/newstory | 🟡 | Show HN: текст готов ниже; нужен аккаунт и публикация вручную; searches по `agent-steward` пока дают 0 hits |
| Reddit | r/sideproject, r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding | 🟡 | Тексты готовы ниже; публикация вручную (нужен аккаунт с историей, иначе автоудаление спама) |
| DEV Community | https://dev.to/new | 🟡 | План статьи готов ниже; публикация вручную |
| Lobsters | https://lobste.rs/new | 🟡 | Короткий post готов ниже; нужен аккаунт/приглашение |
| Product Hunt | https://www.producthunt.com/posts/new | 🟡 | Прямой доступ проверен не был (403); проверить вручную, есть ли аккаунт и подходит ли формат |
| Habr / Telegram-каналы | https://habr.com/ru/newtopic/ | 🟡 | Русскоязычные тексты готовы ниже; публикация вручную |
| GitHub Pages / Discussions | — | ⚪ | `has_pages=false`, Discussions отключены: это не каналы, пока не включены явно |
| `github.com/topics/opencode-plugin` | https://github.com/topics/opencode-plugin | ⚪ | Проект есть в поиске по теме, но не на первой странице: 4 звёзды — мало для заметности |
| awesome-selfhosted | https://github.com/awesome-selfhosted/awesome-selfhosted | ⚪ | Перед PR сверить критерии: это плагин/фреймворк, а не отдельный self-hosted сервис |
| AlternativeTo / MCP-каталоги (mcp.so и др.) | websites | ⚪ | Требуют ручных форм/верификации; подготовить заявки при наличии аккаунта |

## Запрос на обновление в каталогах (OpenDock / opencode.im)

> Hi! The `agent-steward` listing still shows v0.0.8, while npm latest is **v0.0.9** (published 26.11.2026). The positioning has also changed: it is now described as a local-first agent orchestration framework with an OpenCode V1/V2 plugin as its current entry point (the same core is available via MCP, CLI and standalone). Could you refresh the version/description? Repo: https://github.com/DeadSno/agent-steward — npm: https://www.npmjs.com/package/agent-steward. Thanks!

## Hacker News — Show HN

**Title:** Show HN: agent-steward – local-first scheduler for AI agents (cron, DAG, matrix)

**Text:**

> I built agent-steward because cron wrappers around AI agents felt too thin for real work. It is a local-first agent orchestration framework, with an OpenCode V1/V2 plugin as its current entry point (the same core also runs via MCP, CLI and standalone).
>
> - Cron and one-shot jobs are registered in the native OS scheduler (Windows Task Scheduler, launchd, crontab), so they survive reboots and run with OpenCode closed.
> - DAG dependencies, matrix fan-out across repositories, quality gates and webhook/file/git/MCP triggers.
> - SQLite history, metrics, audit log and a local web dashboard. No SaaS, no telemetry, no account.
> - MIT, 34 agent tools, ru/en/zh/tr, Windows/macOS/Linux.
>
> Repo: https://github.com/DeadSno/agent-steward
> npm: https://www.npmjs.com/package/agent-steward (`opencode plugin add agent-steward`)
>
> Happy to answer questions about the scheduler backends or the pipeline-as-code format.

## Reddit

**r/sideproject** — title: `I built a local-first scheduler for AI agents that runs with the editor closed`

> I wanted scheduled agent jobs that survive reboots, so I built agent-steward. It registers cron/one-shot jobs in the native OS scheduler (Task Scheduler / launchd / crontab), and adds DAG pipelines, matrix builds across repos, quality gates and a local dashboard with SQLite history. Everything stays on your machine — no telemetry. MIT.
>
> Repo: https://github.com/DeadSno/agent-steward · npm: https://www.npmjs.com/package/agent-steward
>
> Curious how other people handle retries and dependencies for their agent jobs.

**r/LocalLLaMA** — title: `Local-first agent orchestration: OS-scheduled jobs, SQLite history, no telemetry`

> Sharing a tool I've been building: agent-steward runs AI agent jobs as workflows on your own machine. Jobs are registered in the OS scheduler, so cron/one-shot runs work with the editor closed; DAGs, matrix fan-out and quality gates are available too. History and metrics live in SQLite, with an optional local dashboard. There is a local-agent path in the docs for people who don't want a cloud provider. MIT, Windows/macOS/Linux.
>
> https://github.com/DeadSno/agent-steward

**r/ClaudeAI / r/ChatGPTCoding** — title: `Scheduled agent jobs that actually survive reboots: cron + DAG + matrix`

> If you use coding agents for repetitive work, this might help. agent-steward is a local-first orchestration framework: schedule cron/one-shot jobs via the native OS scheduler, chain them into DAG pipelines, fan one template out across repositories and gate success on a command like `npm test`. Local SQLite history and dashboard, no telemetry, MIT. Works as an OpenCode plugin (V1/V2), MCP server, CLI or standalone.
>
> https://github.com/DeadSno/agent-steward · https://www.npmjs.com/package/agent-steward

## DEV Community — план статьи

Title: `From cron wrappers to local-first agent orchestration: what I learned building agent-steward`

1. Why a cron wrapper wasn't enough: no dependencies, no retries, no visibility.
2. Native OS scheduler as the source of truth (Windows Task Scheduler / launchd / crontab) — why jobs keep running with the editor closed.
3. Workflow primitives: `dependsOn` DAGs, matrix fan-out, quality gates, notification channels.
4. Local observability: SQLite history, metrics, audit log, dashboard.
5. Pipeline-as-code example (`opencode.pipeline.yaml`) and `dry_run`.
6. What's next; links to repo/npm. Avoid claiming it is only a plugin — the current entry point is the OpenCode plugin, the core also runs via MCP/CLI/standalone.

## Lobsters

**Title:** `agent-steward – local-first agent orchestration with OS-scheduled jobs`

> Local-first framework for agent workflows: cron/one-shot jobs in the native OS scheduler, DAG dependencies, matrix builds, quality gates, SQLite history and a local dashboard. OpenCode V1/V2 plugin as the current entry point, plus MCP/CLI/standalone. MIT. https://github.com/DeadSno/agent-steward

## Product Hunt (проверить вручную)

Tagline: `Local-first scheduling and orchestration for AI agents`
Description: `Run agent jobs on the native OS scheduler — cron, one-shot, DAG pipelines, matrix builds and quality gates. Local SQLite history and dashboard. No telemetry, MIT.`

## Habr (русский)

**Заголовок:** `agent-steward: локально-первая оркестрация задач ИИ-агента с планировщиком ОС`

**Начало:**

> Большинство планировщиков для ИИ-агентов — это обёртки над cron: запустили промпт, записали лог. В agent-steward задача рассматривается как рабочий процесс: зависимости DAG, матричные сборки по нескольким репозиториям, quality gate на команду (`npm test`) и локальная история в SQLite.
>
> Ключевое отличие — cron- и разовые задачи регистрируются в нативном планировщике ОС (Планировщик Windows, launchd, crontab), поэтому переживают перезагрузку и работают с закрытым OpenCode. Никакой телеметрии и аккаунтов, лицензия MIT.
>
> Репозиторий: https://github.com/DeadSno/agent-steward · пакет: https://www.npmjs.com/package/agent-steward

## Telegram (короткий пост)

> agent-steward 0.0.9 — локально-первый фреймворк оркестрации ИИ-агентов. Cron/разовые задачи в системном планировщике ОС (работают с закрытым OpenCode), DAG, матричные сборки, quality gates, история в SQLite и локальный дашборд. MIT, без телеметрии.
> GitHub: https://github.com/DeadSno/agent-steward
> npm: https://www.npmjs.com/package/agent-steward

## Что делать после публикации

1. Зафиксировать ссылку на пост в CHANGELOG записью `docs(announce)` и в этом файле заменить статус 🟡 на ✅ с URL.
2. Повторить проверку упоминаний: `agent-steward` в поиске GitHub, DDG и HN (Algolia) — новые площадки должны индексироваться в течение дней.
3. Не путать с PyPI-тёзкой: в тексте всегда полный репозиторий `DeadSno/agent-steward` и npm-ссылка.

См. также: [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md) (X-6), [CHANGELOG.md](../CHANGELOG.md).
