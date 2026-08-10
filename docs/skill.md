# Skill reference

A **skill** is a directory of markdown the platform hands to an agent. Unlike
agents, **the filesystem is the source of truth**: the DB only indexes
`name → path`.

> **How a skill actually reaches the agent (RFC-224 / RFC-251).** The
> production path does **not** populate `OPENCODE_CONFIG_DIR/skills/<name>/`
> and does not use OpenCode's on-disk skill registry at all. Per run the
> platform snapshots the whole skill tree (no symlinks) into the run seal at
> `<runRoot>/opencode-identity-seal/skills/<sha256(skillId)[:24]>`, and injects
> **`SKILL.md`'s body only** into the agent's system prompt as a digest-tagged
> `<aw-frozen-skill …>` block. See `services/runtime/opencode/verifiedPlan.ts`.
>
> **Consequence — auxiliary files are effectively unreachable today.** The
> sealed tree is bind-mounted read-only for the `bash` child, but nothing tells
> the agent its path (no env var, no line in the frozen block), and the netless
> profile masks `$HOME` and `~/.agent-workflow`, so the agent cannot find the
> files by searching either. Measured 2026-08-10: an agent reliably quotes a
> marker line from `SKILL.md` and reliably reports `MISSING` for the same kind
> of marker in a sibling `reference.md`. **Put everything the agent must read
> into `SKILL.md`**; treat other files as human-facing until this is closed
> (tracked in `docs/audit-backlog.md`).

## Source kinds

Skills are **managed-only** since RFC-178: they live under
`~/.agent-workflow/skills/<id>/files/` and the daemon writes / edits them via
the API. The former `external` source kind (symlink a directory the user
already has) has been removed — the verified execution path rejects external
skills rather than inheriting them.

## Layout

```
~/.agent-workflow/skills/<id>/
└── files/
    ├── SKILL.md            # frontmatter + body (required, and the ONLY part
    │                       # the agent actually reads at runtime today)
    ├── examples/
    │   ├── good.ts
    │   └── bad.ts
    └── README.md           # human-facing; not reachable from the agent yet
```

`SKILL.md` is the only required file. Everything else under `files/` is part
of the snapshot and of the tree digest that fixes the run's execution identity
— so editing an auxiliary file _does_ change the digest — but see the box
above: nothing currently hands the agent a path into that snapshot, so
auxiliary files do not participate in what the model sees.

## SKILL.md frontmatter

```yaml
---
name: lint # ^[a-z0-9][a-z0-9_-]*$, must match dir name
description: TypeScript lint rules…
# anything else round-trips through frontmatterExtra
---
# Body markdown — what opencode reads as the skill.
```

| Field         | Type   | Required | Notes                           |
| ------------- | ------ | -------- | ------------------------------- |
| `name`        | string | yes      | URL-safe slug                   |
| `description` | string | yes      | Shown in pickers; not in prompt |

## CRUD

Managed skills:

| Method | Path                        | Body                                              |
| ------ | --------------------------- | ------------------------------------------------- |
| GET    | `/api/skills`               | —                                                 |
| GET    | `/api/skills/:name`         | —                                                 |
| POST   | `/api/skills`               | `CreateManagedSkill` — creates the dir + SKILL.md |
| PUT    | `/api/skills/:name`         | `UpdateSkill` — DB-only metadata                  |
| PUT    | `/api/skills/:name/body`    | `{ bodyMd }`                                      |
| GET    | `/api/skills/:name/files`   | recursive listing                                 |
| GET    | `/api/skills/:name/files/*` | read a file                                       |
| PUT    | `/api/skills/:name/files/*` | write a file                                      |
| DELETE | `/api/skills/:name/files/*` | delete a file                                     |
| DELETE | `/api/skills/:name`         | unregister (409 if any agent references)          |

There is no external-skill import API. `POST /api/skills/import-external` and
the old symlink-backed source kind were removed by RFC-178.

## Per-run projection

Each selected managed skill is snapshotted into the node run's immutable
identity seal. The runner does not copy it into `OPENCODE_CONFIG_DIR`, create a
discoverable symlink, or expose the managed source tree. OpenCode's repo-local
and user-global skill registries are disabled on this verified path; the
digest-tagged prompt block is the only model-facing skill registry.

The snapshot root and its current auxiliary-file reachability limitation are
described at the top of this page. Do not rely on the pre-RFC-224 staging model
when authoring or debugging a skill.
