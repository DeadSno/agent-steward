# Release runbook — внешние действия (X-*)

Этот документ — **инструкция**, не отчёт о выполнении. Ни одна из описанных операций не выполнялась
автоматически: все они требуют доступа к npm registry и GitHub, прав на публикацию и явного решения
человека. X-1/X-2 выполнены 24.11.2026 выпуском `opencode-windows-scheduler@1.5.10` (latest, диапазон
`>=0.0.2 <0.1.0`) и deprecation `Use agent-steward` для 1.5.8/1.5.9/1.5.10; X-4 закрыта и зафиксирована в `CHANGELOG.md`; X-5 остаётся открытой до публикации `v0.0.9` (см. фактический блок ниже).

## Предварительные условия (общие для всех шагов)

- Рабочая копия `dev` синхронизирована: `git fetch origin && git rebase --autostash origin/dev`.
- Локально зелёны: `npm run build`, `npm run lint`, `npm run lint:strict`, `node test-docs.mjs`,
  `node test-test-plan.mjs`, `npm run test:parallel`.
- Есть токен npm с правом publish/deprecate на `agent-steward` и `opencode-windows-scheduler`
  (`npm whoami` показывает нужную учётку), а также GitHub CLI или веб-интерфейс с правом merge/release.
- Версия в `package.json` совпадает с планируемым тегом; `CHANGELOG.md` обновлён.

## X-1 — deprecated legacy `opencode-windows-scheduler`

```bash
npm view opencode-windows-scheduler@1.5.8 deprecated
npm deprecate opencode-windows-scheduler@1.5.8 \
  "Use agent-steward: npm i -g agent-steward"
npm deprecate opencode-windows-scheduler@1.5.9 \
  "Use agent-steward: npm i -g agent-steward"
npm deprecate opencode-windows-scheduler@1.5.10 \
  "Use agent-steward: npm i -g agent-steward"
npm view opencode-windows-scheduler@1.5.8 deprecated
```

Ожидаемый результат: поле `deprecated` у 1.5.8/1.5.9/1.5.10 содержит осмысленное сообщение
`Use agent-steward`, а не ссылку на несуществующий `@agent-steward/plugin`. Откат:
`npm deprecate opencode-windows-scheduler@<version> ""` (снимает метку, если требуется).

## X-2 — legacy 1.5.10 с upper bound `<0.1.0`

Цель: пользователи шима 1.5.x не должны получить ломающий релиз `agent-steward@0.1.0`.

```bash
# в каталоге legacy/ шима, версия 1.5.10
npm pkg get version dependencies.agent-steward   # 1.5.10, ">=0.0.2 <0.1.0"
npm pack --dry-run
npm publish --tag latest
npm view opencode-windows-scheduler dist-tags --json
npm view opencode-windows-scheduler@1.5.10 dependencies.agent-steward
```

Проверка: `latest == 1.5.10`, `npm view ...dependencies.agent-steward` возвращает ровно
`>=0.0.2 <0.1.0`. Версия 1.5.9 осталась под тегом `legacy` и тоже ограничена; перепубликация
1.5.8 невозможна, поэтому исправление выпущено как 1.5.10. Откат публикации — `npm unpublish`
допустим только в течение grace period; иначе выпускается следующая версия с исправленной зависимостью.

## X-4 — Dependabot PR #4 и OpenTUI 0.9.0

1. Открыть https://github.com/DeadSno/agent-steward/pull/4, проверить статус CI (все 6 matrix-джоб
   build-and-test, compat-v1, compat-v2, shim-smoke зелёные),-diff зависимостей и отсутствие
   неожиданных изменений в `package-lock.json`.
2. Слить PR через squash-merge, убедиться что `dev` содержит мерж и что CI на `dev` зелёный.
3. Отдельно проверить OpenTUI 0.9.0: обновление dependency только после зелёного PR #4
   и повторного прогона `npm run build && npm run test:parallel`.
4. Если CI красный — не мержить, зафиксировать причину в issue и оставить строку X-4 открытой.

## X-5 — теги и GitHub release

```bash
# теги должны соответствовать уже опубликованным версиям, а не наоборот
git tag --list
npm view agent-steward versions --json
git tag -a v0.0.9 -m "agent-steward 0.0.9" <commit>
git push origin v0.0.9
gh release create v0.0.9 --verify-tag --generate-notes
```

Проверка: для каждого существующего релиза npm есть тег `v<version>` и GitHub release с notes;
список тегов и список версий совпадают. Откат тега: `git push origin :refs/tags/v0.0.9` и
`git tag -d v0.0.9` (только если released commit ещё не разошёлся).

Фактическое состояние на 26.11.2026 (проверено по `git ls-remote --tags origin`, npm registry
и GitHub Releases API): npm-версии агента — `0.0.1`…`0.0.8` (`latest=0.0.8`), теги есть для
`0.0.2`…`0.0.8` и `1.x`, но **тега `v0.0.1` нет**; GitHub-release есть для `0.0.3`…`0.0.8`
и `1.x`, но **релизов нет для `v0.0.2`, `v1.5.1` и `v1.5.2`**. Поэтому требование «списки
совпадают» пока не выполнено: создавать/удалять теги и релизы можно только после отдельного
одобрения (см. «Что НЕ делать»), в обычной разработке X-5 считается открытым. Шаблон команд
выше обновлён до `v0.0.9` при подготовке релиза 26.11.2026; диапазоны опубликованных версий
отражают фактическое состояние на дату проверки.

## Порядок и stop-условия

X-1 → X-2 → X-4 → X-5. Между шагами — повторный прогон верификации и проверка, что `dev` не
разошёлся с `origin/dev`. Любой красный CI или расхождение версий останавливает последовательность;
соответствующая подзадача остаётся открытой в `ROADMAP.md`, а причина — в отчёте запуска и CHANGELOG.

## Что НЕ делать

- Не запускать `npm publish`, `npm deprecate`, `npm unpublish`, `git push --tags` и `gh release create`
  из автоматической задачи без отдельного одобрения.
- Не закрывать строки X-* в ROADMAP, пока команда из раздела не выполнена и не проверена вживую.
- Не менять `SCHEMA_VERSION`, счётчики tools/RPC/сюит и локали «заодно» с релизными действиями.

---

См. также: [CHANGELOG.md](../CHANGELOG.md), [ROADMAP.md](../ROADMAP.md) (деталь 3.7).
