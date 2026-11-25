/**
 * Система самоанализа для планировщика OpenCode (Спринт 32).
 *
 * Анализирует здоровье системы, выявляет аномалии, тренды и генерирует
 * рекомендации по оптимизации на основе исторических данных.
 */
import {
  buildAnalytics,
  type AnalyticsRecord,
  type AnalyticsReport,
} from "./analytics.js";
import { t } from "../i18n.js";
import { createHash } from "node:crypto";
import type { GateLedgerVerification } from "./audit.js";
import type { GateOutcomeContent, GateOutcomeRecord } from "../db/runs-repo.js";
import { computeSavings, type SavingsRecord } from "./savings.js";

// ==================== Типы ====================

/** Оценка здоровья системы (0-100). */
export interface HealthScore {
  /** Итоговый балл (0-100). */
  score: number;
  /** Описание уровня здоровья. */
  level: "excellent" | "good" | "fair" | "poor" | "critical";
  /**
   * Детальные метрики, из которых сложился балл.
   *
   * ВАЖНО (QA 2026-11-19, roadmap-qa-01; уточнено QA-P1.4): successRate/errorRate —
   * это НОРМАЛИЗОВАННЫЕ БАЛЛЫ 0..100 (чем выше, тем лучше; обратная совместимость
   * с self_analysis tool), а avgDurationMs/timeoutRate/crashRecoveryRate —
   * РЕАЛЬНЫЕ значения из отчёта (мс и доли 0..1), ранее сюда ошибочно писались
   * score-значения, из-за чего avgDurationMs показывал 66 вместо 101597.
   *
   * QA-P1.4: `errorRate` — НЕ доля ошибок, а инвертированный балл
   * `100 - 100 * error / total`. Поэтому при 322 success / 250 error из 573
   * получаются `successRate=56.2` и `errorRate=56.37` — это согласуемые значения:
   * доля ошибок 43.63%, а балл ошибок 56.37. Не путать с `totals.errorRate`,
   * если он когда-либо будет добавлен как реальная доля.
   */
  components: {
    /** Балл успешности 0..100 (нормализованный). */
    successRate: number;
    /** Балл частоты ошибок 0..100 (нормализованный, чем выше, тем меньше ошибок). */
    errorRate: number;
    /** Реальная средняя длительность запуска в мс. */
    avgDurationMs: number;
    /** Реальная доля таймаутов 0..1. */
    timeoutRate: number;
    /** Реальная доля прерванных (crash recovery) запусков 0..1. */
    crashRecoveryRate: number;
    /** Балл длительности 0..100 (нормализованный, использовался в score). */
    avgDurationScore: number;
    /** Балл таймаутов 0..100 (нормализованный). */
    timeoutScore: number;
    /** Балл восстановления после сбоев 0..100 (нормализованный). */
    crashRecoveryScore: number;
  };
  /** Рекомендации по улучшению. */
  recommendations: string[];
}

/** Обнаруженная аномалия. */
export interface Anomaly {
  /** Тип аномалии. */
  type:
    | "error_spike"
    | "duration_spike"
    | "timeout_spike"
    | "cost_spike"
    | "unusual_pattern"
    | "stalled_run";
  /** Серьёзность (0-100). */
  severity: number;
  /** Описание аномалии. */
  description: string;
  /** Затронутые задачи. */
  affectedTasks: string[];
  /** Рекомендуемые действия. */
  recommendations: string[];
  /** Метаданные для детального анализа. */
  metadata: Record<string, unknown>;
}

/** Тренд метрики. */
export interface Trend {
  /** Название метрики. */
  metric: string;
  /** Направление тренда. */
  direction: "improving" | "degrading" | "stable" | "volatile";
  /** Изменение в процентах (положительное = улучшение). */
  changePercent: number;
  /** Описание тренда. */
  description: string;
  /** Рекомендации. */
  recommendations: string[];
}

/** Рекомендация по оптимизации. */
export interface Recommendation {
  /** Приоритет (1-10, где 10 — критический). */
  priority: number;
  /** Категория рекомендации. */
  category:
    | "performance"
    | "reliability"
    | "cost"
    | "scheduling"
    | "monitoring"
    | "security";
  /** Заголовок рекомендации. */
  title: string;
  /** Описание. */
  description: string;
  /** Ожидаемый эффект. */
  expectedImpact: string;
  /** Сложность реализации. */
  effort: "low" | "medium" | "high";
  /** Конкретные шаги. */
  steps: string[];
}

/** Полный отчёт самоанализа. */
export interface SelfAnalysisReport {
  /** Время генерации отчёта. */
  generatedAt: string;
  /** Окно анализа в днях. */
  windowDays: number;
  /** Общий балл здоровья. */
  health: HealthScore;
  /** Обнаруженные аномалии. */
  anomalies: Anomaly[];
  /** Анализ трендов. */
  trends: Trend[];
  /** Рекомендации. */
  recommendations: Recommendation[];
  /** Краткое резюме. */
  summary: string;
  /** Метаданные источников данных (PL-13/PL-29/PL-31: единицы указаны в комментариях). */
  sources: {
    /** Записей истории всего (до фильтрации по окну). */
    historyRecords: number;
    /** Записей истории внутри окна days. */
    recordsInWindow: number;
    /** Число definition задач (НЕ уникальных имён в истории). */
    tasksAnalyzed: number;
    /** Явное имя того же счётчика definition — без двусмысленности «analyzed». */
    taskDefinitions: number;
  };
  /** PL-98: автопроверка tamper-evident цепочки gate_outcomes. */
  gateLedger?: GateLedgerVerification;
}

/** Опции для генерации отчёта самоанализа. */
export interface SelfAnalysisOptions {
  /** Окно анализа в днях (по умолчанию 14). */
  days?: number;
  /** Опорный момент (для тестов). */
  now?: Date;
  /** Сколько строк оставлять в топах (по умолчанию 10). */
  topLimit?: number;
  /** Известные задачи. */
  tasks?: { name: string; matrixParentId?: string | null }[];
}

// ==================== EV-1: воспроизводимая приёмка §11 ====================

/** Строка ledger, пригодная для приёмки (без привязки к конкретной версии записи). */
export type AcceptanceGateRow = GateOutcomeContent | GateOutcomeRecord;

/** Метка стабильности кейса фикс-набора. */
export type AcceptanceLabel = "stable_pass" | "stable_fail" | "unstable";

/** Версия формата фикс-набора — меняется при изменении правил отбора/меток. */
export const ACCEPTANCE_DATASET_VERSION = "1.0";

/** Версия формата метрик приёмки. */
export const ACCEPTANCE_METRICS_VERSION = "1.0";

/** Идентификатор machine-readable метрик приёмки. */
export const ACCEPTANCE_FORMAT = "agent-steward.acceptance";

/** Горизонт наблюдаемого окна: 4 недели (CONCEPT §11.7). */
export const ACCEPTANCE_HORIZON_DAYS = 28;

/** Владелец метрик приёмки — фиксируется в EXECUTION-LOOP §9. */
export const ACCEPTANCE_OWNER = "мейнтейнер agent-steward (цикл приёмки §11)";

/** Пороги приёмки и допустимой деградации eval. */
export const ACCEPTANCE_THRESHOLDS = {
  /**
   * Абсолютный пол success_rate, зафиксированный на снимке приёмки
   * 2026-11-25 (0.2593 → 0.25). Основной гейт — сравнение с baseline.
   */
  minSuccessRate: 0.25,
  /** Абсолютный пол first_pass_rate снимка приёмки 2026-11-25 (0.4208 → 0.40). */
  minFirstPassRate: 0.4,
  /** Чистая экономия (оценка по SAVINGS.md) должна быть положительной. */
  minNetEconomyUsd: 0,
  /** Минимальный размер фикс-набора. */
  minDatasetCases: 3,
  /** eval не деградировал: падение не больше 0.02 абс. по долям. */
  maxRateDegradation: 0.02,
  /** Допустимое падение чистой экономии, USD. */
  maxEconomyDegradationUsd: 1,
} as const;

/** Один кейс версионированного фикс-набора. */
export interface AcceptanceCase {
  /** Детерминированный ID из стабильных полей записи (SHA-256, 12 hex). */
  caseId: string;
  taskType: string;
  gateType: string;
  gateHash: string;
  policyHash: string;
  promptHash: string;
  verdict: "pass" | "fail";
  attemptsToPass: number;
  firstPass: number;
  /** Путь к доказательству после маскировки секретов (никогда не сырой текст). */
  evidencePath: string | null;
  executor: string | null;
  routeSource: string | null;
  samples: number;
  passes: number;
  fails: number;
  label: AcceptanceLabel;
}

/** Версионированный фикс-набор, собранный из ledger. */
export interface AcceptanceDataset {
  kind: "acceptance-dataset";
  format: "agent-steward.acceptance-dataset";
  version: string;
  /** Источник — только ledger, не ручной список. */
  source: "gate_outcomes.ledger";
  generatedAt: string;
  horizonDays: number;
  cases: AcceptanceCase[];
  /** Сколько строк ledger отклонено как нестабильные/субъективные. */
  excluded: number;
  rowsConsidered: number;
}

export interface AcceptanceDatasetOptions {
  now?: Date;
  /** Минимум повторов для метки «стабильный» (по умолчанию 2). */
  minSamples?: number;
  /** Доля голосов, нужная для стабильной метки (по умолчанию 0.8). */
  stabilityRatio?: number;
  /** Сколько кейсов оставить в отчёте (по умолчанию 50). */
  maxCases?: number;
}

/** Метрики семи критериев §11, вычисленные из ledger + истории запусков. */
export interface AcceptanceMetrics {
  kind: "acceptance-metrics";
  format: typeof ACCEPTANCE_FORMAT;
  version: string;
  source: "gate_outcomes.ledger";
  generatedAt: string;
  windowDays: number;
  owner: string;
  thresholds: typeof ACCEPTANCE_THRESHOLDS;
  datasetVersion: string;
  sampleSize: number;
  confidence: "low" | "medium" | "high";
  criteria: {
    /** §11.1: ad-hoc с objective-гейтом и доказательством safety. */
    adhocGateSafety: { observed: boolean; samples: number; objectiveWithEvidence: number };
    /** §11.2: local-first маршрутизация. */
    localFirstRouting: { localShare: number; local: number; total: number };
    /** §11.3: объективный гейт, эскалация/откат без тихого провала. */
    objectiveGate: { objectiveShare: number; objective: number; escalations: number; infraFails: number };
    /** §11.4: честная net-экономия и escalation rate. */
    honestEconomy: { netEconomyUsd: number; savedUsd: number; paidCostUsd: number; escalationRate: number };
    /** §11.5: пример из learning-loop реально переиспользован (по routeSource). */
    learningLoopReuse: { reused: number; reuseRate: number };
    /** §11.6: паритет ad-hoc/registered по маршруту и вердикту. */
    parity: { pairs: number; mismatches: number };
    /** §11.7: фикс-набор за N недель с eval без деградации. */
    fixedSet: {
      cases: number;
      stablePass: number;
      stableFail: number;
      successRate: number;
      firstPassRate: number;
      evalNotDegraded: boolean | null;
      weeks: number;
    };
  };
}

export interface AcceptanceMetricsInput {
  rows: readonly AcceptanceGateRow[];
  /** История запусков для честной net-экономии (контрфактика SAVINGS.md). */
  history?: readonly SavingsRecord[];
  days?: number;
  now?: Date;
  datasetOptions?: AcceptanceDatasetOptions;
}

/** Базовая точка для CI-гейта «eval не деградировал». */
export interface AcceptanceBaseline {
  version: string;
  generatedAt?: string;
  successRate: number;
  firstPassRate: number;
  netEconomyUsd: number;
}

/** Результат сравнения текущих метрик с baseline. */
export interface AcceptanceGateResult {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
  baseline: AcceptanceBaseline | null;
  current: { successRate: number; firstPassRate: number; netEconomyUsd: number; cases: number };
  /** Команда отката при нарушении порога. */
  rollback: string;
}

// ==================== Health Score ====================

/** Рассчитывает общий балл здоровья системы. */
export function calculateHealthScore(report: AnalyticsReport): HealthScore {
  const { totals, errors } = report;

  // Реальные метрики (то, что видит пользователь в self_analysis).
  const realAvgDurationMs = totals.avgDurationMs;
  const realTimeoutRate =
    errors.filter((e) => e.message.includes("timeout")).length /
    Math.max(1, totals.total);
  const realCrashRecoveryRate =
    errors.filter((e) => e.message.includes("Прервано")).length /
    Math.max(1, totals.total);

  // Компоненты здоровья — нормализованные баллы 0..100 (обратная совместимость).
  const successRateScore = totals.successRate;
  const errorRateScore = Math.max(0, 100 - (totals.error / Math.max(1, totals.total)) * 100);
  const avgDurationScore = Math.min(100, Math.max(0, 100 - (realAvgDurationMs / 300000) * 100)); // 5 минут = 0 баллов
  const timeoutRateScore = Math.min(100, Math.max(0, 100 - realTimeoutRate * 100));
  const crashRecoveryRateScore = Math.min(100, Math.max(0, 100 - realCrashRecoveryRate * 100));

  // Взвешенная сумма
  const score = Math.round(
    successRateScore * 0.35 +
    errorRateScore * 0.25 +
    avgDurationScore * 0.20 +
    timeoutRateScore * 0.10 +
    crashRecoveryRateScore * 0.10,
  );

  // Уровень здоровья
  let level: HealthScore["level"];
  if (score >= 90) level = "excellent";
  else if (score >= 75) level = "good";
  else if (score >= 60) level = "fair";
  else if (score >= 40) level = "poor";
  else level = "critical";

  // Рекомендации
  const recommendations: string[] = [];
  if (successRateScore < 80) {
    recommendations.push(t("selfAnalysis.rec.successRate"));
  }
  if (errorRateScore < 80) {
    recommendations.push(t("selfAnalysis.rec.errorRate"));
  }
  if (avgDurationScore < 70) {
    recommendations.push(t("selfAnalysis.rec.duration"));
  }
  if (timeoutRateScore < 80) {
    recommendations.push(t("selfAnalysis.rec.timeouts"));
  }
  if (crashRecoveryRateScore < 90) {
    recommendations.push(t("selfAnalysis.rec.crashes"));
  }

  return {
    score,
    level,
    components: {
      successRate: successRateScore,
      errorRate: errorRateScore,
      // Реальные значения (исправление roadmap-qa-01).
      avgDurationMs: realAvgDurationMs,
      timeoutRate: realTimeoutRate,
      crashRecoveryRate: realCrashRecoveryRate,
      // Нормализованные баллы (прежняя семантика этих трёх полей).
      avgDurationScore,
      timeoutScore: timeoutRateScore,
      crashRecoveryScore: crashRecoveryRateScore,
    },
    recommendations,
  };
}

// ==================== Anomaly Detection ====================

/** Обнаруживает аномалии в данных. */
export function detectAnomalies(
  records: AnalyticsRecord[],
  options: SelfAnalysisOptions = {},
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const now = options.now ?? new Date();
  const windowDays = options.days ?? 14;

  // Группируем записи по задачам
  const byTask = new Map<string, AnalyticsRecord[]>();
  for (const record of records) {
    const key = record.taskName.toLowerCase();
    if (!byTask.has(key)) byTask.set(key, []);
    byTask.get(key)!.push(record);
  }

  for (const taskRecords of byTask.values()) {
    // 1. Всплеск ошибок
    const errorSpike = detectErrorSpike(taskRecords, windowDays);
    if (errorSpike) anomalies.push(errorSpike);

    // 2. Всплеск длительности
    const durationSpike = detectDurationSpike(taskRecords);
    if (durationSpike) anomalies.push(durationSpike);

    // 3. Всплеск таймаутов
    const timeoutSpike = detectTimeoutSpike(taskRecords);
    if (timeoutSpike) anomalies.push(timeoutSpike);

    // 4. Всплеск стоимости
    const costSpike = detectCostSpike(taskRecords);
    if (costSpike) anomalies.push(costSpike);

    // 5. Необычные паттерны
    const unusualPattern = detectUnusualPattern(taskRecords);
    if (unusualPattern) anomalies.push(unusualPattern);

    // 6. Зависшие запуски
    const stalledRun = detectStalledRun(taskRecords, now);
    if (stalledRun) anomalies.push(stalledRun);
  }

  return anomalies;
}

function detectErrorSpike(records: AnalyticsRecord[], windowDays: number): Anomaly | null {
  if (records.length < 5) return null;

  const half = Math.floor(records.length / 2);
  const older = records.slice(half);
  const recent = records.slice(0, half);

  const recentErrorRate = recent.filter(r => r.status === "error").length / recent.length;
  const olderErrorRate = older.filter(r => r.status === "error").length / older.length;

  // Всплеск ошибок: недавний период значительно хуже старого
  if (olderErrorRate < 0.5 && recentErrorRate > olderErrorRate * 2 && recentErrorRate > 0.3) {
    return {
      type: "error_spike",
      severity: Math.min(100, Math.round((recentErrorRate - olderErrorRate) * 100)),
      description: `Всплеск ошибок: ${Math.round(recentErrorRate * 100)}% vs ${Math.round(olderErrorRate * 100)}% (старые данные)`,
      affectedTasks: [records[0].taskName],
      recommendations: [
        "Проверьте логи ошибок за последнее время",
        "Убедитесь, что Quality Gate настроен правильно",
        "Рассмотрите добавление retryCount",
      ],
      metadata: {
        recentErrorRate,
        olderErrorRate,
        windowDays,
      },
    };
  }
  return null;
}

function detectDurationSpike(records: AnalyticsRecord[]): Anomaly | null {
  if (records.length < 5) return null;

  const durations = records
    .map(r => r.durationMs || 0)
    .filter(d => d > 0)
    .sort((a, b) => a - b);

  if (durations.length < 3) return null;

  const median = durations[Math.floor(durations.length / 2)];
  const recentDuration = records[0]?.durationMs || 0;

  if (recentDuration > median * 3) {
    return {
      type: "duration_spike",
      severity: Math.min(100, Math.round((recentDuration / median - 1) * 50)),
      description: `Аномальная длительность: ${Math.round(recentDuration / 1000)}с vs медиана ${Math.round(median / 1000)}с`,
      affectedTasks: [records[0].taskName],
      recommendations: [
        "Проверьте, не завис ли процесс",
        "Увеличьте timeoutSeconds если задача легитимно долгая",
        "Рассмотрите разделение задачи на части",
      ],
      metadata: {
        recentDuration,
        medianDuration: median,
        ratio: recentDuration / median,
      },
    };
  }
  return null;
}

function detectTimeoutSpike(records: AnalyticsRecord[]): Anomaly | null {
  if (records.length < 5) return null;

  const timeoutCount = records.filter(r => r.error?.includes("timeout")).length;
  const timeoutRate = timeoutCount / records.length;

  if (timeoutRate > 0.2) {
    return {
      type: "timeout_spike",
      severity: Math.min(100, Math.round(timeoutRate * 200)),
      description: `Высокий процент таймаутов: ${Math.round(timeoutRate * 100)}%`,
      affectedTasks: [records[0].taskName],
      recommendations: [
        "Увеличьте timeoutSeconds",
        "Упростите промпты задачи",
        "Проверьте производительность модели",
      ],
      metadata: {
        timeoutCount,
        totalRecords: records.length,
        timeoutRate,
      },
    };
  }
  return null;
}

function detectCostSpike(records: AnalyticsRecord[]): Anomaly | null {
  if (records.length < 5) return null;

  const costs = records
    .map(r => r.costUsd || 0)
    .filter(c => c > 0)
    .sort((a, b) => a - b);

  if (costs.length < 3) return null;

  const median = costs[Math.floor(costs.length / 2)];
  const recentCost = records[0]?.costUsd || 0;

  if (recentCost > median * 3) {
    return {
      type: "cost_spike",
      severity: Math.min(100, Math.round((recentCost / median - 1) * 50)),
      description: `Аномальные затраты: $${recentCost.toFixed(4)} vs медиана $${median.toFixed(4)}`,
      affectedTasks: [records[0].taskName],
      recommendations: [
        "Проверьте, не используется ли более дорогая модель",
        "Оптимизируйте промпты для снижения токенов",
        "Рассмотрите использование локальной модели",
      ],
      metadata: {
        recentCost,
        medianCost: median,
        ratio: recentCost / median,
      },
    };
  }
  return null;
}

function detectUnusualPattern(records: AnalyticsRecord[]): Anomaly | null {
  if (records.length < 10) return null;

  // Проверяем паттерн: все подряд ошибки или все подряд успехи
  const recent = records.slice(0, 5);
  const allErrors = recent.every(r => r.status === "error");

  if (allErrors) {
    return {
      type: "unusual_pattern",
      severity: 80,
      description: "5 подряд ошибок подряд",
      affectedTasks: [records[0].taskName],
      recommendations: [
        "Проверьте, не сломалась ли зависимость",
        "Проверьте доступность внешних сервисов",
        "Рассмотрите приостановку задачи до устранения проблемы",
      ],
      metadata: {
        pattern: "consecutive_errors",
        count: 5,
      },
    };
  }

  return null;
}

function detectStalledRun(records: AnalyticsRecord[], now: Date): Anomaly | null {
  const running = records.find(r => r.status === "running");
  if (!running) return null;

  const startedAt = new Date(running.startedAt);
  const hoursRunning = (now.getTime() - startedAt.getTime()) / (1000 * 60 * 60);

  if (hoursRunning > 2) {
    return {
      type: "stalled_run",
      severity: Math.min(100, Math.round(hoursRunning * 10)),
      description: `Зависший запуск: ${hoursRunning.toFixed(1)} часов`,
      affectedTasks: [running.taskName],
      recommendations: [
        "Проверьте, не завис ли процесс",
        "Рассмотрите принудительное завершение",
        "Проверьте блокировки (lock file)",
      ],
      metadata: {
        hoursRunning,
        startedAt: running.startedAt,
        // QA-A2.7: поле id есть не у всех AnalyticsRecord — сохраняем прежнюю семантику undefined.
        taskId: (running as AnalyticsRecord & { id?: number }).id,
      },
    };
  }
  return null;
}

// ==================== Trend Analysis ====================

/** Анализирует тренды метрик. */
export function analyzeTrends(
  records: AnalyticsRecord[],
  _options: SelfAnalysisOptions = {},
): Trend[] {
  const trends: Trend[] = [];

  // Разделяем на периоды
  const half = Math.floor(records.length / 2);
  const older = records.slice(half);
  const recent = records.slice(0, half);

  if (older.length < 3 || recent.length < 3) return trends;

  // 1. Тренд успешности
  const olderSuccessRate = older.filter(r => r.status === "success").length / older.length;
  const recentSuccessRate = recent.filter(r => r.status === "success").length / recent.length;
  const successChange = ((recentSuccessRate - olderSuccessRate) / Math.max(olderSuccessRate, 0.01)) * 100;

  trends.push({
    metric: "success_rate",
    direction: successChange > 5 ? "improving" : successChange < -5 ? "degrading" : "stable",
    changePercent: successChange,
    description: `Успешность: ${Math.round(olderSuccessRate * 100)}% → ${Math.round(recentSuccessRate * 100)}%`,
    recommendations: successChange < -10 ? [
      "Проверьте, что изменилось в последнее время",
      "Проверьте логи ошибок",
    ] : [],
  });

  // 2. Тренд длительности
  const olderDurations = older.map(r => r.durationMs || 0).filter(d => d > 0);
  const recentDurations = recent.map(r => r.durationMs || 0).filter(d => d > 0);

  if (olderDurations.length > 0 && recentDurations.length > 0) {
    const olderAvgDuration = olderDurations.reduce((a, b) => a + b, 0) / olderDurations.length;
    const recentAvgDuration = recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
    const durationChange = ((recentAvgDuration - olderAvgDuration) / Math.max(olderAvgDuration, 1)) * 100;

    trends.push({
      metric: "avg_duration",
      direction: durationChange < -5 ? "improving" : durationChange > 5 ? "degrading" : "stable",
      changePercent: durationChange,
      description: `Средняя длительность: ${Math.round(olderAvgDuration / 1000)}с → ${Math.round(recentAvgDuration / 1000)}с`,
      recommendations: durationChange > 20 ? [
        "Оптимизируйте промпты",
        "Проверьте, не увеличилась ли нагрузка",
      ] : [],
    });
  }

  // 3. Тренд стоимости
  const olderCosts = older.map(r => r.costUsd || 0).filter(c => c > 0);
  const recentCosts = recent.map(r => r.costUsd || 0).filter(c => c > 0);

  if (olderCosts.length > 0 && recentCosts.length > 0) {
    const olderAvgCost = olderCosts.reduce((a, b) => a + b, 0) / olderCosts.length;
    const recentAvgCost = recentCosts.reduce((a, b) => a + b, 0) / recentCosts.length;
    const costChange = ((recentAvgCost - olderAvgCost) / Math.max(olderAvgCost, 0.001)) * 100;

    trends.push({
      metric: "avg_cost",
      direction: costChange < -5 ? "improving" : costChange > 5 ? "degrading" : "stable",
      changePercent: costChange,
      description: `Средняя стоимость: $${olderAvgCost.toFixed(4)} → $${recentAvgCost.toFixed(4)}`,
      recommendations: costChange > 20 ? [
        "Проверьте, не используется ли более дорогая модель",
        "Оптимизируйте промпты для снижения токенов",
      ] : [],
    });
  }

  return trends;
}

// ==================== Recommendations ====================

/** Генерирует рекомендации по оптимизации. */
export function generateRecommendations(
  report: AnalyticsReport,
  anomalies: Anomaly[],
  trends: Trend[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Если нет данных — не генерируем рекомендации
  if (report.totals.total === 0) {
    return recommendations;
  }

  // Рекомендации на основе здоровья
  if (report.totals.successRate < 80) {
    recommendations.push({
      priority: 9,
      category: "reliability",
      title: "Повысьте успешность запусков",
      description: `Текущая успешность ${report.totals.successRate}% ниже целевых 80%. Это может указывать на проблемы с Quality Gate, зависимостями или внешними сервисами.`,
      expectedImpact: "Снизит количество повторных запусков и улучшит надёжность",
      effort: "medium",
      steps: [
        "Проверьте логи ошибок за последние 7 дней",
        "Убедитесь, что Quality Gate настроен правильно",
        "Добавьте retryCount для флакких задач",
        "Проверьте доступность внешних сервисов",
      ],
    });
  }

  // Рекомендации на основе аномалий
  for (const anomaly of anomalies) {
    if (anomaly.severity > 70) {
      recommendations.push({
        priority: Math.min(10, Math.round(anomaly.severity / 10)),
        category: anomaly.type.includes("cost") ? "cost" : "performance",
        title: `Устраните аномалию: ${anomaly.type}`,
        description: anomaly.description,
        expectedImpact: "Снизит нагрузку и улучшит стабильность",
        effort: "medium",
        steps: anomaly.recommendations,
      });
    }
  }

  // Рекомендации на основе трендов
  for (const trend of trends) {
    if (trend.direction === "degrading" && Math.abs(trend.changePercent) > 20) {
      recommendations.push({
        priority: 7,
        category: trend.metric.includes("cost") ? "cost" : "performance",
        title: `Обратите внимание на тренд: ${trend.metric}`,
        description: trend.description,
        expectedImpact: "Предотвратит дальнейшее ухудшение",
        effort: "low",
        steps: trend.recommendations,
      });
    }
  }

  // Рекомендации на основе затрат
  if (report.totals.costUsd > 100) {
    recommendations.push({
      priority: 6,
      category: "cost",
      title: "Оптимизируйте затраты",
      description: `Общие затраты за период: $${report.totals.costUsd.toFixed(2)}. Рассмотрите оптимизацию.`,
      expectedImpact: "Снизит затраты на 20-40%",
      effort: "medium",
      steps: [
        "Проверьте, не используется ли более дорогая модель для простых задач",
        "Оптимизируйте промпты для снижения токенов",
        "Рассмотрите использование локальной модели для простых задач",
        "Настройте лимиты на задачи с высокими затратами",
      ],
    });
  }

  // Рекомендации на основе длительности
  if (report.totals.avgDurationMs > 300000) { // 5 минут
    recommendations.push({
      priority: 5,
      category: "performance",
      title: "Оптимизируйте длительность задач",
      description: `Средняя длительность: ${Math.round(report.totals.avgDurationMs / 1000)} секунд. Это может указывать на сложные промпты или медленные модели.`,
      expectedImpact: "Снизит время ожидания и улучшит отзывчивость",
      effort: "medium",
      steps: [
        "Разбейте длинные задачи на более мелкие",
        "Упростите промпты",
        "Проверьте, не используются ли медленные модели",
        "Увеличьте timeoutSeconds если задачи легитимно долгие",
      ],
    });
  }

  // Рекомендации на основе таймаутов
  const timeoutErrors = report.errors.filter(e => e.message.includes("timeout"));
  if (timeoutErrors.length > 0) {
    recommendations.push({
      priority: 8,
      category: "reliability",
      title: "Устраните проблемы с таймаутами",
      description: `Обнаружено ${timeoutErrors.length} ошибок таймаута. Это может указывать на слишком короткие таймауты или сложные задачи.`,
      expectedImpact: "Снизит количество прерванных запусков",
      effort: "low",
      steps: [
        "Увеличьте timeoutSeconds для затронутых задач",
        "Упростите промпты",
        "Проверьте производительность модели",
        "Рассмотрите разделение сложных задач",
      ],
    });
  }

  // Рекомендации на основе крашей
  const crashErrors = report.errors.filter(e => e.message.includes("Прервано"));
  if (crashErrors.length > 0) {
    recommendations.push({
      priority: 7,
      category: "reliability",
      title: "Снизьте количество прерванных запусков",
      description: `Обнаружено ${crashErrors.length} прерванных запусков. Это может указывать на нестабильность системы или перезагрузки.`,
      expectedImpact: "Повысит надёжность выполнения задач",
      effort: "medium",
      steps: [
        "Проверьте стабильность системы",
        "Проверьте, нет ли конфликтов между задачами",
        "Убедитесь, что задачи не превышают лимиты ресурсов",
        "Рассмотрите настройку crash recovery",
      ],
    });
  }

  // Сортируем по приоритету
  return recommendations.sort((a, b) => b.priority - a.priority);
}

// ==================== Main Function ====================

/** Генерирует полный отчёт самоанализа. */
export function generateSelfAnalysisReport(
  records: AnalyticsRecord[],
  options: SelfAnalysisOptions = {},
): SelfAnalysisReport {
  const windowDays = options.days ?? 14;
  const now = options.now ?? new Date();

  // Базовая аналитика
  const analyticsReport = buildAnalytics(records, {
    days: windowDays,
    now,
    topLimit: options.topLimit,
    tasks: options.tasks,
  });

  // Health Score
  const health = calculateHealthScore(analyticsReport);

  // Anomalies
  const anomalies = detectAnomalies(records, options);

  // Trends
  const trends = analyzeTrends(records, options);

  // Recommendations
  const recommendations = generateRecommendations(analyticsReport, anomalies, trends);

  // Summary
  const summary = generateSummary(health, anomalies, trends, recommendations);

  return {
    generatedAt: now.toISOString(),
    windowDays,
    health,
    anomalies,
    trends,
    recommendations,
    summary,
    sources: {
      historyRecords: records.length,
      recordsInWindow: analyticsReport.sources.recordsInWindow,
      // PL-13/PL-29/PL-31: options.tasks — это definitions, а analyticsReport.tasks —
      // задачи, попавшие в историю; последнее число могло быть больше на 15+.
      tasksAnalyzed: options.tasks?.length ?? analyticsReport.tasks.length,
      taskDefinitions: options.tasks?.length ?? analyticsReport.tasks.length,
    },
  };
}

// --- EV-1.1: версионированный фикс-набор из ledger --------------------------

/** Секреты не копируются в отчёт: маскируем в любом текстовом поле. */
const ACCEPTANCE_SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~-]{8,}/gi,
  /[?&]?(?:token|api[_-]?key|password|secret)=[^\s&]+/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

/** Маскирует известные форматы секретов; `null` остаётся `null`. */
export function maskAcceptanceSecrets(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let masked = value;
  for (const pattern of ACCEPTANCE_SECRET_PATTERNS) {
    masked = masked.replace(pattern, "[MASKED]");
  }
  return masked;
}

/** Стабильный ключ группировки: только хэши и нейтральные тип/название гейта. */
function acceptanceGroupKey(row: AcceptanceGateRow): string {
  return [
    row.gateHash ?? "",
    row.policyHash ?? "",
    row.promptHash ?? "",
    row.taskType ?? "",
    row.gateType ?? "",
  ].join("|");
}

/** Объективный гейт: кодом посчитанный хэш + финальный вердикт. */
function isObjectiveGateOutcome(row: AcceptanceGateRow): boolean {
  return (
    typeof row.gateHash === "string" &&
    row.gateHash.length > 0 &&
    (row.verdict === "pass" || row.verdict === "fail")
  );
}

function roundAcceptance(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

interface AcceptanceGroup {
  sample: AcceptanceGateRow;
  samples: number;
  passes: number;
  fails: number;
  firstPass: number;
  attempts: number;
}

/**
 * Собирает версионированный фикс-набор ТОЛЬКО из строк ledger.
 *
 * Нестабильные (`flake`/`infra_fail`) и субъективные (без `gateHash`) строки
 * отклоняются. Метка «стабильный pass/fail» выставляется по большинству
 * повторов (>= `stabilityRatio`), при малой выборке — `unstable`.
 */
export function buildAcceptanceDataset(
  rows: readonly AcceptanceGateRow[],
  options: AcceptanceDatasetOptions = {},
): AcceptanceDataset {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 2));
  const stabilityRatio = Math.min(1, Math.max(0.5, options.stabilityRatio ?? 0.8));
  const maxCases = Math.max(1, Math.floor(options.maxCases ?? 50));
  const groups = new Map<string, AcceptanceGroup>();
  let excluded = 0;

  for (const row of rows) {
    if (!isObjectiveGateOutcome(row)) {
      excluded++;
      continue;
    }
    const key = acceptanceGroupKey(row);
    let group = groups.get(key);
    if (!group) {
      group = { sample: row, samples: 0, passes: 0, fails: 0, firstPass: 0, attempts: 0 };
      groups.set(key, group);
    }
    group.samples++;
    if (row.verdict === "pass") group.passes++;
    else group.fails++;
    if (Number(row.firstPass) === 1) group.firstPass++;
    group.attempts += Math.max(1, Math.floor(row.attemptsToPass ?? 1));
  }

  const cases: AcceptanceCase[] = [];
  for (const [key, group] of groups) {
    const share = group.passes / group.samples;
    let label: AcceptanceLabel = "unstable";
    if (group.samples >= minSamples) {
      if (share >= stabilityRatio) label = "stable_pass";
      else if (share <= 1 - stabilityRatio) label = "stable_fail";
    }
    const sample = group.sample;
    cases.push({
      caseId: `case-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
      taskType: sample.taskType ?? "",
      gateType: sample.gateType ?? "",
      gateHash: sample.gateHash ?? "",
      policyHash: sample.policyHash ?? "",
      promptHash: sample.promptHash ?? "",
      verdict: group.passes >= group.fails ? "pass" : "fail",
      attemptsToPass: group.samples > 0 ? Math.round(group.attempts / group.samples) : 1,
      firstPass: group.samples > 0 ? Math.round(group.firstPass / group.samples) : 0,
      evidencePath: maskAcceptanceSecrets(sample.evidencePath),
      executor: sample.executor,
      routeSource: sample.routeSource,
      samples: group.samples,
      passes: group.passes,
      fails: group.fails,
      label,
    });
  }
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));

  return {
    kind: "acceptance-dataset",
    format: "agent-steward.acceptance-dataset",
    version: ACCEPTANCE_DATASET_VERSION,
    source: "gate_outcomes.ledger",
    generatedAt: (options.now ?? new Date()).toISOString(),
    horizonDays: ACCEPTANCE_HORIZON_DAYS,
    cases: cases.slice(0, maxCases),
    excluded,
    rowsConsidered: rows.length,
  };
}

// --- EV-1.2: семь критериев §11 ---------------------------------------------

function acceptanceRate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundAcceptance(numerator / denominator) : 0;
}

function isEscalation(row: AcceptanceGateRow): boolean {
  return (
    row.executor === "cloud" ||
    (typeof row.routeReason === "string" && /escalat/i.test(row.routeReason))
  );
}

function isReuse(row: AcceptanceGateRow): boolean {
  return (
    row.routeSource === "capability-map" ||
    (typeof row.routeReason === "string" && /reuse|recipe|example/i.test(row.routeReason))
  );
}

/** Вычисляет метрики семи критериев §11 из ledger и истории запусков. */
export function computeAcceptanceMetrics(input: AcceptanceMetricsInput): AcceptanceMetrics {
  const days = Math.min(365, Math.max(1, Math.floor(input.days ?? ACCEPTANCE_HORIZON_DAYS)));
  const now = input.now ?? new Date();
  const end = now.getTime();
  const cutoff = end - days * 24 * 60 * 60 * 1000;
  const rows = input.rows.filter((row) => {
    const ts = Date.parse(row.createdAt);
    return Number.isFinite(ts) && ts >= cutoff && ts <= end + 60_000;
  });

  const dataset = buildAcceptanceDataset(rows, input.datasetOptions);
  const stable = dataset.cases.filter((c) => c.label !== "unstable");
  const stablePass = stable.filter((c) => c.label === "stable_pass").length;
  const stableFail = stable.length - stablePass;
  const objective = rows.filter(isObjectiveGateOutcome);

  // eval не деградировал: вторая половина окна не хуже первой более чем на порог.
  const mid = cutoff + (end - cutoff) / 2;
  const rateForWindow = (from: number, to: number): number | null => {
    const subset = rows.filter((row) => {
      const ts = Date.parse(row.createdAt);
      return Number.isFinite(ts) && ts >= from && ts < to && isObjectiveGateOutcome(row);
    });
    if (subset.length === 0) return null;
    return acceptanceRate(
      subset.filter((row) => row.verdict === "pass").length,
      subset.length,
    );
  };
  const firstHalf = rateForWindow(cutoff, mid);
  const secondHalf = rateForWindow(mid, end + 60_000);
  const evalNotDegraded =
    firstHalf === null || secondHalf === null
      ? null
      : secondHalf >= firstHalf - ACCEPTANCE_THRESHOLDS.maxRateDegradation;

  const withExecutor = rows.filter((row) => typeof row.executor === "string");
  const local = withExecutor.filter((row) => row.executor === "local").length;
  const escalations = rows.filter(isEscalation).length;
  const infraFails = rows.filter((row) => row.verdict === "infra_fail").length;
  const adhoc = rows.filter((row) => row.triggerKind === "adhoc");
  const reuse = rows.filter(isReuse).length;

  const savings = computeSavings([...(input.history ?? [])], { topLimit: 1 });
  const netEconomyUsd = roundAcceptance(savings.savedUsd - savings.totalCostUsd);

  // §11.6: одинаковый gate+prompt в ad-hoc и registered должен дать вердикт.
  const parityGroups = new Map<string, { adhoc: string | null; registered: string | null }>();
  for (const row of objective) {
    const key = `${row.gateHash}|${row.promptHash}|${row.taskType ?? ""}`;
    let entry = parityGroups.get(key);
    if (!entry) {
      entry = { adhoc: null, registered: null };
      parityGroups.set(key, entry);
    }
    if (row.triggerKind === "adhoc") entry.adhoc = row.verdict;
    else entry.registered = row.verdict;
  }
  let parityPairs = 0;
  let parityMismatches = 0;
  for (const entry of parityGroups.values()) {
    if (entry.adhoc !== null && entry.registered !== null) {
      parityPairs++;
      if (entry.adhoc !== entry.registered) parityMismatches++;
    }
  }

  const objectiveRows = rows.filter(isObjectiveGateOutcome);
  const firstPassCount = objectiveRows.filter((row) => Number(row.firstPass) === 1).length;
  const sampleSize = rows.length;

  return {
    kind: "acceptance-metrics",
    format: ACCEPTANCE_FORMAT,
    version: ACCEPTANCE_METRICS_VERSION,
    source: "gate_outcomes.ledger",
    generatedAt: now.toISOString(),
    windowDays: days,
    owner: ACCEPTANCE_OWNER,
    thresholds: ACCEPTANCE_THRESHOLDS,
    datasetVersion: dataset.version,
    sampleSize,
    confidence: sampleSize >= 30 ? "high" : sampleSize >= 10 ? "medium" : "low",
    criteria: {
      adhocGateSafety: {
        observed: adhoc.length > 0,
        samples: adhoc.length,
        objectiveWithEvidence: adhoc.filter(
          (row) => isObjectiveGateOutcome(row) && !!row.evidencePath,
        ).length,
      },
      localFirstRouting: {
        localShare: acceptanceRate(local, withExecutor.length),
        local,
        total: withExecutor.length,
      },
      objectiveGate: {
        objectiveShare: acceptanceRate(objective.length, rows.length),
        objective: objective.length,
        escalations,
        infraFails,
      },
      honestEconomy: {
        netEconomyUsd,
        savedUsd: roundAcceptance(savings.savedUsd),
        paidCostUsd: roundAcceptance(savings.totalCostUsd),
        escalationRate: acceptanceRate(escalations, rows.length),
      },
      learningLoopReuse: {
        reused: reuse,
        reuseRate: acceptanceRate(reuse, rows.length),
      },
      parity: { pairs: parityPairs, mismatches: parityMismatches },
      fixedSet: {
        cases: dataset.cases.length,
        stablePass,
        stableFail,
        successRate: acceptanceRate(stablePass, stablePass + stableFail),
        firstPassRate: acceptanceRate(firstPassCount, objectiveRows.length),
        evalNotDegraded,
        weeks: Math.round(days / 7),
      },
    },
  };
}

// --- EV-1.3: CI-гейт «eval не деградировал» ---------------------------------

/** Сравнивает текущие метрики с baseline и проверяет пороги приёмки. */
export function evaluateAcceptanceGate(
  current: AcceptanceMetrics,
  baseline: AcceptanceBaseline | null,
  thresholds?: Partial<Record<keyof typeof ACCEPTANCE_THRESHOLDS, number>>,
): AcceptanceGateResult {
  const limits = { ...ACCEPTANCE_THRESHOLDS, ...(thresholds ?? {}) };
  const fixed = current.criteria.fixedSet;
  const economy = current.criteria.honestEconomy.netEconomyUsd;
  const checks: AcceptanceGateResult["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };

  add(
    "metrics_present",
    current.sampleSize > 0 && fixed.cases > 0,
    `sampleSize=${current.sampleSize}, cases=${fixed.cases}`,
  );
  add(
    "dataset_size",
    fixed.cases >= limits.minDatasetCases,
    `cases=${fixed.cases}, min=${limits.minDatasetCases}`,
  );
  add(
    "baseline_present",
    baseline !== null && baseline.version === ACCEPTANCE_METRICS_VERSION,
    `baseline=${baseline?.version ?? "отсутствует"}`,
  );
  add(
    "success_rate_threshold",
    fixed.successRate >= limits.minSuccessRate,
    `success_rate=${fixed.successRate}, min=${limits.minSuccessRate}`,
  );
  add(
    "first_pass_rate_threshold",
    fixed.firstPassRate >= limits.minFirstPassRate,
    `first_pass_rate=${fixed.firstPassRate}, min=${limits.minFirstPassRate}`,
  );
  add(
    "net_economy_positive",
    economy >= limits.minNetEconomyUsd,
    `netEconomyUsd=${economy}, min=${limits.minNetEconomyUsd}`,
  );

  if (baseline) {
    add(
      "eval_not_degraded",
      fixed.successRate >= baseline.successRate - limits.maxRateDegradation &&
        fixed.firstPassRate >= baseline.firstPassRate - limits.maxRateDegradation &&
        economy >= baseline.netEconomyUsd - limits.maxEconomyDegradationUsd,
      `baseline=${JSON.stringify({
        successRate: baseline.successRate,
        firstPassRate: baseline.firstPassRate,
        netEconomyUsd: baseline.netEconomyUsd,
      })}, current=${JSON.stringify({
        successRate: fixed.successRate,
        firstPassRate: fixed.firstPassRate,
        netEconomyUsd: economy,
      })}`,
    );
    add(
      "parity_no_mismatch",
      current.criteria.parity.mismatches === 0,
      `mismatches=${current.criteria.parity.mismatches}`,
    );
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    baseline,
    current: {
      successRate: fixed.successRate,
      firstPassRate: fixed.firstPassRate,
      netEconomyUsd: economy,
      cases: fixed.cases,
    },
    rollback: "git checkout HEAD -- reports/acceptance-baseline.json && npm run build && node scripts/acceptance-gate.mjs",
  };
}

// --- LP-1.1: критерии датасета staged LoRA (только офлайн) --------------------

/** Версия формата датасета: менять при любом изменении критериев. */
export const LORA_DATASET_VERSION = "1.0";
export const LORA_FORMAT = "agent-steward.lora-dataset";
export const LORA_ONLINE_LEARNING = "forbidden";

/**
 * Критерии датасета для staged LoRA. Источник — только ledger objective-гейтов;
 * онлайн-обучение запрещено на уровне формата.
 */
export const LORA_CRITERIA = {
  source: "gate_outcomes.ledger",
  minCases: 20,
  minSamples: 2,
  stabilityRatio: 0.8,
  minStableShare: 0.8,
  dedupBy: "caseId",
  secretMasking: true,
  onlineLearning: false,
  version: LORA_DATASET_VERSION,
} as const;

/** Датасет для офлайн-дообучения адаптера. */
export interface LoraDataset {
  kind: "lora-dataset";
  format: typeof LORA_FORMAT;
  version: string;
  source: "gate_outcomes.ledger";
  criteria: typeof LORA_CRITERIA;
  onlineLearning: typeof LORA_ONLINE_LEARNING;
  generatedAt: string;
  cases: AcceptanceCase[];
  excluded: number;
  rowsConsidered: number;
  /** Доля стабильных кейсов среди всех objective-кейсов. */
  stableShare: number;
}

/** Результат проверки датасета перед офлайн-дообучением. */
export interface LoraValidation {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
}

export interface LoraDatasetOptions {
  now?: Date;
  minCases?: number;
  minStableShare?: number;
  maxCases?: number;
}

function maskOptionalAcceptanceField(value: string | null | undefined): string | null {
  return maskAcceptanceSecrets(value);
}

/**
 * Собирает версионированный датасет для staged LoRA из строк ledger.
 * Нестабильные кейсы отбрасываются, дубликаты дедуплицируются по `caseId`,
 * секреты маскируются повторно (даже если пришли из уже обработанного отчёта).
 */
export function buildLoraDataset(
  rows: readonly AcceptanceGateRow[],
  options: LoraDatasetOptions = {},
): LoraDataset {
  const base = buildAcceptanceDataset(rows, {
    now: options.now,
    minSamples: LORA_CRITERIA.minSamples,
    stabilityRatio: LORA_CRITERIA.stabilityRatio,
    maxCases: Math.max(1, Math.floor(options.maxCases ?? 500)),
  });
  const seen = new Set<string>();
  const cases: AcceptanceCase[] = [];
  for (const item of base.cases) {
    if (item.label !== "stable_pass" && item.label !== "stable_fail") continue;
    if (seen.has(item.caseId)) continue;
    seen.add(item.caseId);
    cases.push({
      ...item,
      taskType: maskOptionalAcceptanceField(item.taskType) ?? "",
      gateType: maskOptionalAcceptanceField(item.gateType) ?? "",
      executor: maskOptionalAcceptanceField(item.executor),
      routeSource: maskOptionalAcceptanceField(item.routeSource),
      evidencePath: maskAcceptanceSecrets(item.evidencePath),
    });
  }
  return {
    kind: "lora-dataset",
    format: LORA_FORMAT,
    version: LORA_DATASET_VERSION,
    source: "gate_outcomes.ledger",
    criteria: LORA_CRITERIA,
    onlineLearning: LORA_ONLINE_LEARNING,
    generatedAt: base.generatedAt,
    cases,
    excluded: base.excluded,
    rowsConsidered: base.rowsConsidered,
    stableShare: base.cases.length > 0 ? roundAcceptance(cases.length / base.cases.length) : 0,
  };
}

/** Проверяет датасет по критериям LP-1.1 до любого дообучения. */
export function validateLoraDataset(dataset: LoraDataset): LoraValidation {
  const checks: LoraValidation["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  add(
    "dataset_version",
    dataset.version === LORA_DATASET_VERSION && dataset.criteria.version === LORA_DATASET_VERSION,
    `version=${dataset.version}, criteria=${dataset.criteria.version}`,
  );
  add(
    "source_ledger",
    dataset.source === "gate_outcomes.ledger" && dataset.criteria.source === "gate_outcomes.ledger",
    `source=${dataset.source}`,
  );
  add(
    "volume",
    dataset.cases.length >= dataset.criteria.minCases,
    `cases=${dataset.cases.length}, min=${dataset.criteria.minCases}`,
  );
  add(
    "stable_share",
    dataset.stableShare >= dataset.criteria.minStableShare,
    `stableShare=${dataset.stableShare}, min=${dataset.criteria.minStableShare}`,
  );
  add(
    "dedup",
    new Set(dataset.cases.map((item) => item.caseId)).size === dataset.cases.length,
    `unique=${new Set(dataset.cases.map((item) => item.caseId)).size}, cases=${dataset.cases.length}`,
  );
  const hasSecrets = dataset.cases.some((item) =>
    [item.taskType, item.gateType, item.executor ?? "", item.routeSource ?? "", item.evidencePath ?? ""].some(
      (value) => maskAcceptanceSecrets(value) !== value,
    ),
  );
  add("secrets_masked", !hasSecrets, hasSecrets ? "обнаружены не маскированные секреты" : "секреты маскированы");
  add(
    "online_learning_forbidden",
    dataset.onlineLearning === LORA_ONLINE_LEARNING && dataset.criteria.onlineLearning === false,
    `mode=${dataset.onlineLearning}, flag=${dataset.criteria.onlineLearning}`,
  );
  return { ok: checks.every((check) => check.ok), checks };
}

// --- LP-1.2: офлайн-адаптер с обязательным eval (без онлайн-обучения) ---------

/** Версия формата кандидата адаптера. */
export const LORA_ADAPTER_VERSION = "1.0";
export const LORA_ADAPTER_FORMAT = "agent-steward.lora-adapter-candidate";
export const LORA_TRAINING_MODE = "offline";

/** Пороги сравнения с эталоном до любого включения адаптера. */
export const LORA_PROMOTION = {
  maxSuccessRateDrop: 0.02,
  maxFirstPassRateDrop: 0.02,
  maxEconomyDropUsd: 1,
  requireEval: true,
  onlineLearning: false,
} as const;

/** Метрики офлайн-оценки адаптера. */
export interface LoraEvalMetrics {
  successRate: number;
  firstPassRate: number;
  netEconomyUsd: number;
  cases: number;
}

/** Результат обязательной офлайн-оценки кандидата. */
export interface LoraAdapterEval {
  kind: "lora-adapter-eval";
  version: string;
  adapterId: string;
  datasetHash: string;
  createdAt: string;
  metrics: LoraEvalMetrics;
  baseline: LoraEvalMetrics;
  verdict: "pass" | "fail";
  checks: { id: string; ok: boolean; detail: string }[];
}

/**
 * Кандидат адаптера. Артефакт весов создаётся внешним офлайн-пайплайном;
 * репозиторий хранит только символическую ссылку и гейт-решения.
 */
export interface LoraAdapterCandidate {
  kind: "lora-adapter-candidate";
  format: typeof LORA_ADAPTER_FORMAT;
  version: string;
  adapterId: string;
  trainingMode: "offline";
  datasetVersion: string;
  datasetHash: string;
  datasetCases: number;
  createdAt: string;
  baseModelRef: string;
  weightsRef: string;
  eval: LoraAdapterEval | null;
  promoted: boolean;
}

/** Решение о переводе адаптера в shadow-режим. */
export interface LoraPromotionDecision {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
  adapterId: string;
  rollback: string;
}

export interface LoraAdapterOptions {
  now?: Date;
  baseModelRef?: string;
}

/** Детерминированный отпечаток Outcome датасета для связки адаптера и eval. */
export function loraDatasetHash(dataset: LoraDataset): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: dataset.version,
        cases: dataset.cases.map((item) => `${item.caseId}:${item.verdict}:${item.label}`),
      }),
    )
    .digest("hex");
}

/**
 * Регистрирует офлайн-кандидата. Невалидный датасет отклоняется до любого
 * обращения к весам; онлайн-обучение в интерфейсе отсутствует.
 */
export function buildLoraAdapterCandidate(
  dataset: LoraDataset,
  options: LoraAdapterOptions = {},
): LoraAdapterCandidate {
  const validation = validateLoraDataset(dataset);
  if (!validation.ok) {
    const failed = validation.checks.filter((item) => !item.ok).map((item) => item.id).join(", ");
    throw new Error(`LORA_DATASET_INVALID: ${failed}`);
  }
  const datasetHash = loraDatasetHash(dataset);
  const baseModelRef = options.baseModelRef ?? "local:3-4B";
  const adapterId = createHash("sha256").update(`${datasetHash}|${baseModelRef}`).digest("hex").slice(0, 12);
  return {
    kind: "lora-adapter-candidate",
    format: LORA_ADAPTER_FORMAT,
    version: LORA_ADAPTER_VERSION,
    adapterId,
    trainingMode: LORA_TRAINING_MODE,
    datasetVersion: dataset.version,
    datasetHash,
    datasetCases: dataset.cases.length,
    createdAt: (options.now ?? new Date()).toISOString(),
    baseModelRef,
    weightsRef: `offline://adapter/${adapterId}`,
    eval: null,
    promoted: false,
  };
}

/**
 * Сравнивает метрики офлайн-оценки с эталоном. Не мутирует кандидата:
 * inclusion возможен только после отдельного решения promoteLoraAdapter.
 */
export function evaluateLoraAdapter(
  candidate: LoraAdapterCandidate,
  dataset: LoraDataset,
  baseline: LoraEvalMetrics,
  evalMetrics: LoraEvalMetrics,
  options: { now?: Date } = {},
): LoraAdapterEval {
  const checks: LoraAdapterEval["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const finite = (value: number): boolean => Number.isFinite(value);
  add(
    "eval_metrics_present",
    finite(evalMetrics.successRate) &&
      finite(evalMetrics.firstPassRate) &&
      finite(evalMetrics.netEconomyUsd) &&
      Number.isInteger(evalMetrics.cases) &&
      evalMetrics.successRate >= 0 &&
      evalMetrics.successRate <= 1 &&
      evalMetrics.firstPassRate >= 0 &&
      evalMetrics.firstPassRate <= 1,
    `metrics=${JSON.stringify(evalMetrics)}`,
  );
  add(
    "dataset_match",
    candidate.datasetHash === loraDatasetHash(dataset) && candidate.datasetVersion === dataset.version,
    `candidate=${candidate.datasetHash}, dataset=${loraDatasetHash(dataset)}`,
  );
  add(
    "offline_only",
    candidate.trainingMode === LORA_TRAINING_MODE,
    `trainingMode=${candidate.trainingMode}`,
  );
  add(
    "cases_match",
    evalMetrics.cases === dataset.cases.length,
    `eval=${evalMetrics.cases}, dataset=${dataset.cases.length}`,
  );
  add(
    "baseline_present",
    baseline.cases > 0 &&
      finite(baseline.successRate) &&
      finite(baseline.firstPassRate) &&
      finite(baseline.netEconomyUsd),
    `baseline=${JSON.stringify(baseline)}`,
  );
  add(
    "no_degradation",
    evalMetrics.successRate >= baseline.successRate - LORA_PROMOTION.maxSuccessRateDrop &&
      evalMetrics.firstPassRate >= baseline.firstPassRate - LORA_PROMOTION.maxFirstPassRateDrop &&
      evalMetrics.netEconomyUsd >= baseline.netEconomyUsd - LORA_PROMOTION.maxEconomyDropUsd,
    `current=${JSON.stringify(evalMetrics)}, baseline=${JSON.stringify(baseline)}`,
  );
  add(
    "thresholds",
    evalMetrics.successRate >= ACCEPTANCE_THRESHOLDS.minSuccessRate &&
      evalMetrics.firstPassRate >= ACCEPTANCE_THRESHOLDS.minFirstPassRate &&
      evalMetrics.netEconomyUsd > ACCEPTANCE_THRESHOLDS.minNetEconomyUsd,
    `minSuccessRate=${ACCEPTANCE_THRESHOLDS.minSuccessRate}, minFirstPassRate=${ACCEPTANCE_THRESHOLDS.minFirstPassRate}`,
  );
  return {
    kind: "lora-adapter-eval",
    version: LORA_ADAPTER_VERSION,
    adapterId: candidate.adapterId,
    datasetHash: candidate.datasetHash,
    createdAt: (options.now ?? new Date()).toISOString(),
    metrics: { ...evalMetrics },
    baseline: { ...baseline },
    verdict: checks.every((item) => item.ok) ? "pass" : "fail",
    checks,
  };
}

/**
 * Разрешает включение только при пройденном eval, совпадении датасета,
 * офлайн-режиме и отсутствии предыдущего включения.
 */
export function promoteLoraAdapter(
  candidate: LoraAdapterCandidate,
  evalResult: LoraAdapterEval,
): LoraPromotionDecision {
  const checks: LoraPromotionDecision["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  add("eval_present", evalResult.kind === "lora-adapter-eval" && LORA_PROMOTION.requireEval, `kind=${evalResult.kind}`);
  add(
    "eval_pass",
    evalResult.verdict === "pass" && evalResult.checks.every((item) => item.ok),
    `verdict=${evalResult.verdict}`,
  );
  add(
    "dataset_match",
    evalResult.adapterId === candidate.adapterId && evalResult.datasetHash === candidate.datasetHash,
    `adapter=${candidate.adapterId}, eval=${evalResult.adapterId}`,
  );
  add("offline_only", candidate.trainingMode === LORA_TRAINING_MODE, `trainingMode=${candidate.trainingMode}`);
  add("not_promoted", !candidate.promoted, `promoted=${candidate.promoted}`);
  add(
    "no_online_learning",
    LORA_PROMOTION.onlineLearning === false && candidate.trainingMode === LORA_TRAINING_MODE,
    `mode=${candidate.trainingMode}`,
  );
  return {
    ok: checks.every((item) => item.ok),
    checks,
    adapterId: candidate.adapterId,
    rollback: "git checkout HEAD -- reports/acceptance-baseline.json && npm run build && node scripts/acceptance-gate.mjs",
  };
}

// --- LP-1.3: теневой режим, канареечный выход и откат адаптера ----------------

/** Версия формата записи о включении адаптера. */
export const LORA_ROLLOUT_VERSION = "1.0";
export const LORA_ROLLOUT_FORMAT = "agent-steward.lora-rollout";
/** Доля трафика в теневом режиме: ответы модели не влияют на пользователя. */
export const LORA_SHADOW_TRAFFIC_SHARE = 0;
/** Доля трафика на первом канареечном шаге. */
export const LORA_CANARY_TRAFFIC_SHARE = 0.05;

/** Запись о включении адаптера: shadow или canary. */
export interface LoraRollout {
  kind: "lora-rollout";
  format: typeof LORA_ROLLOUT_FORMAT;
  version: string;
  adapterId: string;
  mode: "shadow" | "canary";
  enabledAt: string;
  trafficShare: number;
  canaryShare: number;
  decisionOk: boolean;
  rollbackCommand: string;
}

/** Наблюдение за работой адаптера в теневом режиме. */
export interface LoraShadowObservation {
  metrics: LoraEvalMetrics;
  baseline: LoraEvalMetrics;
}

/** Сравнение теневого прогона с эталоном. */
export interface LoraShadowComparison {
  ok: boolean;
  checks: { id: string; ok: boolean; detail: string }[];
  next: "blocked" | "hold" | "canary";
  canaryShare: number;
}

/** Результат отката адаптера. */
export interface LoraAdapterRollback {
  kind: "lora-adapter-rollback";
  version: string;
  adapterId: string;
  rolledBackAt: string;
  reason: string;
  trafficShare: 0;
  canaryShare: 0;
  command: string;
}

/**
 * Включает адаптер только в теневом режиме: нулевая доля реального трафика.
 * Без положительного решения promoteLoraAdapter включение невозможно.
 */
export function activateLoraShadow(
  decision: LoraPromotionDecision,
  options: { now?: Date } = {},
): LoraRollout {
  if (!decision.ok) {
    throw new Error("LORA_PROMOTION_REQUIRED: включение без пройденного eval запрещено");
  }
  return {
    kind: "lora-rollout",
    format: LORA_ROLLOUT_FORMAT,
    version: LORA_ROLLOUT_VERSION,
    adapterId: decision.adapterId,
    mode: "shadow",
    enabledAt: (options.now ?? new Date()).toISOString(),
    trafficShare: LORA_SHADOW_TRAFFIC_SHARE,
    canaryShare: LORA_SHADOW_TRAFFIC_SHARE,
    decisionOk: true,
    rollbackCommand: decision.rollback,
  };
}

/**
 * Сравнивает метрики теневого прогона с эталоном. Переход в canary
 * разрешён только при отсутствии деградации и соблюдении порогов.
 */
export function compareLoraShadow(
  rollout: LoraRollout,
  observation: LoraShadowObservation,
): LoraShadowComparison {
  const checks: LoraShadowComparison["checks"] = [];
  const add = (id: string, ok: boolean, detail: string): void => {
    checks.push({ id, ok, detail });
  };
  const current = observation.metrics;
  const baseline = observation.baseline;
  add(
    "shadow_traffic_zero",
    rollout.mode === "shadow" && rollout.trafficShare === LORA_SHADOW_TRAFFIC_SHARE && rollout.canaryShare === 0,
    `mode=${rollout.mode}, trafficShare=${rollout.trafficShare}`,
  );
  add("decision_ok", rollout.decisionOk, `decisionOk=${rollout.decisionOk}`);
  add(
    "observation_present",
    Number.isFinite(current.successRate) &&
      Number.isFinite(current.firstPassRate) &&
      Number.isFinite(current.netEconomyUsd) &&
      current.cases > 0 &&
      baseline.cases > 0,
    `current=${JSON.stringify(current)}, baseline=${JSON.stringify(baseline)}`,
  );
  add(
    "no_degradation",
    current.successRate >= baseline.successRate - LORA_PROMOTION.maxSuccessRateDrop &&
      current.firstPassRate >= baseline.firstPassRate - LORA_PROMOTION.maxFirstPassRateDrop &&
      current.netEconomyUsd >= baseline.netEconomyUsd - LORA_PROMOTION.maxEconomyDropUsd,
    `current=${JSON.stringify(current)}, baseline=${JSON.stringify(baseline)}`,
  );
  add(
    "thresholds",
    current.successRate >= ACCEPTANCE_THRESHOLDS.minSuccessRate &&
      current.firstPassRate >= ACCEPTANCE_THRESHOLDS.minFirstPassRate &&
      current.netEconomyUsd > ACCEPTANCE_THRESHOLDS.minNetEconomyUsd,
    `successRate=${current.successRate}, firstPassRate=${current.firstPassRate}`,
  );
  const ok = checks.every((item) => item.ok);
  const degraded = checks.some((item) => !item.ok && ["no_degradation", "thresholds"].includes(item.id));
  return {
    ok,
    checks,
    next: ok ? "canary" : degraded ? "blocked" : "hold",
    canaryShare: ok ? LORA_CANARY_TRAFFIC_SHARE : LORA_SHADOW_TRAFFIC_SHARE,
  };
}

/**
 * Переводит теневую запись в канареечный режим с малой долей трафика.
 * Прямой переход на полный трафик в этом интерфейсе отсутствует.
 */
export function promoteShadowToCanary(
  rollout: LoraRollout,
  comparison: LoraShadowComparison,
  options: { now?: Date } = {},
): LoraRollout {
  if (comparison.next !== "canary" || !comparison.ok) {
    throw new Error("LORA_SHADOW_GATE_FAILED: переход в canary разрешён только после успешного сравнения");
  }
  return {
    ...rollout,
    mode: "canary",
    enabledAt: (options.now ?? new Date()).toISOString(),
    trafficShare: LORA_CANARY_TRAFFIC_SHARE,
    canaryShare: LORA_CANARY_TRAFFIC_SHARE,
  };
}

/** Откатывает адаптер: обе доли трафика обнуляются, возврат к эталону явный. */
export function rollbackLoraAdapter(
  rollout: LoraRollout,
  reason: string,
  options: { now?: Date } = {},
): LoraAdapterRollback {
  return {
    kind: "lora-adapter-rollback",
    version: LORA_ROLLOUT_VERSION,
    adapterId: rollout.adapterId,
    rolledBackAt: (options.now ?? new Date()).toISOString(),
    reason,
    trafficShare: 0,
    canaryShare: 0,
    command: rollout.rollbackCommand,
  };
}

function generateSummary(
  health: HealthScore,
  anomalies: Anomaly[],
  trends: Trend[],
  recommendations: Recommendation[],
): string {
  const parts: string[] = [];

  // Здоровье
  parts.push(
    t("selfAnalysis.health", {
      level: t(`selfAnalysis.level.${health.level}`),
      score: health.score,
    }),
  );

  // Аномалии
  if (anomalies.length > 0) {
    const highSeverity = anomalies.filter(a => a.severity > 70).length;
    if (highSeverity > 0) {
      parts.push(t("selfAnalysis.anomaliesHigh", { count: highSeverity }));
    } else {
      parts.push(t("selfAnalysis.anomaliesAll", { count: anomalies.length }));
    }
  } else {
    parts.push(t("selfAnalysis.noAnomalies"));
  }

  // Тренды
  const degradingTrends = trends.filter(trend => trend.direction === "degrading").length;
  if (degradingTrends > 0) {
    parts.push(t("selfAnalysis.degrading", { count: degradingTrends }));
  }

  // Рекомендации
  const highPriority = recommendations.filter(r => r.priority >= 7).length;
  if (highPriority > 0) {
    parts.push(t("selfAnalysis.highPriority", { count: highPriority }));
  }

  return parts.join(". ") + ".";
}

// ==================== Export ====================
