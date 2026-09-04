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
  RFC349_LATENCY_BUDGETS_MS,
  RFC349_T10_REGRESSION_COVERAGE_OWNERS,
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

  test('executes real target faults, and carries no provider-neutral regression lanes', () => {
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

    // 这条 workflow 此后**只**做真 PostgreSQL 取证：provider-neutral 的全量回归
    // 已于 2026-09-04 移除（去向见 RFC349_T10_REGRESSION_COVERAGE_OWNERS 与下一条
    // 用例）。它们从来不产出 provider 证据，却让整条的墙钟变成两段之和。
    expect(regressionJob).toBeUndefined()
    expect(workflow).not.toContain('functional-regression')
  })

  // Why this test exists: the 9 provider-neutral regression lanes that used to
  // hang off this workflow were deleted on 2026-09-04 (they produced no provider
  // evidence and doubled the wall clock — see RFC349_T10_REGRESSION_COVERAGE_OWNERS
  // for the measured breakdown). Deleting duplicated coverage is only safe while
  // the leg it was duplicating still exists. This walks the cost list row by row
  // and re-checks the OWNER workflow, so "the lane we deferred to quietly lost
  // that coverage" goes red here instead of silently reopening the hole.
  //
  // Each row also records WHY the surviving leg is the stronger one; that clause
  // is asserted too, so a downgrade there (Main CI pinning a fixed seed, dropping
  // an OS, the nightly re-adding a `--grep-invert`) is caught as well.
  test('every deleted regression lane still has its coverage owner, and the owner is the stronger leg', () => {
    const owners = {
      'ci.yml': readFileSync(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
      'e2e-full-nightly.yml': readFileSync(
        resolve(ROOT, '.github', 'workflows', 'e2e-full-nightly.yml'),
        'utf8',
      ),
    } as const

    expect(RFC349_T10_REGRESSION_COVERAGE_OWNERS.map((row) => row.evidenceRole)).toEqual([
      'provider-neutral-full-regression',
      'ui-only-full-regression',
      'ui-transport-full-regression',
    ])

    for (const row of RFC349_T10_REGRESSION_COVERAGE_OWNERS) {
      const owner = owners[row.ownerWorkflow as keyof typeof owners]
      expect({ lane: row.lane, ownerFound: owner !== undefined }).toEqual({
        lane: row.lane,
        ownerFound: true,
      })
      // 那条命令确实还在归属方跑着。
      expect({ lane: row.lane, runs: owner.includes(row.command) }).toEqual({
        lane: row.lane,
        runs: true,
      })
      // 归属方仍然是更强的那一份（换种子 / 多 OS / 全量档）。
      expect({ lane: row.lane, stronger: owner.includes(row.strongerBecause) }).toEqual({
        lane: row.lane,
        stronger: true,
      })
    }

    // Main CI 的后端腿仍是四分片——删掉的那条当年就是照它抄的，也是它兜住这份覆盖。
    expect(owners['ci.yml']).toContain('shard: [1, 2, 3, 4]')
    // 全量 e2e 腿不得重新加上 PR 档的过滤，否则 `@nightly` 会全域失守：删掉的那 9 条
    // lane 里的 e2e 正是靠「不过滤」才和它等价。只看真正执行的 `run:` 行——这份 YAML 的
    // 注释里就写着 PR 档用 `--grep-invert '@nightly'`，全文匹配会把注释也算进去。
    const nightlyRunLines = owners['e2e-full-nightly.yml']
      .split('\n')
      .filter((line) => /^\s*run:/u.test(line))
    expect(nightlyRunLines.filter((line) => line.includes('--grep-invert'))).toEqual([])
  })

  // Why this test exists: the backend regression lane that used to live here
  // needed Main CI's ENVIRONMENT, not just its command — run 33732387691 went red
  // on two gaps that were purely environmental (RFC-294 N1a provenance guards need
  // `fetch-depth: 0`; `doctor returns ok when opencode + git present` needs a real
  // opencode on PATH). Now that the lane is gone, those two properties have to
  // hold on the leg that inherited the coverage, or the same two failures simply
  // move rather than being covered.
  test('the owning Main CI backend job still carries the environment that lane needed', () => {
    const mainCi = readFileSync(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

    expect(mainCi).toContain('fetch-depth: 0')
    expect(mainCi).toContain('bun install -g opencode-ai@latest')
    // 两个 OS 都要跑：删掉的那条只有 ubuntu，Main CI 是它的超集。
    expect(mainCi).toContain('os: [ubuntu-latest, macos-latest]')
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

  // Why this test exists: these two millisecond budgets used to measure the hosted
  // runner's jitter rather than the product's responsiveness. Two runs of the SAME
  // weekly tier with ZERO changes to the migration path split on them —
  // `33814856037` PASS (status max 772ms / event-loop max 139ms) vs `33822438279`
  // FAIL (1001.3ms / 994.7ms) — while both reported errors=0, identical row counts,
  // pool-wait p95 under 0.08ms, and only 7.6% apart on copy throughput. The daemon's
  // own stall diagnostics named the cause: the worst gap carried `heapDeltaMib=8`
  // and the same run logged a `heapDeltaMib=-69` whole-heap reclaim — major GC, not
  // the product blocking the loop.
  //
  // Recalibrated 2026-09-04 against "what a real freeze looks like" (same method
  // RFC-338 used in f374ffb10), and the numbers below ARE the decision — locking
  // them so changing one requires writing a new reason.
  test('latency budgets are calibrated against a real freeze, not runner jitter', () => {
    expect(RFC349_LATENCY_BUDGETS_MS).toEqual({
      // 稳态相位不含割接屏障，实测 152.6 / 388.5 / 299.2ms —— 没有放松。
      steadyPhaseMax: 1_000,
      // 割接屏障是这一段最坏的**合法**情形：历轮 585/617/643/772/833/1001ms。
      migrationStatusMax: 2_500,
      // 尾部放宽了就得有不受单样本摆布的判据顶上（实测 p95 73ms / 188ms）。
      migrationStatusP95: 500,
      // 真冻结 = 整个 copying 相位（weekly 档 ≈400,000ms）；实测 max 995ms。
      migrationEventLoopMax: 2_000,
    })
    // 放开的两条都必须仍远小于「真冻结」的量级，否则就不是放宽而是取消判据。
    const weeklyCopyPhaseMs = 6.7 * 60 * 1_000
    expect(RFC349_LATENCY_BUDGETS_MS.migrationEventLoopMax).toBeLessThan(weeklyCopyPhaseMs / 100)
    expect(RFC349_LATENCY_BUDGETS_MS.migrationStatusMax).toBeLessThan(weeklyCopyPhaseMs / 100)
  })

  // Why this test exists: the point of widening the tail budgets was to stop failing
  // on machine jitter WITHOUT losing the ability to catch a real regression. These
  // two fixtures are the exact numbers from the two runs above, so the recalibration
  // is judged against the evidence that motivated it rather than against invented
  // values — and the third fixture proves the new p95 rail actually bites.
  test('the recalibrated budgets pass both real runs but still fail a genuine regression', () => {
    const migration = (over: Partial<{ p95: number; max: number; loop: number }>) => ({
      migration: {
        statusErrors: 0,
        status: { count: 900, p50Ms: 40, p95Ms: over.p95 ?? 73, maxMs: over.max ?? 772 },
        eventLoopMaxGapMs: over.loop ?? 139,
        poolWait: { sampleCount: 120, failedCount: 0 },
        externalPoolProbe: { count: 120, errors: 0 },
        finalStatus: { phase: 'accepting-writes' as const },
      },
    })

    // run 33814856037（当时 PASS）与 33822438279（当时 FAIL，纯机器抖动）现在都放行。
    expect(rfc349EvidenceFailures(migration({}) as never)).toEqual([])
    expect(
      rfc349EvidenceFailures(migration({ p95: 188, max: 1001.3, loop: 994.7 }) as never),
    ).toEqual([])

    // 真退化：整条分布被推上去（p95 越线），必须仍然红——这正是尾部放宽后顶上的那条。
    expect(rfc349EvidenceFailures(migration({ p95: 620 }) as never)).toEqual([
      'migration status p95 620.0ms >= 500ms',
    ])
    // 尾部也不是没有天花板：秒级以上的失控屏障照样红。
    expect(rfc349EvidenceFailures(migration({ max: 3_000 }) as never)).toEqual([
      'migration status max 3000.0ms >= 2500ms',
    ])
    expect(rfc349EvidenceFailures(migration({ loop: 2_500 }) as never)).toEqual([
      'migration event-loop max 2500.0ms >= 2000ms',
    ])
  })

  // Why this test exists: widening a budget is only safe if the criteria that
  // actually carry the claim were left alone. A regression that swapped one of these
  // for a latency threshold would otherwise look like "we loosened the flaky bits".
  test('the non-latency criteria still fail closed after the recalibration', () => {
    const base = {
      statusErrors: 0,
      status: { count: 900, p50Ms: 40, p95Ms: 73, maxMs: 772 },
      eventLoopMaxGapMs: 139,
      poolWait: { sampleCount: 120, failedCount: 0 },
      externalPoolProbe: { count: 120, errors: 0 },
      finalStatus: { phase: 'accepting-writes' as const },
    }
    const cases: [string, Record<string, unknown>, string][] = [
      ['status errors', { statusErrors: 3 }, 'migration status errors=3'],
      ['no samples', { status: { ...base.status, count: 0 } }, 'migration has no status samples'],
      [
        'pool acquisition',
        { poolWait: { sampleCount: 120, failedCount: 2 } },
        'migration PostgreSQL pool acquisition failures=2',
      ],
      [
        'probe errors',
        { externalPoolProbe: { count: 120, errors: 1 } },
        'migration external pool probe errors=1',
      ],
      ['phase', { finalStatus: { phase: 'copying' } }, 'migration phase=copying'],
    ]
    for (const [name, patch, expected] of cases) {
      expect({
        name,
        failures: rfc349EvidenceFailures({ migration: { ...base, ...patch } } as never),
      }).toEqual({ name, failures: [expected] })
    }
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
    // The cron runs the `weekly` drift tier (see RFC349_EVIDENCE_TIERS for the
    // measured breakdown that made a full-tier cron a two-hour run); `full` stays
    // dispatchable and is what the RFC's acceptance evidence was taken on. The
    // 100-client tier and the crash matrix are unchanged at every tier.
    expect(workflow).toContain("github.event_name == 'schedule' && 'weekly'")
    expect(workflow).toContain('options: [weekly, full, small]')
    expect(workflow).toContain("github.event_name == 'schedule' && '100'")
    expect(workflow).toContain("github.event_name == 'schedule' && '180'")
    expect(workflow).toContain("github.event_name == 'schedule' && 'all'")
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
