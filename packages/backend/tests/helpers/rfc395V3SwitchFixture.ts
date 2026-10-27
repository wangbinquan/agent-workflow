// RFC-395 V3-S: pure transitions and a port fixture shared by the switch journey tests.
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
  canonicalOperatorDecisions,
  EpochSwitchError,
  type EpochSwitchFaultPoint,
} from '@/modules/system-operations/domain/epochSwitch/model'
import {
  appendMigrationApproval,
  assertActivationApproval,
} from '@/modules/system-operations/domain/epochSwitch/documents'

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
