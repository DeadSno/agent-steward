import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

interface PackageIdentity {
  name?: string;
  version?: string;
}

function readPackage(root: string): PackageIdentity | null {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageIdentity;
    return pkg && typeof pkg === "object" ? pkg : null;
  } catch {
    return null;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Версия плагина из package.json.
 *
 * Читается в рантайме из корня пакета рядом со скомпилированным модулем
 * (dist/version.js -> ../package.json). Если файл недоступен — «unknown».
 */
export function getPluginVersion(): string {
  if (cached) return cached;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    cached =
      typeof pkg.version === "string" && pkg.version.trim()
        ? pkg.version.trim()
        : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}

export interface PluginDiagnostics {
  /** Версия загруженного плагина (из его собственного package.json). */
  version: string;
  /** Абсолютный путь загруженного модуля (dist/version.js). */
  modulePath: string;
  /** Корень пакета загруженного плагина. */
  packageRoot: string;
  /** Текущий рабочий каталог харнесса (process.cwd()). */
  workspaceRoot: string;
  /** Версия package.json в рабочем каталоге, если он является чек-аутом плагина. */
  workspaceVersion: string | null;
  /** Загружен ли плагин из того же каталога, что и рабочий (или его подкаталога). */
  loadedFromWorkspace: boolean;
  /**
   * Признак рассинхрона установки: в рабочем каталоге лежит манифест того же
   * пакета, но с другой версией. Это ровно случай «OpenCode грузит старый
   * plugin по неактуальному пути» (см. P1 в ROADMAP).
   */
  staleInstallation: boolean;
  /** Машиночитаемая причина: "ok" | "identity-mismatch" | "no-workspace-manifest". */
  reason: "ok" | "identity-mismatch" | "no-workspace-manifest";
}

/**
 * Само-диагностика загруженного плагина для инструментов агента.
 * Позволяет увидеть, что запущенная копия не совпадает с чек-аутом, даже если
 * конфиг OpenCode ссылается на старый путь.
 */
export function getPluginDiagnostics(): PluginDiagnostics {
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  const packageRoot = path.dirname(path.dirname(modulePath));
  const workspaceRoot = path.resolve(process.cwd());
  const loadedPkg = readPackage(packageRoot);
  const workspacePkg = readPackage(workspaceRoot);
  const version = getPluginVersion();

  const loadedFromWorkspace =
    isInside(packageRoot, workspaceRoot) || isInside(workspaceRoot, packageRoot);
  // QA-DEEP4-1: fail-open. Плагин загружен из каталога вне рабочего (например,
  // старый чек-аут), а манифеста в workspace нет — раньше это выглядело как
  // "норма" (no-workspace-manifest) и предупреждение не показывалось вовсе.
  // Помечаем как stale, чтобы get_dashboard_info/self-analysis честно сообщали
  // о возможном рассинхроне установки, вместо тихого использования чужой копии.
  const outsideWorkspace = !loadedFromWorkspace && !isInside(packageRoot, workspaceRoot);
  const failOpenStale = outsideWorkspace && workspacePkg === null;
  const sameIdentity =
    workspacePkg !== null &&
    (workspacePkg.name === undefined ||
      loadedPkg?.name === undefined ||
      workspacePkg.name === loadedPkg.name) &&
    workspacePkg.version === version;

  return {
    version,
    modulePath,
    packageRoot,
    workspaceRoot,
    workspaceVersion: workspacePkg?.version ?? null,
    loadedFromWorkspace,
    staleInstallation: (workspacePkg !== null && !sameIdentity) || failOpenStale,
    reason:
      workspacePkg === null
        ? failOpenStale
          ? "identity-mismatch"
          : "no-workspace-manifest"
        : sameIdentity
          ? "ok"
          : "identity-mismatch",
  };
}
