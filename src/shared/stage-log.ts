/**
 * D03 / IM-3: единый формат меток этапов в логах задач.
 *
 * Формат обратно совместим: строка остаётся обычной строкой лога и читается
 * человеком, а парсер может выделить этап по префиксу `[stage:<name>]`.
 * Старые логи без префикса разбираются как `{ stage: null }`.
 */
export const STAGE_NAMES = ["preFlight", "run", "postFlight", "gate"] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export interface StageLogLine {
  stage: StageName | null;
  message: string;
}

const STAGE_SET: ReadonlySet<string> = new Set(STAGE_NAMES);

/** Возвращает machine-readable префикс этапа. */
export function stageMarker(stage: StageName): string {
  return `[stage:${stage}]`;
}

/** Форматирует строку лога: `[stage:run] Сообщение`. */
export function formatStageLog(stage: StageName, message: string): string {
  return `${stageMarker(stage)} ${message}`;
}

/** Разбирает строку лога; для строк без метки возвращает stage=null. */
export function parseStageLog(line: string): StageLogLine {
  const match = /^\[stage:([^\]]+)\]\s?(.*)$/.exec(line);
  if (!match) return { stage: null, message: line };
  const name = match[1];
  return {
    stage: STAGE_SET.has(name) ? (name as StageName) : null,
    message: match[2] ?? "",
  };
}
