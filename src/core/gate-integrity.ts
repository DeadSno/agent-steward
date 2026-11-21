/**
 * G-1.2: проверяемый snapshot входов Quality Gate.
 *
 * Обёртка фиксирует хэш команды/хука гейта, промпта и таймаута в момент
 * создания задачи (файл лежит в PLUGIN_DIR, вне write-scope агента) и
 * сверяет его непосредственно перед запуском гейта. Подмена гейта или
 * промпта после создания задачи приводит к fail-closed: гейт не выполняется,
 * запуск помечается ошибкой. Snapshot защищает от подмены *definition*
 * гейта; исходники, которые гейт проверяет, в хэш не входят (агент
 * legitimately меняет их в ходе задачи).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../db/index.js";
import { recordGateOutcome, type GateVerdictValue } from "../db/runs-repo.js";
import { recordAudit } from "./audit.js";
import { PLUGIN_DIR, sanitizeName } from "../types.js";

export const GATE_SNAPSHOT_VERSION = 1;
export const GATE_SNAPSHOT_DIR = path.join(PLUGIN_DIR, "gate-snapshots");

export interface GateSnapshotInputs {
  /** Текст гейта: на Windows — содержимое hook-файла, на POSIX — команда. */
  gate: string;
  /** Текст промпта задачи. */
  prompt: string;
  /** Таймаут гейта в секундах. */
  gateTimeoutSeconds: number;
}

export interface GateSnapshot {
  version: number;
  taskName: string;
  createdAt: string;
  hash: string;
}

/** Канонический хэш входов гейта. Порядок полей фиксирован контрактом. */
export function gateInputsHash(inputs: GateSnapshotInputs): string {
  const canonical = JSON.stringify({
    version: GATE_SNAPSHOT_VERSION,
    gate: inputs.gate,
    prompt: inputs.prompt,
    gateTimeoutSeconds: inputs.gateTimeoutSeconds,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Путь snapshot'а задачи — вне рабочей директории задачи. */
export function gateSnapshotPath(taskName: string): string {
  const segment = sanitizeName(taskName).slice(0, 80) || "task";
  return path.join(GATE_SNAPSHOT_DIR, `${segment}.json`);
}

function readText(file: string | undefined): string {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Пишет snapshot задачам на этапе создания обёртки (fail-closed при ошибке). */
export function createGateSnapshot(
  taskName: string,
  inputs: GateSnapshotInputs,
  snapshotFile = gateSnapshotPath(taskName),
): string {
  const snapshot: GateSnapshot = {
    version: GATE_SNAPSHOT_VERSION,
    taskName,
    createdAt: new Date().toISOString(),
    hash: gateInputsHash(inputs),
  };
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return snapshotFile;
}

export function readGateSnapshot(file: string): GateSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<GateSnapshot>;
    if (value.version !== GATE_SNAPSHOT_VERSION) return null;
    if (typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) return null;
    return {
      version: value.version,
      taskName: typeof value.taskName === "string" ? value.taskName : "",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      hash: value.hash,
    };
  } catch {
    return null;
  }
}

/** Сверяет текущие входы гейта с зафиксированными. При расхождении — fail-closed. */
export function verifyGateSnapshot(
  snapshotFile: string,
  inputs: GateSnapshotInputs,
): { ok: boolean; reason?: string } {
  const snapshot = readGateSnapshot(snapshotFile);
  if (!snapshot) {
    return { ok: false, reason: "snapshot гейта отсутствует или повреждён" };
  }
  const actual = gateInputsHash(inputs);
  const expected = snapshot.hash;
  const same =
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
  if (!same) {
    return { ok: false, reason: "входы Quality Gate изменены с момента создания задачи" };
  }
  return { ok: true };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * PL-25: состояние отслеживаемых исходников на границе прогона.
 *
 * Хэш входов гейта (G-1.2) защищает от подмены самой команды, но не от
 * чужого незакоммиченного кода: параллельная задача может изменить `src/`
 * между стартом runners и post-flight гейтом, и гейт «позеленеет» на
 * уже другом дереве. Фиксируем HEAD + `git status --porcelain` для `src/`.
 */
export interface WorktreeSnapshot {
  version: number;
  head: string;
  status: string;
  capturedAt: string;
}

export const WORKTREE_SNAPSHOT_VERSION = 1;

/** Пути, за которыми следит гейт; по умолчанию только исходники плагина. */
export function worktreeGuardPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_STEWARD_GATE_GUARD_PATHS?.trim();
  if (!raw) return ["src"];
  const parts = raw.split(/[|;]/).map((item) => item.trim()).filter(Boolean);
  return parts.length ? parts : ["src"];
}

/**
 * PL-47: пути, которые задача изменить вправе (обычно из `-Files` afterScript).
 * Исключаются из сравнения со snapshot: агент спокойно правит свои файлы,
 * а чужие правки в остальной части `src/` по-прежнему срывают гейт.
 */
export function worktreeAllowPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_STEWARD_GATE_ALLOW_PATHS?.trim();
  if (!raw) return [];
  return raw
    .split(/[|;]/)
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
}

function pathIsAllowed(relative: string, allowed: string[]): boolean {
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  return allowed.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function gitOutput(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Возвращает null, если каталог не git-репозиторий или git недоступен. */
export function readWorktreeState(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): { head: string; status: string } | null {
  const head = gitOutput(dir, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const status = gitOutput(dir, ["status", "--porcelain", "--untracked-files=no", "--", ...worktreeGuardPaths(env)]);
  if (status === null) return null;
  const allowed = worktreeAllowPaths(env);
  let filtered = status;
  if (allowed.length > 0) {
    filtered = status
      .split("\n")
      .filter((line) => {
        if (line.length < 4) return false;
        const relative = line.slice(3).split(" -> ").pop()?.trim() ?? "";
        return !pathIsAllowed(relative, allowed);
      })
      .join("\n");
  }
  return { head: head.trim(), status: filtered };
}

/** Пишет snapshot дерева; null — не git-репозиторий (гейт не блокируем). */
export function captureWorktreeSnapshot(
  dir: string,
  outFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const state = readWorktreeState(dir, env);
  if (!state) return null;
  const snapshot: WorktreeSnapshot = {
    version: WORKTREE_SNAPSHOT_VERSION,
    ...state,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return outFile;
}

export function readWorktreeSnapshot(file: string): WorktreeSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<WorktreeSnapshot>;
    if (value.version !== WORKTREE_SNAPSHOT_VERSION) return null;
    if (typeof value.head !== "string" || typeof value.status !== "string") return null;
    return {
      version: WORKTREE_SNAPSHOT_VERSION,
      head: value.head,
      status: value.status,
      capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : "",
    };
  } catch {
    return null;
  }
}

/** Сверяет дерево со snapshot'ом, снятым на старте задачи. */
export function verifyWorktreeSnapshot(
  dir: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason?: string } {
  const snapshot = readWorktreeSnapshot(file);
  if (!snapshot) {
    return { ok: false, reason: "snapshot рабочего дерева отсутствует или повреждён" };
  }
  const actual = readWorktreeState(dir, env);
  // Не git-репозиторий: нечего сравнивать, гейт работает по старой схеме.
  if (!actual) return { ok: true };
  if (actual.head !== snapshot.head) {
    return { ok: false, reason: "HEAD изменился с момента старта задачи" };
  }
  if (actual.status !== snapshot.status) {
    const paths = worktreeGuardPaths(env).join(", ");
    return { ok: false, reason: `защищённые пути (${paths}) изменились с момента старта задачи` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * ARCH-4.1/4.2: отложенные внешние эффекты (deferred effects + saga).
 *
 * Идея: эффект объявляется ДО прогона гейта — recordEffectIntents()
 * пишет намерение в ledger gate_outcomes (verdict = "intent"). Ни один
 * apply() не вызывается на этом пути. Реальные побочные действия запускает
 * только applyDeferredEffects() после того, как гейт вернул pass; при падении
 * одного эффекта уже применённые обратимые эффекты откатываются compensate()
 * в обратном порядке (saga). Необратимые эффекты помечаются как таковые
 * и никогда не вызываются до pass и при abort.
 * ------------------------------------------------------------------------- */

/** Обратимость эффекта: reversible требует compensate(), irreversible — нет. */
export type EffectReversibility = "reversible" | "irreversible";

export interface EffectIntent {
  /** Стабильный id для идемпотентности и отчётности. */
  readonly id: string;
  readonly description?: string;
  readonly reversibility: EffectReversibility;
  /** Вызывается ТОЛЬКО после вердикта pass гейта. */
  apply(): void | Promise<void>;
  /** Вызывается только при откате уже применённого обратимого эффекта. */
  compensate?(): void | Promise<void>;
}

export type RecordedEffectStatus =
  | "pending"
  | "applied"
  | "compensated"
  | "compensate_failed"
  | "failed"
  | "aborted";

export interface RecordedEffectIntent {
  id: string;
  description: string;
  reversibility: EffectReversibility;
  status: RecordedEffectStatus;
  appliedAt: string | null;
  compensatedAt: string | null;
  error: string | null;
}

export type EffectSagaStatus = "intent" | "applied" | "compensated" | "aborted" | "failed";

export interface EffectSagaResult {
  outcomeKey: string;
  status: EffectSagaStatus;
  appliedIds: string[];
  compensatedIds: string[];
  irreversibleAppliedIds: string[];
  failedId: string | null;
  reason: string | null;
  effectsAppliedAt: string | null;
  intents: RecordedEffectIntent[];
}

export interface EffectIntentLedger {
  outcomeKey: string;
  runId: string | null;
  stepName: string | null;
  status: EffectSagaStatus;
  intents: RecordedEffectIntent[];
  effectsAppliedAt: string | null;
  reason: string | null;
}

/** Ошибка применения эффектов; результат саги (включая компенсацию) внутри. */
export class EffectSagaError extends Error {
  readonly result: EffectSagaResult;
  constructor(result: EffectSagaResult) {
    super(result.reason ?? "применение отложенных эффектов завершилось ошибкой");
    this.name = "EffectSagaError";
    this.result = result;
  }
}

export interface RecordEffectIntentsOptions {
  runId: string;
  stepName: string;
  stepId?: string | null;
  taskName?: string | null;
  attempt?: number;
  intents: readonly EffectIntent[];
  evidencePath?: string | null;
}

function effectErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Проверяет контракт саги до любой записи в БД и доبية вызовов apply. */
function validatedIntents(intents: readonly EffectIntent[]): EffectIntent[] {
  const seen = new Set<string>();
  const result: EffectIntent[] = [];
  for (const intent of intents) {
    if (!intent || typeof intent.id !== "string" || intent.id.trim() === "") {
      throw new Error("ARCH-4: у эффекта должен быть непустой id.");
    }
    if (seen.has(intent.id)) {
      throw new Error(`ARCH-4: дублирующийся id эффекта: ${intent.id}.`);
    }
    seen.add(intent.id);
    if (typeof intent.apply !== "function") {
      throw new Error(`ARCH-4: у эффекта ${intent.id} нет функции apply().`);
    }
    if (intent.reversibility !== "reversible" && intent.reversibility !== "irreversible") {
      throw new Error(`ARCH-4: неверная reversibility у эффекта ${intent.id}.`);
    }
    if (intent.reversibility === "reversible" && typeof intent.compensate !== "function") {
      throw new Error(`ARCH-4: обратимый эффект ${intent.id} обязан иметь compensate().`);
    }
    result.push(intent);
  }
  return result;
}

function snapshotIntent(intent: EffectIntent): RecordedEffectIntent {
  return {
    id: intent.id,
    description: intent.description ?? intent.id,
    reversibility: intent.reversibility,
    status: "pending",
    appliedAt: null,
    compensatedAt: null,
    error: null,
  };
}

/** Идемпотентный ключ намерения: отдельная строка от вердиктов pass/fail. */
export function effectIntentKey(runId: string, stepName: string, attempt = 1): string {
  return `${runId}:${stepName}:intent:${Math.max(1, Math.floor(attempt))}`;
}

/** Читает записанное намерение и текущий статус саги (null, если строки нет). */
export function readEffectIntentLedger(outcomeKey: string): EffectIntentLedger | null {
  const row = getDb()
    .prepare(
      `SELECT outcome_key, run_id, step_name, effect_intents, effects_applied_at,
              effects_status, effects_reason
         FROM gate_outcomes WHERE outcome_key = ?`,
    )
    .get(outcomeKey) as
    | {
        outcome_key: string;
        run_id: string | null;
        step_name: string | null;
        effect_intents: string | null;
        effects_applied_at: string | null;
        effects_status: string | null;
        effects_reason: string | null;
      }
    | undefined;
  if (!row?.effect_intents) return null;
  let intents: RecordedEffectIntent[];
  try {
    const parsed: unknown = JSON.parse(row.effect_intents);
    if (!Array.isArray(parsed)) return null;
    intents = parsed as RecordedEffectIntent[];
  } catch {
    return null;
  }
  return {
    outcomeKey: row.outcome_key,
    runId: row.run_id,
    stepName: row.step_name,
    status: (row.effects_status as EffectSagaStatus | null) ?? "intent",
    intents,
    effectsAppliedAt: row.effects_applied_at ?? null,
    reason: row.effects_reason ?? null,
  };
}

/** Все намерения в ledger (опционально — только для запуска). */
export function listEffectIntents(runId?: string): EffectIntentLedger[] {
  const rows = getDb()
    .prepare(
      `SELECT outcome_key FROM gate_outcomes
        WHERE effect_intents IS NOT NULL ${runId ? "AND run_id = ?" : ""}
        ORDER BY id`,
    )
    .all(...(runId ? [runId] : [])) as { outcome_key: string }[];
  return rows
    .map((row) => readEffectIntentLedger(row.outcome_key))
    .filter((ledger): ledger is EffectIntentLedger => ledger !== null);
}

function writeSagaLedger(
  outcomeKey: string,
  intents: RecordedEffectIntent[],
  status: EffectSagaStatus,
  appliedAt: string | null,
  reason: string | null,
): void {
  getDb()
    .prepare(
      `UPDATE gate_outcomes
          SET effect_intents = ?, effects_applied_at = ?, effects_status = ?, effects_reason = ?
        WHERE outcome_key = ?`,
    )
    .run(JSON.stringify(intents), appliedAt, status, reason, outcomeKey);
}

function resultFromLedger(ledger: EffectIntentLedger): EffectSagaResult {
  return {
    outcomeKey: ledger.outcomeKey,
    status: ledger.status,
    appliedIds: ledger.intents.filter((intent) => intent.status === "applied").map((intent) => intent.id),
    compensatedIds: ledger.intents
      .filter((intent) => intent.status === "compensated")
      .map((intent) => intent.id),
    irreversibleAppliedIds: ledger.intents
      .filter(
        (intent) =>
          intent.reversibility === "irreversible" && intent.status === "applied",
      )
      .map((intent) => intent.id),
    failedId: ledger.intents.find((intent) => intent.status === "failed")?.id ?? null,
    reason: ledger.reason,
    effectsAppliedAt: ledger.effectsAppliedAt,
    intents: ledger.intents,
  };
}

/**
 * ARCH-4.1: фиксирует намерения ДО прогона гейта. Ни один apply() не вызывается.
 * Повторный вызов с тем же ключом идемпотентен и не перезаписывает более
 * поздний статус (applied/aborted/compensated).
 */
export function recordEffectIntents(options: RecordEffectIntentsOptions): string {
  const intents = validatedIntents(options.intents);
  const attempt = Math.max(1, Math.floor(options.attempt ?? 1));
  const outcomeKey = effectIntentKey(options.runId, options.stepName, attempt);
  if (readEffectIntentLedger(outcomeKey)) return outcomeKey;

  recordGateOutcome({
    outcomeKey,
    missionId: options.taskName ?? null,
    runId: options.runId,
    stepId: options.stepId ?? null,
    stepName: options.stepName,
    taskType: null,
    triggerKind: "effect-intent",
    // Ledger хранит произвольный текст; 'intent' не входит в набор вердиктов
    // гейта, но участвует в hash-цепочке наравне с любым другим verdict.
    verdict: "intent" as unknown as GateVerdictValue,
    attemptsToPass: attempt,
    firstPass: false,
    evidencePath: options.evidencePath ?? null,
  });
  writeSagaLedger(outcomeKey, intents.map(snapshotIntent), "intent", null, null);
  recordAudit({
    action: "effect_intents.recorded",
    targetType: "gate_outcome",
    target: outcomeKey,
    actor: "saga",
    source: "execution",
    details: {
      runId: options.runId,
      stepName: options.stepName,
      intents: intents.map((intent) => ({
        id: intent.id,
        reversibility: intent.reversibility,
        description: intent.description ?? intent.id,
      })),
    },
  });
  return outcomeKey;
}

/**
 * ARCH-4.1/4.2: применяет эффекты ТОЛЬКО после вердикта pass гейта.
 * При падении одного эффекта откатывает уже применённые обратимые эффекты
 * в обратном порядке и бросает {@link EffectSagaError} с результатом.
 */
export async function applyDeferredEffects(
  outcomeKey: string,
  intents: readonly EffectIntent[],
): Promise<EffectSagaResult> {
  const ledger = readEffectIntentLedger(outcomeKey);
  if (!ledger) {
    throw new Error(`ARCH-4: нет записанных намерений для ${outcomeKey}.`);
  }
  if (ledger.status === "applied") return resultFromLedger(ledger);
  if (ledger.status !== "intent") {
    throw new Error(`ARCH-4: эффекты ${outcomeKey} уже в статусе ${ledger.status}.`);
  }

  const declared = validatedIntents(intents);
  const recordedIds = ledger.intents.map((intent) => intent.id).join("\u0000");
  const declaredIds = declared.map((intent) => intent.id).join("\u0000");
  if (recordedIds !== declaredIds) {
    throw new Error("ARCH-4: набор эффектов отличается от записанного намерения.");
  }

  const state = ledger.intents.map((intent) => ({ ...intent }));
  let failureReason: string | null = null;
  let failedId: string | null = null;
  for (const intent of declared) {
    try {
      await intent.apply();
    } catch (error) {
      failedId = intent.id;
      failureReason = `${intent.id}: ${effectErrorMessage(error)}`;
      const entry = state.find((item) => item.id === intent.id);
      if (entry) {
        entry.status = "failed";
        entry.error = failureReason;
      }
      break;
    }
    const entry = state.find((item) => item.id === intent.id);
    if (entry) {
      entry.status = "applied";
      entry.appliedAt = nowIso();
    }
  }

  if (!failedId) {
    const appliedAt = nowIso();
    writeSagaLedger(outcomeKey, state, "applied", appliedAt, null);
    recordAudit({
      action: "effects.applied",
      targetType: "gate_outcome",
      target: outcomeKey,
      actor: "saga",
      source: "execution",
      details: {
        effectsAppliedAt: appliedAt,
        appliedIds: state.map((intent) => intent.id),
        irreversibleAppliedIds: state
          .filter((intent) => intent.reversibility === "irreversible")
          .map((intent) => intent.id),
      },
    });
    return resultFromLedger(readEffectIntentLedger(outcomeKey)!);
  }

  // Saga-компенсация: только обратимые и только уже успешно применённые.
  const compensatedIds: string[] = [];
  const compensationErrors: string[] = [];
  for (const intent of [...declared].reverse()) {
    if (intent.id === failedId) continue;
    const entry = state.find((item) => item.id === intent.id);
    if (entry?.status !== "applied") continue;
    if (intent.reversibility !== "reversible") continue;
    try {
      await intent.compensate?.();
      entry.status = "compensated";
      entry.compensatedAt = nowIso();
      compensatedIds.push(intent.id);
    } catch (error) {
      entry.status = "compensate_failed";
      entry.error = effectErrorMessage(error);
      compensationErrors.push(`${intent.id}: ${effectErrorMessage(error)}`);
    }
  }

  const irreversibleRemaining = state
    .filter((intent) => intent.reversibility === "irreversible" && intent.status === "applied")
    .map((intent) => intent.id);
  const status: EffectSagaStatus =
    compensationErrors.length > 0 || irreversibleRemaining.length > 0 ? "failed" : "compensated";
  const reasonParts = [failureReason ?? "применение эффекта прервано"];
  if (compensatedIds.length > 0) reasonParts.push(`откачены: ${compensatedIds.join(", ")}`);
  if (irreversibleRemaining.length > 0) {
    reasonParts.push(
      `необратимые эффекты остались применены: ${irreversibleRemaining.join(", ")}`,
    );
  }
  if (compensationErrors.length > 0) {
    reasonParts.push(`ошибки компенсации: ${compensationErrors.join("; ")}`);
  }
  const reason = reasonParts.join("; ");
  writeSagaLedger(outcomeKey, state, status, null, reason);
  recordAudit({
    action: status === "compensated" ? "effects.compensated" : "effects.apply_failed",
    targetType: "gate_outcome",
    target: outcomeKey,
    actor: "saga",
    source: "execution",
    details: { status, failedId, compensatedIds, irreversibleRemaining, reason },
  });
  throw new EffectSagaError(resultFromLedger(readEffectIntentLedger(outcomeKey)!));
}

/**
 * ARCH-4.1: гейт не прошёл — эффекты НЕ применяются вообще. Статус и причина
 * пишутся в ledger/аудит, все намерения переводятся в 'aborted'.
 */
export function abortDeferredEffects(outcomeKey: string, reason: string): EffectSagaResult | null {
  const ledger = readEffectIntentLedger(outcomeKey);
  if (!ledger) return null;
  if (ledger.status !== "intent") return resultFromLedger(ledger);
  const state = ledger.intents.map((intent) => ({
    ...intent,
    status: "aborted" as const,
    error: reason,
  }));
  writeSagaLedger(outcomeKey, state, "aborted", null, reason);
  recordAudit({
    action: "effects.aborted",
    targetType: "gate_outcome",
    target: outcomeKey,
    actor: "saga",
    source: "execution",
    details: { status: "aborted", reason },
  });
  return resultFromLedger(readEffectIntentLedger(outcomeKey)!);
}

/**
 * CLI для обёрток: `node gate-integrity.js verify --snapshot <file>
 * --gate-file <file> | --gate-command <text> --prompt-file <file> --timeout <n>`.
 * exit 0 — входы совпадают, exit 1 — расхождение/отсутствие snapshot'а.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "worktree-snapshot") {
    const dir = optionValue(argv, "--dir");
    const outFile = optionValue(argv, "--out");
    if (!dir || !outFile) {
      console.error("gate-integrity: worktree-snapshot требует --dir и --out");
      return 2;
    }
    const allow = optionValue(argv, "--allow");
    captureWorktreeSnapshot(dir, outFile, allow ? { ...process.env, AGENT_STEWARD_GATE_ALLOW_PATHS: allow } : process.env);
    return 0;
  }
  if (argv[0] === "worktree-verify") {
    const dir = optionValue(argv, "--dir");
    const file = optionValue(argv, "--snapshot");
    if (!dir || !file) {
      console.error("gate-integrity: worktree-verify требует --dir и --snapshot");
      return 2;
    }
    const allow = optionValue(argv, "--allow");
    const result = verifyWorktreeSnapshot(
      dir,
      file,
      allow ? { ...process.env, AGENT_STEWARD_GATE_ALLOW_PATHS: allow } : process.env,
    );
    if (!result.ok) {
      console.error(`gate-integrity: ${result.reason ?? "рабочее дерево изменилось"}`);
      return 1;
    }
    return 0;
  }
  if (argv[0] !== "verify") {
    console.error("gate-integrity: поддерживаются verify, worktree-snapshot, worktree-verify");
    return 2;
  }
  const snapshotFile = optionValue(argv, "--snapshot");
  if (!snapshotFile) {
    console.error("gate-integrity: не задан --snapshot");
    return 2;
  }
  const gateFile = optionValue(argv, "--gate-file");
  const gateCommand = optionValue(argv, "--gate-command");
  const gate = gateFile ? readText(gateFile) : gateCommand ?? "";
  const timeoutRaw = Number(optionValue(argv, "--timeout") ?? 300);
  const inputs: GateSnapshotInputs = {
    gate,
    prompt: readText(optionValue(argv, "--prompt-file")),
    gateTimeoutSeconds: Number.isFinite(timeoutRaw) ? timeoutRaw : 300,
  };
  const result = verifyGateSnapshot(snapshotFile, inputs);
  if (!result.ok) {
    console.error(`gate-integrity: ${result.reason ?? "проверка целостности не пройдена"}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
