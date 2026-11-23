# TOK-310 — проверка телеметрии токенов (Деталь 3.10, T-6)

Дата: 23.11.2026. Ветка: `dev`.

## T-6.1 — вызов `collectOpenCodeUsage`

- `src/core/record-history.ts` вызывает `resolveUsageFromOpenCodeDb()` в обоих режимах: `--finish` (~строки 838–850) и legacy (~929–943).
- Прямой probing БД OpenCode (`~/.local/share/opencode/opencode.db`, 6303 сообщения) показал: у free-моделей (`opencode/hy4-flash-free`) поля `tokens.*` и `cost` равны нулю, а последние строки датированы 30.10.2026. Причина нулевой телеметрии — провайдер/движок, а не отсутствие вызова.
- Перезапуск задачи `TOK-PROBE-EVENT - Surface measurement` через `runTaskNow` подтвердил: запись истории создаётся, но usage остаётся нулевым до завершения запуска.

## T-6.2 — офлайн-фолбэк

- В `src/core/usage-surface.ts` добавлена чистая функция `estimateRunUsage({prompt, logText, pricePerMillion, countTokens})`: `tokens = estimateTokens(prompt) + estimateTokens(logText)`, цена за 1M из каталога моделей (`catalogPricePerMillion`), для локальных/free — 0.
- `src/core/record-history.ts`: `resolveUsageWithOfflineFallback()` после попытки чтения OpenCode DB подставляет оценку только для недостающих полей; событие `usage.offline_estimate` пишется в `runs.jsonl`. Чтение лога ограничено 256 КБ последнего прогона.
- Регрессия в `test-usage-from-log.mjs`: 3 новые проверки (формула+цена, неизвестная цена, сквозная запись в историю). Итог: **26 пройдено, 0 провалено**.

## T-6.3 — реальные цифры в метриках

Завершение записи истории №726 через штатный рекордер:

```json
{"id":726,"task_name":"TOK-PROBE-EVENT - Surface measurement","status":"success","tokens":370,"cost_usd":0}
```

Прогон `verify-metrics-310.mjs` по живой истории (726 записей):

| Метрика | Значение |
| --- | --- |
| `analytics.totals.tokens` | 370 |
| `analytics.totals.costUsd` | 0.00111 |
| `budget.day.spentUsd` | 0.00111 |
| `forecastSpend(records, 7).projectedUsd` | 0.001113 |
| `tokenEfficiencyScore(records).totalTokens` | 370 (score 100) |

## Проверки

- `npm run build` — exit 0.
- `node test-usage-from-log.mjs` — 26/26, exit 0.
- `node test-docs.mjs` / `node test-test-plan.mjs` / `node test-agent-tools.mjs` — см. финальный прогон перед коммитом.

## Находки плагина

- PL-124 подтверждена: обе пробные задачи провели ~15 минут в `running` и завершились только по таймауту 900 с, хотя отчёты были записаны раньше.
