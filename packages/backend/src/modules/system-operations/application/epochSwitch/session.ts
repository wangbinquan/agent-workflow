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
import {
  CONVERTER_VERSION,
  type ConversionPlanSection,
} from '@/platform/persistence/migration/conversion/plan'
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
  SessionLockPort,
  AutoUpgradeRecordPort,
  EpochTargetProvisioningPort,
} from '../ports/epochSwitch'
import {
  EpochSwitchError,
  type EpochSwitchJournal,
  type EpochSwitchJournalPayload,
  type EpochSwitchFaults,
} from '../../domain/epochSwitch/model'
import {
  phaseIndex,
  reviseEpochSwitch,
  takeOverEpochSwitch,
} from '../../domain/epochSwitch/transitions'
import type { InstallationFacts } from '../../domain/epochSwitch/classification'
import {
  parseMigrationPlanDocument,
  type MigrationPlanDocument,
  type RestoreFileChange,
} from '../../domain/epochSwitch/documents'
import {
  PLAN_PIN_ARTIFACT,
  parsePlanPin,
  pinnedMaterialDifferences,
  type PinnedMaterial,
  type PlanPin,
} from '../../domain/epochSwitch/planPin'

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
  /**
   * RFC-626 §4.2: single-pass orchestration. Only the assembly of the automatic upgrade sets
   * it; the manual flow and the hosted deployment never do, and without it every step is what
   * it was. The automatic session holds the daemon lock from its first step to its last, so
   * the old database cannot change in between: one freeze, one inventory, one backup, one
   * conversion written straight into the new database, one finalize and one validation
   * replace the manual flow's "plan on the live database, then do it again once writers have
   * stopped". The conversion resolves what it cannot carry over instead of blocking.
   */
  readonly direct?: boolean
  /**
   * RFC-626 §4.7: called by a direct run where one step has ended and the next has not begun —
   * the plan step's objects are dead, the backup is written, the conversion is over. The
   * assembly of the automatic upgrade collects there, so that what the next step allocates
   * fits into memory the process already holds instead of adding to it.
   */
  readonly reclaim?: () => void
  /**
   * RFC-626 §4.2: the automatic session's answer to the plan a direct run wrote after its
   * conversion. That plan nearly always differs materially from the plan approved before the
   * run, so the run would otherwise return, be approved by the session and be entered again —
   * re-opening the source, capturing the boot facts and verifying every content reference a
   * second time. The session installs this for the duration of its loop; it evaluates the
   * plan under its usual rules and returns the approval digest, or null when it does not
   * approve (the run then stops awaiting approval, as it does without the callback).
   */
  approveActualPlan?(request: {
    readonly runId: string
    readonly plan: MigrationPlanDocument
  }): Promise<string | null>
  readonly sessionLock?: SessionLockPort
  readonly autoUpgradeRecords?: AutoUpgradeRecordPort
  /** RFC-398 §3.5: databases allocated by automatic PostgreSQL sessions (status lists them). */
  readonly retainedDatabases?: EpochTargetProvisioningPort['retained']
  readonly autoUpgradeCheckpoint?: (point: string) => Promise<void>
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
/** RFC-626 §4.2: the write-once artifact that pins the plan a direct run executes. */
export function planPinName(journal: EpochSwitchJournal): string {
  return runArtifact(journal, PLAN_PIN_ARTIFACT)
}
/**
 * `null`: this run has not pinned a plan. `'unreadable'`: it has, and this binary cannot read
 * the pin — which the comparison with the running binary counts as "written by another one".
 */
export async function readPlanPin(
  deps: Pick<EpochSwitchDependencies, 'journal'>,
  journal: EpochSwitchJournal,
): Promise<PlanPin | 'unreadable' | null> {
  if (!journal.payload.run) return null
  const bytes = await deps.journal.readArtifact(journal.payload.operationId, planPinName(journal))
  if (bytes === null) return null
  const pin = parsePlanPin(bytes)
  return pin !== null && pin.runId === journal.payload.run.runId ? pin : 'unreadable'
}
/** What the running binary pins, and what a pinned run is compared with when it is resumed. */
export function currentPinnedMaterial(
  deps: Pick<
    EpochSwitchDependencies,
    'candidateBuild' | 'targetContractDigest' | 'targetPlanDigest'
  >,
  journal: EpochSwitchJournal,
): PinnedMaterial {
  return {
    candidateBuild: deps.candidateBuild,
    converterVersion: CONVERTER_VERSION,
    targetContractDigest: deps.targetContractDigest,
    targetPlanDigest: deps.targetPlanDigest(journal.payload.target.provider),
  }
}
/**
 * RFC-626 §4.2: why the running binary cannot continue the journal's run directly; empty when
 * it can. Compared before anything opens the new database or parses the plan document, and
 * from the pin alone: a changed target contract makes the new database unopenable, and a
 * changed plan structure makes the plan unreadable, so neither can be the place that notices.
 *
 * Only a run that has started to execute is bound to its binary. Before the pin the plan is
 * simply made again by whichever binary runs. Once the activation receipt is published the
 * remaining steps read that receipt back and are not compared here. A run past `planned`
 * without a pin was not begun by a direct run at all and is given up the same way.
 */
export async function directRunMismatch(
  deps: Pick<
    EpochSwitchDependencies,
    'journal' | 'candidateBuild' | 'targetContractDigest' | 'targetPlanDigest'
  >,
  journal: EpochSwitchJournal,
): Promise<readonly string[]> {
  const p = journal.payload
  if (!p.run || phaseIndex(p.phase) >= phaseIndex('activated')) return []
  if (await deps.journal.readArtifact(p.operationId, 'activation-receipt.json')) return []
  const pin = await readPlanPin(deps, journal)
  if (pin === null) return phaseIndex(p.phase) > phaseIndex('planned') ? ['plan-not-pinned'] : []
  return pinnedMaterialDifferences(
    pin === 'unreadable' ? null : pin,
    currentPinnedMaterial(deps, journal),
  )
}
/** The plan document a pin names: the plan the run that pinned it had approved. */
export async function readPinnedPlan(
  deps: Pick<EpochSwitchDependencies, 'journal'>,
  journal: EpochSwitchJournal,
  pin: PlanPin,
): Promise<MigrationPlanDocument> {
  const bytes = await deps.journal.readArtifact(
    journal.payload.operationId,
    `plans/${pin.planDigest}.json`,
  )
  if (!bytes) throw new EpochSwitchError('v3-plan-file-missing', { category: 'receipt-conflict' })
  const document = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8'))
  if (
    document.digest !== pin.planDigest ||
    document.approvalDigest !== pin.approvalDigest ||
    document.payload.target.generationId !== journal.payload.target.generationId
  )
    throw new EpochSwitchError('v3-pinned-plan-mismatch', { category: 'receipt-conflict' })
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
    // RFC-626: a direct run lets the conversion decide about data the source can hold but the
    // strict access would refuse; the source access also keeps and re-opens its frozen copy.
    ...(session.deps.direct ? { resolution: 'automatic' as const } : {}),
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
      if (next.payload.phase !== old.payload.phase)
        await deps.autoUpgradeCheckpoint?.(`phase-${next.payload.phase}`)
      if (
        phaseIndex(next.payload.phase) > phaseIndex('planned') &&
        next.payload.status === 'awaiting-approval' &&
        old.payload.status !== 'awaiting-approval'
      )
        await deps.autoUpgradeCheckpoint?.('awaiting-approval')
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
          put: async (name, bytes) => {
            const digest = await port.put(name, bytes)
            if (/^acceptance-health-/.test(name))
              await deps.autoUpgradeCheckpoint?.('acceptance-published')
            await record(name, digest)
            if (/^acceptance-health-/.test(name))
              await deps.autoUpgradeCheckpoint?.('acceptance-referenced')
            return digest
          },
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
      await deps.autoUpgradeCheckpoint?.(
        failure.category === 'health-failed'
          ? 'acceptance-journal-failed'
          : `failure-${failure.category}`,
      )
    }
    throw error
  } finally {
    try {
      if (!deps.sessionLock) await deps.quiesce.release(operationId)
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
