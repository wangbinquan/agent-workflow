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
    // RFC-254 T26: the artifact name now carries a platform-dependent
    // extension (`.exe` on Windows, empty elsewhere). What this lock protects
    // is unchanged — build and harness must construct the SAME name — so it
    // follows the construction rather than pinning the old literal.
    expect(build).toContain('`agent-workflow-e2e-${platformSuffix()}${executableExtension()}`')
    expect(build).toContain("raw === 'win32' ? 'windows' : raw")
    expect(pkg.scripts?.['build:binary']).toBe('bun run scripts/build-binary.ts')
    expect(pkg.scripts?.['build:binary:e2e']).toBe('bun run scripts/build-binary.ts --include-e2e')
  })

  test('harness selects only the e2e artifact and seeds a complete model policy', () => {
    const harness = source('e2e/harness.ts')
    expect(harness).toContain('`agent-workflow-e2e-${platformSuffix()}${executableExtension()}`')
    expect(harness).toContain("raw === 'win32' ? 'windows' : raw")
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
    expect(ci).toContain('dist/agent-workflow-e2e-*')

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

  test('the compiled e2e stub is built, shipped to the e2e shards, and made executable', () => {
    // RFC-254 T28b — the model stand-in became a compiled binary because
    // `opencodePath` must name something the OS can execute and Windows cannot
    // run a `#!/bin/sh` file. That created a three-link chain that is silent
    // when it breaks: build → artifact → download. A missing stub does not say
    // "missing stub"; it says "daemon closed with code 1 before printing ready
    // line" in every single spec, which is where an afternoon goes.
    const build = source('scripts/build-binary.ts')
    const harness = source('e2e/harness.ts')
    const ci = source('.github/workflows/ci.yml')

    // Built only alongside the e2e artifact, never in a release build.
    expect(build).toContain('stub-opencode-${platformSuffix()}${executableExtension()}')
    expect(build).toContain("join(repoRoot, 'e2e', 'fixtures', 'stub', 'dispatch.ts')")

    // Named identically on both sides of the seam.
    expect(harness).toContain('stub-opencode-${platformSuffix()}${executableExtension()}')

    // Uploaded WITH the daemon binary — asserted as the two-line upload path
    // list, not as a bare mention: `dist/stub-opencode-*` also appears on the
    // chmod line below, so a loose `toContain` stays green with the upload
    // removed (measured — the first version of this assertion did exactly
    // that).
    expect(ci).toContain('            dist/agent-workflow-e2e-*\n            dist/stub-opencode-*')
    expect(ci).toContain('chmod +x dist/stub-opencode-*')
    // …and its ABSENCE fails on the download step rather than in every spec.
    expect(ci).toContain(`test -n "$(find dist -maxdepth 1 -type f -name 'stub-opencode-*')"`)
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
