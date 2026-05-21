# Plan: Codex Chat — Collaboration Mode dropdown

## Goal

Add a separate dropdown to the Codex chat composer for **collaboration mode**
(`plan` vs `default`) — independent of the existing permissions dropdown
(`approval-required` / `auto-accept-edits` / `full-access`) and the effort
dropdown.

Codex treats these as three orthogonal axes:

| Axis | Codex concept | SlayZone today |
| --- | --- | --- |
| Behavior | `CollaborationMode` / `ModeKind` (`plan`/`default`) | **missing** |
| Permissions | `AskForApproval` + `SandboxPolicy` | `chatMode` dropdown |
| Reasoning | `ReasoningEffort` | `chatEffort` dropdown |

The existing `chatEffort` axis is the implementation template — orthogonal,
per-task, persisted in `provider_config`, kill+respawn on change.

## Scope

Codex chat only. Claude chat's `plan` permission mode is unaffected — it stays
in the `chatMode` dropdown for `claude-chat`.

## Steps

### 1. Shared type + catalog — new `chat-collaboration.ts`
`packages/domains/terminal/src/shared/chat-collaboration.ts`
- `export type ChatCollaborationMode = 'default' | 'plan'`
- `CHAT_COLLABORATION_MODES`, `DEFAULT_CHAT_COLLABORATION = 'default'`
- `isChatCollaborationMode()` type guard
- Export from terminal barrel.

### 2. Persistence — `chat-handlers.ts`
- Add `chatCollaboration?: ChatCollaborationMode | null` to `ProviderConfigEntry`.
- Add `writeChatCollaboration()` (mirror `writeChatEffort`).
- Stored at `provider_config[mode].chatCollaboration`.

### 3. IPC handlers — `chat-handlers.ts`
- `chat:getCollaboration(taskId, mode)` → reads provider config.
- `chat:setCollaboration(opts & { chatCollaboration })` — mirror `chat:setEffort`:
  pre-spawn fast path (persist + `updateSessionChatCollaboration`), else
  kill+respawn via `buildHydrateOpts({ chatCollaborationOverride })`.
- `buildHydrateOpts`: resolve override > stored > default.

### 4. Transport — `chat-transport-manager.ts`
- `Session.chatCollaboration` field; `ChatSessionInfo.chatCollaboration`.
- Wire into `hydrateSession`, `toInfo`, `driverCtx` (`ChatDriverContext`).
- `updateSessionChatCollaboration(tabId, value)` pre-spawn fast path.

### 5. Codex protocol — `codex-protocol.ts`
- `export type CodexModeKind = 'plan' | 'default'`.
- `CodexCollaborationMode = { mode: CodexModeKind; settings: { model: string;
  reasoning_effort: CodexReasoningEffort; developer_instructions: string } }`.
- Add `collaborationMode?: CodexCollaborationMode` to `CodexTurnStartParams`.

### 5b. Instruction presets — new `codex-collaboration-instructions.ts`
- `CODEX_PLAN_INSTRUCTIONS` / `CODEX_DEFAULT_INSTRUCTIONS` — SlayZone-authored
  `<collaboration_mode>…</collaboration_mode>` blocks (not copied from T3Code).

### 6. Codex session — `codex-chat-session.ts`
- Read `ctx.chatCollaboration` in `start()`; store on `this.collaboration`.
- `buildCollaborationMode()` → `CodexCollaborationMode` (mode + settings).
- Include in `turn/start` params (only for `codex-chat`).
- `applyControl` `set_collaboration` case — update in-memory field; next
  `turn/start` picks it up (respawn still happens via the handler for a
  clean reset, matching effort).

### 7. UI — `ChatPanel.tsx` + new hook/component
- `useChatCollaboration()` hook — mirror `useChatEffort` (hydrate from
  `chat:getInfo` > `chat:getCollaboration`, change handler calls
  `chat:setCollaboration`).
- `AgentCollaborationPill` component — mirror `AgentEffortPill`.
- Render in composer footer **only when `mode === 'codex-chat'`**.

### 8. Codex wiring — SPIKE + T3Code investigation (done)
**Finding (confirmed via T3Code `pingdotgg/t3code`, production):** `turn/start`
accepts a native **`collaborationMode`** param. Shape = the schema's
`CollaborationMode` type:

```jsonc
collaborationMode: {
  mode: 'plan' | 'default',          // native ModeKind
  settings: {
    model: <codex model id>,
    reasoning_effort: <effort>,       // default 'medium'
    developer_instructions: <preset>  // <collaboration_mode>…</collaboration_mode> block
  }
}
```

The earlier "orphan type" read was a false alarm — `generate-json-schema`'s
per-file `TurnStartParams.json` omits the property, but the app-server accepts
it; T3Code uses it in prod (and carries the same generator TODO).

Server-side, `mode` is real: in `plan` Codex enables the `request_user_input`
tool and blocks `update_plan`; in `default` the reverse. `developer_instructions`
carries the behavioral prompt (a `<collaboration_mode>` XML block).

**Chosen approach:** add `collaborationMode` to `CodexTurnStartParams`; build it
per-turn in `startTurn()` from `chatCollaboration`. Author SlayZone's own
plan/default `<collaboration_mode>` instruction presets
(`codex-collaboration-instructions.ts`) — do not copy T3Code's verbatim.
Per-turn, like `effort`.

Capability note: send `collaborationMode` only for `codex-chat`; old Codex CLIs
that reject it surface a turn error → "show disabled" reserved for a detected
hard-unsupported signal.

## Out of scope
- Refreshing the entire Codex protocol binding set (separate task).
- Claude chat changes.

## Resolved decisions
1. Plan vs sandbox — keep fully orthogonal.
2. Change application — respawn only (like effort).
3. Unsupported Codex — show disabled.
4. New-task default — `default`.
5. Codex wiring — `developerInstructions` preset (see step 8 spike result);
   native `ModeKind` not available in 0.132.0.
