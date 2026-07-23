// RFC-198 + RFC-219 — lock the non-package visual gate wiring that normal
// component tests cannot observe: scene count, reproducible Linux image, and
// direct fixtures.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')

function repoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

describe('RFC-198 visual infrastructure source gates', () => {
  test('visual spec declares exactly 26 counted scenes', () => {
    const source = repoFile('e2e/visual-regression.spec.ts')
    expect(source).toContain('const EXPECTED_VISUAL_SCENE_COUNT = 26')
    expect(source).toContain('const HOMEPAGE_VISUAL_TIME = new Date(2026, 6, 23, 14, 0, 0)')
    expect(source.match(/^\s{2}test\(/gm)).toHaveLength(26)
    expect(source).toContain('declaredVisualSceneCount !== EXPECTED_VISUAL_SCENE_COUNT')
    expect(source).toContain('async function waitForStableAuthenticatedShell(page: Page)')
    expect(source).toContain("await expect(userMenu).toContainText('e2e_admin')")
    expect(source).toContain('await page.clock.setFixedTime(HOMEPAGE_VISUAL_TIME)')
    expect(source).toContain("'workflow-node-picker-1179-large-human-dark.png'")
    // One declaration plus six locator screenshot callsites.
    expect(source.match(/COMPONENT_SNAPSHOT_OPTS/g)).toHaveLength(7)
    for (const snapshot of [
      'mobile-nav-open.png',
      'page-header-actions.png',
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
    expect(readme).toContain('26 full-page + 6 component pixel baselines')
    expect(readme).not.toContain('RUN_VISUAL_REGRESSION=1 bun run e2e')
    expect(workflow).toContain('runs-on: ubuntu-24.04')
    expect(workflow).toContain("bun-version: '1.3.13'")
  })

  test('path-filtered visual jobs include the terminal-task stub in push and PR gates', () => {
    const workflow = repoFile('.github/workflows/visual-regression-nightly.yml')
    expect(workflow.match(/e2e\/fixtures\/stub-opencode\.sh/g)).toHaveLength(2)
  })
})
