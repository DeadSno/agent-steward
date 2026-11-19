/**
 * Общий харнесс для временных домашних каталогов тестов.
 *
 * Каждая сюита получает свой собственный каталог (fs.mkdtemp), поэтому
 * параллельный прогон не может пересечься с другой сюитой. Удаление делает
 * несколько попыток с backoff: на Windows SQLite/WAL и дашборд могут держать
 * файлы ещё несколько тиков после closeDb()/closeDashboardServer(), из-за чего
 * обычный fs.rm падает с ENOTEMPTY.
 *
 * Если ОС так и не отпустила файл, тест НЕ падает из-за утечки temp-каталога —
 * выводится предупреждение. Это сознательный компромисс: предсказуемость
 * прогона важнее чистоты временной папки.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_ATTEMPTS = 6;

function sleepSync(ms) {
  // Синхронная пауза без внешних зависимостей (для тестов с fs.rmSync).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function makePaths(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    appData: path.join(root, "AppData"),
    pluginDir: path.join(root, "AppData", "opencode", "windows-scheduler"),
  };
}

/** Создаёт изолированный home синхронно (до динамических импортов сервера). */
export function createTestHomeSync(prefix) {
  const paths = makePaths(prefix);
  fs.mkdirSync(paths.pluginDir, { recursive: true });
  return paths;
}

/** Асинхронный аналог createTestHomeSync. */
export async function createTestHome(prefix) {
  const paths = makePaths(prefix);
  await fsp.mkdir(paths.pluginDir, { recursive: true });
  return paths;
}

/** Надёжная синхронная уборка с backoff. Возвращает true, если каталог удалён. */
export function removeTestHomeSync(target, { attempts = DEFAULT_ATTEMPTS, warn = true } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return true;
      if (attempt === attempts) {
        if (warn) console.warn(`Не удалось удалить временный каталог ${target}: ${String(err)}`);
        return false;
      }
      sleepSync(100 * attempt);
    }
  }
  return false;
}

/** Асинхронный аналог removeTestHomeSync. */
export async function removeTestHome(target, { attempts = DEFAULT_ATTEMPTS, warn = true } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (err) {
      if (err?.code === "ENOENT") return true;
      if (attempt === attempts) {
        if (warn) console.warn(`Не удалось удалить временный каталог ${target}: ${String(err)}`);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  return false;
}
