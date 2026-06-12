import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LOCKFILE = join(tmpdir(), "context-lens.lock");

export type LockfileWarning = (message: string, error: unknown) => void;

function warnDefault(message: string, error: unknown): void {
  console.error(
    message,
    error instanceof Error ? error.message : String(error),
  );
}

export function incrementLockRefCount(
  lockfile = DEFAULT_LOCKFILE,
  warn: LockfileWarning = warnDefault,
): number {
  try {
    let count = 0;
    if (fs.existsSync(lockfile)) {
      const data = fs.readFileSync(lockfile, "utf8");
      count = parseInt(data, 10) || 0;
    }
    fs.writeFileSync(lockfile, String(count + 1));
    return count + 1;
  } catch (err: unknown) {
    warn("Warning: failed to update lockfile:", err);
    return 1;
  }
}

export function clearStaleLockfile(
  lockfile = DEFAULT_LOCKFILE,
  warn: LockfileWarning = warnDefault,
): void {
  try {
    if (fs.existsSync(lockfile)) fs.unlinkSync(lockfile);
  } catch (err: unknown) {
    warn("Warning: failed to clear stale lockfile:", err);
  }
}

export function decrementLockRefCount(
  lockfile = DEFAULT_LOCKFILE,
  warn: LockfileWarning = warnDefault,
): number {
  try {
    if (!fs.existsSync(lockfile)) return 0;
    const data = fs.readFileSync(lockfile, "utf8");
    const count = Math.max(0, (parseInt(data, 10) || 1) - 1);
    if (count === 0) {
      fs.unlinkSync(lockfile);
    } else {
      fs.writeFileSync(lockfile, String(count));
    }
    return count;
  } catch (err: unknown) {
    warn("Warning: failed to update lockfile:", err);
    return 0;
  }
}
