import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { existsSync, mkdirSync, renameSync, statfsSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import type { HistoryCatalogCache } from '@/platform/persistence/schema/history/catalog'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { firstLiveWriteAt } from '@/platform/persistence/schema/history/markers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { valueDigest, bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import type {
  ConversionTargetConnection,
  EpochTargetLocation,
  HealthReport,
  TargetFinalizeReport,
} from '@/platform/persistence/migration/run/types'
import {
  openConversionTarget,
  sqliteTargetIsEmpty,
} from '@/platform/persistence/migration/target/connection'
import { createTargetLoader } from '@/platform/persistence/migration/target/loader'
import {
  enforceDeferredConstraints,
  checkTargetIntegrity,
} from '@/platform/persistence/migration/target/finalize'
import {
  targetIdentityHighWater,
  applyIdentityHighWater,
  verifyIdentityHighWater,
} from '@/platform/persistence/migration/target/identity'
import { admitConversionTarget } from '@/platform/persistence/migration/target/admission'
import type {
  TargetGenerationHandle,
  TargetGenerationPort,
} from '../../application/ports/epochSwitch'
import {
  parseActivationReceipt,
  parseRollbackReceipt,
  parseSwitchReceipt,
  assertActivationApproval,
} from '../../domain/epochSwitch/documents'
import { canonicalOperatorDecisions, type EpochSwitchFaults } from '../../domain/epochSwitch/model'
import { EPOCH2_META_TABLES } from '../persistence/migrationMetaTables'
import { createMigrationMetaStore, collectMigrationRows } from './metaStore'
import { createTargetConversionSink } from './conversionSink'
import { createMigrationTraceStore } from './traceStore'
import { validateConversionRun, runReadOnlyProbes } from './validation'
import { exportMigrationReceipts } from './receiptExport'

export interface TargetGenerationOptions {
  readonly appHome: string
  readonly registry: SchemaRegistry
  readonly head: HistoryVersion
  readonly catalogCache: HistoryCatalogCache
  readonly now?: () => number
  readonly postgresql?: {
    open(
      location: Extract<EpochTargetLocation, { kind: 'postgresql-target' }>,
    ): Promise<ConversionTargetConnection>
    preflight: TargetGenerationPort['preflight']
  }
  readonly receiptStorage?: 'files-and-meta' | 'meta-only'
}
export function createTargetGenerationHandle(input: {
  target: ConversionTargetConnection
  generationId: string
  registry: SchemaRegistry
  head: HistoryVersion
  catalogCache: HistoryCatalogCache
  now?: () => number
  receiptStorage?: TargetGenerationOptions['receiptStorage']
  faults?: EpochSwitchFaults
}): TargetGenerationHandle {
  const { target, generationId, registry, head, catalogCache } = input
  const now = input.now ?? Date.now
  const meta = createMigrationMetaStore({ target, registry })
  const admitted = () =>
    admitConversionTarget(target, { head, metaTables: EPOCH2_META_TABLES, catalogCache })
  const handle: TargetGenerationHandle = {
    generationId,
    provider: target.provider,
    openRun(row) {
      if (
        row.conversionPlan.targetGeneration !== generationId ||
        row.conversionPlan.targetContractDigest !== head.contract.contract.digest
      )
        throw new Error('v3-run-target-mismatch')
      return createTargetConversionSink({
        target,
        loader: createTargetLoader({ registry, provider: target.provider }),
        meta,
        run: row,
        now,
        fault: input.faults,
      })
    },
    recordApproval: (approval) =>
      target.transaction((tx) => meta.withConnection(tx).recordApproval(approval)),
    async finalize({ runId }) {
      const run = await meta.migrationRun(runId)
      if (
        !run?.summaryDigest ||
        !['converted', 'blocked', 'validated'].includes(run.state) ||
        run.binding.targetGeneration !== generationId
      )
        throw new Error('v3-finalize-before-finish')
      const deferred = persistenceDialect(target.provider).deferredForeignKeys
        ? head.postgresql.head.filter(
            (statement) => statement.kind === 'constraint' && statement.logicalId.includes(':fk:'),
          )
        : []
      let violations: TargetFinalizeReport['violations'] = []
      let deferredConstraintsApplied = false
      try {
        violations = await enforceDeferredConstraints(target, { registry, deferred })
        deferredConstraintsApplied = violations.length === 0
        if (deferredConstraintsApplied)
          await target.transaction(async (tx) => {
            const store = meta.withConnection(tx)
            const key = { runId, unitId: 'v3:finalize:constraints', ordinal: 0 }
            const record = {
              kind: 'decision',
              code: 'v3-deferred-constraints-applied',
              payload: {
                generationId,
                provider: target.provider,
                planDigest: head[target.provider].digest,
                deferredDigest: valueDigest(deferred),
              },
            } as const
            const previous = (await store.select('migration_records', key))[0]
            if (previous) {
              if (previous.recordDigest !== valueDigest(record))
                throw new Error('v3-finalize-constraint-conflict')
            } else
              await store.insert('migration_records', {
                ...key,
                kind: record.kind,
                tableName: null,
                recordJson: record,
                recordDigest: valueDigest(record),
              })
          })
      } catch (error) {
        deferredConstraintsApplied = false
        violations = [
          {
            table: null,
            targetKey: null,
            constraint: null,
            message: error instanceof Error ? error.message : String(error),
            kind: 'foreign-key',
            referencedTable: null,
          },
        ]
      }
      if (deferredConstraintsApplied) input.faults?.('after-deferred-constraints')
      const integrity = await checkTargetIntegrity(target)
      input.faults?.('after-integrity-check')
      const identityHighWater = await targetIdentityHighWater(target, {
        registry,
        values: await meta.identityHighWater(runId),
      })
      let identityVerified = false
      try {
        await target.transaction(async (tx) => {
          await applyIdentityHighWater(tx, { registry, values: identityHighWater })
          identityVerified = await verifyIdentityHighWater(tx, identityHighWater)
          if (identityVerified)
            await meta.withConnection(tx).saveIdentity(runId, identityHighWater, now())
        })
      } catch {
        identityVerified = false
      }
      if (identityVerified) input.faults?.('after-identity-high-water')
      let catalogAdmitted = false
      try {
        await admitted()
        catalogAdmitted = true
      } catch {
        catalogAdmitted = false
      }
      if (catalogAdmitted) input.faults?.('after-catalog-admission')
      const report = {
        version: 1 as const,
        runId,
        deferredConstraintsApplied,
        violations,
        integrity,
        catalogAdmitted,
        identityHighWater,
        identityVerified,
      }
      return { ...report, digest: valueDigest(report) }
    },
    async validate(request) {
      const existing = await meta.migrationRun(request.runId)
      if (existing?.receiptExportDigest && existing.validation) return existing.validation
      const finalized = await handle.finalize({ runId: request.runId })
      return validateConversionRun({ ...request, target, meta, registry, finalized, now })
    },
    exportReceipts: ({ runId, operationRoot }) =>
      exportMigrationReceipts({
        target,
        meta,
        runId,
        operationRoot: input.receiptStorage === 'meta-only' ? null : operationRoot,
      }),
    async prepareActivation(receipt, previousPointer) {
      const checked = parseActivationReceipt(JSON.stringify(receipt))
      const p = checked.payload
      await admitted()
      const foreignKeys = persistenceDialect(target.provider).enforceForeignKeys
      if (foreignKeys.length) {
        await target.execute(foreignKeys[0]!)
        if (Number((await target.execute(foreignKeys[1]!))[0]?.foreign_keys) !== 1)
          throw new Error('v3-foreign-keys-not-enabled')
      }
      await target.transaction(async (tx) => {
        const store = meta.withConnection(tx)
        const run = await store.migrationRun(p.runId)
        const gen = (await store.select('generations', { generationId }))[0]
        if (
          !gen ||
          gen.state === 'retired' ||
          !run?.validation?.passed ||
          !['validated', 'activated'].includes(run.state) ||
          !run.receiptExportDigest
        )
          throw new Error('v3-activation-before-validation')
        assertActivationApproval(checked, await store.approvals(p.runId))
        const expected = {
          operationId: run.operationId,
          kind: run.kind,
          role: run.role,
          conversionPlanDigest: run.conversionPlan.digest,
          bindingDigest: run.bindingDigest,
          summaryDigest: run.summaryDigest,
          validationDigest: run.validationDigest,
          receiptExportDigest: run.receiptExportDigest,
          contentManifestDigest: run.conversionPlan.contentManifestDigest,
          candidateBuild: run.conversionPlan.candidateBuild,
          historyRestrictionsDigest: run.validation.historyRestrictionsDigest,
        }
        if (
          Object.entries(expected).some(([key, value]) => p[key as keyof typeof p] !== value) ||
          p.target.generationId !== generationId ||
          p.target.provider !== target.provider ||
          p.target.contractDigest !== head.contract.contract.digest ||
          p.target.planDigest !== head[target.provider].digest ||
          p.source.generationId !== run.binding.sourceGenerationId ||
          p.source.watermark !== run.binding.sourceWatermark ||
          valueDigest(canonicalOperatorDecisions(p.operatorDecisions)) !==
            valueDigest(canonicalOperatorDecisions(run.conversionPlan.operatorDecisions)) ||
          p.previousPointer.bytesBase64 !==
            (previousPointer === null ? null : Buffer.from(previousPointer).toString('base64')) ||
          p.previousPointer.digest !==
            (previousPointer === null ? null : bytesDigest(previousPointer))
        )
          throw new Error('v3-activation-binding-mismatch')
        const records = await collectMigrationRows(store.records(p.runId))
        if (
          valueDigest(p.lineage) !==
            valueDigest(
              records.filter(
                (record) => record.kind === 'source-generation' || record.kind === 'source-journal',
              ),
            ) ||
          valueDigest(p.writerDrain) !==
            valueDigest(
              records
                .filter((record) => record.kind === 'writer-drain')
                .map((record) => record.payload),
            ) ||
          valueDigest(p.familyCutoverSource) !==
            valueDigest(
              records
                .filter((record) => record.kind === 'family-cutover-source')
                .map((record) => record.payload),
            ) ||
          valueDigest(p.identityHighWater) !== valueDigest(await store.identityHighWater(p.runId))
        )
          throw new Error('v3-activation-evidence-mismatch')
        const existing = (await store.select('activation_receipts', { generationId }))[0]
        if (existing) {
          if (existing.receiptDigest !== checked.digest)
            throw new Error('v3-activation-receipt-conflict')
          return
        }
        if ((await firstLiveWriteAt(tx, generationId)) !== null)
          throw new Error('v3-activation-already-written')
        await store.insert('activation_receipts', {
          generationId,
          operationId: p.operationId,
          runId: p.runId,
          receiptJson: checked,
          receiptDigest: checked.digest,
          previousPointerBytes: previousPointer,
          previousPointerDigest: p.previousPointer.digest,
          preparedAt: p.preparedAt,
        })
        await store.update(
          'generations',
          { generationId },
          { state: 'active', activationReceiptDigest: checked.digest, activatedAt: p.preparedAt },
        )
        await store.update('migration_runs', { runId: p.runId }, { state: 'activated' })
      })
      input.faults?.('after-meta-receipt')
    },
    async healthCheck(probes) {
      let catalogAdmitted = false
      try {
        await admitted()
        catalogAdmitted = true
      } catch {
        catalogAdmitted = false
      }
      const results = await runReadOnlyProbes(target, probes)
      const payload = {
        version: 1 as const,
        checkedAt: now(),
        catalogAdmitted,
        probes: results,
        passed: catalogAdmitted && results.every((probe) => probe.passed),
      }
      return { ...payload, digest: valueDigest(payload) } satisfies HealthReport
    },
    firstLiveWriteAt: () => firstLiveWriteAt(target, generationId),
    async retireIfUnwritten() {
      return target.transaction(async (tx) => {
        const store = meta.withConnection(tx)
        // A's first-write fence locks this generation row in the business transaction.
        const lock = persistenceDialect(tx.provider).rowLock
        const rows = await tx.execute(
          `SELECT state FROM ${metaTableName(tx.provider, 'generations')} WHERE generation_id = ${parameters(tx, 1)}${lock}`,
          [generationId],
        )
        if (!rows.length) throw new Error('v3-target-generation-missing')
        const markerLock = persistenceDialect(tx.provider).rowLock
        await tx.execute(
          `SELECT first_live_write_at FROM ${metaTableName(tx.provider, 'first_write')} WHERE generation_id = ${parameters(tx, 1)}${markerLock}`,
          [generationId],
        )
        if ((await firstLiveWriteAt(tx, generationId)) !== null) return 'written'
        if (rows[0]!.state === 'retired') return 'already-retired'
        if ((await store.select('switch_receipts', { generationId, kind: 'completed' })).length)
          throw new Error('v3-rollback-completed')
        await store.update('generations', { generationId }, { state: 'retired', retiredAt: now() })
        const gen = (await store.select('generations', { generationId }))[0]!
        if (gen.runId)
          await store.update('migration_runs', { runId: gen.runId }, { state: 'retired' })
        return 'retired'
      })
    },
    async writeSwitchReceipt(receipt) {
      const checked =
        receipt.payload.kind === 'rolled-back'
          ? parseRollbackReceipt(JSON.stringify(receipt))
          : parseSwitchReceipt(JSON.stringify(receipt))
      const payload = checked.payload
      await target.transaction(async (tx) => {
        const store = meta.withConnection(tx)
        const gen = (await store.select('generations', { generationId }))[0]
        if (
          !gen ||
          payload.generationId !== generationId ||
          payload.operationId !== gen.operationId ||
          payload.runId !== gen.runId ||
          payload.activationReceiptDigest !== gen.activationReceiptDigest
        )
          throw new Error('v3-switch-receipt-binding-mismatch')
        const key = { generationId, kind: payload.kind }
        const existing = (await store.select('switch_receipts', key))[0]
        if (existing) {
          if (existing.receiptDigest !== checked.digest)
            throw new Error('v3-switch-receipt-conflict')
          return
        }
        if (payload.kind === 'rolled-back') {
          if (gen.state !== 'retired' || (await firstLiveWriteAt(tx, generationId)) !== null)
            throw new Error('v3-rollback-after-write')
        } else {
          if (
            gen.state !== 'active' ||
            !payload.health.passed ||
            payload.firstLiveWriteAt !== (await firstLiveWriteAt(tx, generationId))
          )
            throw new Error('v3-switch-health-required')
          if (
            payload.kind === 'completed' &&
            !(await store.select('switch_receipts', { generationId, kind: 'verified' })).length
          )
            throw new Error('v3-complete-before-verify')
        }
        await store.insert('switch_receipts', {
          ...key,
          receiptJson: checked,
          receiptDigest: checked.digest,
          recordedAt: payload.recordedAt,
        })
        if (payload.kind === 'completed')
          await store.update(
            'migration_runs',
            { runId: payload.runId },
            { completedAt: payload.recordedAt },
          )
      })
    },
    trace: () => createMigrationTraceStore({ target, registry }),
    close: () => target.close(),
  }
  return handle
}
export function createTargetGenerationPort(options: TargetGenerationOptions): TargetGenerationPort {
  const now = options.now ?? Date.now
  const connect = async (location: EpochTargetLocation, create: boolean) => {
    if (location.kind === 'sqlite-file')
      return openConversionTarget({
        databasePath: resolve(options.appHome, location.relativePath),
        create,
      })
    if (!options.postgresql) throw new Error('v3-postgresql-target-adapter-required')
    return options.postgresql.open(location)
  }
  const port: TargetGenerationPort = {
    async preflight(input) {
      if (persistenceDialect(input.provider).targetLocationKind !== input.location.kind)
        throw new Error('v3-target-provider-mismatch')
      if (input.location.kind === 'postgresql-target') {
        if (!options.postgresql) throw new Error('v3-postgresql-target-adapter-required')
        const result = await options.postgresql.preflight(input)
        await options.catalogCache.expected(
          options.head.postgresql,
          EPOCH2_META_TABLES,
          result.postgresqlMajor ?? undefined,
          options.head.postgresqlCatalog,
        )
        return result
      }
      const path = resolve(options.appHome, input.location.relativePath)
      let parent = dirname(path)
      while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
      const disk = statfsSync(parent)
      const empty = !existsSync(path) || sqliteTargetIsEmpty(path)
      return {
        provider: 'sqlite',
        location: input.location,
        fingerprint: valueDigest({ path }),
        empty,
        postgresqlMajor: null,
        encoding: 'UTF-8',
        collation: 'BINARY',
        canCreate: true,
        availableBytes: disk.bavail * disk.bsize,
        blocks: empty
          ? []
          : [
              {
                code: 'v3-target-not-empty',
                scope: 'global',
                sourceTable: null,
                sourceKey: null,
                taskId: null,
                runId: null,
                missingFields: [],
                detail: { path },
              },
            ],
      }
    },
    async create(input) {
      const checked = await port.preflight({
        location: input.location,
        provider: input.provider,
        sourceFingerprint: null,
      })
      if (!checked.empty || checked.blocks.length || !checked.canCreate)
        throw new Error('v3-target-not-empty')
      const target = await connect(input.location, true)
      try {
        const meta = createMigrationMetaStore({ target, registry: options.registry })
        await installConversionTarget(target, {
          head: options.head,
          metaTables: EPOCH2_META_TABLES,
          generationId: input.generationId,
          now: input.now,
          initialize: async (tx) => {
            await meta.withConnection(tx).insert('generations', {
              generationId: input.generationId,
              schemaEpoch: 2,
              role: input.role,
              state: 'prepared',
              provider: input.provider,
              operationId: input.operationId,
              runId: input.runId,
              sourceGenerationId: input.sourceGenerationId,
              contractDigest: options.head.contract.contract.digest,
              planDigest: options.head[input.provider].digest,
              activationReceiptDigest: null,
              createdAt: input.now,
              activatedAt: null,
              retiredAt: null,
            })
          },
        })
        return createTargetGenerationHandle({
          ...options,
          target,
          generationId: input.generationId,
          now,
          faults: input.faults,
        })
      } catch (error) {
        await target.close()
        throw error
      }
    },
    async open(input) {
      if (persistenceDialect(input.provider).targetLocationKind !== input.location.kind)
        throw new Error('v3-target-provider-mismatch')
      const target = await connect(input.location, false)
      try {
        const meta = createMigrationMetaStore({ target, registry: options.registry })
        const row = (await meta.select('generations', { generationId: input.generationId }))[0]
        if (
          !row ||
          row.provider !== input.provider ||
          row.contractDigest !== options.head.contract.contract.digest ||
          row.planDigest !== options.head[input.provider].digest
        )
          throw new Error('v3-target-generation-mismatch')
        return createTargetGenerationHandle({
          ...options,
          target,
          generationId: input.generationId,
          now,
          faults: input.faults,
        })
      } catch (error) {
        await target.close()
        throw error
      }
    },
    async discard(input) {
      const provider = input.location.kind === 'sqlite-file' ? 'sqlite' : 'postgresql'
      const source =
        input.location.kind === 'sqlite-file'
          ? resolve(options.appHome, input.location.relativePath)
          : null
      const moved = join(input.destination, 'db.sqlite')
      const resuming = source && !existsSync(source) && existsSync(moved)
      const moveRemaining = () => {
        if (!source) return
        for (const suffix of ['', '-wal', '-shm'])
          if (existsSync(source + suffix)) {
            const destination = `${moved}${suffix}`
            if (existsSync(destination)) throw new Error('v3-discard-destination-conflict')
            renameSync(source + suffix, destination)
          }
      }
      // Recover the complete moved database before SQLite opens its WAL at the new path.
      if (resuming) moveRemaining()
      const location = resuming
        ? { kind: 'sqlite-file' as const, relativePath: relative(options.appHome, moved) }
        : input.location
      const handle = await port.open({ ...input, location, provider })
      try {
        if ((await handle.retireIfUnwritten()) === 'written')
          throw new Error('v3-discard-after-write')
      } finally {
        await handle.close()
      }
      if (source) {
        mkdirSync(input.destination, { recursive: true })
        if (!resuming) {
          const checkpoint = await connect(location, false)
          try {
            const result = await checkpoint.execute('PRAGMA wal_checkpoint(TRUNCATE)')
            if (Number(result[0]?.busy ?? 0) !== 0) throw new Error('v3-discard-checkpoint-busy')
          } finally {
            await checkpoint.close()
          }
          moveRemaining()
        }
      }
    },
  }
  return port
}
