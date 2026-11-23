# PL-83 — классификация исчерпания квоты модели

## Воспроизведение

23.11.2026 при выполнении задачи `BL-QA-A2.7-lint-zero` (запланированный cron-прогон) модель `mimo-v2.6-flash-free` исчерпала free-лимит посреди прогона: в логе появилось `Free usage limit reached`, обёртка завершилась с кодом 1 и общим сообщением «Код возврата 1». Quality Gate и afterScript были пропущены, а частично исправленные 121 файл остались в рабочем дереве без артефакта и без подсказки, как продолжить.

## Причина

`src/core/ps-wrapper.ts` и `src/core/wrappers/bash.ts` различали только таймаут (124) и общий ненулевой код возврата. Различные причины — сетевые ошибки, квота, падение агента — попадали в одну ветку с одинаковым сообщением. PL-51 проверял доступность модели только перед стартом, но не классифицировал ошибку, случившуюся во время работы агента.

## Решение

После ненулевого выхода `opencode` обёртка просматривает лог:

- PowerShell — последние 80 строк (`Get-Content -Tail 80`), regex `Free usage limit reached|Insufficient Balance|free usage limit`;
- bash — весь лог, `grep -qE` с тем же шаблоном.

При совпадении:

1. Частичный diff сохраняется в `reports/quota-<sanitized task name>.diff`;
2. В `errorMessage` добавляется подсказка `update_task name=<имя> model=provider/model`;
3. Код возврата становится `126` вместо `1`;
4. Статус запуска остаётся `error` (совместимость с историей и дашбордом).

Регрессия — 5 проверок в `test-execution-hardening.mjs` по статическому тексту обеих обёрток.

## Проверка

| Команда | Результат |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run lint:strict` | exit 0 |
| `node test-execution-hardening.mjs` | 79/79, exit 0 |
| `npm run test:parallel` | 116/116, exit 0 |
| `node test-docs.mjs` | 129/129, exit 0 |
| `node test-test-plan.mjs` | 19/19, exit 0 |
