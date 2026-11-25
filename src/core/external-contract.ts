/**
 * AD-1.2 — версионируемый внешний контракт Этапа 3.
 *
 * Контракт фиксирует три официальных входа (pipeline YAML, SQLite-ledger и
 * MCP/API) и один общий путь исполнения. Модуль НЕ содержит движка: он только
 * описывает поверхности и превращает внешний запрос в уже существующий
 * `RunContext` → `buildExecutionPlan`. Исполнение остаётся в `executeExecutionPlan`.
 *
 * Детерминированное описание + golden-тест позволяют заметить любое изменение
 * контракта (новый вход, смена версии YAML/схемы, закрытый канал) как дизайн:
 * нужно явным образом обновить версию контракта и golden-фикстуру.
 */
import { createHash } from "node:crypto";
import { SCHEMA_VERSION } from "../db/schema.js";
import {
  buildExecutionPlan,
  createAdHocRunContext,
  describeExecutionPlan,
  type BuildPlanOptions,
  type ExecutionPlan,
  type RunContext,
  type RunTrigger,
} from "./execution.js";
import { PIPELINE_VERSION } from "./pipeline-spec.js";

/** Идентификатор формата контракта в поле `format`. */
export const EXTERNAL_CONTRACT_FORMAT = "agent-steward.external-contract" as const;
/** Семантическая версия контракта (underlying pipeline/SQL), отделена от схемы БД. */
export const EXTERNAL_CONTRACT_VERSION = "1.0" as const;
export const EXTERNAL_CONTRACT_METHODOLOGY_URL =
  "https://github.com/DeadSno/agent-steward/blob/main/docs/EXTERNAL-CONTRACT.md" as const;
/** Формат файла pipeline — уже существующий, без нового парсера. */
export const EXTERNAL_CONTRACT_PIPELINE_FORMAT = "opencode.pipeline.yaml" as const;
/** И SQLite-ledger — уже существующий файл, без нового хранилища. */
export const EXTERNAL_CONTRACT_LEDGER_FILE = "scheduler.db" as const;

/** Канал, через который приходит внешний запрос. */
export type ExternalContractChannel = "mcp" | "api" | "pipeline" | "scheduler";

/** Официальная точка входа внешнего контракта. */
export interface ExternalContractEntry {
  channel: ExternalContractChannel;
  /** Имя MCP-инструмента, RPC-метода или операции pipeline/scheduler. */
  name: string;
  /** Триггер `RunContext`, в который отображается вход. */
  trigger: RunTrigger;
  /** Все входы идут через один и тот же цикл. */
  loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan";
}

/** Стабильное описание контракта (golden-фиксируемое). */
export interface ExternalContractDescriptor {
  format: typeof EXTERNAL_CONTRACT_FORMAT;
  version: typeof EXTERNAL_CONTRACT_VERSION;
  pipeline: {
    format: typeof EXTERNAL_CONTRACT_PIPELINE_FORMAT;
    /** Совпадает с `PIPELINE_VERSION` из pipeline-spec. */
    version: number;
  };
  ledger: {
    database: typeof EXTERNAL_CONTRACT_LEDGER_FILE;
    schemaVersion: number;
    tables: readonly string[];
  };
  entries: readonly ExternalContractEntry[];
  /** Инварианты, которые не меняются при смене канала входа. */
  preserved: readonly string[];
  executionLoop: {
    context: string;
    plan: string;
    execute: string;
    gates: readonly string[];
  };
}

/** Таблицы ledger, которые являются частью контракта. */
export const EXTERNAL_CONTRACT_LEDGER_TABLES = [
  "tasks",
  "history",
  "runs",
  "run_steps",
  "run_dlq",
  "gate_outcomes",
  "audit_log",
  "settings",
] as const;

/** Официальные входы Этапа 3. */
export const EXTERNAL_CONTRACT_ENTRIES: readonly ExternalContractEntry[] = [
  { channel: "mcp", name: "run_task_now", trigger: "manual", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  { channel: "mcp", name: "emit_event", trigger: "mcp-event", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  { channel: "mcp", name: "dry_run", trigger: "manual", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  { channel: "api", name: "create_task", trigger: "cron", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  { channel: "api", name: "run_mission", trigger: "manual", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  { channel: "pipeline", name: "pipeline_apply", trigger: "cron", loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan" },
  {
    channel: "scheduler",
    name: "nativeScheduler",
    trigger: "mcp-event",
    loop: "RunContext -> buildExecutionPlan -> executeExecutionPlan",
  },
] as const;

/** Что запрещено терять при добавлении нового канала. */
export const EXTERNAL_CONTRACT_PRESERVED = [
  "ledger",
  "dlq",
  "budgets",
  "approval",
  "quality-gate",
  "local-first",
] as const;

/** Гейты общего цикла — не второй движок, а существующие проверки. */
export const EXTERNAL_CONTRACT_GATES = [
  "risk-class",
  "compiled-policy",
  "quality-gate",
  "commit-attribution",
  "budget",
  "approval",
] as const;

/** Возвращает актуальное описание контракта (новый объект при каждом вызове). */
export function externalContractDescriptor(): ExternalContractDescriptor {
  return {
    format: EXTERNAL_CONTRACT_FORMAT,
    version: EXTERNAL_CONTRACT_VERSION,
    pipeline: {
      format: EXTERNAL_CONTRACT_PIPELINE_FORMAT,
      version: PIPELINE_VERSION,
    },
    ledger: {
      database: EXTERNAL_CONTRACT_LEDGER_FILE,
      schemaVersion: SCHEMA_VERSION,
      tables: [...EXTERNAL_CONTRACT_LEDGER_TABLES],
    },
    entries: EXTERNAL_CONTRACT_ENTRIES.map((entry) => ({ ...entry })),
    preserved: [...EXTERNAL_CONTRACT_PRESERVED],
    executionLoop: {
      context: "RunContext",
      plan: "buildExecutionPlan",
      execute: "executeExecutionPlan",
      gates: [...EXTERNAL_CONTRACT_GATES],
    },
  };
}

/** Канонический JSON: стабильный порядок полей для golden-сравнения и хэша. */
export function externalContractCanonical(
  descriptor: ExternalContractDescriptor = externalContractDescriptor(),
): string {
  return JSON.stringify({
    format: descriptor.format,
    version: descriptor.version,
    pipeline: {
      format: descriptor.pipeline.format,
      version: descriptor.pipeline.version,
    },
    ledger: {
      database: descriptor.ledger.database,
      schemaVersion: descriptor.ledger.schemaVersion,
      tables: [...descriptor.ledger.tables],
    },
    entries: descriptor.entries.map((entry) => ({
      channel: entry.channel,
      name: entry.name,
      trigger: entry.trigger,
      loop: entry.loop,
    })),
    preserved: [...descriptor.preserved],
    executionLoop: {
      context: descriptor.executionLoop.context,
      plan: descriptor.executionLoop.plan,
      execute: descriptor.executionLoop.execute,
      gates: [...descriptor.executionLoop.gates],
    },
  });
}

/** Короткий детерминированный отпечаток контракта (golden-маркер). */
export function externalContractHash(
  descriptor: ExternalContractDescriptor = externalContractDescriptor(),
): string {
  return createHash("sha256").update(externalContractCanonical(descriptor)).digest("hex").slice(0, 16);
}

/** Идентификатор контракта для логов и заголовков ответов. */
export function externalContractId(): string {
  return `${EXTERNAL_CONTRACT_FORMAT}@${EXTERNAL_CONTRACT_VERSION}`;
}

/** Человекочитаемая трассировка контракта. */
export function describeExternalContract(): string {
  const descriptor = externalContractDescriptor();
  const lines = [
    `${externalContractId()} hash=${externalContractHash(descriptor)}`,
    `pipeline: ${descriptor.pipeline.format} v${descriptor.pipeline.version}`,
    `ledger: ${descriptor.ledger.database} schema=${descriptor.ledger.schemaVersion} tables=${descriptor.ledger.tables.length}`,
  ];
  for (const entry of descriptor.entries) {
    lines.push(`entry: ${entry.channel}/${entry.name} -> ${entry.trigger} (общий execution loop)`);
  }
  lines.push(`preserved: ${descriptor.preserved.join(", ")}`);
  return lines.join("\n");
}

/** Внешний запрос на запуск (MCP, API, pipeline или native-триггер). */
export interface ExternalRunRequest {
  channel: ExternalContractChannel;
  /** Имя точки входа из `EXTERNAL_CONTRACT_ENTRIES`. */
  entry: string;
  /** Миссия/промпт, как и для ad-hoc запуска. */
  mission: string;
  cwd?: string;
  taskName?: string;
  taskType?: string;
  trigger?: RunTrigger;
  metadata?: Record<string, unknown>;
}

/** Результат подготовки внешнего запуска: контракт + контекст + план. */
export interface ExternalContractPlan {
  contractId: string;
  contractHash: string;
  entry: ExternalContractEntry;
  context: RunContext;
  plan: ExecutionPlan;
  trace: string;
}

/** Находит официальную точку входа; неизвестные каналы отклоняются. */
export function resolveExternalEntry(
  channel: ExternalContractChannel,
  name: string,
): ExternalContractEntry {
  const entry = EXTERNAL_CONTRACT_ENTRIES.find(
    (candidate) => candidate.channel === channel && candidate.name === name,
  );
  if (!entry) {
    throw new Error(
      `Внешний контракт ${externalContractId()}: неизвестный вход ${channel}/${name}`,
    );
  }
  return entry;
}

/**
 * Преобразует внешний запрос в существующий `RunContext`.
 * Никакого второго движка и отдельной модели запуска: вызывается та же фабрика,
 * что и для ad-hoc миссии, с явными метками контракта в метаданных.
 */
export function externalRequestToContext(request: ExternalRunRequest): RunContext {
  const entry = resolveExternalEntry(request.channel, request.entry);
  return createAdHocRunContext(request.mission, {
    cwd: request.cwd,
    taskName: request.taskName ?? `external-${entry.name}`,
    taskType: request.taskType,
    trigger: request.trigger ?? entry.trigger,
    metadata: {
      ...(request.metadata ?? {}),
      externalContract: EXTERNAL_CONTRACT_VERSION,
      externalChannel: entry.channel,
      externalEntry: entry.name,
    },
  });
}

/**
 * Готовит план внешнего запуска через тот же `buildExecutionPlan`, что и для
 * зарегистрированных задач. План не исполняется — исполнение остаётся в
 * `executeExecutionPlan` и вызывается рантаймом обычным образом.
 */
export async function buildExternalContractPlan(
  request: ExternalRunRequest,
  options: BuildPlanOptions = {},
): Promise<ExternalContractPlan> {
  const entry = resolveExternalEntry(request.channel, request.entry);
  const context = externalRequestToContext(request);
  const plan = await buildExecutionPlan(context, options);
  return {
    contractId: externalContractId(),
    contractHash: externalContractHash(),
    entry,
    context,
    plan,
    trace: describeExecutionPlan(plan),
  };
}
