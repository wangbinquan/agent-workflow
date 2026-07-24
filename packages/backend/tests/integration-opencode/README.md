# integration-opencode — live opencode + LLM integration suite (RFC-054 W2-1)

Tests in this directory spawn the **real** `opencode` binary and let it make
**real** LLM calls. Their value: catch upstream drift across opencode releases
before it corrupts the daemon's runtime path — a new event-shape, an envelope
mangling, or a `--version` rename would silently break the platform if all
our coverage used recorded fixtures.

| File                                              | Cases | What it locks                                                                                                                                                                                           |
| ------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode-identity-preflight.integration.test.ts` | 1     | Exact official v1.18.3 bytes and config/provider/agent/skill/root-session shapes; on Linux, real bwrap/FFF plus freeze-lease TERM/KILL containment of a TERM-resistant setsid double-fork. No LLM call. |
| `opencode-live.integration.test.ts`               | 5 + 2 | `--version` / event-kind shape / accumulated text / envelope round-trip / token accumulator. Plus 2 gate-self-tests.                                                                                    |

## How the gate works

The official no-LLM identity preflight runs whenever
`RUN_OPENCODE_INTEGRATION=1`; it does not need credentials and never posts a
prompt. On Linux, the same case also enters a real private PID namespace,
launches a TERM-resistant setsid + double-fork descendant, and requires one
nonce-bound `READY` → `ARMED` handshake. The Python anchor then SIGSTOPs the
exact bwrap child, confirms the stop with `waitpid(WUNTRACED)` and unchanged
PGID, and emits `FROZEN`. Only while that freeze lease is held does the host
send TERM to the actual negative process group and commit the signal; the
anchor SIGCONTs the exact child and uses exact `waitpid` status to prove a
SIGTERM exit (`TERM_RELEASED` → `TERM_OBSERVED`). Completion additionally
requires direct-leader settlement, latching the first observed ESRCH for the
negative PGID, and EOF on stdout held by the controlled descendants.
`SURVIVED` or `WATCHDOG` is an explicit failure frame. The normal control pipe
remains open until the anchor group is naturally killed/reaped, and cleanup
never re-probes or signals an already-absent leader's old numeric PGID.
bwrap/Python stderr remains in the Actions step log for diagnosis.

The production path uses four help-hidden verified-self commands:
`__opencode-verified-run`, `__opencode-netless-subprocess`,
`__opencode-bwrap-capability-supervisor`, and
`__opencode-fff-capability-supervisor`. The two native supervisors use
nonce-bound `EXIT`/`RESULT` → `ACK` plus control EOF → `RELEASE`, then
self-terminate their negative process group with SIGKILL. A valid observation
requires one monotonic absolute deadline, protocol stdout EOF, raw exit 137,
and a monotonically latched first observed ESRCH; FFF also waits for both probe
stdout and stderr EOF before reporting RESULT. The parent relinquishes
numeric-PGID signal ownership before the first ACK byte and never signals after
release. Compiled smoke locks the corresponding pre-ACK empty buffer, ACK-EOF
boundary, and wrong-nonce failure paths.

Live LLM tests are **opt-in**. They run only when BOTH conditions hold at process
start (probed at module load):

1. `RUN_OPENCODE_INTEGRATION=1` is set in the environment.
2. opencode auth is reachable — one of:
   - `ANTHROPIC_API_KEY` env var
   - `OPENAI_API_KEY` env var
   - `OPENCODE_AUTH_CONTENT` env var holding the JSON blob (matches
     opencode source `packages/opencode/src/auth/index.ts:58`)
   - a pre-existing `~/.config/opencode/auth.json`

Without both, the live LLM cases are `skipIf`'d and `bun test` reports them as
skipped — no LLM calls or charges. The no-LLM preflight still runs whenever
condition 1 is set.

Two non-LLM cases run unconditionally to verify the gate semantics
themselves and that the README isn't accidentally deleted.

## Running locally

Once `opencode auth login anthropic` (or similar) has been done on this
machine — i.e. `~/.config/opencode/auth.json` exists — turning the suite on
is one flag:

```sh
RUN_OPENCODE_INTEGRATION=1 bun test \
  packages/backend/tests/integration-opencode/
```

Expected wall-clock: 30-60 seconds (5 LLM calls × 3-15s each).

To override the opencode binary path with the reviewed official v1.18.3 build:

```sh
OPENCODE_BIN=/opt/opencode-1.18.3/bin/opencode \
  RUN_OPENCODE_INTEGRATION=1 \
  bun test packages/backend/tests/integration-opencode/
```

## How CI runs it

`.github/workflows/integration-opencode.yml` runs daily (07:30 UTC cron),
on pushes to `main`, and on PRs that touch the daemon's opencode-facing code (path filter:
`packages/backend/src/services/runner.ts`, `services/envelope.ts`,
`services/protocol.ts`, this directory, or the workflow itself).

Matrix:

| OS           | opencode                                               |
| ------------ | ------------------------------------------------------ |
| ubuntu-22.04 | exact reviewed `opencode-ai@1.18.3` RFC-224 trust root |

The runner label is explicit because the preflight requires a real
unprivileged bubblewrap namespace trial; a moving `ubuntu-latest` label is not
an authoritative sandbox capability.

Secrets are optional for the no-LLM preflight and are used only by the live-LLM
cases — see "Setting up CI secrets" below.

## Setting up CI secrets

The integration workflow needs LLM credentials to invoke opencode. Two
acceptable paths:

### Path A — single provider env var (simplest)

Add an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) repository secret in
GitHub Settings → Secrets and variables → Actions. The workflow then
exports it as `env.ANTHROPIC_API_KEY` and opencode's LLM layer reads
it directly (matches opencode source `packages/llm/test/provider/anthropic-messages.recorded.test.ts:12`).

### Path B — full auth blob (multi-provider)

Add an `OPENCODE_AUTH_CONTENT` repository secret containing the entire
`~/.config/opencode/auth.json` contents (JSON-encoded; remember to
JSON-escape inner quotes if pasting into the GitHub UI). The workflow
exports it and opencode parses on startup (opencode source
`packages/opencode/src/auth/index.ts:58`).

Either path is enough; the gate prefers env vars over file paths. If
NEITHER is set, the workflow will run but every LLM test will skip —
the CI run will report green (since the 2 gate-self-tests still pass),
which is the desired graceful-degradation state.

## Cost / flakiness budget

| Knob              | Default             | Why                                                                                                                                    |
| ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 5 LLM cases       | per workflow        | Plan target ≥ 5; each tightly scoped to one drift surface                                                                              |
| timeout 120s/case | per test            | Real LLM 99p ~15s; 120s tolerates outliers without hanging the job                                                                     |
| retries           | implicit (bun test) | Bun test doesn't auto-retry, but transient LLM 429 / network blips are rare; if needed, wrap a case in a small retry loop              |
| Matrix OS legs    | one — ubuntu only   | Linux runs mandatory real bwrap FFF and cancellation/orphan containment; macOS official-byte preflight is covered locally/release-side |

Expected daily LLM cost: ~5 calls × ~$0.005 = ~$0.025/day = ~$9/year.

## When a test goes red

The order to debug:

1. **Read the stderr tail** — `RunResult.stderrTail` is captured into the
   bun:test failure output. opencode usually surfaces auth / network /
   provider issues there.
2. **Check the opencode version and bytes** — `OPENCODE_BIN --version`. RFC-224
   refuses any version/platform/arch digest outside the reviewed allowlist.
3. **Re-run with verbose** — `OPENCODE_DEBUG=1` (if the version supports
   it) prints prompt + response to stderr. Compare the raw stream against
   `RFC-054 W1-1` recordings to see what shape changed.
4. **Don't disable** — these tests guard the daemon's runtime contract.
   If opencode genuinely broke compat, review a new official build/codec tuple
   through a follow-up RFC and update the exact allowlist. Don't skip.

## Adding a new case

1. Add the test inside `describe.skipIf(SKIP)('RFC-054 W2-1 — real opencode integration')`.
2. Wrap the case in `test(name, async () => {…}, 120_000)` — the 120s
   timeout is intentional; the default 5s is too short for an LLM call.
3. Use `runOpencode(prompt, opts)` — never spawn directly; the helper
   handles git-repo seeding, stdout buffering, JSON-line parsing, and
   stderr capture.
4. Frame the assertion around an EXISTING framework parser
   (`extractTextFromEvent`, `accumulateTokens`, `extractLastEnvelope`,
   `parseEnvelope`, `detectEnvelopeKind`, `inferEventKind`). The point
   of this suite is to lock the parser ↔ opencode interface, not to
   re-test prompt engineering.
5. Locally run with `RUN_OPENCODE_INTEGRATION=1 bun test packages/backend/tests/integration-opencode/`
   5× consecutive — any flakiness must be resolved (looser regex,
   bigger timeout) before merging.
