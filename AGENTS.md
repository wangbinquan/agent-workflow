# Repository agent instructions

- Before starting work, read `CLAUDE.md` and `STATE.md`, then follow the current repository guidance in those files.

## Commit attribution

- When an AI coding agent materially contributes to a commit, append a standard Git co-author trailer using the actual agent or model name and its provider's noreply email:
  `Co-Authored-By: <agent-or-model-name> <provider-noreply-email>`
- For Claude Fable 5, use exactly:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Replace every placeholder with the contributing session's real values. Do not hard-code one vendor, product, model, or email for all agents, and do not attribute a commit to an agent that did not materially contribute.
- If multiple agents materially contributed to one commit, add one non-duplicated `Co-Authored-By` trailer per contributing agent.
- Do not add an agent co-author trailer to a human-only commit.
- After committing and before pushing, verify the trailer with `git show -s --format=%B HEAD`. If a required trailer is missing, fix it before push; do not rewrite already-pushed shared history solely to add or change attribution.
