# Skill reference

A **skill** is a directory of Markdown and optional supporting files that a runtime
can load for an Agent. Managed skill content lives on disk; the database indexes
its identity, metadata, ACL and content revision.

## Source kinds

Agent references have two forms:

- `managed`: a platform resource with a DB row, ACL and managed files directory;
- `project`: a name that the selected runtime discovers from the task worktree.

The Skill CRUD API manages only the first kind. Project skills are not platform
resources and have no DB row, owner or ACL.

## Layout

```
~/.agent-workflow/skills/<id>/
└── files/
    ├── SKILL.md
    ├── references/
    │   └── api.md
    ├── examples/
    │   └── example.ts
    └── README.md
```

`SKILL.md` is required. Supporting files are copied with the selected managed
skill so the runtime can read them. A directory named `.claude-plugin` is excluded
from the staged copy because plugins are a separate resource type and can declare
hooks, agents and MCP servers.

## SKILL.md frontmatter

```yaml
---
name: lint
description: TypeScript lint rules…
---
# Body markdown
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Must match `^[a-z0-9][a-z0-9_-]*$` |
| `description` | string | yes | Shown in resource pickers |
| other keys | any YAML | no | Round-trip through `frontmatterExtra` |

## Runtime delivery

For OpenCode, selected managed skills are copied to the current runtime config at
`skills/<name>/`; OpenCode discovers project skills from the worktree normally.

For Claude Code, the platform:

- renders each managed skill into the system prompt with its attachment root and
  supporting-file list;
- temporarily projects the same sanitized directory into the disposable task
  worktree for native skill discovery, then removes only the directories it created;
- leaves machine and project skills available through Claude Code's normal discovery.

The projection is a compatibility mechanism, not an immutable snapshot or sandbox.
Changes to a managed skill after dispatch are still fenced by the platform's resource
revision checks before assembly.

## CRUD

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/skills` | list visible managed skills |
| GET | `/api/skills/:id` | read metadata |
| POST | `/api/skills` | create a managed skill and `SKILL.md` |
| PUT | `/api/skills/:id` | update metadata |
| PUT | `/api/skills/:id/content` | update frontmatter/body with OCC token |
| GET | `/api/skills/:id/files` | recursively list supporting files |
| GET/PUT/DELETE | `/api/skills/:id/files/*` | read, write or delete a supporting file |
| DELETE | `/api/skills/:id` | delete when no Agent still references it |

External symlink-backed skills and the former import-external API remain removed.
