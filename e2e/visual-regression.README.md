# visual-regression — 47 pixel baselines

Specs: `e2e/visual-regression.spec.ts` and `e2e/rfc250-visual-states.spec.ts`. Baselines live in each
spec's `*-snapshots/` directory. Coverage belongs to RFC-054/198/199/219/246/249/250.

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

| Viewport         | Scenes                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1536×900 desktop | workflow editor with palette and inspector rails                                                                                                                            |
| 1440×900 desktop | RFC-249 repository-group editor with 20 flat repos and a selected three-level node                                                                                          |
| 1280×800 desktop | auth, agents, workflows, repos, memory, settings, onboarding, seeded homepage, tasks, three inbox states, editor light/dark, open runtime-parameter picker, dynamic preview |
| 1179×800 compact | workflow editor palette and inspector side modals, plus the RFC-219 50-Agent Human category in dark mode                                                                    |
| 736×900 compact  | RFC-249 repository-group inline node settings                                                                                                                               |
| 390×844 mobile   | seeded home + navigation, workflow gallery, agent split detail, settings, task detail, editor modes, open Webhook runtime-parameter picker, RFC-249 batch mode              |

The 33 scenes each own a full-page baseline. Five focused locator baselines lock
mobile navigation open, a real overflowing TableViewport edge, an empty state, a
Dialog footer, and the deterministic dynamic-workflow preview canvas so the
full-page 0.2% threshold cannot hide a small but important local regression.

RFC-250 adds nine populated high-risk baselines: PAT permission matrix and masked reveal; Task
Wizard dirty guard at desktop and 390px; complex Workflow readable and explicit-overview cameras;
Clarify local-only durability; grouped Changes navigation; and Agent resource-integrity feedback.
Five are full-page locks and four are focused dialog/panel locks. Together with the canonical
suite's 33 full-page and five focused baselines, the entry point compares 47 PNGs.

RFC-250 also deliberately refreshes six canonical baselines. `mobile-settings-network` records the
44px coarse/mobile Switch target. The five `workflow-editor-*` baselines record readable-first
camera behavior, the screen-space Add/View full graph/Focus selection toolbar, restored Validate,
and post-layout focus that keeps an explicitly selected node visible after the Inspector opens.

RFC-295 refreshes the five selected-Agent editor baselines after removing the always-expanded
Webhook token wall. It also adds a desktop open-picker scene and a 390px Webhook Agent open-picker
scene so the classified label/token/explanation rows, portal placement, and mobile clamp are locked.

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

Each authorized UI publication must run step 3 locally and confirm the diff is zero (or include
reviewed baseline refreshes in the same exact-path commit).

## CI workflow

`.github/workflows/visual-regression-nightly.yml` runs:

- **schedule** `0 9 * * *` UTC daily (15 min after git-protocols nightly).
- **workflow_dispatch** for ad-hoc verification after a UI change.
- **pull_request** and **push to main** when the diff touches `packages/frontend/**`, either visual
  spec or snapshot directory, or the workflow itself.

The CI runs on pinned **Ubuntu 24.04 (Noble)** and compares against the committed
`*-chromium-linux.png` baselines.

## Generating GitHub-hosted Ubuntu baselines (first-time / refresh)

Two options:

### Option A — let the pinned GitHub runner produce artifacts (preferred)

1. After local and independent gates pass, make the authorized exact-path commit and push it to
   `main`.
2. The path-filtered hosted run fails when new Linux baselines are missing or existing ones differ.
3. Download the workflow's failure artifact, which contains the _actual_
   screenshots written by the failed run.
4. Inspect every changed PNG and reject unexplained layout movement; never accept the artifact as a
   bulk mechanical update.
5. Copy each accepted PNG into the snapshot directory owned by its spec
   (`e2e/visual-regression.spec.ts-snapshots/` or
   `e2e/rfc250-visual-states.spec.ts-snapshots/`), commit, push.
6. Require the new exact-SHA hosted run to pass with zero diff.

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

- Arbitrary user-arranged workflow graphs beyond the fixed RFC-199 fixtures and RFC-250's
  deterministic 15-node camera topology.
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
