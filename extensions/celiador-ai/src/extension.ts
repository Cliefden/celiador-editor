import * as vscode from "vscode";
import { Auth } from "./auth";
import { CeliadorChatProvider, VENDOR } from "./provider";

/**
 * Celiador's AI layer.
 *
 * This extension used to carry its own chat webview, agent loop and file
 * tools. It no longer does — it registers Celiador as a language model and
 * lets VS Code's chat, agent mode, inline edit and diff review run on it.
 * What is left here is identity: sign-in, the account status bar, and the
 * deep link that completes an OAuth or magic-link round trip.
 */

let secretStore: vscode.SecretStorage | undefined;
let auth: Auth | undefined;

function daemonUrl(): string {
  const cfg = vscode.workspace.getConfiguration("celiador");
  return (cfg.get<string>("daemonUrl") || "https://celiador.ai").replace(/\/+$/, "");
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

/** GET /api/me — identity, plan and what is left. */
async function fetchMe(): Promise<{ balance: Balance } | undefined> {
  if (!auth) return undefined;
  const cfg = vscode.workspace.getConfiguration("celiador");
  const bearer = (await auth.isSignedIn()) ? await auth.getAccessToken() : cfg.get<string>("token") || "";
  if (!bearer) return undefined;
  try {
    const res = await fetch(`${daemonUrl()}/api/me`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (!res.ok) return undefined;
    return (await res.json()) as { balance: Balance };
  } catch {
    return undefined;
  }
}

/** Open a Stripe Checkout or Customer Portal session in the browser. */
async function openBilling(path: "checkout" | "portal", body: Record<string, unknown>): Promise<void> {
  if (!auth) return;
  const cfg = vscode.workspace.getConfiguration("celiador");
  const bearer = (await auth.isSignedIn()) ? await auth.getAccessToken() : cfg.get<string>("token") || "";
  if (!bearer) {
    void vscode.window.showWarningMessage("Sign in to Celiador first.");
    return;
  }
  try {
    const res = await fetch(`${daemonUrl()}/api/billing/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await res.json()) as { url?: string; error?: string };
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
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = vscode.workspace.getConfiguration("celiador").get<string>("token");
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/health`, { headers });
  if (!res.ok) throw new Error(`/api/health → HTTP ${res.status}`);
  const health: any = await res.json();
  return `Connected to ${url} (status: ${health?.status ?? health?.ok ?? "ok"}).`;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log("[celiador-ai] activated");
  secretStore = context.secrets;
  auth = new Auth(context.secrets);

  // Remaining balance, kept visible rather than discovered at the moment of
  // refusal — the live spend meter that replaced quote-before-run.
  const balanceStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  balanceStatus.command = "celiador.manageBilling";
  const refreshBalance = async () => {
    const me = await fetchMe();
    if (!me) {
      balanceStatus.hide();
      return;
    }
    const { balance } = me;
    balanceStatus.text = `$(credit-card) $${balance.remainingUsd.toFixed(2)}`;
    balanceStatus.tooltip =
      `Celiador ${balance.planLabel} — $${balance.remainingUsd.toFixed(2)} left ` +
      `($${balance.spentUsd.toFixed(2)} of $${balance.includedUsd.toFixed(2)} included this period` +
      `${balance.topUpUsd > 0 ? `, plus $${balance.topUpUsd.toFixed(2)} credits` : ""}).\nClick to manage billing.`;
    balanceStatus.show();
  };
  context.subscriptions.push(balanceStatus);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(
      VENDOR,
      new CeliadorChatProvider(auth, context.secrets, () => void refreshBalance())
    )
  );

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
      // Credit packs are configured server-side; ask for the plan checkout when
      // there is no subscription yet, since the portal needs a customer first.
      return void openBilling("checkout", me?.balance.plan === "free" ? { plan: "builder" } : {});
    })
  );

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
    vscode.commands.registerCommand("celiador.openChat", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.open");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("celiador.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "Anthropic API key for Celiador", password: true, ignoreFocusOut: true });
      if (key && key.trim()) {
        await secretStore?.store("celiador.apiKey", key.trim());
        void vscode.window.showInformationMessage("Celiador API key saved to the OS keychain.");
      }
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

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(sparkle) Celiador";
  status.tooltip = "Open Celiador chat";
  status.command = "celiador.openChat";
  status.show();
  context.subscriptions.push(status);

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
  context.subscriptions.push(
    authStatus,
    auth.onDidChange(() => {
      void updateAuthStatus();
      void refreshBalance();
    })
  );
  void updateAuthStatus();
  void refreshBalance();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is on context.subscriptions.
}
