import fs from "node:fs";
import path from "node:path";
import { PLUGIN_DIR } from "../types.js";
import { isDatabaseEmpty } from "./index.js";
import { recoverInterrupted } from "./history-repo.js";

/** Файлы, которые миграция переименовывает в .json.bak. */
const JSON_FILES = ["tasks.json", "history.json", "metrics.json", "templates.json"];

/**
 * Crash recovery: помечает незавершённые записи истории как error.
 * Вызывается при setup() до запуска catch-up и файловых триггеров, а также
 * перед выдачей истории (PL-46), чтобы «висящие» запуски не оставались
 * running после schtasks /End.
 */
export function recoverInterruptedRuns(): number {
  // Порог можно переопределить: 0 отключает финализацию живого владельца.
  const configured = Number(process.env.AGENT_STEWARD_STALE_RUN_MS);
  const staleAfterMs =
    Number.isFinite(configured) && configured > 0 ? configured : 2 * 60 * 60 * 1000;
  const { recovered, keptAlive } = recoverInterrupted({ staleAfterMs });
  if (recovered > 0) {
    console.log(
      `[recovery] Восстановлено ${recovered} незавершённых записей истории (error/timeout).` +
        (keptAlive > 0 ? ` Оставлено живым владельцам: ${keptAlive}.` : ""),
    );
  }
  return recovered;
}

/**
 * Если БД пуста, а .json.bak остались (миграция не удалась или БД удалили),
 * подсказываем пользователю, что делать. Возвращает true, если бэкапы найдены.
 */
export function checkJsonBackups(): boolean {
  const backups = JSON_FILES.map((name) => path.join(PLUGIN_DIR, `${name}.bak`)).filter(
    (file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    },
  );

  if (backups.length === 0) return false;
  if (!isDatabaseEmpty()) return false;

  console.warn(
    "[recovery] Обнаружены бэкапы JSON, БД пуста. Запустите миграцию заново.",
  );
  return true;
}
