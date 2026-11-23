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
 *
 * PL-54: строку `cmd.exe /d /s /c` нельзя передавать в `execFile` с обычным
 * экранированием аргументов — Node экранирует кавычки обратными слэшами,
 * которых cmd.exe не понимает. Из-за этого промпт с двойными кавычками
 * разбивался на части и тихо обрезался. Поэтому для cmd.exe включается
 * `windowsVerbatimArguments`, а кавычки экранируются удвоением в `quoteCmdArg`.
 */
import { execFile } from "node:child_process";
import { validateCmdLineText } from "./task-name.js";

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
 * Экранирует аргумент для командной строки cmd.exe → .cmd → exe.
 *
 * PL-54: двойные кавычки удваиваются (cmd.exe сохраняет их в `%*`, а CRT
 * запускаемого процесса превращает `""` в один литеральный `"`). Обратные
 * слэши перед кавычками (в том числе перед закрывающей) удваиваются, иначе
 * `\"` съедает кавычку и аргумент обрезается. Бросает на переводы строк
 * и NUL — такие символы нельзя передать через командную строку.
 */
export function quoteCmdArg(arg: string): string {
  const error = validateCmdLineText(arg);
  if (error) throw new Error(error);
  if (SAFE_ARG.test(arg)) return arg;
  if (arg === "") return '""';

  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2) + '""';
    } else {
      result += "\\".repeat(backslashes) + char;
    }
    backslashes = 0;
  }
  // Закрывающая кавычка не должна экранироваться висящим обратным слэшем.
  return result + "\\".repeat(backslashes * 2) + '"';
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
 * `cwd` (PL-97) нужен возобновлённым шагам: агент должен стартовать в том же
 * рабочем каталоге, что и исходный прогон.
 */
export function runOpencode(
  args: string[],
  timeoutMs = 30_000,
  cwd?: string,
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
        ...(cwd ? { cwd } : {}),
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        // PL-54: без этого Node экранирует кавычки командной строки
        // обратными слэшами, и cmd.exe передаёт их литералами.
        windowsVerbatimArguments: command.file === "cmd.exe",
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
