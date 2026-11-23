# PL-85 —_transient EPERM_ при создании лока секретов

## Воспроизведение

При `npm run test:parallel` (116 сюитов) изредка падал `test-secrets.mjs`:

```
FAIL: test-secrets.mjs
Error: EPERM: operation not permitted, open '...\secrets.json.lock'
```

Повторялось нестабильно: следующий запуск того же набора был зелёным (116/116).

## Причина

`src/core/secrets.ts`, `withSecretsLock()`: лок создаётся через
`fs.openSync(SECRETS_LOCK_FILE, "wx")`. В блоке `catch` обрабатывался только
код `EEXIST`. На Windows под параллельной нагрузкой (и при вмешательстве
антивируса) создание файла может вернуть transient `EPERM`; он перебрасывался
наружу, хотя это та же самая конкуренция за лок.

## Решение

- `src/core/secrets.ts`: `EPERM` на создании лока трактуется так же, как
  `EEXIST` — цикл повторяет попытку до 30-секундного deadline, после чего
  возвращается прежняя ошибка «Не удалось получить блокировку...».
- `test-secrets.mjs`: добавлены две регрессионные проверки исходного кода —
  условие содержит `EPERM`, часть кода и комментария содержат метку PL-85.

## Проверка

| Команда | Результат |
| --- | --- |
| `npm run build` | exit 0 |
| `npm run lint:strict` | exit 0 |
| `node test-secrets.mjs` | 84/84, exit 0 |
| `node test-docs.mjs` | 129/129, exit 0 |
| `node test-test-plan.mjs` | 19/19, exit 0 |
| `npm run test:parallel` | 116/116, exit 0 |
