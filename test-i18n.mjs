/**
 * Тесты Спринта 28: i18n-фундамент (src/i18n.ts + locales/*.json).
 * Запуск: node test-i18n.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_LOCALE,
  DEFAULT_LOCALE_MODE,
  LOCALE_AUTO,
  SUPPORTED_LOCALES,
  availableLocales,
  absentKeys,
  catalogKeys,
  catalogPath,
  getLocale,
  hasKey,
  isLocale,
  isLocaleMode,
  mapAppLocale,
  missingKeys,
  normalizeLocale,
  normalizeLocaleMode,
  registerCatalog,
  resetI18n,
  resolveLocale,
  setLocale,
  t,
} from "./dist/i18n.js";

const root = path.dirname(url.fileURLToPath(new URL(import.meta.url)));

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

// --- 1. Локаль по умолчанию и нормализация ---------------------------------
resetI18n();
check("локаль по умолчанию — ru", DEFAULT_LOCALE === "ru");
check(
  "getLocale() после resetI18n — локаль запуска",
  getLocale() === normalizeLocale(process.env.OPENCODE_SCHEDULER_LOCALE)
);
setLocale("ru");
check("SUPPORTED_LOCALES = [ru, en, zh]", SUPPORTED_LOCALES.join(",") === "ru,en,zh");
check("isLocale('ru')", isLocale("ru") === true);
check("isLocale('en')", isLocale("en") === true);
check("isLocale('zh')", isLocale("zh") === true);
check("isLocale('EN') — false", isLocale("EN") === false);
check("isLocale(null) — false", isLocale(null) === false);
check("normalizeLocale('en') → en", normalizeLocale("en") === "en");
check("normalizeLocale('zh') → zh", normalizeLocale("zh") === "zh");
check("normalizeLocale('de') → ru", normalizeLocale("de") === "ru");
check("normalizeLocale(undefined) → ru", normalizeLocale(undefined) === "ru");

// BCP 47 → Locale (T7): префиксный маппинг; регистр и разделитель не важны.
check("mapAppLocale('zh-CN') → zh", mapAppLocale("zh-CN") === "zh");
check("mapAppLocale('zh-Hans') → zh", mapAppLocale("zh-Hans") === "zh");
check("mapAppLocale('en-GB') → en", mapAppLocale("en-GB") === "en");
check("mapAppLocale('ru-RU') → ru", mapAppLocale("ru-RU") === "ru");
check("mapAppLocale('ZH_hant_TW') → zh", mapAppLocale("ZH_hant_TW") === "zh");
check("mapAppLocale('de-DE') → ru", mapAppLocale("de-DE") === "ru");
check("mapAppLocale('') → ru", mapAppLocale("") === "ru");
check("normalizeLocale('zh-CN') → zh", normalizeLocale("zh-CN") === "zh");

// Режим локали (T7): auto + явные значения, неизвестное → fallback.
check("LOCALE_AUTO = auto", LOCALE_AUTO === "auto");
check("режим локали по умолчанию — auto", DEFAULT_LOCALE_MODE === "auto");
check("isLocaleMode('auto')", isLocaleMode("auto") === true);
check("isLocaleMode('zh')", isLocaleMode("zh") === true);
check("isLocaleMode('de') — false", isLocaleMode("de") === false);
check("normalizeLocaleMode('auto') → auto", normalizeLocaleMode("auto") === "auto");
check("normalizeLocaleMode('zh-CN') → zh", normalizeLocaleMode("zh-CN") === "zh");
check("normalizeLocaleMode('de') → auto", normalizeLocaleMode("de") === "auto");
check("normalizeLocaleMode(undefined) → auto", normalizeLocaleMode(undefined) === "auto");
check("normalizeLocaleMode('de', 'auto') → auto", normalizeLocaleMode("de", "auto") === "auto");
check("resolveLocale('auto') → ru", resolveLocale("auto") === "ru");
check("resolveLocale('auto', 'zh') → zh", resolveLocale("auto", "zh") === "zh");
check("resolveLocale('auto', 'uk') → ru", resolveLocale("auto", "uk") === "ru");
check("resolveLocale('zh') → zh", resolveLocale("zh") === "zh");
check("setLocale('en') возвращает en", setLocale("en") === "en");
check("setLocale меняет getLocale", getLocale() === "en");
check("setLocale('xx') откатывает к ru", setLocale("xx") === "ru" && getLocale() === "ru");

// --- 2. Каталоги на диске ---------------------------------------------------
const ruFile = catalogPath("ru");
const enFile = catalogPath("en");
const zhFile = catalogPath("zh");
check("catalogPath('ru') находит locales/ru.json", !!ruFile && ruFile.endsWith(path.join("locales", "ru.json")));
check("catalogPath('en') находит locales/en.json", !!enFile && enFile.endsWith(path.join("locales", "en.json")));
check("catalogPath('zh') находит locales/zh.json", !!zhFile && zhFile.endsWith(path.join("locales", "zh.json")));
check("availableLocales() = [ru, en, zh]", availableLocales().join(",") === "ru,en,zh");
check("каталоги читаются как JSON-объекты", !!JSON.parse(fs.readFileSync(ruFile, "utf8")));
check("hasKey('server.notFound', 'ru')", hasKey("server.notFound", "ru") === true);
check("hasKey('no.such.key', 'ru') — false", hasKey("no.such.key", "ru") === false);

// --- 3. Паритет каталогов ---------------------------------------------------
check("missingKeys('en') пуст", missingKeys("en").length === 0);
check("absentKeys('en') пуст", absentKeys("en").length === 0);
check("missingKeys('ru') пуст", missingKeys("ru").length === 0);
check("absentKeys('ru') пуст", absentKeys("ru").length === 0);
check(
  "число ключей ru и en совпадает",
  catalogKeys("ru").length === catalogKeys("en").length
);

// PL-36: self_analysis локализован — ключи есть во всех трёх локалях и
// не возвращают сам ключ (t() не падает на фолбэк).
const SELF_ANALYSIS_KEYS = [
  "selfAnalysis.level.excellent",
  "selfAnalysis.level.good",
  "selfAnalysis.level.fair",
  "selfAnalysis.level.poor",
  "selfAnalysis.level.critical",
  "selfAnalysis.health",
  "selfAnalysis.anomaliesHigh",
  "selfAnalysis.anomaliesAll",
  "selfAnalysis.noAnomalies",
  "selfAnalysis.degrading",
  "selfAnalysis.highPriority",
  "selfAnalysis.rec.successRate",
  "selfAnalysis.rec.errorRate",
  "selfAnalysis.rec.duration",
  "selfAnalysis.rec.timeouts",
  "selfAnalysis.rec.crashes",
];
check(
  "PL-36: selfAnalysis.* ключи присутствуют в ru/en/zh",
  SUPPORTED_LOCALES.every((loc) =>
    SELF_ANALYSIS_KEYS.every((key) => hasKey(key, loc))
  )
);
setLocale("ru");
check(
  "PL-36: selfAnalysis.health интерполируется и локализован",
  t("selfAnalysis.health", { level: "отличное", score: 95 }).includes("95") &&
    t("selfAnalysis.health", { level: "отличное", score: 95 }).startsWith("Здоровье")
);
check(
  "PL-36: selfAnalysis.degrading склоняется по числу",
  t("selfAnalysis.degrading", { count: 1 }) !== t("selfAnalysis.degrading", { count: 5 })
);

// --- 4. Подстановка параметров ---------------------------------------------
resetI18n();
setLocale("ru");
check(
  "интерполяция {parentId}",
  t("server.matrixNotFound", { parentId: "nightly" }) === 'Матрица "nightly" не найдена.'
);
check(
  "интерполяция {task}",
  t("server.taskNotFound", { task: "build" }) === 'Задача "build" не найдена.'
);
check(
  "пропущенный параметр остаётся плейсхолдером",
  t("server.taskNotFound") === 'Задача "{task}" не найдена.'
);
check("статический ключ", t("server.notFound") === "Страница не найдена.");
check("ключ без перевода возвращается как есть", t("no.such.key") === "no.such.key");
check(
  "неизвестный ключ не интерполируется",
  t("no.such.key", { x: 1 }) === "no.such.key"
);

// --- 5. Плюрализация ru -----------------------------------------------------
resetI18n();
setLocale("ru");
check("ru plural 1 → one", t("common.runsCount", { count: 1 }) === "запусков: 1 запуск");
check("ru plural 2 → few", t("common.runsCount", { count: 2 }) === "запусков: 2 запуска");
check("ru plural 5 → many", t("common.runsCount", { count: 5 }) === "запусков: 5 запусков");
check("ru plural 21 → one", t("common.runsCount", { count: 21 }) === "запусков: 21 запуск");
check("ru plural 11 → many", t("common.runsCount", { count: 11 }) === "запусков: 11 запусков");

// --- 6. Плюрализация en -----------------------------------------------------
setLocale("en");
check("en plural 1 → one", t("common.runsCount", { count: 1 }) === "runs: 1 run");
check("en plural 2 → other", t("common.runsCount", { count: 2 }) === "runs: 2 runs");
check("en: статический ключ переведён", t("server.notFound") === "Page not found.");
check(
  "en: интерполяция переведена",
  t("server.taskNotFound", { task: "build" }) === 'Task "build" not found.'
);
check("en: заголовок дашборда переведён", t("app.dashboardTitle") === "Web dashboard");

// --- 7. Переключение без перезапуска ---------------------------------------
setLocale("ru");
check("переключение en → ru", t("server.notFound") === "Страница не найдена.");
check("смена локали не требует resetI18n", getLocale() === "ru");

// --- 8. Отсутствующий ключ → fallback на ru --------------------------------
// В en нет ключа, которого нет и в ru, поэтому fallback проверяем на
// искусственном каталоге: подменяем файл en на время теста нельзя (read-only),
// зато видно, что отсутствующий ключ возвращает сам ключ, а не пустую строку.
setLocale("en");
check("отсутствующий в en ключ → сам ключ", t("no.such.key") === "no.such.key");

// --- 8b. Китайский каталог: fallback на ru --------------------------------
// zh.json наполняется пакетами (см. docs/ZH-LOCALE-PLAN.md). Проверяем сам
// механизм на пустом каталоге: отсутствующий ключ обязан давать русский
// вариант, а не сырой ключ. Подмена каталога не зависит от прогресса перевода.
registerCatalog("zh", {});
setLocale("zh");
check("setLocale('zh') возвращает zh", getLocale() === "zh");
check(
  "zh: отсутствующий ключ → русский вариант",
  t("server.notFound") === "Страница не найдена."
);
check(
  "zh: плюрализация отсутствующего ключа считается по ru",
  t("common.runsCount", { count: 5 }) === "запусков: 5 запусков"
);
resetI18n();

// --- 9. Локаль запуска через переменную окружения ---------------------------
const i18nUrl = url.pathToFileURL(path.join(root, "dist", "i18n.js")).href;
const child = spawnSync(
  process.execPath,
  ["-e", `import(${JSON.stringify(i18nUrl)}).then((m) => console.log(m.getLocale()))`],
  { env: { ...process.env, OPENCODE_SCHEDULER_LOCALE: "en" }, encoding: "utf8" }
);
check(
  "OPENCODE_SCHEDULER_LOCALE=en задаёт локаль запуска",
  child.stdout.trim() === "en"
);

const failed = results.filter((r) => !r.ok);
console.log(`\ni18n: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
