import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { classifyDatabaseMigrationFailure } from '@/modules/system-operations/application/databaseMigrationRunner'
import {
  advanceDatabaseMigration,
  createDatabaseMigrationManifest,
  DATABASE_MIGRATION_PHASES,
  requestDatabaseMigrationCancellation,
} from '@/modules/system-operations/domain/databaseMigration'

import {
  parseRfc349EvidenceArgs,
  RFC349_CRASH_POINTS,
  RFC349_DATABASE_MIGRATION_PHASES,
  RFC349_T10_FULL_REGRESSION_TOPOLOGY,
  RFC349_T10_EXECUTABLE_EVIDENCE,
  RFC349_T10_WORKFLOW_TEST_FILES,
  rfc349EvidenceFailures,
} from './helpers/rfc349PostgresqlHostedEvidence'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const WORKFLOW_PATH = resolve(ROOT, '.github', 'workflows', 'postgresql-evidence.yml')
const HARNESS_PATH = resolve(
  ROOT,
  'packages',
  'backend',
  'tests',
  'helpers',
  'rfc349PostgresqlHostedEvidence.ts',
)
const CRASH_WORKER_PATH = resolve(
  ROOT,
  'packages',
  'backend',
  'tests',
  'fixtures',
  'rfc349-postgresql-crash-worker.ts',
)

describe('RFC-349 hosted external PostgreSQL evidence contract', () => {
  test('binds every T10-C/D requirement to an oracle that the hosted workflow executes', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
    const harness = readFileSync(HARNESS_PATH, 'utf8')
    const unitStep =
      /- name: Run executable T10-C fault and corruption oracles[\s\S]*?(?=\n\s+- name:)/u.exec(
        workflow,
      )?.[0]
    expect(unitStep).toBeDefined()
    expect(RFC349_T10_EXECUTABLE_EVIDENCE.map((requirement) => requirement.id)).toEqual([
      'checkpoint-crash-and-process-restart',
      'owner-lease-and-late-receipt',
      'target-runtime-failures',
      'manifest-chunk-pointer-corruption',
      'freeze-drain-timeout',
      'cutover-health-rollback-first-write',
      'cancellation-phase-policy',
      'full-seed-100-client-soak',
      'large-migration-responsiveness',
      'compiled-external-postgresql-hidden-tools',
    ])

    for (const requirement of RFC349_T10_EXECUTABLE_EVIDENCE) {
      expect(requirement.oracles.length).toBeGreaterThan(0)
      for (const oracle of requirement.oracles) {
        if (oracle.kind === 'bun-test') {
          const testPath = resolve(ROOT, oracle.testFile)
          expect(existsSync(testPath)).toBe(true)
          expect(readFileSync(testPath, 'utf8')).toContain(oracle.testName)
          expect(unitStep).toContain(oracle.testFile)
          continue
        }
        expect(workflow).toContain(`  ${oracle.job}:`)
        expect(workflow).toContain(oracle.invocation)
        expect(harness).toContain(oracle.entrypoint)
      }
    }

    expect(RFC349_T10_WORKFLOW_TEST_FILES).toEqual([
      'packages/backend/tests/rfc349-database-migration-admission.test.ts',
      'packages/backend/tests/rfc349-database-migration-artifact-reader.test.ts',
      'packages/backend/tests/rfc349-database-migration-runner.test.ts',
      'packages/backend/tests/rfc349-generation-store.test.ts',
      'packages/backend/tests/rfc349-logical-database-restore.test.ts',
      'packages/backend/tests/rfc349-migration-control-plane.test.ts',
      'packages/backend/tests/rfc349-migration-store-lock-recovery.test.ts',
      'packages/backend/tests/rfc349-postgresql-hosted-evidence.test.ts',
      'packages/backend/tests/rfc349-postgresql-target-faults.integration.test.ts',
    ])
  })

  test('executes real target faults before the honestly labeled full regression topology', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
    const realFaultTest = readFileSync(
      resolve(ROOT, 'packages/backend/tests/rfc349-postgresql-target-faults.integration.test.ts'),
      'utf8',
    )
    const regressionJob = / {2}functional-regression:[\s\S]*$/u.exec(workflow)?.[0]

    expect(workflow).toContain('sudo -u postgres createdb rfc349_target_faults')
    expect(workflow).toContain(
      'RFC349_TARGET_FAULTS_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/rfc349_target_faults',
    )
    expect(workflow).toContain(
      'packages/backend/tests/rfc349-postgresql-target-faults.integration.test.ts',
    )
    expect(realFaultTest).toContain(
      'const realTest = process.env.RFC349_TARGET_FAULTS_DATABASE_URL === undefined ? test.skip : test',
    )
    expect(realFaultTest).toContain('openPostgresqlLogicalTarget({')
    expect(realFaultTest).toContain('pg_terminate_backend(pg_backend_pid())')
    expect(realFaultTest).toContain("set_config('deadlock_timeout', '100ms', true)")
    expect(realFaultTest).toContain("ERRCODE = '53100'")
    expect(realFaultTest).toContain('expect(await copyState(runtime, chunk)).toEqual({')

    expect(regressionJob).toBeDefined()
    expect(regressionJob).toContain('needs: [crash-large-and-soak, compiled-external-postgresql]')
    for (const lane of RFC349_T10_FULL_REGRESSION_TOPOLOGY) {
      expect(regressionJob).toContain(lane.command)
    }
    expect(RFC349_T10_FULL_REGRESSION_TOPOLOGY.map((lane) => lane.evidenceRole)).toEqual([
      'provider-neutral-full-regression',
      'ui-only-full-regression',
      'ui-transport-full-regression',
    ])
    expect(regressionJob).toContain('Run full frontend regression (UI-only oracle)')
    expect(regressionJob).toContain('Run full E2E shard (UI/transport oracle)')
    expect(regressionJob).not.toContain('RFC349_DATABASE_URL')
    expect(regressionJob).not.toContain('RFC349_TARGET_FAULTS_DATABASE_URL')
  })

  // Why this test exists: the backend regression lane originally ran the WHOLE
  // backend suite un-sharded in a single VM. The first time it ever executed
  // (run 33722869768 @ b3883154e — every earlier run had it skipped by `needs:`)
  // the runner was killed twice, at ~20m and ~23m, with `The runner has received
  // a shutdown signal`, ZERO failing assertions, and two different cut points —
  // while the identical file set and env passed green in Main CI's four ~7m
  // ubuntu shards at that same SHA. One VM cannot carry four shards' worth of
  // this suite. Keep the lane sharded exactly like Main CI: if a refactor ever
  // collapses it back to one lane, this goes red instead of costing another
  // 23-minute unattributable runner death.
  test('runs the backend regression lane sharded exactly like Main CI', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')
    const regressionJob = / {2}functional-regression:[\s\S]*$/u.exec(workflow)?.[0]
    expect(regressionJob).toBeDefined()

    const backendLane = RFC349_T10_FULL_REGRESSION_TOPOLOGY.find(
      (lane) => lane.evidenceRole === 'provider-neutral-full-regression',
    )
    expect(backendLane?.shards).toBe(4)
    expect(backendLane?.command).toContain('--shard=${{ matrix.shard }}/4')

    // Every declared backend lane maps to a distinct shard, covering 1..4 with
    // no gap: a missing shard would silently drop a quarter of the suite while
    // the job still reported green.
    const declared = [
      ...(regressionJob ?? '').matchAll(/- lane: (backend-\d+)\n {12}shard: (\d+)/gu),
    ]
    expect(declared.map((match) => match[1])).toEqual([
      'backend-1',
      'backend-2',
      'backend-3',
      'backend-4',
    ])
    expect(declared.map((match) => Number(match[2]))).toEqual([1, 2, 3, 4])

    // The step guard must admit all four lanes, not just the historical `backend`.
    expect(regressionJob).toContain("if: startsWith(matrix.lane, 'backend-')")
    expect(regressionJob).not.toContain("if: matrix.lane == 'backend'")

    // Main CI's own backend lane stays the reference topology this mirrors.
    const mainCi = readFileSync(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(mainCi).toContain('shard: [1, 2, 3, 4]')
    expect(mainCi).toContain('--shard=${{ matrix.shard }}/4')
  })

  test('locks before/after crash coverage for every migration phase and the first target chunk', () => {
    expect(RFC349_DATABASE_MIGRATION_PHASES).toEqual([
      'planned',
      'preflighted',
      'source-frozen',
      'backed-up',
      'target-prepared',
      'copying',
      'verifying',
      'cutover-prepared',
      'switched',
      'health-checked',
      'accepting-writes',
      'finalized',
    ])
    expect(RFC349_CRASH_POINTS).toHaveLength(26)
    for (const phase of RFC349_DATABASE_MIGRATION_PHASES) {
      expect(RFC349_CRASH_POINTS).toContain(`before:${phase}`)
      expect(RFC349_CRASH_POINTS).toContain(`after:${phase}`)
    }
    expect(RFC349_CRASH_POINTS).toContain('before:copy-chunk')
    expect(RFC349_CRASH_POINTS).toContain('after:copy-chunk')
  })

  test('defaults to the full 100-client acceptance tier and validates explicit crash points', () => {
    const defaults = parseRfc349EvidenceArgs([])
    expect(defaults).toMatchObject({
      mode: 'crash-and-soak',
      clients: 100,
      durationMs: 180_000,
      scale: 'full',
      crashPoints: RFC349_CRASH_POINTS,
    })

    expect(
      parseRfc349EvidenceArgs([
        '--mode',
        'crash-matrix',
        '--crash-points',
        'before:planned,after:copy-chunk',
      ]).crashPoints,
    ).toEqual(['before:planned', 'after:copy-chunk'])
    expect(() => parseRfc349EvidenceArgs(['--crash-points', 'after:not-a-real-phase'])).toThrow(
      'unknown crash point',
    )
  })

  test('fails closed when a requested real-process crash checkpoint is absent', () => {
    expect(
      rfc349EvidenceFailures({ crashMatrix: [] }, ['before:planned', 'after:copy-chunk']),
    ).toEqual(['crash matrix missing before:planned', 'crash matrix missing after:copy-chunk'])
  })

  test('classifies disconnect, timeout and deadlock as retryable while constraint and storage failures stay fail-closed', () => {
    const retryable = [
      ['ECONNRESET', 'econnreset'],
      ['57014', '57014'],
      ['40001', '40001'],
      ['40P01', '40p01'],
    ] as const
    for (const [code, detailCode] of retryable) {
      expect(
        classifyDatabaseMigrationFailure(Object.assign(new Error(code), { code }), 'copying'),
      ).toEqual({ category: 'copy-transient', detailCode, retryable: true })
    }

    for (const [code, detailCode] of [
      ['23505', '23505'],
      ['53100', '53100'],
    ] as const) {
      expect(
        classifyDatabaseMigrationFailure(Object.assign(new Error(code), { code }), 'copying'),
      ).toEqual({ category: 'copy-permanent', detailCode, retryable: false })
    }
  })

  test('executes cancellation policy against every allowed and forbidden migration phase', () => {
    const allowed = new Set([
      'planned',
      'preflighted',
      'source-frozen',
      'backed-up',
      'target-prepared',
      'copying',
      'verifying',
    ])
    const digest = `sha256:${'a'.repeat(64)}`
    let manifest = createDatabaseMigrationManifest({
      operationId: 'dbm_t10_cancel_matrix',
      idempotencyKey: 't10-cancel-start',
      sourceGenerationId: 'dbg_t10_source',
      sourceSchemaDigest: digest,
      sourceDatabaseFingerprint: 'sqlite:t10',
      target: {
        provider: 'postgresql',
        urlEnv: 'RFC349_DATABASE_URL',
        poolMax: 4,
        connectTimeoutMs: 10_000,
        statementTimeoutMs: 60_000,
        idleTimeoutMs: 30_000,
      },
      ownerId: 'dbo_t10_owner',
      ownerLeaseExpiresAt: 60_000,
      tableCounts: { source: 184, active: 178, archiveOnly: 6 },
      now: 1,
    })

    for (const [index, phase] of DATABASE_MIGRATION_PHASES.entries()) {
      expect(manifest.payload.phase).toBe(phase)
      const cancel = () =>
        requestDatabaseMigrationCancellation(manifest, {
          expectedRevision: manifest.payload.revision,
          ownerId: manifest.payload.owner.id,
          ownerFence: manifest.payload.owner.fence,
          now: 100 + index,
        })
      if (allowed.has(phase)) {
        expect(cancel().payload.cancellationRequestedAt).toBe(100 + index)
      } else {
        expect(cancel).toThrow(`database migration cannot cancel during ${phase}`)
      }

      const nextPhase = DATABASE_MIGRATION_PHASES[index + 1]
      if (nextPhase === undefined) continue
      manifest = advanceDatabaseMigration(manifest, {
        expectedRevision: manifest.payload.revision,
        expectedPhase: phase,
        nextPhase,
        ownerId: manifest.payload.owner.id,
        ownerFence: manifest.payload.owner.fence,
        idempotencyKey: `t10-phase-${nextPhase}`,
        now: 200 + index,
        ...(nextPhase === 'preflighted' ? { targetDatabaseFingerprint: 'pg:t10' } : {}),
        ...(nextPhase === 'backed-up' ? { logicalBackupDigest: digest } : {}),
        ...(nextPhase === 'verifying' ? { verificationDigest: digest } : {}),
        ...(nextPhase === 'finalized' ? { receiptDigest: digest } : {}),
      })
    }
  })

  test('runs a native compiled-binary matrix against runner-owned PostgreSQL', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf8')

    expect(workflow).toContain('os: [ubuntu-24.04, macos-15, windows-2025]')
    expect(workflow).toContain('sudo systemctl start postgresql.service')
    expect(workflow).toContain('brew install postgresql@17')
    expect(workflow).toContain("Get-Service -Name 'postgresql-x64-*'")
    expect(workflow).toContain('bun run build:binary:e2e')
    expect(workflow).toContain('--mode compiled-smoke')
    expect(workflow).toContain("github.event_name == 'schedule' && 'full'")
    expect(workflow).toContain("github.event_name == 'schedule' && '100'")
    expect(workflow).toContain('--mode crash-and-soak')
    expect(workflow).toContain('actions/upload-artifact@v6')
    expect(workflow).not.toContain('services:\n')
    expect(workflow).not.toContain('docker run')
  })

  test('hides PostgreSQL tools from the application and records production pool telemetry', () => {
    const harness = readFileSync(HARNESS_PATH, 'utf8')

    expect(harness).toContain("hiddenTools: ['psql', 'pg_dump', 'postgres'] as const")
    expect(harness).toContain("'PGBIN'")
    expect(harness).toContain('HIDDEN_POSTGRESQL_HOST_KEYS.has(entry[0].toUpperCase())')
    expect(harness).toContain('PATH: hiddenPath')
    expect(harness).toContain('Path: hiddenPath')
    expect(harness).toContain("Bun.which('git', { PATH: process.env.PATH ?? '' })")
    expect(harness).toContain('PostgreSQL tool remained visible on isolated application PATH')
    expect(harness).toContain("status.database?.provider === 'postgresql'")
    expect(harness).toContain('status.database.poolWait')
    expect(harness).toContain('external-bun-sql-sidecar-acquire')
    expect(harness).toContain('serverProcessOutsideBinary: true')
  })

  test('kills only after durable store/phase/chunk boundaries and resumes the same operation', () => {
    const worker = readFileSync(CRASH_WORKER_PATH, 'utf8')

    expect(worker).toContain("const OPERATION_ID = 'dbm_hosted_crash_matrix'")
    expect(worker).toContain('beforeReplaceForTest(operationId, revision)')
    expect(worker).toContain("maybeHold(input, 'before:planned')")
    expect(worker).toContain('afterReplaceForTest(operationId, revision)')
    expect(worker).toContain("maybeHold(input, 'after:planned')")
    expect(worker).toContain('maybeHold(input, `before:${transition.nextPhase}`)')
    expect(worker).toContain('maybeHold(input, `after:${transition.nextPhase}`)')
    expect(worker).toContain("maybeHold(input, 'before:copy-chunk')")
    expect(worker).toContain("maybeHold(input, 'after:copy-chunk')")
    expect(worker).toContain('const accepting = await runner.run(OPERATION_ID)')
    expect(worker).toContain('const finalized = await runner.finalize(OPERATION_ID)')
  })
})
