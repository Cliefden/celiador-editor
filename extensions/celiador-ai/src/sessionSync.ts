/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dependency-free helpers that keep every window's copy of the Supabase session in
// step with the one in SecretStorage (#81).
//
// Each window (an editor window, the Agents window) runs its own extension host,
// so each has its own `Auth` with its own in-memory session. SecretStorage is
// shared across windows; the in-memory copies are not. Without syncing, a window
// that loaded "signed out" before another window signed in stays signed out, and
// a window holding an older session refreshes with a refresh token another window
// already rotated (GoTrue refresh tokens are single use).

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  email?: string;
}

/** Parse the stored session; anything unreadable counts as signed out. */
export function parseStoredSession(raw: string | undefined | null): Session | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.access_token === 'string' && typeof value.refresh_token === 'string') {
      return value as Session;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Same credential (both signed out, or the same token pair). */
export function sameSession(a: Session | null | undefined, b: Session | null | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  return a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

export type RefreshPlan =
  /** Storage holds the same session: this window refreshes it. */
  | { readonly kind: 'refresh' }
  /** Another window already replaced it: use that one instead of spending a rotated refresh token. */
  | { readonly kind: 'adopt'; readonly session: Session }
  /** Another window signed out. */
  | { readonly kind: 'signedOut' };

/**
 * Decide how to refresh `current`, given what SecretStorage holds right now.
 */
export function planRefresh(current: Session, stored: Session | null): RefreshPlan {
  if (!stored) {
    return { kind: 'signedOut' };
  }
  if (sameSession(current, stored)) {
    return { kind: 'refresh' };
  }
  return { kind: 'adopt', session: stored };
}
