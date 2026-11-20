/**
 * G-1.2: проверяемый snapshot входов Quality Gate.
 *
 * Обёртка фиксирует хэш команды/хука гейта, промпта и таймаута в момент
 * создания задачи (файл лежит в PLUGIN_DIR, вне write-scope агента) и
 * сверяет его непосредственно перед запуском гейта. Подмена гейта или
 * промпта после создания задачи приводит к fail-closed: гейт не выполняется,
 * запуск помечается ошибкой. Snapshot защищает от подмены *definition*
 * гейта; исходники, которые гейт проверяет, в хэш не входят (агент
 * legitimately меняет их в ходе задачи).
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_DIR, sanitizeName } from "../types.js";

export const GATE_SNAPSHOT_VERSION = 1;
export const GATE_SNAPSHOT_DIR = path.join(PLUGIN_DIR, "gate-snapshots");

export interface GateSnapshotInputs {
  /** Текст гейта: на Windows — содержимое hook-файла, на POSIX — команда. */
  gate: string;
  /** Текст промпта задачи. */
  prompt: string;
  /** Таймаут гейта в секундах. */
  gateTimeoutSeconds: number;
}

export interface GateSnapshot {
  version: number;
  taskName: string;
  createdAt: string;
  hash: string;
}

/** Канонический хэш входов гейта. Порядок полей фиксирован контрактом. */
export function gateInputsHash(inputs: GateSnapshotInputs): string {
  const canonical = JSON.stringify({
    version: GATE_SNAPSHOT_VERSION,
    gate: inputs.gate,
    prompt: inputs.prompt,
    gateTimeoutSeconds: inputs.gateTimeoutSeconds,
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Путь snapshot'а задачи — вне рабочей директории задачи. */
export function gateSnapshotPath(taskName: string): string {
  const segment = sanitizeName(taskName).slice(0, 80) || "task";
  return path.join(GATE_SNAPSHOT_DIR, `${segment}.json`);
}

function readText(file: string | undefined): string {
  if (!file) return "";
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Пишет snapshot задачам на этапе создания обёртки (fail-closed при ошибке). */
export function createGateSnapshot(
  taskName: string,
  inputs: GateSnapshotInputs,
  snapshotFile = gateSnapshotPath(taskName),
): string {
  const snapshot: GateSnapshot = {
    version: GATE_SNAPSHOT_VERSION,
    taskName,
    createdAt: new Date().toISOString(),
    hash: gateInputsHash(inputs),
  };
  fs.mkdirSync(path.dirname(snapshotFile), { recursive: true });
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return snapshotFile;
}

export function readGateSnapshot(file: string): GateSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<GateSnapshot>;
    if (value.version !== GATE_SNAPSHOT_VERSION) return null;
    if (typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash)) return null;
    return {
      version: value.version,
      taskName: typeof value.taskName === "string" ? value.taskName : "",
      createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
      hash: value.hash,
    };
  } catch {
    return null;
  }
}

/** Сверяет текущие входы гейта с зафиксированными. При расхождении — fail-closed. */
export function verifyGateSnapshot(
  snapshotFile: string,
  inputs: GateSnapshotInputs,
): { ok: boolean; reason?: string } {
  const snapshot = readGateSnapshot(snapshotFile);
  if (!snapshot) {
    return { ok: false, reason: "snapshot гейта отсутствует или повреждён" };
  }
  const actual = gateInputsHash(inputs);
  const expected = snapshot.hash;
  const same =
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
  if (!same) {
    return { ok: false, reason: "входы Quality Gate изменены с момента создания задачи" };
  }
  return { ok: true };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * PL-25: состояние отслеживаемых исходников на границе прогона.
 *
 * Хэш входов гейта (G-1.2) защищает от подмены самой команды, но не от
 * чужого незакоммиченного кода: параллельная задача может изменить `src/`
 * между стартом runners и post-flight гейтом, и гейт «позеленеет» на
 * уже другом дереве. Фиксируем HEAD + `git status --porcelain` для `src/`.
 */
export interface WorktreeSnapshot {
  version: number;
  head: string;
  status: string;
  capturedAt: string;
}

export const WORKTREE_SNAPSHOT_VERSION = 1;

/** Пути, за которыми следит гейт; по умолчанию только исходники плагина. */
export function worktreeGuardPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_STEWARD_GATE_GUARD_PATHS?.trim();
  if (!raw) return ["src"];
  const parts = raw.split(/[|;]/).map((item) => item.trim()).filter(Boolean);
  return parts.length ? parts : ["src"];
}

/**
 * PL-47: пути, которые задача изменить вправе (обычно из `-Files` afterScript).
 * Исключаются из сравнения со snapshot: агент спокойно правит свои файлы,
 * а чужие правки в остальной части `src/` по-прежнему срывают гейт.
 */
export function worktreeAllowPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.AGENT_STEWARD_GATE_ALLOW_PATHS?.trim();
  if (!raw) return [];
  return raw
    .split(/[|;]/)
    .map((item) => item.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, ""))
    .filter(Boolean);
}

function pathIsAllowed(relative: string, allowed: string[]): boolean {
  const normalized = relative.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  return allowed.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function gitOutput(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Возвращает null, если каталог не git-репозиторий или git недоступен. */
export function readWorktreeState(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): { head: string; status: string } | null {
  const head = gitOutput(dir, ["rev-parse", "HEAD"]);
  if (head === null) return null;
  const status = gitOutput(dir, ["status", "--porcelain", "--untracked-files=no", "--", ...worktreeGuardPaths(env)]);
  if (status === null) return null;
  const allowed = worktreeAllowPaths(env);
  let filtered = status;
  if (allowed.length > 0) {
    filtered = status
      .split("\n")
      .filter((line) => {
        if (line.length < 4) return false;
        const relative = line.slice(3).split(" -> ").pop()?.trim() ?? "";
        return !pathIsAllowed(relative, allowed);
      })
      .join("\n");
  }
  return { head: head.trim(), status: filtered };
}

/** Пишет snapshot дерева; null — не git-репозиторий (гейт не блокируем). */
export function captureWorktreeSnapshot(
  dir: string,
  outFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const state = readWorktreeState(dir, env);
  if (!state) return null;
  const snapshot: WorktreeSnapshot = {
    version: WORKTREE_SNAPSHOT_VERSION,
    ...state,
    capturedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return outFile;
}

export function readWorktreeSnapshot(file: string): WorktreeSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Partial<WorktreeSnapshot>;
    if (value.version !== WORKTREE_SNAPSHOT_VERSION) return null;
    if (typeof value.head !== "string" || typeof value.status !== "string") return null;
    return {
      version: WORKTREE_SNAPSHOT_VERSION,
      head: value.head,
      status: value.status,
      capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : "",
    };
  } catch {
    return null;
  }
}

/** Сверяет дерево со snapshot'ом, снятым на старте задачи. */
export function verifyWorktreeSnapshot(
  dir: string,
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; reason?: string } {
  const snapshot = readWorktreeSnapshot(file);
  if (!snapshot) {
    return { ok: false, reason: "snapshot рабочего дерева отсутствует или повреждён" };
  }
  const actual = readWorktreeState(dir, env);
  // Не git-репозиторий: нечего сравнивать, гейт работает по старой схеме.
  if (!actual) return { ok: true };
  if (actual.head !== snapshot.head) {
    return { ok: false, reason: "HEAD изменился с момента старта задачи" };
  }
  if (actual.status !== snapshot.status) {
    const paths = worktreeGuardPaths(env).join(", ");
    return { ok: false, reason: `защищённые пути (${paths}) изменились с момента старта задачи` };
  }
  return { ok: true };
}

/**
 * CLI для обёрток: `node gate-integrity.js verify --snapshot <file>
 * --gate-file <file> | --gate-command <text> --prompt-file <file> --timeout <n>`.
 * exit 0 — входы совпадают, exit 1 — расхождение/отсутствие snapshot'а.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "worktree-snapshot") {
    const dir = optionValue(argv, "--dir");
    const outFile = optionValue(argv, "--out");
    if (!dir || !outFile) {
      console.error("gate-integrity: worktree-snapshot требует --dir и --out");
      return 2;
    }
    const allow = optionValue(argv, "--allow");
    captureWorktreeSnapshot(dir, outFile, allow ? { ...process.env, AGENT_STEWARD_GATE_ALLOW_PATHS: allow } : process.env);
    return 0;
  }
  if (argv[0] === "worktree-verify") {
    const dir = optionValue(argv, "--dir");
    const file = optionValue(argv, "--snapshot");
    if (!dir || !file) {
      console.error("gate-integrity: worktree-verify требует --dir и --snapshot");
      return 2;
    }
    const allow = optionValue(argv, "--allow");
    const result = verifyWorktreeSnapshot(
      dir,
      file,
      allow ? { ...process.env, AGENT_STEWARD_GATE_ALLOW_PATHS: allow } : process.env,
    );
    if (!result.ok) {
      console.error(`gate-integrity: ${result.reason ?? "рабочее дерево изменилось"}`);
      return 1;
    }
    return 0;
  }
  if (argv[0] !== "verify") {
    console.error("gate-integrity: поддерживаются verify, worktree-snapshot, worktree-verify");
    return 2;
  }
  const snapshotFile = optionValue(argv, "--snapshot");
  if (!snapshotFile) {
    console.error("gate-integrity: не задан --snapshot");
    return 2;
  }
  const gateFile = optionValue(argv, "--gate-file");
  const gateCommand = optionValue(argv, "--gate-command");
  const gate = gateFile ? readText(gateFile) : gateCommand ?? "";
  const timeoutRaw = Number(optionValue(argv, "--timeout") ?? 300);
  const inputs: GateSnapshotInputs = {
    gate,
    prompt: readText(optionValue(argv, "--prompt-file")),
    gateTimeoutSeconds: Number.isFinite(timeoutRaw) ? timeoutRaw : 300,
  };
  const result = verifyGateSnapshot(snapshotFile, inputs);
  if (!result.ok) {
    console.error(`gate-integrity: ${result.reason ?? "проверка целостности не пройдена"}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
