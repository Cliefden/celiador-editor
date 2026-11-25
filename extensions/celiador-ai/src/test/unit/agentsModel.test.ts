/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSessionEvent, bucketTasks, buildTranscript, issueQuote, parseNumstat, parseUnifiedDiff, runMeta, slotsLabel, taskSubtitle, type SessionEvent, type Task } from '../../agents/model';
import { nonce } from '../../agents/webview';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const AT = '2026-10-26T10:00:00Z';
let lastSeq = 0;

/** A session event as the daemon sends it; `seq` counts up unless given, `at` is fixed. */
function ev(e: DistributiveOmit<SessionEvent, 'seq' | 'at'> & { seq?: number }): SessionEvent {
  return { seq: ++lastSeq, at: AT, ...e } as SessionEvent;
}

test('transcript events skip replayed seqs, merge deltas and stay bounded', () => {
  const events: SessionEvent[] = [];
  const add = (e: SessionEvent) => addSessionEvent(events, e, 3);
  add(ev({ seq: 1, kind: 'message', role: 'user', text: 'Fix it' }));
  add(ev({ seq: 2, kind: 'delta', text: 'Look' }));
  add(ev({ seq: 3, kind: 'delta', text: 'ing' }));
  add(ev({ seq: 3, kind: 'delta', text: 'ing' })); // replayed after a reconnect
  add(ev({ seq: 4, kind: 'tool', callId: 'c1', name: 'Read' }));
  add(ev({ seq: 5, kind: 'done' }));
  assert.deepEqual(events, [
    { seq: 3, at: AT, kind: 'delta', text: 'Looking' },
    { seq: 4, at: AT, kind: 'tool', callId: 'c1', name: 'Read' },
    { seq: 5, at: AT, kind: 'done' },
  ]);
});

test('webview nonces are unpredictable base64url strings', () => {
  const a = nonce();
  assert.deepEqual([/^[A-Za-z0-9_-]{22}$/.test(a), a === nonce()], [true, false]);
});

const NOW = new Date('2026-10-26T15:00:00');

function task(id: string, patch: Partial<Task>): Task {
  return {
    id,
    repo: { owner: 'Cliefden', name: 'celiador-ios', url: 'https://github.com/Cliefden/celiador-ios.git' },
    title: `Task ${id}`,
    prompt: '',
    branch: `${id}-branch`,
    source: 'manual',
    state: 'running',
    createdAt: '2026-10-26T10:00:00',
    updatedAt: '2026-10-26T10:00:00',
    ...patch,
  };
}

/** A pull request as the daemon reports it on a task. */
function pr(number: number, url: string): NonNullable<Task['pr']> {
  return { number, url, updatedAt: '2026-10-26T10:00:00Z' };
}

/** A run's usage as the daemon reports it on a task. */
function usage(patch: Partial<NonNullable<Task['usage']>>): NonNullable<Task['usage']> {
  return { requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, ...patch };
}

test('buckets tasks the way the contract derives them', () => {
  const tasks = [
    task('ask', { state: 'running', awaiting: { kind: 'permission', requestId: 'r', text: 'Run command: npm test' } }),
    task('pr', { state: 'pr-open', pr: pr(8, 'https://github.com/x/y/pull/8') }),
    task('run', { state: 'running', runner: 'mac' }),
    task('queued', { state: 'queued' }),
    task('merged', { state: 'merged', finishedAt: '2026-10-26T09:00:00' }),
    task('old', { state: 'merged', finishedAt: '2026-10-20T09:00:00' }),
    task('cancelled', { state: 'cancelled' }),
  ];
  assert.deepEqual(bucketTasks(tasks, NOW).map((b) => [b.id, b.tasks.map((t) => t.id)]), [
    ['needs-you', ['ask']],
    ['ready', ['pr']],
    ['running', ['run', 'queued']],
    ['merged-today', ['merged']],
  ]);
  assert.equal(slotsLabel({ tasks, concurrency: 3 }), '2 of 3 slots busy');
});

test('subtitles and meta', () => {
  assert.deepEqual([
    taskSubtitle(task('a', { branch: '52-relay', awaiting: { kind: 'permission', requestId: 'r', text: 'run tests' } }), 'Mac'),
    taskSubtitle(task('b', { branch: '49-cancel', state: 'pr-open', prUrl: 'https://github.com/x/y/pull/8' }), 'Mac'),
    taskSubtitle(task('c', { branch: '61-sec', machine: 'Mac' }), 'Mac'),
    taskSubtitle(task('d', { branch: '63-guide', runner: 'cloud' }), 'Mac'),
    taskSubtitle(task('f', { branch: '70-cost', runner: 'cloud', usage: usage({ requests: 12, inputTokens: 38_400, outputTokens: 2_400, costUsd: 0.38 }) }), 'Mac'),
    taskSubtitle(task('g', { branch: '71-free', state: 'pr-open', pr: pr(9, 'u'), usage: usage({ costUsd: 0.001 }) }), 'Mac'),
  ], ['52-relay · wants: run tests', '49-cancel · PR #8', '61-sec · this Mac', '63-guide · cloud', '70-cost · cloud · $0.38', '71-free · PR #9 · <$0.01']);
  assert.deepEqual([
    runMeta(task('e', { branch: '49-cancel', state: 'pr-open', issue: { number: 49, title: 't', url: 'u' }, startedAt: '2026-10-26T10:00:00Z', finishedAt: '2026-10-26T10:12:00Z' }), undefined),
    runMeta(task('h', { branch: '70-cost', state: 'pr-open', runner: 'cloud', startedAt: '2026-10-26T10:00:00Z', finishedAt: '2026-10-26T10:12:00Z', usage: usage({ costUsd: 0.38 }) }), undefined),
  ], [
    'Issue #49 · worktree 49-cancel · ran on this Mac, 12 min',
    'worktree 70-cost · ran on the cloud, 12 min · $0.38',
  ]);
});

test('parses numstat and unified diffs', () => {
  assert.deepEqual(parseNumstat('48\t9\tCeliador/SessionView.swift\n-\t-\tlogo.png\n3\t1\tsrc/{old => new}/a.ts\n'), [
    { path: 'Celiador/SessionView.swift', additions: 48, deletions: 9, binary: false },
    { path: 'logo.png', additions: 0, deletions: 0, binary: true },
    { path: 'src/new/a.ts', additions: 3, deletions: 1, binary: false },
  ]);
  assert.deepEqual(parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -10,2 +10,2 @@\n ctx\n-old\n+new\n'), [
    { kind: 'hunk', text: '@@ -10,2 +10,2 @@' },
    { kind: 'context', text: 'ctx', line: 10 },
    { kind: 'del', text: 'old', line: 11 },
    { kind: 'add', text: 'new', line: 11 },
  ]);
});

test('folds session events into a transcript', () => {
  assert.deepEqual(buildTranscript([
    ev({ kind: 'message', role: 'user', text: 'the task prompt' }),
    ev({ kind: 'delta', text: 'I\'ll add a ' }),
    ev({ kind: 'delta', text: 'Cancel button.' }),
    ev({ kind: 'tool', callId: 'c1', name: 'Read', input: { file_path: '/w/SessionView.swift' } }),
    ev({ kind: 'tool', callId: 'c2', name: 'Bash', input: {} }),
    ev({ kind: 'delta', text: 'Build succeeded.' }),
    ev({ kind: 'done' }),
    ev({ kind: 'message', role: 'user', text: 'also disable it' }),
    // A kind this client doesn't know yet (new kinds are additive): skipped.
    { ...ev({ kind: 'done' }), kind: 'checkpoint' } as unknown as SessionEvent,
  ]), [
    { kind: 'assistant', text: 'I\'ll add a Cancel button.' },
    { kind: 'tools', lines: ['Read · SessionView.swift', 'Bash'] },
    { kind: 'assistant', text: 'Build succeeded.' },
    { kind: 'user', text: 'also disable it' },
  ]);
  assert.equal(issueQuote(task('q', {
    issue: { number: 49, title: 'Cancel', url: 'u' },
    prompt: 'Resolve GitHub issue #49 in a/b: "Cancel".\n\nIssue description:\nWhen a cloud run is going, let me cancel it.\n\nMore.\n\nKeep the change focused on this issue.',
  })), 'When a cloud run is going, let me cancel it.');
});
