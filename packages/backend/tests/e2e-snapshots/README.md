# RFC-062 PR-B — real-workflow e2e snapshots

## What lives here

Each `*.json` file is a frozen snapshot of a workflow + mock agent
outputs that the actor + production launcher drives from
`task-started` to `task-completed`. The accompanying replay test
(`rfc062-snapshot-replay.test.ts`) iterates the directory, kicks the
full launcher path against an in-memory DB, scripts the opencode
subprocess behaviour via `ScriptedRunnerAdapter`, and asserts the
expected terminal kind + event sequence.

These fixtures are the safety net the RFC-061 hard cut should have
had. The 2026-05-25 incident — `scanFreshDownstream` deadlocking
every cross-clarify workflow — was caused by W-1..W-5 happy-path
integration tests covering only direct chains, never a real
production-shape workflow with feedback edges. A fixture-based replay
test would have caught it the day the contract broke.

## Fixture file shape

```jsonc
{
  "$comment": "Frozen on YYYY-MM-DD from <provenance>",
  "$schema_version": 4,
  "workflow": {
    /* WorkflowDefinition snapshot */
  },
  "inputs": { "<key>": "<text>" },
  "scriptedAgentOutputs": [
    {
      "matchNode": "agent_xxx",
      "matchIter": 0,
      "ports": [{ "name": "docpath", "content": "doc/design.md" }],
    },
    // ... one entry per (nodeId, iter) the actor will dispatch
  ],
  "expectedTerminalKind": "task-completed",
  "expectedEvents": {
    "mustContainInOrder": [
      "task-started",
      "logical-run-created:in_xxx",
      "logical-run-completed:in_xxx",
      "logical-run-created:agent_xxx",
      "attempt-started:agent_xxx",
      "attempt-finished-success:agent_xxx",
      "task-completed",
    ],
  },
}
```

`ScriptedRunnerAdapter.spawn(req)` matches by `(req.scope.nodeId,
req.scope.iter)` and writes the corresponding `ports` as
`attempt-output-captured` events, then immediately fires the
`attempt-exit success` wake — no opencode subprocess is spawned.

Unmatched spawn → test fails with `unexpected dispatch: nodeId=X
iter=Y`. This catches regressions that mint extra logical_runs the
fixture didn't anticipate.

## Provenance + upgrade policy

- **Initial fixtures** are minimal hand-written workflows targeting
  the topology shape that matters (cross-clarify, self-clarify,
  wrapper-loop). They are NOT raw production snapshots; raw prod
  workflows contain too many irrelevant nodes and the agent outputs
  are sensitive. Each fixture's `$comment` documents what it covers.

- **When workflow schema changes** (`$schema_version` bump), the
  schema author MUST update every `*.json` here so the replay test
  exercises the new shape — fixtures are part of the schema
  contract, not optional examples.

- **When a new NodeKind / SignalKind lands**, the author MUST add
  at least one fixture that exercises the new kind in a workflow
  containing feedback edges. The replay test failing on `unexpected
dispatch` is the natural prompt.

## Out of scope (clarify / review suspension auto-resolve)

PR-B's first cut covers happy-path workflows where agents produce
their final output in one envelope (no clarify question, no review
suspension). This already pins the contract-layer regression (the
incident root cause) because the deadlock fired the moment the input
node completed — long before any clarify suspension would have
mattered.

Fixtures that exercise clarify / cross-clarify / review suspensions +
their auto-resolve dance are intentionally deferred to a follow-up
patch with a richer `ScriptedSignalResolver` harness. Tracked in the
RFC-062 plan.md PR-B notes; not blocking PR-A's incident fix.
