import * as vscode from "vscode";
import { Auth } from "./auth";

/**
 * The Celiador welcome/account pane — always visible in the Celiador sidebar.
 *
 * It exists so the signed-out state is never a silent dead end: the native Agents
 * Window gets its models from the daemon, which needs a Celiador sign-in, so when
 * you're signed out this pane invites you in (rather than the chat just spinning).
 * Signed in, it greets your account and offers one-click into the Agents Window.
 */
export class CeliadorWelcomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "celiador.welcome";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly auth: Auth) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case "signIn": void vscode.commands.executeCommand("celiador.signIn"); break;
        case "openAgents": void this.openAgentsWindow(); break;
        case "account": void vscode.commands.executeCommand("celiador.account"); break;
        case "pastChats": void vscode.commands.executeCommand("celiador.pastChats"); break;
        case "signOut": void vscode.commands.executeCommand("celiador.signOut"); break;
      }
    });

    const sub = this.auth.onDidChange(() => void this.render());
    webviewView.onDidDispose(() => sub.dispose());
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.render();
    });
    void this.render();
  }

  /** Push the current sign-in state to the webview so it renders the right panel. */
  private async render(): Promise<void> {
    if (!this.view) return;
    const signedIn = await this.auth.isSignedIn();
    const email = signedIn ? await this.auth.currentEmail() : undefined;
    this.view.webview.postMessage({ type: "state", signedIn, email });
  }

  /** Open the native Agents Window; fall back to the command palette if unavailable. */
  private async openAgentsWindow(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.action.openAgentsWindow");
    } catch {
      void vscode.window.showInformationMessage("Open the Agents Window from the command palette (⌘⇧A).");
    }
  }

  private html(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { font: 13px var(--vscode-font-family); color: var(--vscode-foreground); padding: 14px 12px; margin: 0; }
  .brand { font-family: Georgia, "Times New Roman", serif; font-style: italic; font-size: 22px; color: var(--vscode-textLink-foreground); margin-bottom: 10px; }
  p { color: var(--vscode-descriptionForeground); line-height: 1.5; margin: 0 0 14px; }
  .email { color: var(--vscode-foreground); font-weight: 600; }
  button { display: block; width: 100%; box-sizing: border-box; font: inherit; text-align: center; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 7px 10px; border-radius: 4px; cursor: pointer; margin-bottom: 8px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 10px; }
  .row { display: flex; gap: 8px; }
  .row button { margin-bottom: 0; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="brand">Celiador</div>

  <div id="out" class="hidden">
    <p>Your agents, your account. Sign in to unlock the Celiador <strong>Agents Window</strong> — your chats, history, and devices in sync, with no API key to manage.</p>
    <button id="signin">Sign In to Celiador</button>
    <div class="hint">New here? Sign-in also lets you create an account — it's free to start.</div>
  </div>

  <div id="in" class="hidden">
    <p>Signed in as <span class="email" id="email"></span>. You're all set — your Celiador agents are ready.</p>
    <button id="open">Open Agents Window</button>
    <div class="row">
      <button class="secondary" id="account">Account</button>
      <button class="secondary" id="chats">Past Chats</button>
    </div>
    <div class="hint"><a id="signout" href="#" style="color:var(--vscode-textLink-foreground)">Sign out</a></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const out = document.getElementById('out');
    const inn = document.getElementById('in');
    const email = document.getElementById('email');
    const send = (type) => vscode.postMessage({ type });
    document.getElementById('signin').onclick = () => send('signIn');
    document.getElementById('open').onclick = () => send('openAgents');
    document.getElementById('account').onclick = () => send('account');
    document.getElementById('chats').onclick = () => send('pastChats');
    document.getElementById('signout').onclick = (e) => { e.preventDefault(); send('signOut'); };
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type !== 'state') return;
      out.classList.toggle('hidden', m.signedIn);
      inn.classList.toggle('hidden', !m.signedIn);
      email.textContent = m.email || 'your account';
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
