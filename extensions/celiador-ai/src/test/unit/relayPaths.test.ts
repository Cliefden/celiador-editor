/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInside, relaySegments } from '../../relayPaths';

function outcome(rel: string): string[] | string {
  try {
    return relaySegments(rel);
  } catch (err) {
    return (err as Error).message;
  }
}

test('splits plain repo-relative paths and refuses escapes and git internals', () => {
  assert.deepEqual(
    ['src/a.ts', './src//b.ts', '', '../x', 'a/../../x', 'a\\..\\x', '.git/config', 'sub/.GIT/hooks/pre-commit', '.git./config', 'docs/.gitignore'].map(outcome),
    [
      ['src', 'a.ts'],
      ['src', 'b.ts'],
      [],
      'bad path',
      'bad path',
      'bad path',
      'the phone cannot access this path',
      'the phone cannot access this path',
      'the phone cannot access this path',
      ['docs', '.gitignore'],
    ]
  );
});

test('containment compares whole path segments', () => {
  assert.deepEqual(
    [
      isInside('/repo', '/repo'),
      isInside('/repo', '/repo/src/a.ts'),
      isInside('/repo', '/repo-other/a.ts'),
      isInside('/repo', '/home/me/.ssh/id_rsa'),
      isInside('/repo/', '/repo/a', '/'),
    ],
    [true, true, false, false, true]
  );
});
