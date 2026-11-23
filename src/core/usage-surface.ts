/**
 * QV-11.1: офлайн-оценка размера поверхности инструментов без вызова платной
 * модели. Точный tiktoken не нужен: нам важна сравнимая метрика «было/стало»
 * и число description', чтобы видеть раздувание реестра.
 */

export interface ToolSurfaceSpec {
  name: string;
  description?: string;
  input?: unknown;
}

export interface ToolSurfaceMeasurement {
  tools: number;
  descriptionChars: number;
  schemaChars: number;
  descriptionCount: number;
  estimatedTokens: number;
}

/** Резервная грубая оценка: ~4 символа на токен (только без токенайзера). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * T-6.2: офлайн-оценка расхода запуска, когда free-провайдер не пишет usage
 * ни в лог, ни в собственную БД OpenCode. Оценка грубая, но детерминированная
 * и воспроизводимая: промпт задачи = вход, хвост лога = выход.
 */
export interface RunUsageEstimateOptions {
  prompt?: string;
  logText?: string;
  /** Цена за 1M токенов; 0 для локальных/free, null/undefined — цена неизвестна. */
  pricePerMillion?: number | null;
  /** Реальный офлайн-токенайзер; по умолчанию ~4 символа на токен. */
  countTokens?: (text: string) => number;
}

export interface RunUsageEstimate {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  source: "offline";
}

export function estimateRunUsage(options: RunUsageEstimateOptions = {}): RunUsageEstimate {
  const count = options.countTokens ?? estimateTokens;
  const inputTokens = count((options.prompt ?? "").trim());
  const outputTokens = count((options.logText ?? "").trim());
  const tokens = inputTokens + outputTokens;
  const price = options.pricePerMillion;
  let costUsd: number | undefined;
  if (tokens > 0 && typeof price === "number" && Number.isFinite(price) && price >= 0) {
    costUsd = Math.round((tokens / 1_000_000) * price * 1_000_000) / 1_000_000;
  }
  return { tokens, inputTokens, outputTokens, costUsd, source: "offline" };
}

export interface MeasureToolSurfaceOptions {
  /** Реальный офлайн-токенайзер (например, encode из gpt-tokenizer). */
  countTokens?: (text: string) => number;
}

export function measureToolSurface(
  specs: readonly ToolSurfaceSpec[],
  options: MeasureToolSurfaceOptions = {},
): ToolSurfaceMeasurement {
  let descriptionChars = 0;
  let schemaChars = 0;
  let descriptionCount = 0;

  for (const spec of specs) {
    if (spec.description) {
      descriptionChars += spec.description.length;
      descriptionCount += 1;
    }
    if (spec.input !== undefined) {
      try {
        schemaChars += JSON.stringify(spec.input).length;
      } catch {
        schemaChars += "[unserializable]".length;
      }
    }
  }

  return {
    tools: specs.length,
    descriptionChars,
    schemaChars,
    descriptionCount,
    estimatedTokens: options.countTokens
      ? options.countTokens(
        specs
          .map((spec) => `${spec.name} ${spec.description ?? ""} ${JSON.stringify(spec.input ?? null)}`)
          .join("\n"),
      )
      : estimateTokens(
        specs
          .map((spec) => `${spec.name} ${spec.description ?? ""} ${JSON.stringify(spec.input ?? null)}`)
          .join("\n"),
      ),
  };
}
