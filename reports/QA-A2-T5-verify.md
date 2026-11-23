# QA-A2-T5 DAG verification

- Дата: 2026-11-23 09:20:34 +03:00
- Trigger: dag
- Модель: opencode / hy4-flash-free (Hy4 flash Free)
- Ветка: dev
- Цель: независимо замерить состояние эпика QA-A2 после подзадач T3/T4 и честно зафиксировать результат

## Вердикт

**Эпик QA-A2 ОСТАЁТСЯ ОТКРЫТЫМ (НЕ закрыт).**

Критерий закрытия: **0 error И 0 warning**. Фактический результат замера: **1 error, 254 warning, 107 files (src)** — критерий НЕ выполнен (есть 1 error и 254 warning).

Сводка относительно baseline (baseline зафиксирован на уровне 543 warning / 0 error):

| Метрика | Baseline | Факт | Дельта |
| --- | --- | --- | --- |
| ESLint error | 0 | 1 | **+1 (регресс)** |
| ESLint warning | 543 | 254 | −289 (улучшение) |
| ESLint files (src) | — | 107 | — |
| `npm run build` (tsc) | success | exit 0, success | — |
| `npm run lint:baseline` | 543 warning / 0 error | exit 1: 1 error / 254 warning | +1 error |
| `npm run test:parallel` | — | exit 1, 111/115 наборов за 54.8s | 4 провала |

Единственный error — `@typescript-eslint/array-type` в `src/db/capability-repo.ts:635:62` (`Array<{...}>` вместо `{...}[]`, функция `listGateQuarantines`). Количество warning снизилось на 289 (543 → 254), но наличие 1 error делает проход `npm run lint:baseline` провальным (exit 1). Поскольку критерий требует **одновременно** 0 error и 0 warning, эпик не может быть закрыт ни по одной из двух метрик.

Провалы `test:parallel` (4 из 115) носят окруженческий / флейковый характер и не являются регрессами, внесёнными в рамках этого задания:
- `test-execution-pipeline.mjs`, `test-mission-run.mjs`, `test-execution-hardening.mjs` — запуски уходят в `awaiting_approval` (ожидание ручного одобрения / quality gate), из-за чего падают проверки gate/эффектов.
- `test-dual-entry.mjs` — утечка переменной `AGENT_STEWARD_CHILD_RUN` в параллельном прогоне (#qv8 дочерний прогон), отсюда `V1 tool не пустой`.

## Команды

| Команда | Результат |
| --- | --- |
| `npm run build` | exit 0, `tsc` завершён успешно |
| `npm run lint:baseline` | **exit 1**, вывод: `QA-A2.0: обнаружены новые предупреждения ESLint: ESLint errors: 1 (в baseline 0); @typescript-eslint/array-type: 1 > baseline 0; src/db/capability-repo.ts: 2 > baseline 1; src/db/capability-repo.ts [@typescript-eslint/array-type]: 1 > baseline 0` |
| `npm run test:parallel` | **exit 1**, `Итого: 111/115 наборов за 54.8s`; провалены: `test-execution-pipeline.mjs`, `test-mission-run.mjs`, `test-execution-hardening.mjs`, `test-dual-entry.mjs` |
| `npx eslint src --format json` + подсчёт через `node -e` | exit 1 (из-за 1 error); JSON: `{"files":107,"errors":1,"warnings":254}` |

Ограничения соблюдены: верификатор изменил **только** `reports/QA-A2-T5-verify.md`. Исходники `src/**`, `ROADMAP.md`, `CHANGELOG.md`, `eslint-baseline.json`, `.github/**`, `reports/QA-A2-final.md` и `dist/` не изменялись (предшествующие модификации в рабочем дереве от T3/T4 оставлены нетронутыми). `eslint --fix` не запускался; `git add`/`commit`/`push` не выполнялись; суб-агенты не спавнились.

## ESLint

Подсчёт по `npx eslint src --format json` (сумма `errorCount`/`warningCount` по всем файлам через `node -e`):

- **ERROR: 1**
- **WARNING: 254**
- **FILES: 107**

Единственный error:
- `src/db/capability-repo.ts:635:62`, правило `@typescript-eslint/array-type`, сообщение: `Array type using 'Array<T>' is forbidden. Use 'T[]' instead.`

Сравнение с baseline (543 warning / 0 error): warning уменьшились на 289, но появился 1 error. `npm run lint:baseline` завершается с exit 1. Критерий `<0 error и 0 warning>` не достигнут.

## Гейт

- Критерий закрытия эпика QA-A2: `0 error И 0 warning`.
- Факт: **1 error и 254 warning** → **гейт НЕ пройден**.
- Статус эпика: **открыт / не закрыт**.
- `test:parallel`: 111/115 (4 провала — approval/quality-gate и утечка `AGENT_STEWARD_CHILD_RUN`; не являются регрессами этого задания, но требуют отдельного разбора).
- Рекомендация: исправить `Array<{...}>` → `{...}[]` в `src/db/capability-repo.ts:635` (устранить 1 error), затем довести 254 warning до 0 — только после повторного замера с `0 error / 0 warning` эпик может быть закрыт.
- Коммит/публикация и финальная фиксация — за afterScript, верификатором не выполнялись.

A2-T5-DONE 254
