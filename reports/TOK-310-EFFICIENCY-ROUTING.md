# T-7 — Меньше «сожжённых» токенов и роутинг моделей (Деталь 3.10)

Дата: 23.11.2026
Статус: выполнено (T-7.1, T-7.2, T-7.3)

## T-7.1 — preflight вместо 320 пропусков

В `src/core/dry-run.ts` добавлена чистая функция `preflightSkipRiskWarnings()`.
Она группирует задачи по рабочему каталогу (с учётом `workspaceId`) и
предупреждает, если несколько задач без `worktree` используют один checkout —
именно этот случай разбирается guard-ом PL-106 и приводит к lock-skip при
`maxConcurrent=1`. Отдельно отмечается совпадение cron-расписания. worktree и
разные каталоги ложных предупреждений не дают.

Проверено: `node test-dry-run.mjs` — 86/86, exit 0 (2 новые проверки).

## T-7.2 — дешёвая модель для рутины

`recommendModelForTask(prompt, currentModel?)` — детерминированная эвристика:
- routine → `opencode/hy4-flash-free` (free, цена из каталога 0 USD/1M);
- complex → `anthropic/claude-3-5-sonnet` (9 USD/1M) при ключевых словах
  `refactor/architect/migration/debug/audit/security/...` или длине промпта >1200.

Рекомендация включается в каждый элемент отчёта `dry_run` как
`modelRecommendation` и **не меняет** definition задачи: если пользователь задал
`model` явно, `recommended=false` и модель остаётся его. Это соответствует
принципу «дорогая модель только для сложных задач» без скрытой подмены.

Проверено: `node test-dry-run.mjs` — 86/86, exit 0 (3 новые проверки).

## T-7.3 — KPI в дашборде

- `src/index.ts`: общий хелпер `withTokenEfficiency()` добавляет результат
  `tokenEfficiencyScore(getHistoryForAnalytics(14))` в ответы `get_metrics`
  как MCP-инструмента, так и RPC-метода дашборда.
- `src/rpc.ts`: необязательное поле `tokenEfficiency` добавлено в схему `Metrics`
  без изменения числа RPC-методов (59).
- `src/gui.tsx`: новая строка KPI с％, всего и потрачено впустую; ключи
  `gui.metricsTokenEfficiencyTitle/Line` добавлены в ru/en/zh/tr.
- Живая проверка на рабочей истории: `score=100`, `runs=715`,
  `totalTokens=1421`, `wastedTokens=0`.

Проверено: `npm run build` (exit 0), `node test-i18n.mjs` (90/90, exit 0),
`node test-docs.mjs` (139/139, exit 0), `node test-dry-run.mjs` (86/86, exit 0).

Строки T-7.1–T-7.3, заголовок задачи и заголовок Детали 3.10 удалены из
`ROADMAP.md`; записи добавлены в `CHANGELOG.md` под `[Unreleased]`.
