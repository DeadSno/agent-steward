# agent-steward — инструкции для агента

Этот репозиторий — **плагин OpenCode** (V1 ≥1.18.29 и V2), а не сайт. Глобальные скиллы
`~/.config/opencode/skills` заточены под `brain-25-evidence` (pytest, `docs/data.json`, RU/EN
сайта) — не применяйте их проверки здесь. В репозитории есть локальные `.opencode/skills`,
они имеют приоритет над глобальными при совпадении ID.

## Стек и ограничения

- TypeScript, Node16/ESM, Node ≥22.22 (`node:sqlite`, chokidar 6); `tsc` → `dist/`, GUI → Vite.
- V2: `Plugin.define`, точки входа `.` / `./tui` / `./gui-experimental` / `./rpc`; ключ конфига
  `plugins` (в V1 — `plugin`). Не ломать dual-export `setup`/`server`; V2-only вызовы в общем коде
  недопустимы без правки `docs/COMPATIBILITY.md` (следит `test-docs`).
- **LSP в V2 отсутствует**. Диагностика: `npm run lint`, `npm run build`, тесты. Не ищите
  LSP-инструменты и не добавляйте `lsp` в конфиг.
- Источник правды по API — <https://opencode.ai/docs/> (только V2). V1-доки — лишь для миграции.

## Команды

- `npm run build` — tsc с declaration-файлами; обязателен после правки TypeScript.
- `npm run lint` — eslint по `src/`.
- `npm run build:gui` — пересобрать GUI-бандл перед релизом.
- `npm test` — полный прогон (~130 `test-*.mjs`, тесты идут против `dist/`); `npm run test:parallel` — быстрее; точечно — `npm run test:<name>`.
- `npm run test:en`, `npm run test:zh` — локали; `npm run test:i18n` — паритет ключей ru/en/zh.
- `node test-docs.mjs` — мета-гейт: сверка счётчиков tools/RPC, версии схемы, ключей конфига и доков; `node test-workflows.mjs` — структура CI-воркфлоу.
- `npm run test:chaos` — nightly-проверки crash/kill-9; `npm pack --dry-run`, `node test-package-exports.mjs` — целостность тарбола и `exports`.
- Публикация **только** через `git tag vX.Y.Z` → `.github/workflows/release.yml` (OIDC + provenance). Локальный `npm publish` не делать; `workflow_dispatch` = dry-run `npm pack`.

## Карта кода

- `src/index.ts` — `Plugin.define`, ~34 agent tools, регистрация RPC и встроенного скилла.
- `src/core/*` — scheduler (schtasks/cron/launchd), guard, matrix, worktree, execution, recovery.
- `src/db/*` — схема и миграции, durable runs, DLQ, journal; `SCHEMA_VERSION=14`, миграции аддитивные и идемпотентные.
- `src/rpc.ts` — контракт `Rpc.define` между сервером и GUI; `src/gui.tsx` — дашборд.
- Durable-слой (leases, идемпотентность шагов, recovery, DLQ) — самое хрупкое место: правки требуют `test-run-*`, `test:worktree`, `test:guards`, `test:w4` и nightly chaos.
- `src/skill.ts` — загрузчик встроенного скилла из `skills/scheduled-job-best-practices`.

## Правила правок

- Правка `src/core/scheduler/*` → тесты schtasks / cron / mac / at-fallback.
- Правка `src/core/worktree*` → `npm run test:worktree`, `test:guards`, `test:w4`.
- Правка i18n → `test:i18n`, `test:en`, `test:zh` (все три локали равноправны).
- Правка GUI/RPC → `test:dlq-gui`, `test:pause-gui`, `test:gui-bundle` + smoke в Playwright.
- Новый модуль в `src/core` → новый `test-*.mjs` в корне.
- Задача в свежем worktree (W-1): сначала подготовить окружение — junction `node_modules` и `dist` из основного чек-аута через `cmd /c mklink /J` либо `npm ci` внутри worktree; иначе `npm run build` и `node test-*.mjs` падают (PL-109). Если `dist/` — junction, self-reference `agent-steward/*` резолвится по реальному пути и не находит зависимости в `node_modules` текущего worktree (QA-PORT-8): тест `test-portability-exports.mjs` сам перезапускается с флагом `--preserve-symlinks` (или дайте worktree собственный `dist`). `npm pack` не упаковывает junction `dist/` (QA-PORT-9): публиковать только из чистого чек-аута, состав tarball проверяет CI.
- Не редактировать вручную `dist/`, `gui-experimental.cjs`, `legacy/gui-experimental.cjs` — это артефакты сборки.
- Коммиты: `type(scope): description` латиницей. CHANGELOG/ROADMAP обновлять в той же правке,
  если меняется поведение.
- Находки QA: сначала воспроизвести (мутация / реальный прогон), затем чинить. Формат строки:
  `<что>: <файл и проверка> — <P0|P1|P2>. Действие: <что сделать>`.
