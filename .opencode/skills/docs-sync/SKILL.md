---
name: Docs Sync (agent-steward)
description: Синхронизация документации плагина agent-steward — ARCHITECTURE, CONCEPT, FEATURES, PIPELINE, EXECUTION-LOOP, README, CHANGELOG, ROADMAP, локали и счётчики tools/RPC. Проверять после изменений API/поведения.
project: agent-steward
---

# Docs Sync — agent-steward

Локальная версия перекрывает глобальный `docs-sync` (тот указывает на `.opencode/skills/CONVENTIONS.md`
сайта brain-25-evidence — здесь не применим).

## Что синхронизировать

| Изменение | Документы |
|---|---|
| Новый/удалённый tool или RPC метод | `README.md`, `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `TEST-PLAN.md` — счётчики сверяет `node test-docs.mjs` |
| Схема БД / `SCHEMA_VERSION` | `docs/ARCHITECTURE.md` (текст версии обязателен для `test-docs`) |
| Поведение scheduler / gate / guard / worktree | `docs/PIPELINE.md`, `docs/EXECUTION-LOOP.md`, `docs/SAFETY.md` |
| Совместимость V1/V2 | `docs/COMPATIBILITY.md`, `docs/V1-V2-COMPATIBILITY-PLAN.md` |
| Локали | `locales/{ru,en,zh}.json` — новый ключ во всех трёх; `README.ru.md`, `README.zh.md` |
| Релиз | `CHANGELOG.md`, `package.json` version, `ROADMAP*.md` |

## Правила

- Приоритет факта: код → тесты → документы. Текст `Known limitations` может отставать от
  закрытых B1.x-фиксов; `docs/FEATURES.md` содержал ложное «Secrets are not encrypted».
- Исторически расходятся счётчики: `TEST-PLAN.md` (25 tools/44 RPC/39 suites) vs
  `README/CHANGELOG` (29 tools/56 RPC) vs `ARCHITECTURE` (53 methods). Не копировать число
  из соседнего файла — сверять через `test-docs`.
- After правки: `node test-docs.mjs`, `npm run test:i18n`, `node test-package-exports.mjs`.

## Формат находки

`<файл>: <что расходится с кодом> — <P1|P2>. Действие: <обновить/сверить>`.
