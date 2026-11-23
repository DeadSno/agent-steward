# EXECUTION-LOOP — цикл v2.1 (спринты 38–43)

> Спека исполнительного цикла. North star: [CONCEPT.md](./CONCEPT.md) §6, §11.
> Безопасность: [SAFETY.md](./SAFETY.md). Статус компонентов: [CHANGELOG.md](../CHANGELOG.md).

## 1. Разрыв, который закрываем

Исторический разрыв (спринт 36); статус на 23.11.2026 — большинство пунктов закрыто (ARCH-1.1…1.3, PL-94/95/102/103, A-1). Оставшиеся дыры отмечены ниже.

- **Два мира исполнения.** Планировщик: `wrapper → opencode run → record-history → history`. Durable DAG: `runs/run_steps → resumeRun`. ~~Запланированная задача не создаёт durable-run.~~ **Закрыто ARCH-1.1:** `recordRegisteredRun` (`src/core/record-history.ts`) создаёт тот же `createRun`, что и ad-hoc путь; вердикт пишется в общую хеш-цепочку `gate_outcomes`.
- **Роутер не вызывается live.** ~~`routeStep` / `decideCapabilityRoute` отсутствуют в `index.ts` / `record-history.ts`.~~ **Закрыто PL-94:** `buildExecutionPlan` (`src/core/execution.ts`) вызывает `routeStep`, который внутри `src/core/router/dispatch.ts` использует `decideCapabilityRoute`; скомпилированный контекст доходит до исполнителя.
- **Карта не обучается.** ~~`recordCapabilityOutcome` не вызывается из горячего пути.~~ **Закрыто:** `writeGateOutcome` (`src/db/capability-repo.ts`) обновляет карту из вердиктов `pass`/`fail` с EWMA.
- **Эскалация не живая.** ~~`escalateAfterGate` есть, но провал гейта идёт в retry/chain.~~ **Закрыто PL-93/PL-102:** `executeStepWithEscalation` в `execution.ts` вызывает `escalateAfterGate`; production-путь `runMission` включает эскалацию и передаёт `agentResultGate` по умолчанию (защита от повтора того же executor'а).
- **Нет ad-hoc входа.** Любой запуск требует регистрации: `schedule_task` + `run_task_now`; `once` — это `at` / `schtasks ONCE` / launchd. Цепочки/DAG/retry обходят расписание костылём force-маркера. *(Закрыто в AB-8: `run_mission` / CLI `run` / GUI / RPC.)*

Частично построено: контекст запуска (`src/db/run-context.ts`), per-task/per-window
бюджеты (`src/core/budget.ts`), целостность гейта (`src/core/gate-integrity.ts`),
worktree-изоляция (`src/core/worktree.ts`, `src/core/worktree-run.ts`).

Построено после спринта 36: ledger + provenance (`outcome_key`/`row_hash`/`prev_hash`,
`evidence_path` — ARCH-1.2/1.3), отложенные эффекты (`effect_intents`,
`effects_applied_at` — ARCH-4.1/4.2), контекст из ledger (`run-context.ts`, PL-94),
flake-aware эскалация (PL-93/102), egress-аудит (ARCH-6.1/6.2), очередь одобрений
с RPC/GUI и автоперезапуском (A-1, PL-95/103).

Остаётся на уровне дизайна: класс риска и компиляция политики, отдельный
gate-executor, полный egress-контроль (сейчас аудит решений), пер-таск token
budgets, экономические колонки ledger'а (см. §3) и автоприменение рекомендаций.

Подтверждение:

```bash
grep -rn "routeStep\|recordCapabilityOutcome\|escalateAfterGate\|planMission" \
  src/index.ts src/core/record-history.ts src/core/ps-wrapper.ts src/core/wrappers/bash.ts
grep -rn "createRun\|runs-repo" src/core/record-history.ts
```

## 2. Целевой кровоток

```
вход (ad-hoc / внутренний / registered)
       → intake (gate-спека + safety) → компиляция политики → approval?
       → createRun (durable, trigger_kind) → planner (декомпозиция)
       → для каждого шага:
            routeStep (static → capability, reliability, explore capped)
            → context compilation (окно модели + бюджет токенов)
            → capability issuance (TTL) → исполнение (worktree/sandbox)
                 внешние эффекты → effect_intents (не применяются)
            → GATE (hard, независимый, tamper-evident, flake-aware)
                 pass → применить intents → ledger → карта → пример
                 fail → escalate / retry / rollback → к роутингу
       → артефакт (diff/PR) → отчёт из ledger → обучение

сквозные: телеметрия (span/шаг) · живой бюджет · аудит · durable state
```

## 2.1 Классы входа (гибрид)

| Класс | Вход | Регистрация в ОС | Catch-up | Pause расписания |
|---|---|---|---|---|
| **Ad-hoc** | `run_mission` / CLI / GUI / RPC | нет | нет | нет (пауза run'а есть) |
| **Внутренний** | chain / DAG / retry / escalation | нет | нет | нет |
| **Registered** | cron / once / file / git / mcp-event / webhook | да (cron/once) | да | да |

Все три класса проходят **один** runtime. Различаются только источником триггера
и персистентностью шаблона.

Инварианты:

1. Ad-hoc исполняется без единой записи в планировщике ОС.
2. Ad-hoc не обходит gate, политику, бюджет, ledger и аудит.
3. Внутренние запуски не консультируются с расписанием (force-маркер не нужен структурно).
4. Одинаковая спека через ad-hoc и registered даёт одинаковый маршрут и вердикт.
5. `trigger_kind` пишется в run и ledger; метрики честно разделяют классы входа.
6. Недоступность планировщика ОС не блокирует ad-hoc.

Lock/no-overlap для ad-hoc — по run/mission id и по workspace (не по имени задачи);
изоляция worktree предотвращает конкуренцию двух миссий в одном репо.

## 2.2 Объекты

| Объект | Что это | Персистентность |
|---|---|---|
| **Миссия** | цель + scope + gate-спека + safety + бюджет | опциональный шаблон; snapshot всегда в run |
| **Задача** | миссия-шаблон + регистрация триггера | только для registered |
| **Запуск** | durable-исполнение: шаги, попытки, вердикты | всегда |

## 3. Ledger (append-only, источник правды)

```sql
CREATE TABLE gate_outcomes (
  id INTEGER PRIMARY KEY,
  mission_id TEXT, run_id TEXT, step_id TEXT, task_type TEXT,
  trigger_kind TEXT,              -- adhoc | manual | chain | dag | retry | escalation | cron | once | file | git | mcp | webhook
  executor TEXT,                  -- local / cloud / model-id
  route_source TEXT,              -- static | capability | explore
  route_reason TEXT,
  gate_type TEXT,                 -- cmd | tests | lint | schema | diff | approval
  verdict TEXT,                   -- pass | fail | flake | infra_fail
  attempts_to_pass INTEGER, first_pass INTEGER,
  evidence_path TEXT,
  gate_hash TEXT, policy_hash TEXT, prompt_hash TEXT,
  model_version TEXT, tool_versions TEXT,
  effect_intents TEXT,            -- JSON: заявленные внешние эффекты
  effects_applied_at TEXT,        -- NULL, пока гейт не пройден
  tokens INTEGER, cost_usd REAL,
  counterfactual_cost_usd REAL, verification_cost_usd REAL,
  net_savings_usd REAL,
  time_ms INTEGER, overhead_ms INTEGER,
  escalation_from TEXT, escalation_to TEXT,
  example_ref TEXT, training_record_ref TEXT,
  prev_hash TEXT,                 -- хеш-цепочка: tamper-evident аудит
  created_at TEXT
);
```

> **Сверка с кодом (DS-3.4):** DDL выше — целевой дизайн, а не дословная схема
> `SCHEMA_VERSION=14`. В реальной `src/db/schema.ts` (`GATE_OUTCOMES_DDL`)
> реализованы `outcome_key`, `mission_id`, `run_id`, `step_id`, `step_name`,
> `task_type`, `trigger_kind`, `executor`, `route_source`, `route_reason`,
> `gate_type`, `verdict`, `attempts_to_pass`, `first_pass`, `evidence_path`,
> `gate_hash`, `policy_hash`, `prompt_hash`, `model_version`, `prev_hash`,
> `row_hash`, `created_at` и эффекты `effect_intents`/`effects_applied_at`/
> `effects_status`/`effects_reason`. Экономические колонки (`tokens`,
> `cost_usd`, `counterfactual_cost_usd`, `verification_cost_usd`,
> `net_savings_usd`, `time_ms`, `overhead_ms`, `tool_versions`, `example_ref`,
> `training_record_ref`, `escalation_from/to`) и `capability issuance` (TTL)
> в актуальной таблице `gate_outcomes` отсутствуют — это остаток дизайна §2,
> а не недоработка конкретного релиза.

- Реализация (ARCH-1.2/1.3) добавляет `outcome_key` (идемпотентность входа) и
  `row_hash` (self-hash строки): `verifyGateOutcomeChain()` сверяет и связь
  `prev_hash`, и self-hash, поэтому подмена последней записи цепочки тоже видна.
- `capability_map` — агрегат по ledger, не отдельная правда.
- Отчёт (43) и датасет (48) читают **только** ledger (`readGateOutcomeLedger()`).
- Нет ledger-строки — нет запуска.
- `prev_hash` даёт **tamper-evident** аудит: подделка заметна. Это **не граница
  безопасности** — у кого есть запись в файл, тот перепишет цепочку. Граница —
  изоляция прав и snapshot гейта.

### Поля capability_map (расширение)

`first_pass_rate REAL`, `avg_attempts REAL`, `decay_updated_at TEXT` (EWMA),
`parent_type TEXT` (иерархия при малых данных).

## 4. Целостность гейта (спринт 39)

**Реализовано (G-1.2):** при создании задачи `src/core/gate-integrity.ts`
фиксирует snapshot входов гейта — команду/файл хука, prompt и таймаут — с
SHA-256 в `PLUGIN_DIR/gate-snapshots/`, вне write-scope задачи. Перед запуском
гейта обе обёртки (Windows и POSIX) вызывают `gate-integrity.js verify`; при
расхождении хэша, отсутствии или повреждении snapshot гейт не выполняется,
запуск переходит в `error` с сообщением «snapshot mismatch». Snapshot
проверяет именно определение гейта, а не исходники репозитория, которые гейт
тестирует.

**Обязательная тест-атака в CI:** `test-execution-hardening.mjs` (Windows) и
`test-posix-e2e.mjs` (macOS/Linux) подменяют сгенерированный gate-файл/команду
на `exit 0` после создания snapshot и требуют падения запуска; оба теста уже
входят в `npm test`/`test:parallel`. Юнит-проверки хэша и CLI — в
`test-execution-pipeline.mjs`.

**Реализовано (ARCH-1.2/1.3):** `gate_outcomes` хранит `gate_hash`,
`policy_hash`, `prompt_hash`, а также `prev_hash` + `row_hash` — цепочка
проверяется `verifyGateOutcomeChain()`.

**Остаётся планом:** отдельный gate-executor, аудит-инцидент при расхождении
и перенос gate-файлов под привилегии, отличные от пользовательских.
Гейт по-прежнему **всегда hard**; shadow/canary — только для маршрутов и
адаптеров (49). Подмена самих тестов агентом текущей мерой не детектируется —
защита ограничена целостностью определения гейта.

### 4.1 Обязательная линтер-проверка (PL-66)

`qualityGate` задачи, меняющей TypeScript-исходники (`src/**/*.ts` в SCOPE
промпта/afterScript), обязан включать **обе** команды —
`npm run lint && npm run lint:baseline`. Одна `lint:baseline` не заменяет
обычный `lint` (и наоборот): это разные проверки. История — ARCH-3 гейтил
только сборку/тесты, поэтому `@typescript-eslint/array-type` дошёл до GitHub
Actions (run #312): Build/Test зелёные, «Lint (informational)» красный.

Подсказка в `dry_run` строится по тем же SCOPE-путям, что и PL-65:
`scopeModulesFromText()` → `qualityGateLintWarning()` добавляет в отчёт
предупреждение с префиксом `PL-66:` и явным списком пропущенных команд. Как и
PL-65, это warning, а не error: симуляция остаётся успешной. Fail-open — если
SCOPE не содержит `.ts`-модулей, предупреждения нет. Реестр ожидаемых команд —
`REQUIRED_LINT_CHECKS` в `src/core/dry-run.ts`; регрессия — `test-dry-run.mjs`.

## 5. Отложенные внешние эффекты

Worktree не защищает от сети/API/БД. Поэтому:

1. До гейта агент **не выполняет** irreversible-действие, а пишет `effect_intents`.
2. Гейт проверяет артефакт **и** валидность intents (политика, egress, blast-radius).
3. `pass` → применение intents, запись `effects_applied_at`.
4. `fail` → discard intents; частично применённые — компенсация (saga, спринт 42).

## 6. Flake-aware вердикт

- Повтор гейта на том же артефакте (N=2) при подозрении на флак.
- verdict `fail` (вина агента) vs `flake` / `infra_fail` (шум/инфра).
- `flake` и `infra_fail` **не обучают** capability-карту.
- Quarantine стабильно флакующих гейтов + предупреждение пользователю.
- `attempts_to_pass` и `first_pass` пишутся всегда.

## 7. Роутинг, бюджет, issuance

- `routeStep(taskType)` до сборки контекста; `explore` — с capped бюджетом.
- Решение учитывает `first_pass_rate`, `avg_attempts`, EWMA-decay; мало данных → `parent_type`.
- **Живой бюджет** в durable-run: $ / токены / время / эскалации. При подходе к
  границе — даунгрейд модели или `review`; превышение → circuit-breaker.
- **Capability issuance на шаг**: scoped-конфиг + короткоживущие секреты, очистка
  после шага. База — существующие `permissions` и scoped-инъекция секретов.

## 8. Context compilation (спринт 41)

- Выполняется **после роутинга**: окно и бюджет токенов зависят от исполнителя.
- Пересборка при эскалации (другая модель → другое окно).
- Repo-map + отбор файлов + gate-passed примеры по типу задачи; дедуп, лимит,
  scrub секретов.
- Retrieval — bag-of-words векторы (подход `notification_embeddings`), без вектор-БД.

## 9. Приёмка (= CONCEPT §11)

1. Ad-hoc миссия с gate-спекой и safety-контрактом принята, политика скомпилирована,
   планировщик ОС не изменён.
2. Шаги смаршрутированы local-first с учётом reliability.
3. Гейт объективно верифицировал; провал экалировался/откатился без тихих отказов;
   irreversible не произошёл до pass.
4. Ledger показал честную net-экономию и escalation rate.
5. Карта обновилась, пример сохранён и переиспользован.
6. Паритет: та же спека через registered даёт тот же маршрут и вердикт.

Тесты: E2E всего среза + chaos (`kill -9` посреди миссии) + атака на гейт +
попытка irreversible до pass + недоступность планировщика ОС.

## 10. Архитектурные решения: что отклонено и почему

| Предложение | Решение | Причина |
|---|---|---|
| Soft-gate / canary для **приёмки** артефакта | ❌ отклонено | Ослабляет keystone: побочные эффекты по «мягкому» вердикту. Canary — только маршруты и адаптеры (49). |
| AOCL как нормативная модель слоёв | ❌ не опираемся | Стандарт не подтверждён. Интероперабельность — через MCP (уже используется) и стабильные форматы YAML/SQLite. |
| OPA/Rego или Cedar как движок политик | ⏸ отложено | Внешняя зависимость против «мало deps / одна машина». Достаточно компилятора политики в существующий enforcement. |
| Hash-linked ledger как «доказуемость» | ✅ переформулировано | **tamper-evident аудит**, не граница безопасности. |
| Вектор-БД / «динамический RAG» | ❌ отклонено | Durable state уже есть; retrieval — на существующих bag-of-words векторах. |
| Capability-токены как OAuth/JWT | ⏸ упрощено | Локальная одна машина: scoped-конфиг + TTL-секреты дают тот же эффект без инфраструктуры. |
| «Сначала зарегистрируй задачу» для одноразовой работы | ❌ отклонено | Гибрид: ad-hoc — полноправный вход; регистрация опциональна. |

## 11. Границы (CONCEPT §8)

- Миссии ограниченные, с явным критерием; не open-ended swarm.
- Облако — эскалация, не замена способной модели.
- Локальный control plane, одна машина; базовый путь работает без Docker и без
  локальной модели.
- Планировщик ОС опционален; его недоступность не блокирует ядро.
- Критичное — человеку: гейт поднимает пол, не потолок.