/**
 * `browser.webmcp` in a real browser: the tools a page registers through
 * `document.modelContext` (Chromium) or `navigator.modelContext` (Firefox)
 * are listed and called from test code, on the active tab, when the engine
 * launched the browser with `web({ webmcp: true })`. Without the option the
 * same calls say how to turn WebMCP on, and the option is refused where the
 * engine launches no browser. Driven through the engine hooks and the
 * `browser` fixture, as the attempt executor drives them. The Firefox half
 * runs where Playwright's Firefox is installed and is skipped elsewhere.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, type Browser, type BrowserName, type BrowserProvider, type WebOptions } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** A page that registers three tools, and one more when `/late` is asked for it. */
const TOOLS_PAGE = `<!doctype html>
<title>tools</title>
<script>
  const context = document.modelContext ?? navigator.modelContext;
  context?.registerTool({
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    annotations: { readOnlyHint: true },
    execute: async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  });
  context?.registerTool({
    name: 'rename',
    description: 'Renames the page',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    execute: async ({ title = 'untitled' }) => { document.title = title; return { content: [{ type: 'text', text: 'renamed' }] }; },
  });
  context?.registerTool({
    name: 'refuse',
    description: 'Always throws',
    inputSchema: { type: 'object' },
    execute: async () => { throw new Error('not today'); },
  });
  window.registerLate = () => context?.registerTool({
    name: 'late', description: 'Registered after load', inputSchema: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: 'late' }] }),
  });
</script>`;

const PLAIN_PAGE = '<!doctype html><title>plain</title><p>no tools here</p>';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-webmcp', attemptId: 'w1', origin: 'test' };
}

describe('browser.webmcp', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/plain' ? PLAIN_PAGE : TOOLS_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // `localhost`, not the address: WebMCP needs a secure context, which localhost is.
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-webmcp-'));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Boots one engine into a running attempt, with no page open yet. */
  async function boot(options: WebOptions): Promise<EngineHandle> {
    const engine = web(options);
    await engine.init!({
      runId: 'run-webmcp', targetName: 'web', projectRoot: process.cwd(),
      app: { site: 'localhost' }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'w1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return engine;
  }

  async function shutdown(engine: EngineHandle): Promise<void> {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }

  /** The engine's `browser` fixture, with the harness parts it reaches stubbed. */
  function fixtureOf(engine: EngineHandle): Browser {
    return engine.fixtures!['browser']!({
      operation,
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
  }

  const browsers: readonly { name: BrowserName; installed: boolean }[] = [
    { name: 'chromium', installed: true },
    { name: 'firefox', installed: existsSync(firefox.executablePath()) },
  ];

  describe.each(browsers)('with web({ webmcp: true }) in $name', ({ name, installed }) => {
    let engine: EngineHandle;
    let browser: Browser;

    beforeAll(async () => {
      if (!installed) return;
      engine = await boot({ webmcp: true, browser: name });
      browser = fixtureOf(engine);
      await engine.session!.open!(`${origin}/`, operation());
    });

    afterAll(async () => {
      if (installed) await shutdown(engine);
    });

    it.skipIf(!installed)('lists the tools the page registered, as the page describes them', async () => {
      const tools = await browser.webmcp.tools();
      // The browsers list them in different orders.
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(['add', 'refuse', 'rename']);
      expect(tools.find((tool) => tool.name === 'add')).toMatchObject({
        name: 'add',
        description: 'Adds two numbers',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
      });
    });

    it.skipIf(!installed)('calls a tool and resolves with its result', async () => {
      expect(await browser.webmcp.callTool('add', { a: 2, b: 40 })).toEqual({ content: [{ type: 'text', text: '42' }] });
    });

    it.skipIf(!installed)('calls a tool with an empty object when no input is given, and the tool acts on the page', async () => {
      expect(await browser.webmcp.callTool('rename')).toEqual({ content: [{ type: 'text', text: 'renamed' }] });
      expect(await browser.title()).toBe('untitled');
      await browser.webmcp.callTool('rename', { title: 'tools' });
      expect(await browser.title()).toBe('tools');
    });

    it.skipIf(!installed)('sees a tool the page registers after load', async () => {
      await browser.evaluate('window.registerLate()');
      expect((await browser.webmcp.tools()).map((tool) => tool.name)).toContain('late');
      expect(await browser.webmcp.callTool('late')).toEqual({ content: [{ type: 'text', text: 'late' }] });
    });

    it.skipIf(!installed)('fails a call to a tool the page does not register, naming the ones it does', async () => {
      await expect(browser.webmcp.callTool('subtract', { a: 1, b: 1 })).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^browser\.webmcp\.callTool: No WebMCP tool named "subtract"\. Available tools: (\w+, ){3}\w+/),
      });
    });

    it.skipIf(!installed)('fails a call whose tool throws', async () => {
      await expect(browser.webmcp.callTool('refuse')).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        // Chromium reports a fixed message, Firefox the tool's own.
        message: expect.stringMatching(/^browser\.webmcp\.callTool: .*(Tool execution failed|not today)/),
      });
    });

    it.skipIf(!installed)('refuses a name that is not a non-empty string, and input that is not JSON', async () => {
      await expect(browser.webmcp.callTool('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(browser.webmcp.callTool(7 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(browser.webmcp.callTool('add', { a: () => 1 } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it.skipIf(!installed)('lists no tools on a page that registers none, and follows the active tab', async () => {
      const first = browser.tabs()[0]!;
      const tab = await browser.newTab();
      await engine.session!.open!(`${origin}/plain`, operation());
      expect(await browser.webmcp.tools()).toEqual([]);
      await expect(browser.webmcp.callTool('add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await first.activate();
      expect((await browser.webmcp.tools()).length).toBeGreaterThan(0);
      await tab.close();
    });
  });

  it('says how to turn WebMCP on when the browser runs without it', async () => {
    const engine = await boot({});
    try {
      const browser = fixtureOf(engine);
      await engine.session!.open!(`${origin}/`, operation());
      const expected = {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/this browser runs without WebMCP; set web\(\{ webmcp: true \}\).*--enable-features=WebMCP/),
      };
      await expect(browser.webmcp.tools()).rejects.toMatchObject({ ...expected, message: expect.stringMatching(/^browser\.webmcp\.tools: /) });
      await expect(browser.webmcp.tools()).rejects.toMatchObject(expected);
      await expect(browser.webmcp.callTool('add', { a: 2, b: 40 })).rejects.toMatchObject(expected);
    } finally {
      await shutdown(engine);
    }
  });

  it('refuses the option where the engine launches no browser, on WebKit, and when it is not a boolean', () => {
    const provider: BrowserProvider = { name: 'hosted', acquire: async () => ({ id: 'b1', cdpEndpoint: 'ws://127.0.0.1:1' }), release: async () => undefined };
    expect(() => web({ webmcp: true, browser: provider })).toThrow(/web\(\{ webmcp \}\) is a launch setting, and with browser provider "hosted" the engine does not launch the browser/);
    expect(() => web({ webmcp: true, connect: { cdpEndpoint: async () => 'ws://127.0.0.1:1' } })).toThrow(/with connect the engine does not launch the browser/);
    expect(() => web({ webmcp: true, browser: 'webkit' })).toThrow(/web\(\{ webmcp \}\) requires the chromium or firefox browser; WebKit does not implement WebMCP/);
    expect(() => web({ webmcp: true, browser: 'firefox' })).not.toThrow();
    expect(() => web({ webmcp: 'yes' as unknown as boolean })).toThrow(/web\(\{ webmcp \}\) must be true or false/);
    expect(() => web({ webmcp: false, browser: provider })).not.toThrow();
  });
});
