/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Shared scaffolding for the Agents view's webviews: a nonce'd CSP page (no
// remote resources, inline styles only), theme variables for every colour, and
// small DOM helpers injected into each page's script.

export function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {text += chars.charAt(Math.floor(Math.random() * chars.length));}
  return text;
}

/** Base styles: VS Code theme variables only, so the page follows the workbench theme. */
const BASE_CSS = `
  :root { --mono: var(--vscode-editor-font-family, ui-monospace, monospace); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--vscode-foreground); background: transparent; }
  button { font: inherit; cursor: pointer; }
  .mono { font-family: var(--mono); }
  .muted { color: var(--vscode-descriptionForeground); }
  .btn { min-height: 26px; padding: 0 12px; border-radius: 4px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn:focus-visible, .row:focus-visible, .tab:focus-visible, .link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); }
  .link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
`;

/** A full webview document with a strict CSP; `body` and `script` are trusted templates. */
export function page(options: { nonce: string; cspSource: string; title: string; css: string; body: string; script: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource} 'unsafe-inline'; script-src 'nonce-${options.nonce}';" />
<title>${options.title}</title>
<style>${BASE_CSS}${options.css}</style>
</head>
<body>
${options.body}
<script nonce="${options.nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  /** Element factory: el('div', { class: 'x', onclick }, child, 'text'). Text is never parsed as HTML. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
${options.script}
})();
</script>
</body>
</html>`;
}
