import * as vscode from "vscode";
import { Auth } from "./auth";
import type { DaemonApi, Me } from "./api";

/**
 * The Celiador welcome/account pane — always visible in the Celiador sidebar.
 *
 * It exists so the signed-out state is never a silent dead end: the native Agents
 * Window gets its models from the daemon, which needs a Celiador sign-in, so when
 * you're signed out this pane invites you in (rather than the chat just spinning).
 *
 * Signed in, it is the account surface: plan, today's agent usage against quota,
 * one-click into the Agents Window, and account management (sign out, delete).
 */
export class CeliadorWelcomeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "celiador.welcome";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly auth: Auth, private readonly api: DaemonApi) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case "signIn": void vscode.commands.executeCommand("celiador.signIn"); break;
        case "openAgents": void this.openAgentsWindow(); break;
        case "pastChats": void vscode.commands.executeCommand("celiador.pastChats"); break;
        case "signOut": void vscode.commands.executeCommand("celiador.signOut"); break;
        case "deleteAccount": void vscode.commands.executeCommand("celiador.deleteAccount"); break;
        case "refresh": void this.render(); break;
      }
    });

    const sub = this.auth.onDidChange(() => void this.render());
    webviewView.onDidDispose(() => sub.dispose());
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void this.render();
    });
    void this.render();
  }

  /** Push sign-in state (fast), then the usage summary (a daemon round-trip) when signed in. */
  private async render(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const signedIn = await this.auth.isSignedIn();
    const email = signedIn ? await this.auth.currentEmail() : undefined;
    if (this.view !== view) return;
    view.webview.postMessage({ type: "state", signedIn, email });
    if (!signedIn) return;
    let me: Me | null = null;
    try {
      me = await this.api.getMe();
    } catch {
      me = null; // daemon unreachable or endpoint absent — panel shows "usage unavailable"
    }
    if (this.view !== view) return;
    view.webview.postMessage({ type: "usage", me });
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
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 10px; line-height: 1.5; }
  .hidden { display: none; }
  .card { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 6px; padding: 10px 12px; margin: 0 0 14px; }
  .card h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); margin: 0 0 8px; font-weight: 600; }
  .meter { margin-bottom: 10px; }
  .meter:last-child { margin-bottom: 0; }
  .meter .label { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .meter .label .k { color: var(--vscode-foreground); }
  .meter .label .v { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .track { height: 5px; border-radius: 3px; background: var(--vscode-progressBar-background, rgba(128,128,128,0.25)); opacity: .5; overflow: hidden; }
  .fill { height: 100%; background: var(--vscode-textLink-foreground); border-radius: 3px; width: 0; }
  .fill.warn { background: var(--vscode-editorWarning-foreground, #cca700); }
  .plan { display: flex; justify-content: space-between; margin-bottom: 12px; }
  .plan .k { color: var(--vscode-descriptionForeground); }
  .plan .v { color: var(--vscode-foreground); font-weight: 600; }
  .resets { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
  .links { font-size: 11px; margin-top: 12px; }
  .links a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  .links .danger { color: var(--vscode-errorForeground); }
  .sep { color: var(--vscode-descriptionForeground); margin: 0 6px; }
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
    <p>Signed in as <span class="email" id="email"></span>.</p>

    <div class="plan"><span class="k">Plan</span><span class="v" id="plan">—</span></div>

    <div class="card">
      <h3>Usage today</h3>
      <div id="meters"><p id="usageMsg" style="margin:0">Loading usage…</p></div>
      <div class="resets hidden" id="resets"></div>
    </div>

    <button id="open">Open Agents Window</button>
    <button class="secondary" id="chats">Past Chats</button>

    <div class="hint">Your agent runs on this machine; Celiador's server only relays the model calls and meters usage — your code isn't stored on it.</div>

    <div class="links">
      <a id="signout" href="#">Sign out</a>
      <span class="sep">·</span>
      <a id="delete" class="danger" href="#">Delete account</a>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const out = document.getElementById('out');
    const inn = document.getElementById('in');
    const email = document.getElementById('email');
    const planEl = document.getElementById('plan');
    const meters = document.getElementById('meters');
    const usageMsg = document.getElementById('usageMsg');
    const resetsEl = document.getElementById('resets');
    const send = (type) => vscode.postMessage({ type });
    document.getElementById('signin').onclick = () => send('signIn');
    document.getElementById('open').onclick = () => send('openAgents');
    document.getElementById('chats').onclick = () => send('pastChats');
    document.getElementById('signout').onclick = (e) => { e.preventDefault(); send('signOut'); };
    document.getElementById('delete').onclick = (e) => { e.preventDefault(); send('deleteAccount'); };

    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

    function meter(label, used, limit) {
      const unlimited = !limit || limit <= 0;
      const pct = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 100));
      const value = unlimited ? compact.format(used) + ' · no limit' : compact.format(used) + ' / ' + compact.format(limit);
      const warn = pct >= 80 ? ' warn' : '';
      const width = unlimited ? 0 : pct;
      return '<div class="meter"><div class="label"><span class="k">' + label + '</span>' +
        '<span class="v">' + value + '</span></div>' +
        '<div class="track"><div class="fill' + warn + '" style="width:' + width + '%"></div></div></div>';
    }

    function renderUsage(me) {
      if (!me) {
        meters.innerHTML = '';
        usageMsg.textContent = 'Usage is unavailable right now.';
        meters.appendChild(usageMsg);
        resetsEl.classList.add('hidden');
        planEl.textContent = '—';
        return;
      }
      planEl.textContent = me.plan ? me.plan.charAt(0).toUpperCase() + me.plan.slice(1) : 'Local';
      const u = me.usage, l = me.limits;
      meters.innerHTML =
        meter('Requests', u.requests, l.dailyRequests) +
        meter('Input tokens', u.inputTokens, l.dailyInput) +
        meter('Output tokens', u.outputTokens, l.dailyOutput);
      if (me.resetsAt) {
        const ms = Date.parse(me.resetsAt) - Date.now();
        if (ms > 0) {
          const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
          resetsEl.textContent = 'Resets in ' + (h > 0 ? h + 'h ' : '') + m + 'm';
          resetsEl.classList.remove('hidden');
        } else {
          resetsEl.classList.add('hidden');
        }
      }
    }

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'state') {
        out.classList.toggle('hidden', m.signedIn);
        inn.classList.toggle('hidden', !m.signedIn);
        email.textContent = m.email || 'your account';
        if (m.signedIn) {
          meters.innerHTML = '';
          usageMsg.textContent = 'Loading usage…';
          meters.appendChild(usageMsg);
          resetsEl.classList.add('hidden');
        }
      } else if (m.type === 'usage') {
        renderUsage(m.me);
      }
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
