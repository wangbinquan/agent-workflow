# Workflow YAML reference

Workflows are stored in SQLite as a JSON `definition` blob; the UI lets you
**Export YAML** / **Import YAML** for version-control or sharing. This page
documents that YAML shape. The authoritative zod schemas are in
[`packages/shared/src/schemas/workflow.ts`](../packages/shared/src/schemas/workflow.ts).

## Top-level shape

```yaml
id: 01J9YJ2P0K7DC9G2X8Q1W6P0XA # ULID; new workflows have this filled
name: code-audit-fix
description: Run worker → audit → fix in a loop until clean.
definition:
  $schema_version: 4
  inputs: [...] # launcher form fields
  nodes: [...]
  edges: [...]
  outputs: [...] # optional; named ports surfaced on the task detail page
```

Import uses a structured JSON request to `POST /api/workflows/import`:

```json
{ "yamlText": "name: ...", "mode": "fail" }
```

| `mode`      | Behavior                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `fail`      | 409 on an id collision; `details.current` carries the exact revision      |
| `overwrite` | Replace only the confirmed revision; requires the `overwrite` fence below |
| `new`       | Strip the YAML id and create a fresh workflow                             |

An overwrite confirmation must reuse the revision returned by the collision and
generate one canonical ULID for that submitted intent (transport retries reuse
the same id):

```json
{
  "yamlText": "id: 01J...\nname: ...",
  "mode": "overwrite",
  "overwrite": {
    "workflowId": "01J...",
    "expectedVersion": 3,
    "clientMutationId": "01ARZ3NDEKTSV4RRFFQ69G5FAV"
  }
}
```

Created imports return `{ "outcome": "created", "workflow": ... }`; overwrites
return `{ "outcome": "overwritten", "receipt": ... }`. Raw YAML request bodies
and the former `?onConflict=` query parameter are intentionally rejected.

Portable YAML uses `agentName` (and, only when needed to disambiguate,
`agentOwnerUsername`). Import resolves that selector to the installation-local
stable `agentId`; export strips `agentId` again.

## `inputs[]` — launcher form

Every input is shown on the **Launch task** page. An `input` node with the same
`inputKey` exposes the packed value on a port of that name; ordinary edges then
bind it to local prompt variables such as `{{target_file}}`.

```yaml
inputs:
  - kind: text
    key: target_file
    label: Target file
    required: true
    multiline: false
  - kind: files
    key: scope
    label: Scope
    minCount: 1
    maxCount: 20
    accept: file # file | dir | both
  - kind: enum
    key: strictness
    label: Strictness
    choices: ['lenient', 'normal', 'strict']
    multiSelect: false
    allowOther: false
  - kind: git
    key: base
    label: Base ref
    gitKind: branch # branch | commit-range | pr
  - kind: upload
    key: attachments
    label: Attachments
    targetDir: .agent-workflow/uploads
    accept: ['.pdf', 'image/*']
    maxFileSize: 10485760
    onConflict: rename # rename (default) | overwrite
```

| `kind`   | Extra fields                                  | Packed value sent to backend              |
| -------- | --------------------------------------------- | ----------------------------------------- |
| `text`   | `multiline`, `maxLength`                      | Raw string                                |
| `files`  | `minCount`, `maxCount`, `accept`              | Newline-joined repo-relative paths        |
| `enum`   | `choices`, `multiSelect`, `allowOther`        | Bare string (single) / JSON array (multi) |
| `git`    | `gitKind: 'branch' \| 'commit-range' \| 'pr'` | `{kind, ...}` JSON object                 |
| `upload` | `targetDir`, `accept`, size/count limits, `onConflict` | Newline-joined staged repo-relative paths |

`upload.onConflict` (RFC-262) decides what happens when a file lands on a name that
already exists inside `targetDir` in the task worktree: `rename` (default, RFC-020
behavior) writes `report (1).pdf` and leaves the existing file alone, while
`overwrite` replaces it so the packed path keeps the original name — which is what
repo-internal references to that path resolve to. Two uploaded files that would land
on the same path are rejected at launch (`upload-duplicate-filename`) under either
policy. Unrelated to the retired `?onConflict=` import query parameter above.

## `nodes[]` — nine kinds

Every node has `id`, `kind`, `position: {x, y}`. The rest depends on `kind`.

### `input`

```yaml
- id: in_target
  kind: input
  position: { x: 40, y: 80 }
  inputKey: target_file # must match an inputs[].key
```

Output port name **equals** `inputKey`.

### `agent-single`

```yaml
- id: a_worker
  kind: agent-single
  position: { x: 200, y: 80 }
  agentName: worker
  promptTemplate: |
    Fix the import paths in {{target_file}}. The repo lives at {{__repo_path__}}.
  overrides: # optional, per-node overrides
    model: anthropic/claude-sonnet-4-6
    temperature: 0.1
```

Output ports are the agent's `outputs` (`{{port_name}}` references are
resolved from upstream edges). Retry and timeout are daemon-wide execution
settings, not node fields: `config.defaultNodeRetries` and
`config.defaultPerNodeTimeoutMs` apply uniformly to every agent run.

### `wrapper-fanout`

```yaml
- id: wrap_fan
  kind: wrapper-fanout
  nodeIds: [a_auditor, a_aggregator]
  inputs:
    - name: docs
      kind: list<path<md>>
      isShardSource: true
    - name: policy
      kind: string # broadcast input
  expectedShardCount: 20 # sizing / nested-cartesian estimate
  position: { x: 280, y: 80 }
  size: { width: 720, height: 420 }
```

Exactly one `inputs[]` port must be `isShardSource: true` and have `list<T>`
kind. A `boundary: wrapper-input` edge maps one item to every per-shard run;
non-shard inputs are broadcast. An optional inner `role: aggregator` agent
runs once after the join and its outputs become wrapper outlets (renamed by the
agent's `outputWrapperPortNames`). With no aggregator, the wrapper exposes the
`__done__: signal` outlet.

The current v1 runtime accepts only `agent-single` inner nodes (plus at most one
aggregator); other inner kinds fail closed with
`wrapper-fanout-v1-unsupported-inner-kind`.

### `output`

```yaml
- id: out_audit
  kind: output
  position: { x: 600, y: 80 }
  ports:
    - name: audit_findings
      bind: { nodeId: a_worker, portName: findings }
```

Surfaces a port on the task detail page's **Outputs** panel.

### `wrapper-git`

```yaml
- id: wrap_git
  kind: wrapper-git
  position: { x: 120, y: 200 }
  nodeIds: [a_worker] # nodes captured inside this wrapper's scope
```

The single output port `git_diff: list<path<*>>` is a newline-delimited,
sorted changed-path list (tracked and untracked) between the wrapper's before
and after snapshots. Arbitrary inner agent ports do not cross the wrapper
boundary.

### `wrapper-loop`

```yaml
- id: wrap_loop
  kind: wrapper-loop
  position: { x: 120, y: 240 }
  nodeIds: [a_worker, a_checker]
  maxIterations: 5
  exitCondition:
    kind: port-empty # also port-not-empty | port-equals | port-count-lt
    nodeId: a_checker
    portName: findings
    # value: 'CLEAN' # port-equals only
    # n: 1           # port-count-lt only
    # separator: "\n"
  outputBindings:
    - name: final_findings
      bind: { nodeId: a_checker, portName: findings }
```

**v1 has no cross-iteration feedback ports** — share state via worktree
files only. Each iteration's inner scope runs against the most recent
upstream values (and any prior iteration's writes that landed in the
worktree).

### `review`

```yaml
- id: review_design
  kind: review
  title: Approve design
  inputSource: { nodeId: a_worker, portName: answer }
  rerunnableOnReject: []
  rerunnableOnIterate: []
  rollbackFilesOnReject: false
  rollbackFilesOnIterate: false
```

Wire the reviewed source to `__review_input__`. Approval exposes
`approved_doc`; reject/iterate behavior is controlled by the declared rerun and
rollback fields.

### `clarify`

```yaml
- id: clarify_gate
  kind: clarify
  title: Clarify requirements
```

Self-clarification uses the fixed system edges:

```yaml
- id: agent_to_clarify
  source: { nodeId: a_worker, portName: __clarify__ }
  target: { nodeId: clarify_gate, portName: questions }
- id: clarify_to_agent
  source: { nodeId: clarify_gate, portName: answers }
  target: { nodeId: a_worker, portName: __clarify_response__ }
```

The asking agent parks the task in `awaiting_human`; sealed answers rerun that
agent with the framework-generated Clarify Q&A block.

### `clarify-cross-agent`

```yaml
- id: cross_gate
  kind: clarify-cross-agent
  title: Clarify upstream design
```

The questioner writes `__clarify__` to `questions`. `to_questioner` returns the
answer to its `__clarify_response__`; `to_designer` may target an upstream
agent's `__external_feedback__`. A normal answer submission reruns the asker by
default; revising another agent is an explicit reassign operation.

## `edges[]`

```yaml
edges:
  - id: e_001
    source: { nodeId: in_target, portName: target_file }
    target: { nodeId: a_worker, portName: target_file }
```

Multiple edges into the same target port are concatenated with a
`---` separator before substituting into the prompt template.

Fanout boundary plumbing is explicit:

```yaml
- id: docs_to_worker
  boundary: wrapper-input
  source: { nodeId: wrap_fan, portName: docs }
  target: { nodeId: a_auditor, portName: doc }
- id: report_to_wrapper
  boundary: wrapper-output
  source: { nodeId: a_aggregator, portName: report }
  target: { nodeId: wrap_fan, portName: final_report }
```

Boundary edges describe container plumbing, not ordinary DAG dependencies.
Wrapper containment must form a tree; `wrapper-loop` inside another
`wrapper-loop` is currently rejected, while git-in-loop and loop-in-git are
supported.

## Validation

`POST /api/workflows/:id/validate` accepts the exact workflow revision fence
(`expectedVersion` and `expectedSnapshotHash`) and validates references, ports,
topology, wrapper containment/boundaries, agent resources, input declarations,
output bindings, review/clarify channels, and prompt variables. The launcher
reruns the gate and refuses to start a task if any error remains; warnings do
not block launch.

Importable production-format examples and their executable daemon matrix live
in [`examples/workflows/e2e`](../examples/workflows/e2e/README.md). They cover
all nine node kinds, all four loop exits, git/loop nesting in both supported
orders, fanout broadcast/join/aggregation/empty/fail-all behavior, human review,
self/cross clarification, and fail-closed wrapper limits.
