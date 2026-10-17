/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { Auth } from './auth';

/**
 * A VS Code authentication provider that exposes the extension's Supabase session
 * (managed by {@link Auth}) to the rest of the workbench. Its only consumer today
 * is the native Agents Window: the Claude agent advertises a `celiador-daemon`
 * protected resource whose authorization server is the daemon URL, and the agent
 * host auth machinery resolves a session from THIS provider (matched by
 * `authorizationServerGlobs` in package.json) and forwards the access token to the
 * daemon transport. Sign-in/out/refresh flow through `onDidChangeSessions` so the
 * token is re-forwarded automatically.
 *
 * Sign-in itself still happens through the extension's existing UI
 * (`celiador.signIn`); this provider only surfaces the resulting session.
 */

export const CELIADOR_AUTH_PROVIDER_ID = 'celiador';
const CELIADOR_AUTH_PROVIDER_LABEL = 'Celiador';
const SESSION_ID = 'celiador-supabase-session';
/** Context key for `when` clauses (e.g. the Get Started walkthrough's sign-in step). */
const SIGNED_IN_CONTEXT_KEY = 'celiador.signedIn';

export class CeliadorAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _sub: vscode.Disposable;
	/** Last session handed out, so a sign-out can report it as `removed`. */
	private _lastSession: vscode.AuthenticationSession | undefined;

	constructor(private readonly auth: Auth) {
		// Translate the extension's own sign-in/out/refresh into provider session
		// change events so the workbench re-resolves and re-forwards the token.
		this._sub = this.auth.onDidChange(() => { void this._fireChange(); });
		void this.auth.isSignedIn().then((signedIn) => this._setSignedInContext(signedIn));
	}

	private _setSignedInContext(signedIn: boolean): void {
		void vscode.commands.executeCommand('setContext', SIGNED_IN_CONTEXT_KEY, signedIn);
	}

	private async _fireChange(): Promise<void> {
		const previous = this._lastSession;
		const sessions = await this.getSessions();
		const current = sessions[0];
		this._setSignedInContext(!!current);
		if (current && !previous) {
			this._onDidChangeSessions.fire({ added: [current], removed: [], changed: [] });
		} else if (!current && previous) {
			this._onDidChangeSessions.fire({ added: [], removed: [previous], changed: [] });
		} else if (current) {
			// Token rotated on the same account (refresh).
			this._onDidChangeSessions.fire({ added: [], removed: [], changed: [current] });
		}
	}

	async getSessions(_scopes?: readonly string[]): Promise<vscode.AuthenticationSession[]> {
		if (!(await this.auth.isSignedIn())) {
			this._lastSession = undefined;
			return [];
		}
		let accessToken: string;
		try {
			accessToken = await this.auth.getAccessToken();
		} catch {
			this._lastSession = undefined;
			return [];
		}
		const email = (await this.auth.currentEmail()) ?? 'Celiador account';
		const session: vscode.AuthenticationSession = {
			id: SESSION_ID,
			accessToken,
			account: { id: email, label: email },
			scopes: [],
		};
		this._lastSession = session;
		return [session];
	}

	async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		if (!(await this.auth.isSignedIn())) {
			await vscode.commands.executeCommand('celiador.signIn');
			await this._waitForSignIn(120_000);
		}
		const sessions = await this.getSessions(_scopes);
		if (sessions.length === 0) {
			throw new Error('Celiador sign-in was not completed.');
		}
		return sessions[0];
	}

	async removeSession(_sessionId: string): Promise<void> {
		await this.auth.signOut();
	}

	/** Resolve once the user is signed in, or after `timeoutMs` regardless. */
	private _waitForSignIn(timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) { return; }
				settled = true;
				sub.dispose();
				clearTimeout(timer);
				resolve();
			};
			const sub = this.auth.onDidChange(() => {
				void this.auth.isSignedIn().then((signedIn) => { if (signedIn) { finish(); } });
			});
			const timer = setTimeout(finish, timeoutMs);
		});
	}

	dispose(): void {
		this._sub.dispose();
		this._onDidChangeSessions.dispose();
	}
}

/**
 * Register the Celiador authentication provider; returns a disposable.
 *
 * `supportedAuthorizationServers` is what lets the workbench match this provider
 * to the agent's protected resource (whose authorization server is the daemon
 * URL). The `authorizationServerGlobs` in package.json only drive activation of a
 * not-yet-registered provider; once registered, matching uses this list alone.
 */
export function registerCeliadorAuthProvider(auth: Auth, daemonUrl: string): vscode.Disposable {
	const provider = new CeliadorAuthProvider(auth);
	const registration = vscode.authentication.registerAuthenticationProvider(
		CELIADOR_AUTH_PROVIDER_ID,
		CELIADOR_AUTH_PROVIDER_LABEL,
		provider,
		{ supportsMultipleAccounts: false, supportedAuthorizationServers: [vscode.Uri.parse(daemonUrl)] },
	);
	return vscode.Disposable.from(registration, provider);
}
