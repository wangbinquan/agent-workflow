import type { MigrationProgressCallback } from '@/platform/persistence/migration/run/progress'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { relocateEpochPath } from '@/platform/persistence/migration/run/paths'
export { relocateEpochPath } from '@/platform/persistence/migration/run/paths'
import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import type { EmptyTableDecision } from '@/platform/persistence/migration/sourceDispositions'
import type { ConversionPlanSection } from '@/platform/persistence/migration/conversion/plan'
import type { ConversionRunRequest } from '@/platform/persistence/migration/run/types'
import type {
  EpochSourceLocation,
  ContentRootSpec,
  MigrationTraceResult,
  TraceInput,
  ReadOnlyProbe,
  SourceArchiveInput,
  FrozenSourceHandle,
  EpochTargetLocation,
  EpochSwitchArtifactPort,
  FreezeContentManifest,
} from '@/platform/persistence/migration/run/types'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchPlanInput } from '../../public/types'
import type {
  ActivationPort,
  ContentInventoryPort,
  ConversionPort,
  EpochBackupPort,
  EpochSourcePort,
  EpochSwitchJournalPort,
  MigrationMetaReadPort,
  QuiescePort,
  SourceRetentionPort,
  TargetGenerationPort,
} from '../ports/epochSwitch'
import {
  EpochSwitchError,
  type EpochSwitchJournal,
  type EpochSwitchJournalPayload,
  type EpochSwitchFaults,
} from '../../domain/epochSwitch/model'
import { reviseEpochSwitch, takeOverEpochSwitch } from '../../domain/epochSwitch/transitions'
import type { InstallationFacts } from '../../domain/epochSwitch/classification'
import {
  parseMigrationPlanDocument,
  type RestoreFileChange,
} from '../../domain/epochSwitch/documents'

export interface EpochSwitchWithdrawalInput {
  readonly operationId: string
  readonly decisions: readonly string[] | 'all'
}
export interface EpochSwitchApplicationWithWithdrawal extends EpochSwitchApplication {
  withdrawAcknowledgements(
    input: EpochSwitchWithdrawalInput,
  ): ReturnType<EpochSwitchApplication['plan']>
}

export interface EpochInstallationProbe {
  facts: InstallationFacts
  source: EpochSourceLocation
  pointerBytes: Uint8Array | null
}
export interface EpochRestoreFiles {
  plan(input: {
    operationRoot: string
    sourceRoot: string
    restoreConfig: boolean
  }): Promise<readonly RestoreFileChange[]>
  apply(changes: readonly RestoreFileChange[]): Promise<void>
  rollback(changes: readonly RestoreFileChange[]): Promise<void>
}
export interface EpochSwitchDependencies {
  readonly progress?: MigrationProgressCallback
  journal: EpochSwitchJournalPort
  source: EpochSourcePort
  sourceFor?(journal: EpochSwitchJournal): EpochSourcePort
  backup: EpochBackupPort
  postgresqlArchive?(
    source: FrozenSourceHandle,
    journal: EpochSwitchJournal,
  ): Promise<SourceArchiveInput>
  targetEvidence?(
    generationId: string,
    location: EpochTargetLocation,
  ): Promise<{
    state: 'prepared' | 'active' | 'retired'
    activationReceiptDigest: string | null
  } | null>
  content: ContentInventoryPort
  target: TargetGenerationPort
  nextTargetLocation?(
    current: EpochSwitchJournal,
    next: EpochSwitchJournal,
  ): Promise<EpochTargetLocation>
  conversion: ConversionPort
  conversionPlan(input: ConversionRunRequest): ConversionPlanSection
  activation: ActivationPort
  quiesce: QuiescePort
  retention: SourceRetentionPort
  installation(): Promise<EpochInstallationProbe>
  defaultContentRoot: ContentRootSpec
  candidateBuild: string
  targetContractDigest: string
  targetPlanDigest(provider: DatabaseProvider): string
  probes?: readonly ReadOnlyProbe[]
  acceptanceProbes?: readonly ReadOnlyProbe[]
  faults?: EpochSwitchFaults
  now?: () => number
  ownerId?: string
  newOperationId?: () => string
  resolveEmptyTables?(input: {
    source: EpochSourceLocation
    decisions: NonNullable<EpochSwitchPlanInput['emptyTables']>
    operationRoot: string
  }): Promise<readonly EmptyTableDecision[]>
  measureCapacity?(
    source: EpochSourceLocation,
    operationRoot: string,
  ): Promise<{ sourceBytes: number | null; availableBytes: number | null; operationBytes?: number }>
  unpackBackup?(
    artifact: string,
    destination: string,
    artifacts?: EpochSwitchArtifactPort,
  ): Promise<{
    sourceKind: 'sqlite-backup' | 'logical-backup' | 'logical-artifact' | 'hosted-backup'
    root: string
    digest: string
    runsSupplied?: boolean
  }>
  materializeBackup?(digest: string, artifacts: EpochSwitchArtifactPort): Promise<{ root: string }>
  restoreFiles?: EpochRestoreFiles
  trace?(
    meta: MigrationMetaReadPort,
    input: TraceInput & { runId: string },
  ): Promise<MigrationTraceResult>
}
export interface EpochSwitchSession {
  readonly deps: EpochSwitchDependencies
  journal: EpochSwitchJournal
  now(): number
  materializedBackupRoot?: string
  save(patch: Parameters<typeof reviseEpochSwitch>[1]): Promise<EpochSwitchJournal>
  replace(next: EpochSwitchJournal): Promise<EpochSwitchJournal>
  artifact<T>(name: string): Promise<T | null>
  artifacts(): EpochSwitchArtifactPort | undefined
  write(name: string, value: unknown): Promise<{ path: string | null; digest: string }>
}
export function runArtifact(journal: EpochSwitchJournal, name: string): string {
  if (!journal.payload.run) throw new EpochSwitchError('v3-run-identity-missing')
  return `runs/${journal.payload.run.runId}/${name}`
}
export async function requireEpochJournal(deps: EpochSwitchDependencies, operationId: string) {
  const journal = await deps.journal.read(operationId)
  if (!journal) throw new EpochSwitchError('v3-operation-not-found')
  return journal
}
export async function readEpochPlan(session: EpochSwitchSession) {
  const plan = session.journal.payload.plan
  if (!plan) throw new EpochSwitchError('v3-plan-missing')
  const bytes = await session.deps.journal.readArtifact(
    session.journal.payload.operationId,
    `plans/${plan.digest}.json`,
  )
  if (!bytes) throw new EpochSwitchError('v3-plan-file-missing', { category: 'receipt-conflict' })
  const document = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8'))
  if (document.digest !== plan.digest) throw new EpochSwitchError('v3-plan-digest-mismatch')
  return document
}
export function sourcePort(session: EpochSwitchSession): EpochSourcePort {
  return session.deps.sourceFor?.(session.journal) ?? session.deps.source
}
export function sourceRequest(session: EpochSwitchSession) {
  const p = session.journal.payload
  return {
    progress: session.deps.progress,
    scratchOwner: p.operationId,
    ...(p.source.location.kind === 'postgresql-database'
      ? {
          async postgresqlArchive(source: FrozenSourceHandle) {
            if (!session.deps.postgresqlArchive)
              throw new EpochSwitchError('v3-postgresql-archive-required', {
                category: 'source-blocked',
              })
            return session.deps.postgresqlArchive(source, session.journal)
          },
        }
      : {}),
    location:
      p.source.location.kind === 'backup'
        ? { ...p.source.location, root: epochLocalPath(session, p.source.location.root) }
        : p.source.location,
    artifacts: epochRunArtifacts(session.journal, session.artifacts()),
    emptyTables: p.inputs.emptyTables,
    operationRoot: epochArtifactPath(
      session.deps.journal.operationRoot(p.operationId),
      runArtifact(session.journal, 'source'),
    ),
  }
}

export function epochRunArtifacts(
  journal: EpochSwitchJournal,
  port: EpochSwitchArtifactPort | undefined,
): EpochSwitchArtifactPort | undefined {
  if (!port || !journal.payload.run) return undefined
  const prefix = `runs/${journal.payload.run.runId}/`
  return {
    put: (name, bytes) => port.put(prefix + name, bytes),
    ...(port.putFile
      ? { putFile: (name: string, path: string) => port.putFile!(prefix + name, path) }
      : {}),
    get: (name, digest) => port.get(prefix + name, digest),
  }
}
export function epochLocalPath(session: EpochSwitchSession, path: string): string {
  const p = session.journal.payload
  if (
    session.materializedBackupRoot &&
    p.source.location.kind === 'backup' &&
    (path === p.source.location.root || path.startsWith(p.source.location.root + '/'))
  )
    return epochArtifactPath(
      session.materializedBackupRoot,
      path.slice(p.source.location.root.length),
    )
  return epochDeploymentCapabilities(p.deployment).localPaths
    ? path
    : relocateEpochPath(path, p.operationId, session.deps.journal.operationRoot(p.operationId))
}
export function epochContentRoot(session: EpochSwitchSession): ContentRootSpec {
  const root = session.journal.payload.inputs.contentRoot!
  return {
    ...root,
    root: epochLocalPath(session, root.root),
    ...(root.runContentRoot
      ? { runContentRoot: epochLocalPath(session, root.runContentRoot) }
      : {}),
  }
}
export function epochContentManifest(
  session: EpochSwitchSession,
  manifest: FreezeContentManifest,
): FreezeContentManifest {
  return { ...manifest, roots: manifest.roots.map((root) => epochLocalPath(session, root)) }
}
export async function materializeEpochArtifacts(
  deps: EpochSwitchDependencies,
  journal: EpochSwitchJournal,
): Promise<string | undefined> {
  const artifacts = deps.journal.artifacts?.(journal.payload.operationId)
  if (!artifacts) {
    if (epochDeploymentCapabilities(journal.payload.deployment).externalSwitch)
      throw new EpochSwitchError('v3-artifact-capability-required')
    return
  }
  for (const reference of journal.payload.artifacts ?? [])
    await artifacts.get(reference.name, reference.digest)
  if (journal.payload.source.location.kind === 'backup' && deps.materializeBackup) {
    const bytes = await deps.journal.readArtifact(journal.payload.operationId, 'inputs/backup.json')
    if (!bytes) throw new EpochSwitchError('v3-backup-input-missing')
    const input = JSON.parse(Buffer.from(bytes).toString('utf8')) as { digest: string }
    return (await deps.materializeBackup(input.digest, artifacts)).root
  }
  return undefined
}

export async function openEpochTargetIfCreated(session: EpochSwitchSession) {
  const p = session.journal.payload
  if (!p.run || !p.target.generationId || !p.target.location) return null
  try {
    return await session.deps.target.open({
      generationId: p.target.generationId,
      provider: p.target.provider,
      location: p.target.location,
      faults: session.deps.faults,
    })
  } catch (error) {
    if (await session.artifact(runArtifact(session.journal, 'target-installed.json'))) throw error
    const checked = await session.deps.target.preflight({
      provider: p.target.provider,
      location: p.target.location,
      sourceFingerprint: p.source.fingerprintDigest,
    })
    if (!checked.empty || checked.blocks.length) throw error
    return null
  }
}

export async function withEpochOperation<T>(
  deps: EpochSwitchDependencies,
  operationId: string,
  body: (s: EpochSwitchSession) => Promise<T>,
): Promise<T> {
  const lock = await deps.journal.lockOperation(operationId)
  const now = deps.now ?? Date.now
  const ownerId = deps.ownerId ?? `${process.pid}:${crypto.randomUUID()}`
  let session: EpochSwitchSession | undefined
  try {
    const current = await requireEpochJournal(deps, operationId)
    const replace = async (next: EpochSwitchJournal) => {
      if (!session) throw new EpochSwitchError('v3-session-missing')
      const old = session.journal
      session.journal = await deps.journal.compareAndSwap(
        { operationId, revision: old.payload.revision, digest: old.digest },
        next,
      )
      deps.faults?.('after-journal-cas')
      return session.journal
    }
    session = {
      deps,
      journal: current,
      now,
      replace,
      save: (patch) => {
        const j = session!.journal
        const phase = patch.phase ?? j.payload.phase
        const key = `${j.payload.run?.runId ?? 'discovery'}:${phase}`
        const checkpoints =
          phase !== j.payload.phase && !j.payload.checkpoints.some((c) => c.key === key)
            ? [
                ...j.payload.checkpoints,
                { phase, key, committedAt: now(), digest: valueDigest(patch) },
              ]
            : j.payload.checkpoints
        return replace(reviseEpochSwitch(j, { ...patch, checkpoints }, now()))
      },
      async artifact<T>(name: string) {
        const bytes = await deps.journal.readArtifact(operationId, name)
        return bytes === null ? null : (JSON.parse(Buffer.from(bytes).toString('utf8')) as T)
      },
      artifacts() {
        const port = deps.journal.artifacts?.(operationId)
        if (!port) return undefined
        const record = async (name: string, digest: string) => {
          const references = session!.journal.payload.artifacts ?? []
          if (!references.some((ref) => ref.name === name && ref.digest === digest))
            await session!.save({
              artifacts: [...references.filter((ref) => ref.name !== name), { name, digest }],
            })
          return digest
        }
        return {
          get: (name, digest) => port.get(name, digest),
          put: async (name, bytes) => record(name, await port.put(name, bytes)),
          ...(port.putFile
            ? {
                putFile: async (name: string, path: string) =>
                  record(name, await port.putFile!(name, path)),
              }
            : {}),
        }
      },
      write: (name, value) =>
        deps.journal.writeOnce(operationId, name, Buffer.from(canonicalSchemaJson(value))),
    }
    await replace(takeOverEpochSwitch(current, ownerId, now()))
    session.materializedBackupRoot = await materializeEpochArtifacts(deps, session.journal)
    return await body(session)
  } catch (error) {
    const failureError =
      error instanceof EpochSwitchError
        ? error
        : new EpochSwitchError(error instanceof Error ? error.message : 'v3-operation-failed', {
            retryable: true,
          })
    if (
      session &&
      !['owner-conflict', 'approval-required', 'reverse-migration-required'].includes(
        failureError.category,
      ) &&
      !['completed', 'rolled-back', 'abandoned'].includes(session.journal.payload.status)
    ) {
      const failure: EpochSwitchJournalPayload['failure'] = {
        phase: session.journal.payload.phase,
        category: failureError.category,
        detailCode: failureError.code,
        retryable: failureError.retryable,
        failedAt: now(),
      }
      await session.save({ status: 'failed', failure })
    }
    throw error
  } finally {
    try {
      await deps.quiesce.release(operationId)
    } finally {
      await lock.release()
    }
  }
}

export function pointerEvidence(bytes: Uint8Array | null) {
  return {
    bytesBase64: bytes === null ? null : Buffer.from(bytes).toString('base64'),
    digest: bytes === null ? null : bytesDigest(bytes),
  }
}
