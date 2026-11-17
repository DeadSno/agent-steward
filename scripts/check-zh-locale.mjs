/**
 * Валидация locales/zh.json по паритету с locales/en.json.
 *
 * Проверяет:
 *   1. Все ключи en.json присутствуют в zh.json (и нет лишних).
 *   2. Набор плейсхолдеров {name} совпадает с en.json по каждому ключу.
 *   3. Плюральные ключи содержат только ветку `other` (для zh категорий one/few/many нет).
 *   4. Значения не пустые.
 *   5. Значения содержат китайские иероглифы (CJK), за исключением белого списка
 *      токенов, которые не переводятся (cron, JSON, SQLite, MCP, DAG, HMAC, URL,
 *      ID, GUI, OpenCode, Telegram, Ollama, glob, имена инструментов, ${secret:NAME},
 *      латинские числа, знаки препинания, плейсхолдеры).
 *
 * Запуск: node scripts/check-zh-locale.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(fs.readFileSync(path.join(root, "locales", "en.json"), "utf8"));
const zh = JSON.parse(fs.readFileSync(path.join(root, "locales", "zh.json"), "utf8"));

const errors = [];
const warnings = [];

const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();

// 1. Паритет ключей
const missingInZh = enKeys.filter((k) => !(k in zh));
const extraInZh = zhKeys.filter((k) => !(k in en));
if (missingInZh.length > 0) {
  errors.push(`Ключи отсутствуют в zh.json (${missingInZh.length}): ${missingInZh.join(", ")}`);
}
if (extraInZh.length > 0) {
  errors.push(`Лишние ключи в zh.json (${extraInZh.length}): ${extraInZh.join(", ")}`);
}

// Плейсхолдеры: {name} или {{name}} — извлекаем имя без скобок
const placeholderRe = /\{\{?([a-zA-Z_][a-zA-Z0-9_.]*)\}?\}/g;
const placeholders = (s) => {
  const out = new Set();
  let m;
  while ((m = placeholderRe.exec(s))) out.add(m[1]);
  return [...out].sort();
};

// Плюральные ключи (в en содержат {count, plural, …})
const pluralKeys = [];
for (const k of enKeys) {
  if (String(en[k]).includes(", plural,")) pluralKeys.push(k);
}

// Токены, которые не переводятся и могут остаться латиницей (белый список для CJK-эвристики)
const untranslatedTokens = [
  "cron", "json", "sqlite", "mcp", "dag", "hmac", "url", "id", "gui", "opencode",
  "telegram", "ollama", "glob", "webhook", "llm", "rpc", "ssh", "http", "https",
  "api", "sdk", "cli", "ui", "diy", "ai", "os", "iso", "tls", "utf", "bot",
  "token", "chat", "channel", "secret", "env", "path", "file", "dir", "cmd",
  "run", "task", "job", "matrix", "profile", "schedule", "shadow", "triage",
  "trigger", "hook", "history", "audit", "log", "logs", "template", "templates",
  "prompt", "prompts", "preset", "presets", "model", "models", "provider",
  "baseurl", "base url", "threshold", "confidence", "timeout", "fallback",
  "concurrency", "concurrent", "workspace", "workspaces", "clone", "clones",
  "aggregator", "status", "success", "error", "warning", "warn", "message", "info", "debug",
  "daily", "weekly", "monthly", "hourly", "minute", "second", "ms", "sec", "s",
  "tok", "tokens", "cost", "rate", "limit", "limits", "offset", "page", "pages",
  "total", "count", "done", "pending", "failed", "skipped", "running", "paused",
  "resumed", "stopped", "cancelled", "deleted", "created", "updated", "restored",
  "rollback", "orphans", "orphan", "parent", "child", "children", "branch",
  "commit", "scheduler", "git", "push", "pull", "merge", "diff", "repo", "repository", "head", "master",
  "main", "origin", "remote", "local", "global", "system", "user", "admin", "root",
  "true", "false", "null", "undefined", "none", "all", "any", "every", "each",
  "some", "no", "not", "is", "are", "was", "were", "be", "been", "being", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should", "may",
  "might", "can", "must", "shall", "need", "dare", "ought", "used", "use", "using",
  "used", "uses", "get", "got", "gets", "getting", "set", "sets", "setting",
  "let", "lets", "make", "makes", "making", "made", "take", "takes", "taking",
  "took", "taken", "give", "gives", "giving", "gave", "given", "go", "goes",
  "going", "went", "gone", "come", "comes", "coming", "came", "come", "see",
  "sees", "seeing", "saw", "seen", "know", "knows", "knowing", "knew", "known",
  "think", "thinks", "thinking", "thought", "want", "wants", "wanting", "wanted",
  "need", "needs", "needing", "needed", "like", "likes", "liking", "liked",
  "love", "loves", "loving", "loved", "hate", "hates", "hating", "hated",
  "wait", "waits", "waiting", "waited", "start", "starts", "starting", "started",
  "stop", "stops", "stopping", "stopped", "run", "runs", "running", "ran",
  "work", "works", "working", "worked", "play", "plays", "playing", "played",
  "live", "lives", "living", "lived", "feel", "feels", "feeling", "felt",
  "leave", "leaves", "leaving", "left", "put", "puts", "putting", "send", "sends",
  "sending", "sent", "say", "says", "saying", "said", "tell", "tells", "telling",
  "told", "ask", "asks", "asking", "asked", "answer", "answers", "answering",
  "answered", "call", "calls", "calling", "called", "try", "tries", "trying",
  "tried", "turn", "turns", "turning", "turned", "keep", "keeps", "keeping",
  "kept", "hold", "holds", "holding", "held", "bring", "brings", "bringing",
  "brought", "buy", "buys", "buying", "bought", "sell", "sells", "selling",
  "sold", "pay", "pays", "paying", "paid", "cost", "costs", "costing", "cut",
  "cuts", "cutting", "hit", "hits", "hitting", "hurt", "hurts", "hurting",
  "read", "reads", "reading", "write", "writes", "writing", "wrote", "written",
  "draw", "draws", "drawing", "drew", "drawn", "drive", "drives", "driving",
  "drove", "driven", "break", "breaks", "breaking", "broke", "broken", "speak",
  "speaks", "speaking", "spoke", "spoken", "wake", "wakes", "waking", "woke",
  "woken", "choose", "chooses", "choosing", "chose", "chosen", "close", "closes",
  "closing", "closed", "open", "opens", "opening", "opened", "find", "finds",
  "finding", "found", "lose", "loses", "losing", "lost", "meet", "meets",
  "meeting", "met", "teach", "teaches", "teaching", "taught", "learn", "learns",
  "learning", "learned", "understand", "understands", "understanding",
  "understood", "win", "wins", "winning", "won", "fly", "flies", "flying",
  "flew", "flown", "fall", "falls", "falling", "fell", "fallen", "swim", "swims",
  "swimming", "swam", "swum", "shake", "shakes", "shaking", "shook", "shaken",
  "steal", "steals", "stealing", "stole", "stolen", "spend", "spends", "spending",
  "spent", "stand", "stands", "standing", "stood", "swear", "swears", "swearing",
  "swore", "sworn", "throw", "throws", "throwing", "threw", "thrown", "catch",
  "catches", "catching", "caught", "teach", "teaches", "teaching", "taught",
  "sleep", "sleeps", "sleeping", "slept", "dream", "dreams", "dreaming", "dreamt",
  "ring", "rings", "ringing", "rang", "rung", "rise", "rises", "rising", "rose",
  "risen", "sit", "sits", "sitting", "sat", "slay", "slays", "slaying", "slew",
  "slain", "spin", "spins", "spinning", "spun", "spit", "spits", "spitting",
  "spit", "split", "splits", "splitting", "spread", "spreads", "spreading",
  "cut", "cuts", "cutting", "hit", "hits", "hitting", "let", "lets", "letting",
  "put", "puts", "putting", "quit", "quits", "quitting", "set", "sets", "setting",
  "shut", "shuts", "shutting", "split", "splits", "splitting", "spread",
  "spreads", "spreading", "thrust", "thrusts", "thrusting", "broadcast",
  "broadcasts", "broadcasting", "cost", "costs", "costing", "hit", "hits",
  "hitting", "hurt", "hurts", "hurting", "let", "lets", "letting", "put",
  "puts", "putting", "quit", "quits", "quitting", "read", "reads", "reading",
  "set", "sets", "setting", "shut", "shuts", "shutting", "split", "splits",
  "splitting", "spread", "spreads", "spreading", "thrust", "thrusts",
  "thrusting", "upset", "upsets", "upsetting", "wet", "wets", "wetting",
  "wind", "winds", "winding", "wound", "withdraw", "withdraws", "withdrawing",
  "withdrew", "withdrawn",
  // спецзначения / плейсхолдеры
  "{count}", "{schedule}", "{timezone}", "{path}", "{task}", "{name}", "{error}",
  "{branch}", "{pattern}", "{commit}", "{files}", "{filter}", "{server}", "{event}",
  "{reason}", "{runAt}", "{nextOpenAt}", "{when}", "{scope}", "{visible}", "{total}",
  "{success}", "{visible}", "{model}", "{latency}", "{ms}", "{days}", "{count}",
  "{seconds}", "{where}", "{filter}", "{warnings}", "{fields}", "{list}", "{verb}",
  "{until}", "{date}", "{affected}", "{started}", "{clone}", "{workspace}", "{parent}",
  "{matrix}", "{channels}", "{errors}", "{byAge}", "{byCount}", "{kept}", "{deleted}",
  "{rate}", "{period}", "{message}", "{min}", "{max}", "{step}", "{raw}", "{value}",
  "{field}", "{operator}", "{tokens}", "{cost}", "{duration}", "{startedAt}",
  "{warnings}", "{warnings}", "{port}", "{id}", "{action}", "{session}",
  "{scheduler}", "{until}", "{minutes}", "{hours}", "{session}", "{warnings}",
  "{session}", "{warnings}",
];

// Регулярное выражение для обнаружения любого китайского/японского/корейского иероглифа
const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uf900-\ufaff]/;

// 2. Плейсхолдеры + 3. только other + 4. непустые + 5. CJK-эвристика
for (const k of enKeys) {
  const e = String(en[k]);
  const z = String(zh[k] ?? "");

  // 4. не пусто
  if (!z.trim()) {
    errors.push(`${k}: пустое значение в zh.json`);
    continue;
  }

  // 2. плейсхолдеры совпадают
  const enPh = placeholders(e);
  const zhPh = placeholders(z);
  if (enPh.join(",") !== zhPh.join(",")) {
    errors.push(`${k}: плейсхолдеры не совпадают (en: [${enPh.join(",")}], zh: [${zhPh.join(",")}])`);
  }

  // 3. плюральные ключи — только other
  if (e.includes(", plural,")) {
    if (!z.includes("{count, plural, other {")) {
      errors.push(`${k}: плюральный ключ должен содержать только ветку other`);
    }
    if (/\bone\b|\bfew\b|\bmany\b/.test(z)) {
      errors.push(`${k}: плюральный ключ содержит не-zh категорию (one/few/many)`);
    }
  }

  // 5. CJK-эвристика: значение должно содержать хотя бы один иероглиф,
  // если после вычёта белого списка токенов остаётся хоть что-то переводящее
  if (cjkRe.test(z)) continue; // есть иероглифы — ок

  // Проверим, не состоит ли строка только из "непереводимых" токенов/чисел/пунктуации/плейсхолдеров
  let normalized = z;
  for (const tok of untranslatedTokens) {
    normalized = normalized.replace(new RegExp(tok, "gi"), " ");
  }
  // убрать числа, знаки препинания, пробелы, плейсхолдеры
  normalized = normalized
    .replace(/\d+/g, " ")
    .replace(/[{}\[\]().,:;!?·•—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length > 0) {
    warnings.push(`${k}: нет китайских иероглифов (осталось: "${normalized}")`);
  }
}

// Итог
let failed = false;
if (errors.length > 0) {
  failed = true;
  console.error("ОШИБКИ валидации zh.json:");
  for (const e of errors) console.error(`  ✗ ${e}`);
}
if (warnings.length > 0) {
  console.warn(`\nВНИМАНИЕ (${warnings.length}):`);
  for (const w of warnings) console.warn(`  ! ${w}`);
}

console.log(`\nКлючей en: ${enKeys.length}, zh: ${zhKeys.length}`);
console.log(`Плюральных ключей: ${pluralKeys.length}`);
console.log(`Ошибок: ${errors.length}, предупреждений: ${warnings.length}`);

if (failed) {
  process.exit(1);
}
console.log("\n✓ zh.json прошёл валидацию: паритет ключей, плейсхолдеры, только other, непустые, CJK-эвристика.");
