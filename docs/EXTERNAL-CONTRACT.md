# Внешний контракт Этапа 3 (AD-1.2)

Версия контракта: `agent-steward.external-contract@1.0`.
Отпечаток (golden-маркер) хранится в `test-external-contract-golden.json` и
проверяется тестом `test-external-contract.mjs`.

## Что фиксируется

Контракт описывает три уже существующие поверхности и один общий путь
исполнения. Нового парсера, нового хранилища и нового движка не добавляется:

| Поверхность | Формат | Источник правды |
|---|---|---|
| Pipeline YAML | `opencode.pipeline.yaml`, `version: 1` | `src/core/pipeline-spec.ts` (`PIPELINE_VERSION`) |
| SQLite ledger | `scheduler.db`, schema `14` | `src/db/schema.ts` (`SCHEMA_VERSION`) |
| MCP / API вход | 34 инструмента / 61 RPC-метод | `src/tool-specs.ts`, `src/rpc.ts` |

В контракт включены таблицы `tasks`, `history`, `runs`, `run_steps`,
`run_dlq`, `gate_outcomes`, `audit_log`, `settings`. Гейты общего цикла —
`risk-class`, `compiled-policy`, `quality-gate`, `commit-attribution`,
`budget`, `approval`.

## Официальные входы

| Канал | Вход | Триггер `RunContext` |
|---|---|---|
| `mcp` | `run_task_now` | `manual` |
| `mcp` | `emit_event` | `mcp-event` |
| `mcp` | `dry_run` | `manual` |
| `api` | `create_task` | `cron` |
| `api` | `run_mission` | `manual` |
| `pipeline` | `pipeline_apply` | `cron` |
| `scheduler` | `nativeScheduler` | `mcp-event` |

Любой вход отображается в `RunContext` фабрикой `createAdHocRunContext` и
проходит через `buildExecutionPlan` → `executeExecutionPlan`. Разница между
каналами — только способ доставки триггера; ledger, DLQ, бюджеты, approval и
quality-gate остаются общими. Режим `nativeScheduler` (AD-1.1) меняет только
источник триггера и при отсутствии capability хоста откатывается на polling.

## Публичный API

Модуль `src/core/external-contract.ts` доступен через точку входа
`agent-steward/core`:

- `externalContractDescriptor()` — актуальное описание контракта;
- `externalContractCanonical()` / `externalContractHash()` — стабильный JSON и
  короткий SHA-256 отпечаток;
- `externalContractId()` — строка `format@version`;
- `describeExternalContract()` — человекочитаемая трассировка;
- `resolveExternalEntry()` — проверка, что канал/вход объявлены в контракте;
- `externalRequestToContext()` — transformation запроса в уже существующий
  `RunContext` с метками `externalContract`, `externalChannel`, `externalEntry`;
- `buildExternalContractPlan()` — подготовка плана тем же `buildExecutionPlan`.

Функции не запускают исполнителя и не открывают соединения: сайд-эффекты
остаются в ответственности рантайма.

## Golden-контракт и правила изменения

`test-external-contract.mjs` сверяет дескриптор и хэш с
`test-external-contract-golden.json`, а также проверяет паритет плана для
всех объявленных входов с прямым вызовом `createAdHocRunContext` +
`buildExecutionPlan`. Это защищает от появления «второго движка»: если новый
канал начнёт строить план иначе, паритет нарушится.

Любое несовместимое изменение (новый вход, смена версии pipeline YAML или
схемы БД, исключение таблицы из ledger, смена гейтов) требует:

1. поднять `EXTERNAL_CONTRACT_VERSION`;
2. обновить golden-фикстуру и ожидаемый хэш;
3. обновить этот документ и запись в CHANGELOG.

Совместимые добавления (новый триггер внутри уже объявленного входа) также
должны проходить через golden-тест: новый вход в `entries` меняет хэш, поэтому
версия контракта обновляется и при расширении списка входов.
