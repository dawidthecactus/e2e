/**
 * Trace entry storage.
 *
 * The file store keeps one test's recordings in one reviewable YAML file
 * under `.e2e/cache/`, named for the test, beside a generated lock file
 * holding the keys (`recording-file.ts`, `recording-name.ts`). A read opens
 * the files of the test the step belongs to and finds the entry by its key;
 * a write rewrites the pair with the entry in its step's place, under a
 * lock, through temporary files and atomic renames. Reads fail closed: an
 * oversized or unreadable pair is a miss, never a repair.
 *
 * A step holds one recording per target. A write for a step and target
 * that already has one replaces it, under whatever key: a recording made
 * under a key the runner no longer derives would never replay again, and
 * one file per step keeps the review to what replays.
 *
 * The interface exists so a remote store, the cloud's shared cache, can
 * replace the filesystem without the harness noticing.
 */

import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { errorMessage } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { withFileLock } from './file-lock.ts';
import { parseRecordingFile, renderRecordingFile, stepIdentity, type ParsedRecordingFile, type StoredRecording } from './recording-file.ts';
import { collisionName, RECORDING_NAME, recordingName } from './recording-name.ts';
import { MAX_TRACE_END_WAIT_MS, type ActionTrace, type TraceEntry, type TraceProvenance } from './trace.ts';

/** Hard wire ceiling on one stored file, on both the read and the write path. */
export const MAX_CACHE_WIRE_BYTES = 1_048_576;

const KEY_HASH = /^[a-f0-9]{64}$/u;

/** The reviewed file's extension. */
export const RECORDING_EXTENSION = '.yml';
/** The generated file's extension. */
export const LOCK_EXTENSION = '.lock.json';

export type CacheReadResult =
  | { readonly status: 'hit'; readonly entry: TraceEntry; readonly bytes: number }
  | { readonly status: 'miss' }
  | { readonly status: 'invalid'; readonly reason: string; readonly bytes?: number };

/** Where the replay cache keeps its entries: the file store by default, or a host's own through `cache.store`. */
export interface CacheStore {
  readonly writable: boolean;
  /**
   * Reads one entry. `step` is the step the key was claimed for, as an entry
   * records it (`recordedFor`): a store may use it to find where the entry
   * lives, and may ignore it.
   */
  read(keyHash: string, step?: TraceProvenance): Promise<CacheReadResult>;
  /** Persists one trace, returning its size, or undefined when not written. */
  write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined>;
  /**
   * Evicts one entry, best-effort. Called when a replayed or just-recorded
   * flow is implicated in a failed attempt: the entry re-records on the next
   * pass instead of replaying a poisoned flow forever. Optional — a store
   * without eviction merely stays stale until the next confirmed write.
   * Resolves when the entry is absent; rejects when deletion fails so the
   * best-effort caller can avoid reporting a successful eviction. `step` is
   * as in `read`.
   */
  delete?(keyHash: string, step?: TraceProvenance): Promise<void>;
}

export interface FileCacheStoreOptions {
  readonly directory: string;
  /** File size cap for tests; production passes the wire ceiling, which clamps it. */
  readonly maxBytes: number;
  readonly writable: boolean;
}

/** One test's file pair as the store found it. */
export interface ListedRecordingFile {
  /** The name both files share, before their extensions. */
  readonly name: string;
  /** Both files' sizes together. */
  readonly bytes: number;
  readonly parsed: ParsedRecordingFile;
}

/** A pair read from disk: its name, size, and what it holds; undefined when neither file exists. */
type LoadedFile = ListedRecordingFile;

export class FileCacheStore implements CacheStore {
  readonly writable: boolean;

  private readonly directory: string;
  private readonly maxBytes: number;

  constructor(options: FileCacheStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = Math.min(options.maxBytes, MAX_CACHE_WIRE_BYTES);
    this.writable = options.writable;
  }

  async read(keyHash: string, step?: TraceProvenance): Promise<CacheReadResult> {
    if (!KEY_HASH.test(keyHash)) return { status: 'invalid', reason: 'key hash is not a SHA-256 digest' };
    if (step === undefined) {
      for (const file of await this.list()) {
        const found = findEntry(file, keyHash);
        if (found !== undefined) return found;
      }
      return { status: 'miss' };
    }
    const base = recordingName(step.testId);
    return this.locked(base, async () => {
      const file = await this.locate(base, step.testId);
      return (file === undefined ? undefined : findEntry(file, keyHash)) ?? { status: 'miss' };
    });
  }

  async write(keyHash: string, payload: ActionTrace): Promise<{ bytes: number } | undefined> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return undefined;
    const testId = payload.recordedFor?.testId;
    const slot = stepIdentity(payload);
    if (testId === undefined || slot === undefined) return undefined;
    const base = recordingName(testId);
    return this.locked(base, async () => {
      const file = await this.locate(base, testId);
      const name = file?.name ?? (await this.exists(base) ? collisionName(base, testId) : base);
      const recordings = file?.parsed.status === 'ok' ? hits(file.parsed) : [];
      const sameSlot = (recording: StoredRecording) =>
        stepIdentity(recording.trace) === slot && recording.trace.recordedFor?.targetId === payload.recordedFor!.targetId;
      const replaced = recordings.find((recording) => recording.keyHash === keyHash || sameSlot(recording));
      const recording: StoredRecording = {
        keyHash,
        // A recording rewritten under its own key (its provenance completed) keeps the time it was made.
        createdAt: replaced?.keyHash === keyHash ? replaced.createdAt : timestamp(),
        trace: wholeSeconds(payload),
      };
      const index = replaced === undefined ? -1 : recordings.indexOf(replaced);
      const next = recordings.filter((existing) => existing.keyHash !== keyHash && !sameSlot(existing));
      if (index < 0) next.push(recording);
      else next.splice(Math.min(index, next.length), 0, recording);
      return this.save(name, testId, next);
    }, true);
  }

  async delete(keyHash: string, step?: TraceProvenance): Promise<void> {
    if (!this.writable || !KEY_HASH.test(keyHash)) return;
    const testId = step?.testId ?? (await this.list()).find((file) => findEntry(file, keyHash) !== undefined)?.parsed.testId;
    if (testId === undefined) return;
    const base = recordingName(testId);
    await this.locked(base, async () => {
      const file = await this.locate(base, testId);
      if (file === undefined) return;
      if (file.parsed.status === 'invalid') {
        // A pair that does not read holds nothing replayable; evicting one of
        // its keys evicts the pair, as deleting the entry's own file did.
        if (file.parsed.keyHashes.includes(keyHash)) await this.remove(file.name);
        return;
      }
      const recordings = hits(file.parsed);
      if (!file.parsed.recordings.some((recording) => recording.keyHash === keyHash)) return;
      const next = recordings.filter((recording) => recording.keyHash !== keyHash);
      if (next.length === 0) await this.remove(file.name);
      else await this.save(file.name, testId, next);
    });
  }

  /**
   * Every file pair in the directory, readable or not; none when the
   * directory does not exist. Not part of `CacheStore`: only `cache.strict`
   * and `e2e cache` list a store, and only this one.
   */
  async list(): Promise<ListedRecordingFile[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }
    const stems = new Set(names.flatMap((name) => {
      const stem = recordingStem(name);
      return stem === undefined ? [] : [stem];
    }));
    const files: ListedRecordingFile[] = [];
    for (const stem of [...stems].toSorted()) {
      const file = await this.load(stem);
      if (file !== undefined) files.push(file);
    }
    return files;
  }

  /**
   * Runs `operation` under the lock of the test's base name when this store
   * writes; a read-only store has no writer to wait for. Only a write creates
   * the directory: a read or a delete in a directory that does not exist has
   * nothing to wait for either, and leaves no directory behind.
   */
  private async locked<T>(base: string, operation: () => Promise<T>, creates = false): Promise<T> {
    if (!this.writable) return operation();
    if (creates) await mkdir(this.directory, { recursive: true });
    else if (!(await stat(this.directory).then((stats) => stats.isDirectory(), () => false))) return operation();
    return withFileLock(join(this.directory, `.${base}.writing`), operation);
  }

  /** The pair holding `testId`'s recordings: its own name, or the colliding one when another test holds that. */
  private async locate(base: string, testId: string): Promise<LoadedFile | undefined> {
    for (const name of [base, collisionName(base, testId)]) {
      const file = await this.load(name);
      if (file?.parsed.testId === testId) return file;
    }
    return undefined;
  }

  private async exists(name: string): Promise<boolean> {
    const present = async (path: string) => stat(path).then(() => true, () => false);
    return (await present(this.path(name, RECORDING_EXTENSION))) || (await present(this.path(name, LOCK_EXTENSION)));
  }

  /** Reads one pair, refusing a file over the size cap before reading it. */
  private async load(name: string): Promise<LoadedFile | undefined> {
    const yaml = await this.readCapped(this.path(name, RECORDING_EXTENSION));
    const lock = await this.readCapped(this.path(name, LOCK_EXTENSION));
    if (yaml === undefined && lock === undefined) return undefined;
    const bytes = (yaml?.bytes ?? 0) + (lock?.bytes ?? 0);
    const problem = yaml?.problem ?? lock?.problem;
    if (problem !== undefined || yaml?.text === undefined || lock?.text === undefined) {
      // The lock may still say whose pair this is, so a writer for that test replaces it.
      const parsedLock = lock?.text === undefined ? undefined : await parseRecordingFile('', lock.text);
      const testId = parsedLock?.testId;
      const reason = problem ?? `${yaml === undefined ? `${name}${RECORDING_EXTENSION}` : `${name}${LOCK_EXTENSION}`} is missing`;
      return {
        name,
        bytes,
        parsed: {
          status: 'invalid',
          ...(testId === undefined ? {} : { testId }),
          keyHashes: parsedLock?.status === 'invalid' ? parsedLock.keyHashes : [],
          reason,
        },
      };
    }
    const parsed = await parseRecordingFile(yaml.text, lock.text);
    return {
      name,
      bytes,
      parsed: parsed.status === 'invalid' ? { ...parsed, reason: `${name}${RECORDING_EXTENSION}: ${parsed.reason}` } : parsed,
    };
  }

  private async readCapped(path: string): Promise<{ readonly bytes: number; readonly text?: string; readonly problem?: string } | undefined> {
    let bytes: number;
    try {
      bytes = (await stat(path)).size;
    } catch {
      return undefined;
    }
    if (bytes > this.maxBytes) return { bytes, problem: `${path} is ${bytes} bytes, over the ${this.maxBytes}-byte limit` };
    try {
      return { bytes, text: await readFile(path, 'utf8') };
    } catch (cause) {
      return { bytes, problem: `${path} is unreadable: ${errorMessage(cause)}` };
    }
  }

  /** Writes one pair, the reviewed file first; undefined when either is over the size cap. */
  private async save(name: string, testId: string, recordings: readonly StoredRecording[]): Promise<{ bytes: number } | undefined> {
    const { yaml, lock } = await renderRecordingFile({ testId, recordings }, `${name}${LOCK_EXTENSION}`);
    const yamlBytes = Buffer.byteLength(yaml, 'utf8');
    const lockBytes = Buffer.byteLength(lock, 'utf8');
    if (yamlBytes > this.maxBytes || lockBytes > this.maxBytes) return undefined;
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(this.path(name, RECORDING_EXTENSION), yaml, { mode: 0o600 });
    await writeFileAtomic(this.path(name, LOCK_EXTENSION), lock, { mode: 0o600 });
    return { bytes: yamlBytes + lockBytes };
  }

  private async remove(name: string): Promise<void> {
    for (const extension of [RECORDING_EXTENSION, LOCK_EXTENSION]) {
      try {
        await unlink(this.path(name, extension));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      }
    }
  }

  /**
   * Resolves one file path. The name is the store's own (`recordingName`),
   * never a caller's text, and matches `RECORDING_NAME`, so traversal is
   * impossible by construction rather than by canonicalization.
   */
  private path(name: string, extension: string): string {
    if (!RECORDING_NAME.test(name)) throw new Error(`not a recording name: ${name}`);
    return join(this.directory, `${name}${extension}`);
  }
}

/**
 * The reviewed file that holds, or would hold, a test's recordings in the
 * file store at `directory`: the one named for the test, or its colliding
 * name when that file exists, since only a write that met another test's
 * file takes it.
 */
export async function recordingFileName(directory: string, testId: string): Promise<string> {
  const base = recordingName(testId);
  const collided = `${collisionName(base, testId)}${RECORDING_EXTENSION}`;
  return (await stat(join(directory, collided)).then(() => true, () => false)) ? collided : `${base}${RECORDING_EXTENSION}`;
}

/** The name a store file carries before its extension, or undefined for any other file. */
export function recordingStem(fileName: string): string | undefined {
  const stem = fileName.endsWith(LOCK_EXTENSION)
    ? fileName.slice(0, -LOCK_EXTENSION.length)
    : fileName.endsWith(RECORDING_EXTENSION)
      ? fileName.slice(0, -RECORDING_EXTENSION.length)
      : undefined;
  return stem !== undefined && RECORDING_NAME.test(stem) ? stem : undefined;
}

/** One key's entry in a pair, as a read result; undefined when the pair does not hold the key. */
function findEntry(file: ListedRecordingFile, keyHash: string): CacheReadResult | undefined {
  const { parsed } = file;
  if (parsed.status === 'invalid') {
    return parsed.keyHashes.includes(keyHash) ? { status: 'invalid', reason: parsed.reason, bytes: file.bytes } : undefined;
  }
  const recording = parsed.recordings.find((candidate) => candidate.keyHash === keyHash);
  if (recording === undefined) return undefined;
  return recording.status === 'hit'
    ? { status: 'hit', entry: recording.entry, bytes: file.bytes }
    : { status: 'invalid', reason: `${file.name}${RECORDING_EXTENSION}: ${recording.reason}`, bytes: file.bytes };
}

/** A pair's readable recordings, the ones a rewrite keeps. */
function hits(parsed: Extract<ParsedRecordingFile, { readonly status: 'ok' }>): StoredRecording[] {
  return parsed.recordings.flatMap((recording) =>
    recording.status === 'hit' ? [{ keyHash: recording.keyHash, createdAt: recording.entry.createdAt, trace: recording.entry.payload }] : [],
  );
}

/**
 * The trace with its end wait rounded up to whole seconds. The wait is a
 * measured duration plus a margin, so its milliseconds change on every
 * recording and say nothing; rounding up never waits less than measured.
 */
function wholeSeconds(trace: ActionTrace): ActionTrace {
  if (trace.endWaitMs === undefined) return trace;
  return { ...trace, endWaitMs: Math.min(MAX_TRACE_END_WAIT_MS, Math.ceil(trace.endWaitMs / 1000) * 1000) };
}
