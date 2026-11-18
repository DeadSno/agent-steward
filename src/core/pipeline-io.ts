import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  validatePipelineSpec,
  type PipelineIssue,
  type PipelineSpec,
  type PipelineValidationResult,
} from "./pipeline-spec.js";

/** Результат разбора YAML: спека возвращается только при успешной валидации. */
export interface PipelineParseResult extends PipelineValidationResult {
  spec?: PipelineSpec;
}

const MAX_YAML_BYTES = 1024 * 1024;
const MAX_ALIAS_COUNT = 100;

function issueMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Разбирает YAML-текст в `PipelineSpec` и сразу валидирует его.
 * Функция не бросает: синтаксические и смысловые ошибки возвращаются в `errors`.
 */
export function parsePipelineYaml(source: string): PipelineParseResult {
  const errors: PipelineIssue[] = [];
  const warnings: PipelineIssue[] = [];

  if (source.length > MAX_YAML_BYTES) {
    return {
      ok: false,
      errors: [{ path: "$", message: `YAML больше ${MAX_YAML_BYTES} байт` }],
      warnings,
    };
  }

  let data: unknown;
  try {
    const doc = parseDocument(source, {
      prettyErrors: true,
      uniqueKeys: true,
      strict: true,
    });
    if (doc.errors.length > 0) {
      for (const err of doc.errors) {
        errors.push({ path: "$", message: err.message });
      }
      return { ok: false, errors, warnings };
    }
    data = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: "$", message: issueMessage(err) }],
      warnings,
    };
  }

  const result = validatePipelineSpec(data);
  if (!result.ok) return result;

  return { ...result, spec: data as PipelineSpec };
}

/** Читает YAML-файл и валидирует его. Ошибки ввода-вывода также попадают в `errors`. */
export async function loadPipelineFile(filePath: string): Promise<PipelineParseResult> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: filePath, message: `Не удалось прочитать файл: ${issueMessage(err)}` }],
      warnings: [],
    };
  }
  return parsePipelineYaml(source);
}
