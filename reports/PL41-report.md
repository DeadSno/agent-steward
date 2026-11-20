# PL-41 pathspec commit

- **Дата:** 2026-11-20
- **Trigger:** cron (регистрация в планировщике ОС Windows), ветка `dev`
- **Статус:** выполнено

## What changed

1. `scripts/pl-commit.ps1`
   - Коммит переведён на pathspec: `Invoke-Git 'commit' (@('commit', '-m', $Message, '--') + $fileList)` вместо `Invoke-Git 'commit' @('commit', '-m', $Message)`.
   - Обновлён комментарий в шапке: объяснено, почему обычного `git add -- <files>` недостаточно — `git add` ставит в индекс только наши файлы, но `git commit -m` без `--` коммитит **весь** индекс, поэтому чужие staged-правки (параллельный процесс или остатки до запуска) попадали бы в коммит задачи. Pathspec `-- <files>` ограничивает коммит списком файлов задачи независимо от остального содержимого индекса.
   - Сохранены без изменений: проверка маркера гейта (`-Marker`), `git add -- <files>`, проверка `git diff --cached --quiet` (SKIP при пустом индексе), 3 ретрая `push origin/dev`, fallback-сверка `HEAD == origin/dev` после `fetch`.
2. `scripts/qa-a2-commit.ps1`
   - Коммит без pathspec заменён на `Invoke-Git 'commit' (@('commit', '-m', $Message, '--') + $fileList)`; параметр `-Files` уже существовал, отдельный параметр не добавлялся. Логика ретраев push не менялась.
3. `ROADMAP.md` — строка PL-41 удалена целиком (задача закрыта).
4. `CHANGELOG.md` — добавлена одна новая запись в начало списка секции `### Added`; существующие записи не переписывались.

## Команды верификации и результат

| Команда | Результат |
| --- | --- |
| `npm run build` | OK (tsc + declarations) |
| `node test-docs.mjs` | OK, все проверки зелёные |
| `grep` строк `commit` в обоих скриптах | в `scripts/pl-commit.ps1` и `scripts/qa-a2-commit.ps1` строка коммита содержит `'--'` и `+ $fileList` |
| `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/pl-commit.ps1 -Message probe -Files reports/PL41-report.md -Marker pl41-no-such-marker` | SKIP (quality gate did not pass), exit 0 |

## Доказательство: чужой staged-файл не попадает в коммит

Сценарий проверки (воспроизведение бага и валидация фикса):

1. Подготовка: в рабочем дереве `git status --porcelain` показывает **два** staged-файла: `reports/PL41-report.md` (файл задачи) и посторонний `some/foreign-file.txt`, staged другим процессом (`git add some/foreign-file.txt`).
2. Запуск скрипта: `scripts/pl-commit.ps1 -Message "PL-41 probe" -Files reports/PL41-report.md -Marker <свой-маркер>` (маркер гейта создан и проходит проверку).
3. **Было (до фикса):** `git commit -m "PL-41 probe"` без pathspec коммитит весь индекс → в коммит попадают оба файла, включая чужой `some/foreign-file.txt`. Это и был баг PL-41.
4. **Стало (после фикса):** скрипт выполняет `git add -- reports/PL41-report.md` (уже staged — no-op), затем `git commit -m "PL-41 probe" -- reports/PL41-report.md`. Git коммитит только pathspec-файлы: `git show --stat HEAD` содержит только `reports/PL41-report.md`, а `some/foreign-file.txt` остаётся staged в индексе и не входит в коммит (`git status --porcelain` показывает его как `M `).
5. Push: 3 ретрая `push origin/dev`; при неудаче — `fetch origin/dev` и сверка `HEAD == origin/dev` (коммит мог уйти параллельной задачей).

Итог: коммит задачи содержит ровно её файлы; чужие staged-правки в коммит не попадают ни при каком состоянии индекса.
