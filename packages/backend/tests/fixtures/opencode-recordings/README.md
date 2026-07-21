# opencode-recordings — protocol-guard fixtures (RFC-054 W1-1)

Each `.ndjson` file is a captured `opencode run ... --format json` session.
The first line is a magic recording header
(`{"__recording__":{...}}`); subsequent lines are opencode's raw stdout
events. Files are committed to git so CI replays them through the
runner's protocol parsers (`extractTextFromEvent` / `inferEventKind` /
`accumulateTokens` / `extractLastEnvelope` / `parseEnvelope`) on every
build.

## Why

Stub binaries (`e2e/fixtures/stub-opencode*.sh`) keep our e2e suite cheap
and deterministic, but they can drift away from real opencode's stdout
shape unnoticed (the 1.14.51 `PWD` regression caught us this way — see
[STATE.md "前序 — 2026-05-20"](../../../../../STATE.md)). These
recordings are the structural ground truth: any change in opencode's
event vocabulary or `tokens` schema fails
`opencode-recording-parser.test.ts` immediately.

## Adding / refreshing a recording

```sh
bun run record:opencode \
  --prompt "Reply with exactly: hello" \
  --out   packages/backend/tests/fixtures/opencode-recordings/1.15.5-text-only.ndjson \
  --id    text-only \
  [--expected-envelope '<workflow-output><port name="answer">42</port></workflow-output>'] \
  [--agent default-build]
```

Required: `--prompt`, `--out`, `--id`. The script:

1. Probes `opencode --version` (fails fast if missing).
2. Creates a throwaway git repo cwd (or accepts `--cwd path/to/repo`).
3. Spawns `opencode run "<prompt>" --format json` plus the version-matched
   auto-approve flag (`--auto` on opencode ≥1.18, `--dangerously-skip-permissions`
   below — the 1.18 rename removed the legacy spelling).
4. Writes the magic header + captured stdout to `--out`.

Filename convention: `<opencodeVersion>-<recordingId>.ndjson`.

## Re-recording requires commit-message marker

`scripts/git-hooks/pre-commit-recording.sh` refuses commits that touch
fixture files unless the message contains the literal `[recording-refresh]`
marker. To enable the hook locally:

```sh
git config core.hooksPath scripts/git-hooks
```

The marker is also the conventional way for reviewers to spot intentional
fixture updates in PRs.

## What each fixture exercises

| File                          | Exercises                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `1.15.5-text-only.ndjson`     | Bare text reply path: `step_start` + `text` part + `step_finish`. No `<workflow-output>` envelope; `extractLastEnvelope` must return `null`. |
| `1.15.5-with-envelope.ndjson` | Reply containing a single-port `<workflow-output>` envelope; `parseEnvelope` must bind `answer` cleanly with no missing / undeclared ports.  |

Two fixtures is the minimum DoD for RFC-054 W1-1. When bumping the pinned
opencode version, add a new pair (e.g. `1.16.0-text-only.ndjson` +
`1.16.0-with-envelope.ndjson`) and update
`packages/backend/src/util/opencode.ts` if any field in the magic header
schema needs to evolve.
