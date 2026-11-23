import type { GateVerdict } from "../core/router/escalation.js";
import { normalizeTaskType } from "../core/router/rules.js";
import { getDb, withTransaction } from "./index.js";
import { getSetting, setSetting } from "./settings-repo.js";
import { recordGateOutcome } from "./runs-repo.js";

/**
 * Capability Map — слой 2 роутера (Спринт 36.5.b).
 *
 * Таблица `capability_map` хранит, как исполнитель справлялся с типом задачи:
 * сколько запусков было, сколько прошло гейт, среднюю стоимость и время, а
 * также последние 10 исходов. Роутер читает карту и выбирает маршрут
 * (local / cloud / review) по порогам — без вызова модели, то есть 0 токенов
 * на само решение.
 *
 * Карта обучается на исходах гейта: каждый прогон шага вызывает
 * {@link recordCapabilityOutcome}, статистика обновляется скользящим средним.
 * Данных мало — карта честно говорит «не знаю» и отдаёт решение слою 3
 * (Explore-режим).
 */

/** Куда исполнять шаг. `review` — данных достаточно, но успех нестабилен. */
export type CapabilityTarget = "local" | "cloud" | "review" | "explore";

/** Порог, выше которого шаг считается надёжным для локали. */
export const LOCAL_SUCCESS_THRESHOLD = 0.85;

/** Порог, ниже которого локальный исполнитель считается безнадёжным. */
export const CLOUD_FAILURE_THRESHOLD = 0.3;

/** Минимум исходов, чтобы карта вообще бралась судить. */
export const MIN_RUNS_FOR_DECISION = 3;

/** Сколько последних исходов хранить (1 — гейт пройден, 0 — провал). */
export const RECENT_RUNS_LIMIT = 10;

/**
 * B13: полураспад веса исхода в последних прогонах. Исход давностью
 * `SUCCESS_HALF_LIFE_RUNS` прогонов весит вдвое меньше свежего.
 */
export const SUCCESS_HALF_LIFE_RUNS = 8;

/** B13: доля затухающего success rate в итоговой надёжности. */
export const DECAY_WEIGHT = 0.7;

/** B13: доля first-pass rate в итоговой надёжности. */
export const FIRST_PASS_WEIGHT = 0.3;

export interface CapabilityRecord {
  taskType: string;
  /** Исполнитель, который последним обрабатывал тип задачи. */
  model: string;
  runsTotal: number;
  runsPassed: number;
  /** B13: сколько успехов получено с первой попытки. */
  firstPassCount: number;
  /** B13: first_pass_count / runs_total. */
  firstPassRate: number;
  successRate: number;
  /** B13: success rate последних прогонов с экспоненциальным затуханием. */
  decayedSuccessRate: number;
  /** B13: 0.7 * decayedSuccessRate + 0.3 * firstPassRate — вход маршрутизации. */
  effectiveSuccessRate: number;
  avgCostUsd: number;
  avgTimeMs: number;
  /** Последние исходы, старые слева, новые справа, максимум 10. */
  last10Runs: number[];
  createdAt: string;
  updatedAt: string;
}

/** Один исход гейта: пройден/провален + необязательные стоимость и время. */
export interface CapabilityOutcome {
  taskType: string;
  model?: string;
  passed: boolean;
  costUsd?: number;
  timeMs?: number;
  /** B13: число попыток до исхода (1 — с первой). */
  attempts?: number;
  /** B13: явный признак first-pass; по умолчанию passed && attempts <= 1. */
  firstPass?: boolean;
}

export interface CapabilityThresholds {
  localSuccess?: number;
  cloudFailure?: number;
  minRuns?: number;
}

export interface CapabilityDecision {
  taskType: string;
  target: CapabilityTarget;
  /** Машиночитаемая причина: no-data | local-reliable | escalate | review. */
  reason: "no-data" | "local-reliable" | "escalate" | "review";
  successRate: number;
  /** B13: надёжность с учётом затухания и first-pass, по ней принимается решение. */
  effectiveSuccessRate: number;
  /** B13: затухающий success rate последних прогонов. */
  decayedSuccessRate: number;
  /** B13: доля успехов с первой попытки. */
  firstPassRate: number;
  runsTotal: number;
  capability: CapabilityRecord | null;
}

const DEFAULT_MODEL = "local";

function nowIso(): string {
  return new Date().toISOString();
}

function requireTaskType(taskType: string): string {
  if (typeof taskType !== "string" || taskType.trim() === "") {
    throw new Error("Пустой тип задачи: Capability Map требует непустой taskType.");
  }
  return normalizeTaskType(taskType);
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Некорректное значение ${field}: ожидалось неотрицательное число, получено ${value}.`);
  }
  return value;
}

/** B13: номер попытки — целое ≥ 1. */
function requireAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Некорректное значение attempts: ожидалось целое ≥ 1, получено ${value}.`);
  }
  return value;
}

function parseRecentRuns(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((value) => (typeof value === "number" ? value : Number(value)))
      .filter((value) => value === 0 || value === 1)
      .slice(-RECENT_RUNS_LIMIT);
  } catch {
    return [];
  }
}

/**
 * B13: экспоненциально взвешенный success rate последних исходов.
 *
 * Свежий исход весит 1, исход давностью `halfLife` прогонов — 0.5.
 * Так старые успехи не перевешивают свежие провалы, а `last_10_runs`
 * участвует в решении, а не только хранится для отчёта.
 */
export function decayedSuccessRate(
  runs: number[],
  halfLife: number = SUCCESS_HALF_LIFE_RUNS,
): number {
  const recent = runs
    .filter((value) => value === 0 || value === 1)
    .slice(-RECENT_RUNS_LIMIT);
  if (recent.length === 0) return 0;
  const hl = Number.isFinite(halfLife) && halfLife > 0 ? halfLife : SUCCESS_HALF_LIFE_RUNS;
  let weighted = 0;
  let weights = 0;
  recent.forEach((value, index) => {
    const age = recent.length - 1 - index;
    const weight = Math.pow(0.5, age / hl);
    weighted += weight * value;
    weights += weight;
  });
  return weights > 0 ? weighted / weights : 0;
}

/** B13: надёжность для маршрутизации — затухание плюс успех с первой попытки. */
export function effectiveReliability(decayedRate: number, firstPassRate: number): number {
  const decayed = Math.min(1, Math.max(0, decayedRate));
  const firstPass = Math.min(1, Math.max(0, firstPassRate));
  return DECAY_WEIGHT * decayed + FIRST_PASS_WEIGHT * firstPass;
}

function rowToRecord(row: Record<string, unknown>): CapabilityRecord {
  const runsTotal = Number(row.runs_total) || 0;
  const runsPassed = Number(row.runs_passed) || 0;
  const successRate =
    Number(row.success_rate) || (runsTotal > 0 ? runsPassed / runsTotal : 0);
  const firstPassCount = Number(row.first_pass_count) || 0;
  const firstPassRate =
    runsTotal > 0 ? Math.min(1, firstPassCount / runsTotal) : 0;
  const last10Runs = parseRecentRuns(row.last_10_runs);
  const decayed =
    last10Runs.length > 0 ? decayedSuccessRate(last10Runs) : successRate;
  return {
    taskType: String(row.task_type),
    model: String(row.model ?? DEFAULT_MODEL),
    runsTotal,
    runsPassed,
    firstPassCount,
    firstPassRate,
    successRate,
    decayedSuccessRate: decayed,
    effectiveSuccessRate: effectiveReliability(decayed, firstPassRate),
    avgCostUsd: Number(row.avg_cost_usd) || 0,
    avgTimeMs: Number(row.avg_time_ms) || 0,
    last10Runs,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Читает статистику по типу задачи или `null`, если данных ещё нет. */
export function getCapability(taskType: string): CapabilityRecord | null {
  const key = requireTaskType(taskType);
  const row = getDb()
    .prepare("SELECT * FROM capability_map WHERE task_type = ?")
    .get(key) as Record<string, unknown> | undefined;
  return row ? rowToRecord(row) : null;
}

/** Все известные типы задач, сначала самые надёжные. */
export function listCapabilities(limit = 100): CapabilityRecord[] {
  const capped = Math.max(1, Math.floor(limit));
  const rows = getDb()
    .prepare("SELECT * FROM capability_map ORDER BY success_rate DESC, runs_total DESC, task_type ASC LIMIT ?")
    .all(capped) as Record<string, unknown>[];
  return rows.map(rowToRecord);
}

/**
 * Записывает исход гейта и обновляет статистику скользящим средним.
 *
 * Возвращает актуальную запись карты — её же удобно логировать вместе с
 * решением роутера, чтобы видеть, на каких данных он остановился.
 */
export function recordCapabilityOutcome(outcome: CapabilityOutcome): CapabilityRecord {
  const key = requireTaskType(outcome.taskType);
  if (typeof outcome.passed !== "boolean") {
    throw new Error("Исход гейта должен быть boolean (passed).");
  }
  const cost = outcome.costUsd === undefined ? 0 : requireNonNegative(outcome.costUsd, "costUsd");
  const time = outcome.timeMs === undefined ? 0 : requireNonNegative(outcome.timeMs, "timeMs");
  const model = (outcome.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const passed = outcome.passed ? 1 : 0;
  const attempts = outcome.attempts === undefined ? undefined : requireAttempts(outcome.attempts);
  if (outcome.firstPass !== undefined && typeof outcome.firstPass !== "boolean") {
    throw new Error("Признак firstPass должен быть boolean.");
  }
  // B13: без явного признака успех считается первым, если попытка одна
  // (или число попыток не передано — обратная совместимость).
  const firstPass =
    passed === 1 &&
    (outcome.firstPass ?? (attempts === undefined || attempts === 1));
  const firstPassIncrement = firstPass ? 1 : 0;

  return withTransaction(() => {
    const db = getDb();
    const timestamp = nowIso();
    const existing = getCapability(key);
    if (!existing) {
      db.prepare(
        `INSERT INTO capability_map (
           task_type, model, runs_total, runs_passed, first_pass_count, success_rate,
           avg_cost_usd, avg_time_ms, last_10_runs, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key,
        model,
        passed,
        firstPassIncrement,
        passed,
        cost,
        time,
        JSON.stringify([passed]),
        timestamp,
        timestamp,
      );
    } else {
      const runsTotal = existing.runsTotal + 1;
      const runsPassed = existing.runsPassed + passed;
      const avgCost = (existing.avgCostUsd * existing.runsTotal + cost) / runsTotal;
      const avgTime = (existing.avgTimeMs * existing.runsTotal + time) / runsTotal;
      const recent = [...existing.last10Runs, passed].slice(-RECENT_RUNS_LIMIT);
      db.prepare(
        `UPDATE capability_map
            SET model = ?, runs_total = ?, runs_passed = ?,
                first_pass_count = COALESCE(first_pass_count, 0) + ?,
                success_rate = ?, avg_cost_usd = ?, avg_time_ms = ?,
                last_10_runs = ?, updated_at = ?
          WHERE task_type = ?`,
      ).run(
        model,
        runsTotal,
        runsPassed,
        firstPassIncrement,
        runsPassed / runsTotal,
        avgCost,
        avgTime,
        JSON.stringify(recent),
        timestamp,
        key,
      );
    }
    const record = getCapability(key);
    if (!record) {
      throw new Error(`Capability Map: запись для ${key} не сохранилась.`);
    }
    return record;
  });
}

/**
 * Решение слоя 2 по порогам (0 токенов).
 *
 * Пороги применяются к `effectiveSuccessRate` — 0.7 затухающего success rate
 * последних прогонов плюс 0.3 first-pass rate (B13), а не к кумулятивному
 * success rate. Поэтому старые успехи не перевешивают свежие провалы.
 *
 * - данных меньше `minRuns` → `explore` (решает слой 3);
 * - `effectiveSuccessRate ≥ 0.85` → `local`;
 * - `effectiveSuccessRate ≤ 0.30` → `cloud` (эскалация);
 * - между порогами → `review` (нужен человек или облачный ревьюер).
 */
export function decideCapabilityRoute(
  taskType: string,
  thresholds: CapabilityThresholds = {},
): CapabilityDecision {
  const key = requireTaskType(taskType);
  const localSuccess = thresholds.localSuccess ?? LOCAL_SUCCESS_THRESHOLD;
  const cloudFailure = thresholds.cloudFailure ?? CLOUD_FAILURE_THRESHOLD;
  const minRuns = thresholds.minRuns ?? MIN_RUNS_FOR_DECISION;
  if (localSuccess <= cloudFailure) {
    throw new Error("Порог localSuccess должен быть больше cloudFailure.");
  }

  const capability = getCapability(key);
  const effectiveSuccessRate = capability?.effectiveSuccessRate ?? 0;
  const decayedSuccessRate = capability?.decayedSuccessRate ?? 0;
  const firstPassRate = capability?.firstPassRate ?? 0;
  if (!capability || capability.runsTotal < minRuns) {
    return {
      taskType: key,
      target: "explore",
      reason: "no-data",
      successRate: capability?.successRate ?? 0,
      effectiveSuccessRate,
      decayedSuccessRate,
      firstPassRate,
      runsTotal: capability?.runsTotal ?? 0,
      capability,
    };
  }

  if (effectiveSuccessRate >= localSuccess) {
    return {
      taskType: key,
      target: "local",
      reason: "local-reliable",
      successRate: capability.successRate,
      effectiveSuccessRate,
      decayedSuccessRate,
      firstPassRate,
      runsTotal: capability.runsTotal,
      capability,
    };
  }

  if (effectiveSuccessRate <= cloudFailure) {
    return {
      taskType: key,
      target: "cloud",
      reason: "escalate",
      successRate: capability.successRate,
      effectiveSuccessRate,
      decayedSuccessRate,
      firstPassRate,
      runsTotal: capability.runsTotal,
      capability,
    };
  }

  return {
    taskType: key,
    target: "review",
    reason: "review",
    successRate: capability.successRate,
    effectiveSuccessRate,
    decayedSuccessRate,
    firstPassRate,
    runsTotal: capability.runsTotal,
    capability,
  };
}

/** Готова ли таблица карты (для диагностики и тестов миграции). */
export function isCapabilityMapReady(): boolean {
  const rows = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capability_map'")
    .all() as { name?: string }[];
  return rows.length > 0;
}

/* ------------------------------------------------------------------------- *
 * ARCH-3: flake-aware вердикт гейта
 * ------------------------------------------------------------------------- */

/** Сколько флаков одного гейта переводят его в карантин. */
export const FLAKE_QUARANTINE_THRESHOLD = 2;

/** Срок карантина в часах — карантин истекает, а не блокирует навсегда. */
export const GATE_QUARANTINE_HOURS = 24;

const GATE_QUARANTINE_SETTING_KEY = "gate_quarantine";

const GATE_VERDICT_SET: ReadonlySet<string> = new Set<GateVerdict>([
  "pass",
  "fail",
  "flake",
  "infra_fail",
]);

interface GateQuarantineEntry {
  flakeCount: number;
  quarantinedUntil: string | null;
}

type GateQuarantineState = Record<string, GateQuarantineEntry>;

/** Вход записи вердикта гейта (ARCH-3.1 + ARCH-3.2). */
export interface GateVerdictRecord {
  /** Идемпотентный ключ строки ledger `gate_outcomes`. */
  outcomeKey: string;
  /** Тип задачи, к которому относится гейт. */
  taskType: string;
  /** Стабильный ключ самого гейта (команда/хук); по нему считается карантин. */
  gateKey: string;
  verdict: GateVerdict;
  /** На какой попытке гейт прошёл (или сколько попыток всего при провале). */
  attemptsToPass: number;
  /** Прошёл ли гейт с первой попытки. */
  firstPass: boolean;
  runId?: string;
  stepId?: string;
  stepName?: string;
  missionId?: string;
  gateType?: string;
  reason?: string;
  costUsd?: number;
  timeMs?: number;
  model?: string;
  evidencePath?: string;
  gateHash?: string;
}

/** Результат записи вердикта: что попало в ledger, карту и карантин. */
export interface GateVerdictResult {
  ledgerId: number;
  verdict: GateVerdict;
  /** Стабильные pass/fail обновляют карту; flake/infra_fail — никогда. */
  capabilityUpdated: boolean;
  capability: CapabilityRecord | null;
  quarantined: boolean;
  quarantineUntil: string | null;
  /** Предупреждение пользователю/в отчёте (для flake и infra_fail). */
  warning: string | null;
}

function requireGateKey(value: string | undefined): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("ARCH-3: нужен непустой gateKey гейта.");
  }
  return value.trim();
}

function readQuarantineState(): GateQuarantineState {
  const raw = getSetting<unknown>(GATE_QUARANTINE_SETTING_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as GateQuarantineState)
    : {};
}

/** Не истёкший ли карантин (ISO-строка или null). */
function activeQuarantine(entry: GateQuarantineEntry | undefined, nowMs: number): string | null {
  if (!entry?.quarantinedUntil) return null;
  const until = Date.parse(entry.quarantinedUntil);
  return Number.isFinite(until) && until > nowMs ? entry.quarantinedUntil : null;
}

/**
 * ARCH-3.1/3.2: пишет вердикт в ledger, обновляет карту ТОЛЬКО для стабильных
 * pass/fail и ведёт карантин флакующих гейтов с предупреждением.
 *
 * Ledger — единственный источник истины: строка gate_outcomes создаётся через
 * {@link recordGateOutcome} с hash-цепочкой. Capability Map — агрегат, поэтому
 * `flake` (прошёл со 2-й попытки) и `infra_fail` в неё не попадают: шум и
 * инфраструктура не должны портить статистику исполнителя.
 */
export function recordGateVerdict(
  record: GateVerdictRecord,
  now: Date = new Date(),
): GateVerdictResult {
  if (record === null || typeof record !== "object") {
    throw new Error("ARCH-3: нужен объект вердикта гейта.");
  }
  if (!GATE_VERDICT_SET.has(record.verdict)) {
    throw new Error(`ARCH-3: неизвестный вердикт гейта: ${String(record.verdict)}.`);
  }
  if (typeof record.firstPass !== "boolean") {
    throw new Error("ARCH-3: firstPass должен быть boolean.");
  }
  if (!Number.isInteger(record.attemptsToPass) || record.attemptsToPass < 1) {
    throw new Error("ARCH-3: attemptsToPass должен быть целым ≥ 1.");
  }
  if (typeof record.outcomeKey !== "string" || record.outcomeKey.trim() === "") {
    throw new Error("ARCH-3: нужен непустой outcomeKey для ledger.");
  }
  const taskType = requireTaskType(record.taskType);
  const gateKey = requireGateKey(record.gateKey ?? record.stepName ?? record.taskType);
  const nowMs = now.getTime();

  return withTransaction(() => {
    const ledger = recordGateOutcome({
      outcomeKey: record.outcomeKey.trim(),
      missionId: record.missionId ?? null,
      runId: record.runId ?? null,
      stepId: record.stepId ?? null,
      stepName: record.stepName ?? null,
      taskType,
      gateType: record.gateType ?? null,
      verdict: record.verdict,
      attemptsToPass: record.attemptsToPass,
      firstPass: record.firstPass,
      routeReason: record.reason ?? null,
      evidencePath: record.evidencePath ?? null,
      gateHash: record.gateHash ?? null,
      modelVersion: record.model ?? null,
    });

    let capability: CapabilityRecord | null = null;
    let capabilityUpdated = false;
    if (record.verdict === "pass" || record.verdict === "fail") {
      capability = recordCapabilityOutcome({
        taskType,
        passed: record.verdict === "pass",
        attempts: record.attemptsToPass,
        firstPass: record.verdict === "pass" && record.firstPass,
        costUsd: record.costUsd,
        timeMs: record.timeMs,
        model: record.model,
      });
      capabilityUpdated = true;
    } else {
      capability = getCapability(taskType);
    }

    const state = readQuarantineState();
    const previous: GateQuarantineEntry =
      state[gateKey] ?? { flakeCount: 0, quarantinedUntil: null };
    // Истёкший карантин сбрасываем: он не блокирует гейт навсегда. Счётчик
    // флаков при этом сохраняется, если карантина ещё не было вовсе.
    const expired = Boolean(previous.quarantinedUntil) && !activeQuarantine(previous, nowMs);
    const base: GateQuarantineEntry = expired
      ? { flakeCount: 0, quarantinedUntil: null }
      : { ...previous };
    let entry: GateQuarantineEntry = { ...base };
    let quarantined = false;
    let quarantineUntilIso: string | null = base.quarantinedUntil;
    let warning: string | null = null;

    if (record.verdict === "flake") {
      entry.flakeCount += 1;
      if (entry.flakeCount >= FLAKE_QUARANTINE_THRESHOLD && !activeQuarantine(entry, nowMs)) {
        const until = new Date(nowMs + GATE_QUARANTINE_HOURS * 60 * 60 * 1000);
        quarantineUntilIso = until.toISOString();
        entry.quarantinedUntil = quarantineUntilIso;
      }
      quarantined = Boolean(activeQuarantine(entry, nowMs));
      if (quarantined) {
        warning =
          `Гейт «${gateKey}» нестабилен (${entry.flakeCount} флаков): ` +
          `выдан карантин до ${quarantineUntilIso}. Результат гейта нестабилен и не обучает capability_map.`;
      }
    } else if (record.verdict === "infra_fail") {
      quarantined = Boolean(activeQuarantine(entry, nowMs));
      warning =
        `Гейт «${gateKey}» завершился инфраструктурной ошибкой: ` +
        `${record.reason ?? "причина не указана"}. Вердикт infra_fail отделён от flakes и не обучает capability_map.`;
    } else {
      // Стабильный pass/fail — признак выздоровления гейта: снимаем карантин.
      entry = { flakeCount: 0, quarantinedUntil: null };
      quarantineUntilIso = null;
      quarantined = false;
    }

    state[gateKey] = entry;
    setSetting(GATE_QUARANTINE_SETTING_KEY, state);

    return {
      ledgerId: ledger.id,
      verdict: record.verdict,
      capabilityUpdated,
      capability,
      quarantined,
      quarantineUntil: quarantineUntilIso,
      warning,
    };
  });
}

/** Находится ли гейт в карантине на момент `now` (истёкший — уже нет). */
export function isGateQuarantined(gateKey: string, now: Date = new Date()): boolean {
  const key = requireGateKey(gateKey);
  const entry = readQuarantineState()[key];
  return Boolean(activeQuarantine(entry, now.getTime()));
}

/** Текст предупреждения для пользователя/отчёта, если гейт в карантине. */
export function getGateQuarantineWarning(
  gateKey: string,
  now: Date = new Date(),
): string | null {
  const key = requireGateKey(gateKey);
  const entry = readQuarantineState()[key];
  const until = activeQuarantine(entry, now.getTime());
  return until
    ? `Гейт «${key}» в карантине до ${until}: результаты нестабильны, повторите позже.`
    : null;
}

/** Снимок карантинов для отчёта (с пометкой истёкших). */
export function listGateQuarantines(now: Date = new Date()): {
  gateKey: string;
  flakeCount: number;
  quarantinedUntil: string | null;
  expired: boolean;
}[] {
  const state = readQuarantineState();
  return Object.keys(state).map((gateKey) => {
    const entry = state[gateKey];
    const active = activeQuarantine(entry, now.getTime());
    return {
      gateKey,
      flakeCount: entry.flakeCount,
      quarantinedUntil: entry.quarantinedUntil,
      expired: !active && Boolean(entry.quarantinedUntil),
    };
  });
}
