/** Compile-time assertions for `browser.webmcp` and the `webmcp` option. */
import type { Browser, WebMcpTool, WebOptions } from '../../src/index.ts';
import type { JsonValue } from '@e2e-dev/core';

/** True only when both types are the same; `any` on either side is a mismatch, which `satisfies` would let through. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function exact<Expected>(): <Actual>(value: Actual, same: Equal<Actual, Expected>) => void;

declare const browser: Browser;

exact<{
  tools(): Promise<readonly WebMcpTool[]>;
  callTool(name: string, input?: JsonValue): Promise<JsonValue>;
}>()(browser.webmcp, true);
exact<Promise<readonly WebMcpTool[]>>()(browser.webmcp.tools(), true);
exact<Promise<JsonValue>>()(browser.webmcp.callTool('add', { a: 2, b: 40 }), true);
exact<Promise<JsonValue>>()(browser.webmcp.callTool('refresh'), true);

declare const tool: WebMcpTool;
exact<{
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonValue;
  readonly annotations?: { readonly readOnly?: boolean; readonly untrustedContent?: boolean; readonly consequential?: boolean };
}>()(tool, true);

// @ts-expect-error a tool name is a string
void browser.webmcp.callTool(42);
// @ts-expect-error input is JSON, so it holds no function
void browser.webmcp.callTool('add', { a: () => 2 });
// @ts-expect-error the page's `readOnlyHint` is published as `readOnly`
void tool.annotations?.readOnlyHint;

exact<boolean | undefined>()(({} as WebOptions).webmcp, true);
void ({ webmcp: true } satisfies WebOptions);
// @ts-expect-error webmcp is a boolean
void ({ webmcp: 'on' } satisfies WebOptions);
