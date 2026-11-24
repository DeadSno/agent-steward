# Steward: Архитектурные диаграммы

> **Статус:** Актуально на schema v14
> **Дата:** 2026-11-23
> **Проверено:** главный агент OpenCode (`opencode/hy4-flash-free`) + сверка по исходникам `src/`; попытка суб-агента завершилась по лимиту Free-модели (ограничение тарифа, а не репозитория)
>
> Все имена файлов и функций в этом документе получены из реального дерева `src/` и подтверждены `Select-String`/`grep`. Там, где однозначного подтверждения нет, стоит пометка `[TODO: проверить]`.

**Содержание:** этот файл — системный контекст, контейнеры, компоненты ядра, модель данных и gap-анализ. Последовательности вынесены в [ARCHITECTURE-DIAGRAMS-SEQUENCES.md](./ARCHITECTURE-DIAGRAMS-SEQUENCES.md), состояния — в [ARCHITECTURE-DIAGRAMS-STATES.md](./ARCHITECTURE-DIAGRAMS-STATES.md).

---

## Реальная структура файлов

Вывод команды `find src/core src/db -type f -name "*.ts" | sort` (на Windows выполнен эквивалент `Get-ChildItem -Recurse -Filter *.ts | Sort-Object`, пути приведены к POSIX-виду):

```text
src/core/agents-advanced.ts
src/core/agents.ts
src/core/analytics.ts
src/core/approval-api.ts
src/core/audit.ts
src/core/budget.ts
src/core/catch-up.ts
src/core/cron-to-schtasks.ts
src/core/defer.ts
src/core/dlq-api.ts
src/core/dry-run.ts
src/core/environment.ts
src/core/execution.ts
src/core/feedback.ts
src/core/file-watcher.ts
src/core/gate-integrity.ts
src/core/git-trigger.ts
src/core/glob.ts
src/core/guard-run.ts
src/core/guard.ts
src/core/local-ai.ts
src/core/lock.ts
src/core/matrix.ts
src/core/mission.ts
src/core/native-notify.ts
src/core/one-shot.ts
src/core/opencode-cli.ts
src/core/opencode-models.ts
src/core/opencode-usage.ts
src/core/otel.ts
src/core/permissions.ts
src/core/pipeline-apply.ts
src/core/pipeline-io.ts
src/core/pipeline-map.ts
src/core/pipeline-spec.ts
src/core/prometheus.ts
src/core/ps-wrapper.ts
src/core/record-history.ts
src/core/retention.ts
src/core/router/dispatch.ts
src/core/router/escalation.ts
src/core/router/planner.ts
src/core/router/rules.ts
src/core/run-mode.ts
src/core/run-panel-api.ts
src/core/runner-docker.ts
src/core/runner-ssh.ts
src/core/runner.ts
src/core/savings.ts
src/core/schedule-gate.ts
src/core/schedule-v2.ts
src/core/scheduler/at-fallback.ts
src/core/scheduler/index.ts
src/core/scheduler/linux.ts
src/core/scheduler/logs.ts
src/core/scheduler/mac.ts
src/core/scheduler/posix.ts
src/core/scheduler/registry.ts
src/core/scheduler/run-now.ts
src/core/scheduler/types.ts
src/core/scheduler/windows.ts
src/core/secrets.ts
src/core/self-analysis.ts
src/core/session.ts
src/core/shutdown.ts
src/core/structured-log.ts
src/core/summary.ts
src/core/task-name.ts
src/core/telegram.ts
src/core/tool-profile.ts
src/core/triage-chain.ts
src/core/triage-compare.ts
src/core/triage-rules.ts
src/core/triage-shadow.ts
src/core/triage-worker.ts
src/core/triage.ts
src/core/usage-surface.ts
src/core/watch-paths.ts
src/core/worktree-run.ts
src/core/worktree.ts
src/core/wrappers/bash.ts
src/db/capability-repo.ts
src/db/git-state-repo.ts
src/db/history-repo.ts
src/db/index.ts
src/db/metrics-repo.ts
src/db/migrate.ts
src/db/recovery.ts
src/db/run-context.ts
src/db/run-dlq.ts
src/db/run-journal.ts
src/db/run-resume.ts
src/db/runs-repo.ts
src/db/schema.ts
src/db/settings-repo.ts
src/db/step-idempotency.ts
src/db/tasks-repo.ts
src/db/templates-repo.ts
```

**Что видно:** 81 модулей в `src/core/` (из них 4 — `router/`, 10 — `scheduler/`, 1 — `wrappers/`) и 17 модулей в `src/db/`. Durable-слой вынесен в `src/db/`, оркестрация — в `src/core/`. Счётчик сверен с `src/core/**/*.ts` 24.11.2026 (71 → 80 после D-1/D-3, M-1…M-4, A-2, T-1, S3-D36 и QW-2; 81 после QW-9).

**Ключевые выводы:** Принцип «ядро не зависит от транспорта» реализован через [`execution.ts`](src/core/execution.ts): исполнитель (`StepExecutor`) передаётся в `executeExecutionPlan` снаружи. Отдельного `gate-repo.ts` не существует — операции с `gate_outcomes` распределены между [`execution.ts`](src/core/execution.ts), [`runs-repo.ts`](src/db/runs-repo.ts) и [`capability-repo.ts`](src/db/capability-repo.ts).

---

## Проверка ключевых файлов

| Файл | Статус | Комментарий |
|---|---|---|
| [src/core/execution.ts](src/core/execution.ts) | ✅ | Execution engine: `createRegisteredRunContext`, `createAdHocRunContext`, `validateRunContext`, `writeGateOutcome`, `buildExecutionPlan`, `executeExecutionPlan`. Здесь единая точка входа для registered и ad-hoc. |
| [src/core/mission.ts](src/core/mission.ts) | ✅ | Ad-hoc missions: `normalizeMissionSpec`, `createMissionContext`, `runMission`. |
| [src/core/router/dispatch.ts](src/core/router/dispatch.ts) | ✅ | Capability-map routing: `routeStep`, `compileContextForRoute`, `recompileContextForRouteEscalation`. |
| [src/core/router/escalation.ts](src/core/router/escalation.ts) | ✅ | Escalation logic: `gateVerdict`, `runGateWithRetry`, `resolveGateOutcome`, `escalateAfterGate`. |
| [src/core/budget.ts](src/core/budget.ts) | ✅ | Budget gates: `evaluateBudgetGate`, `evaluateTaskTokenBudgetGate`, `buildBudgetReport`. |
| [src/core/defer.ts](src/core/defer.ts) | ✅ | Defer-file liveness: `acquireDefer`, `deferFileBusy`, `releaseDefer` — `ISO|PID`, мёртвый владелец не блокирует тик (QW-9). |
| [src/core/gate-integrity.ts](src/core/gate-integrity.ts) | ✅ | Snapshot hash verification: `gateInputsHash`, `createGateSnapshot`, `verifyGateSnapshot`, `verifyWorktreeSnapshot` + saga эффектов. |
| [src/db/runs-repo.ts](src/db/runs-repo.ts) | ✅ | runs/run_steps: `createRun`, `startRun`, `finishStep`, `renewStepLease`; ledger: `recordGateOutcome`, `readGateOutcomeLedger`, `verifyGateOutcomeChain`. |
| [src/db/run-journal.ts](src/db/run-journal.ts) | ✅ | Step journal: `beginStepAttempt`, `renewStepLease`, `recordStepSuccess`, `runStepStatefullyAsync`, `recoverInterruptedSteps`. |
| [src/db/run-resume.ts](src/db/run-resume.ts) | ✅ | Resume after crash: `findResumeStep`, `resumeRunSync`, `resumeRun`. |
| [src/db/run-dlq.ts](src/db/run-dlq.ts) | ✅ | Dead letter queue: `enqueueDeadLetter`, `scanDeadLetters`, `retryDeadLetter`, `discardDeadLetter`. |
| [src/db/capability-repo.ts](src/db/capability-repo.ts) | ✅ | Capability map: `recordCapabilityOutcome`, `decideCapabilityRoute`, `recordGateVerdict`, `isGateQuarantined`. |
| src/db/gate-repo.ts | ❌ | **Не существует.** Функции для `gate_outcomes`: запись вердикта — `writeGateOutcome` ([execution.ts](src/core/execution.ts)) и `recordGateOutcome` ([runs-repo.ts](src/db/runs-repo.ts)); чтение ledger — `readGateOutcomeLedger` ([runs-repo.ts](src/db/runs-repo.ts)); проверка цепочки — `verifyGateOutcomeChain` (там же); обучение карты — `recordGateVerdict` ([capability-repo.ts](src/db/capability-repo.ts)). |

**Что видно:** 11 из 12 ожидаемых файлов существуют. Единственное расхождение с исходной гипотезой — `gate-repo.ts`.

**Ключевые выводы:** «Запись вердикта гейта» — это **два** разных уровня: `writeGateOutcome` (единая точка записи из execution loop и рекордера, обогащает хэшами контекста) и `recordGateOutcome` (низкоуровневая вставка в SQLite с хеш-цепочкой). `recordGateVerdict` в `capability-repo.ts` пишет ledger **и** решает, обновлять ли capability map (только стабильные `pass`/`fail`). Матричные операции — `advanceMatrixAfterClone` и `finalizeMatrixIfComplete` — живут в [matrix.ts](src/core/matrix.ts) (:515 и :959).

---

## Диаграммы

### 1. Системный контекст (C4 Level 1)

```mermaid
flowchart LR
    operator["Оператор / Пользователь"]
    osSched["Планировщик ОС<br/>schtasks / cron / launchd"]
    ext["Внешние триггеры<br/>file / git / MCP-event / HTTP webhook"]
    llm["AI-провайдер<br/>OpenCode CLI / локальная модель / cloud"]

    subgraph system["agent-steward — локальный оркестратор"]
        core["Execution engine + capability map<br/>durable runs, ledger, budget gates"]
    end

    db[("SQLite scheduler.db<br/>SCHEMA_VERSION = 14")]
    report["Отчёты / аудит / уведомления"]

    operator -->|"MCP tools, RPC, CLI, GUI"| core
    osSched -->|"cron, once"| core
    ext -->|"file-watcher, git-trigger,<br/>emit_event, POST /api/hooks"| core
    core -->|"StepExecutor"| llm
    core <-->|"runs, run_steps,<br/>gate_outcomes"| db
    core --> report
```

**Что видно:** система — локальный оркестратор. Четыре класса внешних входов: пользователь (MCP/RPC/CLI/GUI), планировщик ОС, триггеры событий и AI-провайдер как исполняющая сторона. Единственное хранилище — SQLite.

**Ключевые выводы:** планировщик ОС — лишь одна из полос (cron/once), а не центральный маршрут: ядро само выполняет цепочки, DAG, ретраи и матрицы. Webhook-триггер (`POST /api/hooks/:task` в [server.ts](src/server.ts), проверка в [integrations.ts](src/integrations.ts)) с PL-91 добавлен в `RunTrigger` ([execution.ts](src/core/execution.ts)) и явно мапится в `triggerKindFor`, поэтому в `runs`/`gate_outcomes` пишется `trigger_kind = webhook`, а не `manual`. Миграция для старых строк не нужна — значение добавочное.

### 2. Контейнеры (C4 Level 2)

```mermaid
flowchart TB
    subgraph iface["Интерфейсы"]
        mcp["MCP tools — src/index.ts"]
        rpc["RPC контракт — src/rpc.ts"]
        cli["CLI — index.js"]
        http["HTTP / webhook — src/server.ts"]
        gui["GUI — src/gui.tsx"]
    end

    subgraph core["Ядро — src/core"]
        exec["execution.ts"]
        mission["mission.ts"]
        rec["record-history.ts"]
        router["router/dispatch.ts<br/>router/escalation.ts<br/>router/planner.ts<br/>router/rules.ts"]
        matrix["matrix.ts"]
        budget["budget.ts"]
        integ["gate-integrity.ts<br/>permissions.ts<br/>audit.ts"]
        trig["file-watcher.ts<br/>git-trigger.ts<br/>schedule-v2.ts"]
    end

    subgraph durable["Durable-слой — src/db"]
        runs["runs-repo.ts"]
        journal["run-journal.ts"]
        resume["run-resume.ts"]
        dlq["run-dlq.ts"]
        ctx["run-context.ts"]
        cap["capability-repo.ts"]
        schema["schema.ts / migrate.ts / recovery.ts"]
    end

    subgraph executors["Исполнители"]
        oc["opencode-cli.ts"]
        shell["wrappers/bash.ts<br/>ps-wrapper.ts"]
        local["local-ai.ts"]
        os["scheduler/windows.ts<br/>linux.ts / mac.ts / posix.ts"]
    end

    mcp --> core
    rpc --> core
    cli --> core
    http --> core
    gui --> rpc
    exec --> durable
    mission --> exec
    rec --> exec
    router --> cap
    matrix --> exec
    budget --> exec
    integ --> exec
    trig --> core
    exec --> executors
    durable --> schema
```

**Что видно:** интерфейсы (MCP/RPC/CLI/HTTP/GUI) не содержат бизнес-логики — они тонкие адаптеры над ядром. Durable-слой отделён от ядра и от исполнителей.

**Ключевые выводы:** замена транспорта (OpenCode → shell → локальная модель) не требует правок `execution.ts`: интерфейс `StepExecutor` и реализация `createOpenCodeExecutor` объявлены в [execution.ts](src/core/execution.ts). Якоря в диаграммах даны по именам функций, а не по номерам строк — номера дрейфуют при каждом коммите (DS-5.2). GUI общается с ядром только через [rpc.ts](src/rpc.ts).

### 3. Компоненты ядра

```mermaid
flowchart TB
    subgraph entry["Вход"]
        CR["createRegisteredRunContext — execution.ts"]
        CAH["createAdHocRunContext — execution.ts"]
        VRC["validateRunContext — execution.ts"]
    end

    subgraph plan["Планирование"]
        PLAN["planMission — router/planner.ts"]
        BP["buildExecutionPlan — execution.ts<br/>isGateQuarantined — capability-repo.ts"]
        ROUTE["routeStep — router/dispatch.ts"]
        DECIDE["decideCapabilityRoute — capability-repo.ts"]
        COMPILE["compileContextForRoute — router/dispatch.ts<br/>compileRunContext — run-context.ts"]
    end

    subgraph run["Исполнение"]
        EXEC["executeExecutionPlan — execution.ts"]
        JOUR["runStepStatefullyAsync — run-journal.ts"]
        WG["writeGateOutcome — execution.ts"]
        GATE["runGateWithRetry / escalateAfterGate — router/escalation.ts"]
        EFFECT["recordEffectIntents / applyDeferredEffects — gate-integrity.ts"]
    end

    subgraph persist["Durable + обучение"]
        RUNS["createRun / finishStep — runs-repo.ts"]
        LEDGER["recordGateOutcome / readGateOutcomeLedger / verifyGateOutcomeChain — runs-repo.ts"]
        CAP["recordCapabilityOutcome / recordGateVerdict — capability-repo.ts"]
        RESUME["findResumeStep — run-resume.ts<br/>resumeDurableRunExecution — run-panel-api.ts"]
        DLQ["enqueueDeadLetter / retryDeadLetter — run-dlq.ts<br/>retryDlqExecution — dlq-api.ts"]
        APPR["listApprovalPanel / decideApprovalPanel — approval-api.ts<br/>requestApproval / decideApproval — audit.ts"]
        APREX["executeApprovedPlan — run-panel-api.ts<br/>approve → сохранённый план из аудита → executeExecutionPlan"]
        AUD["verifyGateLedgerIntegrity — audit.ts<br/>createRuntime / self_analysis — index.ts"]
        BUDGET["evaluateBudgetGate — budget.ts<br/>вызов: checkBudgetGate — index.ts"]
    end

    CR --> VRC
    CAH --> VRC
    VRC --> BP
    PLAN --> BP
    BP --> ROUTE
    DECIDE --> ROUTE
    BP --> EXEC
    EXEC --> RUNS
    EXEC --> JOUR
    EXEC --> EFFECT
    EFFECT --> LEDGER
    WG --> LEDGER
    CAP --> DECIDE
    JOUR --> DLQ
    DLQ -->|retryDlqExecution: дескриптор → resume| RESUME
    BUDGET -.->|только в index.ts, не в execution| BP
    BP -->|compileContextForRoute| COMPILE
    COMPILE -->|compiledContext + contextHash| EXEC
    BP -->|isGateQuarantined → review| CAP
    EXEC -->|mission: escalation.enabled по умолчанию| GATE
    EXEC -->|recordGateVerdict| CAP
    EXEC -->|финальный verdict| WG
    EXEC -->|metadata.durableExecution| RESUME
    RESUME -->|StepExecutor + handlers| JOUR
    RESUME -->|writeGateOutcome| WG
    EXEC -->|approval gate: requestApproval + план в аудит| APPR
    APPR -->|approve: отложенный execution plan из аудита| APREX
    APREX -->|executeExecutionPlan с восстановленным executor| EXEC
    AUD -->|verifyGateOutcomeChain: вся цепочка| LEDGER
    LEDGER -->|результат в аудит + gateLedger в self_analysis| AUD
```

**Условные обозначения:** сплошная стрелка — реальный вызов в `src/`; единственная пунктирная стрелка `BUDGET -.-> BP` означает не «неподключённый модуль», а границу ответственности: бюджет проверяется в `index.ts`, а не внутри `execution.ts`. PL-93, PL-94, PL-97, PL-98 и PL-103 переведены на сплошные стрелки: после PL-103 одобрение через RPC/GUI не только фиксируется в журнале аудита, но и перезапускает отложенный план через `executeApprovedPlan`.

**Что видно:** после PL-93 ядро замыкает «исполнение → ledger → обучение карты → роутинг»: `executeExecutionPlan` при `execution.escalation.enabled` вызывает `runGateWithRetry`/`escalateAfterGate`, пишет вердикт через `writeGateOutcome` и обучает capability map через `recordGateVerdict`; `buildExecutionPlan` проверяет `isGateQuarantined` и уводит шаг в `review`. После PL-94 план дополнительно несёт `CompiledContext`: `compileContextForRoute` собирает его из ledger, `contextHash` передаётся исполнителю, а при эскалации контекст пересобирается под новую модель/окно. После PL-92 добавлен и путь «metadata.durableExecution → resume → тот же journal/ledger». После PL-95 в контур появился фасад `approval-api.ts`: гейт high-risk вызывает `requestApproval`, а список и решения одобрений доступны через RPC `list_approvals`/`decide_approval` и карточку GUI (журнал аудита, без новой таблицы). После PL-97 DLQ-очередь тоже подключена к исполнению: `retryDlqExecution` проверяет дескриптор, закрывает запись и сразу вызывает `resumeDurableRunExecution`. После PL-98 цепочка `gate_outcomes` проверяется автоматически при старте (`createRuntime`) и при каждом запросе самоанализа: результат пишется в `audit_log` действием `gate_ledger.verify` и попадает в поле `gateLedger` отчёта. PL-102 включил эскалацию в реальном mission-пути: `runMission` передаёт `agentResultGate` и `escalation.enabled: true`, а `executeStepWithEscalation` не дублирует прогон тем же исполнителем при смене маршрута. После PL-103 approval-гейт сохраняет в аудите «отложенное исполнение» (план, дескриптор исполнителя, evidence path), а `decide_approval` при approve вызывает `executeApprovedPlan`; повторный approve и reject не создают второй run.

**Ключевые выводы:** `writeGateOutcome` ([execution.ts](src/core/execution.ts)) — единственная точка записи вердикта в ledger, а при включённой эскалации рядом вызывается и `recordGateVerdict` ([capability-repo.ts](src/db/capability-repo.ts)). В ядре эскалация остаётся opt-in, но реальный mission-путь (`runMission`) после PL-102 включает её и передаёт `agentResultGate`: ошибка/ненулевой код шага даёт вердикт `fail`, а командная quality gate обёртки по-прежнему выполняется внутри обёртки на каждой попытке. Прямые вызовы `executeExecutionPlan` без опции сохраняют старое поведение; зарегистрированные задачи идут через отдельный процесс-рекордер с командной гейт-командой и осознанно не используют execution-loop эскалацию. Скомпилированный контекст теперь не теряется между планом и исполнителем: `CompiledContext.contextHash` доходит до `StepExecutionInput` и `OpenCodeInvocation`, а при эскалации пересобирается через `recompileContextForRouteEscalation`. Бюджет проверяется до старта задачи в [index.ts](src/index.ts) (`checkBudgetGate`), а не внутри `executeExecutionPlan`. Lease шага (`renewStepLease` в [runs-repo.ts](src/db/runs-repo.ts) и [run-journal.ts](src/db/run-journal.ts)) — основа safe-resume; PL-92 подключил `resumeRun` к RPC/GUI-пути, а PL-97 — к ручному retry из DLQ. Без дескриптора `durableExecution` DLQ-запись остаётся открытой и возвращается явная диагностика (подготовительный путь `retryDlq` сохранён). Очередь одобрений после PL-95 доступна пользователю, а после PL-103 approve автоматически перезапускает отложенный план: `executeApprovedPlan` достаёт дескриптор из аудита, помечает запрос как запущенный до старта (идемпотентность) и вызывает `executeExecutionPlan`; планы с отложенными эффектами честно переводятся в ручной перезапуск. Автопроверка PL-98 не ломает старт: `verifyGateLedgerIntegrity` проглатывает ошибки чтения и пишет успешный или повреждённый результат в аудит, а `getLastGateLedgerVerification()` отдаёт результат последней проверки без повторного чтения ledger-а.

### 6. Модель данных (ER-диаграмма)

Реальные таблицы из [schema.ts](src/db/schema.ts) (`SCHEMA_SQL` + `GATE_OUTCOMES_DDL`):

```mermaid
erDiagram
    tasks ||--o{ history : "запуски"
    tasks ||--o{ runs : "durable-запуски"
    runs ||--o{ run_steps : "шаги"
    runs ||--o{ run_dlq : "мёртвые письма"
    runs ||--o{ run_injections : "инъекции на паузе"
    workspaces ||--o{ tasks : "contains tasks"
    capability_map ||--o{ gate_outcomes : "вердикты по типу"

    tasks {
        TEXT name PK
        TEXT definition_json
        TEXT matrix_parent_id
        INTEGER is_matrix_parent
    }
    history {
        INTEGER id PK
        TEXT task_name FK
        TEXT status
        TEXT started_at
        INTEGER owner_pid
        TEXT owner_host
    }
    runs {
        TEXT id PK
        TEXT task_name FK
        TEXT status
        TEXT parent_run_id
        TEXT workspace_id
        TEXT metadata_json
    }
    run_steps {
        TEXT id PK
        TEXT run_id FK
        TEXT step_name
        INTEGER position
        TEXT status
        INTEGER attempt
        TEXT idempotency_key
        TEXT owner_id
        TEXT lease_until
    }
    run_dlq {
        TEXT id PK
        TEXT run_id FK
        TEXT step_name
        TEXT status
        TEXT reason
        INTEGER attempts
    }
    run_injections {
        TEXT id PK
        TEXT run_id FK
        TEXT step_name
        TEXT kind
        TEXT content
        TEXT consumed_at
    }
    gate_outcomes {
        INTEGER id PK
        TEXT outcome_key UK
        TEXT run_id FK
        TEXT step_id
        TEXT verdict
        INTEGER attempts_to_pass
        INTEGER first_pass
        TEXT evidence_path
        TEXT prev_hash
        TEXT row_hash
        TEXT effect_intents
        TEXT effects_applied_at
        TEXT effects_status
    }
    capability_map {
        TEXT task_type PK
        TEXT model
        REAL success_rate
        REAL avg_cost_usd
        REAL avg_time_ms
        TEXT last_10_runs
    }
    audit_log {
        INTEGER id PK
        TEXT ts
        TEXT action
        TEXT target
        TEXT actor
        TEXT details_json
    }
    git_state {
        TEXT task_name PK
        TEXT commit_sha
        TEXT branch
    }
```

**Что видно:** `runs`/`run_steps` — durable-ядро; `gate_outcomes` — append-only ledger с `prev_hash` → `row_hash`; `capability_map` — агрегат из того же ledger; `run_dlq` и `run_injections` — служебные таблицы для детерминированных падений и паузы.

**Ключевые выводы:** цепочка `prev_hash`/`row_hash` — tamper-evident аудит, а не граница безопасности (прямо указано в комментарии [schema.ts](src/db/schema.ts) и §10 `EXECUTION-LOOP.md`). Уникальный индекс `idx_run_dlq_open_unique` гарантирует, что ручной retry не создаст дубль открытой записи. Новые колонки эффектов (`effect_intents`, `effects_applied_at`, …) намеренно **не** входят в `GateOutcomeContent`, чтобы не ломать хеш-цепочку. С PL-91 `trigger_kind` отдельно принимает значение `webhook` (ветка HTTP `POST /api/hooks/:task` больше не попадает в отчёты как `manual`; миграция старых строк не нужна — для них остаётся прежнее значение). С PL-93 поля `verdict`, `attempts_to_pass`, `first_pass` в `gate_outcomes` записываются из `resolveGateOutcome`: flake→pass фиксируется как `verdict=flake, attempts_to_pass=2, first_pass=0`, а не как «всё с первого раза».

### 6.1. ARCH-5.1 / ARCH-5.2 и sequence 4.1 (актуальное состояние)

**ARCH-5.1 — компиляция контекста в прогоне (PL-94).** `buildExecutionPlan` ([execution.ts](src/core/execution.ts)) теперь для каждого шага вызывает `compileContextForRoute` ([dispatch.ts](src/core/router/dispatch.ts)) и кладёт результат в `PlannedStep.compiledContext`. Дополнительная опция `escalationContext` запускает `recompileContextForRouteEscalation` ([dispatch.ts](src/core/router/dispatch.ts)) → `recompileContextOnEscalation` ([run-context.ts](src/db/run-context.ts)): после смены модели/окна получается patched-контекст с новым `contextHash`. Скомпилированный контекст передаётся исполнителю через `StepExecutionInput.compiledContext` и `OpenCodeInvocation.compiledContext`.

**ARCH-5.2 — эскалация и карантин в прогоне (PL-93).** `executeExecutionPlan` ([execution.ts](src/core/execution.ts)) вызывает `runGateWithRetry` → `resolveGateOutcome` → `escalateAfterGate`; выбор таргета учитывает `isGateQuarantined` и `isEscalationExhausted` (пропуск ровно одного уровня: `local → cloud → review`). Решение записывается в `ExecutionResult.escalations` и `metadata`, patched-контекст пересобирается через `recompileStepContext`.

**Sequence 4.1b, ad-hoc mission-путь (кратко; полные диаграммы — [ARCHITECTURE-DIAGRAMS-SEQUENCES.md](./ARCHITECTURE-DIAGRAMS-SEQUENCES.md): 4.1a — зарегистрированная задача через обёртку и рекордер, 4.1b — ad-hoc миссия с планом/маршрутизацией/эскалацией).** Внутренний контур execution-loop ниже относится только к 4.1b: рекордер зарегистрированных задач (4.1a) вызывает из `execution.ts` лишь контекст-хелперы и `writeGateOutcome`, без `buildExecutionPlan`/эскалации.

```mermaid
sequenceDiagram
    participant BP as buildExecutionPlan
    participant R as routeStep / compileContextForRoute
    participant E as executeExecutionPlan
    participant X as StepExecutor
    participant G as runGateWithRetry / escalateAfterGate
    participant C as recompileContextOnEscalation

    BP->>R: routeStep + compileContextForRoute
    R-->>BP: step.compiledContext (contextHash)
    BP->>E: plan
    E->>X: execute(step, compiledContext)
    X-->>E: StepExecutionResult
    E->>G: gate with attempt (flake → retry)
    G-->>E: GateOutcome (verdict, attemptsToPass, firstPass)
    alt провал гейта
        E->>G: escalateAfterGate(current, gate)
        G-->>E: next target (учтён карантин)
        E->>C: recompileContextOnEscalation
        C-->>E: patched context (новый contextHash)
    end
    E->>E: writeGateOutcome(verdict из GateOutcome)
```

---

## 7. Gap-анализ

### Реализовано (подтверждено кодом)

| Возможность | Где | Ключевые символы |
|---|---|---|
| Durable execution | [runs-repo.ts](src/db/runs-repo.ts), [run-journal.ts](src/db/run-journal.ts) | `createRun`, `finishStep`, `renewStepLease`, `runStepStatefullyAsync` |
| Lease + recovery | [run-resume.ts](src/db/run-resume.ts), [run-journal.ts](src/db/run-journal.ts), [record-history.ts](src/core/record-history.ts) | `findResumeStep`, `resumeRun`, `recoverInterruptedSteps`, `recoverStaleRunningOnRecorderStart` (PL-63), `markInterruptedRunWithPartialEdits` |
| Tamper-evident ledger | [runs-repo.ts](src/db/runs-repo.ts) | `recordGateOutcome`, `readGateOutcomeLedger`, `verifyGateOutcomeChain` |
| Capability map (самообучение) | [capability-repo.ts](src/db/capability-repo.ts), [dispatch.ts](src/core/router/dispatch.ts) | `recordCapabilityOutcome`, `decideCapabilityRoute`, `routeStep` |
| Flake-aware verdict + карантин | [escalation.ts](src/core/router/escalation.ts), [capability-repo.ts](src/db/capability-repo.ts) | `runGateWithRetry`, `resolveGateOutcome`, `recordGateVerdict`, `isGateQuarantined` |
| Budget gates (day/week/per-task) | [budget.ts](src/core/budget.ts) | `evaluateBudgetGate`, `evaluateTaskTokenBudgetGate`, `buildBudgetReport` |
| Matrix fan-out + concurrency | [matrix.ts](src/core/matrix.ts) | `expandMatrixTask`, `runMatrix`, `resolveMatrixConcurrency`, `advanceMatrixAfterClone`, `finalizeMatrixIfComplete` |
| DLQ | [run-dlq.ts](src/db/run-dlq.ts) | `enqueueDeadLetter`, `scanDeadLetters`, `retryDeadLetter`, `discardDeadLetter` |
| Pause/resume + инъекции | [run-context.ts](src/db/run-context.ts), [run-resume.ts](src/db/run-resume.ts) | `pauseRun`, `consumeInjections`, `resumeRun` |
| Отложенные эффекты + сага | [gate-integrity.ts](src/core/gate-integrity.ts) | `recordEffectIntents`, `applyDeferredEffects`, `abortDeferredEffects` |
| Snapshot hash verification | [gate-integrity.ts](src/core/gate-integrity.ts) | `gateInputsHash`, `verifyGateSnapshot`, `verifyWorktreeSnapshot` |
| Реальные триггеры | [scheduler/](src/core/scheduler/index.ts), [file-watcher.ts](src/core/file-watcher.ts), [git-trigger.ts](src/core/git-trigger.ts), [server.ts](src/server.ts) | cron/once, `FileWatchManager`, `GitTriggerManager`, `POST /api/hooks/:task`, `emit_event` |
| Реальные исполнители | [opencode-cli.ts](src/core/opencode-cli.ts), [wrappers/bash.ts](src/core/wrappers/bash.ts), [local-ai.ts](src/core/local-ai.ts), [ps-wrapper.ts](src/core/ps-wrapper.ts) | `createOpenCodeExecutor`, shell/locale, локальная модель |
| Реальные интерфейсы | [index.ts](src/index.ts), [rpc.ts](src/rpc.ts), [server.ts](src/server.ts) | MCP tools, `Rpc.define`, HTTP API + GUI |

### Чего не хватает / неоднозначно

1. **`src/db/gate-repo.ts` отсутствует.** Ledger и обучение карты разнесены по трём модулям (`execution.ts`, `runs-repo.ts`, `capability-repo.ts`). Это не баг, но диаграммы, предполагающие наличие `gate-repo.ts`, будут неверны. Зафиксировано в таблице проверки выше.
2. **Webhook-триггер закрыт (PL-91).** `RunTrigger` в [execution.ts](src/core/execution.ts) теперь включает `webhook`, а `triggerKindFor` явно возвращает `webhook`. Ветка `POST /api/hooks/:task` из `server.ts` попадает в ledger как отдельный `trigger_kind` и в отчётах не смешивается с manual/cron. Для старых строк миграция не нужна. Строка PL-91 удалена из `ROADMAP.md`, регрессия — в `test-execution-pipeline.mjs`.
3. **Approval UI/RPC и автоперезапуск закрыты (PL-95, PL-103).** Фасад [approval-api.ts](src/core/approval-api.ts) открывает очередь через RPC `list_approvals`/`decide_approval` и карточку GUI. PL-103 добавил сохранение отложенного исполнения в аудит и автоматический старт после approve через `executeApprovedPlan` ([run-panel-api.ts](src/core/run-panel-api.ts)); повторное решение не создаёт второй run. Open-задача A-1 §3 тем самым закрыта полностью и удалена из `ROADMAP.md`.
4. **Docker/SSH runner есть в коде, но не подключён к execution-пути.** Реализованы `runner.ts` (`resolveRunner` с fail-open на `createLocalRunner`), `runner-docker.ts` и `runner-ssh.ts`; вызовов из `src/index.ts`/`execution.ts` нет — исполнители по-прежнему OpenCode CLI, shell, локальная модель. Ссылки на задачи D-1…D-3 из ROADMAP удалены.
5. **Экономика v2 реализована, enforce — частично.** `budget.ts` (day/week/per-task гейты), `savings.ts`/`usage-surface.ts`/`opencode-usage.ts` (token efficiency, KPI `tokenEfficiency`, offline-оценка `usage.offline_estimate`) на месте; B-1 (бюджетный гейт на cron/once-пути) остаётся открытой задачей. Задачи E-3/E-4/E-5 из ROADMAP удалены.
6. **Покрытие Quality Gate и SCOPE — текущие открытые находки.** PL-120 (парсер SCOPE проглатывает прозу), PL-121 (параллельные задачи в одном чек-ауте), PL-122/PL-123 (ложные предупреждения и `null`-оценки в `dry_run`) — все в §3 ROADMAP. Старые PL-65/PL-66/PL-79/PL-82 закрыты и оттуда удалены.
7. **Суб-агент как механизм выполнения ограничен тарифом.** При автопроверке документа суб-агент падал с «Free usage limit reached» — это окружение Free-тарифа (PL-108), а не дефект репозитория; рабочие проверки делает основной агент.
8. **PL-95 закрыт: очередь одобрений доступна через RPC и GUI.** `requestApproval`/`decideApproval`/`listPendingApprovals` в [audit.ts](src/core/audit.ts) остаются источником данных (журнал аудита, без новой таблицы и без смены `SCHEMA_VERSION=14`); фасад [approval-api.ts](src/core/approval-api.ts) добавляет валидацию и ограничение лимита. В [rpc.ts](src/rpc.ts) появились `list_approvals`/`decide_approval` (счётчик 57 → 59), в [index.ts](src/index.ts) — обработчики, в `src/gui.tsx` — карточка «Одобрения» с ключами `gui.approvals*` в трёх локалях. Прежний `[TODO: проверить]` снят: методы существуют и покрыты регрессией в `test-pause-gui.mjs`. PL-103 закрыл последний нюанс: `decide_approval` при approve теперь возвращает `restart: "auto"` и `restartRunId`, а планы с эффектами — честный `restart: "manual"` без запуска.

9. **PL-97 закрыт: DLQ-retry тоже доигрывает шаг.** PL-92 закрыт: `executeExecutionPlan` пишет `metadata.durableExecution`, а `resumeDurableRunExecution` ([run-panel-api.ts](src/core/run-panel-api.ts)) восстанавливает `StepExecutor`, вызывает `resumeRun` и фиксирует вердикт через `writeGateOutcome`. PL-97 добавил `retryDlqExecution` ([dlq-api.ts](src/core/dlq-api.ts)): перед мутациями проверяется дескриптор (`hasDurableExecution`), затем `retryDeadLetter` ([run-dlq.ts](src/db/run-dlq.ts)) в режиме `deferStepStart` закрывает запись и переоткрывает run, оставляя шаг `failed` ровно до `beginStepAttempt` — так `attempt` увеличивается один раз за повтор. RPC `retry_dlq` и кнопка GUI идут через исполняющий путь; легаси `retryDlq` остался как подготовительный. Если дескриптора нет, запись остаётся открытой и возвращается диагностика. Транспорт `opencode` по умолчанию теперь поднимается через `invokeOpenCodeCli` (реальный CLI с сохранёнными cwd/моделью/сессией). Регрессия в `test-dlq-gui.mjs`: «DLQ → retry → finishStep», один вызов исполнителя, `attempt 3 → 4`, вердикт в ledger и отказ без дескриптора. Диаграмма 4.3 описывает рабочий поток resume, разделяемый с DLQ.

10. **PL-93 и PL-102 закрыты: эскалация подключена и включена в mission-пути.** [execution.ts](src/core/execution.ts) импортирует `runGateWithRetry`/`escalateAfterGate` ([escalation.ts](src/core/router/escalation.ts)) и `isGateQuarantined`/`recordGateVerdict` ([capability-repo.ts](src/db/capability-repo.ts)). При `escalation.enabled: true` гейт повторяется до 2 попыток на артефакте, стабильный `fail` local уходит на cloud-исполнителя (если он есть в `executors`), вердикт пишется через `writeGateOutcome`, а через `recordGateVerdict` обновляется capability map и карантин. `buildExecutionPlan` ([execution.ts](src/core/execution.ts)) при карантине гейта уводит шаг в `review`. PL-102: `runMission` ([mission.ts](src/core/mission.ts)) теперь передаёт `agentResultGate` и `escalation.enabled: true`, поэтому retry/эскалация/обучение работают в реальном ad-hoc прогоне; командная quality gate обёртки продолжает выполняться внутри обёртки. Защита от дублей: если новый маршрут выбирает тот же `StepExecutor.id`, эскалация не запускает агента повторно, а возвращает исходную причину гейта с диагностикой PL-102. Прямые вызовы ядра без опции и рекордер зарегистрированных задач (отдельный процесс с командной гейт-командой) остаются на старом пути — это осознанное ограничение, а не отсутствие кода. Регрессия в `test-execution-pipeline.mjs`: 8 проверок gate/guard и реального mission-прогона с flake-вердиктом в ledger.

11. **PL-94 закрыт: контекст компилируется из ledger и доходит до исполнителя.** `buildExecutionPlan` ([execution.ts](src/core/execution.ts)) после `routeStep` вызывает `compileContextForRoute` ([dispatch.ts](src/core/router/dispatch.ts)) и сохраняет `CompiledContext` (`compiledFrom: "ledger"`, SHA-256 `contextHash`, модель `local-7b`/`cloud-large`) в `PlannedStep.compiledContext`. Поле передаётся в `StepExecutionInput` и `OpenCodeInvocation`, а при PL-93-эскалации `executeStepWithEscalation` пересобирает контекст через `recompileContextForRouteEscalation`/`recompileContextOnEscalation` ([run-context.ts](src/db/run-context.ts)) под новую модель и окно. Регрессия в `test-execution-pipeline.mjs` проверяет 12 свойств, включая разные `contextHash` для local и cloud. PL-102 замкнул контур: этот же путь теперь используется реальным `runMission` по умолчанию.

12. **PL-96 и PL-98 закрыты: цепочка проверяется полностью и автоматически.** `verifyGateOutcomeChain()` ([runs-repo.ts](src/db/runs-repo.ts)) без аргументов читает все строки через `listAllGateOutcomes()`; `readGateOutcomeLedger()` тоже проверяет полную цепочку при `verify !== false`, хотя возвращает `rows` с заданным `limit`. PL-98 добавил фасад `verifyGateLedgerIntegrity(source)` ([audit.ts](src/core/audit.ts)): он вызывает полную проверку, пишет действие `gate_ledger.verify` в `audit_log` (источник, `ok`, `length`, `brokenAt`, `reason`, `checkedAt`) и кэширует результат для `getLastGateLedgerVerification()`. Вызовы встроены в `createRuntime` ([index.ts](src/index.ts)) при старте и в оба пути `self_analysis` (MCP-инструмент и RPC): отчёт дополнился полем `gateLedger`. Ошибки проглатываются, старт и отчёт не ломаются. Регрессия в `test-capability-map.mjs`: валидная цепочка из 5 записей, подмена `evidence_path` последней, разрыв `brokenAt=4`, две записи в аудите и свежий кэш.

> **Важно для читателя:** пункты 3 и 8 описывают один и тот же закрытый контур одобрений: PL-95 добавил RPC/GUI, PL-103 — автоматический перезапуск отложенного плана после approve (с ручным фолбэком для эффектов). Пункт 12 описывает закрытую автопроверку цепочки ledger (PL-98). Resume (п. 9) подключён и к RPC/GUI, и к DLQ-retry. Эскалация (п. 10) встроена в ядро как opt-in и включена в реальном mission-пути после PL-102; рекордер зарегистрированных задач осознанно остаётся на отдельном cmd/process-пути с командной гейт-командой. Компиляция контекста (п. 11) встроена в `buildExecutionPlan` по умолчанию. Диаграммы 3, 4.1a и 4.1b показывают фактические вызовы сплошной линией. Бюджетный гейт проверяется в `index.ts` только на tool/RPC/manual-входах и относится к ad-hoc пути (4.1b); обёртка зарегистрированных задач (4.1a) бюджет не проверяет — открытый пробел PL-125 (задача B-1 Детали 3.12 в `ROADMAP.md`).

### Ссылки на смежные документы

- [ARCHITECTURE.md](./ARCHITECTURE.md) — общее устройство и счётчики.
- [EXECUTION-LOOP.md](./EXECUTION-LOOP.md) — целевой кровоток, §3 (схема `gate_outcomes`) и §10 (hash-ledger как аудит).
- [ARCHITECTURE-DIAGRAMS-SEQUENCES.md](./ARCHITECTURE-DIAGRAMS-SEQUENCES.md) — sequence-диаграммы.
- [ARCHITECTURE-DIAGRAMS-STATES.md](./ARCHITECTURE-DIAGRAMS-STATES.md) — state-диаграммы.
- [ROADMAP.md](../ROADMAP.md), [CHANGELOG.md](../CHANGELOG.md).
