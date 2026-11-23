/**
 * A target's `locators.visible` is the `visible` default of every query but
 * `getByRole`. A query's own `visible` replaces it.
 */

import { describe, expect, it } from 'vitest';
import { resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import type { Locator, Screen } from '@e2e-dev/core/lib/types';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

/** An email field: the one on screen, or its twin in a closed drawer. */
function emailField(id: string, hidden: boolean): SemanticNode {
  return {
    ref: { id, revision: '' },
    role: 'textbox',
    name: 'Email',
    value: 'ada@example.com',
    testId: 'email',
    attributes: { placeholder: 'you@example.com' },
    states: { hidden },
  };
}

const NODES: readonly SemanticNode[] = [emailField('shown', false), emailField('drawer', true)];

function screenWith(visible: boolean): Screen {
  return screenOver({
    observe: () => snapshot(NODES),
    locate: (expression) => resolveExpression(expression, NODES),
    timeoutMs: 300,
    locators: { visible },
  }).screen;
}

const QUERIES: readonly [string, (screen: Screen, options?: { visible?: boolean }) => Locator][] = [
  ['getByText', (screen, options) => screen.getByText('Email', options)],
  ['getByLabel', (screen, options) => screen.getByLabel('Email', options)],
  ['getByPlaceholder', (screen, options) => screen.getByPlaceholder('you@example.com', options)],
  ['getByDisplayValue', (screen, options) => screen.getByDisplayValue('ada@example.com', options)],
  ['getByTestId', (screen, options) => screen.getByTestId('email', options)],
];

describe('locators.visible', () => {
  it.each(QUERIES)('%s skips hidden nodes when the target turns it on', async (_name, query) => {
    expect(await query(screenWith(true)).count()).toBe(1);
  });

  it.each(QUERIES)('%s keeps hidden nodes when the query sets visible: false', async (_name, query) => {
    expect(await query(screenWith(true), { visible: false }).count()).toBe(2);
  });

  it.each(QUERIES)('%s keeps hidden nodes by default, unless the query sets visible: true', async (_name, query) => {
    const screen = screenWith(false);

    expect(await query(screen).count()).toBe(2);
    expect(await query(screen, { visible: true }).count()).toBe(1);
  });
});
