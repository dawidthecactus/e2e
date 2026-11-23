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
 * file read and two writes, and is taken over.
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
    const age = await stat(lockPath).then((stats) => Date.now() - stats.mtimeMs, () => undefined);
    if (age !== undefined && age > STALE_MS) {
      await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`the replay cache file is locked by another writer: ${lockPath}`);
    await sleep(RETRY_MS);
  }
}
