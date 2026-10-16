import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const lockPath = `${filePath}.lock`;
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const release = acquireFileLock(lockPath);
  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    // A unique temporary file prevents two writers in different processes from
    // ever targeting the same staging path. The rename is retried because
    // Windows file scanners and backup tools can briefly hold either path.
    fs.writeFileSync(tmp, contents, { encoding: "utf8", flag: "wx" });
    renameWithRetry(tmp, filePath);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Keep the original write error if cleanup is blocked by a scanner.
    }
    release();
  }
}

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const RENAME_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 60_000;
const RETRYABLE_FS_ERRORS = new Set(["EACCES", "EBUSY", "EPERM"]);

function acquireFileLock(lockPath: string): () => void {
  const startedAt = Date.now();
  for (;;) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      } catch (error) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Let the original write error surface; stale-lock recovery handles
          // a lock that cannot be removed immediately.
        }
        throw error;
      } finally {
        fs.closeSync(descriptor);
      }
      return () => {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // The lock is best-effort cleanup. A stale lock is reclaimed below.
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > STALE_LOCK_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for JSON state lock: ${lockPath}`);
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
}

function renameWithRetry(source: string, destination: string): void {
  const startedAt = Date.now();
  let delay = LOCK_WAIT_MS;
  let lastError: unknown;
  for (;;) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!RETRYABLE_FS_ERRORS.has(code ?? "") || Date.now() - startedAt >= RENAME_TIMEOUT_MS) {
        break;
      }
      sleepSync(delay);
      delay = Math.min(delay * 2, 500);
    }
  }

  // Some Windows versions reject replacing an existing file with rename while
  // the destination is momentarily indexed. A copy fallback keeps the previous
  // state intact if the destination cannot be removed safely. The normal path
  // remains atomic; this path is only reached after the retry window expires.
  try {
    fs.copyFileSync(source, destination);
    fs.rmSync(source, { force: true });
    return;
  } catch {
    throw lastError;
  }
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

