/**
 * A lock around one test's recording files, held for a read or a
 * read-modify-write. One test's recordings on two targets can be written by
 * two workers at once (an iOS and an Android run of the same test), and
 * each writer rewrites the whole pair, so without it the second rename
 * would drop the first writer's recording.
 *
 * In one process the holders queue on a promise; across processes on a
 * file created with `wx`. A lock file older than `STALE_MS` was left by a
 * writer that died holding it, since no holder keeps it longer than a
 * file read and two writes, and is taken over (`takeOver`).
 */

import { open, stat, unlink } from 'node:fs/promises';
import { sleep } from '../internal/time.ts';

/** How long a waiter retries before it gives up; the caller treats that as an unavailable store. */
const WAIT_MS = 15_000;
/** Pause between attempts to take the lock file. */
const RETRY_MS = 20;
/** Age past which a lock file is a dead writer's. */
const STALE_MS = 30_000;

/** The tail of the queue of holders in this process, by lock path. */
const queues = new Map<string, Promise<void>>();

/** Runs `operation` holding the lock at `lockPath`, and releases it however `operation` ends. */
export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  queues.set(lockPath, tail);
  await previous;
  try {
    await acquire(lockPath);
    try {
      return await operation();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  } finally {
    release();
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

async function acquire(lockPath: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.close();
      return;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
    if (Date.now() > deadline) throw new Error(`the replay cache file is locked by another writer: ${lockPath}`);
    const age = await stat(lockPath).then((stats) => Date.now() - stats.mtimeMs, () => undefined);
    // A takeover that could not remove the file (another user's, say) is retried like a live lock: paced, and only until the deadline.
    if (age !== undefined && age > STALE_MS) await takeOver(lockPath);
    await sleep(RETRY_MS);
  }
}

/**
 * Removes a stale lock file. Two waiters can see the same stale file, and
 * deleting it by path would let the slower one delete the lock the faster
 * one has just taken, so both would hold it. Only the waiter holding a
 * second, short-lived lock (`<lock>.takeover`) may delete it, after looking
 * again: whoever takes that lock next sees the lock file gone or fresh.
 */
async function takeOver(lockPath: string): Promise<void> {
  const guard = `${lockPath}.takeover`;
  try {
    await (await open(guard, 'wx', 0o600)).close();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    // Held only for a stat and an unlink, so an old one was left by a waiter that died there.
    const age = await stat(guard).then((stats) => Date.now() - stats.mtimeMs, () => undefined);
    if (age !== undefined && age > STALE_MS) await unlink(guard).catch(() => undefined);
    return;
  }
  try {
    const current = await stat(lockPath).catch(() => undefined);
    if (current !== undefined && Date.now() - current.mtimeMs > STALE_MS) await unlink(lockPath).catch(() => undefined);
  } finally {
    await unlink(guard).catch(() => undefined);
  }
}
