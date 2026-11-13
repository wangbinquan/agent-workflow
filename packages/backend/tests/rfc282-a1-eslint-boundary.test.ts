// RFC-282 A1 — mutation proof for the ESLint runtime-fence boundary (§4.2).
//
// The rule guards two invariants and this file proves BOTH still bite:
//   1. NEW: per-runtime internals ({opencode,claudeCode}/** of the driver
//      family) are import-reachable only via the driver registry and types —
//      alias AND relative spellings (the existing violation shape was relative:
//      runner.ts). RFC-492 moved the family from services/runtime to
//      runtime-management `infrastructure/drivers`; the probes follow it.
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
const RM = 'packages/backend/src/modules/runtime-management'
const DRIVERS = '@/modules/runtime-management/infrastructure/drivers'

describe('RFC-282 A1 — runtime fence (new patterns)', () => {
  test('alias deep import into a driver is rejected in src', async () => {
    const hits = await restrictedImportHits(
      SRC_PROBE,
      `import { x } from '${DRIVERS}/claudeCode/spawn'\nexport const y = x\n`,
    )
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('RFC-282')
  })

  // RFC-492: one probe per depth a runtime-management file (or another module) reaches the drivers from.
  for (const [probe, specifier] of [
    [`${RM}/infrastructure/rfc282-a1-mutation-probe.ts`, './drivers/opencode/inlineConfig'],
    [`${RM}/infrastructure/local/rfc282-a1-mutation-probe.ts`, '../drivers/opencode/inlineConfig'],
    [`${RM}/infrastructure/http/rfc282-a1-mutation-probe.ts`, '../drivers/claudeCode/spawn'],
    [`${RM}/composition/rfc282-a1-mutation-probe.ts`, '../infrastructure/drivers/opencode/spawn'],
    [
      `${RM}/application/ports/rfc282-a1-mutation-probe.ts`,
      '../../infrastructure/drivers/claudeCode/spawn',
    ],
    [
      'packages/backend/src/modules/task-execution/infrastructure/rfc282-a1-mutation-probe.ts',
      '../../runtime-management/infrastructure/drivers/opencode/spawn',
    ],
    [
      'packages/backend/src/modules/task-execution/infrastructure/local/rfc282-a1-mutation-probe.ts',
      '../../../runtime-management/infrastructure/drivers/claudeCode/spawn',
    ],
  ] as const) {
    test(`relative deep import into a driver is rejected in src (${specifier})`, async () => {
      const hits = await restrictedImportHits(
        probe,
        `import { x } from '${specifier}'\nexport const y = x\n`,
      )
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('RFC-282')
    })
  }

  test('re-export (export-from) of driver internals is rejected in src', async () => {
    const hits = await restrictedImportHits(
      `${RM}/infrastructure/local/rfc282-a1-mutation-probe.ts`,
      "export { buildCommand } from '../drivers/opencode/spawn'\n",
    )
    expect(hits.length).toBe(1)
  })

  test('the sanctioned entries (driver registry and types) stay importable', async () => {
    for (const [probe, specifier] of [
      [SRC_PROBE, DRIVERS],
      [`${RM}/infrastructure/local/rfc282-a1-mutation-probe.ts`, '../drivers'],
      [`${RM}/infrastructure/local/rfc282-a1-mutation-probe.ts`, '../drivers/types'],
      [`${RM}/infrastructure/rfc282-a1-mutation-probe.ts`, './drivers'],
    ] as const) {
      const hits = await restrictedImportHits(
        probe,
        `import { getRuntimeDriver } from '${specifier}'\nexport const y = getRuntimeDriver\n`,
      )
      expect([specifier, hits]).toEqual([specifier, []])
    }
  })

  test("the drivers' own registry still reaches each driver directory", async () => {
    for (const [probe, specifier] of [
      [`${RM}/infrastructure/drivers/rfc282-a1-mutation-probe.ts`, './opencode/driver'],
      [`${RM}/infrastructure/drivers/opencode/rfc282-a1-mutation-probe.ts`, '../claudeCode/driver'],
    ] as const) {
      const hits = await restrictedImportHits(
        probe,
        `import { x } from '${specifier}'\nexport const y = x\n`,
      )
      expect([specifier, hits]).toEqual([specifier, []])
    }
  })

  test('tests keep direct unit-test access to driver internals', async () => {
    const hits = await restrictedImportHits(
      TEST_PROBE,
      "import { opencodeDriver } from '../src/modules/runtime-management/infrastructure/drivers/opencode/driver'\nexport const y = opencodeDriver\n",
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

// RFC-370: material mechanisms moved to two exact owner files. Adjacent
// application/common files do not receive private protocol assembly access.
describe('RFC-370 native material owner import boundary', () => {
  const nativeFiles = [
    'packages/backend/src/modules/runtime-management/infrastructure/local/opencodeAgentMaterial.ts',
    'packages/backend/src/modules/runtime-management/infrastructure/local/claudeAgentMaterial.ts',
  ]
  for (const file of nativeFiles) {
    test(`${file}: actual native assembly retains private protocol access`, async () => {
      for (const protocol of ['opencode', 'claudeCode']) {
        for (const specifier of [`${DRIVERS}/${protocol}/spawn`, `../drivers/${protocol}/spawn`]) {
          const hits = await restrictedImportHits(
            file,
            `import { x } from '${specifier}'\nexport const y = x\n`,
          )
          expect([specifier, hits]).toEqual([specifier, []])
        }
      }
    })
    test(`${file}: backend package boundaries remain active`, async () => {
      for (const [specifier, message] of [
        ['@agent-workflow/frontend', 'backend must not import from frontend'],
        ['react', 'no UI deps in backend'],
      ]) {
        const hits = await restrictedImportHits(
          file,
          `import { x } from '${specifier}'\nexport const y = x\n`,
        )
        expect(hits.length).toBe(1)
        expect(hits[0]).toContain(message)
      }
    })
  }
  test('neighboring material application/common files retain the runtime fence', async () => {
    for (const file of [
      'packages/backend/src/modules/runtime-management/application/agentMaterial.ts',
      'packages/backend/src/modules/runtime-management/infrastructure/local/agentMaterialCommon.ts',
    ]) {
      const hits = await restrictedImportHits(
        file,
        `import { x } from '${DRIVERS}/opencode/spawn'\nexport const y = x\n`,
      )
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('RFC-282')
    }
  })
})
