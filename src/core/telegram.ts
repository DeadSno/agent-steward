import { t } from "../i18n.js";

/**
 * Telegram Bot API: отправка уведомлений (Спринт 25).
 *
 * Модуль намеренно не зависит от настроек и сетевого слоя приложения:
 * всё, что нужно, передаётся аргументами. Это позволяет тестировать
 * экранирование и сборку запроса без реальных вызовов Telegram.
 */
export type TelegramParseMode = "" | "HTML" | "Markdown" | "MarkdownV2";

/** Таймаут запроса по умолчанию. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TelegramSendOptions {
  /** База API; по умолчанию https://api.telegram.org. */
  apiBase?: string;
  /** Разметка; пусто — plain text. */
  parseMode?: TelegramParseMode;
  /** Отправить без звука. */
  disableNotification?: boolean;
  /** ID темы форума, если указан. */
  messageThreadId?: number | null;
  /** Добавить ссылку на дашборд. */
  includeDashboardLink?: boolean;
  /** URL дашборда; null/пусто — ссылка не добавляется. */
  dashboardUrl?: string | null;
  /** Таймаут запроса в мс. */
  timeoutMs?: number;
  /** Подмена fetch для тестов. */
  fetchImpl?: typeof fetch;
}

/** Экранирует текст под выбранный parse_mode. */
export function escapeTelegramText(
  text: string,
  parseMode: TelegramParseMode = ""
): string {
  const value = String(text ?? "");
  if (parseMode === "HTML") {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  if (parseMode === "MarkdownV2") {
    return value.replace(/([\\_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
  }
  if (parseMode === "Markdown") {
    return value.replace(/([\\_*[\]`])/g, "\\$1");
  }
  return value;
}

/** Экранирует URL для HTML-атрибута. */
function escapeHtmlAttribute(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Готовит текст сообщения: экранирует пользовательские данные и добавляет
 * ссылку на дашборд в разметке выбранного режима.
 */
export function formatTelegramText(
  text: string,
  parseMode: TelegramParseMode = "",
  dashboardUrl?: string | null
): string {
  const body = escapeTelegramText(text, parseMode);
  const url = (dashboardUrl ?? "").trim();
  if (!url) return body;

  if (parseMode === "HTML") {
    return `${body}\n\n<a href="${escapeHtmlAttribute(url)}">${t("notify.telegram.openDashboard")}</a>`;
  }
  if (parseMode === "MarkdownV2") {
    const escapedUrl = url.replace(/[)\\]/g, "\\$&");
    return `${body}\n\n[${t("notify.telegram.openDashboard")}](${escapedUrl})`;
  }
  if (parseMode === "Markdown") {
    const escapedUrl = url.replace(/[)]/g, "\\)");
    return `${body}\n\n[${t("notify.telegram.openDashboard")}](${escapedUrl})`;
  }
  return `${body}\n\n${t("notify.telegram.openDashboardUrl", { url })}`;
}

/** Проверяет формат токена бота; возвращает trimmed-значение. */
export function validateTelegramToken(token: string): string {
  const value = (token ?? "").trim();
  if (!value) {
    throw new Error(t("notify.error.telegramTokenMissing"));
  }
  // Формат BotFather: <digits>:<base64-ish>. Проверяем достаточно мягко,
  // чтобы не ломать тестовые токены, но отсекать явный мусор.
  if (!/^\d+:[A-Za-z0-9_-]{5,}$/.test(value)) {
    throw new Error(t("notify.error.telegramTokenInvalid"));
  }
  return value;
}

/** Маскирует токен для сообщений об ошибках и логов. */
export function maskTelegramToken(token: string): string {
  const value = (token ?? "").trim();
  if (!value) return "***";
  const colon = value.indexOf(":");
  if (colon <= 0) return "***";
  const id = value.slice(0, colon);
  const secret = value.slice(colon + 1);
  const tail = secret.length >= 4 ? secret.slice(-4) : "";
  return `${id}:***${tail}`;
}

/** Убирает токен из произвольного текста ошибки. */
function sanitizeErrorText(text: string, token: string): string {
  if (!text) return text;
  return text.split(token).join(maskTelegramToken(token));
}

function resolveApiBase(apiBase?: string): string {
  const value = (apiBase ?? "https://api.telegram.org").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(t("notify.error.telegramApiBaseInvalid"));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(t("notify.error.telegramScheme"));
  }
  return value;
}

/** Лимит одного сообщения Telegram Bot API. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Сколько раз повторяем отправку при HTTP 429. */
const TELEGRAM_MAX_RETRIES = 3;

/**
 * Режет длинный текст на части по лимиту Bot API (4096 UTF-16 code units).
 * Старается рвать по переводу строки, не разрывает surrogate pair и
 * экранированный символ MarkdownV2 (`\x`).
 */
export function splitTelegramMessage(
  text: string,
  limit = TELEGRAM_MAX_MESSAGE_LENGTH
): string[] {
  const value = String(text ?? "");
  const max = Math.max(1, Math.floor(limit));
  if (!value) return [""];
  const chunks: string[] = [];
  let rest = value;
  while (rest.length > max) {
    let cut = max;
    const newline = rest.lastIndexOf("\n", max);
    if (newline > max * 0.5) cut = newline + 1;
    // Не разрываем surrogate pair (эмодзи и т.п.).
    if (cut > 0 && cut < rest.length) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    // MarkdownV2: обратный слэш должен остаться вместе с экранируемым символом.
    if (cut > 0 && rest[cut - 1] === "\\") cut -= 1;
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/** Спецсимволы MarkdownV2 (должны совпадать с escapeTelegramText). */
const MARKDOWN_V2_SPECIAL = new Set("\\_*[]()~`>#+-=|{}.!".split(""));
/** Спецсимволы legacy Markdown. */
const MARKDOWN_SPECIAL = new Set("\\_*[]`".split(""));

/** Сколько UTF-16 code units займёт символ после экранирования. */
function escapedCharLength(ch: string, parseMode: TelegramParseMode): number {
  if (parseMode === "HTML") {
    if (ch === "&") return 5;
    if (ch === "<" || ch === ">") return 4;
    return ch.length;
  }
  if (parseMode === "MarkdownV2") {
    return MARKDOWN_V2_SPECIAL.has(ch) ? ch.length + 1 : ch.length;
  }
  if (parseMode === "Markdown") {
    return MARKDOWN_SPECIAL.has(ch) ? ch.length + 1 : ch.length;
  }
  return ch.length;
}

/** Длина текста после экранирования под parse_mode. */
function formattedLength(text: string, parseMode: TelegramParseMode): number {
  let total = 0;
  for (const ch of String(text ?? "")) {
    total += escapedCharLength(ch, parseMode);
  }
  return total;
}

/**
 * Возвращает индекс конца сырого чанка, который после экранирования
 * укладывается в maxFormatted. Старается рвать по переводу строки и никогда
 * не разрывает surrogate pair.
 */
function cutRawChunk(
  text: string,
  start: number,
  maxFormatted: number,
  parseMode: TelegramParseMode
): number {
  let index = start;
  let used = 0;
  let lastNewline = -1;
  while (index < text.length) {
    const codePoint = text.codePointAt(index) as number;
    const ch = String.fromCodePoint(codePoint);
    const cost = escapedCharLength(ch, parseMode);
    if (used + cost > maxFormatted) break;
    used += cost;
    index += ch.length;
    if (ch === "\n") lastNewline = index;
  }
  if (index < text.length && index > start && lastNewline > start) {
    const consumed = index - start;
    if (lastNewline - start > consumed * 0.5) index = lastNewline;
  }
  if (index <= start) {
    // Гарантируем прогресс хотя бы на один code point.
    const codePoint = text.codePointAt(start) as number;
    index = start + String.fromCodePoint(codePoint).length;
  }
  return index;
}

/**
 * Режет СЫРОЙ текст так, чтобы каждый отформатированный чанк укладывался в
 * лимит Telegram. Резать уже экранированный текст нельзя: HTML-сущности
 * (&amp;, &lt;) и MarkdownV2-экранирование (\*) могут разорваться между
 * сообщениями, и Bot API отвечает 400 «can't parse entities».
 * linkReserve — запас под ссылку на дашборд в последнем чанке.
 */
function splitRawMessageForSend(
  text: string,
  limit: number,
  parseMode: TelegramParseMode,
  linkReserve = 0
): string[] {
  const value = String(text ?? "");
  const max = Math.max(1, Math.floor(limit));
  if (!value) return [""];

  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    const end = cutRawChunk(value, start, max, parseMode);
    chunks.push(value.slice(start, end));
    start = end;
  }

  if (linkReserve > 0 && chunks.length > 0) {
    const maxLast = Math.max(1, max - linkReserve);
    const lastStart = value.length - chunks[chunks.length - 1].length;
    if (formattedLength(value.slice(lastStart), parseMode) > maxLast) {
      // Пересобираем хвост с меньшим лимитом, чтобы влезла ссылка.
      chunks.splice(chunks.length - 1, 1);
      let tailStart = lastStart;
      while (tailStart < value.length) {
        const end = cutRawChunk(value, tailStart, maxLast, parseMode);
        chunks.push(value.slice(tailStart, end));
        tailStart = end;
      }
    }
  }
  return chunks;
}

/** Пауза без утечки таймера. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // timer.unref?.() УБРАН: процесс не должен завершаться во время 429-ретрая,
    // иначе уведомление теряется (record-history — короткоживущий процесс,
    // event loop не удерживается unref-таймером).
  });
}

/**
 * Отправляет сообщение через Bot API `sendMessage`.
 *
 * Длинный текст режется на части по 4096 символов. При HTTP 429 отправка
 * повторяется с учётом `parameters.retry_after` (не более 3 повторов).
 * Бросает Error с безопасным текстом (токен замаскирован). Вызывающий код
 * обязан перехватить ошибку, чтобы уведомление не ломало задачу.
 */
export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  options: TelegramSendOptions = {}
): Promise<void> {
  const safeToken = validateTelegramToken(token);
  const target = (chatId ?? "").trim();
  if (!target) {
    throw new Error(t("notify.error.telegramChatMissing"));
  }

  const apiBase = resolveApiBase(options.apiBase);
  const parseMode = options.parseMode ?? "";
  const dashboardUrl =
    options.includeDashboardLink === false ? null : options.dashboardUrl;
  // Ссылку добавляем только в последний чанк, поэтому её длину резервируем
  // заранее: formatTelegramText("") возвращает ровно суффикс со ссылкой.
  const linkSuffix = dashboardUrl
    ? formatTelegramText("", parseMode, dashboardUrl)
    : "";
  const rawChunks = splitRawMessageForSend(
    text,
    TELEGRAM_MAX_MESSAGE_LENGTH,
    parseMode,
    linkSuffix.length
  );

  const timeoutMs = Math.max(
    1_000,
    Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${apiBase}/bot${safeToken}/sendMessage`;

  for (let chunkIndex = 0; chunkIndex < rawChunks.length; chunkIndex++) {
    const isLastChunk = chunkIndex === rawChunks.length - 1;
    // Форматируем каждый сырой чанк отдельно: экранированные сущности
    // (&amp;, \*) никогда не разрываются между сообщениями.
    const chunk = formatTelegramText(
      rawChunks[chunkIndex],
      parseMode,
      isLastChunk ? dashboardUrl : null
    );
    let parseModeForChunk = parseMode;
    let downgradedParseMode = false;

    for (let attempt = 0; ; attempt++) {
      const body: Record<string, unknown> = { chat_id: target, text: chunk };
      if (parseModeForChunk) body.parse_mode = parseModeForChunk;
      if (options.disableNotification) body.disable_notification = true;
      if (
        typeof options.messageThreadId === "number" &&
        Number.isFinite(options.messageThreadId) &&
        options.messageThreadId > 0
      ) {
        body.message_thread_id = Math.floor(options.messageThreadId);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        const raw = await response.text().catch(() => "");
        let parsed: any = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        if (response.status === 429 && attempt < TELEGRAM_MAX_RETRIES) {
          const retryAfter = Number(parsed?.parameters?.retry_after);
          const delaySeconds = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(60, Math.ceil(retryAfter))
            : Math.min(30, 2 ** attempt);
          await sleep(delaySeconds * 1000);
          continue;
        }

        const description =
          (typeof parsed?.description === "string" && parsed.description) ||
          raw.slice(0, 200) ||
          `HTTP ${response.status}`;

        // Страховка: если Telegram всё равно не разобрал разметку, повторяем
        // тот же чанк без parse_mode — лучше без форматирования, чем потерять
        // уведомление целиком.
        if (
          response.status === 400 &&
          parseModeForChunk &&
          !downgradedParseMode &&
          /parse entities|can't parse|unsupported start tag|can't find end/i.test(
            description
          )
        ) {
          downgradedParseMode = true;
          parseModeForChunk = "";
          continue;
        }

        if (!response.ok || parsed?.ok === false) {
          throw new Error(
            `Telegram API: ${sanitizeErrorText(description, safeToken)}`
          );
        }
        break;
      } catch (err: any) {
        if (err?.name === "AbortError") {
          throw new Error(
            t("notify.error.telegramTimeout", {
              seconds: Math.floor(timeoutMs / 1000),
            })
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(sanitizeErrorText(message, safeToken));
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
