import type { TriageRule, TriageRuleAction } from "../settings.js";
import type {
  TriageCategory,
  TriageInput,
  TriageSeverity,
  TriageVerdict,
} from "./triage.js";

/**
 * Rules-движок триажа (Спринт 30.4).
 *
 * Проверяет правила по убыванию priority, при равенстве — в порядке массива.
 * Срабатывает только первое совпавшее правило. Движок чистый: ничего не
 * отправляет и не пишет в БД, поэтому его легко использовать в 30.5.
 */

export interface TriageRuleResult {
  matched: boolean;
  ruleId?: string;
  action: TriageRuleAction;
  verdict: TriageVerdict;
}

const DEFAULT_REASON = "Правило не совпало.";

/**
 * Встроенные правила. Работают, если в настройках нет поля `rules`
 * (пустой массив отключает их). Специфичные ошибки важнее статуса.
 */
export const DEFAULT_TRIAGE_RULES: readonly TriageRule[] = [
  {
    id: "error-timeout",
    field: "error",
    operator: "regex",
    value: "timeout|timed out|таймаут|deadline exceeded",
    category: "timeout",
    severity: "high",
    confidence: 0.9,
    priority: 100,
    reason: "В ошибке есть признак таймаута.",
  },
  {
    id: "error-permission",
    field: "error",
    operator: "regex",
    value:
      "permission denied|access denied|eacces|unauthorized|forbidden|доступ запрещ|нет прав",
    category: "permission",
    severity: "high",
    confidence: 0.9,
    priority: 100,
    reason: "В ошибке есть признак отказа доступа.",
  },
  {
    id: "error-network",
    field: "error",
    operator: "regex",
    value:
      "econnrefused|enotfound|eai_again|network error|connection reset|dns|сеть недоступна|соединение",
    category: "network",
    severity: "high",
    confidence: 0.85,
    priority: 100,
    reason: "В ошибке есть признак сетевой проблемы.",
  },
  {
    id: "error-quality",
    field: "error",
    operator: "regex",
    value: "quality gate|tests? failed|build failed|lint|тест[ыа]? не прош|сборка",
    category: "quality",
    severity: "high",
    confidence: 0.85,
    priority: 100,
    reason: "В ошибке есть признак проблемы качества.",
  },
  {
    id: "cost-high",
    field: "cost",
    operator: "gte",
    value: 1,
    category: "unknown",
    severity: "high",
    confidence: 0.85,
    priority: 90,
    reason: "Стоимость запуска $1 и выше.",
  },
  {
    id: "task-important",
    field: "task",
    operator: "regex",
    value:
      "deploy|release|publish|production|backup|restore|migrat|релиз|бэкап|миграц",
    category: "unknown",
    severity: "high",
    confidence: 0.8,
    priority: 80,
    reason: "Важная задача: deploy, release, backup или миграция.",
  },
  {
    id: "status-error",
    field: "status",
    operator: "equals",
    value: "error",
    category: "unknown",
    severity: "high",
    confidence: 0.8,
    priority: 10,
    reason: "Задача завершилась ошибкой.",
  },
  {
    id: "status-partial",
    field: "status",
    operator: "equals",
    value: "partial",
    category: "unknown",
    severity: "medium",
    confidence: 0.8,
    priority: 10,
    reason: "Часть работы завершилась ошибкой.",
  },
  {
    id: "status-success",
    field: "status",
    operator: "equals",
    value: "success",
    category: "unknown",
    severity: "low",
    confidence: 0.8,
    priority: 10,
    reason: "Задача завершилась успешно.",
  },
];

function textFor(field: TriageRule["field"], input: TriageInput): string | null {
  switch (field) {
    case "status":
      return input.status ?? "";
    case "task":
      return input.taskName ?? "";
    case "error":
      return input.error ?? "";
    default:
      return null;
  }
}

function compareNumber(actual: number, operator: TriageRule["operator"], expected: number): boolean {
  switch (operator) {
    case "equals":
      return actual === expected;
    case "gt":
      return actual > expected;
    case "lt":
      return actual < expected;
    case "gte":
      return actual >= expected;
    case "lte":
      return actual <= expected;
    default:
      return false;
  }
}

function matches(rule: TriageRule, input: TriageInput): boolean {
  if (rule.field === "cost") {
    const cost = Number(input.costUsd);
    if (!Number.isFinite(cost) || typeof rule.value !== "number") return false;
    return compareNumber(cost, rule.operator, rule.value);
  }

  const text = textFor(rule.field, input);
  if (text === null || typeof rule.value !== "string") return false;

  if (rule.operator === "equals") {
    return text.trim().toLowerCase() === rule.value.trim().toLowerCase();
  }
  if (rule.operator === "contains") {
    return text.toLowerCase().includes(rule.value.toLowerCase());
  }
  if (rule.operator === "regex") {
    try {
      return new RegExp(rule.value, "i").test(text);
    } catch {
      return false;
    }
  }
  return false;
}

function conditionLabel(rule: TriageRule): string {
  return rule.id ?? `${rule.field} ${rule.operator} ${rule.value}`;
}

/** Оценивает одно уведомление по правилам. Не бросает исключений. */
export function evaluateTriageRules(
  input: TriageInput,
  rules: readonly TriageRule[] | undefined = DEFAULT_TRIAGE_RULES,
): TriageRuleResult {
  const ordered = (rules ?? [])
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        (b.rule.priority ?? 0) - (a.rule.priority ?? 0) || a.index - b.index,
    );

  for (const { rule } of ordered) {
    if (!matches(rule, input)) continue;

    const category = (rule.category ?? "unknown");
    const severity = (rule.severity ?? "medium");
    const confidence =
      typeof rule.confidence === "number" && Number.isFinite(rule.confidence)
        ? Math.min(1, Math.max(0, rule.confidence))
        : 0.8;
    const reason =
      rule.reason?.trim() ||
      `Правило "${conditionLabel(rule)}" совпало: ${rule.field} ${rule.operator} ${rule.value}.`;

    return {
      matched: true,
      ruleId: rule.id,
      action: rule.action ?? "notify",
      verdict: { category, severity, confidence, reason },
    };
  }

  return {
    matched: false,
    action: "notify",
    verdict: {
      category: "unknown",
      severity: "low",
      confidence: 0,
      reason: DEFAULT_REASON,
    },
  };
}
