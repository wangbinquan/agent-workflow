import { epochMigrationKeys } from './epochMigrationKeys'
import { composeBootUpgradeEnvironment, conversionReadOnlyProbes } from './conversionRules'
// The platform supplies persistent artifacts, freeze confirmation and switch observation.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { createEpochSwitchApplication } from '@/modules/system-operations/composition/epochMigration'
import { type EpochSwitchDependencies } from '@/modules/system-operations/composition/epochMigration'
import { environmentProfile } from '@/modules/system-operations/composition/epochMigration'
import { phaseIndex } from '@/modules/system-operations/composition/epochMigration'
import type { EpochSwitchApplication } from '@/modules/system-operations/public/commands'
import {
  EpochOperationIdSchema,
  EpochSwitchError,
} from '@/modules/system-operations/composition/epochMigration'
import {
  createMetaEpochSwitchJournal,
  type HostedEpochArtifacts,
} from '@/modules/system-operations/composition/epochMigration'
import {
  createHostedEpochActivation,
  type HostedEpochSwitchControl,
} from '@/modules/system-operations/composition/epochMigration'
import {
  createHostedEpochFreeze,
  type HostedFreezeAcknowledgement,
} from '@/modules/system-operations/composition/epochMigration'
import { createEpochSourceAdapter } from '@/modules/system-operations/composition/epochMigration'
import { readEpochTargetEvidence } from '@/modules/system-operations/composition/epochMigration'
import { createEpochBackupAdapter } from '@/modules/system-operations/composition/epochMigration'
import { createContentInventoryAdapter } from '@/modules/system-operations/composition/epochMigration'
import { createTargetGenerationPort } from '@/modules/system-operations/composition/epochMigration'
import { createDryRunSink } from '@/modules/system-operations/composition/epochMigration'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/epochMigration'
import { compileMetaTables } from '@/platform/persistence/schema/history/meta'
import { HistoryCatalogCache } from '@/platform/persistence/schema/history/catalog'
import {
  postgresqlRuntimeFor,
  preflightPostgresqlConversionTarget,
  openPostgresqlScratch,
} from '@/platform/persistence/migration/freeze/postgresqlDatabases'
import {
  unpackOldEpochBackup,
  materializeOldEpochBackup,
} from '@/platform/persistence/migration/freeze/oldEpochBackup'
import { openConversionTarget } from '@/platform/persistence/migration/target/connection'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import type { InventoryObjectReader } from '@/platform/content/inventory/objects'
import type { SupportedSourceManifest } from '@/platform/persistence/migration/supportedSources'
import {
  epochConversionInput,
  epochSourceArchiveInput,
  composeEpochTrace,
  type EpochMigrationEnv,
  type LocalEpochSwitchOptions,
} from './epochMigration'

export interface HostedEpochJobContract {
  operationId: string
  action: 'plan' | 'run' | 'new-run' | 'verify' | 'rollback' | 'restore' | 'discard' | 'complete'
  approve: string | undefined
  sourceGenerationId: string
  freezeReference: string | undefined
  restoreReference: string | undefined
  scratchRoot: string
  env: EpochMigrationEnv
}
export function parseHostedEpochJob(
  env: EpochMigrationEnv,
  action?: HostedEpochJobContract['action'],
): HostedEpochJobContract {
  const requireValue = (name: string) => {
    const value = env[name]
    if (!value) throw new EpochSwitchError(`v3-hosted-env-required:${name}`)
    return value
  }
  const selected = action ?? env.CS_DATABASE_MIGRATION_ACTION ?? 'plan'
  if (
    !['plan', 'run', 'new-run', 'verify', 'rollback', 'restore', 'discard', 'complete'].includes(
      selected,
    )
  )
    throw new EpochSwitchError('v3-hosted-action-invalid')
  requireValue('CS_DATABASE_MIGRATION_TARGET_URL')
  if (['plan', 'run', 'new-run'].includes(selected) && !env.CS_DATABASE_RESTORE_REFERENCE)
    requireValue('CS_DATABASE_MIGRATION_SOURCE_URL')
  if (['run', 'rollback'].includes(selected)) requireValue('CS_DATABASE_MIGRATION_FREEZE_REFERENCE')
  if (selected === 'restore') requireValue('CS_DATABASE_RESTORE_REFERENCE')
  if (selected === 'discard' && env.CS_DATABASE_MIGRATION_CONFIRM !== 'discard')
    throw new EpochSwitchError('v3-hosted-discard-confirm-required')
  return {
    operationId: EpochOperationIdSchema.parse(requireValue('CS_DATABASE_MIGRATION_OPERATION_ID')),
    action: selected as HostedEpochJobContract['action'],
    approve: env.CS_DATABASE_MIGRATION_APPROVE,
    sourceGenerationId: requireValue('CS_DATABASE_MIGRATION_SOURCE_GENERATION'),
    freezeReference: env.CS_DATABASE_MIGRATION_FREEZE_REFERENCE,
    restoreReference: env.CS_DATABASE_RESTORE_REFERENCE,
    scratchRoot: env.CS_DATABASE_MIGRATION_SCRATCH_ROOT ?? '/tmp/agent-workflow-epoch-migration',
    env,
  }
}
export interface HostedEpochJobHandle {
  application: EpochSwitchApplication
  close(): Promise<void>
}
export interface HostedEpochJobEntryDependencies {
  compose(contract: HostedEpochJobContract): Promise<HostedEpochJobHandle>
}
export interface HostedEpochCompositionOptions extends Pick<
  LocalEpochSwitchOptions,
  | 'head'
  | 'catalogArtifacts'
  | 'probes'
  | 'acceptanceProbes'
  | 'candidateBuild'
  | 'faults'
  | 'sourceBornOnPostgresql'
  | 'postgresqlArchive'
> {
  artifacts: HostedEpochArtifacts
  sourceManifest(): Promise<SupportedSourceManifest>
  objects?: InventoryObjectReader
  verifyFreeze(ack: HostedFreezeAcknowledgement): Promise<boolean>
  control: HostedEpochSwitchControl
  downloadBackup?(reference: string, destination: string): Promise<string>
}

export async function composeHostedEpochSwitch(
  contract: HostedEpochJobContract,
  options: HostedEpochCompositionOptions,
): Promise<HostedEpochJobHandle> {
  const runtime = (profileRef: string) =>
    postgresqlRuntimeFor({
      profileRef:
        profileRef === 'crewstation:source'
          ? 'env:CS_DATABASE_MIGRATION_SOURCE_URL'
          : profileRef === 'crewstation:target'
            ? 'env:CS_DATABASE_MIGRATION_TARGET_URL'
            : profileRef,
      base: DEFAULT_CONFIG.database,
      generationId: contract.sourceGenerationId,
      env: contract.env,
    })
  const targetRuntime = runtime('crewstation:target')
  const sourceRuntime = contract.env.CS_DATABASE_MIGRATION_SOURCE_URL
    ? runtime('crewstation:source')
    : null
  const connection = openConversionTarget({ runtime: targetRuntime })
  try {
    const sourceFingerprint = sourceRuntime
      ? (await sourceRuntime.readiness()).databaseFingerprint
      : null
    let catalogProfile = 'crewstation:target'
    const openTarget = (profileRef: string) => {
      catalogProfile = profileRef
      const selected = profileRef === 'crewstation:target' ? targetRuntime : runtime(profileRef)
      const target = openConversionTarget({ runtime: selected })
      return {
        ...target,
        async close() {
          try {
            await target.close()
          } finally {
            if (selected !== targetRuntime) await selected.close()
          }
        },
      }
    }
    const preflight = async (profileRef = 'crewstation:target') => {
      catalogProfile = profileRef
      if (profileRef !== 'crewstation:target') {
        const selected = runtime(profileRef)
        try {
          return await preflightPostgresqlConversionTarget({
            runtime: selected,
            profileRef,
            sourceFingerprint,
            supportedMajors: options.catalogArtifacts.map((a) => a.postgresqlMajor),
          })
        } finally {
          await selected.close()
        }
      }
      const result = await preflightPostgresqlConversionTarget({
        runtime: targetRuntime,
        profileRef: 'crewstation:target',
        sourceFingerprint,
        supportedMajors: options.catalogArtifacts.map((a) => a.postgresqlMajor),
      })
      const tables = await connection.execute(
        "SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')",
      )
      if (
        tables.length === 1 &&
        tables[0]?.schema === 'agent_workflow_meta' &&
        tables[0]?.name === 'migration_operations'
      ) {
        const rows = await connection.execute(
          'SELECT operation_id FROM agent_workflow_meta.migration_operations',
        )
        if (rows.every((row) => row.operation_id === contract.operationId))
          return {
            ...result,
            empty: true,
            blocks: result.blocks.filter((b) => b.code !== 'postgresql-target-not-empty'),
          }
      }
      return result
    }
    const journalExists = (
      await connection.execute(
        "SELECT to_regclass('agent_workflow_meta.migration_operations') AS name",
      )
    )[0]?.name
    if (!journalExists) {
      const checked = await preflight()
      if (!checked.empty || checked.blocks.length || !checked.canCreate)
        throw new EpochSwitchError('v3-hosted-target-not-empty-or-incompatible', {
          category: 'target-not-empty',
        })
      for (const sql of compileMetaTables(
        'postgresql',
        EPOCH2_META_TABLES.filter((t) => t.name === 'migration_operations'),
      ))
        await connection.execute(sql)
    }
    const journal = createMetaEpochSwitchJournal({
      connection,
      artifacts: options.artifacts,
      scratchRoot: contract.scratchRoot,
      async acquireOperationLock(op) {
        const lock = await targetRuntime.acquireMigrationAdvisoryLock(op)
        if (!lock)
          throw new EpochSwitchError('v3-operation-locked', {
            category: 'owner-conflict',
            retryable: true,
          })
        return lock
      },
    })
    const sourceFor: NonNullable<EpochSwitchDependencies['sourceFor']> = (journal) =>
      createEpochSourceAdapter({
        async resolve() {
          const scratch = journal.payload.inputs.scratchProfileRef
          const openScratch = (requireEmpty: boolean) => {
            if (!scratch)
              throw new EpochSwitchError('v3-scratch-required', { category: 'scratch-required' })
            return openPostgresqlScratch({
              runtime: runtime(scratch),
              profileRef: scratch,
              sourceFingerprint,
              supportedMajors: options.catalogArtifacts.map((a) => a.postgresqlMajor),
              requireEmpty,
            })
          }
          return {
            manifest: await options.sourceManifest(),
            ...(sourceRuntime ? { postgresql: () => sourceRuntime } : {}),
            ...(scratch
              ? {
                  createScratchPostgresql: () => openScratch(true),
                  reopenScratchPostgresql: () => openScratch(false),
                }
              : {}),
          }
        },
      })
    const source = createEpochSourceAdapter({
      async resolve() {
        return {
          manifest: await options.sourceManifest(),
          ...(sourceRuntime ? { postgresql: () => sourceRuntime } : {}),
        }
      },
    })
    const cache = new HistoryCatalogCache(async (plan) => {
      const selected = openTarget(catalogProfile)
      let major: number
      try {
        const row = (
          await selected.execute("SELECT current_setting('server_version_num') AS version")
        )[0]
        major = Math.floor(Number(row?.version) / 10000)
      } finally {
        await selected.close()
      }
      const artifact = options.catalogArtifacts.find(
        (a) => a.planDigest === plan.digest && a.postgresqlMajor === major,
      )
      if (!artifact)
        throw new EpochSwitchError('v3-catalog-unavailable', { category: 'catalog-unavailable' })
      return artifact
    })
    const { persistenceSchema } = await import('./persistenceSchema')
    const target = createTargetGenerationPort({
      appHome: contract.scratchRoot,
      registry: persistenceSchema,
      head: options.head,
      catalogCache: cache,
      receiptStorage: 'meta-only',
      postgresql: {
        async open(location) {
          return openTarget(location.profileRef)
        },
        preflight: (request) =>
          preflight(
            request.location.kind === 'postgresql-target'
              ? request.location.profileRef
              : 'crewstation:target',
          ),
      },
    })
    const content = createContentInventoryAdapter({ objects: options.objects })
    const app = createEpochSwitchApplication({
      journal,
      source,
      sourceFor,
      target,
      backup: createEpochBackupAdapter({
        artifacts: () => journal.artifacts!(contract.operationId),
      }),
      async nextTargetLocation(current) {
        const name = contract.env.CS_DATABASE_MIGRATION_NEXT_TARGET_URL_ENV
        if (!name && phaseIndex(current.payload.phase) >= phaseIndex('converting'))
          throw new EpochSwitchError('v3-new-run-target-required', { category: 'target-not-empty' })
        const location = name
          ? { kind: 'postgresql-target' as const, profileRef: environmentProfile(name) }
          : current.payload.target.location!
        const checked = await target.preflight({
          provider: 'postgresql',
          location,
          sourceFingerprint: null,
        })
        if (!checked.empty || !checked.canCreate || checked.blocks.length)
          throw new EpochSwitchError('v3-new-run-target-not-empty', {
            category: 'target-not-empty',
          })
        return location
      },
      async targetEvidence(generationId, location) {
        if (location.kind !== 'postgresql-target')
          throw new EpochSwitchError('v3-hosted-target-provider')
        const target = openTarget(location.profileRef)
        try {
          return await readEpochTargetEvidence(target, generationId)
        } finally {
          await target.close()
        }
      },
      postgresqlArchive:
        options.postgresqlArchive ??
        (async (source) =>
          epochSourceArchiveInput(source, {
            bornOnPostgresql: options.sourceBornOnPostgresql === true,
          })),
      content,
      conversionPlan: (request) => planConversion(epochConversionInput(request)),
      conversion: {
        bootUpgradeEnvironment: composeBootUpgradeEnvironment(
          epochMigrationKeys(() =>
            contract.env.CS_DATABASE_MIGRATION_SOURCE_KEY
              ? Buffer.from(contract.env.CS_DATABASE_MIGRATION_SOURCE_KEY, 'base64')
              : null,
          ),
        ),
        async dryRun(request) {
          const sink = createDryRunSink()
          await runConversion(epochConversionInput(request), sink)
          return sink.result
        },
        run: (request, sink) => runConversion(epochConversionInput(request), sink),
      },
      activation: createHostedEpochActivation(options.control),
      quiesce: createHostedEpochFreeze({
        acknowledgement: {
          operationId: contract.operationId,
          reference: contract.freezeReference ?? '',
          sourceGenerationId: contract.sourceGenerationId,
          writersStopped: contract.freezeReference !== undefined,
        },
        verify: options.verifyFreeze,
      }),
      retention: {
        async retain({ source }) {
          return source.kind === 'backup' ? [source.artifact] : ['crewstation:source']
        },
      },
      async installation() {
        return {
          source: { kind: 'postgresql-database', profileRef: 'crewstation:source' },
          pointerBytes: null,
          facts: {
            pointer: null,
            provider: 'postgresql',
            sourceExists: true,
            operation: null,
            rfc349Operation: null,
            activationReceiptDigest: null,
            targetState: null,
            rollbackIncomplete: false,
          },
        }
      },
      defaultContentRoot: {
        kind: 'app-home',
        root: join(contract.scratchRoot, contract.operationId, 'content'),
        runsSupplied: false,
        objects: 'crewstation',
      },
      candidateBuild: options.candidateBuild ?? 'rfc395-epoch2-hosted-candidate',
      targetContractDigest: options.head.contract.contract.digest,
      targetPlanDigest: (provider) => options.head[provider].digest,
      newOperationId: () => contract.operationId,
      probes: options.probes ?? conversionReadOnlyProbes,
      acceptanceProbes: options.acceptanceProbes,
      faults: options.faults,
      async unpackBackup(artifact, destination, artifacts) {
        const local = options.downloadBackup
          ? await options.downloadBackup(artifact, destination)
          : artifact
        const unpacked = await unpackOldEpochBackup({
          artifact: local,
          destination: join(destination, 'unpacked'),
          artifacts,
        })
        return {
          ...unpacked,
          runsSupplied: ['runs', 'logs', 'evidence'].some((name) =>
            existsSync(join(unpacked.root, name)),
          ),
        }
      },
      materializeBackup: (digest, artifacts) => materializeOldEpochBackup({ digest, artifacts }),
      trace: composeEpochTrace({ journal, source, sourceFor, content }),
    })
    return {
      application: app,
      async close() {
        try {
          await connection.close()
        } finally {
          await targetRuntime.close()
          await sourceRuntime?.close()
        }
      },
    }
  } catch (error) {
    await connection.close()
    await targetRuntime.close()
    await sourceRuntime?.close()
    throw error
  }
}

async function executeHostedJob(
  contract: HostedEpochJobContract,
  deps: HostedEpochJobEntryDependencies,
): Promise<string> {
  const handle = await deps.compose(contract)
  try {
    const app = handle.application
    if (contract.action === 'restore') {
      const plan = await app.restoreBackup({
        artifact: contract.restoreReference!,
        target: { provider: 'postgresql' },
        scratchUrlEnv: contract.env.CS_DATABASE_MIGRATION_SCRATCH_URL
          ? 'CS_DATABASE_MIGRATION_SCRATCH_URL'
          : undefined,
      })
      return `CS_DATABASE_MIGRATION_PLAN=${JSON.stringify(plan)}`
    }
    if (contract.action === 'plan') {
      const list = await app.status({})
      const exists =
        Array.isArray(list) && list.some((entry) => entry.operationId === contract.operationId)
      const plan = await app.plan({
        ...(exists ? { operationId: contract.operationId } : {}),
        target: { provider: 'postgresql' },
        scratchUrlEnv: contract.env.CS_DATABASE_MIGRATION_SCRATCH_URL
          ? 'CS_DATABASE_MIGRATION_SCRATCH_URL'
          : undefined,
      })
      return `CS_DATABASE_MIGRATION_PLAN=${JSON.stringify(plan)}`
    }
    const input = { operationId: contract.operationId }
    const status =
      contract.action === 'complete'
        ? await app.complete(input)
        : contract.action === 'discard'
          ? await app.discard({ ...input, confirm: true })
          : contract.action === 'verify'
            ? await app.verify(input)
            : contract.action === 'rollback'
              ? await app.rollback(input)
              : await app.run({
                  ...input,
                  approve: contract.approve,
                  newRun: contract.action === 'new-run',
                })
    if (status.status === 'awaiting-approval') {
      if (!status.approval) throw new EpochSwitchError('v3-approval-request-missing')
      return `CS_DATABASE_MIGRATION_PLAN=${JSON.stringify(status.approval)}`
    }
    const receipt = await app.receipt({
      ...input,
      kind: ['verify', 'complete'].includes(contract.action)
        ? 'switch'
        : ['rollback', 'discard'].includes(contract.action)
          ? 'rollback'
          : 'activation',
    })
    return `CS_DATABASE_MIGRATION_RECEIPT=${receipt.json}`
  } finally {
    await handle.close()
  }
}
export async function runHostedEpochSwitchJob(
  env: EpochMigrationEnv,
  deps: HostedEpochJobEntryDependencies,
): Promise<string> {
  return executeHostedJob(parseHostedEpochJob(env), deps)
}
export async function verifyHostedEpochSwitch(
  env: EpochMigrationEnv,
  deps: HostedEpochJobEntryDependencies,
): Promise<string> {
  return executeHostedJob(parseHostedEpochJob(env, 'verify'), deps)
}
export async function restoreHostedEpoch1Backup(
  env: EpochMigrationEnv,
  deps: HostedEpochJobEntryDependencies,
): Promise<string> {
  return executeHostedJob(parseHostedEpochJob(env, 'restore'), deps)
}
