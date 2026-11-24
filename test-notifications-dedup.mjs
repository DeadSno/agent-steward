/**
 * Тесты 31.2: дедуп уведомлений со счётчиком повторов.
 * Запуск: node test-notifications-dedup.mjs (после npm run build).
 * Локальный HTTP-сервер как webhook-приёмник; планировщик ОС не нужен.
 *
 * Поведение дедупа:
 *  - Первый запуск задачи/статуса: доставляется, count=1, без "(repeat)".
 *  - Повтор неважного статуса в окне: подавляется (не доставляется).
 *  - Повтор важного статуса (error/timeout): доставляется с "(repeat N)".
 *  - dedup.enabled=false: дедуп отключён, всё доставляется.
 *  - dedup.suppressDuplicates=false: подавление выключено, всё доставляется.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// Временный конфиг-домен — до динамического импорта dist.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scheduler-dedup-"));
process.env.APPDATA = tempRoot;
process.env.OPENCODE_SCHEDULER_HOME = path.join(
  tempRoot,
  "opencode",
  "windows-scheduler"
);

const notifications = await import("./dist/notifications.js");
const settingsModule = await import("./dist/settings.js");
const dbModule = await import("./dist/db/index.js");
const { t } = await import("./dist/i18n.js");

const {
  notifyTaskCompletion,
  flushNotificationBatch,
  getPendingNotificationBatchSize,
} = notifications;

let passed = 0;
let failed = 0;
function check(name, cond) {
  const ok = !!cond;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
}

const settingsFile = path.join(
  process.env.OPENCODE_SCHEDULER_HOME,
  "settings.json"
);

// Записывает settings.json с нужными overrides и указанным webhook URL.
async function writeSettings(hookUrl, overrides = {}) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const config = {
    enabled: true,
    onlyOnError: false,
    webhook: { enabled: true, url: hookUrl },
    triage: { mode: "off" },
    dedup: {
      enabled: true,
      windowMinutes: 60,
      suppressDuplicates: true,
      importantStatuses: ["error", "timeout"],
      maxCount: 999,
    },
    ...overrides,
  };
  fs.writeFileSync(settingsFile, JSON.stringify({ notifications: config }), "utf8");
  await settingsModule.loadSettings();
}

// Поднимает webhook-сервер, пишет settings с его URL и запускает fn.
async function withWebhook(overrides, fn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        calls.push(JSON.parse(body));
      } catch (e) {
        calls.push({ text: body });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await writeSettings(`http://127.0.0.1:${port}/hook`, overrides);
    await fn(calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- Тесты ------------------------------------------------------------------

// 1. Первое уведомление: доставляется, count=1, без "(repeat)"
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check("dedup #1: первый запуск доставился", calls.length === 1);
  check(
    "dedup #1: в сообщении нет '(repeat)'",
    !calls[0]?.text?.includes("(repeat")
  );
});

// 2. Дубликат неважного статуса в окне: подавляется, не доставляется
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check(
    "dedup #2: повтор success не доставляется (подавлен)",
    calls.length === 0
  );
});

// 3. Ещё один дубликат неважного статуса: тоже подавляется
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check(
    "dedup #3: второй repeat success тоже подавлен",
    calls.length === 0
  );
});

// 4. Разный статус той же задачи: новый ключ, доставляется, count=1
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Deploy-Production", "error", 2000, "boom", 0, 0, {
    asyncTriage: false,
  });
  check("dedup #4: ошибка той же задачи доставилась", calls.length === 1);
  check("dedup #4: ошибка без '(repeat)'", !calls[0]?.text?.includes("(repeat"));
});

// 5. Важный статус (error) не подавляется даже как дубликат
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Nightly-Build", "success", 500, null, 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Nightly-Build", "error", 500, "failed", 0, 0, {
    asyncTriage: false,
  });
  check("dedup #5: важный статус error доставился", calls.length === 2);
  check(
    "dedup #5: error без '(repeat)' (новый ключ, count=1)",
    !calls[1]?.text?.includes("(repeat")
  );
});

// 6. dedup.enabled=false: записи не создаются, повторы не считаются
await withWebhook({ dedup: { enabled: false } }, async (calls) => {
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
    asyncTriage: false,
  });
  check("dedup #6: без enable оба запуска доставились", calls.length === 2);
  check(
    "dedup #6: ни одно сообщение не содержит '(repeat)'",
    calls.every((c) => !c?.text?.includes("(repeat"))
  );
});

// 7. dedup.suppressDuplicates=false: всё доставляется, счётчик не растёт
await withWebhook(
  { dedup: { enabled: true, suppressDuplicates: false } },
  async (calls) => {
    await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
      asyncTriage: false,
    });
    await notifyTaskCompletion("Deploy-Production", "success", 1000, null, 0, 0, {
      asyncTriage: false,
    });
    check(
      "dedup #7: с suppressDuplicates=false оба доставились",
      calls.length === 2
    );
    check(
      "dedup #7: ни одно сообщение не содержит '(repeat)'",
      calls.every((c) => !c?.text?.includes("(repeat"))
    );
  }
);

// 8. Важный дубликат (error): доставляется со счётчиком (repeat 2)
await withWebhook({}, async (calls) => {
  await notifyTaskCompletion("Deploy-Production-2", "error", 1000, "boom", 0, 0, {
    asyncTriage: false,
  });
  await notifyTaskCompletion("Deploy-Production-2", "error", 1000, "boom", 0, 0, {
    asyncTriage: false,
  });
  check("dedup #8: важный дубликат error доставился", calls.length === 2);
  check(
    "dedup #8: второй error содержит суффикс повтора (repeat 2)",
    calls[1]?.text?.includes(t("notify.dedup.count", { count: 2 }))
  );
});

// 9. BN-4: лимит items сбрасывает сводку раньше таймера
await withWebhook(
  { batch: { enabled: true, windowSeconds: 30, maxItems: 3 } },
  async (calls) => {
    for (const name of ["BN4-Alpha", "BN4-Beta", "BN4-Gamma"]) {
      await notifyTaskCompletion(name, "success", 1000, null, 0, 0, {
        asyncTriage: false,
      });
    }
    check("batch #9: три уведомления — одна сводка", calls.length === 1);
    check(
      "batch #9: сводка содержит счётчик и все задачи",
      calls[0]?.text?.includes("Batch summary (3)") &&
        calls[0]?.text?.includes("BN4-Alpha") &&
        calls[0]?.text?.includes("BN4-Beta") &&
        calls[0]?.text?.includes("BN4-Gamma")
    );
    check(
      "batch #9: буфер опустошён после сброса",
      getPendingNotificationBatchSize() === 0
    );
  }
);

// 10. BN-4: гарантированный сброс до истечения окна
await withWebhook(
  { batch: { enabled: true, windowSeconds: 60, maxItems: 10 } },
  async (calls) => {
    await notifyTaskCompletion("BN4-Delta", "error", 1000, "boom", 0, 0, {
      asyncTriage: false,
    });
    await notifyTaskCompletion("BN4-Epsilon", "success", 1000, null, 0, 0, {
      asyncTriage: false,
    });
    check("batch #10: до сброса доставок нет", calls.length === 0);
    check(
      "batch #10: два уведомления накоплены в буфере",
      getPendingNotificationBatchSize() === 2
    );
    const ok = await flushNotificationBatch();
    check(
      "batch #10: flushNotificationBatch доставил сводку",
      ok === true &&
        calls.length === 1 &&
        calls[0]?.text?.includes("Batch summary (2)") &&
        calls[0]?.text?.includes("BN4-Delta") &&
        calls[0]?.text?.includes("BN4-Epsilon")
    );
    check(
      "batch #10: повторный flush ничего не отправляет",
      (await flushNotificationBatch()) === false && calls.length === 1
    );
  }
);

// 11. BN-4: значения по умолчанию и нормализация настроек
await withWebhook({}, async () => {
  const settings = await settingsModule.loadSettings();
  check(
    "batch #11: дефолты выключены, окно 30 с, лимит 10",
    settings.notifications.batch?.enabled === false &&
      settings.notifications.batch?.windowSeconds === 30 &&
      settings.notifications.batch?.maxItems === 10
  );
});

// --- Очистка ----------------------------------------------------------------
try {
  await flushNotificationBatch();
} catch (_) {}
try {
  await dbModule.closeDb();
} catch (_) {}

console.log(`\n${passed}/${passed + failed} тестов дедупа пройдены.`);
process.exit(failed > 0 ? 1 : 0);
