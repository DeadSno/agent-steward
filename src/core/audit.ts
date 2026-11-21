import { getDb } from "../db/index.js";
import { redactSecretsInText } from "./secrets.js";
import {
  resolvePermissions,
  checkEgress,
  normalizeEgressPolicy,
  runWithEgressDecision,
  type EgressDecision,
  type EgressPolicy,
  type EgressGuardedResult,
  type PermissionPolicy,
} from "./permissions.js";

/**
 * Журнал аудита мутаций (Спринт 26).
 *
 * Фиксирует кто, когда и через какой интерфейс создал / изменил / запустил /
 * удалил задачу или настройки. Записи лежат в SQLite рядом с историей, поэтому
 * аудит не зависит от файловых логов и переживает перезапуск. Любая ошибка
 * записи проглатывается: аудит не должен ломать основную операцию.
 */

export type AuditActor = "mcp" | "gui" | "http" | "system" | string;

export interface AuditEntryInput {
  action: string;
  targetType?: string | null;
  target?: string | null;
  actor: AuditActor;
  /** Конкретный инструмент / RPC-метод / HTTP-маршрут. */
  source?: string | null;
  details?: unknown;
  remote?: string | null;
  /** Время события (ISO). По умолчанию — сейчас. */
  ts?: string;
}

export interface AuditRecord {
  id: number;
  ts: string;
  action: string;
  targetType: string | null;
  target: string | null;
  actor: string;
  source: string | null;
  details: unknown;
  remote: string | null;
}

export interface ReadAuditFilter {
  action?: string;
  target?: string;
  actor?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ReadAuditResult {
  records: AuditRecord[];
  total: number;
}

export const DEFAULT_AUDIT_RETENTION_DAYS = 90;
export const DEFAULT_AUDIT_MAX_RECORDS = 10_000;

const SENSITIVE_KEY_RE = /(TOKEN|SECRET|PASS|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH)/i;
const PURE_SECRET_REF_RE = /^\$\{secret:[A-Za-z0-9_.-]{1,64}\}$/;

function looksLikeSecretRef(value: string): boolean {
  return PURE_SECRET_REF_RE.test(value.trim());
}

/** Рекурсивно вычищает секреты из произвольной структуры details. */
export function redactAuditDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactSecretsInText(value);
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactAuditDetails(item, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      SENSITIVE_KEY_RE.test(key) &&
      !looksLikeSecretRef(item)
    ) {
      result[key] = "***";
    } else {
      result[key] = redactAuditDetails(item, depth + 1);
    }
  }
  return result;
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(redactAuditDetails(value));
  } catch {
    return null;
  }
}

let lastCleanupAt = 0;

/**
 * Записывает событие аудита. Никогда не бросает исключение.
 * Возвращает id записи или null при ошибке.
 */
export function recordAudit(entry: AuditEntryInput): number | null {
  try {
    const ts = entry.ts ?? new Date().toISOString();
    const result = getDb()
      .prepare(
        `INSERT INTO audit_log
           (ts, action, target_type, target, actor, source, details_json, remote)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        String(entry.action || "unknown").slice(0, 128),
        entry.targetType == null ? null : String(entry.targetType).slice(0, 64),
        entry.target == null ? null : String(entry.target).slice(0, 256),
        String(entry.actor || "system").slice(0, 32),
        entry.source == null ? null : String(entry.source).slice(0, 128),
        safeJson(entry.details),
        entry.remote == null ? null : String(entry.remote).slice(0, 128),
      );
    maybeCleanup();
    return Number(result.lastInsertRowid) || null;
  } catch (err) {
    try {
      console.warn(
        `[audit] не удалось записать событие: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } catch {
      // console недоступен — молча игнорируем.
    }
    return null;
  }
}

/**
 * Ленивая ротация: не чаще раза в час, лимиты по умолчанию. Точные лимиты из
 * settings применяются в cleanupHistory / manage_settings.
 */
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanupAt < 60 * 60 * 1000) return;
  lastCleanupAt = now;
  try {
    cleanupAuditLog({
      retentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
      maxRecords: DEFAULT_AUDIT_MAX_RECORDS,
    });
  } catch {
    // очистка не критична
  }
}

function rowToRecord(row: any): AuditRecord {
  let details: unknown = null;
  if (row.details_json) {
    try {
      details = JSON.parse(String(row.details_json));
    } catch {
      details = String(row.details_json);
    }
  }
  return {
    id: Number(row.id),
    ts: String(row.ts),
    action: String(row.action),
    targetType: row.target_type == null ? null : String(row.target_type),
    target: row.target == null ? null : String(row.target),
    actor: String(row.actor ?? "system"),
    source: row.source == null ? null : String(row.source),
    details,
    remote: row.remote == null ? null : String(row.remote),
  };
}

export interface ToolBlockedInput {
  /** Имя задачи, для которой действует запрет. */
  task: string;
  /** Заблокированный инструмент (например, shell или write). */
  tool: string;
  actor?: AuditActor;
  source?: string | null;
  /** Дополнительные детали события; можно переопределить/дополнить. */
  details?: Record<string, unknown>;
}

/**
 * Записывает событие tool.blocked для задачи и инструмента.
 *
 * Детали события — обычный объект, поэтому вызывающая сторона может добавить
 * причину, список разрешённых инструментов и любые другие поля.
 * Возвращает id записи или null, если журнал недоступен.
 */
export function recordToolBlocked(input: ToolBlockedInput): number | null {
  return recordAudit({
    action: "tool.blocked",
    targetType: "task",
    target: input.task,
    actor: input.actor ?? "system",
    source: input.source ?? "policy",
    details: { tool: input.tool, ...(input.details ?? {}) },
  });
}

/**
 * Фиксирует запреты задачи из её политики allowedTools/deniedTools.
 *
 * Явно запрещённые инструменты попадают в аудит по одному событию на
 * инструмент. Для режима «только разрешённые» пишется одно событие с
 * инструментом `*`, потому что список заблокированных в этом режиме
 * неограничен. Возвращает число записанных событий.
 */
export function recordTaskToolBlocks(
  task: string,
  allowedTools: readonly string[] | null | undefined,
  deniedTools: readonly string[] | null | undefined,
  actor: AuditActor = "system",
  source = "policy",
  policy?: PermissionPolicy,
  legacyShell?: boolean,
): number {
  const normalizedDenied = Array.from(
    new Set(
      (deniedTools ?? [])
        .map((tool) => String(tool).trim())
        .filter(Boolean),
    ),
  );
  const normalizedAllowed = Array.from(
    new Set(
      (allowedTools ?? [])
        .map((tool) => String(tool).trim())
        .filter(Boolean),
    ),
  );
  const details = {
    reason: "deniedTools",
    allowedTools: normalizedAllowed.length > 0 ? normalizedAllowed : null,
    deniedTools: normalizedDenied.length > 0 ? normalizedDenied : null,
  };
  let written = 0;
  for (const tool of normalizedDenied) {
    if (recordToolBlocked({ task, tool, actor, source, details }) != null) {
      written++;
    }
  }
  if (normalizedDenied.length === 0 && normalizedAllowed.length > 0) {
    if (
      recordToolBlocked({
        task,
        tool: "*",
        actor,
        source,
        details: {
          reason: "allowedTools",
          allowedTools: normalizedAllowed,
          deniedTools: null,
        },
      }) != null
    ) {
      written++;
    }
  }
  // Спринт 32 / релиз 1.6: фиксируем инструменты, запрещённые политикой по
  // умолчанию (hybrid: shell/question; secure: ещё edit/webfetch/websearch/
  // subagent). Это политика на момент сохранения задачи, а не попытки вызова:
  // detached-обёртка не имеет доступа к SQLite.
  if (policy) {
    const effective = resolvePermissions({
      policy,
      legacyShell,
      allowedTools: normalizedAllowed,
      deniedTools: normalizedDenied,
    });
    for (const denied of effective.deniedByPolicy) {
      if (
        recordToolBlocked({
          task,
          tool: denied.action,
          actor,
          source,
          details: {
            reason: "default-policy",
            policy: effective.policy,
            legacyShell: effective.legacyShell,
            hint: denied.hint,
            allowedTools: normalizedAllowed.length > 0 ? normalizedAllowed : null,
            deniedTools: normalizedDenied.length > 0 ? normalizedDenied : null,
          },
        }) != null
      ) {
        written++;
      }
    }
  }
  return written;
}

/* ─── ARCH-6.1 / ARCH-6.2: аудит egress-попыток и деградация раннера ──────── */

export const EGRESS_ALLOWED_ACTION = "egress.allowed";
export const EGRESS_BLOCKED_ACTION = "egress.blocked";

export interface EgressAttemptInput {
  /** Задача, от имени которой происходит выход. */
  task: string;
  /** URL, `host:port` или «голый» хост назначения. */
  destination: string;
  /** Whitelist из scoped-конфига; null/undefined = fail-open (старое поведение). */
  policy?: EgressPolicy | readonly string[] | string | null;
  actor?: AuditActor;
  source?: string | null;
}

/** Решение egress-политики плюс id аудитной записи. */
export interface EgressAttemptResult extends EgressDecision {
  auditId: number | null;
}

/**
 * ARCH-6.1: аудит КАЖДОЙ попытки выхода — разрешённой и заблокированной —
 * с указанием причины. Запись идемпотентна по решению: один вызов = одна
 * запись `egress.allowed` или `egress.blocked`. Ошибка журнала проглатывается
 * `recordAudit`, поэтому аудит не ломает сам выход.
 */
export function recordEgressAttempt(input: EgressAttemptInput): EgressAttemptResult {
  const decision = checkEgress(input.policy ?? null, input.destination);
  const normalized = normalizeEgressPolicy(input.policy ?? null);
  const auditId = recordAudit({
    action: decision.allowed ? EGRESS_ALLOWED_ACTION : EGRESS_BLOCKED_ACTION,
    targetType: "task",
    target: input.task,
    actor: input.actor ?? "system",
    source: input.source ?? "egress",
    details: {
      destination: input.destination,
      host: decision.host,
      reason: decision.reason,
      detail: decision.detail,
      allowed: decision.allowed,
      degraded: decision.degraded,
      policyConfigured: decision.policyConfigured,
      allowedHosts: normalized?.allowedHosts ?? null,
      allowedApis: normalized?.allowedApis ?? null,
    },
  });
  return { ...decision, auditId };
}

/**
 * Execute-path guard с аудитом: попытка фиксируется ДО действия, действие
 * выполняется только при разрешённом выходе. При блоке `ok=false`,
 * `status="degraded"` — раннер не может сообщить об успехе тихо.
 */
export async function runEgressGuardedWithAudit<T>(
  input: EgressAttemptInput,
  action: (destination: string) => T | Promise<T>,
): Promise<EgressGuardedResult<T> & { auditId: number | null }> {
  const attempt = recordEgressAttempt(input);
  const result = await runWithEgressDecision(attempt, input.destination, action);
  return { ...result, decision: attempt, auditId: attempt.auditId };
}

export type EgressRunStatus = "ok" | "degraded";

/** ARCH-6.2: честный свод статуса/отчёта раннера по egress-попыткам шага. */
export interface EgressRunSummary {
  /** false, если была хотя бы одна заблокированная попытка. */
  success: boolean;
  status: EgressRunStatus;
  degraded: boolean;
  attempts: number;
  allowed: number;
  blocked: number;
  reason: string;
  report: string;
}

/**
 * ARCH-6.2: «сеть закрыта → деградация без тихого успеха». Любой отказ
 * превращается в `status="degraded"`, `success=false` и строку отчёта с
 * причиной; при отсутствии отказов сохраняется обычный успешный исход.
 */
export function summarizeEgressRun(attempts: readonly EgressAttemptResult[]): EgressRunSummary {
  const blocked = attempts.filter((attempt) => !attempt.allowed);
  const degraded = blocked.length > 0;
  const reasons = blocked.map(
    (attempt) => `${attempt.host ?? "?"}: ${attempt.reason} — ${attempt.detail}`,
  );
  const report = degraded
    ? `деградация: egress заблокирован (${blocked.length}/${attempts.length}); ${reasons.join("; ")}`
    : `egress-попыток ${attempts.length}, все разрешены`;
  return {
    success: !degraded,
    status: degraded ? "degraded" : "ok",
    degraded,
    attempts: attempts.length,
    allowed: attempts.length - blocked.length,
    blocked: blocked.length,
    reason: degraded ? reasons.join("; ") : "no-policy-or-all-allowed",
    report,
  };
}

/**
 * QA-P3.1: единообразная проверка ISO-дат для фильтров аудита.
 * Возвращает текст ошибки или null — чтобы все вызывающие (MCP, RPC, HTTP)
 * отвечали одинаково, а не молча отдавали пустую выборку.
 */
export function auditDateFilterError(
  value: string | null | undefined,
  name: "since" | "until",
): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (Number.isNaN(Date.parse(trimmed))) {
    return `Некорректный параметр ${name}: ожидается ISO-дата.`;
  }
  return null;
}

/** Читает журнал аудита (новые сверху). */
export function readAuditLog(filter: ReadAuditFilter = {}): ReadAuditResult {
  for (const [name, value] of [
    ["since", filter.since],
    ["until", filter.until],
  ] as const) {
    const dateError = auditDateFilterError(value, name);
    if (dateError) throw new Error(dateError);
  }
  const limit = Math.max(1, Math.min(5000, Math.floor(filter.limit ?? 200) || 200));
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.action?.trim()) {
    where.push("action = ?");
    params.push(filter.action.trim());
  }
  if (filter.target?.trim()) {
    where.push("target = ?");
    params.push(filter.target.trim());
  }
  if (filter.actor?.trim()) {
    where.push("actor = ?");
    params.push(filter.actor.trim());
  }
  if (filter.since?.trim()) {
    where.push("ts >= ?");
    params.push(filter.since.trim());
  }
  if (filter.until?.trim()) {
    where.push("ts <= ?");
    params.push(filter.until.trim());
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const db = getDb();
    const totalRow = db
      .prepare(`SELECT COUNT(*) AS count FROM audit_log ${clause}`)
      .get(...params);
    const rows = db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT ?`)
      .all(...params, limit);
    return { records: rows.map(rowToRecord), total: Number(totalRow?.count) || 0 };
  } catch (err) {
    try {
      console.warn(
        `[audit] не удалось прочитать журнал: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } catch {
      // ignore
    }
    return { records: [], total: 0 };
  }
}

/**
 * Удаляет старые записи и лишние сверх maxRecords.
 * Возвращает количество удалённых строк.
 */
export function cleanupAuditLog(options: {
  retentionDays?: number;
  maxRecords?: number;
} = {}): number {
  const retentionDays = Math.max(
    0,
    Math.floor(options.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS) || 0,
  );
  const maxRecords = Math.max(
    100,
    Math.floor(options.maxRecords ?? DEFAULT_AUDIT_MAX_RECORDS) || DEFAULT_AUDIT_MAX_RECORDS,
  );
  let deleted = 0;
  try {
    const db = getDb();
    if (retentionDays > 0) {
      const cutoff = new Date(
        Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      const result = db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
      deleted += Number(result.changes) || 0;
    }
    const countRow = db.prepare("SELECT COUNT(*) AS count FROM audit_log").get();
    const count = Number(countRow?.count) || 0;
    if (count > maxRecords) {
      const excess = count - maxRecords;
      const result = db
        .prepare(
          `DELETE FROM audit_log WHERE id IN (
             SELECT id FROM audit_log ORDER BY ts ASC, id ASC LIMIT ?
           )`,
        )
        .run(excess);
      deleted += Number(result.changes) || 0;
    }
  } catch (err) {
    try {
      console.warn(
        `[audit] не удалось очистить журнал: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } catch {
      // ignore
    }
  }
  return deleted;
}

/** Удаляет все записи (тесты / обслуживание). */
export function clearAuditLog(): void {
  try {
    getDb().exec("DELETE FROM audit_log");
  } catch {
    // ignore
  }
}

/** Сбрасывает троттлинг очистки (для тестов). */
export function resetAuditCleanupThrottle(): void {
  lastCleanupAt = 0;
}
