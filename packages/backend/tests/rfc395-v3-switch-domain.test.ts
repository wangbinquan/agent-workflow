// RFC-395 V3-S: pure transitions and a port fixture shared by the switch journey tests.
import { describe, expect, test } from 'bun:test'
import { unfinishedTasks } from '@/modules/system-operations/application/epochSwitch/planner'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { valueDigest, bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import type { ConversionPlanSection } from '@/platform/persistence/migration/conversion/plan'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import type {
  ConversionBlock,
  RowDisposition,
} from '@/platform/persistence/migration/conversion/types'
import type {
  FrozenSourceHandle,
  ConversionRunRequest,
  MigrationRun,
  ValidationReport,
  HealthReport,
  MigrationApproval,
} from '@/platform/persistence/migration/run/types'
import { VALIDATION_CHECKS } from '@/platform/persistence/migration/run/types'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import { type EpochSwitchDependencies } from '@/modules/system-operations/application/epochSwitch/session'
import type {
  TargetGenerationHandle,
  MigrationMetaReadPort,
} from '@/modules/system-operations/application/ports/epochSwitch'
import { createFileEpochSwitchJournal } from '@/modules/system-operations/infrastructure/epochSwitch/fileJournal'
import { createPointerEpochActivation } from '@/modules/system-operations/infrastructure/epochSwitch/pointerActivation'
import { createEpochSourceRetention } from '@/modules/system-operations/infrastructure/epochSwitch/sourceRetention'
import { createEpochRestoreFiles } from '@/modules/system-operations/infrastructure/epochSwitch/restoreFiles'
import { createEpochInstallationProbe } from '@/modules/system-operations/infrastructure/epochSwitch/installationProbe'
import {
  createEpochSwitchJournal,
  canonicalOperatorDecisions,
  EPOCH_SWITCH_PHASES,
  EpochSwitchError,
  type EpochSwitchFaultPoint,
  type EpochSwitchJournal,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  reviseEpochSwitch,
  takeOverEpochSwitch,
  newEpochRun,
  rollbackEligibility,
  assertJournalSuccessor,
} from '@/modules/system-operations/domain/epochSwitch/transitions'
import {
  appendMigrationApproval,
  assertActivationApproval,
} from '@/modules/system-operations/domain/epochSwitch/documents'
import { assertEpochSwitchSupported } from '@/modules/system-operations/domain/epochSwitch/supportMatrix'

export const fixtureDigest = valueDigest('v3-s-fixture')
export function fixturePlan(request: ConversionRunRequest): ConversionPlanSection {
  const payload: Omit<ConversionPlanSection, 'digest'> = {
    version: 1,
    converterVersion: 'v3-fixture',
    ruleSetDigest: fixtureDigest,
    sourceFingerprint: request.source.preflight.fingerprint.digest,
    sourceVersion: request.source.preflight.sourceVersion,
    sourceGenerationId: request.source.preflight.sourceGenerationId,
    sourceWatermark: request.source.watermark,
    targetContractDigest: fixtureDigest,
    targetGeneration: request.targetGeneration,
    candidateBuild: request.candidateBuild,
    sourceBackupId: request.sourceBackupId,
    contentManifestDigest: request.contentManifestDigest,
    planTime: request.planTime,
    coverage: 'complete',
    chunkLimit: request.chunkLimit,
    preUpgradeWatermark: null,
    operatorDecisions: canonicalOperatorDecisions(request.operatorDecisions),
    tables: [],
    topology: { order: [], selfReferences: [], deferredForeignKeys: [] },
    deferredChecks: [],
    blocks: [],
  }
  return { ...payload, digest: valueDigest(payload) }
}

export function makeSwitchFixture(existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'aw-v3-s-'))
  const pointerPath = join(root, 'database-generation.json')
  const sourcePath = join(root, 'db.sqlite')
  writeFileSync(sourcePath, 'retained epoch-one bytes')
  const operationId = 'dbm_e2_switch_fixture'
  const journal = createFileEpochSwitchJournal({ root: join(root, 'database-migrations') })
  const control = {
    watermark: fixtureDigest,
    inject: undefined as ((point: EpochSwitchFaultPoint) => void) | undefined,
    firstWrite: null as number | null,
    state: 'prepared' as 'prepared' | 'active' | 'retired' | 'discarded',
    approvals: [] as readonly MigrationApproval[],
    quiesceCalls: 0,
    clock: 123,
    installed: false,
    generationId: 'dbg_target_fixture',
    rows: 0,
    held: false,
    planBlocks: [] as readonly ConversionBlock[],
    actualBlocks: [] as readonly ConversionBlock[],
    plannedRestrictions: [] as readonly RowDisposition[],
    actualRestrictions: [] as readonly RowDisposition[],
    liveCount: 1,
    actualCount: 1,
    drift: false,
    run: null as MigrationRun | null,
    receiptBytes: null as Uint8Array | null,
    activationDigest: null as string | null,
  }
  const faults = (point: EpochSwitchFaultPoint) => control.inject?.(point)
  const source = (): FrozenSourceHandle => {
    const preflight: FrozenSourceHandle['preflight'] = {
      version: 1,
      kind: 'sqlite-file',
      sourceVersion: 'epoch1-fixture',
      contract: null,
      fingerprint: {
        version: 1,
        evidence: 'physical-catalog-and-journal',
        provider: 'sqlite',
        catalog: [],
        catalogDigest: fixtureDigest,
        journal: [],
        journalEntryCount: 0,
        tableRows: {},
        digest: fixtureDigest,
      },
      sourceGenerationId: 'dbg_source_fixture',
      identityHighWater: [],
      identityEvidence: 'physical',
      watermark: control.watermark,
      requiresOfflineUpgrade: false,
      tables: [],
      expectedAbsent: [],
      content: [],
    }
    return {
      preflight,
      watermark: control.watermark,
      preUpgrade: null,
      evidenceRoot: null,
      reader: {
        kind: 'sqlite-file',
        async preflight() {
          return preflight
        },
        async assertUnchanged(expected) {
          if (expected.watermark !== control.watermark) throw new Error('source-changed')
        },
        async readChunk() {
          throw new Error('no source business tables in the port fixture')
        },
        async readRawChunk() {
          throw new Error('no raw source tables in the port fixture')
        },
        async close() {},
      },
      async close() {},
    }
  }
  const health = (): HealthReport => ({
    version: 1,
    checkedAt: 123,
    catalogAdmitted: true,
    probes: [],
    passed: true,
    digest: fixtureDigest,
  })
  const validation = (runId: string): ValidationReport => ({
    version: 1,
    runId,
    validatedAt: 123,
    passed: !control.drift,
    checks: VALIDATION_CHECKS.map((check) => ({ check, passed: true, detail: null })),
    blocks: [],
    contentDrift: [],
    historyRestrictionsDigest: valueDigest(control.actualRestrictions),
    probes: [],
    digest: fixtureDigest,
  })
  const meta: MigrationMetaReadPort = {
    async approvals(runId) {
      return control.approvals.filter((a) => a.payload.runId === runId)
    },
    async migrationRun() {
      return control.run
    },
    async runs() {
      return control.run ? [control.run] : []
    },
    async *units() {},
    async unitSources() {
      return []
    },
    async tableReceipts() {
      return []
    },
    async *dispositions() {},
    async *artifacts() {},
    async restrictions() {
      return []
    },
    async blocks() {
      return []
    },
    async *records() {},
    async identityHighWater() {
      return []
    },
    async archive() {
      return null
    },
    async probeTarget() {
      return false
    },
    async receiptExport() {
      return control.receiptBytes
        ? { path: null, digest: bytesDigest(control.receiptBytes), bytes: control.receiptBytes }
        : null
    },
  }
  const target: TargetGenerationHandle = {
    get generationId() {
      return control.generationId
    },
    provider: 'sqlite',
    openRun(init) {
      return {
        async open(binding) {
          if (control.run && control.run.bindingDigest !== valueDigest(binding))
            throw new Error('binding changed')
          control.run ??= {
            ...init,
            state: 'open',
            binding,
            bindingDigest: valueDigest(binding),
            summaryDigest: null,
            validation: null,
            validationDigest: null,
            receiptExportDigest: null,
            convertedAt: null,
            validatedAt: null,
            completedAt: null,
          }
          return { committedUnitIds: new Set<string>() }
        },
        async commitUnit() {},
        async finish(summary) {
          control.run = {
            ...control.run!,
            state: summary.status === 'converted' ? 'converted' : 'blocked',
            summaryDigest: valueDigest(summary),
            convertedAt: 123,
          }
        },
        async loadBlocks() {
          return []
        },
      }
    },
    async finalize({ runId }) {
      for (const point of [
        'after-deferred-constraints',
        'after-identity-high-water',
        'after-integrity-check',
        'after-catalog-admission',
      ] as const)
        faults(point)
      return {
        version: 1,
        runId,
        deferredConstraintsApplied: true,
        violations: [],
        integrity: [],
        catalogAdmitted: true,
        identityHighWater: [],
        identityVerified: true,
        digest: fixtureDigest,
      }
    },
    async validate({ runId }) {
      const report = validation(runId)
      control.run = {
        ...control.run!,
        state: 'validated',
        validation: report,
        validationDigest: report.digest,
        validatedAt: 123,
      }
      return report
    },
    async exportReceipts() {
      control.receiptBytes ??= Buffer.from(
        JSON.stringify({ runId: control.run!.runId, rows: control.rows }),
      )
      const digest = bytesDigest(control.receiptBytes)
      control.run = { ...control.run!, receiptExportDigest: digest }
      return { path: null, digest }
    },
    async recordApproval(approval) {
      if (approval.payload.runId !== control.run?.runId) throw new Error('approval run mismatch')
      control.approvals = appendMigrationApproval(control.approvals, approval)
    },
    async prepareActivation(receipt) {
      assertActivationApproval(receipt, control.approvals)
      if (
        valueDigest(receipt.payload.operatorDecisions) !==
        valueDigest(control.run!.conversionPlan.operatorDecisions)
      )
        throw new Error('activation decisions differ')
      if (control.activationDigest && control.activationDigest !== receipt.digest)
        throw new Error('activation conflict')
      control.activationDigest = receipt.digest
      control.state = 'active'
      // Like the real handle (targetGeneration.ts), the fault fires after the meta commit.
      faults('after-meta-receipt')
    },
    async healthCheck() {
      return health()
    },
    async firstLiveWriteAt() {
      return control.firstWrite
    },
    async retireIfUnwritten() {
      if (control.firstWrite !== null) return 'written'
      const prior = control.state
      control.state = 'retired'
      return prior === 'retired' ? 'already-retired' : 'retired'
    },
    async writeSwitchReceipt(receipt) {
      if (receipt.payload.activationReceiptDigest !== control.activationDigest)
        throw new Error('switch receipt activation mismatch')
    },
    trace: () => meta,
    async close() {},
  }
  const summary = (request: ConversionRunRequest, actual: boolean): ConversionSummary => {
    const blocks = request.operatorDecisions.length
      ? []
      : actual
        ? control.actualBlocks
        : control.planBlocks
    const plan = fixturePlan(request)
    return {
      status: blocks.length ? 'blocked' : 'converted',
      tableReceipts: [],
      blocks,
      records: [],
      historyOnly: actual ? control.actualRestrictions : control.plannedRestrictions,
      stagingDigest: fixtureDigest,
      plan: {
        ...plan,
        tables: [
          {
            table: 'numeric-only',
            phase: 'current',
            rows: actual ? control.actualCount : control.liveCount,
            rule: 'copy',
            targets: [],
          },
        ],
      },
    }
  }
  const deps: EpochSwitchDependencies = {
    journal,
    async targetEvidence() {
      return control.installed && control.state !== 'discarded'
        ? { state: control.state, activationReceiptDigest: control.activationDigest }
        : null
    },
    source: {
      async discover() {
        return source()
      },
      async freeze(input) {
        if (input.expected && input.expected.watermark !== control.watermark)
          throw new EpochSwitchError('v3-source-changed', { category: 'source-changed' })
        return source()
      },
    },
    backup: {
      async create({ source: frozen, destination, contentManifest }) {
        return {
          version: 1,
          id: 'backup-fixture',
          kind: 'sqlite-vacuum',
          path: destination,
          digest: fixtureDigest,
          sourceWatermark: frozen.watermark,
          contentManifestDigest: contentManifest?.digest ?? null,
          createdAt: 123,
        }
      },
      async matches(receipt, watermark) {
        return receipt.sourceWatermark === watermark
      },
    },
    content: {
      async capture() {
        return {
          version: 1,
          roots: [root],
          files: [],
          objects: [],
          databaseTrees: [],
          digest: fixtureDigest,
        }
      },
      async open() {
        return {
          async stat() {
            return { state: 'absent', cause: 'originally-absent', evidence: 'fixture' }
          },
          async read() {
            throw new Error('absent')
          },
          async verifyUnchanged() {
            return []
          },
        }
      },
    },
    target: {
      async preflight({ provider, location }) {
        return {
          provider,
          location,
          fingerprint: fixtureDigest,
          empty: true,
          postgresqlMajor: null,
          encoding: 'UTF-8',
          collation: 'BINARY',
          canCreate: true,
          availableBytes: 100000,
          blocks: [],
        }
      },
      async create(input) {
        control.installed = true
        control.generationId = input.generationId
        return target
      },
      async open() {
        if (!control.installed) throw new Error('target not installed')
        return target
      },
      async discard() {
        control.state = 'discarded'
      },
    },
    conversionPlan: fixturePlan,
    conversion: {
      async dryRun(request) {
        return {
          summary: summary(request, false),
          units: 1,
          rowsWritten: 1,
          dispositions: 0,
          artifacts: 0,
          archiveBytes: 0,
          targetCounts: [],
        }
      },
      async run(request, sink) {
        const plan = fixturePlan(request)
        await sink.open({
          planDigest: plan.digest,
          sourceWatermark: request.source.watermark,
          sourceVersion: request.source.preflight.sourceVersion,
          sourceGenerationId: request.source.preflight.sourceGenerationId,
          targetGeneration: request.targetGeneration,
          converterVersion: plan.converterVersion,
          ruleSetDigest: plan.ruleSetDigest,
          preUpgradeWatermark: null,
          stagingDigest: fixtureDigest,
          lookupDigest: fixtureDigest,
        })
        if (control.rows === 0) {
          faults('after-rows')
          faults('after-receipts')
          control.rows = 1
          faults('before-ack')
        }
        const result = summary(request, true)
        await sink.finish(result)
        return result
      },
    },
    activation: createPointerEpochActivation({ pointerPath, journal, faults }),
    quiesce: {
      async quiesce({ operationId }) {
        control.quiesceCalls++
        control.held = true
        faults('after-stop-request')
        faults('after-lock-acquired')
        return {
          version: 1,
          operationId,
          deployment: 'standalone',
          kind: control.quiesceCalls === 1 ? 'daemon-stopped' : 'already-stopped',
          stoppedAt: control.clock + control.quiesceCalls,
          freezeReference: null,
          digest: fixtureDigest,
        }
      },
      async release() {
        control.held = false
      },
      async assertHeld() {
        if (!control.held) throw new Error('not held')
      },
    },
    retention: createEpochSourceRetention({ journal, faults }),
    installation: createEpochInstallationProbe({
      pointerPath,
      migrationsRoot: join(root, 'database-migrations'),
      provider: 'sqlite',
      source: { kind: 'sqlite-file', path: sourcePath, pointerPath },
      journal,
    }),
    defaultContentRoot: { kind: 'app-home', root, runsSupplied: true, objects: 'none' },
    candidateBuild: 'candidate',
    targetContractDigest: fixtureDigest,
    targetPlanDigest: () => fixtureDigest,
    now: () => control.clock,
    newOperationId: () => operationId,
    faults,
    restoreFiles: createEpochRestoreFiles({ appHome: root, faults }),
  }
  return {
    root,
    pointerPath,
    sourcePath,
    operationId,
    deps,
    control,
    target,
    app: createEpochSwitchApplication(deps),
    close() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function plannedFixture() {
  const fixture = makeSwitchFixture()
  const plan = await fixture.app.plan({})
  return { ...fixture, plan }
}

describe('V3 switch domain', () => {
  test('legal successors, approvals, failure resume and fenced takeover', async () => {
    const f = await plannedFixture()
    try {
      let j = (await f.deps.journal.read(f.operationId))!
      expect(() => reviseEpochSwitch(j, { phase: 'backed-up' }, 123)).toThrow('approval-required')
      j = reviseEpochSwitch(
        j,
        {
          plan: {
            ...j.payload.plan!,
            approvedDigest: j.payload.plan!.approvalDigest,
            approvedAt: 123,
          },
        },
        123,
      )
      for (const phase of EPOCH_SWITCH_PHASES.slice(2)) j = reviseEpochSwitch(j, { phase }, 123)
      expect(j.payload.phase).toBe('completed')
      expect(() => reviseEpochSwitch(j, { phase: 'planned' }, 123)).toThrow('illegal-transition')
      const original = (await f.deps.journal.read(f.operationId))!
      const takeover = takeOverEpochSwitch(original, 'next-owner', 124)
      expect(takeover.payload.owner.fence).toBe(original.payload.owner.fence + 1)
      expect(() =>
        assertJournalSuccessor(
          original,
          createEpochSwitchJournal({
            ...takeover.payload,
            owner: { ...takeover.payload.owner, fence: 0 },
          }),
        ),
      ).toThrow('stale-revision-or-owner')
      const failed = reviseEpochSwitch(original, { status: 'failed' }, 124)
      expect(reviseEpochSwitch(failed, { status: 'running' }, 125).payload.status).toBe('running')
      expect(newEpochRun(failed, 125).payload.plan).toBeNull()
    } finally {
      f.close()
    }
  })
  test('every non-successor is rejected and rollback respects phase and first write', async () => {
    const f = await plannedFixture()
    try {
      const base = (await f.deps.journal.read(f.operationId))!
      for (let index = 0; index < EPOCH_SWITCH_PHASES.length; index++) {
        const phase = EPOCH_SWITCH_PHASES[index]!
        const j: EpochSwitchJournal = createEpochSwitchJournal({ ...base.payload, phase })
        for (let next = 0; next < EPOCH_SWITCH_PHASES.length; next++)
          if (next !== index && next !== index + 1)
            expect(() => reviseEpochSwitch(j, { phase: EPOCH_SWITCH_PHASES[next]! }, 123)).toThrow(
              'illegal-transition',
            )
        expect(rollbackEligibility(j).allowed).toBe(phase !== 'completed')
        expect(
          rollbackEligibility({ ...j, payload: { ...j.payload, firstLiveWriteAt: 123 } }).allowed,
        ).toBe(false)
      }
    } finally {
      f.close()
    }
  })
  test('the support matrix preserves SQLite to PostgreSQL and refuses the reverse', () => {
    for (const [sourceProvider, targetProvider] of [
      ['sqlite', 'sqlite'],
      ['sqlite', 'postgresql'],
      ['postgresql', 'postgresql'],
    ] as const)
      expect(() =>
        assertEpochSwitchSupported({
          sourceProvider,
          targetProvider,
          sourceEpoch: 1,
          targetEpoch: 2,
        }),
      ).not.toThrow()
    expect(() =>
      assertEpochSwitchSupported({
        sourceProvider: 'postgresql',
        targetProvider: 'sqlite',
        sourceEpoch: 1,
        targetEpoch: 2,
      }),
    ).toThrow('unsupported')
    expect(() =>
      assertEpochSwitchSupported({
        sourceProvider: 'sqlite',
        targetProvider: 'sqlite',
        sourceEpoch: 2,
        targetEpoch: 2,
      }),
    ).toThrow('unsupported')
  })
})

test('unfinished task inventory uses the frozen epoch-one terminal status vocabulary', async () => {
  const f = makeSwitchFixture()
  try {
    const source = await f.deps.source.discover({
      location: { kind: 'sqlite-file', path: f.sourcePath, pointerPath: f.pointerPath },
      emptyTables: [],
      operationRoot: f.root,
    })
    const statuses = [
      'done',
      'failed',
      'canceled',
      'interrupted',
      'running',
      'pending',
      'running',
      'awaiting_review',
      'awaiting_human',
    ]
    const withTasks = {
      ...source,
      preflight: {
        ...source.preflight,
        tables: [
          {
            table: 'tasks',
            physicalTable: 'tasks',
            rows: statuses.length,
            destination: { kind: 'business' as const, tables: ['tasks'] },
            disposition: 'converted' as const,
            reason: 'fixture',
          },
        ],
      },
    }
    source.reader.readChunk = async () => ({
      version: 1,
      sourceVersion: source.preflight.sourceVersion,
      table: 'tasks',
      migrationKey: ['id'],
      afterKey: null,
      firstKey: null,
      lastKey: null,
      rows: statuses.map((status, index) => ({
        key: [{ type: 'integer', value: String(index) }],
        values: [{ type: 'text', value: status }],
      })),
      decodedRows: statuses.map((status) => ({ status })),
      sourceDigest: fixtureDigest,
    })
    expect(await unfinishedTasks(withTasks)).toEqual([
      { status: 'awaiting_human', count: 1 },
      { status: 'awaiting_review', count: 1 },
      { status: 'interrupted', count: 1 },
      { status: 'pending', count: 1 },
      { status: 'running', count: 2 },
    ])
  } finally {
    f.close()
  }
})
