/**
 * D04 / IM-4: батч-вызов инструментов с изоляцией результатов.
 *
 * Один вызов `batch_call` принимает до BATCH_CALL_LIMIT операций; каждая
 * операция проверяется своей Zod-схемой и исполняется отдельно. Ошибка одного
 * вызова не отменяет остальные и не пробрасывает исключение наружу — наружу
 * возвращается структурированный отчёт с per-call результатами.
 */
import type { z } from "zod";
import type { ToolSpec } from "../tool-specs.js";

export const BATCH_CALL_LIMIT = 20;

export interface BatchCallRequest {
  name: string;
  args: Record<string, unknown>;
}

export interface BatchCallResult {
  index: number;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function textOf(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part: any) => (typeof part?.text === "string" ? part.text : part));
    }
  }
  return result ?? null;
}

/**
 * Исполняет список вызовов по реестру спеки, изолируя ошибки.
 * `execute` может быть как синхронным, так и асинхронным.
 */
export async function executeBatchCalls(
  specs: readonly Pick<ToolSpec, "name" | "input" | "execute">[],
  calls: readonly BatchCallRequest[],
): Promise<BatchCallResult[]> {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  if (calls.length > BATCH_CALL_LIMIT) {
    return [
      {
        index: 0,
        name: "batch_call",
        ok: false,
        error: `batch_call: лимит ${BATCH_CALL_LIMIT} вызовов превышен (${calls.length})`,
      },
    ];
  }
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const results: BatchCallResult[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const name = typeof call?.name === "string" ? call.name : String(call?.name ?? "");
    const spec = byName.get(name);
    if (!spec) {
      results.push({ index, name, ok: false, error: `batch_call: неизвестный инструмент «${name}»` });
      continue;
    }
    try {
      const parsed = (spec.input).parse(call.args ?? {});
      const raw = await (spec.execute as (args: unknown) => unknown)(parsed);
      results.push({ index, name, ok: true, result: textOf(raw) });
    } catch (err) {
      results.push({
        index,
        name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
