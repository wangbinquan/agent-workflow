// RFC-198 + RFC-219 + RFC-250 — lock the non-package visual gate wiring that normal
// component tests cannot observe: scene count, reproducible Linux image, and
// direct fixtures.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { NAV_GROUPS } from '@/lib/nav'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

function repoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('RFC-198 visual infrastructure source gates', () => {
  // The shell-settle anchor in the visual spec must be the LAST nav row: the
  // sidebar's height is only final once that row has rendered, and a screenshot
  // taken earlier is short by one row in every scene that shows the sidebar.
  //
  // A stale anchor does not fail — it goes *flaky*, and the diff looks like an
  // unrelated pixel shift, so it is discovered weeks later by whoever happens to
  // be reading a red run. It has rotted once already (RFC-310 inserted a whole
  // `digitalEmployees` group ahead of the tasks group, demoting the pinned
  // `/code` row to the middle). Deriving the expectation from NAV_GROUPS turns
  // that silent rot into a red the same commit that appends a nav row.
  test('the visual shell-settle anchor is the last NAV_GROUPS row', () => {
    const source = repoFile('e2e/visual-regression.spec.ts')
    const body = source.slice(source.indexOf('async function waitForStableAuthenticatedShell'))
    const settle = body.slice(0, body.indexOf('\n}'))
    // The *last* anchor in the settle helper is the one that decides when the
    // sidebar is done; asserting mere presence would stay green while an
    // earlier row silently became the real anchor.
    const anchors = [...settle.matchAll(/a\[href\^?="([^"]+)"\]/g)].map((m) => m[1])
    const lastGroup = NAV_GROUPS[NAV_GROUPS.length - 1]!
    const lastRow = lastGroup.subnav[lastGroup.subnav.length - 1]!
    expect(anchors[anchors.length - 1]).toBe(lastRow.to)
    // Prefix match is mandatory, not stylistic: a row's rendered href may carry
    // the route's stable default search params (`/memory?tab=all`), and an
    // exact-href locator then matches nothing — every scene burns the full
    // visibility timeout and fails. This assertion exists because that is what
    // happened: 2 red scenes became 26 on the very next run.
    expect(settle).toContain(`a[href^="${lastRow.to}"]`)
  })

  test('visual spec declares exactly 44 counted scenes', () => {
    const source = repoFile('e2e/visual-regression.spec.ts')
    expect(source).toContain('const EXPECTED_VISUAL_SCENE_COUNT = 44')
    expect(source).toContain('const HOMEPAGE_VISUAL_TIME = new Date(2026, 6, 23, 14, 0, 0)')
    expect(source.match(/^\s{2}test\(/gm)).toHaveLength(44)
    expect(source).toContain('declaredVisualSceneCount !== EXPECTED_VISUAL_SCENE_COUNT')
    expect(source).toContain('async function waitForStableAuthenticatedShell(page: Page)')
    expect(source).toContain("await expect(userMenu).toContainText('e2e_admin')")
    expect(source).toContain('await page.clock.setFixedTime(HOMEPAGE_VISUAL_TIME)')
    expect(source).toContain("'workflow-node-picker-1179-large-human-dark.png'")
    expect(source).toContain("'workflow-runtime-parameter-picker-1280-light.png'")
    expect(source).toContain("'webhook-runtime-parameter-picker-390-light.png'")
    // One declaration plus five locator screenshot callsites.
    expect(source.match(/COMPONENT_SNAPSHOT_OPTS/g)).toHaveLength(6)
    for (const snapshot of [
      'mobile-nav-open.png',
      'table-edge.png',
      'empty-state.png',
      'dialog-footer.png',
      'dynamic-workflow-preview-canvas.png',
    ]) {
      expect(source).toContain(`'${snapshot}'`)
    }
  })

  test('Linux instructions match the locked Playwright and CI Noble environment', () => {
    const readme = repoFile('e2e/visual-regression.README.md')
    const lockfile = repoFile('bun.lock')
    const workflow = repoFile('.github/workflows/visual-regression-nightly.yml')

    expect(lockfile).toContain('@playwright/test@1.60.0')
    expect(readme).toContain('mcr.microsoft.com/playwright:v1.60.0-noble')
    expect(readme).toContain('bun run test:visual -- --update-snapshots')
    expect(readme).toContain('57 pixel baselines')
    expect(readme).not.toContain('RUN_VISUAL_REGRESSION=1 bun run e2e')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    expect(workflow).toContain("bun-version: '1.3.13'")
  })

  test('path-filtered visual jobs include unified system mocks in push and PR gates', () => {
    // Runtime modes and every external service now live under one test-only
    // package, so a new protocol or mode must not silently fall outside the gate.
    const workflow = repoFile('.github/workflows/visual-regression-nightly.yml')
    expect(workflow.match(/packages\/system-mocks\/\*\*/g)).toHaveLength(2)
  })

  test('RFC-250 high-risk scenes are counted, invoked, and retained by hosted CI', () => {
    const source = repoFile('e2e/rfc250-visual-states.spec.ts')
    const workflow = repoFile('.github/workflows/visual-regression-nightly.yml')
    const packageJson = repoFile('package.json')

    expect(source).toContain('const EXPECTED_RFC250_VISUAL_SCENE_COUNT = 9')
    expect(source.match(/^\s{2}test\(/gm)).toHaveLength(9)
    expect(source).toContain(
      'declaredRfc250VisualSceneCount !== EXPECTED_RFC250_VISUAL_SCENE_COUNT',
    )
    for (const snapshot of [
      'pat-permission-matrix-390.png',
      'pat-reveal-masked.png',
      'task-wizard-dirty-desktop.png',
      'task-wizard-dirty-390.png',
      'workflow-complex-readable.png',
      'workflow-complex-overview.png',
      'clarify-draft-local-only.png',
      'changes-grouped-sidebar.png',
      'agent-resource-integrity-error.png',
    ]) {
      expect(source).toContain(`'${snapshot}'`)
    }
    expect(packageJson).toContain('e2e/rfc250-visual-states.spec.ts')
    expect(workflow.match(/e2e\/rfc250-visual-states\.spec\.ts'/g)).toHaveLength(2)
    expect(workflow.match(/e2e\/rfc250-visual-states\.spec\.ts-snapshots\/\*\*/g)).toHaveLength(2)
    expect(workflow).toContain('e2e/rfc250-visual-states.spec.ts-snapshots/')
    expect(workflow.match(/e2e\/command\.ts'/g)).toHaveLength(2)
  })
})
