/** The file store: one reviewable YAML file and one generated lock per test, fail-to-miss reads. */

import { chmod, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { instructionDigest, paramsDigest } from '@e2e-dev/core/lib/cache/identity';
import { FileCacheStore, MAX_CACHE_WIRE_BYTES } from '@e2e-dev/core/lib/cache/store';
import type { ActionTrace, TraceProvenance } from '@e2e-dev/core/lib/cache/trace';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const TEST_ID = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan';
const NAME = 'settings-upgrades-the-plan';
const INSTRUCTION = 'upgrade the plan to {tier}';
const PARAMS = { tier: 'Pro' };

function step(targetId = 'web', overrides: Partial<TraceProvenance> = {}): TraceProvenance {
  return {
    testId: TEST_ID,
    targetId,
    instructionDigest: instructionDigest(INSTRUCTION),
    paramsDigest: paramsDigest(PARAMS),
    callIndex: 0,
    agent: 'default',
    instruction: INSTRUCTION,
    params: PARAMS,
    ...overrides,
  };
}

function payload(targetId = 'web', overrides: Partial<ActionTrace> = {}): ActionTrace {
  return {
    actions: [
      { name: 'tap', summary: 'tap button "Upgrade"', target: { role: 'button', name: 'Upgrade', within: 'Plan' } },
      { name: 'type', summary: 'type "Pro" into textbox "Tier"', target: { role: 'textbox', name: 'Tier' }, value: 'Pro' },
      { name: 'pressKey', summary: 'press "Enter" on the focused field', key: 'Enter' },
      { name: 'back', summary: 'navigate back' },
    ],
    executor: { name: 'example-agent', version: '1' },
    recordedFor: step(targetId),
    summary: 'upgraded the plan',
    startPath: '/settings',
    endPath: '/settings',
    endAnchors: [{ role: 'status', text: 'Plan: Pro' }],
    goneAnchors: [{ role: 'button', name: 'Upgrade', position: { index: 0, of: 2 } }],
    endWaitMs: 11_234,
    ...overrides,
  };
}

/** Temp dirs the cases here create, removed after each so a run leaves nothing behind. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(options: { maxBytes?: number; writable?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-trace-cache-'));
  tempDirs.push(directory);
  return {
    directory,
    store: new FileCacheStore({
      directory,
      maxBytes: options.maxBytes ?? MAX_CACHE_WIRE_BYTES,
      writable: options.writable ?? true,
    }),
  };
}

const yamlPath = (directory: string, name = NAME) => path.join(directory, `${name}.yml`);
const lockPath = (directory: string, name = NAME) => path.join(directory, `${name}.lock.json`);

describe('FileCacheStore', () => {
  it('writes one test as a YAML file named for it, and reads every field back', async () => {
    const { directory, store } = await makeStore();
    const written = await store.write(KEY, payload());
    expect(written?.bytes).toBeGreaterThan(0);
    expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(
      [
        '# Replay recording of one e2e test. Review it like code: each step lists what',
        '# a replay does (do) and what it checks before the step passes (expect).',
        `# Generated, not reviewed: ${NAME}.lock.json holds the cache keys.`,
        '',
        'test: settings › upgrades the plan',
        'file: tests/settings.e2e.ts',
        '',
        'steps:',
        '  - act: upgrade the plan to {tier}',
        '    params:',
        '      tier: Pro',
        '    targets:',
        '      web:',
        '        at: /settings',
        '        do:',
        '          - tap: { role: button, name: Upgrade, within: Plan }',
        '          - type: Pro',
        '            into: { role: textbox, name: Tier }',
        '          - press: Enter',
        '          - back',
        '        expect:',
        '          shows:',
        '            - { role: status, text: "Plan: Pro" }',
        '          gone:',
        '            - { role: button, name: Upgrade, position: { index: 0, of: 2 } }',
        '',
      ].join('\n'),
    );
    const read = await store.read(KEY, step());
    expect(read.status).toBe('hit');
    // The end wait is kept in whole seconds, rounded up; the action summaries are written again from the actions.
    expect(read.status === 'hit' && read.entry.payload).toEqual({
      ...payload(),
      actions: [
        { name: 'tap', summary: 'tap button "Upgrade" in "Plan"', target: { role: 'button', name: 'Upgrade', within: 'Plan' } },
        payload().actions[1],
        payload().actions[2],
        payload().actions[3],
      ],
      endWaitMs: 12_000,
    });
    // A read without the step finds the entry by listing the directory.
    expect((await store.read(KEY)).status).toBe('hit');
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    expect(lock).toMatchObject({ format: 'e2e-replay-lock-1', testId: TEST_ID, entries: [{ key: KEY, step: 0, target: 'web' }] });
  });

  it('lists one step recorded on two targets under one act, and drops each on its own', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload('web'));
    await store.write(OTHER_KEY, payload('ios', { startPath: '/a', endPath: '/b' }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(yaml.match(/- act:/gu)).toHaveLength(1);
    expect(yaml).toContain('      web:\n        at: /settings\n');
    expect(yaml).toContain('      ios:\n        from: /a\n        to: /b\n');
    expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');

    await store.delete(KEY, step('web'));
    expect((await store.read(KEY, step('web'))).status).toBe('miss');
    expect((await store.read(OTHER_KEY, step('ios'))).status).toBe('hit');
    await store.delete(OTHER_KEY, step('ios'));
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps one recording per step and target, replacing it whatever its key', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { summary: 'upgraded again' }));
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read(OTHER_KEY, step())).status).toBe('hit');
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    expect(lock.entries).toHaveLength(1);
  });

  it('lists a repeated instruction as two steps, in the order they were recorded', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { callIndex: 1 }) }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    expect(yaml.match(/- act:/gu)).toHaveLength(2);
    // Steps are blocks of their own: a blank line before each.
    expect(yaml).toContain('upgrade the plan to {tier}\n');
    expect(yaml).toContain('\n\n  - act:');
    expect((await store.read(OTHER_KEY, step('web', { callIndex: 1 }))).status).toBe('hit');
  });

  it('names an agent other than the default on its step', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload('web', { recordedFor: step('web', { agent: 'admin' }) }));
    expect(await readFile(yamlPath(directory), 'utf8')).toContain('    agent: admin\n');
    expect((await store.read(KEY, step('web', { agent: 'admin' }))).status).toBe('hit');
  });

  it('gives a second test whose name comes out the same its own file', async () => {
    const { directory, store } = await makeStore();
    const otherTest = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan!';
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { testId: otherTest }) }));
    const names = (await readdir(directory)).filter((name) => name.endsWith('.yml')).toSorted();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^settings-upgrades-the-plan--[a-f0-9]{12}\.yml$/u);
    expect(names[1]).toBe(`${NAME}.yml`);
    expect((await store.read(KEY, step())).status).toBe('hit');
    expect((await store.read(OTHER_KEY, step('web', { testId: otherTest }))).status).toBe('hit');
    expect((await store.read(KEY, step('web', { testId: otherTest }))).status).toBe('miss');
  });

  it('writes two targets of one test at once without losing either', async () => {
    const { store } = await makeStore();
    const targets = ['web', 'ios', 'android', 'desktop'];
    await Promise.all(targets.map((targetId, index) => store.write(String(index).repeat(64), payload(targetId))));
    for (const [index, targetId] of targets.entries()) {
      expect((await store.read(String(index).repeat(64), step(targetId))).status).toBe('hit');
    }
  });

  it('takes over the lock a writer that died holding it left behind', async () => {
    const { directory, store } = await makeStore();
    const stale = path.join(directory, `.${NAME}.writing`);
    await writeFile(stale, '', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    expect(await store.write(KEY, payload())).toBeDefined();
    expect(await readdir(directory)).not.toContain(`.${NAME}.writing`);
  });

  it('says in the lock when the act it shows cannot be held to the key', async () => {
    const { directory, store } = await makeStore();
    // The instruction as the entry keeps it differs from the one the key digested (a redacted secret, say).
    await store.write(KEY, payload('web', { recordedFor: step('web', { instruction: 'upgrade the plan to <secret:tier>' }) }));
    const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    expect(lock.entries[0].verbatim).toBe(false);
    expect((await store.read(KEY, step())).status).toBe('hit');
  });

  it('misses on an absent entry and rejects a malformed key hash', async () => {
    const { store } = await makeStore();
    expect((await store.read(KEY, step())).status).toBe('miss');
    expect((await store.read('../escape')).status).toBe('invalid');
    expect(await store.write('../escape', payload())).toBeUndefined();
  });

  it('does not write a trace that does not name its whole step', async () => {
    const { directory, store } = await makeStore();
    const { recordedFor: _recordedFor, ...anonymous } = payload();
    expect(await store.write(KEY, anonymous)).toBeUndefined();
    expect(await store.write(KEY, payload('web', { recordedFor: { testId: TEST_ID, targetId: 'web', instructionDigest: instructionDigest(INSTRUCTION) } }))).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  describe('fails closed on a file it cannot trust', () => {
    async function written() {
      const made = await makeStore({ maxBytes: 8_192 });
      await made.store.write(KEY, payload());
      return { ...made, yaml: await readFile(yamlPath(made.directory), 'utf8') };
    }

    it.each([
      ['a torn file', () => 'steps: [ torn'],
      ['an act edited under its key', (yaml: string) => yaml.replace('upgrade the plan to {tier}', 'downgrade the plan to {tier}')],
      ['params edited under their key', (yaml: string) => yaml.replace('tier: Pro', 'tier: Free')],
      ['an unknown key', (yaml: string) => yaml.replace('        at: /settings', '        at: /settings\n        later: true')],
      ['an unknown action', (yaml: string) => yaml.replace('          - back', '          - shell: rm -rf /')],
      ['an anchor and an alias', (yaml: string) => yaml.replace('- tap: { role: button', '- tap: &upgrade { role: button').replace('          - back', '          - tap: *upgrade')],
      ['a tag', (yaml: string) => yaml.replace('- type: Pro', '- type: !!str Pro')],
      ['a duplicate key', (yaml: string) => yaml.replace('        at: /settings', '        at: /settings\n        at: /elsewhere')],
      ['a target the lock does not name', (yaml: string) => yaml.replace('      web:', '      web2:')],
      ['a value the trace format refuses', (yaml: string) => yaml.replace('- press: Enter', '- press: ""')],
      ['an oversized file', (yaml: string) => `${yaml}#${'x'.repeat(9_000)}\n`],
    ])('%s', async (_label, edit) => {
      const { directory, store, yaml } = await written();
      await writeFile(yamlPath(directory), edit(yaml), 'utf8');
      const read = await store.read(KEY, step());
      expect(read.status).toBe('invalid');
    });

    it('a missing lock file', async () => {
      const { directory, store } = await written();
      await rm(lockPath(directory));
      // Without the lock, nothing says which keys the YAML holds: a miss, never a replay.
      expect((await store.read(KEY, step())).status).not.toBe('hit');
    });

    it('a lock of another format', async () => {
      const { directory, store } = await written();
      const lock = JSON.parse(await readFile(lockPath(directory), 'utf8'));
      await writeFile(lockPath(directory), JSON.stringify({ ...lock, format: 'e2e-replay-lock-0' }), 'utf8');
      expect((await store.read(KEY, step())).status).not.toBe('hit');
    });

    it('and a later write or eviction leaves the file it could not read', async () => {
      const { directory, store, yaml } = await written();
      const torn = yaml.replace('steps:', 'steps: [ torn');
      await writeFile(yamlPath(directory), torn, 'utf8');
      expect(await store.write(KEY, payload())).toBeUndefined();
      await store.delete(KEY, step());
      expect(await readFile(yamlPath(directory), 'utf8')).toBe(torn);
    });

    it('a lock in a merge conflict, for every step of the test, without a second file', async () => {
      const { directory, store } = await written();
      const lock = await readFile(lockPath(directory), 'utf8');
      await writeFile(lockPath(directory), `<<<<<<< HEAD\n${lock}=======\n${lock}>>>>>>> branch\n`, 'utf8');
      expect((await store.read(KEY, step())).status).toBe('invalid');
      // A step the pair may or may not hold is no miss either: strict replay must not run it live.
      expect((await store.read(OTHER_KEY, step('web', { callIndex: 1 }))).status).toBe('invalid');
      expect(await store.write(OTHER_KEY, payload('web', { recordedFor: step('web', { callIndex: 1 }) }))).toBeUndefined();
      expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
    });

    it('but not a pair whose YAML names another test', async () => {
      const { directory, store } = await written();
      await rm(lockPath(directory));
      const otherTest = 'tests/settings.e2e.ts::settings::upgrades%20the%20plan!';
      expect((await store.read(OTHER_KEY, step('web', { testId: otherTest }))).status).toBe('miss');
    });
  });

  it('keeps a recording it cannot read when another is written or evicted beside it', async () => {
    const { directory, store } = await makeStore();
    const second = step('web', { callIndex: 1 });
    await store.write(KEY, payload());
    await store.write(OTHER_KEY, payload('web', { recordedFor: second }));
    const yaml = await readFile(yamlPath(directory), 'utf8');
    // The second step's act no longer digests to its key: that recording reads as invalid, the first still replays.
    const edited = `${yaml.slice(0, yaml.lastIndexOf('- act:'))}- act: downgrade the plan to {tier}\n${yaml.slice(yaml.indexOf('\n', yaml.lastIndexOf('- act:')) + 1)}`;
    await writeFile(yamlPath(directory), edited, 'utf8');
    expect((await store.read(OTHER_KEY, second)).status).toBe('invalid');
    expect((await store.read(KEY, step())).status).toBe('hit');
    expect(await store.write('c'.repeat(64), payload('ios'))).toBeUndefined();
    await expect(store.delete(KEY, step())).rejects.toThrow(/does not read/u);
    expect(await readFile(yamlPath(directory), 'utf8')).toBe(edited);
    // Recording the step again under its own key is the repair.
    expect(await store.write(OTHER_KEY, payload('web', { recordedFor: second }))).toBeDefined();
    expect((await store.read(OTHER_KEY, second)).status).toBe('hit');
  });

  // Root writes anywhere, and Windows ignores the mode: neither has a directory to refuse the lock.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads from a directory it cannot write, as on a read-only mount', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await chmod(directory, 0o555);
    try {
      expect((await store.read(KEY, step())).status).toBe('hit');
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('refuses to write a file over its byte cap', async () => {
    const { store } = await makeStore({ maxBytes: 64 });
    expect(await store.write(KEY, payload())).toBeUndefined();
    expect((await store.read(KEY, step())).status).toBe('miss');
  });

  it('never writes when not writable', async () => {
    const { directory, store } = await makeStore({ writable: false });
    expect(await store.write(KEY, payload())).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it('evicts an entry on delete, tolerating absence and read-only mode', async () => {
    const { directory, store } = await makeStore();
    await store.write(KEY, payload());
    await store.delete(KEY);
    expect(await readdir(directory)).toEqual([]);
    await store.delete(KEY);
    const readOnly = new FileCacheStore({ directory, maxBytes: MAX_CACHE_WIRE_BYTES, writable: false });
    await store.write(KEY, payload());
    await readOnly.delete(KEY, step());
    expect((await readdir(directory)).toSorted()).toEqual([`${NAME}.lock.json`, `${NAME}.yml`]);
  });
});
