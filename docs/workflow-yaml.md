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
  $schema_version: 1
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

## `inputs[]` — launcher form

Every input is shown on the **Launch task** page. The user-entered value is
exposed inside agents' prompt templates via `{{__inputs__.key}}`-style
references and through any wiring the workflow declares.

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
    accept: '*.ts'
  - kind: enum
    key: strictness
    label: Strictness
    options: ['lenient', 'normal', 'strict']
    multi: false
    allowOther: false
  - kind: git
    key: base
    label: Base ref
    gitKind: branch # branch | commit-range | pr
```

| `kind`  | Extra fields                                  | Packed value sent to backend              |
| ------- | --------------------------------------------- | ----------------------------------------- |
| `text`  | `multiline`                                   | Raw string                                |
| `files` | `minCount`, `maxCount`, `accept`              | Newline-joined paths                      |
| `enum`  | `options`, `multi`, `allowOther`              | Bare string (single) / JSON array (multi) |
| `git`   | `gitKind: 'branch' \| 'commit-range' \| 'pr'` | `{kind, ...}` JSON object                 |

## `nodes[]` — six kinds

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
  retries: 1
  timeoutMs: 600000 # falls back to config.defaultPerNodeTimeoutMs
  overrides: # optional, per-node overrides
    model: anthropic/claude-sonnet-4-6
    temperature: 0.1
```

Output ports are the agent's `outputs` (`{{port_name}}` references are
resolved from upstream edges).

### `agent-multi` (fan-out)

```yaml
- id: a_auditor
  kind: agent-multi
  position: { x: 360, y: 80 }
  agentName: auditor
  sourcePort: { nodeId: wrap_git, portName: git_diff } # the diff to shard
  shardingStrategy:
    kind: per-file # per-file | per-n-files | per-directory
    # n: 5                       # required when kind = per-n-files
    # depth: 1                   # default for per-directory
  promptTemplate: |
    Audit this shard:
    {{git_diff}}
  retries: 0
```

Output ports = the agent's `outputs` (children concatenated in shard-key
lexicographic order), plus an automatic `errors` port listing failed shards.

### `output`

```yaml
- id: out_audit
  kind: output
  position: { x: 600, y: 80 }
  ports:
    - name: audit_findings
      bind: { nodeId: a_auditor, portName: findings }
```

Surfaces a port on the task detail page's **Outputs** panel.

### `wrapper-git`

```yaml
- id: wrap_git
  kind: wrapper-git
  position: { x: 120, y: 200 }
  nodeIds: [a_worker] # nodes captured inside this wrapper's scope
```

No inputs; single output port `git_diff` = composed diff (tracked +
untracked) between HEAD-before-inner and HEAD-after-inner.

### `wrapper-loop`

```yaml
- id: wrap_loop
  kind: wrapper-loop
  position: { x: 120, y: 240 }
  nodeIds: [a_worker, a_auditor, a_fixer]
  maxIterations: 5
  exitCondition:
    kind: port-empty # port-empty | port-equals | port-count-lt
    target: { nodeId: a_auditor, portName: findings }
    # value: 'CLEAN'              # for port-equals
    # n: 1                        # for port-count-lt (count items in a list-ish port)
    # separator: "\n"
  outputBindings:
    - name: final_findings
      bind: { nodeId: a_auditor, portName: findings }
```

**v1 has no cross-iteration feedback ports** — share state via worktree
files only. Each iteration's inner scope runs against the most recent
upstream values (and any prior iteration's writes that landed in the
worktree).

## `edges[]`

```yaml
edges:
  - id: e_001
    source: { nodeId: in_target, portName: target_file }
    target: { nodeId: a_worker, portName: target_file }
```

Multiple edges into the same target port are concatenated with a
`---` separator before substituting into the prompt template.

## Validation

`POST /api/workflows/:id/validate` runs 13 rules covering missing nodes /
ports, topology cycles, empty / mis-configured wrappers, agent + skill
existence, duplicate `input.key`s, and unresolved `{{port}}` references in
prompts. The launcher refuses to start a task if validation fails.
