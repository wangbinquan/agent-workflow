// RFC-627: deterministic backend tiering (core / migration / all), LPT sharding,
// pure-SQLite smoke purity, PG coverage completeness, and timings self-verification.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import {
  assertTimingsMatchPlannedFiles,
  BACKEND_CORE_SHARDS,
  BACKEND_FULL_SHARDS,
  BACKEND_MIGRATION_SHARDS,
  CORE_MIGRATION_SMOKE,
  discoverBackendTests,
  filterBackendTestsByTier,
  isMigrationTierTest,
  loadBackendTimingWeights,
  parseBackendTestTier,
  parseShardSpec,
  planBackendShards,
  SHARD_1_PINNED_FILES,
  TEST_BACKEND_POSTGRESQL_FILES,
} from '../../../scripts/ci/backend-shards'
import { parsePlanBackendShardArgs } from '../../../scripts/ci/plan-backend-shards'
import {
  buildBunTestCommand,
  parseRunBackendShardArgs,
  runBackendShard,
} from '../../../scripts/ci/run-backend-shard'

const ROOT = resolve(import.meta.dir, '../../..')

describe('RFC-627 backend tiering and PostgreSQL coverage invariants', () => {
  const all = discoverBackendTests(ROOT)
  const core = filterBackendTestsByTier(all, 'core')
  const migration = filterBackendTestsByTier(all, 'migration')
  const coreSet = new Set(core)
  const migrationSet = new Set(migration)
  const pgGateSet = new Set<string>(TEST_BACKEND_POSTGRESQL_FILES)

  test('core and migration form an exact disjoint partition of all backend tests', () => {
    expect(all.length).toBeGreaterThanOrEqual(1000)
    expect(core.length).toBeGreaterThanOrEqual(500)
    expect(migration.length).toBeGreaterThanOrEqual(300)
    expect(core.filter((file) => migrationSet.has(file))).toEqual([])
    expect([...core, ...migration].sort((a, b) => a.localeCompare(b))).toEqual(all)
    expect(filterBackendTestsByTier(all, 'all')).toEqual(all)
  })

  test('CORE_MIGRATION_SMOKE files exist, live in core, and contain zero dual-provider or PostgreSQL helpers', () => {
    const forbiddenPgHelperPattern =
      /\b(?:describeEachProvider|describeQ3PhaseBoundary|describeV[123]Providers|describeV3CrossProvider|describeRfc398Postgresql)\b|includes\(\s*['"]postgresql['"]\s*\)|===\s*['"]postgresql['"]/
    expect(CORE_MIGRATION_SMOKE.length).toBe(7)
    for (const file of CORE_MIGRATION_SMOKE) {
      expect(existsSync(resolve(ROOT, file)), `missing smoke file: ${file}`).toBe(true)
      expect(coreSet.has(file), `expected in core: ${file}`).toBe(true)
      expect(isMigrationTierTest(file), `must not be in migration: ${file}`).toBe(false)
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      expect(
        forbiddenPgHelperPattern.test(source),
        `CORE_MIGRATION_SMOKE file ${file} must stay pure SQLite/static so mode=full never loses PG tests`,
      ).toBe(false)
    }
  })

  test('every non-architecture migration-PG helper suite belongs to migration and every pure-PG gated suite belongs to migration or test-backend-postgresql', () => {
    const migrationPgHelperPattern =
      /\b(?:describeQ3PhaseBoundary|describeV[123]Providers|describeV3CrossProvider|describeRfc398Postgresql)\b/
    const purePgFilterPattern =
      /\.filter\(\s*\([^)]*\)\s*=>\s*\w+\s*===\s*['"]postgresql['"]\s*\)|\.includes\(\s*['"]postgresql['"]\s*\)/

    const strandedMigrationPg: string[] = []
    const strandedPurePg: string[] = []

    for (const file of all) {
      if (
        file.startsWith('packages/backend/tests/architecture/') ||
        file === 'packages/backend/tests/rfc627-backend-shard-planner.test.ts'
      )
        continue
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      if (migrationPgHelperPattern.test(source) && !migrationSet.has(file)) {
        strandedMigrationPg.push(file)
      }
      // Exclude unit tests that assert the parser/harness itself or standalone external PG
      // workflows (postgresql-evidence.yml) that never ran on standard CI runners.
      const isPurePgSuite =
        purePgFilterPattern.test(source) &&
        !file.endsWith('rfc359-each-provider-harness.test.ts') &&
        !file.endsWith('rfc349-postgresql-logical-migration.integration.test.ts') &&
        !file.endsWith('rfc349-postgresql-target-faults.integration.test.ts') &&
        !file.endsWith('rfc349-postgresql-write-matrix.integration.test.ts')
      if (isPurePgSuite && !migrationSet.has(file) && !pgGateSet.has(file)) {
        strandedPurePg.push(file)
      }
    }

    expect(strandedMigrationPg).toEqual([])
    expect(strandedPurePg).toEqual([])
  })

  test('TEST_BACKEND_POSTGRESQL_FILES (16 files) all exist and drive ci-work.yml:test-backend-postgresql via run-postgresql-gate.ts', () => {
    expect(TEST_BACKEND_POSTGRESQL_FILES).toHaveLength(16)
    for (const file of TEST_BACKEND_POSTGRESQL_FILES) {
      expect(existsSync(resolve(ROOT, file)), `missing PG gate file: ${file}`).toBe(true)
    }
    const ciWork = parse(readFileSync(resolve(ROOT, '.github/workflows/ci-work.yml'), 'utf8'))
    const pgSteps = ciWork.jobs['test-backend-postgresql'].steps as {
      name?: string
      run?: string
    }[]
    const pgTestStep = pgSteps.find((step) => step.name?.includes('Test real PostgreSQL parity'))
    expect(pgTestStep?.run).toBeDefined()
    expect(pgTestStep!.run!).toContain('bun scripts/ci/run-postgresql-gate.ts --concurrency=3')
    const gateScript = readFileSync(resolve(ROOT, 'scripts/ci/run-postgresql-gate.ts'), 'utf8')
    expect(gateScript).toContain("import { TEST_BACKEND_POSTGRESQL_FILES } from './backend-shards'")
  })

  test('docs-fast-gate executes all 23 existing backend files under sqlite and 2 existing shared files via shared filter', () => {
    const ci = parse(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8'))
    const steps = ci.jobs['docs-fast-gate'].steps as {
      name?: string
      run?: string
      env?: Record<string, string>
    }[]
    const backendStep = steps.find((step) => step.name === 'Run backend doc-contract tests')
    expect(backendStep?.env?.AW_TEST_PROVIDERS).toBe('sqlite')
    const backendFiles = [
      ...(backendStep?.run?.matchAll(/packages\/backend\/tests\/[A-Za-z0-9_./-]+\.test\.ts/g) ??
        []),
    ].map((m) => m[0])
    expect(backendFiles).toHaveLength(23)
    expect(new Set(backendFiles).size).toBe(23)
    for (const file of backendFiles) {
      expect(existsSync(resolve(ROOT, file)), `missing docs-fast-gate backend test: ${file}`).toBe(
        true,
      )
    }

    const sharedStep = steps.find((step) => step.name === 'Run shared doc-contract tests')
    expect(sharedStep?.run).toContain('bun run --filter @agent-workflow/shared test --')
    const sharedFiles = [
      ...(sharedStep?.run?.matchAll(/tests\/[A-Za-z0-9_./-]+\.test\.ts/g) ?? []),
    ].map((m) => m[0])
    expect(sharedFiles).toEqual([
      'tests/config-rfc300.test.ts',
      'tests/webhook-vars-rfc263.test.ts',
    ])
    for (const file of sharedFiles) {
      expect(
        existsSync(resolve(ROOT, 'packages/shared', file)),
        `missing docs-fast-gate shared test: ${file}`,
      ).toBe(true)
    }
  })
})

describe('RFC-627 LPT shard planning and wrapper self-verification', () => {
  test('plans deterministic exact-once shards across core (12), migration (28), and all (44) and pins opencode tests to shard 1', () => {
    const all = discoverBackendTests(ROOT)
    for (const pinned of SHARD_1_PINNED_FILES) {
      expect(existsSync(resolve(ROOT, pinned)), pinned).toBe(true)
    }

    for (const [tier, total] of [
      ['core', BACKEND_CORE_SHARDS],
      ['migration', BACKEND_MIGRATION_SHARDS],
      ['all', BACKEND_FULL_SHARDS],
    ] as const) {
      const files = filterBackendTestsByTier(all, tier)
      const weights = loadBackendTimingWeights(ROOT, tier)
      const plan = planBackendShards(files, weights, tier, 1, total)
      const reversed = planBackendShards([...files].reverse(), weights, tier, 1, total)
      expect(reversed).toEqual(plan)
      expect(plan.assignments).toHaveLength(total)
      expect(plan.estimatedShardMs).toHaveLength(total)
      for (const bucket of plan.assignments) {
        expect(bucket.length).toBeGreaterThan(0)
      }
      const flat = plan.assignments.flat()
      expect(new Set(flat).size).toBe(files.length)
      expect([...flat].sort((a, b) => a.localeCompare(b))).toEqual(files)

      if (tier === 'core' || tier === 'all') {
        for (const pinned of SHARD_1_PINNED_FILES) {
          expect(plan.assignments[0]).toContain(pinned)
          for (let shard = 1; shard < total; shard++) {
            expect(plan.assignments[shard]).not.toContain(pinned)
          }
        }
      }
    }

    // Even with extreme weights, pinned files remain in shard 1.
    const synthetic = [
      'packages/backend/tests/cli.test.ts',
      'packages/backend/tests/opencode-version.test.ts',
      'packages/backend/tests/a.test.ts',
      'packages/backend/tests/b.test.ts',
    ]
    const heavyPinnedPlan = planBackendShards(
      synthetic,
      {
        'packages/backend/tests/cli.test.ts': 999_999,
        'packages/backend/tests/opencode-version.test.ts': 888_888,
        'packages/backend/tests/a.test.ts': 1,
        'packages/backend/tests/b.test.ts': 1,
      },
      'core',
      1,
      2,
    )
    expect(heavyPinnedPlan.assignments[0]).toContain('packages/backend/tests/cli.test.ts')
    expect(heavyPinnedPlan.assignments[0]).toContain(
      'packages/backend/tests/opencode-version.test.ts',
    )
  })

  test('rejects invalid tiers, shard specs, duplicate paths, path traversal, and over-sharding', () => {
    expect(() => parseBackendTestTier('invalid')).toThrow('Invalid backend test tier')
    for (const badSpec of ['', '0/16', '17/16', '1/0', '1.5/16', 'abc', '1/2/3']) {
      expect(() => parseShardSpec(badSpec), badSpec).toThrow()
    }
    const files = ['packages/backend/tests/a.test.ts', 'packages/backend/tests/b.test.ts']
    expect(() => planBackendShards(files, {}, 'core', 1, 3)).toThrow('More backend shards')
    expect(() => planBackendShards([files[0]!, files[0]!], {}, 'core', 1, 1)).toThrow(
      'Duplicate backend test path',
    )
    expect(() =>
      planBackendShards(['packages/backend/tests/../escape.test.ts'], {}, 'core', 1, 1),
    ).toThrow('Invalid backend test path')
    // Two files pinned to shard 1 leave only one file for the remaining two shards -> empty shard refused.
    expect(() =>
      planBackendShards(
        [
          'packages/backend/tests/cli.test.ts',
          'packages/backend/tests/opencode-version.test.ts',
          'packages/backend/tests/a.test.ts',
        ],
        {},
        'core',
        1,
        3,
      ),
    ).toThrow('non-empty backend shards')
    expect(() => parsePlanBackendShardArgs(['--tier=core', '--shard=1/16', '--output'])).toThrow(
      'Missing value for --output',
    )
    expect(() => parsePlanBackendShardArgs(['--tier=core', '--shard=1/16', '--output='])).toThrow(
      'Missing value for --output',
    )
    expect(() => parsePlanBackendShardArgs(['--tier', '--shard=1/16'])).toThrow(
      'Missing value for --tier',
    )
  })

  test('real bun test --timings --update-timings records exact planned keys including 0-test PG-only files under sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc627-bun-timings-'))
    const timingsOut = join(dir, 'core-timings.json')
    const planned = [
      'packages/backend/tests/rfc359-each-provider-harness.test.ts',
      'packages/backend/tests/rfc615-g1-plan-stability.test.ts',
    ]
    try {
      const command = buildBunTestCommand({ seed: '1', timingsOut, coverage: false }, planned)
      const child = Bun.spawn(command, {
        cwd: ROOT,
        env: { ...process.env, AW_TEST_PROVIDERS: 'sqlite' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const exitCode = await child.exited
      expect(exitCode).toBe(0)
      const recorded: unknown = JSON.parse(readFileSync(timingsOut, 'utf8'))
      expect(() => assertTimingsMatchPlannedFiles(recorded, planned)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('runBackendShard cleans stale timings before spawn and verifies recorded keys match planned files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc627-shard-'))
    const timingsOut = join(dir, 'nested', 'timings.json')
    try {
      // Seed a stale file with an unrelated key; runBackendShard must remove it first.
      const fakeRepo = join(dir, 'repo')
      const testsDir = join(fakeRepo, 'packages', 'backend', 'tests')
      writeFileSync(join(dir, 'placeholder'), '')
      rmSync(join(dir, 'placeholder'))
      const { mkdirSync } = await import('node:fs')
      mkdirSync(testsDir, { recursive: true })
      mkdirSync(join(dir, 'nested'), { recursive: true })
      writeFileSync(join(testsDir, 'a.test.ts'), '')
      writeFileSync(join(testsDir, 'b.test.ts'), '')
      writeFileSync(
        timingsOut,
        JSON.stringify({ version: 1, files: { 'packages/backend/tests/stale.test.ts': 10 } }),
      )

      let existedAtSpawnStart = true
      let spawnedCommand: readonly string[] = []
      const okResult = await runBackendShard(
        { tier: 'core', current: 1, total: 1, seed: '42', timingsOut, coverage: true },
        fakeRepo,
        async (command) => {
          existedAtSpawnStart = existsSync(timingsOut)
          spawnedCommand = command
          writeFileSync(
            timingsOut,
            JSON.stringify({
              version: 1,
              files: {
                'packages/backend/tests/a.test.ts': 12,
                'packages/backend/tests/b.test.ts': 34,
              },
            }),
          )
          return 0
        },
      )
      expect(existedAtSpawnStart).toBe(false)
      expect(okResult.exitCode).toBe(0)
      expect(okResult.selectedFiles).toEqual([
        'packages/backend/tests/a.test.ts',
        'packages/backend/tests/b.test.ts',
      ])
      expect(spawnedCommand.slice(0, 8)).toEqual([
        'bun',
        'test',
        '--isolate',
        '--randomize',
        '--seed=42',
        '--coverage',
        '--coverage-reporter=lcov',
        `--timings=${timingsOut}`,
      ])

      // Missing recorded file on exit 0 fails closed.
      await expect(
        runBackendShard(
          { tier: 'core', current: 1, total: 1, seed: '42', timingsOut, coverage: false },
          fakeRepo,
          async () => {
            writeFileSync(
              timingsOut,
              JSON.stringify({ version: 1, files: { 'packages/backend/tests/a.test.ts': 12 } }),
            )
            return 0
          },
        ),
      ).rejects.toThrow('timings mismatch')

      // Non-zero exit code propagates directly without throwing on missing timings file.
      const failedResult = await runBackendShard(
        { tier: 'core', current: 1, total: 1, seed: '42', timingsOut, coverage: false },
        fakeRepo,
        async () => 1,
      )
      expect(failedResult.exitCode).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('assertTimingsMatchPlannedFiles, buildBunTestCommand, and CLI parser validate inputs strictly', () => {
    const planned = ['packages/backend/tests/a.test.ts']
    expect(() =>
      assertTimingsMatchPlannedFiles(
        { version: 1, files: { 'packages/backend/tests/a.test.ts': 0 } },
        planned,
      ),
    ).not.toThrow()
    for (const bad of [
      null,
      [],
      { version: 2, files: { 'packages/backend/tests/a.test.ts': 1 } },
      { version: 1, files: {} },
      {
        version: 1,
        files: {
          'packages/backend/tests/a.test.ts': 1,
          'packages/backend/tests/extra.test.ts': 2,
        },
      },
      { version: 1, files: { 'packages/backend/tests/a.test.ts': -1 } },
      { version: 1, files: { 'packages/backend/tests/a.test.ts': NaN } },
    ]) {
      expect(() => assertTimingsMatchPlannedFiles(bad, planned)).toThrow()
    }

    expect(
      buildBunTestCommand({ seed: '9', timingsOut: '/tmp/out.json', coverage: false }, planned),
    ).toEqual([
      'bun',
      'test',
      '--isolate',
      '--randomize',
      '--seed=9',
      '--timings=/tmp/out.json',
      '--update-timings',
      'packages/backend/tests/a.test.ts',
    ])

    expect(
      parseRunBackendShardArgs([
        '--tier=core',
        '--shard=1/16',
        '--seed=123',
        '--timings-out=/tmp/t.json',
      ]),
    ).toEqual({
      tier: 'core',
      current: 1,
      total: 16,
      seed: '123',
      timingsOut: '/tmp/t.json',
      coverage: false,
    })
    expect(
      parseRunBackendShardArgs([
        '--tier',
        'all',
        '--shard',
        '2/44',
        '--seed',
        '999',
        '--timings-out',
        '/tmp/f.json',
        '--coverage',
      ]).coverage,
    ).toBe(true)
    for (const badArgs of [
      [],
      ['--tier=core', '--shard=1/16', '--seed=abc', '--timings-out=/tmp/t.json'],
      ['--tier=core', '--shard=1/16', '--seed=1', '--timings-out=/tmp/t.json', '--unknown'],
    ]) {
      expect(() => parseRunBackendShardArgs(badArgs)).toThrow()
    }
  })
})
