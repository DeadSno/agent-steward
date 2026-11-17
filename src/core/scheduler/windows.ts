import { execFile } from "node:child_process";
import { promisify } from "node:util";
import iconv from "iconv-lite";
import type { ScheduledTaskInfo } from "../../types.js";
import { TASK_FOLDER, TASK_FOLDER_NAME, taskFolderNameForProfile } from "../../types.js";
import { getProfileName } from "../../profiles.js";
import { buildScheduleFlags, convertCronToSchTasks } from "../cron-to-schtasks.js";
import { buildWindowsOneShotFlags } from "../one-shot.js";
import { needsPollMode } from "../schedule-v2.js";
import type {
  CreateTaskOptions,
  RunTaskResult,
  SchedulerBackend,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** Максимальный размер вывода schtasks (обычно хватает с большим запасом). */
const MAX_OUTPUT_BUFFER = 10 * 1024 * 1024;

/** Префикс папки задач плагина в Планировщике заданий Windows. */
export const WINDOWS_TASK_PREFIX = `\\${TASK_FOLDER}\\${TASK_FOLDER_NAME}\\`;

/** Префикс папки задач конкретного профиля (для удаления неактивного профиля). */
export function windowsTaskPrefixForProfile(profile: string): string {
  return `\\${TASK_FOLDER}\\${taskFolderNameForProfile(profile)}\\`;
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
    const hexMatch = text.match(/0x([0-9A-Fa-f]{1,8})/i);
    const decMatch = text.match(/\b(\d{2,5})\b/);
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
  text: string
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
  const byText: Array<[string[], string]> = [
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
    public readonly stderr: string
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
    throw new SchtasksError(
      `schtasks error: ${buildErrorDetails(err, stdout, stderr)}`,
      e.code ?? null,
      stderr
    );
  }
}

/** Формирует полное имя задачи с папкой плагина. */
export function taskFullName(name: string): string {
  if (name.startsWith(WINDOWS_TASK_PREFIX)) {
    return name;
  }
  return WINDOWS_TASK_PREFIX + name;
}

/** Убирает папку плагина из полного имени задачи. */
function shortTaskName(fullName: string): string {
  return fullName.startsWith(WINDOWS_TASK_PREFIX)
    ? fullName.slice(WINDOWS_TASK_PREFIX.length)
    : fullName;
}

/**
 * Бэкенд Планировщика заданий Windows (schtasks).
 *
 * Вся Windows-специфика (кодировка консоли, формат /tn, ONCE-заглушка для
 * файловых триггеров) инкапсулирована здесь.
 */
export class WindowsScheduler implements SchedulerBackend {
  readonly platform: NodeJS.Platform = "win32";
  readonly title = "Планировщик Windows";

  /** Имя папки задач и её префикс — в пространстве имён своего профиля. */
  private readonly taskFolderName: string;
  private readonly taskPrefix: string;

  constructor(profile: string = getProfileName()) {
    this.taskFolderName = taskFolderNameForProfile(profile);
    this.taskPrefix = windowsTaskPrefixForProfile(profile);
  }

  /** Полное имя задачи (\OpenCode\<профиль>\<name>) для этого бэкенда. */
  private fullName(name: string): string {
    return name.startsWith(this.taskPrefix) ? name : this.taskPrefix + name;
  }

  /** Убирает папку профиля из полного имени задачи. */
  private shortName(fullName: string): string {
    return fullName.startsWith(this.taskPrefix)
      ? fullName.slice(this.taskPrefix.length)
      : fullName;
  }

  async createTask(options: CreateTaskOptions): Promise<void> {
    const { name, command, schedule, triggerType } = options;

    let scheduleFlags: string[];

    if (triggerType === "once") {
      // Настоящий one-shot: Windows сам удалит задачу из расписания после
      // единственного запуска, повторных срабатываний не будет.
      if (!options.runAt) {
        throw new Error(
          `Задача "${name}": для triggerType=once не передано время runAt.`
        );
      }
      scheduleFlags = buildWindowsOneShotFlags(options.runAt);
    } else if (triggerType && triggerType !== "cron") {
      // Файловый или MCP-триггер: однократный запуск в далёком будущем.
      // Активация — только вручную (runTask / файловый watcher / emit_event).
      scheduleFlags = ["/sc", "ONCE", "/sd", "31.12.2099", "/st", "00:00"];
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

    const fullName = this.fullName(name);
    // Спринт 27.5.4: по умолчанию задача интерактивная — schtasks запускает её
    // только при активном входе пользователя (Interactive only). Для работы без
    // входа нужен SYSTEM: он не требует пароля, но работает в session 0 без
    // профиля пользователя (нет доступа к пользовательским файлам/сети/ключам).
    const logonFlags = options.runWhenLoggedOff ? ["/ru", "SYSTEM"] : [];
    const args: string[] = [
      "/create",
      "/tn",
      fullName,
      "/tr",
      `"${command}"`,
      ...scheduleFlags,
      ...logonFlags,
      "/f",
    ];

    let result: SchtasksResult;
    try {
      result = await runSchtasks(args);
    } catch (err) {
      if (!(err instanceof SchtasksError)) throw err;

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
          err.stderr
        );
      }

      const alreadyExists =
        text.includes("already exists") || text.includes("уже существует");

      if (alreadyExists) {
        throw new SchtasksError(
          `Задача с именем "${name}" уже существует. Используйте delete_task или выберите другое имя.`,
          err.code,
          err.stderr
        );
      }

      throw new SchtasksError(
        `Не удалось создать задачу "${name}": ${
          err.stderr || err.message || "неизвестная ошибка schtasks"
        }`,
        err.code,
        err.stderr
      );
    }
    if (result.code === 0) return;
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

    if (!result.stdout || !result.stdout.trim()) {
      return [];
    }

    const allTasks = parseListOutput(result.stdout).filter((task) =>
      Boolean(task.taskName)
    );
    const filtered = allTasks.filter((task) =>
      (task.taskName || "").startsWith(this.taskPrefix)
    );

    // Fallback: если структурный парсер не распознал ключи (нестандартная
    // локаль/кодировка), вытаскиваем имена задач по префиксу папки.
    if (filtered.length === 0 && result.stdout.includes(this.taskFolderName)) {
      const names = new Set<string>();
      const folderPattern = `${TASK_FOLDER}[\\\\/]${this.taskFolderName}[\\\\/]`;
      const re = new RegExp(`${folderPattern}([^\\r\\n"']+)`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(result.stdout)) !== null) {
        const nm = m[1].trim().replace(/[\s:]+$/, "");
        if (nm) names.add(nm);
      }
      if (names.size > 0) {
        return Array.from(names).map(
          (nm) => ({ taskName: nm } as ScheduledTaskInfo)
        );
      }
    }

    return filtered.map((task) => ({
      ...task,
      taskName: this.shortName(task.taskName || ""),
      paused: /disabled|отключ|запрещ/i.test(task.status ?? ""),
    }));
  }

  async deleteTask(name: string): Promise<void> {
    // schtasks /delete требует имя без ведущего обратного слэша.
    const fullName = taskFullName(name).replace(/^\\+/, "");
    const args = ["/delete", "/tn", fullName, "/f"];
    try {
      await runSchtasks(args);
    } catch (err: any) {
      if (err instanceof SchtasksError) {
        const text = `${err.message} ${err.stderr}`.toLowerCase();
        const alreadyGone =
          text.includes("cannot find") ||
          text.includes("не удалось найти") ||
          text.includes("не удается найти") ||
          text.includes("не может найти") ||
          text.includes("не найдено") ||
          text.includes("the system cannot find the file specified") ||
          text.includes("no tasks") ||
          text.includes("could not find");
        if (alreadyGone) return;
      }
      throw new SchtasksError(
        `Не удалось удалить задачу "${name}"`,
        err.code ?? null,
        err.stderr ?? ""
      );
    }
  }

  /** Ставит задачу на паузу (/disable). */
  async pauseTask(name: string): Promise<void> {
    const fullName = taskFullName(name).replace(/^\\+/, "");
    const args = ["/change", "/tn", fullName, "/disable"];
    try {
      await runSchtasks(args);
    } catch (err: any) {
      if (err instanceof SchtasksError) {
        const text = `${err.message} ${err.stderr}`.toLowerCase();
        const alreadyDisabled =
          text.includes("disabled") || text.includes("запрещена");
        if (alreadyDisabled) return;
      }
      throw new SchtasksError(
        `Не удалось поставить задачу "${name}" на паузу`,
        err.code ?? null,
        err.stderr ?? ""
      );
    }
  }

  /** Снимает задачу с паузы (/enable). */
  async resumeTask(name: string): Promise<void> {
    const fullName = taskFullName(name).replace(/^\\+/, "");
    const args = ["/change", "/tn", fullName, "/enable"];
    try {
      await runSchtasks(args);
    } catch (err: any) {
      if (err instanceof SchtasksError) {
        const text = `${err.message} ${err.stderr}`.toLowerCase();
        const alreadyEnabled =
          text.includes("enabled") || text.includes("включена");
        if (alreadyEnabled) return;
      }
      throw new SchtasksError(
        `Не удалось снять задачу "${name}" с паузы`,
        err.code ?? null,
        err.stderr ?? ""
      );
    }
  }

  /**
   * Проверяет, находится ли задача в состоянии Running.
   * Ошибки запроса списка не должны ломать основной сценарий.
   */
  private async isTaskRunning(name: string): Promise<boolean> {
    try {
      const tasks = await this.listTasks();
      const task = tasks.find(
        (t) => (t.taskName ?? "").toLowerCase() === name.toLowerCase()
      );
      return /running|выполняется/i.test(task?.status ?? "");
    } catch {
      return false;
    }
  }

  async runTask(name: string): Promise<RunTaskResult> {
    const fullName = this.fullName(name);
    const args = ["/run", "/tn", fullName];

    // schtasks /run не требует смены кодировки — вызываем напрямую.
    try {
      await execFileAsync("schtasks", args, {
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: MAX_OUTPUT_BUFFER,
      });
      return { alreadyRunning: false };
    } catch (err) {
      const e = err as { message?: string; code?: number | null };
      const stdout = await decodeConsoleOutput(errorBuffer(err, "stdout"));
      const stderr = await decodeConsoleOutput(errorBuffer(err, "stderr"));
      const errorDetails = buildErrorDetails(err, stdout, stderr);

      const text = errorDetails.toLowerCase();
      const saysAlreadyRunning =
        text.includes("already running") ||
        text.includes("уже выполняется") ||
        text.includes("уже запущена");

      if (saysAlreadyRunning || (await this.isTaskRunning(name))) {
        return { alreadyRunning: true };
      }

      throw new SchtasksError(
        `schtasks error: ${errorDetails}`,
        e.code ?? null,
        stderr
      );
    }
  }
}

/** Определяет, что ошибка schtasks означает «задач не найдено». */
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

    const task: any = {};
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

    tasks.push(task);
  }

  return tasks;
}

/** Сохраняет поле в объект задачи, преобразуя ключи schtasks в camelCase. */
function setTaskField(task: any, key: string, value: string): void {
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
  };

  const field = map[keyLower];
  if (field) {
    task[field] = value;
  }
}
