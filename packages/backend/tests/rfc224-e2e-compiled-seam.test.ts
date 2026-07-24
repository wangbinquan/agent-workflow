// RFC-224 release-fixture guard.
//
// Browser tests need deterministic OpenCode stubs, while a configured command
// in the shipped daemon must always take the verified official-build path.
// Lock the separation structurally: production and e2e are distinct compiled
// artifacts, and only the latter receives the existing unbranded code seam.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isProductionOpencodeCommand, markProductionOpencodeCommand } from '../src/util/opencode'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const source = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')

describe('RFC-224 compiled Playwright seam', () => {
  test('source/default builds still brand every production OpenCode command', () => {
    const command = ['/test/opencode']
    expect(markProductionOpencodeCommand(command)).toBe(command)
    expect(isProductionOpencodeCommand(command)).toBe(true)
  })

  test('build pipeline emits separate false/true artifacts with no runtime toggle', () => {
    const util = source('packages/backend/src/util/opencode.ts')
    const build = source('scripts/build-binary.ts')
    const pkg = JSON.parse(source('package.json')) as { scripts?: Record<string, string> }

    expect(util).toContain('declare const AW_E2E_UNVERIFIED_OPENCODE: boolean')
    expect(util).toContain('if (IS_E2E_UNVERIFIED_OPENCODE_BUILD) return command')
    expect(util).not.toMatch(/process\.env\.[A-Z0-9_]*E2E_UNVERIFIED_OPENCODE/)

    expect(build.match(/--define=AW_E2E_UNVERIFIED_OPENCODE=false/g)).toHaveLength(1)
    expect(build.match(/--define=AW_E2E_UNVERIFIED_OPENCODE=true/g)).toHaveLength(1)
    expect(build).toContain("Bun.argv.includes('--include-e2e')")
    expect(build).toContain('`agent-workflow-e2e-${platformSuffix()}`')
    expect(pkg.scripts?.['build:binary']).toBe('bun run scripts/build-binary.ts')
    expect(pkg.scripts?.['build:binary:e2e']).toBe('bun run scripts/build-binary.ts --include-e2e')
  })

  test('harness selects only the e2e artifact and seeds a complete model policy', () => {
    const harness = source('e2e/harness.ts')
    expect(harness).toContain('`agent-workflow-e2e-${platformSuffix()}`')
    expect(harness).toContain('async function seedE2eExecutionPolicy(')
    expect(harness).toContain('fetch(`${ready.baseUrl}/api/runtimes/opencode`')
    expect(harness).toContain("const E2E_OPENCODE_MODEL = 'test/model'")
    expect(harness).toContain('await seedE2eExecutionPolicy(ready, token)')
  })

  test('CI and browser workflows build/use the test artifact; release stays production-only', () => {
    const ci = source('.github/workflows/ci.yml')
    expect(ci).toContain('run: bun run build:binary:e2e')
    expect(ci).toContain("! -name 'agent-workflow-e2e-*'")
    expect(ci).toContain('name: agent-workflow-e2e-${{ matrix.os }}')
    expect(ci).toContain('path: dist/agent-workflow-e2e-*')

    for (const path of [
      '.github/workflows/visual-regression-nightly.yml',
      '.github/workflows/e2e-webkit-nightly.yml',
      '.github/workflows/git-protocols-e2e.yml',
    ]) {
      expect(source(path), path).toContain('run: bun run build:binary:e2e')
    }
    const release = source('.github/workflows/release.yml')
    expect(release).toContain('run: bun run build:binary')
    expect(release).not.toContain('build:binary:e2e')
  })

  test('visual pixels stub only the diagnostic presentation, not production policy', () => {
    const visual = source('e2e/visual-regression.spec.ts')
    expect(visual).toContain('const VISUAL_RUNTIME_STATUS = {')
    expect(visual).toContain("version: '1.18.3'")
    expect(visual).toContain("page.route('**/api/runtimes/status'")
    expect(visual).toContain('route.fulfill({ json: VISUAL_RUNTIME_STATUS })')
    expect(visual).not.toContain('testOnlyUnverifiedRuntime')
  })
})
