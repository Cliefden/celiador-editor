/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Which Celiador environment this editor is working against (CHANNELS.md,
// daemon/ENVIRONMENTS.md). Pure functions — no vscode import — so the status
// item's wording is unit-testable. The vscode side lives in environmentStatus.ts.

/** A daemon environment, derived from its host name. */
export type Environment = 'prod' | 'test' | 'dev' | 'local' | 'custom';

/** What the build itself says (product.json). */
export interface BuildIdentity {
  /** `celiadorChannel`: prod / test / dev. Unset in a source build. */
  channel?: string;
  /** `nameLong`, e.g. "Celiador Test". */
  name?: string;
  /** VS Code version of the fork. */
  version?: string;
  /** Short or long commit of the build; unset in a source build. */
  commit?: string;
  /** `celiadorBuild`, the release script's build number. */
  build?: number;
}

/** What the daemon reports on `GET /api/health`. */
export interface DaemonHealth {
  env?: string;
  version?: string;
  commit?: string;
}

export interface EnvironmentInput {
  build: BuildIdentity;
  /** The URL the extension uses: the `celiador.daemonUrl` setting, else the build's. */
  extensionDaemonUrl: string;
  /** The URL the native agent host, relay bridge and presence use: always the build's. */
  nativeDaemonUrl: string;
  /** True when `celiador.daemonUrl` is set, i.e. the extension was redirected by hand. */
  overridden: boolean;
  /** The daemon's own answer, or undefined when it could not be reached. */
  health?: DaemonHealth;
  /** Why the daemon could not be reached, when `health` is undefined. */
  healthError?: string;
}

export interface EnvironmentDescription {
  env: Environment;
  /** Status bar text without the icon. */
  label: string;
  /** ok = prod and consistent; warning = any non-prod environment; error = clients disagree. */
  severity: 'ok' | 'warning' | 'error';
  /** Tooltip lines, Markdown. */
  lines: string[];
  /** One line for the clipboard / an issue. */
  summary: string;
  /** Problems worth the error colour, in plain words. */
  problems: string[];
}

/** celiador.ai → prod, test.celiador.ai → test, dev.celiador.ai → dev, loopback → local, else custom. */
export function environmentForUrl(url: string): Environment {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'custom';
  }
  switch (host) {
    case 'celiador.ai':
    case 'www.celiador.ai':
      return 'prod';
    case 'test.celiador.ai':
      return 'test';
    case 'dev.celiador.ai':
      return 'dev';
    case 'localhost':
    case '127.0.0.1':
    case '::1':
    case '[::1]':
      return 'local';
    default:
      return 'custom';
  }
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return url;
  }
}

function shortCommit(commit: string | undefined): string | undefined {
  return commit ? commit.slice(0, 7) : undefined;
}

/**
 * Work out the environment and how to present it. The daemon's own `env` wins
 * over the host-name guess when it answers; the host name stands in until then.
 */
export function describeEnvironment(input: EnvironmentInput): EnvironmentDescription {
  const extensionEnv = environmentForUrl(input.extensionDaemonUrl);
  const nativeEnv = environmentForUrl(input.nativeDaemonUrl);
  const reported = input.health?.env;
  const env: Environment = reported && isEnvironment(reported) ? reported : extensionEnv;
  const problems: string[] = [];

  if (input.overridden && input.extensionDaemonUrl !== input.nativeDaemonUrl) {
    problems.push(
      `Split: the celiador.daemonUrl setting sends sign-in and account calls to ${hostOf(input.extensionDaemonUrl)}, ` +
      `but agent runs, the relay and presence still use this build's ${hostOf(input.nativeDaemonUrl)}.`
    );
  }
  // A local or custom host can legitimately run any env; only the named hosts must match.
  if (reported && (extensionEnv === 'prod' || extensionEnv === 'test' || extensionEnv === 'dev') && reported !== extensionEnv) {
    problems.push(`The daemon at ${hostOf(input.extensionDaemonUrl)} reports env "${reported}", not "${extensionEnv}".`);
  }
  if (input.build.channel && input.build.channel !== nativeEnv && nativeEnv !== 'custom') {
    problems.push(`This is a ${input.build.channel} build but its daemon URL points at ${nativeEnv}.`);
  }

  const severity: EnvironmentDescription['severity'] =
    problems.length > 0 ? 'error' : env === 'prod' ? 'ok' : 'warning';

  const label = env === 'prod' ? 'prod' : env.toUpperCase();

  const buildBits = [
    input.build.name ?? 'Celiador',
    input.build.version,
    input.build.build !== undefined ? `build ${input.build.build}` : undefined,
    shortCommit(input.build.commit) ?? 'source build',
  ].filter(Boolean);
  const daemonBits = [
    hostOf(input.extensionDaemonUrl),
    input.health?.version ? `v${input.health.version}` : undefined,
    shortCommit(input.health?.commit),
  ].filter(Boolean);

  const lines: string[] = [];
  lines.push(`**Celiador environment: ${label}**`);
  lines.push(`Build: ${buildBits.join(' · ')}${input.build.channel ? ` (${input.build.channel} channel)` : ''}`);
  if (input.health) {
    lines.push(`Daemon: ${daemonBits.join(' · ')} — reports env \`${reported ?? '?'}\``);
  } else {
    lines.push(`Daemon: ${hostOf(input.extensionDaemonUrl)} — unreachable${input.healthError ? ` (${input.healthError})` : ''}`);
  }
  if (input.overridden) {
    lines.push('Daemon URL comes from the `celiador.daemonUrl` setting, not this build.');
  }
  for (const problem of problems) {
    lines.push(`⚠ ${problem}`);
  }
  lines.push('Click for details, copy or settings.');

  const summary = [
    `Celiador ${label}`,
    buildBits.join(' '),
    `daemon ${daemonBits.join(' ')}`,
    reported ? `env=${reported}` : 'daemon unreachable',
    input.overridden ? 'daemonUrl overridden' : undefined,
  ].filter(Boolean).join(' · ');

  return { env, label, severity, lines, summary, problems };
}

function isEnvironment(value: string): value is Environment {
  return value === 'prod' || value === 'test' || value === 'dev' || value === 'local' || value === 'custom';
}
