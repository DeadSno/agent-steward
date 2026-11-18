/**
 * Кроссплатформенный запуск OpenCode CLI.
 *
 * На Windows `opencode` — это `opencode.cmd`. Node с 18.20/20.12 запрещает
 * запускать `.cmd`/`.bat` через `execFile` без shell (EINVAL), а имя без
 * расширения не находится вовсе (ENOENT). Поэтому на Windows команда идёт
 * через `cmd.exe /d /s /c` — ровно так же, как в `opencode-models.ts`.
 *
 * Модуль не бросает: результат запуска возвращается объектом, чтобы вызывающий
 * сам решал, писать предупреждение или продолжать молча.
 */
import { execFile } from "node:child_process";

/** Готовая команда для `execFile`/`execFileSync`. */
export interface OpencodeCommand {
  file: string;
  args: string[];
}

/** Аргументы без спецсимволов cmd.exe можно передавать как есть. */
const SAFE_ARG = /^[A-Za-z0-9_.,:@/\\+=-]+$/;

/** Результат запуска CLI. */
export interface RunOpencodeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Текст ошибки запуска (только при ok = false). */
  error?: string;
}

/**
 * Экранирует аргумент для командной строки cmd.exe.
 * Бросает на переводы строк: они разрывают команду на две.
 */
export function quoteCmdArg(arg: string): string {
  if (/[\r\n]/.test(arg)) {
    throw new Error("Аргумент командной строки не может содержать перевод строки");
  }
  if (SAFE_ARG.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Команда запуска OpenCode для указанной платформы (чистая функция). */
export function opencodeCommandFor(
  platform: NodeJS.Platform,
  args: string[],
): OpencodeCommand {
  if (platform !== "win32") return { file: "opencode", args: args.slice() };
  const line = ["opencode", ...args].map(quoteCmdArg).join(" ");
  return { file: "cmd.exe", args: ["/d", "/s", "/c", line] };
}

/** Команда запуска OpenCode на текущей платформе. */
export function opencodeCommand(args: string[]): OpencodeCommand {
  return opencodeCommandFor(process.platform, args);
}

/**
 * Запускает OpenCode CLI и ждёт завершения. Никогда не бросает.
 * `timeoutMs` защищает от зависшего процесса: CLI не должен держать ротацию.
 */
export function runOpencode(
  args: string[],
  timeoutMs = 30_000,
): Promise<RunOpencodeResult> {
  let command: OpencodeCommand;
  try {
    command = opencodeCommand(args);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return new Promise<RunOpencodeResult>((resolve) => {
    execFile(
      command.file,
      command.args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            error: error.message,
          });
          return;
        }
        resolve({ ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}
