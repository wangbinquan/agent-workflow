import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describeV3Providers, describeV3CrossProvider, type V3Harness } from './rfc395V3Harness'
import { frozenValues } from './rfc395V2/contentFixtures'
import { readEpochTargetEvidence } from '@/modules/system-operations/infrastructure/epochSwitch/installationProbe'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { archivedHistoryFixture } from './rfc395V2/archivedHistoryFixtures'
import { createEpochSourceAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/sourceAdapter'
import { createEpochBackupAdapter } from '@/modules/system-operations/infrastructure/epochSwitch/backupAdapter'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { logicalArtifactFileDigest } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { composeLocalEpochSwitchDependencies } from '@/bootstrap/epochMigration'
import { DEFAULT_CONFIG, PostgresqlDatabaseConfigSchema } from '@agent-workflow/shared'
import { createDatabaseMigrationManifest } from '@/modules/system-operations/domain/databaseMigration'
import { writeDatabaseGenerationAtomic } from '@/platform/persistence/generationStore'
import { seedRequiredRows } from './rfc395V2/integrationFixtures'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { composeBootUpgradeEnvironment } from '@/bootstrap/conversionRules'
import { epochConversionInput, composeEpochTrace } from '@/bootstrap/epochMigration'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import { assertMigrationHistory, readExpectedMigrationChain } from '@/db/schemaAdmission'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import { installConversionTarget } from '@/platform/persistence/migration/target/install'
import { markFirstLiveWrite, EPOCH2_SENTINEL } from '@/platform/persistence/schema/history/markers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { parseGenerationPointerV2 } from '@/platform/persistence/generationPointerV2'
import { createTargetGenerationHandle } from '@/modules/system-operations/infrastructure/epochSwitch/targetGeneration'
import { createMigrationMetaStore } from '@/modules/system-operations/infrastructure/epochSwitch/metaStore'
import { createDryRunSink } from '@/modules/system-operations/infrastructure/epochSwitch/dryRunSink'
import { createEpochSwitchApplication } from '@/modules/system-operations/application/epochSwitch/application'
import type { TargetGenerationHandle } from '@/modules/system-operations/application/ports/epochSwitch'
import { makeSwitchFixture } from './rfc395V3SwitchFixture'

function providerJourney(h: V3Harness, selected: string) {
  const scenarios = [
    'activate',
    'rollback-before-activation-meta',
    ...(h.sourceProvider === 'postgresql' ? ['missing-at-plan', 'missing-at-freeze'] : []),
  ]
  for (const scenario of scenarios.filter((value) => value === selected))
    test(`real source -> native target -> ${scenario}`, async () => {
      const history = await archivedHistoryFixture(h.source)
      // The application opens its own snapshots; retain only the fixture's archive bytes.
      await history.native.close()
      await history.logical.close()
      await seedRequiredRows(h.source)
      await h.source.write(
        'code_work_items',
        ['pending-one', 'pending-two', 'pending-three'].map((id) =>
          frozenValues('code_work_items', { id, anchor_id: id, status: 'queued' }),
        ),
      )
      const sourceBefore = await h.source.sourceHarness.fingerprint()
      const f = makeSwitchFixture()
      let target: TargetGenerationHandle | undefined
      const connection = { ...h.target, async close() {} }
      try {
        f.deps.source = createEpochSourceAdapter({
          async resolve() {
            return {
              manifest: await h.source.sourceHarness.manifest(),
              postgresql: () => h.source.sourceHarness.runtime,
            }
          },
        })
        const archiveDigest = logicalArtifactFileDigest(
          join(history.retainedRoot, 'legacy-archive/manifest.json'),
        )
        const resolvedStages: string[] = []
        let archiveRoot = history.retainedRoot
        let sourcePointerBytes: Uint8Array | null = null
        const database = PostgresqlDatabaseConfigSchema.parse({
          provider: 'postgresql',
          urlEnv: 'SOURCE_URL',
        })
        if (h.sourceProvider === 'postgresql') {
          const oldOperationId = 'dbm_pgxc_retained_installation'
          archiveRoot = join(f.root, 'database-migrations', oldOperationId)
          mkdirSync(archiveRoot, { recursive: true })
          cpSync(history.retainedRoot, archiveRoot, { recursive: true })
          const physical = await h.source.sourceHarness.source()
          const preflight = await physical.preflight()
          await physical.close()
          const prior = createDatabaseMigrationManifest({
            operationId: oldOperationId,
            idempotencyKey: 'pgxc-retained-installation',
            sourceGenerationId: 'dbg_pgxc_original_sqlite',
            sourceSchemaDigest: preflight.contract!.digest,
            sourceDatabaseFingerprint: 'sqlite:pgxc-original',
            target: database,
            ownerId: 'dbo_pgxc_retained_installation',
            ownerLeaseExpiresAt: 60000,
            tableCounts: { source: 222, active: 216, archiveOnly: 6 },
            now: 1,
          })
          const payload = {
            ...prior.payload,
            phase: 'accepting-writes' as const,
            legacyArchiveDigest: archiveDigest,
          }
          const migration = { payload, digest: valueDigest(payload) }
          writeFileSync(join(archiveRoot, 'manifest.json'), canonicalSchemaJson(migration))
          writeDatabaseGenerationAtomic({
            pointerPath: f.pointerPath,
            payload: {
              version: 1,
              generationId: preflight.sourceGenerationId,
              provider: 'postgresql',
              operationId: oldOperationId,
              schemaDigest: preflight.contract!.digest,
              manifestDigest: migration.digest,
              activatedAt: 1,
            },
          })
          sourcePointerBytes = readFileSync(f.pointerPath)
        }
        const resolveInstalledArchive = composeLocalEpochSwitchDependencies({
          appHome: f.root,
          config: { ...DEFAULT_CONFIG, database },
          env: {},
          head: h.head,
          catalogArtifacts: [],
        }).postgresqlArchive!
        f.deps.postgresqlArchive = async (source, journal) => {
          resolvedStages.push(journal.payload.phase)
          const physical = frozenSourceDetails(source).originalPreflight
          for (const table of history.originals.keys()) {
            expect(physical.expectedAbsent).toContain(table)
            expect(physical.tables.some((entry) => entry.table === table)).toBe(false)
          }
          return resolveInstalledArchive(source, journal)
        }
        f.deps.installation = async () => ({
          source:
            h.sourceProvider === 'sqlite'
              ? {
                  kind: 'sqlite-file',
                  path: h.source.sourceHarness.sqlitePath,
                  pointerPath: f.pointerPath,
                }
              : { kind: 'postgresql-database', profileRef: 'env:SOURCE_URL' },
          pointerBytes: sourcePointerBytes,
          facts: {
            pointer: null,
            provider: h.sourceProvider,
            sourceExists: true,
            operation: null,
            rfc349Operation: null,
            activationReceiptDigest: null,
            targetState: null,
            rollbackIncomplete: false,
          },
        })
        f.deps.targetEvidence = (generationId) => readEpochTargetEvidence(connection, generationId)
        f.deps.targetContractDigest = h.head.contract.contract.digest
        f.deps.targetPlanDigest = (provider) => h.head[provider].digest
        f.deps.backup = createEpochBackupAdapter()
        f.deps.conversionPlan = (request) => planConversion(epochConversionInput(request))
        f.deps.conversion = {
          bootUpgradeEnvironment: composeBootUpgradeEnvironment({
            async open() {
              return null
            },
          }),
          async dryRun(request) {
            for (const table of history.originals.keys())
              expect(
                request.source.preflight.tables.find((entry) => entry.table === table)?.rows,
              ).toBe(3)
            if (h.sourceProvider === 'postgresql')
              expect(request.source.watermark).not.toBe(
                frozenSourceDetails(request.source).originalPreflight.watermark,
              )
            const sink = createDryRunSink()
            await runConversion(epochConversionInput(request), sink)
            return sink.result
          },
          run: (request, sink) => runConversion(epochConversionInput(request), sink),
        }
        f.deps.target = {
          async preflight({ location }) {
            return {
              provider: h.targetProvider,
              location,
              fingerprint: 'independent-target',
              empty: true,
              postgresqlMajor: null,
              encoding: 'UTF8',
              collation: 'C',
              canCreate: true,
              availableBytes: null,
              blocks: [],
            }
          },
          async create(i) {
            await installConversionTarget(connection, {
              head: h.head,
              metaTables: h.metaTables,
              generationId: i.generationId,
              now: i.now,
            })
            const meta = createMigrationMetaStore({
              target: connection,
              registry: persistenceSchema,
            })
            await meta.insert('generations', {
              generationId: i.generationId,
              schemaEpoch: 2,
              role: i.role,
              state: 'prepared',
              provider: i.provider,
              operationId: i.operationId,
              runId: i.runId,
              sourceGenerationId: i.sourceGenerationId,
              contractDigest: h.head.contract.contract.digest,
              planDigest: h.head[i.provider].digest,
              activationReceiptDigest: null,
              createdAt: i.now,
              activatedAt: null,
              retiredAt: null,
            })
            target = createTargetGenerationHandle({
              target: connection,
              generationId: i.generationId,
              registry: persistenceSchema,
              head: h.head,
              catalogCache: h.catalogCache,
              now: () => 123,
              receiptStorage: 'meta-only',
              faults: i.faults,
            })
            return target
          },
          async open() {
            if (!target) throw new Error('target not installed')
            return target
          },
          async discard() {
            throw new Error('not used')
          },
        }
        const app = createEpochSwitchApplication(f.deps)
        const planInput = {
          target: {
            provider: h.targetProvider,
            ...(h.targetProvider === 'postgresql' ? { urlEnv: 'TARGET_URL' } : {}),
          },
        }
        if (scenario === 'missing-at-plan') {
          rmSync(join(archiveRoot, 'legacy-archive/manifest.json'))
          await expect(app.plan(planInput)).rejects.toMatchObject({ category: 'source-blocked' })
          expect(target).toBeUndefined()
          expect(f.control.quiesceCalls).toBe(0)
          return
        }
        const initialPlan = await app.plan({
          target: {
            provider: h.targetProvider,
            ...(h.targetProvider === 'postgresql' ? { urlEnv: 'TARGET_URL' } : {}),
          },
        })
        expect(initialPlan.acknowledgeable.length).toBeGreaterThanOrEqual(3)
        const plan = await app.acknowledge({
          operationId: f.operationId,
          items: [...initialPlan.acknowledgeable].reverse().map((item) => item.id),
          reason: 'Preserve unfinished retired work as full history',
          by: 'operator',
        })
        expect(plan.plan.payload.blocks).toEqual([])
        expect(plan.plan.payload.operatorDecisions.map(valueDigest)).toEqual(
          plan.plan.payload.operatorDecisions.map(valueDigest).sort(),
        )
        if (scenario === 'missing-at-freeze') {
          const quiesce = f.deps.quiesce.quiesce
          f.deps.quiesce.quiesce = async (request) => {
            const receipt = await quiesce(request)
            rmSync(join(archiveRoot, 'legacy-archive/manifest.json'))
            return receipt
          }
          await expect(
            app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
          ).rejects.toMatchObject({ category: 'source-blocked' })
          expect(resolvedStages).toContain('quiescing')
          expect(target).toBeUndefined()
          return
        }
        if (scenario === 'rollback-before-activation-meta') {
          f.control.inject = (point) => {
            if (point === 'after-activation-receipt-file')
              throw new Error('before native activation commit')
          }
          await expect(
            app.run({ operationId: f.operationId, approve: plan.plan.approvalDigest }),
          ).rejects.toThrow('before native activation commit')
          const operation = (await f.deps.journal.read(f.operationId))!
          expect(
            (await readEpochTargetEvidence(connection, operation.payload.target.generationId!))!
              .activationReceiptDigest,
          ).toBeNull()
          f.control.inject = undefined
          expect((await app.rollback({ operationId: f.operationId })).status).toBe('rolled-back')
          const rollback = JSON.parse(
            (await app.receipt({ operationId: f.operationId, kind: 'rollback' })).json,
          )
          expect(rollback.payload.activationReceiptDigest).toBeNull()
          expect(
            (await readEpochTargetEvidence(connection, operation.payload.target.generationId!))!
              .state,
          ).toBe('retired')
          expect((await h.source.sourceHarness.fingerprint()).digest).toBe(sourceBefore.digest)
          return
        }
        const result = await app.run({
          operationId: f.operationId,
          approve: plan.plan.approvalDigest,
        })
        expect(result.phase).toBe('activated')
        if (h.sourceProvider === 'postgresql') {
          expect(resolvedStages).toContain('discovered')
          expect(resolvedStages).toContain('planned')
          expect(resolvedStages).toContain('quiescing')
        }
        const prefix = h.targetProvider === 'postgresql' ? 'agent_workflow.' : ''
        const archives = await connection.execute(`SELECT * FROM ${prefix}code_history_archives`)
        const indexes = await connection.execute(`SELECT * FROM ${prefix}code_history_id_index`)
        const receipts = await target!.trace().tableReceipts(result.journal.payload.run!.runId)
        for (const [table, originals] of history.originals) {
          const archive = archives.find((row) => row.source_table === table)!
          expect(Number(archive.row_count)).toBe(3)
          const payload = JSON.parse(
            Buffer.from(archive.content_inline_bytes as Uint8Array).toString(),
          )
          const entries = indexes.filter((row) => row.source_table === table)
          expect(entries).toHaveLength(3)
          for (const original of originals) {
            const index = entries.find(
              (row) => row.original_key_json === canonicalSchemaJson(original.key),
            )!
            expect(index).toBeDefined()
            expect(payload.records[Number(index.record_ordinal)].canonical).toEqual(original)
          }
          expect(receipts.find((receipt) => receipt.sourceTable === table)).toMatchObject({
            rowsRead: 3,
            counts: { archived: 3, blocked: 0, converted: 0, preserved: 0 },
          })
        }
        const activation = JSON.parse(
          (await app.receipt({ operationId: f.operationId, kind: 'activation' })).json,
        )
        expect(activation.payload.operatorDecisions).toEqual(plan.plan.payload.operatorDecisions)
        expect(await target!.trace().approvals!(result.journal.payload.run!.runId)).toEqual(
          result.journal.payload.approvals!,
        )
        const pointer = parseGenerationPointerV2(readFileSync(f.pointerPath, 'utf8'))
        expect(pointer.payload.provider).toBe(h.targetProvider)
        expect(pointer.payload.database).toEqual(
          h.targetProvider === 'sqlite'
            ? {
                kind: 'sqlite-file',
                relativePath: `databases/${result.targetGenerationId}/db.sqlite`,
              }
            : { kind: 'postgresql-target', profileRef: 'env:TARGET_URL' },
        )
        expect((await app.verify({ operationId: f.operationId })).phase).toBe('verified')
        const replay = await composeEpochTrace(f.deps)(
          {
            ...target!.trace(),
            async unitSources() {
              return []
            },
          },
          {
            operationId: f.operationId,
            runId: result.journal.payload.run!.runId,
            table: 'users',
            key: [canonicalValue('__system__')],
            replay: true,
          },
        )
        expect(replay.proof).toBe('replay')
        expect(replay.targets.some((row) => row.table === 'users' && row.present)).toBe(true)
        expect((await h.source.sourceHarness.fingerprint()).digest).toBe(sourceBefore.digest)
        const before = readFileSync(f.pointerPath)
        await h.target.transaction(async (tx) => {
          await tx.execute(
            "INSERT INTO agent_workflow.maintenance_state (key, value, updated_at) VALUES ('v3-business-write', 'preserved', 123)".replace(
              'agent_workflow.',
              h.targetProvider === 'sqlite' ? '' : 'agent_workflow.',
            ),
          )
          await markFirstLiveWrite(tx, result.targetGenerationId!, 124)
        })
        await expect(app.rollback({ operationId: f.operationId })).rejects.toThrow(
          'reverse-migration-required',
        )
        expect(readFileSync(f.pointerPath)).toEqual(before)
        expect(
          await h.target.execute(`SELECT * FROM ${metaTableName(h.targetProvider, 'first_write')}`),
        ).toHaveLength(1)
        if (h.targetProvider === 'sqlite') {
          const rows = await h.target.execute('SELECT hash FROM __drizzle_migrations')
          expect(rows.some((row) => row.hash === EPOCH2_SENTINEL)).toBe(true)
          expect(() =>
            assertMigrationHistory(h.sqlite, {
              dbPath: h.targetPath,
              expected: readExpectedMigrationChain(resolve(import.meta.dir, '../../db/migrations')),
              stage: 'migration-history-preflight',
              allowPrefix: true,
            }),
          ).toThrow('migration-history-preflight')
        }
      } finally {
        await history.close()
        f.close()
      }
    })
}
export function describeV3SwitchJourney(scenario: string): void {
  describeV3Providers('V3-S native same-provider switch', (h) => providerJourney(h, scenario))
  describeV3CrossProvider('V3-S SQLite to PostgreSQL switch', (h) => providerJourney(h, scenario))
}
