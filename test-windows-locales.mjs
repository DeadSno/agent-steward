// P1-8.T1.4: тесты формата даты one-shot / «никогда» для en-US и zh-CN локалей.
//
// Раньше P1-8.T1.4 висел как «невыполнимо в песочнице без Node». Это не так:
// форматирование — чистая функция в one-shot.ts, а реальные шаблоны ShortDatePattern
// можно получить прямо здесь через PowerShell (Get-Culture). Проверяем и то, и другое:
//  1. известные шаблоны l10n дают корректные /sd для schtasks;
//  2. на Windows Live-значения Get-Culture для culture_info совпадают с ожидаемыми
//     и тоже проходят сквозь buildWindowsOneShotFlags.
//
// Запуск: node test-windows-locales.mjs (после npm run build).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWindowsOneShotFlags, formatDateByLocalePattern } from "./dist/core/one-shot.js";

let failures = 0;
const check = (msg, cond, detail) => {
  if (cond) {
    console.log("OK: " + msg);
  } else {
    failures += 1;
    console.error("FAIL: " + msg + (detail === undefined ? "" : " -> " + JSON.stringify(detail)));
  }
};

// 2 января 2030, 09:30 — локальное время, чтобы не зависеть от TZ.
const date = new Date(2030, 0, 2, 9, 30);
const iso = date.toISOString();

/** Ожидаемые .NET ShortDatePattern для трёх целевых локалей (проверено на Win11). */
const KNOWN = [
  { culture: "ru-RU", pattern: "dd.MM.yyyy", sd: "02.01.2030" },
  { culture: "en-US", pattern: "M/d/yyyy", sd: "1/2/2030" },
  { culture: "zh-CN", pattern: "yyyy/M/d", sd: "2030/1/2" },
];

for (const { culture, pattern, sd } of KNOWN) {
  const flags = buildWindowsOneShotFlags(iso, pattern);
  check(
    `schtasks /sd для ${culture} (${pattern}) → ${sd}`,
    flags[3] === sd,
    { pattern, got: flags[3], expected: sd },
  );
  check(
    `${culture}: /sc ONCE и /st HH:MM на месте`,
    flags[0] === "/sc" && flags[1] === "ONCE" && flags[5] === "09:30",
    flags,
  );
  const never = formatDateByLocalePattern(new Date(2099, 11, 31), pattern);
  check(
    `${culture}: дата «никогда» 2099 = ${never}`,
    // 31.12.2099 / 12/31/2099 / 2099/12/31 — ved'une办学 три токена, год в любом порядке.
    (never.match(/\d+/g) ?? []).join(",") === "31,12,2099" ||
      (never.match(/\d+/g) ?? []).join(",") === "2099,12,31" ||
      (never.match(/\d+/g) ?? []).join(",") === "12,31,2099",
    never,
  );
}

// Живое подтверждение на Windows: реальные Get-Culture не расходятся с KNOWN.
if (process.platform === "win32") {
  const scriptPath = path.join(
    os.tmpdir(),
    `sched-locales-${process.pid}.ps1`,
  );
  fs.writeFileSync(
    scriptPath,
    [
      "foreach ($n in @('ru-RU','en-US','zh-CN')) {",
      "  $c = [System.Globalization.CultureInfo]::GetCultureInfo($n)",
      "  Write-Output ($n + '|' + $c.DateTimeFormat.ShortDatePattern)",
      "}",
    ].join("\r\n"),
    "utf8",
  );
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { encoding: "utf8", windowsHide: true },
    );
    fs.unlinkSync(scriptPath);
    const live = new Map(
      String(out)
        .split(/\r?\n/)
        .map((line) => line.split("|"))
        .filter((p) => p.length === 2)
        .map(([culture, pattern]) => [culture.trim(), pattern.trim()]),
    );
    for (const { culture, pattern } of KNOWN) {
      check(
        `Windows Get-Culture(${culture}) = ${pattern} (live)`,
        live.get(culture) === pattern,
        { got: live.get(culture), expected: pattern, raw: String(out) },
      );
    }
  } catch (err) {
    check("Windows Get-Culture доступен", false, String(err));
  }
} else {
  console.log("SKIP: живые Get-Culture проверки доступны только на Windows (шаблоны сверху проверены всегда).");
}

console.log(`\n${failures === 0 ? "P1-8.T1.4 locales: OK" : `${failures} ошибок`}.`);
process.exit(failures > 0 ? 1 : 0);
