/**
 * What a call from `run_code` on an engine fixture may reach: any member a
 * test calls, except what every object inherits and what reads or writes the
 * host by a path the code names.
 */

import { describe, expect, it } from 'vitest';
import { FixtureCalls, parseFixtureRequest, passesFunction } from '../../src/session-tools/code-fixtures.ts';

function calls(browser: object): FixtureCalls {
  return new FixtureCalls((name) => (name === 'browser' ? browser : undefined), (text) => text.replaceAll('hunter2', '<secret:password>'));
}

const request = (path: readonly string[], args?: readonly unknown[], base: object = { root: 'browser' }) => parseFixtureRequest(JSON.stringify({ base, path, args }));
const text = (value: string) => ({ t: 'value', v: value });

describe('run_code fixture calls', () => {
  it('refuses a member that reaches a host file by path or the raw driver, before anything runs', async () => {
    const ran: string[] = [];
    const locator = { setInputFiles: () => ran.push('setInputFiles'), fill: () => ran.push('fill') };
    const fixture = calls({
      locator: () => locator,
      addInitScript: () => ran.push('addInitScript'),
      route: () => ran.push('route'),
      installApp: () => ran.push('installApp'),
      unstable_raw: { client: { save: () => ran.push('raw') } },
    });
    const located = await fixture.run(request(['locator'], [text('#file')]));
    expect(located).toEqual({ handle: 0 });
    for (const refused of [
      request(['setInputFiles'], [text('/etc/passwd')], { handle: 0 }),
      request(['addInitScript'], [{ t: 'object', v: [['path', text('/etc/passwd')]] }]),
      request(['route'], [text('**/api'), { t: 'object', v: [['path', text('/etc/passwd')]] }]),
      request(['installApp'], [text('/tmp/app.apk')]),
      request(['unstable_raw', 'client', 'save'], [text('/tmp/x')]),
      request(['unstable_raw']),
    ]) {
      await expect(fixture.run(refused)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    }
    expect(ran).toEqual([]);

    // The same members without a host path run: a script as source, a route answered with data, the target's own app.
    await fixture.run(request(['addInitScript'], [{ t: 'function', s: '() => {}' }]));
    await fixture.run(request(['route'], [text('**/api'), { t: 'object', v: [['json', { t: 'value', v: 1 }]] }]));
    await fixture.run(request(['installApp'], []));
    await fixture.run(request(['fill'], [text('x')], { handle: 0 }));
    expect(ran).toEqual(['addInitScript', 'route', 'installApp', 'fill']);
  });

  it('spells a line from the request, names an object a call awaited for, and redacts what goes back', async () => {
    const tab = { close: () => Promise.resolve(undefined) };
    const fixture = calls({ newTab: () => Promise.resolve(tab), locator: () => ({ first: () => ({}) }), evaluate: () => Promise.resolve({ value: 'hunter2' }) });
    expect(await fixture.run(request(['newTab'], []))).toEqual({ handle: 0, declared: 'const newTab1 = await browser.newTab();' });
    expect(fixture.describe(request(['close'], [], { handle: 0 }))).toBe('newTab1.close()');
    expect(await fixture.run(request(['locator'], [text("it's")]))).toEqual({ handle: 1 });
    expect(fixture.describe(request(['first'], [], { handle: 1 }))).toBe("browser.locator('it\\'s').first()");
    expect(await fixture.run(request(['evaluate'], [{ t: 'function', s: '() => 1' }]))).toEqual({ value: { value: '<secret:password>' } });
  });

  it('tells a call that hands over a function from one that only reads', () => {
    expect(passesFunction(request(['evaluate'], [{ t: 'function', s: '() => document.title' }]))).toBe(true);
    expect(passesFunction(request(['url'], []))).toBe(false);
    expect(passesFunction(request(['title']))).toBe(false);
  });
});
