/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The daemon's wire types, from its OpenAPI spec (Cliefden/celiador
// packages/client). schema.ts is vendored by scripts/sync-contract.mjs and
// never edited by hand; SOURCE names the celiador commit it came from.
// Types only: tsc emits empty modules for both files and nothing else imports
// them at runtime.

import type { components } from './schema';

type Schemas = components['schemas'];

/** `GET /api/health`. */
export type Health = Schemas['Health'];
/** `GET /api/config`. */
export type Config = Schemas['Config'];
/** The sign-in routes `GET /api/config` offers (`signIn`). */
export type SignInMethods = Schemas['SignInMethods'];

/** `GET|PATCH /api/profile` (`profile`). */
export type Profile = Schemas['Profile'];
/** The body of `PATCH /api/profile`. */
export type ProfilePatch = Schemas['ProfilePatch'];
/** One chat of `GET /api/chats` / `GET /api/chats/{id}`. */
export type Chat = Schemas['Chat'];
export type ChatMessage = Schemas['ChatMessage'];

/** `GET /api/me`. */
export type Me = Schemas['Me'];
/** Today's agent usage in `Me.usage` (UTC day). */
export type DayUsage = Schemas['DayUsage'];
/** Per-user limits in `Me.limits`; 0 means unlimited. */
export type UserLimits = Schemas['UserLimits'];
/** A session's model usage at the daemon's published rates (`Task.usage`). */
export type Usage = Schemas['Usage'];

export type TaskState = Schemas['TaskState'];
/** A task as `GET /api/tasks` and the `/api/tasks/stream` feed send it. */
export type Task = Schemas['Task'];
/** `GET /api/tasks`. */
export type TaskList = Schemas['TaskList'];
/** The body of `POST /api/tasks`. */
export type CreateTaskRequest = Schemas['CreateTaskRequest'];
/** The body of `POST /api/tasks/{id}/status`. */
export type TaskStatusReport = Schemas['TaskStatusReport'];

/** `POST /api/complete` (Tab autocomplete). */
export type CompleteRequest = Schemas['CompleteRequest'];
export type CompleteResponse = Schemas['CompleteResponse'];

/** One entry of `GET /api/sessions/{id}/events`. Clients must ignore kinds they don't know. */
export type SessionEvent = Schemas['SessionEvent'];
