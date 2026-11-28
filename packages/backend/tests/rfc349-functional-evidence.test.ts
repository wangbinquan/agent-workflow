// RFC-376 T8: retain executable RFC-349 evidence after retiring canonical projections.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  RFC349_T10_FUNCTIONAL_BACKEND_TEST_FILES,
  RFC349_T10_FUNCTIONAL_E2E_TEST_FILES,
  RFC349_T10_FUNCTIONAL_EVIDENCE,
  RFC349_T10_FUNCTIONAL_FRONTEND_TEST_FILES,
} from './helpers/rfc349FunctionalEvidence'

import { buildBunTestCommand } from '../../../scripts/ci/run-backend-shard'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const CI_WORKFLOW = readFileSync(resolve(ROOT, '.github', 'workflows', 'ci-work.yml'), 'utf8')
const FULL_BACKEND_WORKFLOW = readFileSync(
  resolve(ROOT, '.github', 'workflows', 'backend-full-nightly.yml'),
  'utf8',
)
const FULL_E2E_WORKFLOW = readFileSync(
  resolve(ROOT, '.github', 'workflows', 'e2e-full-nightly.yml'),
  'utf8',
)
const BUNFIG = readFileSync(resolve(ROOT, 'bunfig.toml'), 'utf8')
const ROOT_PACKAGE = readFileSync(resolve(ROOT, 'package.json'), 'utf8')
const FRONTEND_PACKAGE = readFileSync(resolve(ROOT, 'packages', 'frontend', 'package.json'), 'utf8')

const testDeclaration = (name: string): string => `test('${name}'`

describe('RFC-349 T10-A functional evidence contract', () => {
  test('binds every functional acceptance group to an executable oracle', () => {
    expect(RFC349_T10_FUNCTIONAL_EVIDENCE.map((requirement) => requirement.id)).toEqual([
      'provider-config-and-runtime',
      'dual-provider-behavior',
      'migration-api',
      'migration-cli',
      'settings-and-e2e',
      'fresh-target-and-upgrade',
      'backup',
      'restore',
      'doctor',
      'maintenance',
      'architecture-cutover',
      'schema-and-architecture-hard-gates',
    ])

    const seen = new Set<string>()
    for (const requirement of RFC349_T10_FUNCTIONAL_EVIDENCE) {
      expect(requirement.oracles.length).toBeGreaterThan(0)
      for (const oracle of requirement.oracles) {
        const key = `${oracle.lane}:${oracle.testFile}:${oracle.testName}`
        expect(seen.has(key)).toBe(false)
        seen.add(key)

        const testPath = resolve(ROOT, oracle.testFile)
        expect(existsSync(testPath)).toBe(true)
        expect(readFileSync(testPath, 'utf8')).toContain(testDeclaration(oracle.testName))
      }
    }
  })

  test('Main discovers every backend and frontend functional oracle', () => {
    expect(BUNFIG).toContain('root = "packages/backend/tests"')
    // RFC-627 / RFC-629: ci-work.yml partitions backend discovery across deterministic LPT tiers
    // (`core` 12 shards + conditional `migration` 28 shards), while backend-full-nightly.yml
    // runs the full 44-shard dual-engine discovery; all invoke bun:test with --isolate --randomize.
    expect(CI_WORKFLOW).toContain(
      'bun scripts/ci/run-backend-shard.ts --tier=core --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED"',
    )
    expect(CI_WORKFLOW).toContain(
      'bun scripts/ci/run-backend-shard.ts --tier=migration --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED"',
    )
    expect(FULL_BACKEND_WORKFLOW).toContain(
      'bun scripts/ci/run-backend-shard.ts --tier=all --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED"',
    )
    expect(
      buildBunTestCommand({ seed: '123', timingsOut: '/tmp/timings.json', coverage: false }, [
        'packages/backend/tests/a.test.ts',
      ]).slice(0, 5),
    ).toEqual(['bun', 'test', '--isolate', '--randomize', '--seed=123'])
    expect(FRONTEND_PACKAGE).toContain('"test": "vitest run --sequence.shuffle"')
    expect(CI_WORKFLOW).toContain(
      'bun run --filter @agent-workflow/frontend test -- --shard=${{ matrix.shard }}/3',
    )

    expect(RFC349_T10_FUNCTIONAL_BACKEND_TEST_FILES.length).toBeGreaterThan(0)
    expect(RFC349_T10_FUNCTIONAL_FRONTEND_TEST_FILES.length).toBeGreaterThan(0)
    for (const path of RFC349_T10_FUNCTIONAL_BACKEND_TEST_FILES) {
      expect(path.startsWith('packages/backend/tests/')).toBe(true)
      expect(path.endsWith('.test.ts')).toBe(true)
    }
    for (const path of RFC349_T10_FUNCTIONAL_FRONTEND_TEST_FILES) {
      expect(path.startsWith('packages/frontend/tests/')).toBe(true)
      expect(path.endsWith('.test.tsx')).toBe(true)
    }
  })

  test('Main and full E2E execute the mapped compiled-browser tiers', () => {
    const fullStep = /- name: Run e2e \(full tier,[\s\S]*?(?=\n\s+- name:)/u.exec(
      FULL_E2E_WORKFLOW,
    )?.[0]
    expect(fullStep).toBeDefined()
    expect(ROOT_PACKAGE).toContain('"e2e": "playwright test"')
    expect(CI_WORKFLOW).toContain("AW_E2E_TIER_EXCLUDE: '@nightly'")
    expect(CI_WORKFLOW).toContain('--grep-invert "$AW_E2E_TIER_EXCLUDE"')
    expect(fullStep).toContain('run: bun run e2e -- --shard=${{ matrix.shard }}/4 --workers=1')
    expect(fullStep).not.toContain('--grep-invert')

    expect(RFC349_T10_FUNCTIONAL_E2E_TEST_FILES.length).toBeGreaterThan(0)
    for (const requirement of RFC349_T10_FUNCTIONAL_EVIDENCE) {
      for (const oracle of requirement.oracles) {
        if (oracle.lane === 'e2e-main') expect(oracle.testName).not.toContain('@nightly')
        if (oracle.lane === 'e2e-full') expect(oracle.testName).toContain('@nightly')
      }
    }
  })

  test('the evidence map cannot satisfy a requirement with prose or an undiscovered file', () => {
    const fabricated = {
      id: 'backup',
      oracles: [
        {
          lane: 'backend-main',
          testFile: 'design/RFC-349-postgresql-provider-one-click-migration/plan.md',
          testName: 'backup is supported',
        },
      ],
    } as const

    const oracle = fabricated.oracles[0]
    expect(oracle.testFile.startsWith('packages/backend/tests/')).toBe(false)
    expect(readFileSync(resolve(ROOT, oracle.testFile), 'utf8')).not.toContain(
      testDeclaration(oracle.testName),
    )
  })
})
