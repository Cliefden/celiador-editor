import * as vscode from "vscode";
import { Auth } from "./auth";
import { registerCeliadorAuthProvider } from "./authProvider";
import { CeliadorChangesViewProvider } from "./changesView";
import { CeliadorWelcomeViewProvider } from "./welcomeView";
import { DaemonApi } from "./api";
import { resolveDaemonUrl } from "./productConfig";

// The agent itself is the native Agents Window (Claude Agent SDK), routed through the
// daemon's first-party gateway. This extension is the thin identity + companion shell:
// it owns Celiador sign-in and the balance/billing surface, exposes the Supabase session as a VS Code authentication
// provider (so the agent host can resolve a daemon token), surfaces a git-review
// "Changes" view, and serves account/history commands. The former in-extension 3-tool
// agent loop, BYO-key path, Jev, and chat webview were retired in favour of the
// agentHost + the daemon relay bridge (src/vs/workbench/.../agentHost).

let auth: Auth | undefined;

function daemonUrl(): string {
  return resolveDaemonUrl();
}

interface Balance {
  plan: string;
  planLabel: string;
  includedUsd: number;
  spentUsd: number;
  topUpUsd: number;
  remainingUsd: number;
  period: string;
}

/** GET /api/me — identity, plan and what is left. Undefined when signed out or unreachable. */
async function fetchMe(): Promise<{ balance: Balance } | undefined> {
  if (!auth || !(await auth.isSignedIn())) return undefined;
  try {
    const res = await fetch(`${daemonUrl()}/api/me`, { headers: { Authorization: `Bearer ${await auth.getAccessToken()}` } });
    if (!res.ok) return undefined;
    return (await res.json()) as { balance: Balance };
  } catch {
    return undefined;
  }
}

/** Open a Stripe Checkout or Customer Portal session in the browser. */
async function openBilling(path: "checkout" | "portal", body: Record<string, unknown>): Promise<void> {
  if (!auth || !(await auth.isSignedIn())) {
    void vscode.window.showWarningMessage("Sign in to Celiador first.");
    return;
  }
  try {
    const res = await fetch(`${daemonUrl()}/api/billing/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await auth.getAccessToken()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !payload.url) {
      void vscode.window.showErrorMessage(`Billing unavailable: ${payload.error ?? res.status}`);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(payload.url));
  } catch (err: any) {
    void vscode.window.showErrorMessage(`Billing unavailable: ${err?.message ?? err}`);
  }
}

async function probeDaemon(): Promise<string> {
  const url = daemonUrl();
  const res = await fetch(`${url}/api/health`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
  const health: any = await res.json();
  return `Connected to ${url} (status: ${health?.status ?? health?.ok ?? "ok"}).`;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log("[celiador-ai] activated");
  auth = new Auth(context.secrets);

  // Welcome/account pane — always visible so the signed-out state invites sign-in
  // (the Agents Window needs a Celiador token) instead of silently waiting.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CeliadorWelcomeViewProvider.viewId, new CeliadorWelcomeViewProvider(auth))
  );

  // Git-review "Changes" view in the Celiador sidebar.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CeliadorChangesViewProvider.viewId, new CeliadorChangesViewProvider())
  );

  // Expose the Supabase session as a VS Code authentication provider so the native
  // Agents Window can resolve a token for the daemon's `celiador-daemon` resource and
  // route the Claude agent through the daemon.
  context.subscriptions.push(registerCeliadorAuthProvider(auth));

  // Capture the Supabase OAuth / magic-link deep link (celiador://…/auth-callback).
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (!auth) return;
        if (await auth.handleCallback(uri)) {
          void vscode.window.showInformationMessage(`Signed in to Celiador as ${(await auth.currentEmail()) ?? "your account"}.`);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.signIn", async () => {
      if (!auth) return;
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Sign in — email & password", id: "password" },
          { label: "Create account — email & password", id: "signup" },
          { label: "Magic link (email)", id: "magic" },
          { label: "GitHub", id: "github" },
        ],
        { placeHolder: "Sign in to Celiador" }
      );
      if (!pick) return;
      try {
        if (pick.id === "github") { await auth.signInWithGitHub(); return; }
        const email = (await vscode.window.showInputBox({ prompt: "Email", ignoreFocusOut: true }))?.trim();
        if (!email) return;
        if (pick.id === "magic") {
          await auth.sendMagicLink(email);
          void vscode.window.showInformationMessage("Magic link sent — open the link in your email to finish signing in.");
          return;
        }
        const password = await vscode.window.showInputBox({ prompt: "Password", password: true, ignoreFocusOut: true });
        if (!password) return;
        if (pick.id === "signup") {
          const active = await auth.signUp(email, password);
          void vscode.window.showInformationMessage(active ? "Account created and signed in." : "Account created — confirm via the email we sent, then sign in.");
        } else {
          await auth.signInWithPassword(email, password);
          void vscode.window.showInformationMessage(`Signed in as ${email}.`);
        }
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Sign-in failed: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.signOut", async () => {
      await auth?.signOut();
      void vscode.window.showInformationMessage("Signed out of Celiador.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.checkConnection", async () => {
      try { void vscode.window.showInformationMessage(await probeDaemon()); }
      catch (err: any) { void vscode.window.showErrorMessage(`Celiador daemon unreachable: ${err?.message ?? err}`); }
    })
  );

  // App data (profile + chat history) served by the daemon over the shared JWT.
  const api = new DaemonApi(auth, () => daemonUrl());

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.account", async () => {
      if (!auth || !(await auth.isSignedIn())) {
        void vscode.window.showInformationMessage("Not signed in. Run “Celiador: Sign In”.");
        return;
      }
      try {
        const p = await api.getProfile();
        void vscode.window.showInformationMessage(
          `Celiador — ${p.display_name ?? p.email ?? p.id} · plan: ${p.plan}`
        );
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't load your profile: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.pastChats", async () => {
      if (!auth || !(await auth.isSignedIn())) {
        void vscode.window.showInformationMessage("Sign in to see your Celiador chat history.");
        return;
      }
      try {
        const chats = await api.listChats();
        if (chats.length === 0) {
          void vscode.window.showInformationMessage("No past chats yet.");
          return;
        }
        const pick = await vscode.window.showQuickPick(
          chats.map((c) => ({
            label: c.title || "Untitled task",
            description: new Date(c.updated_at).toLocaleString(),
            detail: c.status,
            id: c.id,
          })),
          { placeHolder: "Open a past Celiador chat" }
        );
        if (!pick) return;
        const { chat, messages } = await api.getChat(pick.id);
        const body = messages
          .map((m) => `### ${m.role}\n\n${(m.content as { text?: string })?.text ?? ""}`)
          .join("\n\n");
        const doc = await vscode.workspace.openTextDocument({
          language: "markdown",
          content: `# ${chat.title ?? "Chat"}\n\n${body || "_No messages._"}`,
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err: any) {
        void vscode.window.showErrorMessage(`Couldn't load chats: ${err?.message ?? err}`);
      }
    })
  );

  // Balance status item — what's left this period; click to top up or change plan.
  const balanceStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  balanceStatus.command = "celiador.manageBilling";
  const refreshBalance = async () => {
    const me = await fetchMe();
    if (!me) {
      balanceStatus.hide();
      return;
    }
    const balance = me.balance;
    balanceStatus.text = `$(sparkle) $${balance.remainingUsd.toFixed(2)}`;
    balanceStatus.tooltip =
      `Celiador ${balance.planLabel} — $${balance.remainingUsd.toFixed(2)} left ` +
      `($${balance.spentUsd.toFixed(2)} of $${balance.includedUsd.toFixed(2)} included this period` +
      `${balance.topUpUsd > 0 ? `, plus $${balance.topUpUsd.toFixed(2)} credits` : ""}).\nClick to manage billing.`;
    balanceStatus.show();
  };
  context.subscriptions.push(balanceStatus, auth.onDidChange(() => void refreshBalance()));
  void refreshBalance();

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.manageBilling", async () => {
      const me = await fetchMe();
      const pick = await vscode.window.showQuickPick(
        [
          { label: "Add credits", id: "credits", detail: "One-off top-up — no subscription change" },
          { label: "Change plan", id: "plan", detail: "Upgrade, downgrade or cancel" },
          { label: "Refresh balance", id: "refresh" },
        ],
        { placeHolder: me ? `${me.balance.planLabel} — $${me.balance.remainingUsd.toFixed(2)} left` : "Celiador billing" }
      );
      if (!pick) return;
      if (pick.id === "refresh") return void refreshBalance();
      if (pick.id === "plan") return void openBilling("portal", {});
      return void openBilling("checkout", me?.balance.plan === "free" ? { plan: "builder" } : {});
    })
  );

  // Account status item — reflects signed-in state.
  const authStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  const updateAuthStatus = async () => {
    const email = await auth?.currentEmail();
    if (email) {
      authStatus.text = `$(account) ${email}`;
      authStatus.tooltip = "Celiador account — click to sign out";
      authStatus.command = "celiador.signOut";
    } else {
      authStatus.text = "$(account) Sign in";
      authStatus.tooltip = "Sign in to Celiador";
      authStatus.command = "celiador.signIn";
    }
    authStatus.show();
  };
  context.subscriptions.push(authStatus, auth.onDidChange(() => void updateAuthStatus()));
  void updateAuthStatus();
}

export function deactivate(): void {
  /* no-op */
}
