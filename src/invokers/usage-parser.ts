/**
 * P-3.1: парсер usage из вывода любого инвокера.
 * Не зависит от формата логов OpenCode — работает с общим текстом.
 */
export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
}

const TOKEN_PATTERNS = [
  /input(?:\s+tokens)?[:\s=]+([\d,\s]+)/gi,
  /output(?:\s+tokens)?[:\s=]+([\d,\s]+)/gi,
  /total(?:\s+tokens)?[:\s=]+([\d,\s]+)/gi,
];

export function parseUsageFromText(text: string): ParsedUsage | null {
  if (!text || typeof text !== "string") return null;
  const matchNumber = (pattern: RegExp): number | null => {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) return null;
    const value = Number(match[1].replace(/[,\s]/g, ""));
    return Number.isFinite(value) ? value : null;
  };
  const inputTokens = matchNumber(TOKEN_PATTERNS[0]);
  const outputTokens = matchNumber(TOKEN_PATTERNS[1]);
  const reportedTotal = matchNumber(TOKEN_PATTERNS[2]);
  const costMatch = /\$\s?([\d.]+)/.exec(text);
  const costUsd = costMatch ? Number(costMatch[1]) : null;
  const totalTokens = reportedTotal ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  if (inputTokens === null && outputTokens === null && reportedTotal === null && costUsd === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens,
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
  };
}
