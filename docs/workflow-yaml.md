# Workflow definition reference

A workflow is stored in SQLite as a JSON `definition` blob. This page documents
that structure — nodes, edges, launcher inputs and the validation rules — using
YAML for readability. The authoritative zod schemas are in
[`packages/shared/src/schemas/workflow.ts`](../packages/shared/src/schemas/workflow.ts).

> **Moving workflows between instances: use a configuration package, not this
> file.** RFC-271 retired single-file YAML export/import
> (`GET /api/workflows/:id/export`, `POST /api/workflows/import`) because a YAML
> file carries only the workflow's own `definition` — the skills, MCPs, plugins
> and `dependsOn` closure behind its agents are not in it, so importing one into
> another instance reliably produces dangling references. Configuration packages
> ship the whole closure; see [`resource-packages.md`](./resource-packages.md)
> for the format and [`resource-bundles.md`](./resource-bundles.md) for the
> expression layer underneath it.
>
> What follows still describes the live `definition` — it is what the canvas
> edits, what a package's `bundle.json` carries, and what the intent builder
> emits.

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

`name` is an ordinary human-readable name — Chinese and mixed scripts are fine
(`代码审计流水线`, `审计 Pipeline v2`). It must not start with `_` (that shape is
reserved for framework-internal rows), must not contain control characters or
line breaks, and is at most 128 characters. Every write path normalizes it (NFC,
spaces folded, edges trimmed) and rejects a non-conforming name with
`workflow-name-invalid` rather than silently rewriting it (RFC-264).

Inside a stored definition an `agent-single` node carries the
installation-local stable `agentId`. Portable forms carry a selector instead —
`agentName` plus, only when needed to disambiguate, `agentOwnerUsername` — and
the resource-bundle layer resolves it to `agentId` on the way in
([`resource-bundles.md`](./resource-bundles.md) §1).

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

| `kind`   | Extra fields                                           | Packed value sent to backend              |
| -------- | ------------------------------------------------------ | ----------------------------------------- |
| `text`   | `multiline`, `maxLength`                               | Raw string                                |
| `files`  | `minCount`, `maxCount`, `accept`                       | Newline-joined repo-relative paths        |
| `enum`   | `choices`, `multiSelect`, `allowOther`                 | Bare string (single) / JSON array (multi) |
| `git`    | `gitKind: 'branch' \| 'commit-range' \| 'pr'`          | `{kind, ...}` JSON object                 |
| `upload` | `targetDir`, `accept`, size/count limits, `onConflict` | Newline-joined staged repo-relative paths |

`upload.onConflict` (RFC-262) decides what happens when a file lands on a name that
already exists inside `targetDir` in the task worktree: `rename` (default, RFC-020
behavior) writes `report (1).pdf` and leaves the existing file alone, while
`overwrite` replaces it so the packed path keeps the original name — which is what
repo-internal references to that path resolve to. Two uploaded files that would land
on the same path are rejected at launch (`upload-duplicate-filename`) under either
policy.

## `nodes[]` — the fourteen kinds

Every node has `id`, `kind`, `position: {x, y}`. The rest depends on `kind`.

Thirteen of them you author. The fourteenth — [`code-round`](#code-round) — is
synthesized by the platform and **rejected** if you write it yourself; it is
documented here because you can still read it in a task snapshot.

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

Retries have two dimensions (RFC-313). `config.defaultNodeRetries` is how many times a
failed attempt may be re-asked **inside the same runtime session** (the model exited
cleanly, said something, and only botched the envelope — a short repair prompt resumes
that session and keeps its isolated worktree). `config.sessionRestartBudget` is how many
times a node may give up on that session entirely and start over in a **clean** one:
fresh worktree branched from canonical, fresh envelope nonce, the full prompt re-rendered
plus a short note telling the new session what the abandoned one kept getting wrong. The
worst-case attempt count per node is `(1 + defaultNodeRetries) × (1 + sessionRestartBudget)`
— 8 by default. Set `sessionRestartBudget: 0` to disable escalation entirely; the cap then
degrades to `1 + defaultNodeRetries`, exactly the pre-RFC-313 behavior.

In the visual editor, runtime templates use one field-adjacent **Insert parameter** picker instead
of an always-expanded token list. It classifies current-node inputs, task runtime values, and
Webhook trigger context separately; every option shows a readable label, canonical token, and
description. Webhook values remain discoverable on demand because a workflow can be saved before a
trigger rule is attached, but they are only populated for Webhook-launched tasks.

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

### `call-workflow`

```yaml
- id: c_child
  kind: call-workflow
  position: { x: 520, y: 300 }
  workflowName: nightly-audit # the target's exact display name
  limits: # optional caps on the child task
    maxDurationMs: 1800000
    maxTotalTokens: 400000
```

Runs another workflow as an **independent child task**. Its ports mirror the
child's declared `inputs[]` (in-ports) and `outputs` (out-ports), so the caller's
wiring depends on the child's definition.

`workflowName` is the authoritative selector and is resolved **late, at launch**
— two consequences follow. Renaming the target breaks every caller
(`call-workflow-ref-missing`), and `workflows.name` is **not** unique, so when
several visible rows share the name the launch binds the oldest one the launching
user can see. Two launch-time rules the definition alone will not reveal: every
one of the child's declared inputs needs its own ordinary incoming edge targeting
that exact input key — **including optional ones**, else
`call-workflow-input-unwired`; and a child declaring any `upload` input cannot be
called at all (`call-workflow-upload-input-unsupported`).

### `call-workgroup`

```yaml
- id: c_squad
  kind: call-workgroup
  position: { x: 520, y: 380 }
  workgroupName: audit-squad
  goalTemplate: |
    Review {{git_diff}} and report blocking issues.
  limits:
    maxDurationMs: 1800000
```

Hands this stage to a workgroup running as an independent child task. Inbound
ports are edge-derived (each incoming edge's target `portName` **is** the
variable name) and readable inside `goalTemplate` as `{{port_name}}`. The single
output port is `result`. `workgroupName` has the same late-bound, non-unique
semantics as `call-workflow`.

### `script`

```yaml
- id: s_report
  kind: script
  position: { x: 520, y: 460 }
  language: python # python | bash | node
  script: |
    import os, json
    findings = os.environ['AW_PORT_FINDINGS']
    print(json.dumps({'count': len(findings.splitlines())}))
  outputs: # optional; absent/empty ⇒ one implicit `stdout` port
    - name: summary
  dependencies: ['requests==2.32.3'] # exact pins only; bash declares none
  env: { TOKEN: '' } # closed secret carrier — see below
  network: deny # allow (default) | deny
  readonly: true
```

Runs inline in the task worktree — no agent, no model process. Inbound port
values arrive as environment variables `AW_PORT_<PORT>` (port name uppercased,
characters outside `[A-Z0-9_]` folded to `_`); they are **never** substituted
into the body, so read them from the environment. With `outputs` absent or empty
the raw stdout becomes one implicit `stdout` port; with `outputs` declared the
script must print
`<workflow-output nonce="$AW_ENVELOPE_NONCE"><port name="…">…</port></workflow-output>`.
`dependencies` must pin exact versions (pip `pkg==1.2.3` / npm `pkg@1.2.3`).
Script nodes cannot sit inside `wrapper-fanout`.

`env` values are a **closed secret carrier**: real values are collected through
the confirm UI / configuration-package import and never travel in a definition
document. Authoring or changing a script node requires the `scripts:author`
permission (admin + manager); everyone else may still move the node and edit
unrelated parts of the same workflow.

### `code-host-call`

```yaml
- id: h_comment
  kind: code-host-call
  position: { x: 520, y: 560 }
  provider: gitlab # gitlab | github
  action: comment.create # key from the shared action registry
  params:
    mr: '{{trigger.webhook.mr_iid}}'
    body: |
      Audit found {{findings}}.
  timeoutMs: 30000
  # allowDestructive: true   # required for any DELETE
  # request: { method: POST, path: /projects/1/x, body: '{"k":"v"}' }  # action: custom only
```

The **platform itself** issues one REST call to GitLab/GitHub using the base URL
and token an administrator configured in settings — no agent, no model, no
subprocess, and that token never enters a prompt or a port. Fixed output ports
are `response` (raw body) and `status` (HTTP status code); the node declares no
input ports. Every `params` value is a template: `{{port_name}}` reads an inbound
edge's port and `{{trigger.webhook.<field>}}` reads the webhook event that started
the task (no edge needed). The same canonical trigger namespace is available in
agent prompts, call-workgroup goals and review comment templates; these values are
execution context and must not be copied into workflow root `inputs[]`. Leaving
`project` empty targets the task's own repository. A non-2xx response fails the
node.

`action: custom` is the escape hatch and its `request` is stricter than it looks:
`path` must start with a single `/`, is relative to the configured base URL (no
scheme, no `//` prefix, no `?`, `#`, `..` segment or whitespace — query
parameters go in `query`), and `body` is a **string** holding JSON in which every
`{{var}}` sits inside a JSON string value. Authoring one requires the
`code-host-calls:author` permission (admin + manager).

### `code-round`

**You cannot write this one.** A definition containing it is rejected with
`code-round-not-authorable`, whether it arrives by YAML import, by
`PUT /api/workflows/:id`, or by hand-editing an export. It has no palette entry
for the same reason.

```yaml
# read-only: what a task snapshot looks like, not something you author
- id: round
  kind: code-round
  position: { x: 0, y: 0 }
  capability: mr-review # which code capability this round runs
  roundSeq: 1 # 1-based, within the work item
```

It exists because a code capability (RFC-304) runs a **stage sequence**, not a
node graph: most stages are plain program code, and program stages have no node
kind to compile into. So a capability round is one synthesized node driven by the
stage engine, and this kind is what a task's frozen snapshot records so the task
detail page has something to draw. What the round actually does is configured one
level up, on the capability binding — never on the node.

Every synthesized-only kind is listed in `SYNTHESIZED_ONLY_NODE_KINDS`
(`packages/shared/src/schemas/workflow.ts`), which the validator, the palette and
this page's coverage test all read; adding a kind to that list is what makes it
unauthorable, not any hand-copied list.

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
