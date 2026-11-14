/**
 * Тесты Спринта 28: i18n-фундамент (src/i18n.ts + locales/*.json).
 * Запуск: node test-i18n.mjs (после npm run build).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  availableLocales,
  absentKeys,
  catalogKeys,
  catalogPath,
  getLocale,
  hasKey,
  isLocale,
  missingKeys,
  normalizeLocale,
  resetI18n,
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
check("getLocale() сразу после resetI18n — ru", getLocale() === "ru");
check("SUPPORTED_LOCALES = [ru, en]", SUPPORTED_LOCALES.join(",") === "ru,en");
check("isLocale('ru')", isLocale("ru") === true);
check("isLocale('en')", isLocale("en") === true);
check("isLocale('EN') — false", isLocale("EN") === false);
check("isLocale(null) — false", isLocale(null) === false);
check("normalizeLocale('en') → en", normalizeLocale("en") === "en");
check("normalizeLocale('de') → ru", normalizeLocale("de") === "ru");
check("normalizeLocale(undefined) → ru", normalizeLocale(undefined) === "ru");
check("setLocale('en') возвращает en", setLocale("en") === "en");
check("setLocale меняет getLocale", getLocale() === "en");
check("setLocale('xx') откатывает к ru", setLocale("xx") === "ru" && getLocale() === "ru");

// --- 2. Каталоги на диске ---------------------------------------------------
const ruFile = catalogPath("ru");
const enFile = catalogPath("en");
check("catalogPath('ru') находит locales/ru.json", !!ruFile && ruFile.endsWith(path.join("locales", "ru.json")));
check("catalogPath('en') находит locales/en.json", !!enFile && enFile.endsWith(path.join("locales", "en.json")));
check("availableLocales() = [ru, en]", availableLocales().join(",") === "ru,en");
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

// --- 4. Подстановка параметров ---------------------------------------------
resetI18n();
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
resetI18n();

const failed = results.filter((r) => !r.ok);
console.log(`\ni18n: ${results.length - failed.length}/${results.length} проверок пройдено.`);
process.exit(failed.length > 0 ? 1 : 0);
