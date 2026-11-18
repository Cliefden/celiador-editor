/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseGitHubRemote } from '../../githubRemote';
import { generatePkce, pkceChallenge } from '../../pkce';
import { readSse } from '../../sse';

test('parses GitHub remotes in every URL form, and nothing else', () => {
  assert.deepEqual(
    [
      'https://github.com/Cliefden/celiador-editor.git',
      'https://token@github.com/Cliefden/celiador-editor',
      'git@github.com:Cliefden/celiador-editor.git',
      'ssh://git@github.com/Cliefden/celiador-editor/',
      '  HTTPS://GitHub.com/a/b.git  ',
      'https://gitlab.com/a/b.git',
      'https://github.com/only-owner',
      undefined,
    ].map(parseGitHubRemote),
    [
      { owner: 'Cliefden', repo: 'celiador-editor' },
      { owner: 'Cliefden', repo: 'celiador-editor' },
      { owner: 'Cliefden', repo: 'celiador-editor' },
      { owner: 'Cliefden', repo: 'celiador-editor' },
      { owner: 'a', repo: 'b' },
      undefined,
      undefined,
      undefined,
    ]
  );
});

test('PKCE: the S256 challenge is base64url SHA-256 of a fresh 256-bit verifier', async () => {
  const a = await generatePkce();
  const b = await generatePkce();
  assert.deepEqual(
    {
      verifier: /^[0-9a-f]{64}$/.test(a.verifier),
      challenge: a.challenge === createHash('sha256').update(a.verifier).digest('base64url'),
      fresh: a.verifier !== b.verifier,
      // RFC 7636 appendix B example.
      rfc: await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    },
    { verifier: true, challenge: true, fresh: true, rfc: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' }
  );
});

test('reads server-sent events split across chunks, with named events and multi-line data', async () => {
  const chunks = ['data: {"a":', '1}\n\nevent: ping\ndata:\r\n\r\n', 'data: line 1\ndata: line 2\n\n: comment\n\n'];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {controller.enqueue(new TextEncoder().encode(chunk));}
      controller.close();
    },
  });
  const frames: [string, string][] = [];
  await readSse(new Response(body), (event, data) => frames.push([event, data]));
  assert.deepEqual(frames, [['message', '{"a":1}'], ['ping', ''], ['message', 'line 1\nline 2']]);
});
