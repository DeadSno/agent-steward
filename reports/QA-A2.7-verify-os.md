# QA-A2.7 OS-bound verification

- Дата: 2026-11-20 13:22:35 +03:00 (2026-11-20T13:22:35+03:00)
- Ветка: `dev`
- Trigger: `cron` (зарегистрировано в планировщике ОС)
- Модель: Hy4 flash Free (`opencode/hy4-flash-free`)

## Вердикт

**Эпик типизации ОСТАЁТСЯ ОТКРЫТЫМ.**

Критерий закрытия — `0 error И 0 warning` — НЕ выполнен: зафиксировано **0 error / 355 warning** (102 файла). Warning > 0, значит эпик остаётся открытым.

Точные цифры (замер `npx eslint src --format json`):

| Метрика | Значение |
|---|---|
| ERRORS | 0 |
| WARNINGS | 355 |
| FILES | 102 |

Baseline в `eslint-baseline.json` = 543 warning / 0 error — фактическое число warning снизилось до 355 (−188), но до нуля не дошло. Сборка, линтер и все тесты проходят успешно; единственный непреодолённый барьер — оставшиеся 355 предупреждений ESLint.

## Команды

| Команда | Exit code | Ключевой вывод |
|---|---|---|
| `npm run build` | 0 | `tsc` — успешная сборка, ошибок нет |
| `npm run lint` | 0 | `✖ 355 problems (0 errors, 355 warnings)`; `0 errors and 3 warnings potentially fixable with the --fix option` (fix НЕ применялся) |
| `npm run lint:baseline` | 0 | `QA-A2.0: новых предупреждений нет — 355 warning (baseline 543, -188)` |
| `npm run test:parallel` | 0 | `Итого: 113/113 наборов за 32.8s` (pretest:parallel → build → tsc, всё зелёное) |
| `npx eslint src --format json` | 0 | `ERRORS=0 WARNINGS=355 FILES=102` |

## ESLint

Источник: `npx eslint src --format json` → точный подсчёт через node-агрегацию.

**Итого: error = 0, warning = 355, files = 102.**

### Top-10 правил

| # | Правило | Кол-во |
|---|---|---|
| 1 | `@typescript-eslint/no-unsafe-member-access` | 162 |
| 2 | `@typescript-eslint/no-unsafe-assignment` | 50 |
| 3 | `@typescript-eslint/no-unused-vars` | 29 |
| 4 | `@typescript-eslint/no-explicit-any` | 28 |
| 5 | `@typescript-eslint/no-base-to-string` | 27 |
| 6 | `@typescript-eslint/prefer-optional-chain` | 18 |
| 7 | `@typescript-eslint/no-redundant-type-constituents` | 17 |
| 8 | `@typescript-eslint/no-unsafe-argument` | 11 |
| 9 | `@typescript-eslint/await-thenable` | 7 |
| 10 | `@typescript-eslint/no-floating-promises` | 3 |

(Сумма top-10 = 352; оставшиеся 3 приходятся на прочие правила, включая `no-unsafe-call` / `no-unsafe-return` / `consistent-type-imports`.)

### Top-10 файлов

| # | Файл | Warning |
|---|---|---|
| 1 | `src/db/history-repo.ts` | 52 |
| 2 | `src/db/runs-repo.ts` | 47 |
| 3 | `src/core/audit.ts` | 24 |
| 4 | `src/index.ts` | 23 |
| 5 | `src/core/structured-log.ts` | 21 |
| 6 | `src/db/run-context.ts` | 20 |
| 7 | `src/db/metrics-repo.ts` | 18 |
| 8 | `src/db/tasks-repo.ts` | 15 |
| 9 | `src/db/run-dlq.ts` | 14 |
| 10 | `src/db/index.ts` | 12 |

## Гейт

`npm run lint:baseline` (скрипт `scripts/check-eslint-baseline.mjs`) прошёл с exit code 0 и сообщил:

> `QA-A2.0: новых предупреждений нет — 355 warning (baseline 543, -188)`

То есть хранимый baseline (543 warning / 0 error) — это "храповик" (ratchet): гейтorelse проверяет только отсутствие **новых** предупреждений, а не достижение нуля. Фактическое число warning = 355, что ниже baseline на 188, поэтому гейт зелёный.

**Важно:** зелёный ratchet-гейт НЕ равен закрытию эпика. Критерий закрытия QA-A2.7 — `0 error И 0 warning`. При 355 warning эпик остаётся открытым; baseline-файл стоит обновить через `npm run lint:baseline:update` только после достижения реального нуля (до этого он намеренно оставлен без изменений согласно SCOPE).
