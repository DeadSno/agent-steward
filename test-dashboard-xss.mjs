/**
 * Dashboard XSS (B3.3): esc() экранирует кавычки и угловые скобки, поэтому
 * payload не выходит из текста и из значения атрибута.
 *
 * Проверяется esc() из реально отданной страницы (`GET /`), а не копия в тесте:
 * если кто-то вернёт div.innerHTML-трюк, тест упадёт.
 *
 * Run: node test-dashboard-xss.mjs (после npm run build).
 */
import path from "node:path";
import vm from "node:vm";
import { createTestHomeSync, removeTestHomeSync } from "./scripts/test-home.mjs";

const { root: tempRoot } = createTestHomeSync("ws-scheduler-xss-");
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(tempRoot, "opencode", "windows-scheduler");

const { startDashboardServer, closeDashboardServer, getDashboardPort } = await import("./dist/server.js");
const { closeDb } = await import("./dist/db/index.js");

let passed = 0;
let failed = 0;

function check(name, condition) {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// Payload'ы покрывают оба вида кавычек, закрытие текста и атрибута,
// повторное экранирование сущностей и javascript:-URL.
const PAYLOADS = [
  'x" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  '"><script>alert(1)</script>',
  '</title><script>alert(1)</script>',
  'a"><img src=x onerror=alert(1)>',
  "');alert(1);//",
  "javascript:alert(1)",
  '&quot; &amp; &#39; &lt;',
];

function decodeEntities(value) {
  return value
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const deps = {
  getTasks: async () => PAYLOADS.map((name) => ({
    name,
    schedule: "* * * * *",
    status: "success",
    nextRun: null,
    triggerType: "cron",
  })),
};

try {
  const started = await startDashboardServer(deps, { preferred: 4320, fallback: 4321 });
  check("дашборд стартовал", !!started && started.port === 4320);
  if (!started) throw new Error("дашборд не стартовал: порты 4320/4321 заняты");

  // При параллельном прогоне getDashboardPort() может указывать на другой
  // экземпляр сервера (или быть null), поэтому берём порт нашего started.
  check("порт дашборда совпадает с запущенным", getDashboardPort() === started.port);
  const base = "http://127.0.0.1:" + started.port;
  const res = await fetch(base + "/");
  const html = await res.text();
  check("GET / отдаёт HTML-страницу", res.ok && html.includes("<!DOCTYPE html>"));

  // B3.4: CSP — defense in depth, inline-скрипт только по nonce.
  const csp = res.headers.get("content-security-policy") || "";
  check("CSP-заголовок присутствует", csp.length > 0);
  check("CSP: default-src 'none'", csp.includes("default-src 'none'"));
  check("CSP: frame-ancestors 'none'", csp.includes("frame-ancestors 'none'"));
  check("CSP: connect-src 'self'", csp.includes("connect-src 'self'"));
  check("CSP: нет script-src 'unsafe-inline'", !/script-src[^;]*'unsafe-inline'/.test(csp));

  const cspNonce = (csp.match(/'nonce-([^']+)'/) || [])[1] || "";
  check("CSP: nonce для скрипта задан", cspNonce.length >= 16);

  // Все inline-скрипты страницы должны нести один и тот же nonce из CSP.
  const scriptBlocks = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g));
  check("клиентских скриптов не меньше двух", scriptBlocks.length >= 2);
  check(
    "все inline-скрипты помечены тем же nonce",
    scriptBlocks.length > 0 &&
      scriptBlocks.every(
        (m) => ((m[1].match(/nonce="([^"]+)"/) || [])[1] || "") === cspNonce
      )
  );

  const script = scriptBlocks.length > 0 ? scriptBlocks[0][2] : "";
  check("клиентский скрипт найден", script.length > 0);
  check(
    "все клиентские скрипты синтаксически валидны",
    scriptBlocks.every((m) => {
      try {
        new vm.Script(m[2]);
        return true;
      } catch {
        return false;
      }
    })
  );

  const escMatch = script.match(/function esc\(s\) \{[\s\S]*?\n  \}/);
  check("esc() присутствует в отданной странице", !!escMatch);
  check(
    "esc() не полагается на div.innerHTML",
    !!escMatch && !/createElement|innerHTML/.test(escMatch[0])
  );

  if (!escMatch) throw new Error("без esc() дальнейшие проверки невозможны");
  const esc = vm.runInNewContext("(" + escMatch[0] + ")", {});

  check("null/undefined -> пустая строка", esc(null) === "" && esc(undefined) === "");
  check("обычный текст не меняется", esc("Задача-1 (ok)") === "Задача-1 (ok)");

  for (const payload of PAYLOADS) {
    const out = esc(payload);
    check(
      `esc(): нет сырых кавычек и тегов ${JSON.stringify(payload)}`,
      !/["'<>]/.test(out)
    );

    // Атрибут: значение закрывается на нашей кавычке, payload остаётся внутри.
    const attrHtml = '<td title="' + out + '">cell</td>';
    const attrMatch = attrHtml.match(/^<td title="([^"]*)">cell<\/td>$/);
    check(
      `атрибут title не ломается ${JSON.stringify(payload)}`,
      !!attrMatch && decodeEntities(attrMatch[1]) === payload
    );

    const dataHtml = '<button data-name="' + out + '" data-act="run">x</button>';
    const dataMatch = dataHtml.match(/^<button data-name="([^"]*)" data-act="run">x<\/button>$/);
    check(
      `атрибут data-name не ломается ${JSON.stringify(payload)}`,
      !!dataMatch && decodeEntities(dataMatch[1]) === payload
    );

    // Текст: ни одного нового тега, кроме нашей обёртки.
    const textHtml = "<span>" + out + "</span>";
    check(
      `текстовый контекст не ломается ${JSON.stringify(payload)}`,
      textHtml.startsWith("<span>") &&
        textHtml.endsWith("</span>") &&
        !/[<>]/.test(textHtml.slice("<span>".length, -"</span>".length))
    );
  }

  // API отдаёт имя как данные (JSON), а не как разметку.
  const tasks = await fetch(base + "/api/tasks").then((r) => r.json());
  check(
    "GET /api/tasks возвращает payload без искажений",
    Array.isArray(tasks.tasks) && PAYLOADS.every((p) => tasks.tasks.some((t) => t.name === p))
  );
} finally {
  try {
    await closeDashboardServer();
  } catch {
    // Сервер мог не подняться — тест уже зафиксировал это.
  }
  try {
    closeDb();
  } catch {
    // БД могла не инициализироваться.
  }
}

removeTestHomeSync(tempRoot);

console.log(`\nDashboard XSS: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
