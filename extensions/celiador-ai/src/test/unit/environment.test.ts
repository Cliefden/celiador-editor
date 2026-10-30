/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEnvironment, environmentForUrl } from '../../environment';

test('maps daemon hosts to environments', () => {
  assert.deepEqual(
    ['https://celiador.ai', 'https://test.celiador.ai/', 'https://dev.celiador.ai', 'http://localhost:4661', 'http://127.0.0.1:4661', 'https://example.com', 'nonsense'].map(environmentForUrl),
    ['prod', 'test', 'dev', 'local', 'local', 'custom', 'custom']
  );
});

test('a prod build on prod is quiet', () => {
  const d = describeEnvironment({
    build: { channel: 'prod', name: 'Celiador', version: '1.138.0', commit: 'abcdef0123', build: 42 },
    extensionDaemonUrl: 'https://celiador.ai',
    nativeDaemonUrl: 'https://celiador.ai',
    overridden: false,
    health: { env: 'prod', version: '0.2.3', commit: '73c0d03380d8' },
  });
  assert.deepEqual(
    { env: d.env, label: d.label, severity: d.severity, problems: d.problems, summary: d.summary },
    {
      env: 'prod', label: 'prod', severity: 'ok', problems: [],
      summary: 'Celiador prod · Celiador 1.138.0 build 42 abcdef0 · daemon celiador.ai v0.2.3 73c0d03 · env=prod',
    }
  );
});

test('a test build is amber and says so', () => {
  const d = describeEnvironment({
    build: { channel: 'test', name: 'Celiador Test', version: '1.138.0' },
    extensionDaemonUrl: 'https://test.celiador.ai',
    nativeDaemonUrl: 'https://test.celiador.ai',
    overridden: false,
    health: { env: 'test', version: '0.2.3' },
  });
  assert.deepEqual({ label: d.label, severity: d.severity, problems: d.problems }, { label: 'TEST', severity: 'warning', problems: [] });
  assert.equal(d.lines[1], 'Build: Celiador Test · 1.138.0 · source build (test channel)');
});

test('the daemon’s own env wins over the host-name guess', () => {
  const d = describeEnvironment({
    build: {},
    extensionDaemonUrl: 'http://localhost:4661',
    nativeDaemonUrl: 'https://celiador.ai',
    overridden: true,
    health: { env: 'dev', version: '0.2.3' },
  });
  assert.equal(d.env, 'dev');
  assert.equal(d.severity, 'error');
  assert.deepEqual(d.problems, [
    'Split: the celiador.daemonUrl setting sends sign-in and account calls to localhost:4661, but agent runs, the relay and presence still use this build\'s celiador.ai.',
  ]);
});

test('a prod build repointed at test by the setting is flagged, and a lying daemon too', () => {
  const d = describeEnvironment({
    build: { channel: 'prod', name: 'Celiador' },
    extensionDaemonUrl: 'https://test.celiador.ai',
    nativeDaemonUrl: 'https://celiador.ai',
    overridden: true,
    health: { env: 'dev' },
  });
  assert.equal(d.severity, 'error');
  assert.deepEqual(d.problems, [
    'Split: the celiador.daemonUrl setting sends sign-in and account calls to test.celiador.ai, but agent runs, the relay and presence still use this build\'s celiador.ai.',
    'The daemon at test.celiador.ai reports env "dev", not "test".',
  ]);
});

test('an unreachable daemon keeps the host-name guess and says unreachable', () => {
  const d = describeEnvironment({
    build: { channel: 'dev', name: 'Celiador Dev' },
    extensionDaemonUrl: 'https://dev.celiador.ai',
    nativeDaemonUrl: 'https://dev.celiador.ai',
    overridden: false,
    healthError: 'timeout',
  });
  assert.deepEqual({ env: d.env, severity: d.severity, line: d.lines[2] }, {
    env: 'dev', severity: 'warning', line: 'Daemon: dev.celiador.ai — unreachable (timeout)',
  });
});
