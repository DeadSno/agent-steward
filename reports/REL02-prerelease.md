# REL-02 — предрелизная проверка перед мержем `dev` → `main`

Дата: 2026-11-20  
Репозиторий: `DeadSno/agent-steward`  
Текущая ветка: `dev`  
SCOPE: только `CHANGELOG.md` и настоящий отчёт. Код и документация не изменялись; коммит и push не выполнялись.

## Итог

| Проверка | Результат |
| --- | --- |
| Рабочее дерево чистое | ❌ На момент проверки **НЕТ** (правки REL-01, детали ниже); ✅ после проверки обёртка REL-01 их закоммитила, остался только неотслеживаемый отчёт REL-02 |
| `dev` синхронизирована с `origin/dev` | ✅ Да, `HEAD == origin/dev` (сначала `86a9350d…`, после проверки `4ecb3d8…`) |
| `main` является предком `dev` | ✅ Да, `git merge-base --is-ancestor main dev` → exit `0` |
| Мерж `dev` → `main` | ✅ Будет **fast-forward** (на момент проверки `0` коммитов позади / `123` вперёд) |
| GitHub Actions для `dev` | ✅ На момент проверки run `44784642500`: `completed` / `success`, `head_sha == HEAD (86a9350d…)`; ⏳ после проверки для нового HEAD `4ecb3d8…` run `44787411521` — `queued`, `conclusion` ещё нет |
| Команды Quality Gate | ⏭️ Делегированы обёртке, которая создаёт маркер; результаты здесь не фиксируются |

**Вердикт на момент проверки:** технических блокировок для fast-forward-мержа не было (синхронизация, предок, CI зелёный на проверяемом коммите); расхождением было грязное дерево из-за параллельной задачи REL-01.

**Обновлённый вердикт:** обёртка REL-01 закоммитила правки (`4ecb3d8`), дерево стало чистым кроме настоящего отчёта, но CI для нового HEAD ещё не завершён (`44787411521` в `queued`). **Перед мержем дождаться зелёного `conclusion` run `44787411521`** — предыдущий зелёный результат относится к `86a9350d…`, а не к текущему `4ecb3d8…`.

## Хеши коммитов

| Объект | Хеш |
| --- | --- |
| `HEAD` (ветка `dev`) | `86a9350da9e4e2577bade61d94122ba3e8604ce6` |
| `origin/dev` | `86a9350da9e4e2577bade61d94122ba3e8604ce6` |
| `main` | `525bf926b61e24f4be2e25fa1a7ed2cd03b2fc79` |
| `merge-base(main, dev)` | `525bf926b61e24f4be2e25fa1a7ed2cd03b2fc79` (совпадает с `main`) |
| Последний коммит `dev` на момент проверки | `86a9350d` — `docs: close PL-45..PL-53 in roadmap and changelog`, `2026-11-20T20:35:13+03:00` |
| `head_sha` CI-run на момент проверки | `86a9350da9e4e2577bade61d94122ba3e8604ce6` — **совпадал с HEAD** |
| `HEAD` / `origin/dev` после проверки | `4ecb3d8a845026c2bb7893e00d355a4b48456a58` (коммит обёртки REL-01, см. пост-наблюдение) |
| `head_sha` queued CI-run | `4ecb3d8a845026c2bb7893e00d355a4b48456a58` — совпадает с новым HEAD, `status=queued` |

## Статус рабочего дерева

Первый замер (`git status -sb`, начало проверки):

```
## dev...origin/dev
 M docs/README.ru.md
 M docs/README.zh.md
 M test-docs.mjs
```

Повторный замер (`git status --porcelain=v1`, после появления правок параллельной задачи REL-01) — состояние на момент проверки (после неё дерево стало чистым, см. пост-наблюдение):

```
 M CHANGELOG.md
 M docs/README.ru.md
 M docs/README.zh.md
 M test-docs.mjs
?? reports/REL01-docs-audit.md
```

Расшифровка: ` M` — изменение в рабочей копии **без индекса** (не staged), `??` — untracked. Ни один файл REL-02 (`reports/REL02-prerelease.md` и запись REL-02 в `CHANGELOG.md`) не перезаписал чужие правки: запись REL-01 в `CHANGELOG.md` сохранена, файлы `docs/README.ru.md`, `docs/README.zh.md`, `test-docs.mjs` и `reports/REL01-docs-audit.md` не трогались.

Дифф, подтверждающий природу изменений (`git diff --stat`):

```
 CHANGELOG.md      |  2 ++
 docs/README.ru.md |  2 +-
 docs/README.zh.md |  2 +-
 test-docs.mjs     | 14 ++++++++++++++
 4 files changed, 18 insertions(+), 2 deletions(-)
```

## Результат проверки `main` / `dev`

- `git merge-base --is-ancestor main dev` → `MERGE_BASE_EXIT=0` → `main` является предком `dev`.
- `git rev-list --left-right --count main...dev` → `0	123` → в `main` нет коммитов, отсутствующих в `dev`; `dev` опережает `main` на 123 коммита. Мерж `dev` в `main` проходит без merge-commit, строго fast-forward.
- `git rev-parse HEAD` и `git rev-parse origin/dev` вернули одинаковый хеш → локальная ветка не отстаёт и не опережает origin.

## Статус CI (GitHub Actions, ветка `dev`)

Сеть доступна, API отвечает (запрос выполнялся через `Invoke-RestMethod` с заголовками `User-Agent: agent-steward-release-check` и `Accept: application/vnd.github+json`, `TimeoutSec 30`). Ошибок `ECONNRESET` не было.

```
CI_OK=true
TOTAL_COUNT=241
RUN id=44784642500 status=completed conclusion=success name=CI created_at=20.11.2026 17:34:51 html_url=https://github.com/DeadSno/agent-steward/actions/runs/44784642500
RUN id=44776159561 status=completed conclusion=success name=CI created_at=20.11.2026 16:43:09 html_url=https://github.com/DeadSno/agent-steward/actions/runs/44776159561
RUN id=44774311861 status=completed conclusion=failure  name=CI created_at=20.11.2026 16:31:56 html_url=https://github.com/DeadSno/agent-steward/actions/runs/44774311861
```

Дополнительная выборка `head_sha`, чтобы убедиться, что CI проверял именно текущий коммит:

```
RUN id=44784642500 status=completed conclusion=success head_sha=86a9350da9e4e2577bade61d94122ba3e8604ce6 event=push run_started_at=20.11.2026 17:34:51 updated_at=20.11.2026 17:41:29
RUN id=44776159561 status=completed conclusion=success head_sha=b18fde3a174baa1f43ed49241e851e3bf46989ce event=push run_started_at=20.11.2026 16:43:09 updated_at=20.11.2026 16:50:32
RUN id=44774311861 status=completed conclusion=failure  head_sha=f090c6d4f5f67d822f7aea8fb1e5257fe2219edb event=push run_started_at=20.11.2026 16:31:56 updated_at=20.11.2026 16:35:35
```

**На момент проверки последний run (id `44784642500`): `status=completed`, `conclusion=success`.** Его `head_sha` совпадал с тогдашними `HEAD` и `origin/dev`, значит зелёный результат относился именно к проверявшемуся коммиту (см. пост-наблюдение для текущего HEAD). Провальный run `44774311861` (`conclusion=failure`) относился к более старому коммиту `f090c6d4…` и перекрыт двумя последующими зелёными прогонами. Запусков со статусом `queued` / `in_progress` в выборке нет.

## Пост-наблюдение: HEAD изменился во время подготовки отчёта

Пока готовился отчёт, параллельная задача REL-01 выполнила свою обёртку (коммит + push). Ниже — фактические команды и вывод, зафиксированные после этого события.

```
git status -sb
## dev...origin/dev
?? reports/REL02-prerelease.md

git log --oneline -3
4ecb3d8 docs: sync translated readme suite counters [REL-01]
86a9350 docs: close PL-45..PL-53 in roadmap and changelog
d62f555 fix(plugin): close PL-45..PL-53 backlog findings

git show --stat --oneline HEAD
4ecb3d8 docs: sync translated readme suite counters [REL-01]
 CHANGELOG.md                |  4 +++
 docs/README.ru.md           |  2 +-
 docs/README.zh.md           |  2 +-
 reports/REL01-docs-audit.md | 77 +++++++++++++++++++++++++++++++++++++++++++++
 test-docs.mjs               | 14 +++++++++
 5 files changed, 97 insertions(+), 2 deletions(-)
```

Повторный запрос GitHub Actions с `per_page=5` (те же заголовки, `Invoke-RestMethod`):

```
CI_OK=true TOTAL_COUNT=242
RUN id=44787411521 status=queued    conclusion=          head_sha=4ecb3d8a845026c2bb7893e00d355a4b48456a58 created_at=20.11.2026 17:52:22
RUN id=44784642500 status=completed conclusion=success   head_sha=86a9350da9e4e2577bade61d94122ba3e8604ce6 created_at=20.11.2026 17:34:51
RUN id=44776159561 status=completed conclusion=success   head_sha=b18fde3a174baa1f43ed49241e851e3bf46989ce created_at=20.11.2026 16:43:09
RUN id=44774311861 status=completed conclusion=failure   head_sha=f090c6d4f5f67d822f7aea8fb1e5257fe2219edb created_at=20.11.2026 16:31:56
RUN id=44773725508 status=completed conclusion=cancelled head_sha=2ac3cdd415e6b64da96031bd90e671ad9f4c113e created_at=20.11.2026 16:28:22

git rev-parse HEAD       -> 4ecb3d8a845026c2bb7893e00d355a4b48456a58
git rev-parse origin/dev -> 4ecb3d8a845026c2bb7893e00d355a4b48456a58
```

Вывод: `HEAD == origin/dev == 4ecb3d8…`; в дереве остался только неотслеживаемый отчёт REL-02 (его закоммитит обёртка этой задачи). Последний run для текущего HEAD — `44787411521`, `status=queued`, `conclusion` отсутствует: готовность CI на текущем коммите **не подтверждена**, в отличие от успешного run для `86a9350d…`.

## Команды проверки и вывод

Все команды выполнялись из корня репозитория; метки `EXIT` добавлены для фиксации кода возврата.

| Команда | Вывод |
| --- | --- |
| `git status -sb` | `## dev...origin/dev` + 3 строки ` M docs/README.ru.md`, ` M docs/README.zh.md`, ` M test-docs.mjs` |
| `git rev-parse HEAD` | `86a9350da9e4e2577bade61d94122ba3e8604ce6` |
| `git rev-parse origin/dev` | `86a9350da9e4e2577bade61d94122ba3e8604ce6` |
| `git merge-base --is-ancestor main dev; echo "MERGE_BASE_EXIT=$LASTEXITCODE"` | `MERGE_BASE_EXIT=0` |
| `git rev-parse main` | `525bf926b61e24f4be2e25fa1a7ed2cd03b2fc79` |
| `git rev-list --left-right --count main...dev` | `0	123` |
| `git log -1 --format="%H%n%ad%n%s" --date=iso-strict HEAD` | `86a9350da9e4e2577bade61d94122ba3e8604ce6` / `2026-11-20T20:35:13+03:00` / `docs: close PL-45..PL-53 in roadmap and changelog` |
| `git branch --show-current` | `dev` |
| `git status --porcelain=v1` | 4 строки ` M` + `?? reports/REL01-docs-audit.md` (см. раздел «Статус рабочего дерева») |
| `git diff --stat` | 4 файла, `18 insertions(+), 2 deletions(-)` (см. там же) |
| `Invoke-RestMethod https://api.github.com/repos/DeadSno/agent-steward/actions/runs?branch=dev&per_page=3` | `CI_OK=true`, `TOTAL_COUNT=241`, 3 run'а: `44784642500 success`, `44776159561 success`, `44774311861 failure` (см. раздел «Статус CI») |
| тот же запрос + выборка `head_sha` | `head_sha` последнего run = `86a9350d…` == HEAD (см. там же) |

## Верификация Quality Gate

По условию задачи следующие команды выполняются **Quality Gate обёрткой**, а не этим агентом; маркер также создаётся обёрткой. Результаты здесь не приводятся, чтобы не подменить их выдуманными значениями:

- `npm test`
- `npm run build`
- `npm run lint:baseline`
- `node test-docs.mjs`

## Ограничения SCOPE

- Изменено только: `CHANGELOG.md` (одна запись REL-02 в `[Unreleased]`, запись REL-01 сохранена) и `reports/REL02-prerelease.md` (настоящий отчёт).
- Код, документация, тесты, workflows и чужие отчёты не изменялись.
- `git commit` и `git push` **не выполнялись** — это делает `afterScript` обёртки.
- Суб-агенты не спавнились.
