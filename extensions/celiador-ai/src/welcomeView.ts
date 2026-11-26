/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Auth } from './auth';
import type { DaemonApi, Me } from './api';
import { nonce as getNonce } from './agents/webview';

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
  public static readonly viewId = 'celiador.welcome';
  private view: vscode.WebviewView | undefined;

  constructor(private readonly auth: Auth, private readonly api: DaemonApi) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();

    webviewView.webview.onDidReceiveMessage((msg) => {
      switch (msg?.type) {
        case 'signIn': void vscode.commands.executeCommand('celiador.signIn'); break;
        case 'openAgents': void this.openAgentsWindow(); break;
        case 'pastChats': void vscode.commands.executeCommand('celiador.pastChats'); break;
        case 'signOut': void vscode.commands.executeCommand('celiador.signOut'); break;
        case 'deleteAccount': void vscode.commands.executeCommand('celiador.deleteAccount'); break;
        case 'refresh': void this.render(); break;
      }
    });

    const sub = this.auth.onDidChange(() => void this.render());
    webviewView.onDidDispose(() => sub.dispose());
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {void this.render();}
    });
    void this.render();
  }

  /** Push sign-in state (fast), then the usage summary (a daemon round-trip) when signed in. */
  private async render(): Promise<void> {
    const view = this.view;
    if (!view) {return;}
    const signedIn = await this.auth.isSignedIn();
    const email = signedIn ? await this.auth.currentEmail() : undefined;
    if (this.view !== view) {return;}
    view.webview.postMessage({ type: 'state', signedIn, email });
    if (!signedIn) {return;}
    let me: Me | null = null;
    try {
      me = await this.api.getMe();
    } catch {
      me = null; // daemon unreachable or endpoint absent — panel shows "usage unavailable"
    }
    if (this.view !== view) {return;}
    view.webview.postMessage({ type: 'usage', me });
  }

  /** Open the native Agents Window; fall back to the command palette if unavailable. */
  private async openAgentsWindow(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.openAgentsWindow');
    } catch {
      void vscode.window.showInformationMessage('Open the Agents Window from the command palette (⌘⇧A).');
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
  .fill.over { background: var(--vscode-errorForeground, #f14c4c); }
  .row { display: flex; justify-content: space-between; margin-bottom: 6px; }
  .row .v { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .bars { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 40px; margin-top: 10px; }
  .bars .bar { flex: 1; min-height: 1px; background: var(--vscode-textLink-foreground); border-radius: 2px 2px 0 0; }
  .bars .bar.idle { opacity: .3; }
  .bars .bar.warn { background: var(--vscode-editorWarning-foreground, #cca700); }
  .bars .budget { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--vscode-descriptionForeground); opacity: .6; }
  .barsAxis { display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
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

    <div class="card hidden" id="periodCard">
      <h3 id="periodTitle">This month</h3>
      <div id="period"></div>
      <div class="bars hidden" id="bars" role="img"></div>
      <div class="barsAxis hidden" id="barsAxis"></div>
      <div class="resets" id="periodNote"></div>
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

    const periodCard = document.getElementById('periodCard');
    const periodTitle = document.getElementById('periodTitle');
    const periodEl = document.getElementById('period');
    const barsEl = document.getElementById('bars');
    const barsAxis = document.getElementById('barsAxis');
    const periodNote = document.getElementById('periodNote');
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
    const count = (n) => compact.format(num(n));
    // "$0.38", or "<$0.01" under a cent so a cheap day never reads as free (as on iOS).
    const usd = (v) => { v = num(v); return v > 0 && v < 0.01 ? '<$0.01' : '$' + v.toFixed(2); };
    const tokens = (u) => count(u.inputTokens) + ' in · ' + count(u.outputTokens) + ' out';
    // Days are UTC dates (YYYY-MM-DD) from the daemon; shown in the user's locale.
    const dayLabel = (d, opts) => /^\\d{4}-\\d{2}-\\d{2}$/.test(d || '')
      ? new Date(d + 'T00:00:00Z').toLocaleDateString(undefined, Object.assign({ timeZone: 'UTC' }, opts))
      : '';

    function meter(label, used, limit, fmt) {
      fmt = fmt || count;
      const unlimited = !limit || limit <= 0;
      const ratio = unlimited ? 0 : num(used) / limit;
      const pct = Math.min(100, Math.round(ratio * 100));
      const value = unlimited ? fmt(used) + ' · no limit' : fmt(used) + ' / ' + fmt(limit);
      const state = ratio >= 1 ? ' over' : pct >= 80 ? ' warn' : '';
      const width = unlimited ? 0 : pct;
      return '<div class="meter"><div class="label"><span class="k">' + label + '</span>' +
        '<span class="v">' + value + '</span></div>' +
        '<div class="track"><div class="fill' + state + '" style="width:' + width + '%"></div></div></div>';
    }

    function row(label, value) {
      return '<div class="row"><span class="k">' + label + '</span><span class="v">' + value + '</span></div>';
    }

    /** The month so far + the last days' spend as bars (oldest left), scaled to the daily budget. */
    function renderPeriod(me) {
      const p = me && me.period;
      if (!p || !p.usage) { periodCard.classList.add('hidden'); return; }
      periodCard.classList.remove('hidden');
      const month = dayLabel(p.from, { month: 'long' });
      periodTitle.textContent = month ? month + ' so far' : 'This month';
      periodEl.innerHTML = row('Agent spend', usd(p.usage.costUsd)) + row('Requests', count(p.usage.requests)) + row('Tokens', tokens(p.usage));
      const days = Array.isArray(me.history) ? me.history.slice().reverse() : [];
      const budget = num(me.limits && me.limits.dailyUsd);
      if (days.length) {
        const peak = Math.max(budget, ...days.map((d) => num(d.usage && d.usage.costUsd)));
        let html = '';
        for (const d of days) {
          const c = num(d.usage && d.usage.costUsd);
          const h = peak > 0 && c > 0 ? Math.max(2, Math.round(40 * c / peak)) : 1;
          const cls = c <= 0 ? ' idle' : budget > 0 && c >= budget ? ' warn' : '';
          html += '<div class="bar' + cls + '" style="height:' + h + 'px" title="' + dayLabel(d.day, { month: 'short', day: 'numeric' }) + ': ' + usd(c) + '"></div>';
        }
        if (budget > 0 && peak > 0) {
          html += '<div class="budget" style="bottom:' + Math.round(40 * budget / peak) + 'px"></div>';
        }
        barsEl.innerHTML = html;
        barsEl.setAttribute('aria-label', 'Agent spend, last ' + days.length + ' days');
        barsAxis.innerHTML = '<span>' + dayLabel(days[0].day, { month: 'short', day: 'numeric' }) + '</span>' +
          (budget > 0 ? '<span>budget ' + usd(budget) + '/day</span>' : '') + '<span>today</span>';
        barsEl.classList.remove('hidden');
        barsAxis.classList.remove('hidden');
      } else {
        barsEl.classList.add('hidden');
        barsAxis.classList.add('hidden');
      }
      periodNote.textContent = 'Since ' + dayLabel(p.from, { month: 'short', day: 'numeric' }) + ', in UTC days. Limits are per day' +
        (days.length ? '; the bars are your daily spend.' : '.');
    }

    function renderUsage(me) {
      renderPeriod(me);
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
      // The dollar budget is the limit that bites; token caps are off by default,
      // so tokens get meters only when one is set.
      meters.innerHTML =
        (typeof l.dailyUsd === 'number' ? meter('Agent spend', u.costUsd, l.dailyUsd, usd) : '') +
        meter('Requests', u.requests, l.dailyRequests) +
        (l.dailyInput > 0 || l.dailyOutput > 0
          ? meter('Input tokens', u.inputTokens, l.dailyInput) + meter('Output tokens', u.outputTokens, l.dailyOutput)
          : row('Tokens', tokens(u)));
      if (me.resetsAt) {
        const ms = Date.parse(me.resetsAt) - Date.now();
        if (ms > 0) {
          const mins = Math.ceil(ms / 60000), h = Math.floor(mins / 60), m = mins % 60; // never "5h 60m"
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
        periodCard.classList.add('hidden');
      } else if (m.type === 'usage') {
        renderUsage(m.me);
      }
    });
  </script>
</body>
</html>`;
  }
}
