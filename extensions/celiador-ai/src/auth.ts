import * as vscode from "vscode";
import { resolveDaemonUrl } from "./productConfig";

// Dependency-free Supabase/GoTrue client for the editor. Mirrors the native
// iOS/macOS client (apps/apple/Shared/Api.swift): password / signup / magic-link /
// GitHub OAuth / refresh, session stored in VS Code SecretStorage, access token
// refreshed just before expiry. The same session's access_token is sent to the
// daemon as `Authorization: Bearer` — the shared cross-client auth contract.

const SESSION_KEY = "celiador.session";
// VS Code routes deep links as celiador://<publisher>.<extension><path> to the
// extension's UriHandler. GoTrue's redirect allowlist must contain this exactly.
export const AUTH_REDIRECT = "celiador://celiador.celiador-ai/auth-callback";

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  email?: string;
}

/** Best-effort email from a JWT payload (no verification — display only). */
function jwtEmail(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/** How long a started magic-link / OAuth sign-in may take to come back. */
const PENDING_SIGNIN_MS = 30 * 60 * 1000;

export class Auth {
  private cached: Session | null | undefined;
  /** In-flight refresh, shared so concurrent 401s don't rotate the refresh token twice. */
  private refreshing: Promise<Session> | undefined;
  /**
   * When this editor last started a magic-link / GitHub sign-in. A callback deep
   * link is only accepted while one is pending — otherwise any page could open
   * celiador://…/auth-callback#access_token=… and silently swap the account.
   */
  private pendingSignInAt = 0;
  private supaConfig: { base: string; anonKey: string } | undefined;
  private readonly onChange = new vscode.EventEmitter<void>();
  /** Fires whenever the signed-in state changes (sign in/out/refresh). */
  readonly onDidChange = this.onChange.event;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  private daemonUrl(): string {
    return resolveDaemonUrl();
  }

  /** Resolve the Supabase base URL + anon key (setting override → /api/config). */
  private async supa(): Promise<{ base: string; anonKey: string }> {
    if (this.supaConfig) return this.supaConfig;
    const override = vscode.workspace.getConfiguration("celiador").get<string>("supabaseUrl");
    let cfg: any = {};
    try {
      const res = await fetch(`${this.daemonUrl()}/api/config`, { headers: { Accept: "application/json" } });
      if (res.ok) cfg = await res.json();
    } catch {
      /* fall back to daemon URL */
    }
    const base = (override || cfg.supabaseUrl || this.daemonUrl()).replace(/\/+$/, "");
    this.supaConfig = { base, anonKey: cfg.supabaseAnonKey || "" };
    return this.supaConfig;
  }

  private async gotrue(pathAndQuery: string, body: unknown): Promise<any> {
    const { base, anonKey } = await this.supa();
    const res = await fetch(`${base}/auth/v1/${pathAndQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error_description || data?.msg || data?.error || `HTTP ${res.status}`);
    }
    return data;
  }

  private toSession(data: any): Session {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at) || now + Number(data.expires_in || 3600),
      email: data.user?.email || data.email || jwtEmail(data.access_token),
    };
  }

  // ---- sign-in methods ------------------------------------------------------

  async signInWithPassword(email: string, password: string): Promise<void> {
    await this.store(this.toSession(await this.gotrue("token?grant_type=password", { email, password })));
  }

  async signUp(email: string, password: string): Promise<boolean> {
    const data = await this.gotrue("signup", { email, password });
    if (data.access_token) {
      await this.store(this.toSession(data));
      return true; // email confirmation disabled → immediate session
    }
    return false; // confirmation email sent; user must confirm
  }

  async sendMagicLink(email: string): Promise<void> {
    const { base, anonKey } = await this.supa();
    this.pendingSignInAt = Date.now();
    const url = `${base}/auth/v1/otp?redirect_to=${encodeURIComponent(AUTH_REDIRECT)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ email, create_user: true }),
    });
    if (!res.ok) {
      const d: any = await res.json().catch(() => ({}));
      throw new Error(d?.msg || d?.error_description || `HTTP ${res.status}`);
    }
  }

  async signInWithGitHub(): Promise<void> {
    const { base } = await this.supa();
    const url = `${base}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(AUTH_REDIRECT)}`;
    this.pendingSignInAt = Date.now();
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Handle celiador://auth-callback — tokens arrive in the fragment (implicit flow). */
  async handleCallback(uri: vscode.Uri): Promise<boolean> {
    const params = new URLSearchParams(uri.fragment || uri.query);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (!access_token || !refresh_token) return false;
    if (Date.now() - this.pendingSignInAt > PENDING_SIGNIN_MS) {
      // Not started here (or long expired) — possible login CSRF. Ask before switching.
      const email = jwtEmail(access_token) ?? "an unknown account";
      const pick = await vscode.window.showWarningMessage(
        `A sign-in link wants to sign this editor in as ${email}. You didn't start a sign-in here recently.`,
        { modal: true },
        "Sign In"
      );
      if (pick !== "Sign In") return false;
    }
    this.pendingSignInAt = 0;
    const now = Math.floor(Date.now() / 1000);
    await this.store({
      access_token,
      refresh_token,
      expires_at: Number(params.get("expires_at")) || now + Number(params.get("expires_in") || 3600),
      email: jwtEmail(access_token),
    });
    return true;
  }

  // ---- session state --------------------------------------------------------

  private async store(s: Session): Promise<void> {
    this.cached = s;
    await this.secrets.store(SESSION_KEY, JSON.stringify(s));
    this.onChange.fire();
  }

  private async load(): Promise<Session | null> {
    if (this.cached !== undefined) return this.cached;
    const raw = await this.secrets.get(SESSION_KEY);
    this.cached = raw ? (JSON.parse(raw) as Session) : null;
    return this.cached;
  }

  async signOut(): Promise<void> {
    this.cached = null;
    await this.secrets.delete(SESSION_KEY);
    this.onChange.fire();
  }

  async isSignedIn(): Promise<boolean> {
    return !!(await this.load());
  }

  async currentEmail(): Promise<string | undefined> {
    return (await this.load())?.email;
  }

  private refresh(s: Session): Promise<Session> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const next = this.toSession(await this.gotrue("token?grant_type=refresh_token", { refresh_token: s.refresh_token }));
        await this.store(next);
        return next;
      })().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  /** Force a refresh (used after a daemon 401). Returns false if not signed in. */
  async tryRefresh(): Promise<boolean> {
    const s = await this.load();
    if (!s) return false;
    try {
      await this.refresh(s);
      return true;
    } catch {
      return false;
    }
  }

  /** A valid access token, refreshing within 60s of expiry. Throws if signed out. */
  async getAccessToken(): Promise<string> {
    let s = await this.load();
    if (!s) throw new Error("Not signed in.");
    if (s.expires_at - Math.floor(Date.now() / 1000) < 60) {
      s = await this.refresh(s);
    }
    return s.access_token;
  }
}
