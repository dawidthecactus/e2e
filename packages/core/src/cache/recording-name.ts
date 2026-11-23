/**
 * The file name of one test's recordings: what a reviewer sees in a diff's
 * file list, so it says which test it is (`checkout-buys-a-mug`) instead of
 * a digest.
 *
 * The name is the test file's stem and the test's titles, from the test id
 * as an entry stores it (redacted), in lowercase ASCII kebab case. Two tests
 * whose names come out the same share no file: the store gives the second
 * the name with `--` and 12 hex characters of its test id's SHA-256 after
 * it (`collisionName`), and each file's lock names the test it holds, so a
 * reader opens the one that is its own.
 */

import { sha256Hex } from '../internal/ids.ts';

/** Longest a name runs before it is cut at a word boundary. */
const MAX_NAME_CHARS = 80;

/** Hex characters of the test id's digest a colliding name carries. */
const COLLISION_DIGEST_CHARS = 12;

/** Names Windows reserves for devices, which no file may take, whatever its extension. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

/** The shape of every name the store writes: lowercase words joined by single dashes, maybe a collision suffix. */
export const RECORDING_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-f0-9]{12})?$/u;

/** Text as lowercase ASCII words joined by single dashes; accents are dropped, every other character separates words. */
function kebab(text: string): string {
  return text
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '');
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * The name of a test's recordings, from its test id
 * (`tests/checkout.e2e.ts::buys%20a%20mug` is `checkout-buys-a-mug`). A
 * first title that only repeats the file's stem
 * (`control-inventory.e2e.ts::control inventory::...`) is left out.
 */
export function recordingName(testId: string): string {
  const parts = testId.split('::');
  let words: string[];
  if (parts.length < 2) {
    words = [kebab(testId)];
  } else {
    const [file, ...titles] = parts;
    const base = file!.split('/').pop() ?? '';
    const stem = kebab(base.split('.')[0] ?? '');
    const named = titles.map((title) => kebab(decode(title)));
    words = [stem, ...(named[0] === stem ? named.slice(1) : named)];
  }
  let name = words.filter((word) => word !== '').join('-');
  if (name.length > MAX_NAME_CHARS) {
    const cut = name.lastIndexOf('-', MAX_NAME_CHARS);
    name = name.slice(0, cut > 0 ? cut : MAX_NAME_CHARS).replace(/-+$/u, '');
  }
  if (name === '') return 'test';
  return WINDOWS_DEVICE.test(name) ? `test-${name}` : name;
}

/**
 * How every name `recordingName` gives a test of this file starts: the
 * file's stem. A test id that spells a secret is named differently once
 * the secret is redacted, but only in its titles, so its recordings under
 * either spelling share this.
 */
export function recordingPrefix(testId: string): string {
  const parts = testId.split('::');
  if (parts.length < 2) return '';
  return kebab((parts[0]!.split('/').pop() ?? '').split('.')[0] ?? '');
}

/** The name a test takes when another test already holds `name`. */
export function collisionName(name: string, testId: string): string {
  return `${name}--${sha256Hex(testId).slice(0, COLLISION_DIGEST_CHARS)}`;
}
