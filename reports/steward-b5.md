# steward-b5 — закрытие PL-91, PL-93, PL-94

Дата: 23.11.2026. Ветка: `steward-work`. Рабочая директория: каталог репозитория плагина `agent-steward`.
Коммит и push **не выполнялись** — это делает обёртка плагина через `scripts/steward-commit.ps1`.

## 1. Изменённые файлы

| Файл | Что изменено |
|---|---|
| `src/core/execution.ts` | PL-91: `RunTrigger` + `"webhook"`, явный маппинг в `triggerKindFor`. PL-93: импорт `runGateWithRetry`/`resolveGateOutcome`/`escalateAfterGate`/`nextGateTarget`/`isEscalationExhausted` из `router/escalation.ts` и `isGateQuarantined` из `db/capability-repo.ts`; гейт через `runGateWithRetry` с номером попытки, вердикт из `resolveGateOutcome`, эскалация с учётом карантина (ровно один уровень), `ExecutionResult.escalations`/metadata. PL-94: `compiledContext` в `PlannedStep`/`StepExecutionInput`/`OpenCodeInvocation`, вызовы `compileContextForRoute`/`recompileContextForRouteEscalation`/`recompileContextOnEscalation` и patched-контекст при эскалации. |
| `test-escalation.mjs` | Раздел 8: 6 проверок наличия символов в `execution.ts` + интеграционный smoke (flake→pass, 2 вызова гейта, ledger `flake`/`attemptsToPass=2`/`firstPass=0`). Новый `test-*.mjs` не создавался. |
| `test-router-dispatch.mjs` | Раздел 12: `buildExecutionPlan` с `contextOptions` и `escalationContext`; `compiledContext` с SHA-256 `contextHash`, модель local-7b → cloud-large после эскалации. |
| `test-execution-pipeline.mjs` | PL-91: `trigger=webhook` принимается, `triggerKindFor` → `webhook`, ledger пишет `trigger_kind=webhook`. PL-93: flake-pass retry + ledger, stable fail → local→cloud + patched hash, карантин сдвигает таргет, снятие карантина. PL-94: `compiledContext` в шаге и у исполнителя, patched context после эскалации. |
| `docs/ARCHITECTURE-DIAGRAMS.md` | C4 L1: webhook в `RunTrigger` и `trigger_kind`. Диаграмма 3: убраны пометки «НЕ в прогоне», связи PL-93/PL-94 переведены в сплошные, легенда/выводы обновлены. ER: пояснения про `trigger_kind=webhook` и поля вердикта. Добавлен раздел 6.1 с ARCH-5.1/5.2 и краткой sequence 4.1. Gap-пункты 2/10/11 переписаны как закрытые, обновлена сноска 9–12. |
| `ROADMAP.md` | Строки PL-91, PL-93, PL-94 удалены целиком (без `[x]`, дубликатов нет). Чужой незакоммиченный блок PL-102..PL-105 сохранён. |
| `CHANGELOG.md` | Под `## [Unreleased]` добавлены ровно 3 строки — по одной на PL-91/PL-93/PL-94, с указанием файлов, регрессий и exit-кодов. |
| `reports/steward-b5.md` | Настоящий отчёт. |

Файлы из SCOPE `src/core/router/escalation.ts`, `src/core/router/dispatch.ts`, `src/db/run-context.ts`, `src/db/capability-repo.ts` **не изменялись**: они уже содержали нужный API, правка потребовалась только в точке интеграции. `dist/`, `gui-experimental.cjs`, `legacy/`, `package.json`, `TEST-PLAN.md`, counter-файлы не трогались; новые `test-*.mjs` не создавались.

## 2. Результат по ID

| ID | Статус | Суть и проверка |
|---|---|---|
| PL-91 | Закрыт | `webhook` добавлен в `RunTrigger` и явно мапится в `triggerKindFor`; HTTP-ветка `POST /api/hooks/:task` теперь различима в `runs`/`gate_outcomes`. Миграция старых строк не нужна (добавочное значение). Регрессия в `test-execution-pipeline.mjs`, C4/ER обновлены, строка удалена из ROADMAP. |
| PL-93 | Закрыт | Эскалация и flake-aware retry подключены к `executeExecutionPlan`; вердикт гейта (включая `flake`/`infra_fail`, `attemptsToPass`, `firstPass`) пишется в ledger, `isGateQuarantined` влияет на выбор исполнителя, решение фиксируется в `escalations`/metadata. `escalation.ts` остался чистой библиотекой (без импортов). Регрессии в `test-escalation.mjs` и `test-execution-pipeline.mjs`; строка удалена из ROADMAP. |
| PL-94 | Закрыт | `buildExecutionPlan` компилирует контекст через `compileContextForRoute` и кладёт `compiledContext` (SHA-256 `contextHash`) в шаг; при эскалации контекст пересобирается через `recompileContextForRouteEscalation`/`recompileContextOnEscalation`. Регрессии в `test-router-dispatch.mjs` и `test-execution-pipeline.mjs`; ARCH-5.1/5.2 и sequence 4.1 описаны; строка удалена из ROADMAP. |

## 3. Реально запущенные команды и exit-коды

| Команда | Результат | Exit code |
|---|---|---|
| `npm run build` | tsc + declarations, без ошибок | 0 |
| `node test-escalation.mjs` | все проверки, включая новый раздел 8 | 0 |
| `node test-router-dispatch.mjs` | все проверки, включая новый раздел 12 | 0 |
| `node test-execution-pipeline.mjs` | `AC-1: все проверки единого пути пройдены` | 0 |
| `node test-docs.mjs` | 138/138 проверок (после правки ROADMAP/CHANGELOG) | 0 |
| `npm run test:parallel` | 115/116 наборов; единственный провал — `test-dual-entry.mjs` из-за унаследованного `AGENT_STEWARD_CHILD_RUN=1` | 1 |
| `node test-dual-entry.mjs` (как есть, env унаследован) | `V1 tool не пустой` — окружение сессии, не регрессия | 1 |
| `$env:AGENT_STEWARD_CHILD_RUN = $null; node test-dual-entry.mjs` | `test-dual-entry: все проверки пройдены` | 0 |
| `npm run lint` | 12 problems (11 errors, 1 warning), все на строках, не тронутых этой правкой | 1 |

## 4. Найденные баги плагина и ограничения

1. **PL-103 (открыт в ROADMAP): `npm run lint` красный.** 11 ошибок + 1 предупреждение: `src/core/execution.ts:808` (quotes), `1299–1305` (indent), `src/core/run-panel-api.ts:316` (unnecessary type assertion) + warning, `src/db/runs-repo.ts:874–875` (indent). Сверка с `git show HEAD:src/core/execution.ts` и `git diff` показала, что эти строки **не изменены** этой правкой; ошибка `execution.ts:808/1299–1305` уже задокументирована в `reports/steward-b3.md` как часть PL-103. Не чинилось, чтобы не выходить за SCOPE и не трогать чужой код.
2. **Окружение сессии ломает `test-dual-entry.mjs`.** Переменная `AGENT_STEWARD_CHILD_RUN=1` наследуется обёрткой, из-за чего тест пропускает регистрацию плагина и падает на `V1 tool не пустой`. С очищенной переменной — exit 0. Это артефакт запуска внутри дочернего прогона, не дефект кода; в полном прогоне `npm run test:parallel` остальные 115 наборов прошли.
3. **Граница SCOPE для sequence 4.1.** Полная диаграмма лежит в `docs/ARCHITECTURE-DIAGRAMS-SEQUENCES.md`, который **не входит в SCOPE** этой задачи. В `docs/ARCHITECTURE-DIAGRAMS.md` добавлены актуальные ARCH-5.1/5.2 и краткая mermaid-последовательность со ссылкой на исходный файл; сам SEQUENCES требует отдельного обновления, чтобы снять пометки `--x` PL-93/PL-94.
4. **Остальные смежные находки остаются открытыми:** PL-95 (approval RPC/GUI), PL-97 (DLQ-retry), PL-98 (автопроверка цепочки), PL-102..PL-105 (чужой блок в ROADMAP). В эту задачу не входили.
5. **Ловушка при реализации (исправлено в ходе работы):** наивный `while`-цикл в `resolveExecutionTarget` пропускал все уровни сразу до `review` при карантине `local`; исправлено на пропуск ровно одного уровня с проверкой `isEscalationExhausted`. Также прямой `let` для `GateOutcome` внутри колбэка сужался TypeScript до `never` — заменён на объект-холдер. Оба дефекта пойманы регрессиями до финального прогона.

## 5. Чек-лист

- [x] ROADMAP.md: строки PL-91/PL-93/PL-94 удалены целиком, дубликатов нет (проверено `node test-docs.mjs`, 138/138).
- [x] CHANGELOG.md: ровно 3 строки под `## [Unreleased]`, по одной на ID.
- [x] Регрессии добавлены в три существующих `test-*.mjs`, новых файлов нет.
- [x] Документация диаграмм обновлена, ARCH-5.1/5.2 и sequence 4.1 описаны.
- [x] Команды верификации запущены, exit-коды зафиксированы в §3.
- [x] Коммит/push не выполнялись.
