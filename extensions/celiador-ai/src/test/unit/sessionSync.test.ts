/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStoredSession, planRefresh, sameSession, type Session } from '../../sessionSync';

const a: Session = { access_token: 'at-1', refresh_token: 'rt-1', expires_at: 1000, email: 'me@example.com' };
const rotated: Session = { access_token: 'at-2', refresh_token: 'rt-2', expires_at: 4600, email: 'me@example.com' };

test('parses the stored session and treats junk as signed out', () => {
  assert.deepEqual(
    [parseStoredSession(JSON.stringify(a)), parseStoredSession(undefined), parseStoredSession(''), parseStoredSession('{nope'), parseStoredSession('{"access_token":1}')],
    [a, null, null, null, null]
  );
});

test('sessions compare by their token pair', () => {
  assert.deepEqual(
    [sameSession(a, { ...a, email: 'other' }), sameSession(a, rotated), sameSession(null, undefined), sameSession(a, null)],
    [true, false, true, false]
  );
});

test('a window refreshes only the session storage still holds', () => {
  assert.deepEqual(planRefresh(a, { ...a }), { kind: 'refresh' });
});

test('a window whose session another window rotated adopts the rotated one', () => {
  // Spending rt-1 again would fail (GoTrue refresh tokens are single use).
  assert.deepEqual(planRefresh(a, rotated), { kind: 'adopt', session: rotated });
});

test('a window whose session another window signed out goes signed out', () => {
  assert.deepEqual(planRefresh(a, null), { kind: 'signedOut' });
});
