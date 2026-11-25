/**
 * DEEP-3: единое представление предупреждения о рассинхроне установки.
 *
 * Модуль намеренно не импортирует `version.ts` (там есть node:fs/path/url),
 * чтобы оставаться чистым и пригодным для самоанализа, RPC-слоя и GUI-бандла.
 * Поле `reason` повторяет машиночитаемую причину из `getPluginDiagnostics()`.
 */
export interface InstallationDiagnosticsInput {
  /** Версия загруженного плагина. */
  version: string;
  /** Абсолютный путь загруженного модуля. */
  modulePath: string;
  /** Версия package.json в рабочем каталоге, если он — чек-аут плагина. */
  workspaceVersion: string | null;
  /** Рабочий каталог харнесса. */
  workspaceRoot: string;
  /** Признак рассинхрона из само-диагностики плагина. */
  staleInstallation?: boolean;
  /** Машиночитаемая причина из само-диагностики плагина. */
  reason?: string | null;
}

export type InstallationWarningReason = "identity-mismatch" | "stale-installation";

/** Структурное предупреждение: текст строится один раз и переиспользуется всеми потребителями. */
export interface InstallationWarning {
  reason: InstallationWarningReason;
  loadedVersion: string;
  workspaceVersion: string | null;
  loadedFrom: string;
  workspaceRoot: string;
  message: string;
}

/**
 * Возвращает предупреждение только для реального рассинхрона установки.
 * `no-workspace-manifest` и отсутствие диагностики — норма, warning = null.
 */
export function buildInstallationWarning(
  diagnostics: InstallationDiagnosticsInput | null | undefined,
): InstallationWarning | null {
  if (!diagnostics) return null;
  const mismatch = diagnostics.reason === "identity-mismatch";
  const stale = diagnostics.staleInstallation === true;
  if (!mismatch && !stale) return null;

  const loadedVersion = diagnostics.version || "unknown";
  const workspaceVersion = diagnostics.workspaceVersion ?? "unknown";
  return {
    reason: mismatch ? "identity-mismatch" : "stale-installation",
    loadedVersion,
    workspaceVersion: diagnostics.workspaceVersion,
    loadedFrom: diagnostics.modulePath,
    workspaceRoot: diagnostics.workspaceRoot,
    message:
      `Loaded agent-steward ${loadedVersion} from ${diagnostics.modulePath} ` +
      `but the workspace has ${workspaceVersion} — restart OpenCode to use the current checkout.`,
  };
}
