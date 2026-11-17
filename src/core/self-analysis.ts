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
  type BuildAnalyticsOptions,
} from "./analytics.js";
import {
  computeSavings,
  type SavingsRecord,
  type SavingsReport,
} from "./savings.js";

// ==================== Типы ====================

/** Оценка здоровья системы (0-100). */
export interface HealthScore {
  /** Итоговый балл (0-100). */
  score: number;
  /** Описание уровня здоровья. */
  level: "excellent" | "good" | "fair" | "poor" | "critical";
  /** Детальные метрики, из которых сложился балл. */
  components: {
    successRate: number;
    errorRate: number;
    avgDurationMs: number;
    timeoutRate: number;
    crashRecoveryRate: number;
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
  /** Метаданные источников данных. */
  sources: {
    historyRecords: number;
    recordsInWindow: number;
    tasksAnalyzed: number;
  };
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

// ==================== Health Score ====================

/** Рассчитывает общий балл здоровья системы. */
export function calculateHealthScore(report: AnalyticsReport): HealthScore {
  const { totals, tasks, errors } = report;

  // Компоненты здоровья (0-100)
  const successRateScore = totals.successRate;
  const errorRateScore = Math.max(0, 100 - (totals.error / Math.max(1, totals.total)) * 100);
  const avgDurationScore = Math.min(100, Math.max(0, 100 - (totals.avgDurationMs / 300000) * 100)); // 5 минут = 0 баллов
  const timeoutRateScore = Math.min(100, Math.max(0, 100 - (errors.filter(e => e.message.includes("timeout")).length / Math.max(1, totals.total)) * 100));
  const crashRecoveryRateScore = Math.min(100, Math.max(0, 100 - (errors.filter(e => e.message.includes("Прервано")).length / Math.max(1, totals.total)) * 100));

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
    recommendations.push("Повысьте успешность запусков: проверьте Quality Gate и логи ошибок");
  }
  if (errorRateScore < 80) {
    recommendations.push("Снизьте частоту ошибок: добавьте retryCount для флакких задач");
  }
  if (avgDurationScore < 70) {
    recommendations.push("Оптимизируйте длительность: разбейте длинные задачи или увеличьте timeoutSeconds");
  }
  if (timeoutRateScore < 80) {
    recommendations.push("Уменьшите количество таймаутов: увеличьте timeoutSeconds или упростите промпты");
  }
  if (crashRecoveryRateScore < 90) {
    recommendations.push("Снизьте количество прерванных запусков: проверьте стабильность системы");
  }

  return {
    score,
    level,
    components: {
      successRate: successRateScore,
      errorRate: errorRateScore,
      avgDurationMs: avgDurationScore,
      timeoutRate: timeoutRateScore,
      crashRecoveryRate: crashRecoveryRateScore,
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

  for (const [taskKey, taskRecords] of byTask) {
    const taskName = taskRecords[0]?.taskName || taskKey;

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
  const allSuccess = recent.every(r => r.status === "success");

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
        taskId: (running as any).id,
      },
    };
  }
  return null;
}

// ==================== Trend Analysis ====================

/** Анализирует тренды метрик. */
export function analyzeTrends(
  records: AnalyticsRecord[],
  options: SelfAnalysisOptions = {},
): Trend[] {
  const trends: Trend[] = [];
  const windowDays = options.days ?? 14;

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
      tasksAnalyzed: analyticsReport.tasks.length,
    },
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
  const levelNames = {
    excellent: "отличное",
    good: "хорошее",
    fair: "удовлетворительное",
    poor: "плохое",
    critical: "критическое",
  };
  parts.push(`Здоровье системы: ${levelNames[health.level]} (${health.score}/100)`);

  // Аномалии
  if (anomalies.length > 0) {
    const highSeverity = anomalies.filter(a => a.severity > 70).length;
    if (highSeverity > 0) {
      parts.push(`Обнаружено ${highSeverity} критических аномалий`);
    } else {
      parts.push(`Обнаружено ${anomalies.length} аномалий (все некритические)`);
    }
  } else {
    parts.push("Критических аномалий не обнаружено");
  }

  // Тренды
  const degradingTrends = trends.filter(t => t.direction === "degrading").length;
  if (degradingTrends > 0) {
    parts.push(`${degradingTrends} метрик ухудшаются`);
  }

  // Рекомендации
  const highPriority = recommendations.filter(r => r.priority >= 7).length;
  if (highPriority > 0) {
    parts.push(`${highPriority} рекомендаций высокого приоритета`);
  }

  return parts.join(". ") + ".";
}

// ==================== Export ====================
