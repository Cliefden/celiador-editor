/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCost } from '../../agents/model';
import { clipText, composeTaskPrBody, formatTokens, parseSelfReview, runFooter } from '../../agents/prBody';

const FINAL_MESSAGE = [
  'Added a Cancel button to the session view and wired it to the relay.',
  '',
  'The button is disabled while the cancel is in flight.',
  '',
  '## Self-review',
  '- What changed: `SessionView.swift` gets a Cancel button; `RelayClient` gains `cancel()`.',
  '- Unsure about: whether the Live Activity should also show the cancelled state.',
  '- Not verified: did not run the UI tests (no simulator in this sandbox).',
  '  Also skipped the widget build.',
].join('\n');

test('parses a labelled self-review and the message before it', () => {
  assert.deepEqual(parseSelfReview(FINAL_MESSAGE), {
    body: 'Added a Cancel button to the session view and wired it to the relay.\n\nThe button is disabled while the cancel is in flight.',
    review: {
      whatChanged: '`SessionView.swift` gets a Cancel button; `RelayClient` gains `cancel()`.',
      unsure: ['whether the Live Activity should also show the cancelled state.'],
      notVerified: ['did not run the UI tests (no simulator in this sandbox).', 'Also skipped the widget build.'],
    },
  });
});

test('accepts bold labels, sub-headings and "none" answers; keeps unlabelled prose raw', () => {
  const headings = parseSelfReview('Done.\n\n## Self-review\n### What changed\nRenamed the flag.\n### Unsure about\nNone.\n### Not run\n- The e2e suite\n\n## Next steps\nShip it.');
  const bold = parseSelfReview('Done.\n\n**Self-review**\n**Changed.** Two files.\n**Uncertain.** The copy.\n**Did not verify.** Dark mode.');
  const prose = parseSelfReview('Done.\n\n## Self-review\nI changed two files and I think it is right.');
  assert.deepEqual([headings, bold, prose], [
    {
      body: 'Done.\n\n## Next steps\nShip it.',
      review: { whatChanged: 'Renamed the flag.', unsure: [], notVerified: ['The e2e suite'] },
    },
    {
      body: 'Done.',
      review: { whatChanged: 'Two files.', unsure: ['The copy.'], notVerified: ['Dark mode.'] },
    },
    {
      body: 'Done.',
      review: { unsure: [], notVerified: [], raw: 'I changed two files and I think it is right.' },
    },
  ]);
});

test('composes the contract body from the final message', () => {
  assert.equal(composeTaskPrBody({
    issueNumber: 49,
    finalMessage: FINAL_MESSAGE,
    machine: 'Stefan\'s MacBook Pro',
    files: 3,
    elapsedMs: 12 * 60_000,
  }), [
    'Closes #49',
    '',
    '## What the agent did',
    '`SessionView.swift` gets a Cancel button; `RelayClient` gains `cancel()`.',
    '',
    '## Self-review',
    '- Unsure about: whether the Live Activity should also show the cancelled state.',
    '- Not verified: did not run the UI tests (no simulator in this sandbox).',
    '- Not verified: Also skipped the widget build.',
    '',
    '---',
    'Run by Celiador on Stefan\'s MacBook Pro · 3 files · 12 min',
  ].join('\n'));
});

test('falls back to the clipped message without a self-review, and leaves unknown footer parts out', () => {
  const long = `${'word '.repeat(600)}end`;
  const body = composeTaskPrBody({ finalMessage: long, runner: 'cloud', usage: { costUsd: 0.38, inputTokens: 38_400, outputTokens: 2_400 }, attribution: true });
  const lines = body.split('\n');
  assert.deepEqual({
    heading: lines[0],
    clipped: lines[1].length <= 2000 && lines[1].endsWith(' word…'),
    blank: lines[2],
    noReview: !body.includes('## Self-review'),
    footer: lines.slice(-3),
  }, {
    heading: '## What the agent did',
    clipped: true,
    blank: '',
    noReview: true,
    footer: ['Run by Celiador on the cloud · $0.38 (38k in / 2.4k out tokens)', '', 'Made with [Celiador](https://celiador.ai): an agent ran this and a person reviewed it.'],
  });
  assert.equal(composeTaskPrBody({}), '## What the agent did\nThe agent did not leave a summary.\n\n---\nRun by Celiador');
});

test('formats footer pieces', () => {
  assert.deepEqual([
    runFooter({ machine: 'Mac', files: 1, elapsedMs: 20_000 }),
    formatTokens(512), formatTokens(1_234), formatTokens(10_000), formatTokens(38_400),
    formatCost(0.38), formatCost(0.004), formatCost(0), formatCost(12),
    clipText('short', 10), clipText('a sentence that goes on and on', 20),
  ], [
    'Run by Celiador on Mac · 1 file · <1 min',
    '512', '1.2k', '10k', '38k',
    '$0.38', '<$0.01', '$0.00', '$12.00',
    'short', 'a sentence that…',
  ]);
});
