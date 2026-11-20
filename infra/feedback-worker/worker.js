/**
 * Деталь 3.8 (F-2) — write-only приёмник баг-репортов → GitHub Issues.
 *
 * Задача воркера: принять структурированный payload от плагина, проверить
 * контракт, отфильтровать ботов и создать issue в репозитории автора.
 *
 * ВАЖНО (приватность):
 *   - PAT живёт только в секрете GITHUB_TOKEN воркера (не в npm-пакете);
 *   - в логи не пишется ни сам payload, ни email, ни логи задачи —
 *     только reportId, HTTP-статус и понятная причина отказа;
 *   - поле `website` — honeypot: боты заполняют его, люди — никогда.
 *
 * Файл — обычный ESM JS (не TypeScript), чтобы его можно было тестировать
 * в Node напрямую через import, без wrangler dev.
 */

/** Лимиты контракта. Должны совпадать с src/core/feedback.ts. */
export const LIMITS = Object.freeze({
  description: 4000,
  logs: 8000,
  contactEmail: 254,
  taskName: 200,
  reportId: 128,
  body: 64 * 1024,
});

/** Окно rate-limit по IP: не более N запросов за окно. */
export const RATE_LIMIT = Object.freeze({ windowMs: 60 * 60_000, max: 10 });
/** Время жизни записи о доставленном reportId (дедуп), секунды. */
export const DEDUP_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REPO = "DeadSno/agent-steward";
export const ISSUE_LABELS = ["user-report", "needs-triage"];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Хранилище по умолчанию: in-memory, если KV не привязан (локальный тест). */
const memoryRate = new Map();
const memoryDedup = new Map();

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

function clientIp(request) {
  const cf = request.headers?.get?.("cf-connecting-ip");
  if (cf) return cf.trim();
  const forwarded = request.headers?.get?.("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

function isEmail(value) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) && value.length <= LIMITS.contactEmail;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && /^\d{4}-\d{2}-\d{2}T/.test(value);
}

/**
 * Чистая валидация payload (F-2.1). Возвращает `{ok:true}` или
 * `{ok:false,status,error}`. Никаких PII в `error`.
 */
export function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, status: 400, error: "payload must be a JSON object" };
  }
  if (payload.schemaVersion !== 1) {
    return { ok: false, status: 400, error: "unsupported schemaVersion (expected 1)" };
  }
  if (typeof payload.reportId !== "string" || !/^[A-Za-z0-9._:-]{8,}$/.test(payload.reportId) || payload.reportId.length > LIMITS.reportId) {
    return { ok: false, status: 400, error: "invalid reportId" };
  }
  if (!isIsoDate(payload.createdAt)) {
    return { ok: false, status: 400, error: "invalid createdAt" };
  }
  if (typeof payload.description !== "string" || payload.description.trim().length < 1 || payload.description.length > LIMITS.description) {
    return { ok: false, status: 400, error: "invalid description" };
  }
  if (typeof payload.pluginVersion !== "string" || payload.pluginVersion.length > 64) {
    return { ok: false, status: 400, error: "invalid pluginVersion" };
  }
  if (!payload.os || typeof payload.os !== "object" || typeof payload.os.platform !== "string") {
    return { ok: false, status: 400, error: "invalid os" };
  }
  if (typeof payload.node !== "string" || payload.node.length > 64) {
    return { ok: false, status: 400, error: "invalid node" };
  }
  if (payload.locale !== undefined && (typeof payload.locale !== "string" || payload.locale.length > 16)) {
    return { ok: false, status: 400, error: "invalid locale" };
  }
  if (payload.profile !== undefined && (typeof payload.profile !== "string" || payload.profile.length > 64)) {
    return { ok: false, status: 400, error: "invalid profile" };
  }
  if (payload.taskName !== undefined && (typeof payload.taskName !== "string" || payload.taskName.length > LIMITS.taskName)) {
    return { ok: false, status: 400, error: "invalid taskName" };
  }
  if (payload.contactEmail !== undefined && (typeof payload.contactEmail !== "string" || !isEmail(payload.contactEmail))) {
    return { ok: false, status: 400, error: "invalid contactEmail" };
  }
  if (payload.redactedLogs !== undefined && (typeof payload.redactedLogs !== "string" || payload.redactedLogs.length > LIMITS.logs)) {
    return { ok: false, status: 400, error: "invalid redactedLogs" };
  }
  if (payload.metrics !== undefined) {
    if (!payload.metrics || typeof payload.metrics !== "object" || Array.isArray(payload.metrics)) {
      return { ok: false, status: 400, error: "invalid metrics" };
    }
    for (const value of Object.values(payload.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, status: 400, error: "invalid metrics" };
      }
    }
  }
  if (JSON.stringify(payload).length > LIMITS.body) {
    return { ok: false, status: 413, error: "payload too large" };
  }
  return { ok: true };
}

/** Короткая строка для заголовка issue (F-2.3). */
export function issueTitle(payload) {
  const firstLine = payload.description.split("\n").find((line) => line.trim()) ?? "без описания";
  const short = firstLine.trim().replace(/\s+/g, " ").slice(0, 80);
  return `[user-report] ${short}${short.length < firstLine.trim().length ? "…" : ""}`;
}

/** Тело issue с метаданными. ContactEmail добавляется только если его прислал пользователь. */
export function issueBody(payload) {
  const lines = [
    "## Описание",
    "",
    payload.description,
    "",
    "## Метаданные",
    "",
    `- reportId: \`${payload.reportId}\``,
    `- createdAt: ${payload.createdAt}`,
    `- pluginVersion: ${payload.pluginVersion}`,
    `- OS: ${payload.os.platform} ${payload.os.release ?? ""} ${payload.os.arch ?? ""}`.trim(),
    `- Node: ${payload.node}`,
    `- locale: ${payload.locale ?? "—"}`,
    `- profile: ${payload.profile ?? "—"}`,
  ];
  if (payload.taskName) lines.push(`- taskName: ${payload.taskName}`);
  if (payload.contactEmail) lines.push(`- contactEmail: ${payload.contactEmail}`);
  if (payload.metrics) lines.push(`- metrics: \`${JSON.stringify(payload.metrics)}\``);
  if (payload.redactedLogs) {
    lines.push("", "## Логи (уже отредактированы клиентом)", "", "```text", payload.redactedLogs, "```");
  }
  lines.push("", "---", "_Создано автоматически приёмником обратной связи agent-steward._");
  return lines.join("\n");
}

/** Простой rate-limit: KV привязан → KV, иначе in-memory Map. */
async function checkRateLimit(env, ip, now) {
  const key = `rl:${ip}`;
  const store = env.FEEDBACK_RATELIMIT;
  try {
    let hits = 0;
    let since = now;
    if (store && typeof store.get === "function") {
      const raw = await store.get(key, "json");
      if (raw && Number.isFinite(raw.since)) {
        hits = Number(raw.hits) || 0;
        since = raw.since;
      }
    } else {
      const raw = memoryRate.get(key);
      if (raw) {
        hits = raw.hits;
        since = raw.since;
      }
    }
    if (now - since > RATE_LIMIT.windowMs) {
      hits = 0;
      since = now;
    }
    hits += 1;
    const record = JSON.stringify({ hits, since });
    if (store && typeof store.put === "function") {
      await store.put(key, record, { expirationTtl: Math.ceil(RATE_LIMIT.windowMs / 1000) });
    } else {
      memoryRate.set(key, { hits, since });
    }
    return hits <= RATE_LIMIT.max;
  } catch {
    // При отказе KV не блокируем пользователя (fail-open на инфраструктуре).
    return true;
  }
}

async function isDuplicate(env, reportId) {
  const key = `dedup:${reportId}`;
  const store = env.FEEDBACK_DEDUP;
  try {
    if (store && typeof store.get === "function") {
      return (await store.get(key)) !== null;
    }
    return memoryDedup.has(key);
  } catch {
    return false;
  }
}

async function markDelivered(env, reportId, issueUrl) {
  const key = `dedup:${reportId}`;
  const store = env.FEEDBACK_DEDUP;
  try {
    if (store && typeof store.put === "function") {
      await store.put(key, issueUrl || "ok", { expirationTtl: DEDUP_TTL_SECONDS });
    } else {
      memoryDedup.set(key, issueUrl || "ok");
    }
  } catch {
    // Идемпотентность best-effort: GitHub всё равно создаст issue.
  }
}

/** Создаёт issue. Возвращает {ok, issueUrl?, status?, error?}. */
export async function createIssue(payload, env, fetchImpl = globalThis.fetch) {
  const token = env.GITHUB_TOKEN;
  if (!token) return { ok: false, status: 500, error: "receiver is not configured" };
  let response;
  try {
    response = await fetchImpl(`https://api.github.com/repos/${REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "agent-steward-feedback-worker",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        title: issueTitle(payload),
        body: issueBody(payload),
        labels: ISSUE_LABELS,
      }),
    });
  } catch (err) {
    return { ok: false, status: 502, error: "GitHub is unreachable", cause: err instanceof Error ? err.message : String(err) };
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    // ignore
  }
  if (!response.ok) {
    return { ok: false, status: 502, error: "GitHub rejected the issue", upstreamStatus: response.status };
  }
  return { ok: true, issueUrl: data.html_url ?? `https://github.com/${REPO}/issues` };
}

/**
 * Обработчик Cloudflare Worker. Экспортируется как default для wrangler
 * и как named `handleReport` для unit-тестов в Node.
 */
export async function handleReport(request, env, ctx, fetchImpl = globalThis.fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method === "GET" && new URL(request.url).pathname === "/health") {
    return json({ ok: true, service: "agent-steward-feedback" });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405, { allow: "POST, OPTIONS" });
  }
  if (new URL(request.url).pathname !== "/report") {
    return json({ ok: false, error: "not found" }, 404);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  // Honeypot: бот получает те же 200, что и человек, но issue не создаётся.
  if (payload && typeof payload === "object" && payload.website) {
    return json({ ok: true, issueUrl: null });
  }

  if (!(await checkRateLimit(env, clientIp(request), Date.now()))) {
    return json({ ok: false, error: "rate limit exceeded" }, 429, { "retry-after": "3600" });
  }

  const validation = validatePayload(payload);
  if (!validation.ok) {
    return json({ ok: false, error: validation.error }, validation.status);
  }

  if (await isDuplicate(env, payload.reportId)) {
    return json({ ok: true, issueUrl: null, duplicate: true });
  }

  const result = await createIssue(payload, env, fetchImpl);
  if (!result.ok) {
    return json({ ok: false, error: result.error }, result.status ?? 502);
  }
  await markDelivered(env, payload.reportId, result.issueUrl);
  // ctx.waitUntil в Workers; в тесте ctx может отсутствовать.
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(Promise.resolve());
  }
  return json({ ok: true, issueUrl: result.issueUrl });
}

export default { fetch: handleReport };
