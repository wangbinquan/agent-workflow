# integration-opencode — live OpenCode + LLM integration suite

Tests in this directory spawn the real `opencode` CLI in the operator's natural
environment. They catch upstream drift in CLI flags, event shapes, accumulated text,
envelope parsing and token accounting.

## Gate behavior

The live LLM cases run only when both conditions are true at process start:

1. `RUN_OPENCODE_INTEGRATION=1`;
2. OpenCode authentication is reachable through `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `OPENCODE_AUTH_CONTENT`, or the user's ordinary
   `~/.config/opencode/auth.json`.

Without both, those cases are skipped and make no LLM calls. Two non-LLM cases run
unconditionally to verify the gate semantics and that this README remains present.

## Running locally

```sh
RUN_OPENCODE_INTEGRATION=1 bun test \
  packages/backend/tests/integration-opencode/
```

To test another executable:

```sh
OPENCODE_BIN=/opt/opencode/bin/opencode \
  RUN_OPENCODE_INTEGRATION=1 \
  bun test packages/backend/tests/integration-opencode/
```

Expected wall-clock is roughly 30–60 seconds when credentials are configured.

## CI

`.github/workflows/integration-opencode.yml` runs daily and when OpenCode-facing
runtime code changes. Its matrix samples historical `1.18.3` behavior and the current
npm channel; this is compatibility coverage, not a version allowlist.

The workflow installs OpenCode and project dependencies only. It does not install
bubblewrap or run verified/sandbox supervisors. Runtime children inherit the job's
normal HOME, provider configuration, authentication, filesystem access and network.

Repository secrets are optional. Configure either a provider API key or the complete
`OPENCODE_AUTH_CONTENT` JSON to enable live calls; otherwise the gate self-tests still
run and the LLM cases remain skipped.

## When a test goes red

1. Reproduce with the same `OPENCODE_BIN` and authentication source.
2. Compare raw CLI stdout/stderr with the driver parser.
3. Check whether the upstream release changed a flag or event schema.
4. Update compatibility code and fixtures together; do not add a version admission
   rule or reintroduce a verified execution path.
