/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketTasks, buildTranscript, issueQuote, parseNumstat, parseUnifiedDiff, runMeta, slotsLabel, taskSubtitle, type Task } from '../../agents/model';

const NOW = new Date('2026-10-26T15:00:00');

function task(id: string, patch: Partial<Task>): Task {
  return {
    id,
    repo: { owner: 'Cliefden', name: 'celiador-ios', url: 'https://github.com/Cliefden/celiador-ios.git' },
    title: `Task ${id}`,
    branch: `${id}-branch`,
    state: 'running',
    createdAt: '2026-10-26T10:00:00',
    updatedAt: '2026-10-26T10:00:00',
    ...patch,
  };
}

test('buckets tasks the way the contract derives them', () => {
  const tasks = [
    task('ask', { state: 'running', awaiting: { kind: 'permission', requestId: 'r', text: 'Run command: npm test' } }),
    task('pr', { state: 'pr-open', pr: { number: 8, url: 'https://github.com/x/y/pull/8' } }),
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
  ], ['52-relay · wants: run tests', '49-cancel · PR #8', '61-sec · this Mac', '63-guide · cloud']);
  assert.equal(
    runMeta(task('e', { branch: '49-cancel', state: 'pr-open', issue: { number: 49, title: 't', url: 'u' }, startedAt: '2026-10-26T10:00:00Z', finishedAt: '2026-10-26T10:12:00Z' }), undefined),
    'Issue #49 · worktree 49-cancel · ran on this Mac, 12 min');
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
    { kind: 'message', role: 'user', text: 'the task prompt' },
    { kind: 'delta', text: 'I\'ll add a ' },
    { kind: 'delta', text: 'Cancel button.' },
    { kind: 'tool', name: 'Read', input: { file_path: '/w/SessionView.swift' } },
    { kind: 'tool', name: 'Bash', input: {} },
    { kind: 'delta', text: 'Build succeeded.' },
    { kind: 'done' },
    { kind: 'message', role: 'user', text: 'also disable it' },
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
