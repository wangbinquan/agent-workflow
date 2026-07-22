# Codex Review

Target: branch diff against eb262a02^

The patch introduces a core requiredness mismatch and multiple launch paths that the UI advertises but the backend rejects. Multipart handling and scheduled validation also contain failure-path gaps that can cause 500s, invalid schedules, memory amplification, and leaked workspaces.

Full review comments:

- [P1] Align the editor with required-by-default semantics — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/shared/src/agentLaunchForm.ts:69-69
  `compactInputPort` drops `required:false`, while `AgentPortDialog` initializes and renders an absent flag as unchecked; this new default reads that persisted absence as required. Consequently, every default/unchecked port saved through the editor becomes mandatory in the launch wizard/backend, and editing an imported optional port can silently flip it. Seed/render absence as required and persist explicit `false` when the user turns Required off.

- [P2] Reject inherited record-property port names — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/shared/src/agentLaunchForm.ts:59-59
  For a schema-valid legacy/API port named `toString`, `valueOf`, `hasOwnProperty`, or another `Object.prototype` property, this blocker set allows the name even though launch inputs are ordinary objects. Omitting a required one makes `validateAgentLaunchShape` read the inherited function and call `.trim()` (500), while omitting an optional one later makes `scheduler.ts` read the inherited value instead of `''`; block every inherited key or use own-property/null-prototype lookups.

- [P2] Clean up uploaded workspaces when startTask refuses handoff — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/backend/src/services/agentLaunch.ts:471-474
  For multipart agent launches under `sandboxMode=enforce` when the OS sandbox is unavailable, uploads are materialized and written before this call, but `startTask` throws `sandbox-unavailable` before initializing ownership of `materializedSpace.cleanup`. This service only cleans failures from `applyUploadsToWorktree`, so the uploaded worktree remains behind and scratch launches also retain their `materializingSpaces` lease; precheck before materialization or clean up around the handoff.

- [P2] Validate upload keys before buffering file bytes — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/backend/src/services/launchMultipart.ts:89-89
  `parseMultipartLaunch` now calls `arrayBuffer()` before either caller has schema-validated or authorized the target or run `assertUploadFilesMatchDefs`. A `tasks:launch` caller can attach a very large `files[ghost][]` part to a valid non-upload workflow or inaccessible target and force a full in-memory copy even though the request must be rejected; the previous task route checked the workflow and input key before this copy. Defer reading bytes until target definitions are available.

- [P2] Validate payload replacements even while disabled — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/backend/src/services/scheduledTasks.ts:252-256
  When `PUT` supplies `launchPayload` for a schedule whose resulting `enabled` is false, `updateScheduledTask` skips `assertScheduledTargetUsable`, so this new shape validator is never called. Such an update can persist a ported-agent payload with neither shape, unknown or missing required keys, blockers, or upload ports and report success, only to fail when later enabled; validate explicit payload replacements regardless of enabled state while still allowing payload-free disable/rename cleanup.

- [P2] Block multi-repo agent uploads in the wizard — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/frontend/src/routes/tasks.new.tsx:923-924
  For a ported agent with a `path` input, this new branch sends multipart, but `multiRepoBlockedReason` is still computed only when `kind === 'workflow'`. Selecting two remote repositories therefore leaves `canSubmit` true and submits a request that `startAgentTask` deterministically rejects with `multi-repo-upload-unsupported`; apply the same upload multi-repo gate to agent forms.

- [P2] Disable scheduling for agents with upload ports — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/frontend/src/routes/tasks.new.tsx:724-727
  `inputDefs` now includes agent upload definitions, but `scheduleUnsupported` remains workflow-only, so Save scheduled stays enabled for path-port agents. Scheduled fires are JSON-only and create-time validation deterministically rejects these agents, turning the advertised action into an error; extend the guard to agent upload definitions, including the edit action.

- [P2] Stop treating a missing agent as still loading — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/frontend/src/routes/tasks.new.tsx:534-535
  After `agentsQ` succeeds without a row matching a stale, deleted, invisible, or builtin deep-linked `agentName`, this expression remains false forever. The content step then renders `LoadingState` because only `agentsQ.isError` selects an error, and `canProceed` never recovers; distinguish success-without-match from a pending query and show a recoverable not-found state.

- [P2] Consume agentKind when rendering text ports — /private/tmp/claude-501/-Users-wangbinquan-dev-proj-agent-workflow/a7ea24b5-6f0c-4b39-a1b9-7fa19fd3dec8/scratchpad/rfc218-implgate-wt/packages/frontend/src/components/launch/DynamicInput.tsx:32-35
  `deriveAgentLaunchForm` carries `agentKind`, but this rendering path only reads `maxLength`, `presentation`, and `multiline`; no frontend code consumes `agentKind`. Consequently, markdown ports render as ordinary proportional textareas instead of monospace, and fallback composite kinds have no declared-kind hint. Use this metadata when selecting the control presentation and field hint.
