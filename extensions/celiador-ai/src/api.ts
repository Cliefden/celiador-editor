/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Auth } from './auth';

// Thin client for the daemon's app-data endpoints (profile + chat history). The
// editor talks to the DB THROUGH the daemon — never PostgREST directly. Auth is
// the shared Supabase Bearer token; refresh once on a 401 and retry.

export interface Profile {
  id: string;
  email?: string;
  display_name?: string;
  avatar_url?: string;
  plan: string;
  settings: Record<string, unknown>;
}

export interface ChatSummary {
  id: string;
  title?: string;
  origin: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_at?: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: { text?: string } | Record<string, unknown>;
  seq?: number;
  created_at: string;
}

/** Today's agent usage counters (UTC day), as metered by the daemon's quota tracker. */
export interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Active per-user daily limits. A `0` means that limit is disabled (unlimited). */
export interface Limits {
  rpm: number;
  concurrency: number;
  dailyRequests: number;
  dailyInput: number;
  dailyOutput: number;
}

/** Dollar balance for the account (Stripe-backed; Phase 5 slice 2). Absent until billing lands. */
export interface Balance {
  plan: string;
  planLabel: string;
  includedUsd: number;
  spentUsd: number;
  topUpUsd: number;
  remainingUsd: number;
  period: string;
}

/** GET /api/me — signed-in account summary: identity, plan, usage vs. quota. */
export interface Me {
  userId: string;
  email: string | null;
  /** Billing plan, or null in token/none (self-host/dev) mode or before a profile row exists. */
  plan: string | null;
  usage: Usage;
  limits: Limits;
  /** ISO timestamp when the daily usage counters reset (next UTC midnight). */
  resetsAt: string;
  balance?: Balance;
}

export class DaemonApi {
  constructor(private readonly auth: Auth, private readonly getUrl: () => string) {}

  private async call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (init.body) {headers['content-type'] = 'application/json';}
    const res = await fetch(`${this.getUrl()}${path}`, { ...init, headers });
    if (res.status === 401 && retry && (await this.auth.tryRefresh())) {
      return this.call<T>(path, init, false);
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async getProfile(): Promise<Profile> {
    return (await this.call<{ profile: Profile }>('/api/profile')).profile;
  }

  async updateProfile(patch: { display_name?: string; settings?: Record<string, unknown> }): Promise<Profile> {
    return (await this.call<{ profile: Profile }>('/api/profile', { method: 'PATCH', body: JSON.stringify(patch) })).profile;
  }

  async listChats(): Promise<ChatSummary[]> {
    return (await this.call<{ chats: ChatSummary[] }>('/api/chats')).chats;
  }

  async getChat(id: string): Promise<{ chat: ChatSummary; messages: ChatMessage[] }> {
    return this.call(`/api/chats/${encodeURIComponent(id)}`);
  }

  async deleteChat(id: string): Promise<void> {
    await this.call(`/api/chats/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getMe(): Promise<Me> {
    return this.call<Me>('/api/me');
  }

  /** Permanently delete the signed-in account and all its data (DELETE /api/account). */
  async deleteAccount(): Promise<void> {
    await this.call('/api/account', { method: 'DELETE' });
  }
}
