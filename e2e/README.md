# e2e/ — Playwright end-to-end suite

Drives the separately compiled test binary
(`dist/agent-workflow-e2e-<plat>-<arch>`) against deterministic OpenCode and
Claude Code protocol stand-ins and walks the embedded frontend in a headless
browser. The test artifact differs
from the shipped binary by one compile-time-only dependency-injection seam;
there is no runtime env/config/HTTP switch that can enable it in production.
Each spec spawns its own daemon via [`harness.ts`](./harness.ts) into a
fresh temp `AGENT_WORKFLOW_HOME` on a random ephemeral port, so specs are
hermetic — no shared SQLite, no shared port, no cross-test pollution.

## Quick start

```sh
bun install
bun run build:binary:e2e       # produces production + test-only e2e binaries
bun run e2e                    # 4 workers, chromium only, ~22s on M2
```

The harness throws "binary not found" if you forget the build step — set
`AGENT_WORKFLOW_E2E_BINARY=/path/to/binary` to override.

For the complete task-execution matrix, historical-task scenario format, and
the opt-in pre-release gate against real OpenCode + Claude Code, see
[`CAPABILITY_COVERAGE.md`](./CAPABILITY_COVERAGE.md).

## Parallelism model (RFC-054 W1-8)

Two levels of parallelism stack:

1. **Workers (process-level, in [`playwright.config.ts`](../playwright.config.ts))** —
   `workers: 4` runs four spec files concurrently. We deliberately leave
   `fullyParallel` at its default `false` so tests _within_ one file
   stay serial: many files use a single `test.beforeAll(async () => …)`
   to launch one task and then assert across multiple ordered tests
   against it (e.g. [`lifecycle-diagnose.spec.ts`](./lifecycle-diagnose.spec.ts)
   plants a DB violation in test 2 that test 1 expects to be absent —
   intra-file parallelism would race them).
2. **Shards (CI matrix-level, in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml))** —
   main CI uses `M=3` on Ubuntu and `M=4` on macOS/Windows. Playwright's native
   `--list --reporter=json` first discovers the exact chromium/tier/platform
   population. `scripts/ci/plan-e2e-shards.ts` assigns complete spec files using
   the platform's committed timing estimates, then `playwright.ci.config.ts`
   runs that exact subset without applying native `--shard` a second time.
   The reporter checks the executed test identities against the plan. File-local
   `test.beforeAll`, ordered-test semantics, four workers and retries stay intact.
   Local default runs and other nightly workflows retain native sharding.

The initial `.github/e2e-test-timings.json` values are estimates reconstructed
from successful run 45772006810, not exact hook-inclusive benchmark results.
New specs enter discovery automatically and receive a 60-second fallback
weight until measured. Each CI shard uploads `e2e-test-timings-<OS>-<N>` with
its plan and measured file windows; incomplete/failed measurements must not
replace the committed weights. Timing changes affect placement only, never
which tests are covered. See [RFC-611](../design/RFC-611-ci-throughput-and-stability/design.md).

CI wall-clock today (RFC-054 W1-8 baseline):

| Layer       | Mode                 | Wall-clock          |
| ----------- | -------------------- | ------------------- |
| Single proc | `workers=1`          | ~50s (chromium, 36) |
| Workers     | `workers=4`          | ~22s (chromium, 36) |
| Shards      | `shard×workers` × OS | ~15s per shard      |

## Running a subset locally

| Goal                           | Command                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| All chromium tests             | `bun run e2e`                                                    |
| One spec file                  | `bun run e2e e2e/main.spec.ts`                                   |
| One test (substring match)     | `bun run e2e -g "happy path"`                                    |
| Native diagnostic shard        | `bun run e2e -- --shard=1/4`                                     |
| All native shards sequentially | `for i in 1 2 3 4; do bun run e2e -- --shard=$i/4; done`         |
| Single worker (debug a race)   | `bun run e2e -- --workers=1`                                     |
| Headed (visible browser)       | `bun run e2e -- --headed`                                        |
| With stdout/stderr forwarded   | `E2E_VERBOSE=1 bun run e2e`                                      |
| UI trace viewer post-failure   | `bunx playwright show-trace test-results/.../trace.zip`          |
| Runtime parity only            | `bun run e2e -- e2e/runtime-scenario-matrix.spec.ts --workers=1` |
| Real runtimes before release   | `bun run e2e:release-runtimes`                                   |

The `bun run e2e -- <flag>` double-dash is required so the flag reaches
Playwright, not bun's script runner.

## Cross-browser (webkit)

Webkit coverage is **opt-in** to keep PR CI wall-clock predictable. The
default `bun run e2e` runs chromium only. To exercise webkit:

```sh
# One-time: download the Safari-equivalent engine (~75 MB).
bunx playwright install webkit

# Each run: enable the webkit project + pick it explicitly.
PLAYWRIGHT_WEBKIT=1 bun run e2e -- --project=webkit
```

`PLAYWRIGHT_WEBKIT=1` registers the webkit `project` in
`playwright.config.ts`; `--project=webkit` then filters Playwright to
that project only (without the filter, both chromium _and_ webkit run,
doubling wall-clock).

CI runs webkit on a nightly cron (see
[`.github/workflows/e2e-webkit-nightly.yml`](../.github/workflows/e2e-webkit-nightly.yml))
so Safari-specific selector / focus-trap / animation regressions get
caught daily without slowing every PR. If a webkit-only failure shows up
nightly, reproduce locally with the commands above.

## Debugging a failure

CI uploads `test-results/` + `playwright-report/` as `playwright-trace-<os>-shard<N>`
artifacts when any test fails. Download, unzip, then:

```sh
bunx playwright show-trace path/to/trace.zip
```

Locally, failed runs already leave traces in `test-results/<spec-name>/trace.zip`
because `trace: 'retain-on-failure'` is set for non-CI runs in the config.

## Adding a new spec

1. New file `e2e/<feature>.spec.ts`.
2. Import `startDaemon` from `./harness` and call it in `test.beforeAll`.
3. Build fixtures via the HTTP API (don't bypass — that's a worse contract
   than the spec).
4. Run `bun run e2e e2e/<feature>.spec.ts` until green locally.
5. Verify it passes on webkit too: `PLAYWRIGHT_WEBKIT=1 bun run e2e -- --project=webkit -g "<test name>"`.
6. CI shard assignment is derived from the discovered file-level test groups;
   no manual update is needed unless you have a reason to pin a spec to a
   particular shard (you don't).

## Why workers can't be higher than 4 today

The xyflow canvas takes ~3-5s of CPU during cold mount + each daemon
starts a Bun process with full bundle eval. On an M2 with 8 CPUs, 4
concurrent boots saturates the CPU; pushing to 6+ shows diminishing
returns and increases the chance of `expect.timeout` flakes on slow
runners. CI runners are 2-core ubuntu / 3-core macOS, so 4 workers
matches actual core count. If we ever switch to faster daemon startup
(e.g. caching the bundled binary boot), revisit.
