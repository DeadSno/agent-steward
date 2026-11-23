# Steward: Архитектурные диаграммы — последовательности

> Часть основного документа: [ARCHITECTURE-DIAGRAMS.md](./ARCHITECTURE-DIAGRAMS.md).
> Все имена функций сверены с `src/` по состоянию на schema v14, 2026-11-23.

---

## 4. Последовательности

### 4.1 Запуск cron-задачи

Источник: зарегистрированная задача (`registered`), триггер `cron`. Код пути — [record-history.ts](src/core/record-history.ts), [execution.ts](src/core/execution.ts), [runs-repo.ts](src/db/runs-repo.ts).

```mermaid
sequenceDiagram
    participant OS as Планировщик ОС
    participant SCH as scheduler windows или posix
    participant IDX as index.ts (MCP CLI)
    participant RH as record-history.ts
    participant EX as execution.ts
    participant BG as budget.ts
    participant RT as router dispatch и planner
    participant CTX as run-context.ts
    participant AUD as audit.ts
    participant DB as runs-repo.ts
    participant JR as run-journal.ts
    participant OC as opencode-cli.ts
    participant GI as gate-integrity.ts
    participant ESC as router escalation.ts

    OS->>SCH: cron или schtasks /Run
    SCH->>RH: beginRegisteredRun и recordRegisteredRun
    RH->>EX: createRegisteredRunContext
    EX->>EX: validateRunContext
    IDX->>BG: checkBudgetGate → evaluateBudgetGate (до старта, не в execution.ts)
    alt бюджет исчерпан
        BG-->>IDX: skip с причиной
        IDX-->>OS: задача пропущена без запуска агента
    else бюджет есть
        BG-->>IDX: ok
        RH->>EX: buildExecutionPlan
        EX->>RT: planMission и routeStep
        RT->>DB: decideCapabilityRoute читает capability_map
        RT--xCTX: compileContextForRoute compileRunContext — НЕ вызывается (PL-94)
        note over RT,CTX: buildExecutionPlan вызывает только routeStep, исполнителю передаётся сырой RunContext
        RT-->>EX: ExecutionPlan с маршрутами
        EX->>AUD: requestApproval если options.approval и R2 или R3
        alt нет одобрения
            AUD-->>EX: pending или rejected
            EX-->>RH: awaiting_approval или rejected, runId равен null
        else одобрено или R0 R1
            AUD-->>EX: approved
            EX->>DB: createRun и startRun
            loop каждый шаг плана
                EX->>GI: recordEffectIntents до гейта
                EX->>JR: runStepStatefullyAsync
                JR->>OC: StepExecutor execute
                OC-->>JR: output и exitCode
                JR--xESC: runGateWithRetry и resolveGateOutcome — НЕ вызывается (PL-93)
                note over JR,ESC: executeExecutionPlan пишет вердикт напрямую через writeGateOutcome, минуя retry/эскалацию
                JR-->>EX: результат шага
                EX->>EX: writeGateOutcome
                EX->>DB: recordGateOutcome с prev_hash и row_hash
                alt вердикт pass
                    EX->>GI: applyDeferredEffects
                    GI-->>EX: EffectSagaResult applied
                else fail
                    EX->>GI: abortDeferredEffects
                end
                EX->>DB: finishStep
            end
            EX->>DB: finishRun
            EX-->>RH: ExecutionResult
        end
    end
```

**Что видно:** единый путь `RunContext → ExecutionPlan → executeExecutionPlan`. Гейт одобрений и бюджет стоят **до** `createRun`; намерения эффектов — **до** гейта; применение эффектов — **только после** `pass`. Стрелки `--x` с пометками PL-94 и PL-93 показывают вызовы, которых в production нет.

**Ключевые выводы:** три места, где запуск может быть остановлен без побочных эффектов: budget gate (вызывается в [index.ts](src/index.ts:7948), не в движке), approval gate, worktree snapshot gate (`decideWorktreeSnapshot`/`enforceWorktreeSnapshot`, PL-59). Ledger-запись делает `writeGateOutcome`, а не сам исполнитель — поэтому registered и ad-hoc дают одинаковый набор хэшей. Компиляция контекста и flake-aware эскалация в этом пути отсутствуют (PL-94, PL-93).

### 4.2 Matrix fan-out

Источник: [matrix.ts](src/core/matrix.ts) (`expandMatrixTask`, `runMatrix`, `resolveMatrixConcurrency`, `advanceMatrixAfterClone`, `finalizeMatrixIfComplete`), конфиг матрицы — `schedule_task({ matrix: {...} })`.

```mermaid
sequenceDiagram
    participant U as Пользователь или MCP
    participant API as schedule_task в index.ts
    participant MW as manage_workspaces
    participant MT as matrix.ts
    participant TR as tasks-repo.ts
    participant SH as Планировщик ОС
    participant CL as клон задачи workspace 1
    participant CL2 as клон задачи workspace N
    participant EX as execution.ts
    participant DB as runs-repo.ts

    U->>API: schedule_task с matrix workspaceIds
    API->>MW: проверить workspaceIds
    MW-->>API: список workspace
    API->>MT: expandMatrixTask
    MT-->>API: TaskDefinition клонов
    API->>TR: сохранить клонов и родителя is_matrix_parent
    API->>MT: ensureMatrixCompleteTask
    MT->>TR: создать агрегатор parent-matrix-complete
    MT->>TR: dependsOn всех клонов
    loop по числу workspace
        SH->>CL: запуск клона 1
        SH->>CL2: запуск клона N
    end
    Note over MT,SH: resolveMatrixConcurrency ограничивает параллельных клонов
    CL->>EX: runMission или execution plan
    EX->>DB: createRun и finishStep с workspace_id
    CL->>MT: advanceMatrixAfterClone
    CL2->>MT: advanceMatrixAfterClone
    MT->>DB: записать результат клона в матрицу
    MT->>MT: finalizeMatrixIfComplete
    alt все клоны завершены
        MT->>SH: запустить агрегатор matrix-complete
        MT->>DB: aggregateMatrixResults
    else есть незавершённые
        MT-->>SH: ждать следующий клон
    end
```

**Что видно:** родительская задача-шаблон сама не исполняется; создаются клоны по workspace и отдельный агрегатор с `dependsOn`. Concurrency ограничивается `resolveMatrixConcurrency`.

**Ключевые выводы:** за завершение матрицы отвечают `advanceMatrixAfterClone` и `finalizeMatrixIfComplete` — именно их следует указывать в схемах и тестах (а не выдуманные `completeMatrix`/`matrixDone`). При `failureMode: stop` незавершённые клоны снимаются через `cancelPendingMatrixClones`.

### 4.3 Resume после краша

Источник: [run-journal.ts](src/db/run-journal.ts) (`recoverInterruptedSteps`), [run-resume.ts](src/db/run-resume.ts) (`findResumeStep`, `resumeRun`), [runs-repo.ts](src/db/runs-repo.ts) (`renewStepLease`), [run-dlq.ts](src/db/run-dlq.ts). **Ниже — целевой поток:** `recoverInterruptedSteps` действительно вызывается при старте, а `resumeRun` в `src/` не вызывается вообще (только в тестах) — см. PL-92.

```mermaid
sequenceDiagram
    participant BOOT as старт плагина или рекордера
    participant RJ as run-journal.ts
    participant DB as runs-repo.ts
    participant RS as run-resume.ts
    participant CTX as run-context.ts
    participant H as StepHandler
    participant DLQ as run-dlq.ts
    participant AUD as audit.ts

    BOOT->>RJ: recoverInterruptedSteps
    RJ->>DB: listRunningSteps
    DB-->>RJ: шаги status running
    loop каждый running-шаг
        RJ->>DB: проверить lease_until и owner_id
        alt lease жив
            DB-->>RJ: не трогаем чужой шаг
        else lease истёк
            RJ->>DB: пометить STEP_INTERRUPTED_ERROR
            RJ->>AUD: записать причину прерывания
        end
    end
    BOOT--xRS: resumeRun с runId — НЕ вызывается в production (PL-92)
    Note over BOOT,RS: ResumeResult готовит run, но исполнителя шага не запускает
    RS->>DB: findResumeStep и listRunSteps
    DB-->>RS: первый незавершённый шаг по position
    RS->>CTX: pendingInjectionsForStep
    CTX-->>RS: инъекции comment file artifact
    RS->>H: вызвать StepHandler с контекстом
    H->>DB: finishStep success или failure
    alt детерминированное падение
        H->>DLQ: enqueueDeadLetter attempts-exhausted
        Note over DLQ: открытая запись на шаг только одна
        DLQ-->>AUD: ожидает ручного retry или discard
    else успех
        RS->>DB: finishRun
    end
    RS->>CTX: consumeInjections consumed_at и consumed_attempt
    RS-->>BOOT: ResumeResult
```

**Что видно:** recovery не финализирует шаг с живым lease (`owner_id` + `lease_until`). Возобновление идёт строго по `position` из `findResumeStep`; инъекции на паузе потребляются ровно один раз. Стрелка `--x` к `resumeRun` означает, что в текущем production-коде этот вызов отсутствует.

**Ключевые выводы:** идемпотентность шага держится на `idempotency_key` + `attempt` в `run_steps`, а не на повторном вызове агента вслепую. Механизмов два и они не смешиваются: `recoverInterruptedSteps` (массовый при старте, реально работает) и `resumeRun` (точечный по runId — только библиотека и тесты, PL-92). `retryDeadLetter` тоже лишь готовит шаг и ждёт внешний обработчик. DLQ — тупик для детерминированных ошибок, а не общий ретрай.

---

**Ссылки:** [основной документ](./ARCHITECTURE-DIAGRAMS.md) · [state-диаграммы](./ARCHITECTURE-DIAGRAMS-STATES.md)
