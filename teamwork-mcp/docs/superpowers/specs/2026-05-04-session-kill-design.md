# Session Kill UI Design

## Goal

Add a dashboard kill action that force-stops all tracked agent CLIs for one session, normalizes the session state even when some runtimes are already dead, and exposes the action from both the session detail page and the session list.

## User-Approved Decisions

- Terminal session status after kill: `abandoned`
- Action placement: session detail page and session list rows
- Confirmation UX: single confirmation dialog for every session
- Recommended architecture selected: dedicated server-owned session-kill endpoint

## Current Constraints

- The dashboard HTTP surface is read-only today.
- Existing worker control primitives (`stop_worker`, `stopSessionWorkers`) and lifecycle primitives (`abandonSession`, `archiveSession`) already exist in the server runtime.
- The browser does not receive parent actor tokens, so the kill flow must stay server-owned.

## Proposed UX

### Session detail page

Add a trailing destructive action in the session header area.

- Label: `Kill session` for active/executing sessions
- Label may degrade to `Force abandon` when the session is already stale but still appears actionable
- Style: restrained destructive treatment that matches the current neutral dashboard, with emphasis on clarity over alarm

### Session list rows

Add a compact trailing row action that is visible on hover and focus without breaking row scanability.

- The row remains primarily navigational
- The kill affordance opens the same confirmation dialog used by the detail page
- Shared action semantics avoid split-brain behavior between list and detail

### Confirmation dialog

Use one shared Radix dialog component for both entry points.

Dialog copy should state that the server will:

1. Stop any tracked worker CLIs that are still running
2. Mark all agents inactive
3. Set the session status to `abandoned`
4. Continue the abandonment even if some runtimes were already stopped or missing

## Backend Design

Add a dedicated HTTP mutation:

- `POST /api/v2/sessions/:sessionId/kill`

This endpoint will be implemented in the dashboard HTTP layer and execute fully on the server side.

### Kill flow

1. Resolve the session from the shared teamwork store
2. Resolve the parent agent internally from the store so no actor token is exposed to the client
3. Load all runtimes for the session
4. For each runtime:
   - if it is server-managed and `running`, stop it
   - if it is already `exited`, `crashed`, or has no live child process, record it as already stopped
5. Mark all agents in the session inactive
6. Set the session status to `abandoned`
7. Record a terminal reason such as `Killed from dashboard`
8. Emit the normal runtime/agent/session events so the list and detail views refresh immediately

### Idempotency rule

The kill endpoint must be idempotent.

Repeated calls must converge to the same final result:

- session status ends as `abandoned`
- all agents end as inactive
- no already-dead runtime blocks completion

This rule directly covers the stale-session cleanup case where tracked CLIs are already gone.

## Response Contract

Return a compact mutation summary:

```json
{
  "sessionId": "uuid",
  "status": "abandoned",
  "stoppedCount": 2,
  "alreadyStoppedCount": 1,
  "agentCount": 4,
  "terminalReason": "Killed from dashboard"
}
```

This gives the client enough information for precise success and warning toasts.

## Client Data Flow

1. User clicks kill from the row action or header action
2. Client opens the shared confirmation dialog
3. On confirm, client calls the kill endpoint
4. UI disables the initiating control and shows an in-flight label such as `Stopping session...`
5. On success:
   - refresh the affected session detail if open
   - refresh the session list
   - allow SSE updates to reconcile any runtime and agent transitions
6. Show a toast using the returned summary

## Loading, Success, and Failure States

### Loading

- Disable the initiating action while the request is in flight
- Prevent duplicate submissions from list and detail at the same time for the same session

### Success

- Update visible status badges to `abandoned`
- Keep the session visible in any include-stopped view until later archival
- Show a success toast using the mutation summary

### Partial runtime stop issues

If runtime signaling is incomplete but session normalization succeeds:

- still mark the session `abandoned`
- still mark all agents inactive
- show a warning toast noting how many runtimes were already stopped or could not be signaled cleanly

### Hard failure

If the endpoint cannot perform the mutation:

- do not mutate client state optimistically beyond the loading affordance
- close loading state
- show toast and inline dialog error text

## Session Status Semantics

Kill is not completion and should not reuse completed/finalizing semantics.

- `completed` means orderly closeout
- `archived` means hidden historical cleanup
- `abandoned` is the correct terminal state for a forced stop

## Out of Scope

- Bulk multi-session kill
- Automatic archive immediately after kill
- Exposing raw actor tokens to the UI
- Adding a separate kill state beyond `abandoned`

## Verification Targets

1. Endpoint abandons an active session after stopping running managed runtimes
2. Endpoint abandons a stale session even if all runtimes are already exited or crashed
3. All agents become inactive after kill
4. Session list and session detail both reflect `abandoned` without manual reload
5. Repeated kill requests are harmless and deterministic
6. Row action and detail action share the same confirmation and mutation path
