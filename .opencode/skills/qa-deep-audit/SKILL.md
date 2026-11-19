---
name: QA Deep Audit (agent-steward)
description: QA-аудит кода плагина agent-steward — покрытие тестами, edge cases, offline/error/empty состояния, durable-слой, кросс-ОС обёртки, i18n и GUI. Только чтение; находки подтверждаются прогоном.
license: MIT
project: agent-steward
---

# QA Deep Audit — agent-steward

Локальная версия скилла перекрывает глобальный `qa-deep-audit` (тот проверяет сайт
brain-25-evidence через pytest — здесь не применим).

## Правило верификации находок

Прежде чем фиксить находку — воспроизведи её:
- тест: мутация (сломать → тест падает) и реальный прогон `npm run test:<name>`;
- код: `node --check` / `npm run build`, а не «похоже на баг»;
- данные/БД: запрос к тестовой БД на `OPENCODE_SCHEDULER_HOME`, не к памяти;
- GUI: реальный браузер (Playwright), реальный viewport, реальный клик.

Если воспроизвести нельзя — статус «требует верификации», не P0/P1.

## Что проверять

1. **Тестовый контур.** Новый модуль `src/core/*` → есть `test-*.mjs`. Тесты идут против
   `dist/` (сначала `npm run build`), изолированы через `OPENCODE_SCHEDULER_HOME`.
   Мутационный тест: убедись, что тест действительно падает на сломанном поведении.
2. **Durable-слой (самое хрупкое).** Миграции аддитивные/идемпотентные; leases и stale-only
   recovery; идемпотентность шагов; DLQ; journal. Смена `SCHEMA_VERSION` → обновлён текст в
   `docs/ARCHITECTURE.md` и проходит `node test-docs.mjs`.
3. **Edge cases.** Offline / пустой список задач / ошибка RPC / таймаут / повтор / отмена;
   `timeoutSeconds`, retry, guard conditions, skipped status (W-4), worktree cleanup (W-2).
4. **Кросс-ОС.** Правки PowerShell/bash/.cmd синхронны: единый lock-токен `<pid>-<iso>`,
   watchdog CIM→WMI fail-closed, промпт после `--`, лимит argv. Тесты: `test-lock-format`,
   `test-ps-watchdog`, `test-posix-e2e`, `test-schtasks-*`, `test-mac-*`.
5. **Безопасность и права.** Маскирование секретов в логах/истории/аудите, `esc()` + CSP nonce
   дашборда, порядок `resolvePermissions`, audit на каждую мутацию. См. `plugin-security-review`.
6. **i18n.** Новый ключ есть в `ru`, `en`, `zh`; `test:i18n`, `test:en`, `test:zh` зелёные.
7. **GUI.** Error/empty/loading состояния, вызовы RPC, консоль и сеть без ошибок.
8. **Документы как гейт.** `node test-docs.mjs` сверяет счётчики tools/RPC и версию схемы;
   `node test-workflows.mjs` — структуру workflow. Расхождение — уже находка.
9. **Честность доков.** «Не построено» в ARCHITECTURE/EXECUTION-LOOP могло быть уже сделано —
   сверяй с кодом, а не с текстом.

## Отчёт

Формат строки: `<что>: <файл и проверка> — <P0|P1|P2>. Действие: <что сделать>`.
- P0 — тесты не проходят/не собираются, реальные данные ОС задеты, секрет в логах.
- P1 — расхождение доков со счётчиками, отсутствует тест на новый модуль, кросс-ОС рассинхрон.
- P2 — косметика, мёртвый код, устаревшие ссылки.

Группируй однотипные находки; P0/P1 не режь.
