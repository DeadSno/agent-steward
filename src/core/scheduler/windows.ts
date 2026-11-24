import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import path from "node:path";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import { quoteCmdArg } from "../opencode-cli.js";
import type { ScheduledTaskInfo } from "../../types.js";
import { TASK_FOLDER, TASK_FOLDER_NAME, LEGACY_TASK_FOLDER_NAME, taskFolderNameForProfile, legacyTaskFolderNameForProfile, getPluginDir } from "../../types.js";
import { getProfileName } from "../../profiles.js";
import {
  buildScheduleFlags,
  convertCronToSchTasks,
  nextMonthlyStartBoundary,
} from "../cron-to-schtasks.js";
import {
  buildWindowsOneShotFlags,
  formatDateByLocalePattern,
} from "../one-shot.js";
import { buildWindowsHiddenTaskCommand, ensureHiddenLauncher } from "../ps-wrapper.js";
import { needsPollMode } from "../schedule-v2.js";
import type {
  CreateTaskOptions,
  RunTaskResult,
  SchedulerBackend,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Кэш формата даты локали Windows (ShortDatePattern), полученного через PowerShell.
 *  Храним промис, а не готовую строку: параллельные вызовы ждут один и тот же
 *  результат и не запускают PowerShell по несколько раз (гонка при await). */
let windowsDateFormatCache: Promise<string> | null = null;

/** Определяет формат даты системной локали через PowerShell (P1-8). */
async function getWindowsDateFormat(): Promise<string> {
  if (windowsDateFormatCache === null) {
    windowsDateFormatCache = (async () => {
      try {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-Command", "(Get-Culture).DateTimeFormat.ShortDatePattern"],
          { maxBuffer: MAX_OUTPUT_BUFFER, windowsHide: true },
        );
        const pattern = String(stdout).trim();
        return pattern || "dd.MM.yyyy";
      } catch {
        return "dd.MM.yyyy";
      }
    })();
  }
  return windowsDateFormatCache;
}

/** Кэш имени культуры Windows (Get-Culture).Name для MMM/MMMM (QW-14.3). */
let windowsLocaleCache: Promise<string | undefined> | null = null;

async function getWindowsLocale(): Promise<string | undefined> {
  if (windowsLocaleCache === null) {
    windowsLocaleCache = (async () => {
      try {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-Command", "(Get-Culture).Name"],
          { maxBuffer: MAX_OUTPUT_BUFFER, windowsHide: true },
        );
        return String(stdout).trim() || undefined;
      } catch {
        return undefined;
      }
    })();
  }
  return windowsLocaleCache;
}

/** Форматирует дату «никогда» (заглушка для file/git/mcp-триггеров) в формате локали. */
async function buildNeverDate(format: string): Promise<string> {
  const { formatDateByLocalePattern } = await import("../one-shot.js");
  return formatDateByLocalePattern(new Date("2099-12-31T00:00:00Z"), format);
}

/**
 * PL-75: форматирует дату стартовой границы в DD.MM.YYYY — тот же числовой
 * формат, что и в PL-57 (однозначен для русской локали Windows).
 */
function formatCronBoundary(date: Date): string {
  return (
    String(date.getDate()).padStart(2, "0") +
    "." +
    String(date.getMonth() + 1).padStart(2, "0") +
    "." +
    String(date.getFullYear())
  );
}

/**
 * V009-5: переформатирует стартовую границу `/sd` из DD.MM.YYYY (PL-57/PL-75)
 * в ShortDatePattern системной локали Windows. CI-регрессия: на windows-latest
 * с en-US (`M/d/yyyy`) schtasks отвергал `24.11.2026` как `Incorrect Start Date`,
 * из-за чего `update_task` терял ОС-задачу без definition в SQLite.
 * Некорректные/уже локализованные значения возвращаются как есть (fail-open).
 */
export function formatCronBoundaryForLocale(
  boundary: string,
  format = "dd.MM.yyyy",
  locale?: string,
): string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(boundary);
  if (!match) return boundary;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return boundary;
  }
  return formatDateByLocalePattern(date, format, locale);
}

/**
 * PL-75: строго будущая стартовая граница `/sd` для cron-триггера.
 *
 * При пересоздании задачи (update_task = delete + create) schtasks берёт дату
 * создания как start boundary и «догоняет» пропущенный старт. Для MONTHLY
 * границу уже считает nextMonthlyStartBoundary (PL-57); для остальных
 * нативных выражений возвращаем завтрашний день — это убирает catch-up ценой
 * отложенного первого тика. Возвращаемая дата всегда строго позже `now`.
 */
export function cronStartBoundary(schedule: string, now: Date = new Date()): string {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    if (
      /^\d+$/.test(minute) &&
      /^\d+$/.test(hour) &&
      /^\d+$/.test(dayOfMonth) &&
      dayOfWeek === "*"
    ) {
      const monthNumber = month === "*" ? null : Number(month);
      if (
        monthNumber === null ||
        (Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12)
      ) {
        try {
          return nextMonthlyStartBoundary(
            Number(dayOfMonth),
            monthNumber,
            now,
            Number(hour),
            Number(minute),
          );
        } catch {
          // 31-е число в коротком месяце и т.п. — fallback на общую дату ниже.
        }
      }
    }
  }
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return formatCronBoundary(tomorrow);
}

/**
 * PL-75: проверка «прошедшей» границы ранее запланированного запуска.
 * Используется вызывающим кодом, чтобы не пересоздавать OS-триггер с датой
 * из прошлого (такой триггер сразу уходит в catch-up).
 */
export function shouldDeferCronTriggerRecreation(
  previousNextRun: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!previousNextRun) return false;
  const timestamp = Date.parse(previousNextRun);
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

/** Максимальный размер вывода schtasks (обычно хватает с большим запасом). */
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

/** Префикс папки задач плагина в Планировщике заданий Windows. */
export const WINDOWS_TASK_PREFIX = `\\${TASK_FOLDER}\\${TASK_FOLDER_NAME}\\`;

/** Префикс старой папки (до переименования) — поддерживается для миграции. */
export const LEGACY_WINDOWS_TASK_PREFIX = `\\${TASK_FOLDER}\\${LEGACY_TASK_FOLDER_NAME}\\`;

/** Префикс папки конкретного профиля (для удаления неактивного профиля). */
export function windowsTaskPrefixForProfile(profile: string): string {
  return `\\${TASK_FOLDER}\\${taskFolderNameForProfile(profile)}\\`;
}

/** Префикс старой папки конкретного профиля. */
export function legacyWindowsTaskPrefixForProfile(profile: string): string {
  return `\\${TASK_FOLDER}\\${legacyTaskFolderNameForProfile(profile)}\\`;
}

/** Полное имя задачи в папке конкретного профиля. */
export function taskFullNameForProfile(name: string, profile: string): string {
  const prefix = windowsTaskPrefixForProfile(profile);
  return name.startsWith(prefix) ? name : prefix + name;
}

/**
 * Кэш OEM-кодовой страницы системы. Заполняется один раз через реестр
 * HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage (значение OEMCP).
 */
let oemCodePageCache: number | null = null;

/**
 * Определяет OEM-кодовую страницу системы из реестра Windows.
 *
 * schtasks.exe и другие консольные утилиты выводят текст в OEM-кодировке
 * системы (CP866 на русской Windows, 850/852 на западноевропейской, 437 на
 * английской и т.д.). Жёсткий фолбэк на cp866 ломает вывод на DE/FR/ES/IT/PL
 * и других локалях: акцентные ключи (nächste Ausführung, última ejecución и т.д.)
 * превращаются в кракозябры и не распознаются парсером.
 *
 * Фолбэк — cp866 (историческое поведение на русской Windows).
 */
export async function getOemCodePage(): Promise<number> {
  if (oemCodePageCache !== null) {
    return oemCodePageCache;
  }
  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      "/v",
      "OEMCP",
    ], {
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 64 * 1024,
    });
    // reg query выводит в OEM-кодировке, но цифры кода страницы — ASCII,
    // поэтому декодировать можно через cp866/utf8 — цифры не пострадают.
    const text = decodeConsoleOutputSync(stdout);
    // Значение может быть REG_DWORD (0x362) или REG_SZ (866 / "866").
    const hexMatch = /0x([0-9A-Fa-f]{1,8})/i.exec(text);
    const decMatch = /\b(\d{2,5})\b/.exec(text);
    let cp: number | null = null;
    if (hexMatch) {
      cp = parseInt(hexMatch[1], 16);
    } else if (decMatch) {
      cp = parseInt(decMatch[1], 10);
    }
    if (cp && cp > 0 && cp < 65536) {
      oemCodePageCache = cp;
      return cp;
    }
  } catch {
    // реестр недоступен — фолбэк ниже
  }
  oemCodePageCache = 866;
  return 866;
}

/**
 * Синхронная обёртка для начального определения OEMCP (используется внутри
 * getOemCodePage для декодирования вывода reg query). Цифры кода страницы —
 * ASCII, поэтому cp866/utf8 безопасны для этого шага.
 */
export function decodeConsoleOutputSync(buf: Buffer | string | undefined | null): string {
  if (!buf) return "";
  if (typeof buf === "string") return buf;
  if (buf.length === 0) return "";

  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }

  return iconv.decode(buf, "cp866");
}

/**
 * Декодирует вывод консольных утилит Windows.
 *
 * `schtasks.exe` запускается напрямую, без `cmd.exe`, поэтому метасимволы
 * в аргументах не исполняются. Вывод утилиты приходит в OEM-кодировке системы,
 * из-за чего Node, читающий его как UTF-8, показывает «?????». Поэтому:
 * если байты — валидный UTF-8, декодируем как UTF-8, иначе пробуем OEMCP
 * системы (определяется из реестра Nls\CodePage), с фолбэком на cp866.
 */
export async function decodeConsoleOutput(buf: Buffer | string | undefined | null): Promise<string> {
  if (!buf) return "";
  if (typeof buf === "string") return buf;
  if (buf.length === 0) return "";

  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) {
    return utf8;
  }

  const cp = await getOemCodePage();
  try {
    return iconv.decode(buf, `cp${cp}`);
  } catch {
    return iconv.decode(buf, "cp866");
  }
}

/** Достаёт Buffer из ошибки execFile (при encoding: "buffer"). */
function errorBuffer(err: unknown, field: "stdout" | "stderr"): Buffer | undefined {
  const value = (err as Record<string, unknown> | null)?.[field];
  return Buffer.isBuffer(value) ? value : undefined;
}

/**
 * Собирает читаемый текст ошибки.
 *
 * err.message от Node содержит stderr, уже декодированный как UTF-8,
 * поэтому для русской Windows там остаются «кракозябры». Берём из message
 * только первую строку (команду), а текст ошибки — из наших Buffer'ов.
 */
function buildErrorDetails(err: unknown, stdout: string, stderr: string): string {
  const message = (err as { message?: string } | null)?.message ?? "";
  const commandLine = message.split(/\r?\n/)[0] ?? "";
  return [...new Set([commandLine, stdout, stderr].filter(Boolean))].join(" | ");
}

/** Результат выполнения команды schtasks. */
export interface SchtasksResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Поясняет известные коды и тексты ошибок schtasks.
 *
 * Возвращает `null`, если код/текст неизвестен: исходное сообщение в этом
 * случае не меняется. schtasks часто возвращает общий код `1`, поэтому
 * текстовая эвристика остаётся основным фолбэком.
 */
export function explainSchtasksError(
  code: number | null,
  text: string,
): string | null {
  // HRESULT-коды приходят как знаковые 32-битные числа; приводим к unsigned.
  const unsigned =
    typeof code === "number" && Number.isFinite(code)
      ? code < 0
        ? code >>> 0
        : code
      : null;

  const byCode: Record<number, string> = {
    267009: "Задача сейчас выполняется.",
    267010: "Задача отключена.",
    267011: "Задача ещё ни разу не запускалась.",
    267012: "У задачи больше нет запланированных запусков.",
    267013: "Задача не запланирована.",
    267014: "Выполнение задачи было прервано пользователем.",
    2147942405: "Нет прав на операцию с задачей (access denied).",
    2147942402: "Задача или файл не найдены.",
  };

  if (unsigned !== null && byCode[unsigned]) {
    return byCode[unsigned];
  }

  const lower = text.toLowerCase();
  const byText: [string[], string][] = [
    [
      ["access is denied", "отказано в доступе"],
      "Нет прав на операцию с задачей (access denied).",
    ],
    [
      ["cannot find", "не удалось найти", "не найдено"],
      "Задача или файл не найдены.",
    ],
    [
      ["already running", "currently running", "уже выполняется", "уже запущена", "сейчас выполняется"],
      "Задача уже выполняется.",
    ],
    [["is disabled", "отключена"], "Задача отключена."],
  ];

  for (const [needles, hint] of byText) {
    if (needles.some((needle) => lower.includes(needle))) {
      return hint;
    }
  }

  return null;
}

/** Ошибка выполнения schtasks. */
export class SchtasksError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    const hint = explainSchtasksError(code, `${message} ${stderr}`);
    super(hint ? `${message} | пояснение: ${hint}` : message);
    this.name = "SchtasksError";
  }
}

/**
 * Выполняет `schtasks.exe` напрямую с массивом аргументов.
 *
 * Раньше команда собиралась в строку и запускалась через `cmd.exe /c`,
 * из-за чего метасимволы (`&`, `|`, `"`) в имени задачи исполнялись
 * оболочкой: можно было получить command injection и «фантомную» задачу.
 * `execFile` передаёт каждый аргумент отдельно — оболочки в цепочке нет.
 */
export async function runSchtasks(args: string[]): Promise<SchtasksResult> {
  try {
    const { stdout, stderr } = (await execFileAsync("schtasks", args, {
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: MAX_OUTPUT_BUFFER,
    })) as unknown as { stdout: Buffer; stderr: Buffer };
    return {
      stdout: await decodeConsoleOutput(stdout),
      stderr: await decodeConsoleOutput(stderr),
      code: 0,
    };
  } catch (err) {
    const e = err as { message?: string; code?: number | null };
    const stdout = await decodeConsoleOutput(errorBuffer(err, "stdout"));
    const stderr = await decodeConsoleOutput(errorBuffer(err, "stderr"));
    const failure = new SchtasksError(
      `schtasks error: ${buildErrorDetails(err, stdout, stderr)}`,
      e.code ?? null,
      stderr,
    );
    // Нет прав → пробуем тот же вызов с повышением (UAC) вместо тупика.
    if (!isAccessDeniedError(failure) || !shouldTryElevation(args)) {
      throw failure;
    }
    return await runSchtasksWithElevation(args, failure);
  }
}

/**
 * Фолбэк повышения (UAC) для schtasks.
 *
 * На части машин (OEM-политика, отозванное право «Log on as a batch job»)
 * регистрация задач запрещена даже владельцу без повышения: и `schtasks.exe`,
 * и COM-апик `Register-ScheduledTask` отвечают «Access is denied». Раньше это
 * была тупиковая ошибка и единственный способ — запускать OpenCode от администратора.
 * Теперь команда повторяется через ShellExecute `verb=runas`: права спрашиваются
 * у пользователя ровно на одну операцию, сам OpenCode остаётся без повышения.
 *
 * Ограничения: промпт показывает только интерактивный десктоп (в services/session 0
 * фолбэк выключен), ответа ждём `UAC_TIMEOUT_MS`, отключается он
 * `AGENT_STEWARD_NO_UAC=1` (CI, headless, сервисы).
 */

/** Флаги schtasks, которые меняют планировщик: только для них просим повышение. */
const ELEVATABLE_FLAGS = new Set(["/create", "/delete", "/change", "/run", "/end"]);

/** Отключение фолбэка (CI/headless/сервисы): AGENT_STEWARD_NO_UAC=1. */
export const NO_UAC_ENV = "AGENT_STEWARD_NO_UAC";

/** Сколько ждать ответа на запрос повышения. */
export const UAC_TIMEOUT_MS = 120_000;

/** Признак «нет прав» в ошибке schtasks: HRESULT 0x80070005, код 5 или текст. */
export function isAccessDeniedError(err: unknown): boolean {
  const e = (err ?? {}) as { code?: number | null; message?: string; stderr?: string };
  const code =
    typeof e.code === "number" && Number.isFinite(e.code) ? e.code >>> 0 : null;
  if (code === 0x80070005 || code === 5) return true;
  const text = `${e.message ?? ""} ${e.stderr ?? ""}`.toLowerCase();
  return text.includes("access is denied") || text.includes("отказано в доступе");
}

/** Нужен ли UAC-фолбэк для этих аргументов (только изменяющие команды). */
export function shouldTryElevation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if ((env[NO_UAC_ENV] ?? "").trim()) return false;
  if (!ELEVATABLE_FLAGS.has((args[0] ?? "").toLowerCase())) return false;
  // Services/session 0: показать промпт некому, ждать согласия не от кого.
  const session = (env.SESSIONNAME ?? "").trim();
  return !session || /^(console|rdp-tcp)/i.test(session);
}

/** Литерал строки для PowerShell (одинарные кавычки удваиваются). */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Запускает schtasks через повышенный `cmd.exe` и возвращает вывод как обычно.
 *
 * Права запрашивает ShellExecute (`-Verb RunAs`), поэтому stdout/stderr нельзя
 * унаследовать — они пишутся во временные файлы, а код возврата — в `code.txt`.
 * Кавычки собирает `quoteCmdArg` (PL-54), сама командная строка передаётся через
 * файл, а скрипт PowerShell — base64, так что метасимволы из имени задачи нигде
 * не разбираются оболочкой.
 *
 * `opts` — тестовый шов: `verb: null` прогоняет ту же цепочку cmd.exe → exe без
 * повышения, `exe` подставляет заглушку вместо schtasks.exe.
 */
export async function runSchtasksElevated(
  args: string[],
  opts: { verb?: string | null; exe?: string; timeoutMs?: number } = {},
): Promise<SchtasksResult> {
  const verb = opts.verb === undefined ? "runas" : opts.verb;
  const exe =
    opts.exe ??
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-steward-uac-"));
  const outFile = path.join(dir, "stdout.txt");
  const errFile = path.join(dir, "stderr.txt");
  const codeFile = path.join(dir, "code.txt");
  const lineFile = path.join(dir, "cmdline.txt");
  try {
    const line =
      `"${exe}" ${args.map(quoteCmdArg).join(" ")}` +
      ` 1> "${outFile}" 2> "${errFile}"`;
    await fs.writeFile(lineFile, line, "utf8");

    const verbParam = verb ? ` -Verb ${psLiteral(verb)}` : "";
    const script =
      "$ErrorActionPreference = 'Stop'\n" +
      `$line = [IO.File]::ReadAllText(${psLiteral(lineFile)}, [Text.Encoding]::UTF8)\n` +
      "$cmd = [IO.Path]::Combine($env:SystemRoot, 'System32', 'cmd.exe')\n" +
      `$p = Start-Process -FilePath $cmd -ArgumentList ('/S /c "' + $line + '"')${verbParam} -Wait -PassThru -WindowStyle Hidden\n` +
      `[IO.File]::WriteAllText(${psLiteral(codeFile)}, [string]$p.ExitCode)\n`;

    try {
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        {
          windowsHide: true,
          maxBuffer: MAX_OUTPUT_BUFFER,
          timeout: opts.timeoutMs ?? UAC_TIMEOUT_MS,
        },
      );
    } catch (err) {
      const e = err as { killed?: boolean; message?: string; stderr?: string | Buffer };
      const stderr = Buffer.isBuffer(e.stderr) ? e.stderr.toString("utf8") : (e.stderr ?? "");
      const text = `${e.message ?? ""} ${stderr}`;
      if (e.killed) {
        throw new Error(`повышение не подтверждено за ${Math.round((opts.timeoutMs ?? UAC_TIMEOUT_MS) / 1000)} с`);
      }
      if (/canceled by the user|отменена пользователем|1223|0x800704c7/i.test(text)) {
        throw new Error("повышение отклонено пользователем");
      }
      throw new Error(`не удалось повысить права: ${(text.split(/\r?\n/)[0] ?? text).trim()}`);
    }

    const codeRaw = (await fs.readFile(codeFile, "utf8").catch(() => "")).trim();
    if (codeRaw === "") {
      throw new Error("повышенный запуск не вернул код возврата");
    }
    return {
      stdout: await decodeConsoleOutput(await fs.readFile(outFile).catch(() => Buffer.alloc(0))),
      stderr: await decodeConsoleOutput(await fs.readFile(errFile).catch(() => Buffer.alloc(0))),
      code: Number.parseInt(codeRaw, 10),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Повышение уже отклонено/не ответили — не просим заново до перезапуска процесса. */
let elevationUnavailable = false;

/** Повтор команды с повышением; при отказе сохраняется исходная ошибка. */
async function runSchtasksWithElevation(
  args: string[],
  failure: SchtasksError,
): Promise<SchtasksResult> {
  if (elevationUnavailable) {
    throw new SchtasksError(
      `${failure.message} | повышение уже отклонено в этой сессии — перезапустите OpenCode с правами администратора`,
      failure.code,
      failure.stderr,
    );
  }

  let result: SchtasksResult;
  try {
    result = await runSchtasksElevated(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/отклонено|не подтверждено/.test(message)) {
      elevationUnavailable = true;
    }
    throw new SchtasksError(`${failure.message} | ${message}`, failure.code, failure.stderr);
  }

  if (result.code !== 0) {
    // В повышенном режиме schtasks тоже может ошибаться («уже существует» и т.п.).
    throw new SchtasksError(
      `schtasks error: ${[result.stdout, result.stderr].filter(Boolean).join(" | ")}`,
      result.code,
      result.stderr,
    );
  }
  return result;
}

/** Формирует полное имя задачи с папкой плагина. */
export function taskFullName(name: string): string {
  if (
    name.startsWith(WINDOWS_TASK_PREFIX) ||
    name.startsWith(LEGACY_WINDOWS_TASK_PREFIX)
  ) {
    return name;
  }
  return WINDOWS_TASK_PREFIX + name;
}

/**
 * Признак того, что schtasks не нашёл задачу (локаль-независимый набор фраз).
 * Используется для fallback на старую папку windows-scheduler.
 */
function isTaskNotFoundText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("cannot find") ||
    t.includes("не удалось найти") ||
    t.includes("не удается найти") ||
    t.includes("не может найти") ||
    t.includes("не найдено") ||
    t.includes("the system cannot find the file specified") ||
    t.includes("no tasks") ||
    t.includes("could not find")
  );
}

function isTaskNotFoundError(err: unknown): boolean {
  if (!(err instanceof SchtasksError)) return false;
  return isTaskNotFoundText(`${err.message} ${err.stderr}`);
}

/**
 * QW-15.2: дедупликация задач из новой и legacy-папок.
 *
 * Раньше сохранялась «первая попавшаяся» запись, и корректность выбора новой
 * папки держалась на алфавитном порядке вывода schtasks. Теперь при коллизии
 * короткого имени явно побеждает запись из новой папки; legacy-дубль
 * отбрасывается независимо от порядка вывода.
 */
export function preferNewFolderTasks(
  tasks: readonly ScheduledTaskInfo[],
  newPrefix: string,
  legacyPrefix: string,
): ScheduledTaskInfo[] {
  const shortName = (fullName: string): string => {
    if (fullName.startsWith(newPrefix)) return fullName.slice(newPrefix.length);
    if (fullName.startsWith(legacyPrefix)) return fullName.slice(legacyPrefix.length);
    return fullName;
  };
  const isNew = (fullName: string): boolean => fullName.startsWith(newPrefix);

  const preferred = new Map<string, ScheduledTaskInfo>();
  for (const task of tasks) {
    const fullName = task.taskName || "";
    const key = shortName(fullName).toLowerCase();
    if (!key) continue;
    const existing = preferred.get(key);
    if (
      !existing ||
      (isNew(fullName) && !isNew(existing.taskName || ""))
    ) {
      preferred.set(key, task);
    }
  }
  return Array.from(preferred.values());
}

/**
 * Бэкенд Планировщика заданий Windows (schtasks).
 *
 * Вся Windows-специфика (кодировка консоли, формат /tn, ONCE-заглушка для
 * файловых триггеров) инкапсулирована здесь.
 */
export class WindowsScheduler implements SchedulerBackend {
  readonly platform: NodeJS.Platform = "win32";
  readonly title = "agent-steward by DeadSno";

  /** Имя папки задач и её префикс — в пространстве имён своего профиля. */
  private readonly taskFolderName: string;
  private readonly taskPrefix: string;
  /** Старая (до переименования) папка — только чтение/миграция. */
  private readonly legacyTaskFolderName: string;
  private readonly legacyTaskPrefix: string;

  constructor(profile: string = getProfileName()) {
    this.taskFolderName = taskFolderNameForProfile(profile);
    this.taskPrefix = windowsTaskPrefixForProfile(profile);
    this.legacyTaskFolderName = legacyTaskFolderNameForProfile(profile);
    this.legacyTaskPrefix = legacyWindowsTaskPrefixForProfile(profile);
  }

  /** Полное имя задачи (\OpenCode\<профиль>\<name>) для этого бэкенда. */
  private fullName(name: string): string {
    return name.startsWith(this.taskPrefix) || name.startsWith(this.legacyTaskPrefix)
      ? name
      : this.taskPrefix + name;
  }

  /** Оба возможных полных имени: новое и старое (для поиска legacy-задач). */
  fullNames(name: string): string[] {
    const candidate = this.fullName(name);
    const names = [candidate];
    if (!candidate.startsWith(this.legacyTaskPrefix)) {
      names.push(this.legacyTaskPrefix + name);
    }
    return names;
  }

  /** Убирает папку профиля (новую или старую) из полного имени задачи. */
  private shortName(fullName: string): string {
    if (fullName.startsWith(this.taskPrefix)) {
      return fullName.slice(this.taskPrefix.length);
    }
    if (fullName.startsWith(this.legacyTaskPrefix)) {
      return fullName.slice(this.legacyTaskPrefix.length);
    }
    return fullName;
  }

  async createTask(options: CreateTaskOptions): Promise<void> {
    const { name, command, schedule, triggerType } = options;

    let scheduleFlags: string[];

    if (triggerType === "once") {
      // Настоящий one-shot: Windows сам удалит задачу из расписания после
      // единственного запуска, повторных срабатываний не будет.
      if (!options.runAt) {
        throw new Error(
          `Задача "${name}": для triggerType=once не передано время runAt.`,
        );
      }
      const [dateFormat, locale] = await Promise.all([
        getWindowsDateFormat(),
        getWindowsLocale(),
      ]);
      scheduleFlags = buildWindowsOneShotFlags(options.runAt, dateFormat, locale);
    } else if (triggerType && triggerType !== "cron") {
      // Файловый или MCP-триггер: однократный запуск в далёком будущем.
      // Активация — только вручную (runTask / файловый watcher / emit_event).
      // Дата форматируется в формате системной локали (P1-8), а не захардкожена
      // под русскую DD.MM.YYYY.
      const dateFormat = await getWindowsDateFormat();
      scheduleFlags = [
        "/sc",
        "ONCE",
        "/sd",
        await buildNeverDate(dateFormat),
        "/st",
        "00:00",
      ];
    } else {
      // Выражения, которые Windows не выражает нативно (список через запятую, L, #,
      // именованные месяцы и т.д.), падают в минутный опрос + gate во враппере.
      const tz = options.timezone?.trim() || null;
      const poll = needsPollMode(schedule, tz);
      if (poll) {
        scheduleFlags = ["/sc", "MINUTE", "/mo", "1"];
      } else {
        // parseCron/валидация УЖЕ выполнена вызывающим кодом перед этим местом.
        const native = convertCronToSchTasks(schedule);
        scheduleFlags = buildScheduleFlags(native);
      }
    }

    // V009-5: /sd от PL-57 (MONTHLY) и PL-75 (catch-up) приходит в DD.MM.YYYY.
    // Для en-US/windows-latest такой формат отвергается schtasks; приводим
    // границу к ShortDatePattern системы до передачи флагов в /create.
    // V009-6: ShortDatePattern PowerShell и формат, который фактически ждёт
    // schtasks, могут расходиться (LOCAL ≡ SYSTEM). Поэтому сохраняем исходные
    // границы и при отказе «неверная дата начала» ретраим /create в других
    // поддерживаемых schtasks форматах; шаблон из Get-Culture остаётся первым.
    const rawStartBoundaries: string[] = [];
    let detectedDateFormat: string | undefined;
    let detectedLocale: string | undefined;
    if (!triggerType || triggerType === "cron") {
      const [dateFormat, locale] = await Promise.all([
        getWindowsDateFormat(),
        getWindowsLocale(),
      ]);
      detectedDateFormat = dateFormat;
      detectedLocale = locale;
      for (let i = 0; i < scheduleFlags.length - 1; i += 1) {
        if (scheduleFlags[i] === "/sd") {
          rawStartBoundaries.push(scheduleFlags[i + 1]);
          scheduleFlags[i + 1] = formatCronBoundaryForLocale(
            scheduleFlags[i + 1],
            dateFormat,
            locale,
          );
          break;
        }
      }

      // PL-75: пересоздание cron-задачи (update_task) не должно наследовать
      // прошедшую start boundary — иначе schtasks включает catch-up и запускает
      // задачу сразу после зелёного гейта. Добавляем явную будущую /sd, если
      // конвертер её ещё не выставил (MONTHLY получает её сам, см. PL-57).
      if (options.avoidCatchUp && !scheduleFlags.includes("/sd")) {
        const raw = cronStartBoundary(schedule);
        rawStartBoundaries.push(raw);
        scheduleFlags.push(
          "/sd",
          formatCronBoundaryForLocale(raw, dateFormat, locale),
        );
      }
    }

    // Создаём всегда в новой папке, даже если передано полное legacy-имя.
    const fullName = this.taskPrefix + this.shortName(name);
    // Спринт 27.5.4: по умолчанию задача интерактивная — schtasks запускает её
    // только при активном входе пользователя (Interactive only). Для работы без
    // входа нужен SYSTEM: он не требует пароля, но работает в session 0 без
    // профиля пользователя (нет доступа к пользовательским файлам/сети/ключам).
    const logonFlags = options.runWhenLoggedOff ? ["/ru", "SYSTEM"] : [];
    // QA-CONSOLE-1: голый `.cmd` в /tr заставляет Планировщик показать окно
    // cmd.exe на рабочем столе. Запускаем его через windowless WSH-шип.
    const hiddenLauncherPath = await ensureHiddenLauncher();
    const args: string[] = [
      "/create",
      "/tn",
      fullName,
      "/tr",
      buildWindowsHiddenTaskCommand(command, hiddenLauncherPath),
      ...scheduleFlags,
      ...logonFlags,
      "/f",
    ];

    // V009-6: если Get-Culture и schtasks расходятся в формате /sd, пробуем
    // остальные форматы, не меняя остальные флаги и не создавая задачу дважды.
    const sdFormats = [
      ...new Set([
        detectedDateFormat || "dd.MM.yyyy",
        "dd.MM.yyyy",
        "M/d/yyyy",
        "MM/dd/yyyy",
        "yyyy-MM-dd",
      ]),
    ];
    const attempts: string[][] = [args];
    if (rawStartBoundaries.length > 0) {
      for (const format of sdFormats.slice(1)) {
        const attempt = [...args];
        let boundaryIndex = 0;
        for (let i = 0; i < attempt.length - 1; i += 1) {
          if (attempt[i] === "/sd" && boundaryIndex < rawStartBoundaries.length) {
            attempt[i + 1] = formatCronBoundaryForLocale(
              rawStartBoundaries[boundaryIndex],
              format,
              detectedLocale,
            );
            boundaryIndex += 1;
          }
        }
        attempts.push(attempt);
      }
    }

    let result: SchtasksResult | undefined;
    let createError: SchtasksError | undefined;
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      try {
        result = await runSchtasks(attempts[attemptIndex]);
        createError = undefined;
        break;
      } catch (err) {
        if (!(err instanceof SchtasksError)) throw err;
        createError = err;
        const text = `${err.stderr} ${err.message}`.toLowerCase();
        const invalidStartBoundary =
          text.includes("start date") ||
          text.includes("дата начала") ||
          text.includes("incorrect start") ||
          text.includes("недопустимый формат даты");
        if (invalidStartBoundary && attemptIndex < attempts.length - 1) {
          continue;
        }
        break;
      }
    }

    if (createError) {
      const err = createError;
      const text = `${err.stderr} ${err.message}`.toLowerCase();

      const isRunning =
        text.includes("running") ||
        text.includes("выполняется") ||
        text.includes("запущена") ||
        text.includes("busy") ||
        text.includes("in use") ||
        text.includes("используется");

      if (isRunning) {
        throw new SchtasksError(
          `Задача с именем "${name}" уже существует и выполняется. Дождитесь её завершения или удалите её.`,
          err.code,
          err.stderr,
        );
      }

      const alreadyExists =
        text.includes("already exists") || text.includes("уже существует");

      if (alreadyExists) {
        throw new SchtasksError(
          `Задача с именем "${name}" уже существует. Используйте delete_task или выберите другое имя.`,
          err.code,
          err.stderr,
        );
      }

      throw new SchtasksError(
        `Не удалось создать задачу "${name}": ${
          err.stderr || err.message || "неизвестная ошибка schtasks"
        }`,
        err.code,
        err.stderr,
      );
    }
    if (result?.code === 0) {
      // После успешного создания в новой папке убираем возможный дубль из
      // legacy-папки (best-effort: отсутствие дубля — не ошибка).
      await this.removeLegacyDuplicate(name);
      return;
    }
  }

  /** Удаляет одноимённую задачу из старой папки, если она там осталась. */
  private async removeLegacyDuplicate(name: string): Promise<void> {
    if (this.legacyTaskPrefix === this.taskPrefix) return;
    const legacyFull = this.legacyTaskPrefix + this.shortName(name);
    try {
      await runSchtasks([
        "/delete",
        "/tn",
        legacyFull.replace(/^\\+/, ""),
        "/f",
      ]);
    } catch {
      // Дубликата нет или нет прав — создание уже прошло, не мешаем.
    }
  }

  async listTasks(): Promise<ScheduledTaskInfo[]> {
    // /v нужен, чтобы ОС отдала «Режим входа» (Logon Mode): без него
    // schtasks печатает только имя, время и состояние, а logonMode остаётся null.
    const args = ["/query", "/v", "/fo", "LIST"];

    let result: SchtasksResult;
    try {
      result = await runSchtasks(args);
    } catch (err) {
      if (err instanceof SchtasksError && isEmptyQueryResult(err)) {
        return [];
      }
      throw err;
    }

    if (!result.stdout?.trim()) {
      return [];
    }

    const allTasks = parseListOutput(result.stdout).filter((task) =>
      Boolean(task.taskName),
    );
    const filtered = allTasks.filter((task) => {
      const name = task.taskName || "";
      return (
        name.startsWith(this.taskPrefix) ||
        name.startsWith(this.legacyTaskPrefix)
      );
    });

    // Fallback: если структурный парсер не распознал ключи (нестандартная
    // локаль/кодировка), вытаскиваем имена задач по префиксу папки.
    if (
      filtered.length === 0 &&
      (result.stdout.includes(this.taskFolderName) ||
        result.stdout.includes(this.legacyTaskFolderName))
    ) {
      const names = new Set<string>();
      const folderPattern = `${TASK_FOLDER}[\\\\/](?:${this.taskFolderName}|${this.legacyTaskFolderName})[\\\\/]`;
      const re = new RegExp(`${folderPattern}([^\\r\\n"']+)`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(result.stdout)) !== null) {
        const nm = m[1].trim().replace(/[\s:]+$/, "");
        if (nm) names.add(nm);
      }
      if (names.size > 0) {
        // QW-15.2: даже в fallback-ветке дубли из legacy-папки не должны
        // вытеснять запись из новой папки.
        const candidates = Array.from(names).map((nm) => ({ taskName: nm }));
        return preferNewFolderTasks(candidates, this.taskPrefix, this.legacyTaskPrefix).map(
          (task) => ({ taskName: this.shortName(task.taskName || "") }),
        );
      }
    }

    // Если в обеих папках остались задачи с одинаковым коротким именем,
    // показываем одну (новую) — дубликат мог остаться после миграции.
    const candidates = preferNewFolderTasks(filtered, this.taskPrefix, this.legacyTaskPrefix);
    return candidates.map((task) => ({
      ...task,
      taskName: this.shortName(task.taskName || ""),
      paused: /disabled|отключ|запрещ/i.test(task.status ?? ""),
    }));
  }

  async deleteTask(name: string): Promise<void> {
    // schtasks /delete требует имя без ведущего обратного слэша.
    let lastError: unknown = null;
    for (const candidate of this.fullNames(name)) {
      const fullName = candidate.replace(/^\\+/, "");
      try {
        await runSchtasks(["/delete", "/tn", fullName, "/f"]);
        return;
      } catch (err) {
        lastError = err;
        // Новая папки нет — пробуем legacy. Прочие ошибки прерывают цикл.
        if (!isTaskNotFoundError(err)) break;
      }
    }
    if (isTaskNotFoundError(lastError)) return;
    const err = lastError as { code?: number | null; stderr?: string };
    throw new SchtasksError(
      `Не удалось удалить задачу "${name}"`,
      err?.code ?? null,
      err?.stderr ?? "",
    );
  }

  /** Ставит задачу на паузу (/disable). */
  async pauseTask(name: string): Promise<void> {
    let lastError: unknown = null;
    for (const candidate of this.fullNames(name)) {
      const fullName = candidate.replace(/^\\+/, "");
      try {
        await runSchtasks(["/change", "/tn", fullName, "/disable"]);
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof SchtasksError) {
          const text = `${err.message} ${err.stderr}`.toLowerCase();
          if (text.includes("disabled") || text.includes("запрещена")) return;
        }
        if (!isTaskNotFoundError(err)) break;
      }
    }
    const err = lastError as { code?: number | null; stderr?: string };
    throw new SchtasksError(
      `Не удалось поставить задачу "${name}" на паузу`,
      err?.code ?? null,
      err?.stderr ?? "",
    );
  }

  /** Снимает задачу с паузы (/enable). */
  async resumeTask(name: string): Promise<void> {
    let lastError: unknown = null;
    for (const candidate of this.fullNames(name)) {
      const fullName = candidate.replace(/^\\+/, "");
      try {
        await runSchtasks(["/change", "/tn", fullName, "/enable"]);
        return;
      } catch (err) {
        lastError = err;
        if (err instanceof SchtasksError) {
          const text = `${err.message} ${err.stderr}`.toLowerCase();
          if (text.includes("enabled") || text.includes("включена")) return;
        }
        if (!isTaskNotFoundError(err)) break;
      }
    }
    const err = lastError as { code?: number | null; stderr?: string };
    throw new SchtasksError(
      `Не удалось снять задачу "${name}" с паузы`,
      err?.code ?? null,
      err?.stderr ?? "",
    );
  }

  /**
   * Проверяет, находится ли задача в состоянии Running.
   * Ошибки запроса списка не должны ломать основной сценарий.
   */
  private async isTaskRunning(name: string): Promise<boolean> {
    try {
      const tasks = await this.listTasks();
      const task = tasks.find(
        (t) => (t.taskName ?? "").toLowerCase() === name.toLowerCase(),
      );
      return /running|выполняется/i.test(task?.status ?? "");
    } catch {
      return false;
    }
  }

  /**
   * QA-D316-28: задача может жить в папке другого профиля (например, агент
   * из worktree использует свой профиль). Добавляем к двум обычным кандидатам
   * все найденные в Планировщике папки плагина, чтобы run_task_now не падал
   * сырой ошибкой legacy-пути.
   */
  private async runNameCandidates(name: string): Promise<string[]> {
    const names = this.fullNames(name);
    try {
      const { stdout } = await execFileAsync("schtasks", ["/query", "/fo", "LIST"], {
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: MAX_OUTPUT_BUFFER,
      });
      const text = await decodeConsoleOutput(errorBuffer({ stdout }, "stdout"));
      const prefix = `\\${TASK_FOLDER}\\`;
      const re = new RegExp(prefix.replace(/\\/g, "\\\\") + "([^\\\\\\r\\n]+)\\\\", "gi");
      for (const match of text.matchAll(re)) {
        const folder = match[1];
        if (!/^(agent-steward|windows-scheduler)(-.*)?$/i.test(folder)) continue;
        const candidate = `${prefix}${folder}\\${name}`;
        if (!names.includes(candidate)) names.push(candidate);
      }
    } catch {
      // Опрос Планировщика — best effort; обычные кандидаты остаются.
    }
    return names;
  }

  async runTask(name: string): Promise<RunTaskResult> {
    const candidates = await this.runNameCandidates(name);
    for (let i = 0; i < candidates.length; i++) {
      const args = ["/run", "/tn", candidates[i]];

      // /run тоже может требовать повышения → общий путь с UAC-фолбэком.
      try {
        await runSchtasks(args);
        return { alreadyRunning: false };
      } catch (err) {
        const e = err as { message?: string; code?: number | null; stderr?: string };
        const errorDetails = `${e.message ?? ""} ${e.stderr ?? ""}`.trim();

        const text = errorDetails.toLowerCase();
        const saysAlreadyRunning =
          text.includes("already running") ||
          text.includes("уже выполняется") ||
          text.includes("уже запущена");

        if (saysAlreadyRunning || (await this.isTaskRunning(name))) {
          return { alreadyRunning: true };
        }

        // Новая папка пуста — задача могла остаться в legacy-папке.
        if (isTaskNotFoundText(errorDetails) && i < candidates.length - 1) {
          continue;
        }

        throw err instanceof SchtasksError
          ? err
          : new SchtasksError(
            `schtasks error: ${errorDetails}`,
            e.code ?? null,
            e.stderr ?? "",
          );
      }
    }
    throw new SchtasksError(
      `Не удалось запустить задачу "${name}": задача не найдена. Проверены пути: ${candidates.join(", ")}`,
      null,
      "",
    );
  }
}

/** Определяет, что ошибка schtasks означает «задач не найдено». */
/**
 * QA-CONSOLE-1: задачи, зарегистрированные до появления WSH-шипа, всё ещё
 * запускают голый cmd.exe и показывают окно на рабочем столе. Один раз за
 * установку переписываем их /tr на скрытый запуск, не трогая триггеры.
 * Fail-open: ошибка отдельной задачи не мешает остальным и старту плагина.
 */
export async function migrateWindowsTaskActionsToHiddenLauncher(): Promise<{
  migrated: number;
  skipped: number;
  failed: number;
}> {
  const stats = { migrated: 0, skipped: 0, failed: 0 };
  if (process.platform !== "win32") return stats;

  const marker = join(getPluginDir(), "hidden-launch-migration.v1");

  if (existsSync(marker)) return stats;

  try {
    const launcherPath = await ensureHiddenLauncher();
    const backend = new WindowsScheduler();
    const names = await backend.listTasks();
    for (const task of names) {
      const name = task.taskName;
      if (!name) continue;
      let done = false;
      for (const fullName of backend.fullNames(name)) {
        const queryName = fullName.replace(/^\\+/, "");
        try {
          const { stdout } = await runSchtasks([
            "/query",
            "/tn",
            queryName,
            "/xml",
          ]);
          const commandMatch = /<Command>([\s\S]*?)<\/Command>/i.exec(stdout);
          const rawCommand = commandMatch?.[1]?.trim() ?? "";
          if (!rawCommand || /wscript\.exe/i.test(rawCommand)) {
            stats.skipped += 1;
            done = true;
            break;
          }
          const command = rawCommand.replace(/^"+|"+$/g, "");
          await runSchtasks([
            "/change",
            "/tn",
            queryName,
            "/tr",
            buildWindowsHiddenTaskCommand(command, launcherPath),
          ]);
          stats.migrated += 1;
          done = true;
          break;
        } catch {
          // Задача исчезла, нет прав или имя из legacy-папки — пробуем дальше.
        }
      }
      if (!done) stats.failed += 1;
    }
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, new Date().toISOString(), "utf8");
  } catch {
    // Миграция — оптимизация, а не условие старта.
  }
  return stats;
}

function isEmptyQueryResult(err: SchtasksError): boolean {
  const text = `${err.message} ${err.stderr}`.toLowerCase();
  return (
    text.includes("cannot find") ||
    text.includes("не удалось найти") ||
    text.includes("не найдено") ||
    text.includes("no tasks") ||
    text.includes("не содержит задач")
  );
}

/** Парсит вывод schtasks /query /fo LIST в массив ScheduledTaskInfo. */
function parseListOutput(output: string): ScheduledTaskInfo[] {
  const tasks: ScheduledTaskInfo[] = [];
  const blocks = output.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const task: Record<string, string> = {};
    let currentKey: string | null = null;
    let currentValue: string[] = [];

    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) {
        if (currentKey) currentValue.push(line);
        continue;
      }

      if (currentKey) {
        setTaskField(task, currentKey, currentValue.join(" ").trim());
      }

      currentKey = line.slice(0, colonIndex).trim();
      currentValue = [line.slice(colonIndex + 1).trim()];
    }

    if (currentKey) {
      setTaskField(task, currentKey, currentValue.join(" ").trim());
    }

    // QA-A2.7: schtasks печатает поля как строки; отсутствующие поля остаются undefined.
    tasks.push(task as unknown as ScheduledTaskInfo);
  }

  return tasks;
}

/** Сохраняет поле в объект задачи, преобразуя ключи schtasks в camelCase. */
export function setTaskField(task: Record<string, string>, key: string, value: string): void {
  const keyLower = key.toLowerCase();

  const map: Record<string, string> = {
    // English keys (US locale)
    folder: "folder",
    taskname: "taskName",
    tasknametorun: "taskNameToRun",
    nextruntime: "nextRunTime",
    status: "status",
    logonmode: "logonMode",
    lastruntime: "lastRunTime",
    lastresult: "lastResult",
    author: "author",
    tasktorun: "taskToRun",
    comment: "comment",
    // Russian keys (RU locale)
    папка: "folder",
    "имя задачи": "taskName",
    "требуемое имя задачи": "taskNameToRun",
    "следующее время запуска": "nextRunTime",
    состояние: "status",
    "режим входа": "logonMode",
    // RU Windows 10/11 в /v печатает полную формулировку.
    "режим входа в систему": "logonMode",
    "последнее время запуска": "lastRunTime",
    "последний результат": "lastResult",
    автор: "author",
    команда: "taskToRun",
    комментарий: "comment",
    // German (DE)
    ordner: "folder",
    aufgabenname: "taskName",
    "nächste ausführungszeit": "nextRunTime",
    "nächste laufzeit": "nextRunTime",
    "anmeldemodus": "logonMode",
    "letzte laufzeit": "lastRunTime",
    "letztes ergebnis": "lastResult",
    // French (FR)
    dossier: "folder",
    "nom de la tâche": "taskName",
    "prochaine exécution": "nextRunTime",
    état: "status",
    statut: "status",
    "mode d'ouverture de session": "logonMode",
    "dernière exécution": "lastRunTime",
    "dernier résultat": "lastResult",
    // Spanish (ES)
    carpeta: "folder",
    "nombre de tarea": "taskName",
    "próxima ejecución": "nextRunTime",
    estado: "status",
    "modo de inicio de sesión": "logonMode",
    "última ejecución": "lastRunTime",
    "último resultado": "lastResult",
    // Italian (IT)
    cartella: "folder",
    "nome attività": "taskName",
    "prossima esecuzione": "nextRunTime",
    stato: "status",
    "modalità di accesso": "logonMode",
    "ultima esecuzione": "lastRunTime",
    "ultimo risultato": "lastResult",
    // Polish (PL)
    "nazwa zadania": "taskName",
    "następne uruchomienie": "nextRunTime",
    stan: "status",
    "tryb logowania": "logonMode",
    "ostatnie uruchomienie": "lastRunTime",
    "ostatni wynik": "lastResult",
    // Chinese (ZH)
    "文件夹": "folder",
    "任务名": "taskName",
    "任务名称": "taskName",
    "要运行的任务": "taskToRun",
    "运行的任务": "taskToRun",
    "下次运行时间": "nextRunTime",
    "下一次运行时间": "nextRunTime",
    "状态": "status",
    "登录模式": "logonMode",
    "登录状态": "logonMode",
    "上次运行时间": "lastRunTime",
    "上一次运行时间": "lastRunTime",
    "上次结果": "lastResult",
    "作者": "author",
    "注释": "comment",
  };

  const field =
    map[keyLower] ?? map[keyLower.replace(/\s+/g, "")];
  if (field) {
    task[field] = value;
  }
}
