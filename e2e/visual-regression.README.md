# visual-regression — 26 full-page + 6 component pixel baselines (RFC-054 / RFC-198 / RFC-199 / RFC-219)

Spec: `e2e/visual-regression.spec.ts`. Baselines: `e2e/visual-regression.spec.ts-snapshots/`.

## How the gate works

The spec is **opt-in** via `RUN_VISUAL_REGRESSION=1`. Default `bun run e2e`
skips it because:

- The first run on each platform needs to GENERATE baselines (and would
  fail without them).
- Font subpixel jitter between macOS and Linux means baselines are
  platform-specific. Playwright auto-suffixes snapshots
  (`*-chromium-darwin.png` vs `*-chromium-linux.png`), but a developer
  running locally is on a different platform than CI.

Threshold: `maxDiffPixelRatio: 0.002` (0.2%) per RFC-054 plan §risk 9.

## Scenes covered

| Viewport         | Scenes                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1536×900 desktop | workflow editor with palette and inspector rails                                                                                             |
| 1280×800 desktop | auth, agents, workflows, repos, memory, settings, onboarding, seeded homepage, tasks, three inbox states, editor light/dark, dynamic preview |
| 1179×800 compact | workflow editor palette and inspector side modals, plus the RFC-219 50-Agent Human category in dark mode                                     |
| 390×844 mobile   | seeded home + navigation, workflow gallery, agent split detail, settings network form, terminal task detail, editor picker/inspector         |

The 26 scenes each own a full-page baseline. Six focused locator baselines lock
mobile navigation open, PageHeader actions, a real overflowing TableViewport
edge, an empty state, a Dialog footer, and the deterministic dynamic-workflow
preview canvas so the full-page 0.2% threshold cannot hide a small but important
local regression.

Every scene owns an isolated daemon plus an explicit light/dark and clean/seeded
fixture. This keeps a single `--grep` run equivalent to the full suite and
prevents resource or theme state leaking between screenshots.

## Running locally (darwin baselines)

```sh
# 1. Build the daemon binary the spec spawns.
bun run build:binary:e2e

# 2. Generate (or refresh) darwin baselines.
bun run test:visual -- --update-snapshots

# 3. Re-run against the committed baselines.
bun run test:visual
```

Each PR that touches UI must run step 3 locally and confirm the diff
is zero (or commit refreshed baselines in the same PR).

## CI workflow

`.github/workflows/visual-regression-nightly.yml` (added in this PR) runs:

- **schedule** `0 9 * * *` UTC daily (15 min after git-protocols nightly).
- **workflow_dispatch** for ad-hoc verification after a UI change.
- **pull_request** when the diff touches `packages/frontend/**` or this
  spec / workflow itself.

The CI runs on pinned **Ubuntu 24.04 (Noble)** and compares against the committed
`*-chromium-linux.png` baselines.

## Generating GitHub-hosted Ubuntu baselines (first-time / refresh)

Two options:

### Option A — let the pinned GitHub runner produce artifacts (preferred)

1. Open a PR branch.
2. Trigger the nightly workflow with `workflow_dispatch` against the branch.
3. The first run fails when new `-chromium-linux.png` files are missing.
4. Download the workflow's failure artifact, which contains the _actual_
   screenshots written by the failed run.
5. Copy those PNGs into `e2e/visual-regression.spec.ts-snapshots/` on
   the branch, commit, push.
6. Re-run the workflow and require a zero-diff pass.

This is the documented escape hatch in RFC-054 plan §risk 9: snapshot
update must be human-triggered, NEVER automatic on CI failure. The workflow's
`ubuntu-24.04` hosted image is the baseline authority; its complete package
inventory is maintained by
[actions/runner-images](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md).

### Option B — local Linux container (diagnostics only)

If you have docker / VM access to a Linux environment:

```sh
docker run --rm -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.60.0-noble \
  bash -lc '
    curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13" &&
    export PATH="/root/.bun/bin:$PATH" &&
    bun install --frozen-lockfile &&
    bun run build:binary:e2e &&
    bun run test:visual -- --update-snapshots
  '
```

The container tag matches the Playwright `1.60.0` browser revision in
`bun.lock`, but the Microsoft Playwright container is not the GitHub-hosted
runner image and does not guarantee the same installed fonts or rasterization.
Use it to catch gross layout changes and to inspect candidate screenshots; do
not commit container-generated Linux PNGs as authoritative baselines. Refresh
and verify the final files through Option A without raising the threshold.

## What this gate does NOT cover

- Arbitrary user-arranged workflow graphs beyond the fixed RFC-199 editor fixtures.
- Hover / focus states (only the at-rest state is snapshotted).
- Every dialog family; semantic/focus/mobile contracts live in
  `overlay-ux-inventory.test.ts`, `ux-consistency.spec.ts`, and
  `keyboard-flows.spec.ts`, while the inbox and mobile navigation provide
  representative pixel locks here.

Adding a new page to the spec: snapshot 5× consecutive locally to
confirm zero pixel diff, then commit baseline. If the first run on
ubuntu CI shows >0.2% diff, anti-alias / font fallback differences are
the likely cause — start with `text-rendering: geometricPrecision` on
the problematic surface before considering raising the threshold.
