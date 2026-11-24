import fs from "node:fs";

/** QW-9: максимальный возраст defer-файла с живым владельцем. */
export const STALE_DEFER_MS = 25 * 60 * 60 * 1000;

/** Дольше 12 часов перенос не ждём — тик просто пропускается. */
export const MAX_POSTPONE_MS = 12 * 60 * 60 * 1000;

/**
 * QW-9: true, если defer-файл занят живым владельцем. Раньше любой файл
 * считался занятым 25 ч — убитую во время ожидания обёртку блокировали сутки.
 * Новый формат: `ISO|PID`. Легаси-файл без PID живёт не дольше MAX_POSTPONE_MS.
 */
export function deferFileBusy(path: string, nowMs: number): boolean {
  try {
    const raw = fs.readFileSync(path, "utf8").trim();
    const [tsRaw, pidRaw] = raw.split("|");
    const ts = Date.parse(tsRaw);
    const age = nowMs - ts;
    if (!Number.isFinite(ts) || age < 0) {
      fs.unlinkSync(path);
      return false;
    }
    if (pidRaw) {
      const pid = Number(pidRaw);
      if (!Number.isInteger(pid) || pid <= 0) {
        fs.unlinkSync(path);
        return false;
      }
      try {
        process.kill(pid, 0);
      } catch (err) {
        // EPERM означает «процесс есть, но signals недоступны» — считаем живым.
        if ((err as NodeJS.ErrnoException).code !== "EPERM") {
          fs.unlinkSync(path);
          return false;
        }
      }
      if (age < STALE_DEFER_MS) return true;
    } else if (age < MAX_POSTPONE_MS) {
      return true;
    }
    // Протухший/мёртвый файл — удаляем и занимаем сами.
    fs.unlinkSync(path);
    return false;
  } catch {
    return false;
  }
}

/** Атомарно занимает defer-слот; true, если занят успешно. */
export function acquireDefer(path: string, nowMs: number): boolean {
  try {
    const fd = fs.openSync(path, "wx");
    fs.writeSync(fd, `${new Date(nowMs).toISOString()}|${process.pid}`);
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function releaseDefer(path: string): void {
  try {
    fs.unlinkSync(path);
  } catch {
    /* удалён раньше — не страшно */
  }
}
