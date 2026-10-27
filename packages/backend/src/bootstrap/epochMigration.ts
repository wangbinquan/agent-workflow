import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { createExternalTargetPreflight } from '@/platform/persistence/migration/target/preflightAdapter'
import { epochMigrationKeys } from './epochMigrationKeys'
// RFC-395 V3-S: offline composition only; package A owns dispatch and startup wiring.
import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Config } from '@agent-workflow/shared'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import {
  HistoryCatalogCache,
  type PostgresqlCatalogArtifact,
} from '@/platform/persistence/schema/history/catalog'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import {
  loadSupportedSourceManifest,
  type SupportedSourceManifest,
} from '@/platform/persistence/migration/supportedSources'
import { collectSourceFingerprint } from '@/platform/persistence/migration/sourceCatalog'
import { tableCatalogDigest } from '@/platform/persistence/migration/sourceDispositions'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  planConversion,
  resolveContributions,
} from '@/platform/persistence/migration/conversion/plan'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import {
  postgresqlRuntimeFor,
  openPostgresqlScratch,
} from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import { captureLiveSqliteSnapshot } from '@/platform/persistence/migration/freeze/liveSnapshot'
import {
  unpackOldEpochBackup,
  materializeOldEpochBackup,
} from '@/platform/persistence/migration/freeze/oldEpochBackup'
import { availableDiskBytes } from '@/platform/persistence/migration/freeze/diskBudget'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import type {
  ConversionRunRequest,
  EpochSourceLocation,
  ReadOnlyProbe,
  MigrationRun,
  FrozenSourceHandle,
  FreezeContentManifest,
  SourceArchiveInput,
  EpochTargetLocation,
} from '@/platform/persistence/migration/run/types'
import { createEpochSwitchApplication } from '@/modules/system-operations/composition/epochMigration'
import {
  type EpochSwitchDependencies,
  type EpochSwitchApplicationWithWithdrawal,
  epochRunArtifacts,
  relocateEpochPath,
} from '@/modules/system-operations/composition/epochMigration'
import { createMigrationTraceQuery } from '@/modules/system-operations/composition/epochMigration'
import {
  EpochSwitchError,
  type EpochSwitchFaults,
  type EpochSwitchJournal,
} from '@/modules/system-operations/composition/epochMigration'
import { createFileEpochSwitchJournal } from '@/modules/system-operations/composition/epochMigration'
import { createEpochSourceAdapter } from '@/modules/system-operations/composition/epochMigration'
import { createEpochBackupAdapter } from '@/modules/system-operations/composition/epochMigration'
import { createContentInventoryAdapter } from '@/modules/system-operations/composition/epochMigration'
import { createTargetGenerationPort } from '@/modules/system-operations/composition/epochMigration'
import { createDryRunSink } from '@/modules/system-operations/composition/epochMigration'
import { createPointerEpochActivation } from '@/modules/system-operations/composition/epochMigration'
import { createEpochSourceRetention } from '@/modules/system-operations/composition/epochMigration'
import { createEpochRestoreFiles } from '@/modules/system-operations/composition/epochMigration'
import { verifyDatabaseMigrationManifest } from '@/modules/system-operations/composition/epochMigration'
import { parseDatabaseGenerationText } from '@/platform/persistence/generationValidation'
import { frozenSourceDetails } from '@/platform/persistence/migration/freeze/sourceAccess'
import { loadOperationSourceManifest } from '@/platform/persistence/migration/freeze/sourceManifest'
import {
  createEpochInstallationProbe,
  readEpochTargetEvidence,
} from '@/modules/system-operations/composition/epochMigration'
import { createLocalEpochQuiesce } from '@/modules/system-operations/composition/epochMigration'

import {
  composeConversionInput,
  conversionContributions,
  composeBootUpgradeEnvironment,
  conversionReadOnlyProbes,
} from './conversionRules'
import { persistenceSchema } from './persistenceSchema'

export type EpochMigrationEnv = Readonly<Record<string, string | undefined>>
export interface LocalEpochSwitchOptions {
  appHome: string
  config: Config
  env: EpochMigrationEnv
  head: HistoryVersion
  catalogArtifacts: readonly PostgresqlCatalogArtifact[]
  sourceManifest?: () => Promise<SupportedSourceManifest>
  probes?: readonly ReadOnlyProbe[]
  acceptanceProbes?: readonly ReadOnlyProbe[]
  candidateBuild?: string
  faults?: EpochSwitchFaults
  sourceBornOnPostgresql?: boolean
  postgresqlArchive?: EpochSwitchDependencies['postgresqlArchive']
  nextTargetLocation?: EpochSwitchDependencies['nextTargetLocation']
}

export function epochConversionInput(request: ConversionRunRequest) {
  return composeConversionInput({
    ...request,
    source: request.source.reader,
    preflight: request.source.preflight,
    ...(request.source.preUpgrade
      ? {
          preUpgradeSource: request.source.preUpgrade.reader,
          preUpgradePreflight: request.source.preUpgrade.preflight,
        }
      : {}),
  })
}

export function composeEpochTrace(
  deps: Pick<
    EpochSwitchDependencies,
    'journal' | 'source' | 'sourceFor' | 'content' | 'postgresqlArchive'
  >,
): NonNullable<EpochSwitchDependencies['trace']> {
  return (meta, input) => {
    const withSource = async <T>(
      run: MigrationRun,
      body: (
        source: FrozenSourceHandle,
        operation: EpochSwitchJournal,
        localPath: (path: string) => string,
      ) => Promise<T>,
    ) => {
      const operation = await deps.journal.read(run.operationId)
      if (!operation?.payload.inputs.contentRoot)
        throw new EpochSwitchError('v3-trace-frozen-source-required')
      const root = deps.journal.operationRoot(run.operationId)
      let location = operation.payload.source.location
      const storedRoot = location.kind === 'backup' ? location.root : null
      let backupRoot: string | null = null
      if (storedRoot) {
        const bytes = await deps.journal.readArtifact(run.operationId, 'inputs/backup.json')
        const artifacts = deps.journal.artifacts?.(run.operationId)
        if (bytes && artifacts)
          backupRoot = (
            await materializeOldEpochBackup({
              digest: (JSON.parse(Buffer.from(bytes).toString('utf8')) as { digest: string })
                .digest,
              artifacts,
            })
          ).root
      }
      const localPath = (path: string): string =>
        storedRoot && backupRoot && (path === storedRoot || path.startsWith(storedRoot + '/'))
          ? join(backupRoot, path.slice(storedRoot.length))
          : operation.payload.deployment === 'crewstation'
            ? relocateEpochPath(path, run.operationId, root)
            : path
      if (location.kind === 'backup') location = { ...location, root: localPath(location.root) }
      if (location.kind === 'sqlite-file') {
        const name = `runs/${run.runId}/trace/source-pointer.json`
        if (operation.payload.source.pointer.bytesBase64 !== null)
          await deps.journal.writeOnce(
            run.operationId,
            name,
            Buffer.from(operation.payload.source.pointer.bytesBase64, 'base64'),
          )
        location = {
          ...location,
          path:
            !existsSync(location.path) && existsSync(join(root, 'source/db.sqlite'))
              ? join(root, 'source/db.sqlite')
              : location.path,
          pointerPath: join(root, name),
        }
      }
      const source = await (deps.sourceFor?.(operation) ?? deps.source).freeze({
        location,
        ...(location.kind === 'postgresql-database'
          ? {
              async postgresqlArchive(source: FrozenSourceHandle) {
                if (!deps.postgresqlArchive)
                  throw new EpochSwitchError('v3-postgresql-archive-required', {
                    category: 'source-blocked',
                  })
                return deps.postgresqlArchive(source, operation)
              },
            }
          : {}),
        emptyTables: run.emptyTables,
        operationRoot: join(root, `runs/${run.runId}/source`),
        artifacts: epochRunArtifacts(operation, deps.journal.artifacts?.(run.operationId)),
        expected: {
          watermark: run.binding.sourceWatermark,
          preUpgradeWatermark: run.binding.preUpgradeWatermark,
          sourceGenerationId: run.binding.sourceGenerationId,
        },
      })
      try {
        return await body(source, operation, localPath)
      } finally {
        await source.close()
      }
    }
    return createMigrationTraceQuery({
      meta,
      sourceProbe: {
        async groupKeys(query) {
          if (query.unit.kind !== 'group') return []
          const unit = query.unit
          return withSource(query.run, async (source) => {
            const rule = resolveContributions({
              preflight: source.preflight,
              preUpgradePreflight: source.preUpgrade?.preflight,
              target: persistenceSchema,
              contributions: conversionContributions,
            }).rules.find(
              (rule) =>
                rule.ref.id === unit.rule && (rule.sourcePhase ?? 'current') === query.sourcePhase,
            )
            if (rule?.unit.kind !== 'group') return []
            const column =
              rule.unit.driver === query.sourceTable
                ? rule.unit.groupColumn
                : rule.unit.members.find((member) => member.table === query.sourceTable)?.column
            if (!column) return []
            const reader =
              query.sourcePhase === 'pre-upgrade' ? source.preUpgrade?.reader : source.reader
            if (!reader) return []
            let afterKey: Parameters<typeof reader.readChunk>[1] = null
            for (;;) {
              const chunk = await reader.readChunk(
                query.sourceTable,
                afterKey,
                query.run.conversionPlan.chunkLimit,
              )
              const index = chunk.rows.findIndex(
                (row) => encodeMigrationKey(query.sourceTable, row.key) === query.sourceKey,
              )
              if (index >= 0) {
                const group = chunk.decodedRows[index]?.[column]
                return typeof group === 'string' ? [group] : []
              }
              if (!chunk.rows.length || !chunk.lastKey) return []
              afterKey = chunk.lastKey
            }
          })
        },
      },
      replay: {
        replay(query) {
          return withSource(query.run, async (source, operation, localPath) => {
            const bytes = await deps.journal.readArtifact(
              query.operationId,
              `runs/${query.run.runId}/frozen/content-manifest.json`,
            )
            if (!bytes) throw new EpochSwitchError('v3-trace-manifest-missing')
            const manifest = JSON.parse(
              Buffer.from(bytes).toString('utf8'),
            ) as FreezeContentManifest
            const inventory = await deps.content.open({
              source,
              manifest: { ...manifest, roots: manifest.roots.map(localPath) },
              root: {
                ...operation.payload.inputs.contentRoot!,
                root: localPath(operation.payload.inputs.contentRoot!.root),
                ...(operation.payload.inputs.contentRoot!.runContentRoot
                  ? {
                      runContentRoot: localPath(
                        operation.payload.inputs.contentRoot!.runContentRoot,
                      ),
                    }
                  : {}),
              },
            })
            const result = await explainSourceRow(
              epochConversionInput({
                source,
                content: inventory,
                scratchRoot: join(
                  deps.journal.operationRoot(query.operationId),
                  `runs/${query.run.runId}/trace-scratch`,
                ),
                planTime: query.run.conversionPlan.planTime,
                chunkLimit: query.run.conversionPlan.chunkLimit,
                targetGeneration: query.run.conversionPlan.targetGeneration,
                candidateBuild: query.run.conversionPlan.candidateBuild,
                sourceBackupId: query.run.conversionPlan.sourceBackupId,
                contentManifestDigest: query.run.conversionPlan.contentManifestDigest,
                operatorDecisions: query.run.conversionPlan.operatorDecisions,
              }),
              query.table,
              query.key,
              query.phase,
            )
            return {
              runId: query.run.runId,
              sourceTable: result.sourceTable,
              sourceKey: result.sourceKey,
              sourcePhase: result.sourcePhase,
              proof: result.found ? ('replay' as const) : ('not-found' as const),
              class: result.class,
              dispositions: result.dispositions,
              unit: null,
              targets: await Promise.all(
                result.targets.map(async (target) => ({
                  ...target,
                  probed: true,
                  present: await meta.probeTarget(target),
                })),
              ),
              artifacts: [],
              restrictions: result.dispositions.flatMap((row) =>
                row.history ? [row.history] : [],
              ),
              blocks: result.blocks,
              archive: result.dispositions.find((row) => row.archive)?.archive ?? null,
            }
          })
        },
      },
    })(input)
  }
}

export function composeLocalEpochSwitch(
  options: LocalEpochSwitchOptions,
): EpochSwitchApplicationWithWithdrawal {
  return createEpochSwitchApplication(composeLocalEpochSwitchDependencies(options))
}

export function composeLocalEpochSwitchDependencies(
  options: LocalEpochSwitchOptions,
): EpochSwitchDependencies {
  const { appHome, env, head, faults } = options
  const pointerPath = join(appHome, 'database-generation.json')
  const journal = createFileEpochSwitchJournal({ root: join(appHome, 'database-migrations') })
  const config = options.config.database
  const sourceLocation: EpochSourceLocation =
    'urlEnv' in config
      ? { kind: 'postgresql-database', profileRef: `env:${config.urlEnv}` }
      : { kind: 'sqlite-file', path: join(appHome, 'db.sqlite'), pointerPath }
  const runtimeFor = (profileRef: string, generationId = 'dbg_epoch2_offline') =>
    postgresqlRuntimeFor({
      profileRef,
      base: config,
      generationId,
      env,
    })
  const sourceFor = (operation?: EpochSwitchJournal) => {
    const runtimes: ReturnType<typeof runtimeFor>[] = []
    const adapter = createEpochSourceAdapter({
      async resolve(request) {
        const location = request.location
        const sourceRuntime =
          location.kind === 'postgresql-database' ? runtimeFor(location.profileRef) : null
        if (sourceRuntime) runtimes.push(sourceRuntime)
        const sourceFingerprint = sourceRuntime
          ? (await sourceRuntime.readiness()).databaseFingerprint
          : null
        const scratch = operation?.payload.inputs.scratchProfileRef ?? request.scratchProfileRef
        const operationId = operation?.payload.operationId ?? request.scratchOwner
        const manifest = options.sourceManifest
          ? await options.sourceManifest()
          : scratch && operationId
            ? await loadOperationSourceManifest({
                runtime: runtimeFor(scratch),
                profileRef: scratch,
                sourceFingerprint,
                supportedMajors: options.catalogArtifacts.map((a) => a.postgresqlMajor),
                cache: {
                  read: (name) => journal.readArtifact(operationId, name),
                  writeOnce: (name, bytes) => journal.writeOnce(operationId, name, bytes),
                },
              })
            : await loadSupportedSourceManifest()
        if (!options.sourceManifest && sourceRuntime && !scratch)
          throw new EpochSwitchError('v3-scratch-required', { category: 'scratch-required' })
        const openScratch = (requireEmpty: boolean) => {
          if (!scratch)
            throw new EpochSwitchError('v3-scratch-required', { category: 'scratch-required' })
          return openPostgresqlScratch({
            runtime: runtimeFor(scratch),
            profileRef: scratch,
            sourceFingerprint,
            supportedMajors: options.catalogArtifacts.map((a) => a.postgresqlMajor),
            requireEmpty,
          })
        }
        return {
          manifest,
          ...(sourceRuntime ? { postgresql: () => sourceRuntime } : {}),
          ...(operation?.payload.inputs.scratchProfileRef
            ? {
                createScratchPostgresql: () => openScratch(true),
                reopenScratchPostgresql: () => openScratch(false),
              }
            : {}),
        }
      },
    })
    const wrap = async (open: () => ReturnType<typeof adapter.discover>) => {
      try {
        const handle = await open()
        const close = handle.close.bind(handle)
        handle.close = async () => {
          try {
            await close()
          } finally {
            for (const runtime of runtimes.splice(0)) await runtime.close()
          }
        }
        return handle
      } catch (error) {
        for (const runtime of runtimes.splice(0)) await runtime.close()
        throw error
      }
    }
    return {
      discover: (input: Parameters<typeof adapter.discover>[0]) =>
        wrap(() => adapter.discover(input)),
      freeze: (input: Parameters<typeof adapter.freeze>[0]) => wrap(() => adapter.freeze(input)),
    }
  }
  const pgPreflight = createExternalTargetPreflight({
    runtime: runtimeFor,
    catalogArtifacts: options.catalogArtifacts,
  })
  let targetProfile: string | null = null
  const catalogCache = new HistoryCatalogCache(async (plan) => {
    if (!targetProfile) throw new EpochSwitchError('v3-target-profile-missing')
    const runtime = runtimeFor(targetProfile)
    try {
      const rows = await runtime
        .providerPool()
        .unsafe("SELECT current_setting('server_version_num') AS version")
      const major = Math.floor(Number(rows[0]?.version) / 10_000)
      const artifact = options.catalogArtifacts.find(
        (a) => a.planDigest === plan.digest && a.postgresqlMajor === major,
      )
      if (!artifact)
        throw new EpochSwitchError('v3-catalog-unavailable', { category: 'catalog-unavailable' })
      return artifact
    } finally {
      await runtime.close()
    }
  })
  const target = createTargetGenerationPort({
    appHome,
    registry: persistenceSchema,
    head,
    catalogCache,
    postgresql: {
      async open(location) {
        targetProfile = location.profileRef
        const runtime = runtimeFor(location.profileRef)
        const connection = openConversionTarget({ runtime })
        return {
          ...connection,
          async close() {
            try {
              await connection.close()
            } finally {
              await runtime.close()
            }
          },
        }
      },
      async preflight(request) {
        if (request.location.kind === 'postgresql-target')
          targetProfile = request.location.profileRef
        let fingerprint = request.sourceFingerprint
        if (sourceLocation.kind === 'postgresql-database') {
          const runtime = runtimeFor(sourceLocation.profileRef)
          try {
            fingerprint = (await runtime.readiness()).databaseFingerprint
          } finally {
            await runtime.close()
          }
        }
        return pgPreflight.preflight({ ...request, sourceFingerprint: fingerprint })
      },
    },
  })
  const targetEvidence = async (generationId: string, location: EpochTargetLocation) => {
    if (location.kind === 'sqlite-file') {
      const path = join(appHome, location.relativePath)
      if (!existsSync(path)) return null
      const database = new Database(path, { readonly: true })
      try {
        const row = database
          .query(
            'SELECT state, activation_receipt_digest FROM aw_meta_generations WHERE generation_id = ?',
          )
          .get(generationId) as {
          state: 'prepared' | 'active' | 'retired'
          activation_receipt_digest: string | null
        } | null
        return row
          ? { state: row.state, activationReceiptDigest: row.activation_receipt_digest }
          : null
      } finally {
        database.close()
      }
    }
    const runtime = runtimeFor(location.profileRef)
    const connection = openConversionTarget({ runtime })
    try {
      return await readEpochTargetEvidence(connection, generationId)
    } finally {
      await connection.close()
      await runtime.close()
    }
  }
  const content = createContentInventoryAdapter()
  const deps: EpochSwitchDependencies = {
    journal,
    source: sourceFor(),
    sourceFor,
    backup: createEpochBackupAdapter({
      async artifacts(receipt) {
        const operation = (await journal.list()).find(
          (j) =>
            j.payload.backup?.id === receipt.id ||
            j.payload.artifacts?.some((ref) =>
              ref.name.startsWith(`switch-backups/${receipt.id}/`),
            ),
        )
        if (!operation) throw new EpochSwitchError('v3-backup-operation-missing')
        return journal.artifacts!(operation.payload.operationId)
      },
    }),
    targetEvidence,
    postgresqlArchive:
      options.postgresqlArchive ??
      (async (source, operation) => {
        // The current pointer becomes epoch 2 at activation. Replay must keep
        // resolving the source installation's RFC-349 archive from its journal.
        const bytes = operation.payload.source.pointer.bytesBase64
        const pointer =
          bytes === null
            ? null
            : parseDatabaseGenerationText(
                Buffer.from(bytes, 'base64').toString('utf8'),
                'epoch-switch source pointer',
              )
        let retained: Extract<SourceArchiveInput, { kind: 'retained-epoch1-archive' }> | undefined
        if (pointer?.payload.version === 1 && pointer.payload.operationId) {
          const root = join(appHome, 'database-migrations', pointer.payload.operationId)
          const migration = verifyDatabaseMigrationManifest(
            JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')),
          )
          if (!migration.payload.legacyArchiveDigest)
            throw new EpochSwitchError('v3-postgresql-archive-required')
          retained = {
            kind: 'retained-epoch1-archive',
            path: root,
            digest: migration.payload.legacyArchiveDigest,
          }
        }
        return epochSourceArchiveInput(source, {
          retained,
          bornOnPostgresql: options.sourceBornOnPostgresql === true,
        })
      }),
    content,
    target,
    nextTargetLocation: options.nextTargetLocation,
    conversionPlan: (request) => planConversion(epochConversionInput(request)),
    conversion: {
      bootUpgradeEnvironment: composeBootUpgradeEnvironment(epochMigrationKeys(undefined, appHome)),
      async dryRun(request) {
        const sink = createDryRunSink()
        await runConversion(epochConversionInput(request), sink)
        return sink.result
      },
      run: (request, sink) => runConversion(epochConversionInput(request), sink),
    },
    activation: createPointerEpochActivation({ pointerPath, journal, faults }),
    quiesce: createLocalEpochQuiesce({
      lockPath: join(appHome, '.daemon.lock'),
      controlPath: join(appHome, '.daemon.control'),
      faults,
    }),
    retention: createEpochSourceRetention({ journal, faults }),
    installation: createEpochInstallationProbe({
      pointerPath,
      migrationsRoot: join(appHome, 'database-migrations'),
      provider: config.provider,
      source: sourceLocation,
      journal,
      async targetState(generationId) {
        const operation = (await journal.list()).find(
          (j) => j.payload.target.generationId === generationId,
        )
        if (!operation?.payload.target.location) return null
        return (
          (await targetEvidence(generationId, operation.payload.target.location))?.state ?? null
        )
      },
    }),
    defaultContentRoot: { kind: 'app-home', root: appHome, runsSupplied: true, objects: 'none' },
    candidateBuild: options.candidateBuild ?? env.AGENT_WORKFLOW_BUILD ?? 'rfc395-epoch2-candidate',
    targetContractDigest: head.contract.contract.digest,
    targetPlanDigest: (provider) => head[provider].digest,
    probes: options.probes ?? conversionReadOnlyProbes,
    acceptanceProbes: options.acceptanceProbes,
    faults,
    async unpackBackup(artifact, destination, artifacts) {
      const unpacked = await unpackOldEpochBackup({ artifact, destination, artifacts })
      return {
        ...unpacked,
        runsSupplied: ['runs', 'logs', 'evidence'].some((name) =>
          existsSync(join(unpacked.root, name)),
        ),
      }
    },
    materializeBackup: (digest, artifacts) => materializeOldEpochBackup({ digest, artifacts }),
    restoreFiles: createEpochRestoreFiles({ appHome, faults }),
    async measureCapacity(source, operationRoot) {
      const sourceBytes =
        source.kind === 'sqlite-file' && existsSync(source.path) ? statSync(source.path).size : null
      return { sourceBytes, availableBytes: availableDiskBytes(operationRoot) }
    },
    async resolveEmptyTables({ source, decisions, operationRoot }) {
      if (!decisions.length) return []
      let fingerprint
      if (source.kind === 'sqlite-file') {
        const snapshot = captureLiveSqliteSnapshot({ ...source, operationRoot })
        const db = new Database(snapshot.path, { readonly: true })
        try {
          fingerprint = collectSourceFingerprint(db)
        } finally {
          db.close()
          await snapshot.close()
        }
      } else if (source.kind === 'postgresql-database') {
        const runtime = runtimeFor(source.profileRef)
        const connection = await runtime.providerPool().reserve()
        try {
          fingerprint = await collectSourceFingerprint(postgresqlHistoryConnection(connection))
        } finally {
          connection.release()
          await runtime.close()
        }
      } else
        throw new EpochSwitchError('v3-backup-empty-table-decisions-require-source-catalog', {
          category: 'source-blocked',
        })
      return decisions.map((decision) => {
        if (fingerprint.tableRows[decision.table] !== 0)
          throw new EpochSwitchError('v3-empty-table-not-empty', { category: 'source-blocked' })
        return {
          ...decision,
          catalogDigest: tableCatalogDigest(fingerprint, decision.table),
          disposition: 'archived' as const,
        }
      })
    },
    trace: composeEpochTrace({ journal, source: sourceFor(), sourceFor, content }),
  }
  return deps
}

/** Composition supplies provenance; the exact frozen catalog supplies the absence proof. */
export function epochSourceArchiveInput(
  source: FrozenSourceHandle,
  input: {
    retained?: Extract<SourceArchiveInput, { kind: 'retained-epoch1-archive' }>
    bornOnPostgresql: boolean
  },
): SourceArchiveInput {
  if (input.retained) return input.retained
  const preflight = frozenSourceDetails(source).originalPreflight
  const tables =
    preflight.contract?.tables
      .filter((t) => t.disposition === 'ARCHIVE_THEN_OMIT')
      .map((t) => t.id) ?? []
  if (
    !input.bornOnPostgresql ||
    !persistenceDialect(preflight.fingerprint.provider).externalArchive ||
    tables.length !== 6 ||
    tables.some(
      (name) =>
        !preflight.expectedAbsent.includes(name) ||
        Object.hasOwn(preflight.fingerprint.tableRows, name),
    )
  )
    throw new EpochSwitchError('v3-postgresql-archive-required', { category: 'backup-failed' })
  return {
    kind: 'never-installed',
    evidence: {
      sourceBornOn: 'postgresql',
      sourceGenerationId: preflight.sourceGenerationId,
      sourceWatermark: preflight.watermark,
      catalogDigest: preflight.fingerprint.catalogDigest,
      expectedAbsent: [...tables].sort(),
    },
  }
}
