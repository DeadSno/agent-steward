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
 * CLI для обёрток: `node gate-integrity.js verify --snapshot <file>
 * --gate-file <file> | --gate-command <text> --prompt-file <file> --timeout <n>`.
 * exit 0 — входы совпадают, exit 1 — расхождение/отсутствие snapshot'а.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] !== "verify") {
    console.error("gate-integrity: только команда verify поддерживается");
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
