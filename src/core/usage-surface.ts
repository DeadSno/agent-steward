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
