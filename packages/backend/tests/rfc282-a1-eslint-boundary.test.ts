// RFC-282 A1 — mutation proof for the ESLint runtime-fence boundary (§4.2).
//
// The rule guards two invariants and this file proves BOTH still bite:
//   1. NEW: per-runtime internals (services/runtime/{opencode,claudeCode}/**)
//      are import-reachable only via @/services/runtime — alias AND relative
//      spellings (the existing violation shape was relative: runner.ts).
//   2. OLD: the pre-existing cross-package bans (frontend pkg, react/vite)
//      still fire in BOTH backend blocks — flat config REPLACES same-rule
//      options instead of merging patterns (设计门 P1-8), and the config now
//      has two backend blocks sharing one array; if a refactor forks or drops
//      that array, these assertions go red.
//
// Runs the REAL repo config via the ESLint API — not a copy of the patterns —
// so what is proven is what CI enforces.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ESLint } from 'eslint'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

async function restrictedImportHits(filePath: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT })
  const results = await eslint.lintText(code, { filePath: resolve(REPO_ROOT, filePath) })
  return (results[0]?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message)
}

const SRC_PROBE = 'packages/backend/src/services/rfc282-a1-mutation-probe.ts'
const TEST_PROBE = 'packages/backend/tests/rfc282-a1-mutation-probe.ts'

describe('RFC-282 A1 — runtime fence (new patterns)', () => {
  test('alias deep import into a driver is rejected in src', async () => {
    const hits = await restrictedImportHits(
      SRC_PROBE,
      "import { x } from '@/services/runtime/claudeCode/spawn'\nexport const y = x\n",
    )
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('RFC-282')
  })

  test('relative deep import into a driver is rejected in src (the runner.ts shape)', async () => {
    const hits = await restrictedImportHits(
      SRC_PROBE,
      "import { x } from './runtime/opencode/inlineConfig'\nexport const y = x\n",
    )
    expect(hits.length).toBe(1)
  })

  test('re-export (export-from) of driver internals is rejected in src', async () => {
    const hits = await restrictedImportHits(
      SRC_PROBE,
      "export { buildCommand } from './runtime/opencode/spawn'\n",
    )
    expect(hits.length).toBe(1)
  })

  test('the sanctioned entry (@/services/runtime) stays importable', async () => {
    const hits = await restrictedImportHits(
      SRC_PROBE,
      "import { getRuntimeDriver } from '@/services/runtime'\nexport const y = getRuntimeDriver\n",
    )
    expect(hits).toEqual([])
  })

  test('tests keep direct unit-test access to driver internals', async () => {
    const hits = await restrictedImportHits(
      TEST_PROBE,
      "import { opencodeDriver } from '../src/services/runtime/opencode/driver'\nexport const y = opencodeDriver\n",
    )
    expect(hits).toEqual([])
  })
})

describe('RFC-282 A1 — pre-existing cross-package bans survive in BOTH blocks (P1-8)', () => {
  for (const [where, probe] of [
    ['src block', SRC_PROBE],
    ['non-src block', TEST_PROBE],
  ] as const) {
    test(`${where}: frontend package import still rejected`, async () => {
      const hits = await restrictedImportHits(
        probe,
        "import { z } from '@agent-workflow/frontend'\nexport const y = z\n",
      )
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('backend must not import from frontend')
    })

    test(`${where}: react import still rejected`, async () => {
      const hits = await restrictedImportHits(
        probe,
        "import react from 'react'\nexport default react\n",
      )
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('no UI deps in backend')
    })
  }
})
