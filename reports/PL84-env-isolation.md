# PL-84 — изоляция тестов gate-integrity от workspace env

## Воспроизведение

При гейте задачи `BL-QA-A2.7-lint-zero` 23.11.2026 workspace имел
`env: { AGENT_STEWARD_GATE_ALLOW_PATHS=src }`. Обёртка inject-ит переменные workspace
в процесс задачи, поэтому тест `test-execution-pipeline.mjs` унаследовал allow-список
и три проверки PL-25/PL-47 («чужая правка src ловится», CLI worktree-verify → 1)
упали, хотя в чистой оболочке тот же тест был зелёным.

## Исправление

- `test-execution-pipeline.mjs`: сразу после объявления `check()` переменные
  `AGENT_STEWARD_GATE_ALLOW_PATHS` и `AGENT_STEWARD_CHILD_RUN` удаляются из
  `process.env`, добавляется проверка, что сброс действительно произошёл.
  Дочерние CLI-процессы `spawnSync` наследуют уже очищенное окружение.
- `docs/FEATURES.md`: предупреждение в разделе Workspace environment variables,
  что переменные видны всем дочерним процессам, включая сюиты Quality Gate.
- `docs/ARCHITECTURE.md`: то же предупреждение в таблице описания workspace env.
- `ROADMAP.md`: строка PL-84 удалена, `CHANGELOG.md`: добавлена запись.

## Верификация

| Команда | Exit code | Результат |
|---|---:|---|
| `node test-execution-pipeline.mjs` при `AGENT_STEWARD_GATE_ALLOW_PATHS=src`, `AGENT_STEWARD_CHILD_RUN=1` | 0 | «AC-1: все проверки единого пути пройдены» |
| `npm run build` | 0 | `tsc` без ошибок |
| `npm run lint:strict` | 0 | ESLint: 0 warning / 0 error |
| `node test-docs.mjs` | 0 | Docs: 129/129 |
| `npm run test:parallel` | 0 | 116/116 наборов за 33.9 с |

До исправления те же три проверки падали в гейте обёртки; после исправления
тест зелёный даже с искусственно выставленным враждебным окружением.
