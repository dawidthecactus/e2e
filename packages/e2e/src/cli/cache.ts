/**
 * `e2e cache`: what is in the replay cache, and how to get rid of it.
 *
 * The store keeps one reviewable YAML file per test, beside a generated
 * lock file: `ls` prints one row per recording (its file, target, step,
 * age, and how many actions it would replay) and names the files no run can
 * read, `stats` sizes the store, and `clear` empties it.
 *
 * Every command works on files only. A project that configures `cache.store`
 * replaced the filesystem with its own store, and this CLI has no way to
 * enumerate it, so it says so instead of listing an empty directory.
 */

import { existsSync, statSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import picocolors from 'picocolors';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES, RECORDING_EXTENSION } from '@e2e-dev/core/lib/cache/store';
import { discoverConfig, loadConfigModule, missingConfigError } from '../config/load.ts';
import { resolveConfig } from '../config/resolve-run.ts';
import { errorMessage, sanitizeText } from '@e2e-dev/core/lib/internal/errors';
import { redactError } from '@e2e-dev/core/lib/run/secrecy';
import { visibleWidth } from '../report/format.ts';
import { formatBytes } from './format-bytes.ts';
import { docsLine, examples } from './help.ts';

type CacheCommand = 'ls' | 'clear' | 'stats';

/** The `--cache-dir` help line `e2e run` and every `e2e cache` command share. */
export const CACHE_DIR_DESCRIPTION =
  'replay cache directory, relative to the project root (default: E2E_CACHE_DIR, else cache.dir in the config, else .e2e/cache)';

interface CacheOptions {
  /** Explicit config path; the nearest config file when absent. */
  readonly config?: string;
  /** `--cache-dir`: the store directory, over `E2E_CACHE_DIR` and `cache.dir`. */
  readonly cacheDir?: string;
  readonly cwd?: string;
}

/** One recording as `ls` prints it. */
interface CacheEntrySummary {
  /** The reviewed file it is in. */
  readonly file: string;
  readonly createdAt: string;
  readonly actions: number;
  readonly truncated: boolean;
  readonly testId: string | undefined;
  readonly targetId: string | undefined;
  /** The instruction it was recorded for, else its digest's prefix. */
  readonly step: string;
}

interface CacheContents {
  readonly directory: string;
  readonly entries: readonly CacheEntrySummary[];
  /** The recording files' names and sizes, each file pair once. */
  /** Each test's pair: its name, size, and the files in it the store wrote. */
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly owned: readonly string[] }[];
  /** Recordings, or whole file pairs, the store could not read: a miss to the runner too. */
  readonly unreadable: readonly { readonly file: string; readonly reason: string }[];
  /** Entries an older e2e wrote, one digest-named `.json` file each, which no run reads. */
  readonly legacy: readonly string[];
  /** Files in the directory that are not cache-shaped; never touched. */
  readonly foreign: readonly string[];
}

/** An entry file of the store before recordings were kept per test: the key digest. */
const LEGACY_ENTRY_FILE = /^[a-f0-9]{64}\.json$/u;
/** A crashed writer's leftover, a store file for cleanup purposes: an atomic write's temporary file. */
const TEMPORARY_FILE = /^(?:[a-z0-9-]+(?:\.yml|\.lock\.json)|[a-f0-9]{64}\.json)\.[a-f0-9]{16}\.tmp$/u;
/**
 * The lock a writer holds while it rewrites a test's files, or the one a
 * waiter holds while it takes over a stale lock: always empty, so a file of
 * that name with something in it is another tool's.
 */
const LOCK_FILE = /^\.[a-z0-9-]+\.writing(?:\.takeover)?$/u;

/** Whether a file in the store directory is a leftover of the store's own: a temporary, or an empty lock. */
function isLeftover(directory: string, name: string): boolean {
  if (TEMPORARY_FILE.test(name)) return true;
  if (!LOCK_FILE.test(name)) return false;
  try {
    return statSync(path.join(directory, name)).size === 0;
  } catch {
    return false;
  }
}

/** Characters of a step's instruction a row prints. */
const STEP_CHARS = 48;
/** Digest prefix printed for a step recorded without its instruction. */
const DIGEST_PREFIX_CHARS = 12;

/**
 * Runs one `e2e cache` command against the configured store directory.
 * Returns the process exit code: 2 for a config or filesystem error, 0
 * otherwise — an empty or absent cache is a fact, not a failure.
 */
async function cache(command: CacheCommand, options: CacheOptions = {}): Promise<number> {
  let directory: string;
  try {
    directory = await resolveCacheDirectory(options);
  } catch (cause) {
    process.stderr.write(`${redactError(errorMessage(cause))}\n`);
    return 2;
  }

  try {
    const contents = await readContents(directory);
    switch (command) {
      case 'ls':
        return list(contents);
      case 'stats':
        return stats(contents);
      case 'clear':
        return await clear(contents);
    }
  } catch (cause) {
    process.stderr.write(`replay cache at ${directory} could not be read: ${errorMessage(cause)}\n`);
    return 2;
  }
}

/** Registers `e2e cache` and its `ls`, `clear`, and `stats` subcommands on `program`. */
export function registerCacheCommand(program: Command): void {
  const cacheCommand = program
    .command('cache')
    .summary('inspect, measure, and clear the replay cache')
    .description(
      'Read the replay cache the runs write, under .e2e/cache by default: what a committed cache holds, how much room it takes, and how to empty it. Reads the same config as e2e run, so --cache-dir, E2E_CACHE_DIR, cache.dir, and --config decide which store is meant.',
    )
    .addHelpText(
      'after',
      ['', examples(['e2e cache ls', 'e2e cache stats', 'e2e cache clear']), '', docsLine('/reference/cli#e2e-cache')].join('\n'),
    );

  const cacheSubcommand = (name: CacheCommand, summary: string, description: string): void => {
    cacheCommand
      .command(name)
      .summary(summary)
      .description(description)
      .option('--config <path>', 'config file (default: the nearest e2e.config.ts, .mts, .js, or .mjs)')
      .option('--cache-dir <dir>', CACHE_DIR_DESCRIPTION)
      .action(async (options: { config?: string; cacheDir?: string }) => {
        process.exitCode = await cache(name, options);
      });
  };

  cacheSubcommand(
    'ls',
    'list the cached traces',
    'Print one row per cached trace: the recording file it is in, the target it was recorded on, the instruction it was recorded for, its age, and how many actions a replay would run.',
  );
  cacheSubcommand('clear', 'delete every cached trace', 'Delete the recording files, entries an older e2e wrote, and the directory itself; files the runner never wrote are left alone.');
  cacheSubcommand('stats', 'print the entry count and size', 'Print the store directory, how many tests and readable entries it holds, and how many bytes they take.');
}

/**
 * The store directory from the project's resolved config, so `--cache-dir`,
 * `E2E_CACHE_DIR`, `cache.dir`, and `--config` mean here what they mean to a run.
 */
async function resolveCacheDirectory(options: CacheOptions): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const discovered = discoverConfig(cwd, options.config);
  if (discovered.configPath === undefined) throw missingConfigError(cwd);
  const raw = await loadConfigModule(discovered.configPath);
  const config = resolveConfig(raw, {
    projectRoot: discovered.projectRoot,
    configPath: discovered.configPath,
    env: process.env,
    cli: options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir },
  });
  if (config.cache.store !== undefined) {
    throw new Error(
      'cache.store replaces the file store with a custom one; e2e cache reads files only, so inspect that store with its own tools',
    );
  }
  return config.cache.dir;
}

/**
 * Every file in the store directory, classified. Reads go through the store
 * itself, so a recording this CLI lists is exactly one a run would replay:
 * an oversized or unparseable file is unreadable here and a miss there. A
 * directory that does not exist is an empty store.
 */
async function readContents(directory: string): Promise<CacheContents> {
  const store = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
  const entries: CacheEntrySummary[] = [];
  const files: { name: string; bytes: number; owned: readonly string[] }[] = [];
  const unreadable: { file: string; reason: string }[] = [];
  const legacy: string[] = [];
  const foreign: string[] = [];

  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { directory, entries, files, unreadable, legacy, foreign };
    }
    throw cause;
  }
  const listedFiles = await store.list();
  // A file named like a recording is the store's only when the store lists it: one it never wrote stays foreign.
  const owned = new Set(listedFiles.flatMap((listed) => listed.files));
  for (const name of names.toSorted()) {
    if (LEGACY_ENTRY_FILE.test(name)) legacy.push(name);
    else if (!owned.has(name) && !isLeftover(directory, name)) foreign.push(name);
  }

  for (const listed of listedFiles) {
    const file = `${listed.name}${RECORDING_EXTENSION}`;
    files.push({ name: listed.name, bytes: listed.bytes, owned: listed.files });
    const { parsed } = listed;
    if (parsed.status === 'invalid') {
      unreadable.push({ file, reason: parsed.reason });
      continue;
    }
    for (const where of parsed.unclaimed) unreadable.push({ file, reason: `${file}: ${where} has no entry in the lock file, so it never replays` });
    for (const recording of parsed.recordings) {
      if (recording.status === 'invalid') {
        unreadable.push({ file, reason: `${file}: ${recording.reason}` });
        continue;
      }
      const trace = recording.entry.payload;
      const instruction = trace.recordedFor?.instruction;
      entries.push({
        file,
        createdAt: recording.entry.createdAt,
        actions: trace.actions.length,
        truncated: trace.truncated === true,
        testId: trace.recordedFor?.testId,
        targetId: trace.recordedFor?.targetId,
        step:
          instruction === undefined
            ? (trace.recordedFor?.instructionDigest.slice(0, DIGEST_PREFIX_CHARS) ?? '-')
            : oneLine(sanitizeText(instruction)),
      });
    }
  }
  return { directory, entries, files, unreadable, legacy, foreign };
}

/** An instruction on one line, cut to `STEP_CHARS`. */
function oneLine(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= STEP_CHARS ? flat : `${flat.slice(0, STEP_CHARS - 1)}…`;
}

/**
 * Prints one row per recording, file by file in the order each file lists
 * them, so a reviewer reads a committed cache test by test.
 */
function list(contents: CacheContents): number {
  if (contents.entries.length === 0) {
    process.stdout.write(`no replay cache entries in ${contents.directory}\n`);
    warnAboutSkipped(contents);
    return 0;
  }
  const now = Date.now();
  const rows = contents.entries.map((entry) => [
    entry.file,
    sanitizeText(entry.targetId ?? '-'),
    entry.step,
    formatAge(entry.createdAt, now),
    `${entry.actions}${entry.truncated ? ' (truncated)' : ''}`,
  ]);
  const header = ['FILE', 'TARGET', 'STEP', 'AGE', 'ACTIONS'];
  const widths = header.map((title, column) =>
    Math.max(visibleWidth(title), ...rows.map((row) => visibleWidth(row[column]!))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell + ' '.repeat(widths[column]! - visibleWidth(cell))))
      .join('  ')
      .trimEnd();
  process.stdout.write(`${picocolors.bold(line(header))}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
  warnAboutSkipped(contents);
  return 0;
}

/** Prints the store's size: where it is, how many entries, how many bytes. */
function stats(contents: CacheContents): number {
  const bytes = contents.files.reduce((total, file) => total + file.bytes, 0);
  const rows: [string, string][] = [
    ['directory', contents.directory],
    ['tests', String(contents.files.length)],
    ['entries', String(contents.entries.length)],
    ['size', formatBytes(bytes)],
  ];
  if (contents.unreadable.length > 0) rows.push(['unreadable', String(contents.unreadable.length)]);
  if (contents.legacy.length > 0) rows.push(['legacy', String(contents.legacy.length)]);
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
  }
  warnAboutSkipped(contents);
  return 0;
}

/**
 * Deletes the store's own files and the directory when nothing else is left
 * in it. Files the store never wrote stay: `cache.dir` can point anywhere,
 * and a mistyped one must not take a project's files with it.
 */
async function clear(contents: CacheContents): Promise<number> {
  const removable = [
    ...contents.files.flatMap((file) => file.owned),
    ...contents.legacy,
  ];
  let removedFiles = 0;
  for (const name of removable) {
    const file = path.join(contents.directory, name);
    if (!existsSync(file)) continue;
    await rm(file, { force: true });
    removedFiles += 1;
  }
  // Leftover temporaries are neither entries nor foreign files; they go too.
  const temporaries = await removeTemporaries(contents.directory);
  const removed = removedFiles + temporaries;
  if (contents.foreign.length === 0) await rmdir(contents.directory).catch(() => undefined);
  process.stdout.write(
    removed === 0
      ? `no replay cache entries to clear in ${contents.directory}\n`
      : `cleared ${removed} file(s) from ${contents.directory}\n`,
  );
  warnAboutSkipped(contents);
  return 0;
}

async function removeTemporaries(directory: string): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!isLeftover(directory, name)) continue;
    await rm(path.join(directory, name), { force: true });
    removed += 1;
  }
  return removed;
}

/** Names what was left alone, so a surprising count has an explanation. */
function warnAboutSkipped(contents: CacheContents): void {
  if (contents.unreadable.length > 0) {
    process.stderr.write(
      `${contents.unreadable.length} recording(s) in ${contents.directory} are not readable; a run treats each as a miss:\n${contents.unreadable.map((item) => `  ${sanitizeText(item.reason)}`).join('\n')}\n`,
    );
  }
  if (contents.legacy.length > 0) {
    process.stderr.write(
      `${contents.legacy.length} file(s) in ${contents.directory} are entries an older e2e wrote, one .json file per key, which no run reads; re-record those steps, then delete the files (e2e cache clear removes them)\n`,
    );
  }
  if (contents.foreign.length > 0) {
    process.stderr.write(
      `${contents.foreign.length} file(s) in ${contents.directory} are not cache files and were left alone: ${sanitizeText(contents.foreign.join(', '))}\n`,
    );
  }
}

/** Coarse age of one entry: the unit a reviewer cares about, nothing finer. */
function formatAge(createdAt: string, now: number): string {
  const ms = now - Date.parse(createdAt);
  if (!Number.isFinite(ms)) return '-';
  // A future timestamp is a clock difference between two machines, not an age.
  if (ms < 60_000) return ms < 0 ? '0m' : '<1m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

