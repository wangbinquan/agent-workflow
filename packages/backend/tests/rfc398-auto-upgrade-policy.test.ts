import { startMaintenanceTicker } from '@/services/maintenanceTicker'
// RFC-398 §2.1/2.3/2.4B,F/2.5: policy tables include negative controls.
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  autoUpgradeTrigger,
  foldAutoUpgradeSession,
  evaluateAutoUpgradePlan,
  classifyAutoUpgradeRun,
  autoUpgradeRollbackCommitment,
  AUTO_UPGRADE_RECORD_KINDS,
  type AutoUpgradeRecord,
} from '@/modules/system-operations/domain/epochSwitch/autoUpgrade'
import {
  classifyEpochInstallation,
  type InstallationFacts,
} from '@/modules/system-operations/domain/epochSwitch/classification'
import { EpochSwitchError } from '@/modules/system-operations/domain/epochSwitch/model'
import { createAutoUpgradeRecords } from '@/modules/system-operations/infrastructure/epochSwitch/autoUpgradeRecords'
import { createFileEpochSwitchJournal } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { createLocalEpochArtifacts } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { createLocalEpochQuiesce } from '@/modules/system-operations/infrastructure/local/epochSwitchQuiesce'
import { makeSwitchFixture, plannedFixture } from './helpers/rfc395V3SwitchFixture'
import { epochMigrationCommand } from '@/cli/epochMigration'
import { ConfigSchema, DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createAutoUpgradeSessionLock } from '@/modules/system-operations/infrastructure/local/autoUpgradeSessionLock'
import { autoUpgrade } from '@/modules/system-operations/application/epochSwitch/autoUpgrade'
import { withEpochOperation } from '@/modules/system-operations/application/epochSwitch/session'
import { createEpochInstallationProbe } from '@/modules/system-operations/infrastructure/epochSwitch/installationProbe'
import type { LegacyMigrationFinalizePort } from '@/modules/system-operations/application/ports/epochSwitch'
import {
  MigrationPlanBlockSchema,
  MigrationRowDispositionSchema,
} from '@/modules/system-operations/domain/epochSwitch/documents'

const id = 'dbm_e2_policy_fixture'
const records = (kinds: AutoUpgradeRecord['kind'][]) =>
  kinds.map(
    (kind, i): AutoUpgradeRecord => ({
      version: 1,
      operationId: id,
      sequence: i + 1,
      kind,
      at: i,
      data:
        kind === 'intent'
          ? { sessionSequence: 1, provider: 'sqlite', candidateBuild: 'test', trigger: 'epoch1' }
          : {},
    }),
  )
const base: InstallationFacts = {
  pointer: null,
  provider: 'sqlite',
  sourceExists: true,
  operation: null,
  rfc349Operation: null,
  activationReceiptDigest: null,
  targetState: null,
  rollbackIncomplete: false,
}

for (const phase of ['accepting-writes', 'copying'] as const)
  test(`legacy ${phase}: intent precedes the T4 port; only a finalizable operation reaches discovery`, async () => {
    const f = makeSwitchFixture()
    try {
      const port = createAutoUpgradeRecords(f.root)
      const probe = f.deps.installation
      let finalized = false
      f.deps.installation = async () => {
        const installation = await probe()
        return {
          ...installation,
          facts: {
            ...installation.facts,
            rfc349Operation: finalized ? null : 'dbm_legacy_fixture',
          },
        }
      }
      // Only phase and rollback state cross this orchestration decision. T4's own tests
      // exercise the real finalize port against captured old-release database artifacts.
      const status = { phase, rolledBackAt: null } as Awaited<
        ReturnType<LegacyMigrationFinalizePort['status']>
      >
      const result = await autoUpgrade({
        epoch: f.deps,
        application: f.app,
        records: port,
        enabled: true,
        standalone: true,
        lock: {
          acquire: async () => {},
          bind: async () => {},
          assertHeld: async () => {},
          release: async () => {},
        },
        legacy: {
          async status() {
            expect((await port.list())[0]!.records[0]!.kind).toBe('intent')
            expect(await f.deps.journal.list()).toEqual([])
            return status
          },
          async finalize() {
            expect(phase).toBe('accepting-writes')
            finalized = true
            return { ...status, phase: 'finalized' }
          },
        },
      })
      expect(result.exitCode).toBe(phase === 'accepting-writes' ? 0 : 3)
      const session = (await port.list())[0]!
      expect(session.records.some((r) => r.kind === 'rfc349-finalized')).toBe(finalized)
      expect(session.outcome).toBe(finalized ? 'completed' : null)
      if (!finalized) {
        expect(session.records.at(-1)!.data.reason).toBe('rfc349-operation-unfinished')
        expect(await f.deps.journal.list()).toEqual([])
      }
    } finally {
      f.close()
    }
  })

test('configuration defaults on; a fresh installation does not trigger conversion', () => {
  // A config.json written before RFC-398 has no key at all: the default turns automation on.
  const { autoEpochMigration: _absent, ...legacyConfig } = DEFAULT_CONFIG
  expect(ConfigSchema.parse(legacyConfig).autoEpochMigration).toBe(true)
  expect(
    ConfigSchema.parse({ ...DEFAULT_CONFIG, autoEpochMigration: false }).autoEpochMigration,
  ).toBe(false)
  const facts = { ...base, sourceExists: false }
  expect(
    autoUpgradeTrigger({
      facts,
      installation: classifyEpochInstallation(facts),
      standalone: true,
      enabled: true,
    }).kind,
  ).toBe('noop')
})

for (const [name, kinds, enabled, standalone, retry, expected] of [
  ['epoch1', [], true, true, false, 'start'],
  ['disabled', [], false, true, false, 'noop'],
  ['hosted', [], true, false, false, 'noop'],
  ['unfinished', ['intent'], true, true, false, 'resume'],
  ['refused resumes', ['intent', 'refused'], true, true, false, 'resume'],
  ['rollback commitment resumes', ['intent', 'verify-failed'], true, true, false, 'resume'],
  [
    'verification failure',
    ['intent', 'verify-failed', 'rolled-back', 'failed'],
    true,
    true,
    false,
    'refuse',
  ],
  [
    'explicit retry',
    ['intent', 'verify-failed', 'rolled-back', 'failed'],
    true,
    true,
    true,
    'start',
  ],
] as const)
  test(`trigger: ${name}`, () => {
    const facts = {
      ...base,
      autoUpgradeSessions: kinds.length ? [foldAutoUpgradeSession(records([...kinds]))] : [],
    }
    expect(
      autoUpgradeTrigger({
        facts,
        installation: classifyEpochInstallation(facts),
        enabled,
        standalone,
        retry,
      }).kind,
    ).toBe(expected)
  })

test('fold accepts exactly the RFC record kinds and only completed/failed close a session', () => {
  expect(AUTO_UPGRADE_RECORD_KINDS).toEqual([
    'intent',
    'rfc349-finalized',
    'provisioned',
    'plan-evaluated',
    'approved',
    'refused',
    'verify-failed',
    'rolled-back',
    'completed',
    'failed',
  ])
  for (const kind of AUTO_UPGRADE_RECORD_KINDS.filter((k) => k !== 'intent')) {
    const session = foldAutoUpgradeSession(records(['intent', kind]))
    expect(session.unfinished).toBe(!['completed', 'failed'].includes(kind))
  }
  for (const kinds of [
    [],
    ['approved'],
    ['intent', 'completed', 'refused'],
    ['intent', 'verify-failed', 'completed'],
  ] as AutoUpgradeRecord['kind'][][])
    expect(() => foldAutoUpgradeSession(records(kinds))).toThrow()
})

for (const [value, expected] of [
  [{ status: 'awaiting-approval' }, 'awaiting-approval'],
  [
    new EpochSwitchError('v3-approval-required', { category: 'approval-required' }),
    'awaiting-approval',
  ],
  [{ failure: { category: 'source-changed', detailCode: 'v3-source-changed' } }, 'new-run'],
  [new EpochSwitchError('v3-source-changed', { category: 'source-changed' }), 'new-run'],
  [
    new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
      category: 'source-changed',
    }),
    'new-run',
  ],
  [{ phase: 'activated', status: 'running' }, 'activated'],
  [{ phase: 'activated', status: 'failed' }, 'error'],
  [new EpochSwitchError('v3-acceptance-failed', { category: 'health-failed' }), 'error'],
  [new Error('network'), 'error'],
] as const)
  test(`run failure classification: ${JSON.stringify(value)}`, () => {
    expect(classifyAutoUpgradeRun(value)).toBe(expected)
  })

test('rollback commitment table ignores ordinary failures, tmp files, positive evidence and other runs', () => {
  const session = foldAutoUpgradeSession(records(['intent']))
  const health = { passed: false, catalogAdmitted: true, probes: [] }
  const evidence = { published: true, runId: 'run1', name: 'acceptance-health-9.json', health }
  const check = (
    failure: { category: string; detailCode: string } | null,
    artifacts = [evidence],
  ) => autoUpgradeRollbackCommitment({ session, runId: 'run1', failure, artifacts })
  expect(check(null)).toBe('published-negative-acceptance')
  expect(check({ category: 'health-failed', detailCode: 'v3-acceptance-failed' }, [])).toBe(
    'journal-acceptance-failed',
  )
  for (const failure of [
    { category: 'source-changed', detailCode: 'v3-source-changed' },
    { category: 'health-failed', detailCode: 'other' },
    { category: 'internal', detailCode: 'v3-acceptance-failed' },
  ])
    expect(check(failure, [])).toBeNull()
  for (const item of [
    { ...evidence, published: false },
    { ...evidence, runId: 'old' },
    { ...evidence, name: 'acceptance-health-9.json.tmp' },
    { ...evidence, health: { ...health, passed: true } },
  ])
    expect(check(null, [item])).toBeNull()
  expect(
    autoUpgradeRollbackCommitment({
      session: foldAutoUpgradeSession(records(['intent', 'verify-failed'])),
      runId: null,
      failure: null,
      artifacts: [],
    }),
  ).toBe('verify-failed')
})

test('plan blocks including acknowledgeable items are refused; restrictions retain the exact approval digest', async () => {
  const f = await plannedFixture()
  try {
    expect(evaluateAutoUpgradePlan(f.plan.plan)).toMatchObject({
      kind: 'approve',
      digest: f.plan.plan.approvalDigest,
    })
    const block = MigrationPlanBlockSchema.parse({
      id: 'item',
      block: {
        code: 'v2-code-history-unfinished',
        scope: 'row',
        sourceTable: 'code_work_items',
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: [],
        detail: null,
        acknowledgeable: true,
      },
      remediation: { action: 'acknowledge', message: 'Explicit operator decision required' },
    })
    const plan = {
      ...f.plan.plan,
      payload: { ...f.plan.plan.payload, blocks: [block] },
    }
    expect(evaluateAutoUpgradePlan(plan)).toMatchObject({ kind: 'refuse', reasons: [block] })
    const restriction = MigrationRowDispositionSchema.parse({
      sourceTable: 'tasks',
      sourceKey: 'mk1:test',
      class: 'preserved',
      kind: 'history-only',
      targets: [],
      archive: null,
      rule: { id: 'task-facts', version: 1 },
      decision: null,
      history: {
        execution: 'terminal-history',
        taskId: 'old-task',
        runId: null,
        missingFields: [],
      },
    })
    expect(
      evaluateAutoUpgradePlan({
        ...f.plan.plan,
        payload: { ...f.plan.plan.payload, restrictions: [restriction] },
      }),
    ).toMatchObject({
      kind: 'approve',
      digest: f.plan.plan.approvalDigest,
      restrictions: [restriction],
    })
    const journal = (await f.deps.journal.read(f.operationId))!
    const facts = { ...base, operation: journal }
    expect(
      autoUpgradeTrigger({
        facts,
        installation: classifyEpochInstallation(facts),
        enabled: true,
        standalone: true,
      }).reason,
    ).toBe('manual-operation-active')
    const auto = {
      ...facts,
      autoUpgradeSessions: [
        foldAutoUpgradeSession(
          records(['intent']).map((r) => ({ ...r, operationId: f.operationId })),
        ),
      ],
    }
    const activated = await f.app.run({
      operationId: f.operationId,
      approve: f.plan.plan.approvalDigest,
    })
    expect(
      autoUpgradeTrigger({
        facts: auto,
        installation: { kind: 'epoch2', pointer: {} as never, operation: activated.journal },
        enabled: true,
        standalone: true,
      }).kind,
    ).toBe('resume')
    const closed = {
      ...auto,
      operation: activated.journal,
      autoUpgradeSessions: [
        foldAutoUpgradeSession(
          records(['intent', 'completed']).map((r) => ({ ...r, operationId: f.operationId })),
        ),
      ],
    }
    for (const reason of [
      'activation-unreconciled',
      'pointer-receipt-mismatch',
      'target-retired',
    ] as const)
      expect(
        autoUpgradeTrigger({
          facts: closed,
          installation: { kind: 'switch-recovery-required', operation: activated.journal, reason },
          enabled: true,
          standalone: true,
        }).kind,
      ).toBe(reason === 'activation-unreconciled' ? 'resume' : 'noop')
    for (const args of [
      ['auto', '--retry', '--json'],
      ['auto', '--json'],
    ]) {
      const result = await epochMigrationCommand(args, {
        application: f.app,
        autoUpgrade: async () => ({
          mode: 'auto',
          outcome: 'refused',
          exitCode: 3,
          operationId: id,
          guidance: ['fix block'],
        }),
      })
      expect(result.exitCode).toBe(3)
      expect(JSON.parse(result.output).guidance).toEqual(['fix block'])
    }
    expect(
      (await epochMigrationCommand(['auto', 'unexpected'], { application: f.app })).status,
    ).toBe('usage-error')
  } finally {
    f.close()
  }
})

test('records are numbered/write-once; scanner finds unreferenced publication and ignores tmp; journal ignores auto-upgrade', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-auto-records-'))
  try {
    const port = createAutoUpgradeRecords(home)
    await port.append(id, 'intent', { sessionSequence: 1 })
    const path = join(home, 'database-migrations/auto-upgrade/sessions', id, '0001-intent.json')
    const original = readFileSync(path)
    await port.append(id, 'refused', { reason: 'test' })
    expect(readFileSync(path)).toEqual(original)
    expect((await port.list())[0]!.unfinished).toBe(true)
    const root = join(home, 'database-migrations', id)
    mkdirSync(join(root, '.artifacts'), { recursive: true })
    writeFileSync(join(root, '.artifacts', 'negative.tmp'), JSON.stringify({ passed: false }))
    expect(await port.acceptance(id, 'run')).toEqual([])
    await createLocalEpochArtifacts(root).put(
      'acceptance-health-7.json',
      Buffer.from(JSON.stringify({ passed: false, catalogAdmitted: true, probes: [] })),
    )
    expect(await port.acceptance(id, 'run')).toHaveLength(1)
    expect(
      await createFileEpochSwitchJournal({ root: join(home, 'database-migrations') }).list(),
    ).toEqual([])
    const installation = await createEpochInstallationProbe({
      pointerPath: join(home, 'database-generation.json'),
      migrationsRoot: join(home, 'database-migrations'),
      provider: 'sqlite',
      source: {
        kind: 'sqlite-file',
        path: join(home, 'db.sqlite'),
        pointerPath: join(home, 'database-generation.json'),
      },
      journal: createFileEpochSwitchJournal({ root: join(home, 'database-migrations') }),
    })()
    expect(installation.facts.rfc349Operation).toBeNull()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('discovery honors the intent identity only when creating an operation', async () => {
  const f = makeSwitchFixture()
  try {
    const requestedOperationId = 'dbm_e2_intent_identity'
    const first = await f.app.plan({ requestedOperationId })
    expect(first.operationId).toBe(requestedOperationId)
    const resumed = await f.app.plan({
      operationId: requestedOperationId,
      requestedOperationId: 'dbm_e2_ignored_on_resume',
    })
    expect(resumed.operationId).toBe(requestedOperationId)
    expect((await f.deps.journal.list()).map((j) => j.payload.operationId)).toEqual([
      requestedOperationId,
    ])
  } finally {
    f.close()
  }
})

test('a frozen run reuses the persisted plan, approves at most three times, and handles both returned and thrown approval requests', async () => {
  const f = await plannedFixture()
  try {
    const port = createAutoUpgradeRecords(f.root)
    await port.append(f.operationId, 'intent', { sessionSequence: 1 })
    let plans = 0,
      runs = 0
    const result = await autoUpgrade({
      epoch: f.deps,
      records: port,
      enabled: true,
      standalone: true,
      lock: {
        acquire: async () => {},
        bind: async () => {},
        assertHeld: async () => {},
        release: async () => {},
      },
      legacy: {
        status: async () => {
          throw new Error('no legacy operation')
        },
        finalize: async () => {
          throw new Error('no legacy operation')
        },
      },
      application: {
        ...f.app,
        async plan(input) {
          plans++
          expect((await f.deps.journal.read(f.operationId))!.payload.phase).toBe('planned')
          return f.app.plan(input)
        },
        async run(input) {
          runs++
          const journal = (await f.deps.journal.read(f.operationId))!
          expect(input.approve).toBe(journal.payload.plan!.approvalDigest)
          // Reach frozen + awaiting-approval through legal one-step transitions, recording the
          // approval the way the real runner does before backing up (transitions.ts reviseEpochSwitch).
          await withEpochOperation(f.deps, f.operationId, async (session) => {
            const p = session.journal.payload
            if (p.phase === 'planned') {
              await session.save({
                plan: {
                  ...p.plan!,
                  approvedDigest: p.plan!.approvalDigest,
                  approvedAt: session.now(),
                },
              })
              await session.save({ phase: 'backed-up' })
              await session.save({ phase: 'quiescing' })
              await session.save({ phase: 'frozen', status: 'awaiting-approval' })
            } else await session.save({ status: 'awaiting-approval' })
          })
          if (runs % 2 === 0)
            throw new EpochSwitchError('v3-approval-required', { category: 'approval-required' })
          return f.app.status({ operationId: f.operationId }) as ReturnType<typeof f.app.run>
        },
      },
    })
    expect(result).toMatchObject({ outcome: 'refused', exitCode: 3 })
    expect(plans).toBe(1)
    expect(runs).toBe(4) // initial approved run, then three permitted re-approvals
    const session = (await port.list())[0]!
    expect(session.unfinished).toBe(true)
    expect(
      session.records.filter((r) => r.kind === 'plan-evaluated' && r.data.reapproval),
    ).toHaveLength(3)
    expect(session.records.at(-1)!.data.reason).toBe('approval-retry-limit')
  } finally {
    f.close()
  }
})

// Implementation gate r1 P1-1: a PostgreSQL new-run retires the old target before the journal
// CAS. Death in between leaves the journal on the old run with a persisted source change; the
// session must resume through new-run (which provisions the next run) instead of preparing the
// retired old target, whose refusal would otherwise block start and --retry forever.
test('a persisted source change resumes through new-run without re-preparing the old target', async () => {
  const f = await plannedFixture()
  try {
    const port = createAutoUpgradeRecords(f.root)
    await port.append(f.operationId, 'intent', { sessionSequence: 1 })
    await withEpochOperation(f.deps, f.operationId, async (session) => {
      const p = session.journal.payload
      await session.save({
        plan: { ...p.plan!, approvedDigest: p.plan!.approvalDigest, approvedAt: session.now() },
      })
      await session.save({ phase: 'backed-up' })
      await session.save({ phase: 'quiescing' })
      await session.save({ phase: 'frozen' })
      await session.save({ phase: 'converting' })
      await session.save({
        status: 'failed',
        failure: {
          phase: 'converting',
          category: 'source-changed',
          detailCode: 'v3-source-changed',
          retryable: true,
          failedAt: session.now(),
        },
      })
    })
    let prepares = 0,
      newRuns = 0
    const result = await autoUpgrade({
      epoch: {
        ...f.deps,
        async installation() {
          const observed = await f.deps.installation()
          return { ...observed, facts: { ...observed.facts, provider: 'postgresql' } }
        },
      },
      records: port,
      enabled: true,
      standalone: true,
      lock: {
        acquire: async () => {},
        bind: async () => {},
        assertHeld: async () => {},
        release: async () => {},
      },
      legacy: {
        status: async () => {
          throw new Error('no legacy operation')
        },
        finalize: async () => {
          throw new Error('no legacy operation')
        },
      },
      provisioning: {
        async prepare() {
          prepares++
          throw Object.assign(new Error('retired old target'), {
            code: 'postgresql-target-not-empty',
            detail: { reason: 'retired' },
          })
        },
        retained: async () => [],
        async nextTargetLocation() {
          throw new Error('not reached by this orchestration double')
        },
      },
      application: {
        ...f.app,
        async run(input) {
          if (!input.newRun) throw new Error(`unexpected run ${JSON.stringify(input)}`)
          newRuns++
          throw new Error('new-run-reached')
        },
      },
    })
    expect({ prepares, newRuns }).toEqual({ prepares: 0, newRuns: 1 })
    expect(result.outcome).toBe('error')
    expect(result.guidance.join('\n')).toContain('new-run-reached')
  } finally {
    f.close()
  }
})

test('borrowed quiesce does not signal, acquire or release the daemon lock', async () => {
  let asserted = 0
  const fail = () => {
    throw new Error('must not touch physical protocol')
  }
  const quiesce = createLocalEpochQuiesce({
    lockPath: 'unused',
    controlPath: 'unused',
    sessionLock: {
      acquire: async () => {},
      bind: async () => {},
      assertHeld: async () => {
        asserted++
      },
      release: async () => {
        fail()
      },
    },
    protocol: {
      pid: fail,
      alive: fail,
      request: async () => fail(),
      acquire: fail,
      wait: async () => fail(),
    },
  })
  await quiesce.quiesce({ operationId: id, drainTimeoutMs: 1 })
  await quiesce.assertHeld(id)
  await quiesce.release(id)
  expect(asserted).toBe(2)
})

test('a delegation must match both the actual parent and lock PID; rejected delegation leaves no active session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-auto-delegation-'))
  try {
    writeFileSync(join(home, '.daemon.lock'), String(process.pid))
    const lock = createAutoUpgradeSessionLock({
      appHome: home,
      delegation: String(process.ppid),
      startMonitor: (onTick) =>
        startMaintenanceTicker({
          job: 'auto-upgrade-lock',
          intervalMs: 1000,
          phaseOffsetMs: 1000,
          keepAlive: true,
          onTick,
        }),
    })
    await expect(lock.acquire()).rejects.toThrow('delegation-invalid')
    expect(readFileSync(join(home, '.daemon.lock'), 'utf8')).toBe(String(process.pid))
    expect(await createAutoUpgradeRecords(home).list()).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
