/**
 * D16 (IM-15): отладочный режим с подробными логами.
 *
 * Включается флагом CLI `--debug` или переменной `AGENT_STEWARD_DEBUG=1`.
 * Все сообщения идут в stderr, ключи-секреты и Bearer-токены редактируются.
 * Модуль не читает часы и не имеет побочных эффектов при выключенном режиме.
 */

export const DEBUG_ENV = "AGENT_STEWARD_DEBUG";

let forced: boolean | undefined;

function envEnabled(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof process.env === "object" &&
    /^(1|true|yes)$/i.test(String(process.env[DEBUG_ENV] ?? ""))
  );
}

/** Включён ли подробный вывод логов. */
export function isDebugEnabled(): boolean {
  return forced ?? envEnabled();
}

/** Явно задаёт режим (используется CLI и тестами). */
export function setDebugEnabled(value: boolean): void {
  forced = value;
}

/** Убирает `--debug` из argv и сообщает, был ли он задан. */
export function parseDebugArgs(args: readonly string[]): { args: string[]; debug: boolean } {
  const rest: string[] = [];
  let debug = false;
  for (const arg of args) {
    if (arg === "--debug") {
      debug = true;
      continue;
    }
    rest.push(arg);
  }
  return { args: rest, debug };
}

const SECRET_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|credential)/i;
const SECRET_ASSIGNMENT =
  /\b(token|secret|password|api[_-]?key|authorization|cookie|credential)\b(\s*[:=]\s*)(["']?)[^\s"',;}]+/gi;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Возвращает безопасный для лога текст: секреты заменены на `<redacted>`. */
export function redactDebug(value: unknown): string {
  const seen = new WeakSet<object>();
  const scrub = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input.replace(BEARER, "Bearer <redacted>").replace(SECRET_ASSIGNMENT, (_all, key, sep, quote) => `${key}${sep}${quote}<redacted>`);
    }
    if (Array.isArray(input)) return input.map(scrub);
    if (input && typeof input === "object") {
      if (seen.has(input)) return "<circular>";
      seen.add(input);
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, item]) => [
          key,
          SECRET_KEY.test(key) ? "<redacted>" : scrub(item),
        ]),
      );
    }
    return input;
  };
  const safe = scrub(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}

/** Пишет отладочную строку в stderr; в обычном режиме — no-op. */
export function debugLog(scope: string, message: string, details?: unknown): void {
  if (!isDebugEnabled()) return;
  const suffix = details === undefined ? "" : ` ${redactDebug(details)}`;
  const line = `[debug][${scope}] ${redactDebug(message)}${suffix}`;
  if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
    process.stderr.write(`${line}\n`);
  } else {
    console.debug(line);
  }
}
