// Playwright configuration for the v1 e2e (P-5-07, expanded in RFC-054 W1-8).
//
// RFC-054 W1-8 — cross-file parallelism + cross-browser:
//   * `workers: 4` — each spec spawns its own daemon via e2e/harness.ts on a
//     random ephemeral port (`bindPort: 0`) into a fresh `mkdtempSync` home,
//     so workers never share state across *files*. We deliberately leave
//     `fullyParallel` at the default false because many specs use a single
//     `test.beforeAll` to launch one task and then assert on it across
//     several ordered tests (e.g. lifecycle-diagnose.spec.ts plants a DB
//     violation in test 2 that test 1 expects to be absent). Intra-file
//     parallelism would race them.
//   * Two projects: `chromium` (PR-gating default) + `webkit` (opt-in via
//     `PLAYWRIGHT_WEBKIT=1`, used by the nightly cron). Default `bun run e2e`
//     stays chromium-only so PR CI cost / wall-clock doesn't double; webkit
//     coverage runs daily and surfaces Safari-specific selector / focus /
//     animation drift without blocking iteration speed.
//   * CI shard via `--shard=N/M` (built-in Playwright flag) — see
//     e2e/README.md for the sharding contract. The CI `e2e` job sets a
//     `matrix.shard` so each runner picks one quarter of the suite.
//
// The spec spawns its own daemon via e2e/harness.ts so the binary path
// and stub-opencode wiring stay co-located with the test.

import { type PlaywrightTestConfig, defineConfig, devices } from '@playwright/test'

const canonicalDesktopViewport = { width: 1280, height: 800 }

// Default project list: chromium-only (PR-gating). Webkit is added only when
// PLAYWRIGHT_WEBKIT=1 (nightly cron + opt-in local runs). Keeping webkit
// behind a flag means the default `bun run e2e` invocation stays fast and
// the CI matrix's wall-clock budget doesn't double — webkit is treated as
// a periodic sanity sweep rather than a PR-blocker.
const projects: NonNullable<PlaywrightTestConfig['projects']> = [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], viewport: canonicalDesktopViewport },
  },
]
if (process.env.PLAYWRIGHT_WEBKIT === '1') {
  projects.push({
    name: 'webkit',
    use: { ...devices['Desktop Safari'], viewport: canonicalDesktopViewport },
  })
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts$/,
  // The happy-path spec walks through agent / workflow / launch / detail; the
  // task itself usually finishes in <5s with the stub, but xyflow loading and
  // i18n bootstrapping eat ~3-5s on cold start. 90s gives plenty of headroom
  // for CI runners.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Cross-file parallelism only: each spec spawns an isolated daemon (random
  // port, temp home), so workers never share state across *files*. We
  // intentionally leave `fullyParallel` at the default false so tests *within*
  // a file stay serial — most files use `test.beforeAll` to launch one task
  // and then assert against it across multiple tests in a specific order
  // (e.g. lifecycle-diagnose.spec.ts plants a DB violation in test 2 that
  // test 1 expects to be absent). Intra-file parallelism would race them.
  //
  // 4 workers gives ~3-4× speedup over single-worker on chromium without
  // burning RAM on cold xyflow boots. CI gets two levels of parallelism:
  // `shard` matrix outside (≥ 2 shards) × `workers: 4` inside.
  workers: 4,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    headless: true,
    viewport: canonicalDesktopViewport,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    video: process.env.CI ? 'retain-on-failure' : 'off',
  },
  projects,
})
