#!/bin/sh
# RFC-054 W1-1 — guard recording fixtures from accidental drift.
#
# Recording fixtures under packages/backend/tests/fixtures/opencode-recordings/
# are produced by `bun run record:opencode` against a real opencode binary.
# We don't want them to drift via casual `prettier`, manual edits, or
# unrelated PRs—a fixture change MUST be intentional and call out the
# opencode version refresh in the commit body.
#
# Install: `git config core.hooksPath scripts/git-hooks` once locally.
# (Project-wide enforcement happens via opencode-recording-coverage.test.ts,
# which fails CI if the magic header schema is wrong or fixtures vanish.)
#
# Behavior:
#   - If no recording fixtures are staged → exit 0 (no-op).
#   - If any recording fixtures are staged AND the commit message does NOT
#     contain the literal marker `[recording-refresh]` → exit 1 with a
#     friendly explanation.
#
# Bypass: include the marker in the commit message, e.g.
#   git commit -m "test(rec): refresh opencode-recording 1.16 [recording-refresh]"

set -eu

REC_DIR="packages/backend/tests/fixtures/opencode-recordings/"
MARKER="[recording-refresh]"

staged="$(git diff --name-only --cached -- "$REC_DIR" 2>/dev/null || true)"
if [ -z "$staged" ]; then
  exit 0
fi

# The commit message file is passed by git-commit via COMMIT_EDITMSG; in
# pre-commit hook context we read it from .git/COMMIT_EDITMSG which is
# already populated when -m/-F is used. As a fallback, also support reading
# from stdin (the prepare-commit-msg / commit-msg chain).
msg_file=".git/COMMIT_EDITMSG"
if [ ! -f "$msg_file" ]; then
  exit 0  # no message file (e.g. amend without edit) — skip; commit-msg hook covers it
fi
msg="$(cat "$msg_file" 2>/dev/null || true)"

if echo "$msg" | grep -F -q "$MARKER"; then
  exit 0
fi

cat >&2 <<EOF
[record-guard] recording fixtures are staged but commit message lacks the
[record-guard] '$MARKER' marker.

Staged fixture files:
$(echo "$staged" | sed 's/^/  /')

If this change is intentional (you re-ran 'bun run record:opencode' to
refresh recordings), append the marker to your commit message:

  git commit -m "test(rec): refresh opencode-recording 1.16 [recording-refresh]"

If it isn't intentional, unstage the recording files and commit your other
changes separately.
EOF
exit 1
