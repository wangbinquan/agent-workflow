# Repository agent instructions

- Before starting work, read `CLAUDE.md` and `STATE.md`, then follow the current repository guidance in those files.

## Commit attribution

- When an AI coding agent creates a commit, append an `Assisted-By` trailer that identifies the actual agent product and, when available, the active model or runtime identifier:
  `Assisted-By: <agent-product> (<model-or-runtime-id>)`
- Replace every placeholder with the committing session's real values. Do not hard-code one vendor, product, or model for all agents, and do not invent an identifier that the session does not expose.
- If no model or runtime identifier is available, use `Assisted-By: <agent-product>` instead.
- If multiple agents materially contributed to one commit, add one non-duplicated `Assisted-By` trailer per contributing agent.
- Do not add an agent trailer to a human-only commit.
- After committing and before pushing, verify the trailer with `git show -s --format=%B HEAD`. If a required trailer is missing, fix it before push; do not rewrite already-pushed shared history solely to add or change attribution.
