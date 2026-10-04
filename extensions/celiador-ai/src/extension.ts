import * as vscode from "vscode";
import { Auth } from "./auth";
import { registerCeliadorAuthProvider } from "./authProvider";
import { CeliadorChangesViewProvider } from "./changesView";
import { DaemonApi } from "./api";
import { resolveDaemonUrl } from "./productConfig";

// The agent itself is the native Agents Window (Claude Agent SDK), routed through the
// daemon's first-party gateway. This extension is the thin identity + companion shell:
// it owns Celiador sign-in, exposes the Supabase session as a VS Code authentication
// provider (so the agent host can resolve a daemon token), surfaces a git-review
// "Changes" view, and serves account/history commands. The former in-extension 3-tool
// agent loop, BYO-key path, Jev, and chat webview were retired in favour of the
// agentHost + the daemon relay bridge (src/vs/workbench/.../agentHost).

let auth: Auth | undefined;

function daemonUrl(): string {
  return resolveDaemonUrl();
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
