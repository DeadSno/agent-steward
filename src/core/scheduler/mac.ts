import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeName } from "../../types.js";
import { getProfileDir, getProfileName } from "../../profiles.js";
import { buildLaunchdCalendar, buildOneShotGuardCommand, launchdLabel } from "../one-shot.js";
import {
  needsPollMode,
  systemTimeZone,
} from "../schedule-v2.js";
import { PosixSchedulerBase } from "./posix.js";
import type { RegistryEntry } from "./registry.js";

const execFileAsync = promisify(execFile);

/** Папка пользовательских LaunchAgents. */
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");

/** Экранирует текст для XML. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Один элемент StartCalendarInterval. */
interface LaunchdCalendar {
  Minute?: number;
  Hour?: number;
  Weekday?: number;
  Month?: number;
  Day?: number;
}

/** Расписание launchd, полученное из cron-выражения. */
interface LaunchdSchedule {
  /** StartInterval в секундах (для poll-режима «каждую минуту»). */
  interval?: number;
  /** Одиночный StartCalendarInterval (фиксированное время). */
  calendar?: LaunchdCalendar;
  /** Массив StartCalendarInterval (например, минуты 0,15,30,45). */
  calendars?: LaunchdCalendar[];
}

/**
 * Преобразует поддерживаемое 5-полевое cron-выражение в расписание launchd.
 * Поддерживается то же подмножество, что и у Windows-бэкенда.
 */
export function cronToLaunchdSchedule(cron: string): LaunchdSchedule {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Ожидалось 5 полей cron-выражения, получено ${fields.length}.`,
    );
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const star = (v: string) => v === "*";
  const intIn = (v: string, min: number, max: number): number | undefined => {
    if (!/^\d+$/.test(v)) return undefined;
    const n = parseInt(v, 10);
    return n >= min && n <= max ? n : undefined;
  };

  if (
    star(minute) && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)
  ) {
    return { interval: 60 };
  }

  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    const n = parseInt(step[1], 10);
    if (n > 0) {
      // P1-6: выравниваем по cron-сетке (0, N, 2N, …), а не отсчитываем
      // интервал от момента загрузки агента. launchd принимает массив
      // StartCalendarInterval — по dict на каждую минуту.
      const calendars: LaunchdCalendar[] = [];
      for (let m = 0; m < 60; m += n) calendars.push({ Minute: m });
      return { calendars };
    }
  }

  const m = intIn(minute, 0, 59);
  const h = intIn(hour, 0, 23);
  if (m === undefined) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }

  // M * * * * — каждый час в минуту M.
  if (star(hour) && star(dayOfMonth) && star(month) && star(dayOfWeek)) {
    return { calendar: { Minute: m } };
  }

  if (h === undefined || !star(dayOfMonth) || !star(month)) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }

  // M H * * * — ежедневно.
  if (star(dayOfWeek)) {
    return { calendar: { Minute: m, Hour: h } };
  }

  // M H * * D — еженедельно (0 и 7 — воскресенье).
  const d = intIn(dayOfWeek, 0, 7);
  if (d === undefined) {
    throw new Error("Неподдерживаемое cron-выражение для launchd.");
  }
  return { calendar: { Minute: m, Hour: h, Weekday: d } };
}

/** Добавляет поля одного StartCalendarInterval-dict с заданным отступом. */
function pushCalendarFields(
  out: string[],
  cal: LaunchdCalendar,
  indent: string,
): void {
  const fields: [string, number | undefined][] = [
    ["Minute", cal.Minute],
    ["Hour", cal.Hour],
    ["Weekday", cal.Weekday],
    ["Month", cal.Month],
    ["Day", cal.Day],
  ];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    out.push(`${indent}<key>${key}</key>`, `${indent}<integer>${value}</integer>`);
  }
}

/** Собирает XML plist для задачи. */
function buildPlist(label: string, entry: RegistryEntry): string {
  const schedule: {
    interval?: number;
    calendar?: LaunchdCalendar;
    calendars?: LaunchdCalendar[];
  } =
    entry.triggerType === "once"
      ? (() => {
        if (!entry.runAt) {
          throw new Error(
            `Задача "${entry.name}": для one-shot не задано runAt.`,
          );
        }
        return { calendar: buildLaunchdCalendar(entry.runAt) };
      })()
      : entry.triggerType !== "cron"
        ? { interval: 315_360_000 } // file/mcp-event: 10 лет — фактически «никогда».
        : (() => {
          // P1-5: чужой IANA-таймзона — poll-режим (StartInterval 60 + gate во враппере),
          // иначе crontab сработает по системному времени, а не по таймзоне задачи.
          const tz = entry.timezone?.trim();
          if (tz && tz !== systemTimeZone()) return { interval: 60 };
          // P1-6: неконвертируемый cron (списки, диапазоны, L, #, @daily и т.п.)
          // — poll-режим вместо бросания ошибки. Gate во враппере уже есть
          // (buildScheduleGate), поэтому достаточно StartInterval 60.
          try {
            return cronToLaunchdSchedule(entry.schedule);
          } catch {
            return { interval: 60 };
          }
        })();

  const scheduleXml: string[] = [];
  if (schedule.interval !== undefined) {
    scheduleXml.push(
      "  <key>StartInterval</key>",
      `  <integer>${schedule.interval}</integer>`,
    );
  }
  if (schedule.calendar) {
    scheduleXml.push("  <key>StartCalendarInterval</key>", "  <dict>");
    pushCalendarFields(scheduleXml, schedule.calendar, "    ");
    scheduleXml.push("  </dict>");
  }
  if (schedule.calendars && schedule.calendars.length > 0) {
    scheduleXml.push("  <key>StartCalendarInterval</key>", "  <array>");
    for (const cal of schedule.calendars) {
      scheduleXml.push("    <dict>");
      pushCalendarFields(scheduleXml, cal, "      ");
      scheduleXml.push("    </dict>");
    }
    scheduleXml.push("  </array>");
  }

  const workdir = entry.workingDirectory || process.cwd();
  const log = entry.logFile;
  const logXml = log
    ? [
      "  <key>StandardOutPath</key>",
      `  <string>${xmlEscape(log)}</string>`,
      "  <key>StandardErrorPath</key>",
      `  <string>${xmlEscape(log)}</string>`,
    ]
    : [];

  // P2-12.T2: launchd не умеет год в StartCalendarInterval. Для one-shot
  // запускаем bash -c с проверкой runAt и маркером выполнения, иначе задача
  // сработает в ближайшую годовщину и повторится через год.
  const programArgsXml =
    entry.triggerType === "once" && entry.runAt
      ? (() => {
        const epoch = Math.floor(Date.parse(entry.runAt) / 1000);
        const stamp = path.join(
          LAUNCH_AGENTS_DIR,
          `${label}.once-${epoch}.done`,
        );
        return [
          "    <string>/bin/bash</string>",
          "    <string>-c</string>",
          `    <string>${xmlEscape(
            buildOneShotGuardCommand(entry.command, entry.runAt, stamp),
          )}</string>`,
        ];
      })()
      : [
        "    <string>/bin/bash</string>",
        `    <string>${xmlEscape(entry.command)}</string>`,
      ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
      '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...programArgsXml,
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xmlEscape(workdir)}</string>`,
    ...logXml,
    "  <key>RunAtLoad</key>",
    "  <false/>",
    ...scheduleXml,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** Ошибка запуска launchctl с командой, кодом выхода и stderr. */
export function describeLaunchctlError(args: string[], err: unknown): string {
  const error = err as {
    code?: number | string;
    signal?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    message?: string;
  };
  const stderr = String(error.stderr ?? "").trim();
  const stdout = String(error.stdout ?? "").trim();
  const detail = stderr || stdout || error.message || "вывод пуст";
  const status =
    error.code !== undefined
      ? `код ${String(error.code)}`
      : error.signal
        ? `сигнал ${error.signal}`
        : "без кода выхода";
  return `launchctl ${args.join(" ")}: ${status}: ${detail}`;
}

/**
 * Запускает launchctl и либо пробрасывает ошибку с stderr/exit code,
 * либо глотает её (unload незагруженного агента — штатная ситуация).
 */
export async function runLaunchctl(
  runner: (args: string[]) => Promise<unknown>,
  args: string[],
  options: { tolerateFailure?: boolean } = {},
): Promise<void> {
  try {
    await runner(args);
  } catch (err) {
    if (options.tolerateFailure) return;
    const failure = new Error(describeLaunchctlError(args, err)) as Error & {
      cause?: unknown;
    };
    // target/lib проекта не включает ErrorOptions, поэтому cause ставим вручную.
    failure.cause = err;
    throw failure;
  }
}

/** Команды launchctl при установке записи. */
export interface LaunchctlInstallPlan {
  /** unload перед перезаписью plist (best effort: агент мог быть не загружен). */
  beforeWrite: string[];
  /** load после записи; null — задача на паузе, загружать её нельзя. */
  afterWrite: string[] | null;
}

/**
 * B5: `load -w` не только загружает агент, но и снимает Disabled,
 * поэтому для приостановленной задачи его вызывать нельзя — иначе
 * установка молча возобновляет задачу. Вместо этого `unload -w`
 * фиксирует Disabled, чтобы launchd не загрузил агент при следующем входе.
 */
export function planLaunchctlInstall(
  paused: boolean,
  plistPath: string,
): LaunchctlInstallPlan {
  if (paused) {
    return {
      beforeWrite: ["unload", "-w", plistPath],
      afterWrite: null,
    };
  }
  return {
    beforeWrite: ["unload", plistPath],
    afterWrite: ["load", "-w", plistPath],
  };
}

/**
 * Бэкенд планировщика macOS на основе launchd.
 *
 * Каждая задача — отдельный LaunchAgent:
 *   ~/Library/LaunchAgents/com.opencode.scheduler.<name>.plist
 * Управление — через launchctl load/unload -w. Ошибки load не глотаются:
 * битый plist должен вернуть ошибку установки, а не оставить задачу
 * молча незапланированной.
 */
export class MacScheduler extends PosixSchedulerBase {
  readonly platform: NodeJS.Platform = "darwin";
  readonly title = "agent-steward by DeadSno";

  constructor(profile: string = getProfileName()) {
    super("mac", profile);
    this.profile = profile;
  }

  private readonly profile: string;

  private label(name: string): string {
    const sanitized = sanitizeName(name);
    // Совместимость: до 1.5.6 plist не-default профилей назывался без scope.
    // Используем старое имя, только если plist реально принадлежит этому
    // профилю (в его команде есть директория профиля), иначе можно удалить
    // одноимённый plist активного профиля.
    if (this.profile !== "default") {
      const legacy = launchdLabel(sanitized, "default");
      const legacyPath = path.join(LAUNCH_AGENTS_DIR, `${legacy}.plist`);
      try {
        const text = fsSync.readFileSync(legacyPath, "utf8");
        if (text.includes(getProfileDir(this.profile))) return legacy;
      } catch {
        // Старого plist нет — используем профильное имя.
      }
    }
    return launchdLabel(sanitized, this.profile);
  }

  private plistPath(name: string): string {
    return path.join(LAUNCH_AGENTS_DIR, `${this.label(name)}.plist`);
  }

  /** Выполняет launchctl; tolerateFailure оставлен только для unload. */
  private async launchctl(
    args: string[],
    options: { tolerateFailure?: boolean } = {},
  ): Promise<void> {
    await runLaunchctl(
      (call) => execFileAsync("launchctl", call, { maxBuffer: 1024 * 1024 }),
      args,
      options,
    );
  }

  protected async installEntry(entry: RegistryEntry): Promise<void> {
    await fs.mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
    const plistPath = this.plistPath(entry.name);
    const plan = planLaunchctlInstall(entry.paused, plistPath);
    // Агент мог быть не загружен — это не ошибка.
    await this.launchctl(plan.beforeWrite, { tolerateFailure: true });
    // Пишем в уникальный temp и переименовываем: launchctl не должен увидеть
    // полузаписанный plist, если процесс упадёт посреди записи.
    const tmpPath = `${plistPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmpPath, buildPlist(this.label(entry.name), entry), "utf8");
      await fs.rename(tmpPath, plistPath);
    } catch (error) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw error;
    }
    if (plan.afterWrite) {
      await this.launchctl(plan.afterWrite);
    }
  }

  protected async uninstallEntry(entry: RegistryEntry): Promise<void> {
    const plistPath = this.plistPath(entry.name);
    await this.launchctl(["unload", "-w", plistPath], { tolerateFailure: true });
    await fs.unlink(plistPath).catch(() => {});
  }

  protected async applyPause(entry: RegistryEntry, paused: boolean): Promise<void> {
    const plistPath = this.plistPath(entry.name);
    if (paused) {
      await this.launchctl(["unload", "-w", plistPath], { tolerateFailure: true });
    } else {
      // Возобновление не должно «удаваться» молча при битом plist.
      await this.launchctl(["load", "-w", plistPath]);
    }
  }
}
