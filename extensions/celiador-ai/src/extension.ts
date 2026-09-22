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

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, new CeliadorChatProvider(auth, context.secrets))
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
  context.subscriptions.push(authStatus, auth.onDidChange(() => void updateAuthStatus()));
  void updateAuthStatus();
}

export function deactivate(): void {
  // Nothing to tear down: every disposable is on context.subscriptions.
}
