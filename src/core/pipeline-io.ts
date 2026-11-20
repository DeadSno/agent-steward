import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
export async function loadPipelineFile(
  filePath: string,
  baseDir?: string,
): Promise<PipelineParseResult> {
  // PL-34: cwd процесса-хоста OpenCode может не совпадать с каталогом задачи.
  // Пробуем явный baseDir, затем cwd и подсказки окружения.
  const roots = [
    baseDir?.trim(),
    process.cwd(),
    process.env.OPENCODE_PROJECT_DIR,
    process.env.INIT_CWD,
  ].filter((root): root is string => Boolean(root));
  const candidates = isAbsolute(filePath)
    ? [filePath]
    : roots.map((root) => resolve(root, filePath));
  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return parsePipelineYaml(await readFile(candidate, "utf8"));
    } catch (err) {
      lastError = err;
    }
  }
  return {
    ok: false,
    errors: [{ path: filePath, message: `Не удалось прочитать файл: ${issueMessage(lastError)}` }],
    warnings: [],
  };
}
