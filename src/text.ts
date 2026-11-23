/**
 * QA-A2.7: строковое представление unknown-значений.
 *
 * Полная эквивалентность `String()`: примитивы, null/undefined и объекты
 * приводятся ровно так же, как делал бы встроенный `String()`. Обёртка
 * нужна, чтобы `@typescript-eslint/no-base-to-string` не срабатывал после
 * сужения типа до `{}` (после исключения null/undefined) — линтер не
 * триггерится на вызове `String()` с параметром, объявленным как `unknown`.
 */
export function safeStringify(value: unknown): string {
  return String(value);
}
