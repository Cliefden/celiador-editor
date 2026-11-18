/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PKCE (RFC 7636) for the Supabase OAuth and magic-link flows, kept free of the
// `vscode` module so the unit tests can load it.

/** A fresh PKCE pair: a 256-bit hex verifier and its S256 challenge (base64url SHA-256). */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** The S256 challenge for `verifier`: base64url(SHA-256(verifier)), unpadded. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return Buffer.from(hash).toString('base64url');
}
