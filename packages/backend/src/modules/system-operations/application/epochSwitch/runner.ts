import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { ConversionSummary } from '@/platform/persistence/migration/conversion/sink'
import type {
  FreezeContentManifest,
  FrozenSourceHandle,
  SwitchBackupReceipt,
  ValidationReport,
  QuiesceReceipt,
} from '@/platform/persistence/migration/run/types'
import { VALIDATION_CHECKS } from '@/platform/persistence/migration/run/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import {
  parseGenerationPointerV2,
  type GenerationPointerV2Payload,
} from '@/platform/persistence/generationPointerV2'
import { parseDatabaseGenerationText } from '@/platform/persistence/generationValidation'
import type { TargetGenerationHandle } from '../ports/epochSwitch'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchStatusView } from '../../public/types'
import {
  createActivationReceipt,
  approveMigrationPlan,
  appendMigrationApproval,
  latestMigrationApproval,
  parseActivationReceipt,
  createMigrationPlanDocument,
  type ActivationReceipt,
} from '../../domain/epochSwitch/documents'
import { EpochSwitchError, createEpochSwitchJournal } from '../../domain/epochSwitch/model'
import { assertApproved, newEpochRun, phaseIndex } from '../../domain/epochSwitch/transitions'
import { buildEpochPlan } from '../../domain/epochSwitch/planDocument'
import {
  readEpochPlan,
  runArtifact,
  sourcePort,
  sourceRequest,
  openEpochTargetIfCreated,
  pointerEvidence,
  epochContentRoot,
  epochContentManifest,
  type EpochSwitchSession,
} from './session'
import {
  captureBootUpgradeFacts,
  conversionRequest,
  persistEpochPlan,
  planEpochOperation,
  unfinishedTasks,
} from './planner'
import { epochSwitchStatus } from './status'

interface FrozenEvidence {
  watermark: string
  preflight: SourcePreflight
  preUpgrade: SourcePreflight | null
  planTime: number
}

async function approve(session: EpochSwitchSession, digest: string | undefined): Promise<void> {
  const plan = await readEpochPlan(session)
  if (plan.payload.blocks.length > 0)
    throw new EpochSwitchError('v3-plan-blocked', { category: 'conversion-blocked' })
  const p = session.journal.payload
  const history = p.approvals ?? []
  if (digest !== undefined) {
    const approval = approveMigrationPlan({
      plan,
      approve: digest,
      runId: p.run!.runId,
      approvedAt: session.now(),
      history,
    })
    await session.save({
      approvals: appendMigrationApproval(history, approval),
      plan: {
        ...p.plan!,
        approvedDigest: approval.payload.approvalDigest,
        approvedAt: approval.payload.approvedAt,
      },
      status: 'running',
      failure: null,
    })
  }
  const latest = latestMigrationApproval(session.journal.payload.approvals ?? [], p.run!.runId)
  if (latest?.payload.approvalDigest !== plan.approvalDigest)
    throw new EpochSwitchError('v3-approval-required', { category: 'approval-required' })
  assertApproved(session.journal)
}

async function mirrorApprovals(
  session: EpochSwitchSession,
  target: TargetGenerationHandle,
): Promise<void> {
  if (!target.recordApproval || !target.trace().approvals)
    throw new EpochSwitchError('v3-approval-capability-required')
  for (const approval of session.journal.payload.approvals ?? [])
    if (approval.payload.runId === session.journal.payload.run!.runId)
      await target.recordApproval(approval)
}

async function readBackup(session: EpochSwitchSession): Promise<SwitchBackupReceipt | null> {
  return (
    (await session.artifact<SwitchBackupReceipt>(
      runArtifact(session.journal, 'backup-final.json'),
    )) ??
    (await session.artifact<SwitchBackupReceipt>(runArtifact(session.journal, 'backup-live.json')))
  )
}

async function createBackup(
  session: EpochSwitchSession,
  source: FrozenSourceHandle,
  manifest: FreezeContentManifest,
  stage: 'live' | 'final',
): Promise<SwitchBackupReceipt> {
  const name = runArtifact(session.journal, `backup-${stage}.json`)
  const existing = await session.artifact<SwitchBackupReceipt>(name)
  if (existing) return existing
  const p = session.journal.payload
  session.deps.progress?.({ phase: 'backup', detail: `${stage} backup`, boundary: true })
  const receipt = await session.deps.backup.create({
    operationId: p.operationId,
    source,
    destination: epochArtifactPath(
      session.deps.journal.operationRoot(p.operationId),
      `backup/${p.run!.ordinal}/${stage}`,
    ),
    contentManifest: manifest,
    artifacts: session.artifacts(),
    postgresqlArchive:
      persistenceDialect(source.preflight.fingerprint.provider).externalArchive &&
      p.source.location.kind !== 'backup'
        ? await session.deps.postgresqlArchive?.(source, session.journal)
        : undefined,
  })
  session.deps.progress?.({ phase: 'backup', detail: `${stage} backup complete`, boundary: true })
  await session.write(name, receipt)
  session.deps.faults?.(stage === 'live' ? 'after-backup-file' : 'after-final-backup')
  return receipt
}

function assertValidation(report: ValidationReport): void {
  if (
    !report.passed ||
    report.blocks.length ||
    report.contentDrift.length ||
    report.probes.some((p) => !p.passed) ||
    VALIDATION_CHECKS.some(
      (check) => !report.checks.some((result) => result.check === check && result.passed),
    )
  )
    throw new EpochSwitchError('v3-validation-failed', { category: 'validation-failed' })
}

export function activationPointer(receipt: ActivationReceipt): GenerationPointerV2Payload {
  const p = receipt.payload
  const previous = previousPointerIdentity(p.previousPointer.bytesBase64)
  return {
    version: 2,
    schemaEpoch: 2,
    generationId: p.target.generationId,
    provider: p.target.provider,
    role: p.role,
    database: p.target.location,
    contractDigest: p.target.contractDigest,
    planDigest: p.target.planDigest,
    operationId: p.operationId,
    manifestDigest: receipt.digest,
    activatedAt: p.preparedAt,
    previous,
  }
}

function previousPointerIdentity(
  bytesBase64: string | null,
): GenerationPointerV2Payload['previous'] {
  if (bytesBase64 !== null) {
    const text = Buffer.from(bytesBase64, 'base64').toString('utf8')
    const version = (JSON.parse(text) as { payload: { version: number } }).payload.version
    const pointer =
      version === 1
        ? parseDatabaseGenerationText(text, 'activation previous pointer')
        : parseGenerationPointerV2(text)
    return { generationId: pointer.payload.generationId, pointerDigest: pointer.digest }
  }
  return null
}

async function prepareActivation(
  session: EpochSwitchSession,
  target: TargetGenerationHandle,
): Promise<ActivationReceipt> {
  const existing = await session.deps.journal.readArtifact(
    session.journal.payload.operationId,
    'activation-receipt.json',
  )
  if (existing) return parseActivationReceipt(Buffer.from(existing).toString('utf8'))
  const p = session.journal.payload
  const plan = await readEpochPlan(session)
  const run = await target.trace().migrationRun(p.run!.runId)
  const backup = await readBackup(session)
  if (
    !run?.bindingDigest ||
    !run.summaryDigest ||
    !run.validation ||
    !run.receiptExportDigest ||
    !backup
  )
    throw new EpochSwitchError('v3-activation-evidence-incomplete', {
      category: 'validation-failed',
    })
  assertValidation(run.validation)
  const records = []
  for await (const record of target.trace().records(run.runId)) records.push(record)
  const receipt = createActivationReceipt({
    version: 1,
    operationId: p.operationId,
    runId: run.runId,
    kind: p.kind,
    deployment: p.deployment,
    role: p.role,
    source: plan.payload.source,
    target: plan.payload.target,
    migrationPlanDigest: plan.digest,
    approvalRecordDigest: latestMigrationApproval(p.approvals ?? [], run.runId)!.digest,
    approvalDigest: plan.approvalDigest,
    conversionPlanDigest: run.conversionPlan.digest,
    bindingDigest: run.bindingDigest,
    summaryDigest: run.summaryDigest,
    validationDigest: run.validation.digest,
    receiptExportDigest: run.receiptExportDigest,
    backup,
    contentManifestDigest: p.frozen!.contentManifestDigest,
    writerDrain: records.filter((r) => r.kind === 'writer-drain').map((r) => r.payload),
    familyCutoverSource: records
      .filter((r) => r.kind === 'family-cutover-source')
      .map((r) => r.payload),
    lineage: records.filter((r) => r.kind === 'source-generation' || r.kind === 'source-journal'),
    identityHighWater: await target.trace().identityHighWater(run.runId),
    historyRestrictionsDigest: run.validation.historyRestrictionsDigest,
    operatorDecisions: plan.payload.operatorDecisions,
    acknowledgementsDigest: valueDigest(plan.payload.operatorDecisions),
    candidateBuild: session.deps.candidateBuild,
    previousPointer: {
      ...p.source.pointer,
      generationId: previousPointerIdentity(p.source.pointer.bytesBase64)?.generationId ?? null,
    },
    restoreFiles: plan.payload.restoreFiles,
    preparedAt: session.now(),
  })
  await session.write('activation-receipt.json', receipt)
  session.deps.faults?.('after-activation-receipt-file')
  return receipt
}

export async function runEpochSwitch(
  session: EpochSwitchSession,
  input: Parameters<EpochSwitchApplication['run']>[0],
): Promise<EpochSwitchStatusView> {
  const { deps } = session
  if (['completed', 'rolled-back', 'abandoned'].includes(session.journal.payload.status))
    throw new EpochSwitchError('v3-operation-terminal')
  if (input.newRun) {
    let next = newEpochRun(session.journal, session.now())
    if (
      (await session.artifact('activation-receipt.json')) ||
      (await session.artifact('rollback-retired.json'))
    )
      throw new EpochSwitchError('v3-new-run-after-activation-preparation')
    if (deps.nextTargetLocation)
      next = createEpochSwitchJournal({
        ...next.payload,
        target: {
          ...next.payload.target,
          location: await deps.nextTargetLocation(session.journal, next),
        },
      })
    if (
      session.journal.payload.target.generationId &&
      phaseIndex(session.journal.payload.phase) >= phaseIndex('converting')
    ) {
      const target = await openEpochTargetIfCreated(session)
      try {
        if (target && (await target.retireIfUnwritten()) === 'written')
          throw new EpochSwitchError('reverse-migration-required', {
            category: 'reverse-migration-required',
          })
      } finally {
        await target?.close()
      }
    }
    await session.replace(next)
    await planEpochOperation(session)
    return epochSwitchStatus(deps, session.journal)
  }
  if (phaseIndex(session.journal.payload.phase) >= phaseIndex('activated')) {
    const authority = await deps.activation.observe(input.operationId)
    if (
      epochDeploymentCapabilities(session.journal.payload.deployment).localPaths &&
      authority.pointsAt !== 'target'
    )
      throw new EpochSwitchError('v3-activation-unreconciled', {
        category: 'pointer-receipt-mismatch',
      })
    if (session.journal.payload.status === 'failed')
      await session.save({ status: 'running', failure: null })
    return epochSwitchStatus(deps, session.journal)
  }
  if (session.journal.payload.phase === 'discovered') await planEpochOperation(session)
  await approve(session, input.approve)
  if (session.journal.payload.phase === 'planned') {
    const source = await sourcePort(session).discover(sourceRequest(session))
    try {
      const p = session.journal.payload
      const manifest = await deps.content.capture({
        progress: deps.progress,
        source,
        root: epochContentRoot(session),
        destination: epochArtifactPath(
          deps.journal.operationRoot(p.operationId),
          runArtifact(session.journal, 'backup-content.json'),
        ),
      })
      const backup = await createBackup(session, source, manifest, 'live')
      await session.save({
        phase: 'backed-up',
        backup: {
          id: backup.id,
          digest: backup.digest,
          sourceWatermark: backup.sourceWatermark,
          path: backup.path,
        },
        status: 'running',
        failure: null,
      })
    } finally {
      await source.close()
    }
  }
  const quiesceName = runArtifact(session.journal, 'quiesce.json')
  const priorQuiesce = await session.artifact<QuiesceReceipt>(quiesceName)
  deps.progress?.({ phase: 'freeze', detail: 'quiesce writers', boundary: true })
  const quiesce = await deps.quiesce.quiesce({
    operationId: input.operationId,
    drainTimeoutMs: input.drainTimeoutMs ?? 30_000,
  })
  if (session.journal.payload.phase === 'backed-up') {
    if (!priorQuiesce) await session.write(quiesceName, quiesce)
    await session.save({ phase: 'quiescing' })
  }
  await deps.quiesce.assertHeld(input.operationId)
  if (
    session.journal.payload.phase === 'quiescing' &&
    !(await session.artifact(runArtifact(session.journal, 'frozen/preflight.json')))
  ) {
    const installation = await deps.installation()
    await session.save({
      source: {
        ...session.journal.payload.source,
        pointer: pointerEvidence(installation.pointerBytes),
      },
    })
  }
  const authority = await deps.activation.observe(input.operationId)
  if (authority.pointsAt === 'target' && session.journal.payload.phase === 'activation-prepared') {
    await session.save({
      phase: 'activated',
      activation: {
        ...session.journal.payload.activation!,
        pointerDigest: authority.pointerDigest,
        activatedAt: session.journal.payload.activation!.preparedAt,
      },
      status: 'running',
      failure: null,
    })
    return epochSwitchStatus(deps, session.journal)
  }
  let source: FrozenSourceHandle | undefined
  let target: TargetGenerationHandle | undefined
  try {
    if (phaseIndex(session.journal.payload.phase) <= phaseIndex('converting')) {
      const frozenName = runArtifact(session.journal, 'frozen/preflight.json')
      let evidence = await session.artifact<FrozenEvidence>(frozenName)
      const expected = evidence
        ? {
            watermark: evidence.watermark,
            preUpgradeWatermark: evidence.preUpgrade?.watermark ?? null,
            sourceGenerationId: evidence.preflight.sourceGenerationId,
          }
        : undefined
      source = await sourcePort(session).freeze({
        ...sourceRequest(session),
        ...(expected ? { expected } : {}),
      })
      if (
        evidence &&
        (source.watermark !== evidence.watermark ||
          source.preUpgrade?.preflight.watermark !== (evidence.preUpgrade?.watermark ?? undefined))
      )
        throw new EpochSwitchError('v3-source-changed', { category: 'source-changed' })
      if (!evidence) {
        evidence = {
          watermark: source.watermark,
          preflight: source.preflight,
          preUpgrade: source.preUpgrade?.preflight ?? null,
          planTime: session.now(),
        }
        await session.write(frozenName, evidence)
      }
      deps.faults?.('after-frozen-preflight')
      const manifestName = runArtifact(session.journal, 'frozen/content-manifest.json')
      let manifest = await session.artifact<FreezeContentManifest>(manifestName)
      if (!manifest) {
        manifest = await deps.content.capture({
          progress: deps.progress,
          source,
          root: epochContentRoot(session),
          destination: epochArtifactPath(
            deps.journal.operationRoot(input.operationId),
            runArtifact(session.journal, 'frozen/content-listing.json'),
          ),
        })
        await session.write(manifestName, manifest)
      }
      deps.faults?.('after-content-manifest')
      let backup = await readBackup(session)
      if (
        !backup ||
        !(await deps.backup.matches(backup, source.watermark)) ||
        backup.contentManifestDigest !== manifest.digest
      )
        backup = await createBackup(session, source, manifest, 'final')
      if (!(await deps.backup.matches(backup, source.watermark)))
        throw new EpochSwitchError('v3-final-backup-watermark-mismatch', {
          category: 'backup-failed',
        })
      if (session.journal.payload.phase === 'quiescing')
        await session.save({
          phase: 'frozen',
          source: {
            ...session.journal.payload.source,
            generationId: source.preflight.sourceGenerationId,
            fingerprintDigest: source.preflight.fingerprint.digest,
            sourceVersion: source.preflight.sourceVersion,
          },
          frozen: {
            watermark: source.watermark,
            preUpgradeWatermark: source.preUpgrade?.preflight.watermark ?? null,
            planTime: evidence.planTime,
            contentManifestDigest: manifest.digest,
            preflightPath: frozenName,
          },
          backup: {
            id: backup.id,
            digest: backup.digest,
            sourceWatermark: backup.sourceWatermark,
            path: backup.path,
          },
        })
      const inventory = await deps.content.open({
        source,
        manifest: epochContentManifest(session, manifest),
        root: epochContentRoot(session),
      })
      const bootFactsName = runArtifact(session.journal, 'frozen/boot-upgrade-facts.json')
      const priorBootFacts = await session.artifact<BootUpgradeFacts>(bootFactsName)
      const capturedBootFacts = await captureBootUpgradeFacts(
        session,
        source,
        inventory,
        manifest,
        priorBootFacts ? 'run' : 'freeze',
      )
      if (
        priorBootFacts &&
        (createBootUpgradeFacts(priorBootFacts.facts).environmentDigest !==
          priorBootFacts.environmentDigest ||
          priorBootFacts.environmentDigest !== capturedBootFacts.environmentDigest)
      )
        throw new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
          category: 'source-changed',
        })
      const bootUpgradeFacts = priorBootFacts ?? capturedBootFacts
      let observedBootFacts = capturedBootFacts
      const request = conversionRequest(
        session,
        source,
        inventory,
        manifest.digest,
        evidence.planTime,
        backup,
        bootUpgradeFacts,
      )
      let approvedPlan = await readEpochPlan(session)
      if (!priorBootFacts) {
        const rehearsal = (await deps.conversion.dryRun(request)).summary
        const frozenPlan = buildEpochPlan({
          journal: session.journal,
          source,
          manifest,
          summary: rehearsal,
          bootUpgradeFacts,
          targetPlanDigest: deps.targetPlanDigest(session.journal.payload.target.provider),
          backup,
          backupDestination: approvedPlan.payload.backup.destination,
          estimates: approvedPlan.payload.estimates,
          unfinishedTasks: await unfinishedTasks(source),
          restoreFiles: approvedPlan.payload.restoreFiles,
          now: evidence.planTime,
        })
        await persistEpochPlan(
          session,
          frozenPlan,
          session.journal.payload.phase === 'frozen' ? 'frozen' : 'converting',
          true,
        )
        if (session.journal.payload.status === 'awaiting-approval')
          return epochSwitchStatus(deps, session.journal)
        if (frozenPlan.payload.blocks.length)
          throw new EpochSwitchError('v3-conversion-blocked', { category: 'conversion-blocked' })
        await session.write(bootFactsName, bootUpgradeFacts)
        approvedPlan = frozenPlan
      }
      const assertBootEnvironment = async (): Promise<void> => {
        const current = await captureBootUpgradeFacts(session, source!, inventory, manifest!, 'run')
        if (current.environmentDigest !== bootUpgradeFacts.environmentDigest)
          throw new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
            category: 'source-changed',
          })
        observedBootFacts = current
      }
      // capturedBootFacts is the single post-freeze check before target creation.
      if (session.journal.payload.phase === 'frozen') await session.save({ phase: 'converting' })
      const p = session.journal.payload
      target =
        (await openEpochTargetIfCreated(session)) ??
        (await deps.target.create({
          generationId: p.target.generationId!,
          provider: p.target.provider,
          location: p.target.location!,
          operationId: p.operationId,
          runId: p.run!.runId,
          role: p.role,
          sourceGenerationId: source.preflight.sourceGenerationId,
          now: evidence.planTime,
          faults: deps.faults,
        }))
      await session.write(runArtifact(session.journal, 'target-installed.json'), {
        generationId: target.generationId,
      })
      deps.faults?.('after-target-install')
      const conversionPlan = deps.conversionPlan(request)
      const sink = target.openRun({
        version: 1,
        runId: p.run!.runId,
        operationId: p.operationId,
        ordinal: p.run!.ordinal,
        kind: p.kind,
        role: p.role,
        sourceProvider: p.source.provider,
        sourceEpoch: 1,
        sourceKind: source.preflight.kind,
        targetProvider: p.target.provider,
        targetEpoch: 2,
        migrationPlanDigest: approvedPlan.digest,
        approvalDigest: approvedPlan.approvalDigest,
        conversionPlan,
        emptyTables: p.inputs.emptyTables,
        startedAt: evidence.planTime,
      })
      let summary = await session.artifact<ConversionSummary>(
        runArtifact(session.journal, 'summary.json'),
      )
      if (!summary) {
        let loadedUnits = 0
        deps.progress?.({ phase: 'load', detail: 'start', boundary: true })
        summary = await deps.conversion.run(request, {
          async open(binding) {
            const result = await sink.open(binding)
            await mirrorApprovals(session, target!)
            deps.faults?.('after-run-open')
            return result
          },
          async commitUnit(output) {
            await sink.commitUnit(output)
            deps.progress?.({
              phase: 'load',
              detail: output.receipt.rule.id,
              completed: ++loadedUnits,
              unit: 'units',
            })
          },
          finish: (result) => sink.finish(result),
        })
        deps.progress?.({
          phase: 'load',
          detail: 'complete',
          completed: loadedUnits,
          unit: 'units',
          boundary: true,
        })
        await session.write(runArtifact(session.journal, 'summary.json'), summary)
      }
      deps.faults?.('after-finish')
      await assertBootEnvironment()
      if (
        summary.status === 'blocked' ||
        summary.blocks.length ||
        summary.plan.coverage !== 'complete'
      )
        throw new EpochSwitchError('v3-conversion-blocked', { category: 'conversion-blocked' })
      if ((await sink.loadBlocks()).length)
        throw new EpochSwitchError('v3-load-blocked', { category: 'load-blocked' })
      deps.progress?.({ phase: 'validation', detail: 'constraints and content', boundary: true })
      const finalized = await target.finalize({ runId: p.run!.runId })
      if (
        !finalized.deferredConstraintsApplied ||
        !finalized.catalogAdmitted ||
        !finalized.identityVerified ||
        finalized.violations.length
      )
        throw new EpochSwitchError('v3-finalize-failed', { category: 'validation-failed' })
      const storedValidation = (await target.trace().migrationRun(p.run!.runId))?.validation
      if (
        storedValidation?.passed &&
        (await inventory.verifyUnchanged(target.trace().artifacts({ runId: p.run!.runId }))).length
      )
        throw new EpochSwitchError('v3-content-drift', { category: 'content-drift' })
      const validation = storedValidation?.passed
        ? storedValidation
        : await target.validate({
            runId: p.run!.runId,
            preflight: source.preflight,
            preUpgrade: source.preUpgrade?.preflight ?? null,
            inventory,
            probes: deps.probes ?? [],
          })
      assertValidation(validation)
      deps.progress?.({ phase: 'validation', detail: 'complete', boundary: true })
      deps.faults?.('after-validation')
      const exported = await target.exportReceipts({
        runId: p.run!.runId,
        operationRoot: deps.journal.operationRoot(p.operationId),
      })
      const exportData = await target.trace().receiptExport(p.run!.runId)
      if (!exportData?.bytes)
        throw new EpochSwitchError('v3-receipt-export-bytes-required', {
          category: 'receipt-conflict',
        })
      await deps.journal.writeOnce(
        p.operationId,
        runArtifact(session.journal, 'receipt-export.json'),
        exportData.bytes,
      )
      deps.faults?.('after-receipt-export')
      const run = await target.trace().migrationRun(p.run!.runId)
      if (!run) throw new EpochSwitchError('v3-run-missing')
      await session.save({
        run: {
          ...p.run!,
          bindingDigest: run.bindingDigest,
          summaryDigest: run.summaryDigest,
          validationDigest: validation.digest,
          receiptExportDigest: exported.digest,
        },
      })
      const actual = buildEpochPlan({
        journal: session.journal,
        source,
        manifest,
        summary,
        bootUpgradeFacts: observedBootFacts,
        targetPlanDigest: deps.targetPlanDigest(p.target.provider),
        backup,
        backupDestination: approvedPlan.payload.backup.destination,
        estimates: approvedPlan.payload.estimates,
        unfinishedTasks: await unfinishedTasks(source),
        restoreFiles: approvedPlan.payload.restoreFiles,
        validation,
        now: evidence.planTime,
      })
      await persistEpochPlan(session, actual, 'validated', true)
      if (session.journal.payload.status === 'awaiting-approval')
        return epochSwitchStatus(deps, session.journal)
    }
    const p = session.journal.payload
    target ??= await deps.target.open({
      generationId: p.target.generationId!,
      provider: p.target.provider,
      location: p.target.location!,
      faults: deps.faults,
    })
    if (!source) {
      source = await sourcePort(session).freeze({
        ...sourceRequest(session),
        expected: {
          watermark: p.frozen!.watermark,
          preUpgradeWatermark: p.frozen!.preUpgradeWatermark,
          sourceGenerationId: p.source.generationId!,
        },
      })
      const manifest = await session.artifact<FreezeContentManifest>(
        runArtifact(session.journal, 'frozen/content-manifest.json'),
      )
      if (!manifest) throw new EpochSwitchError('v3-content-manifest-missing')
      const inventory = await deps.content.open({
        source,
        root: epochContentRoot(session),
        manifest: epochContentManifest(session, manifest),
      })
      const accepted = await session.artifact<BootUpgradeFacts>(
        runArtifact(session.journal, 'frozen/boot-upgrade-facts.json'),
      )
      const current = await captureBootUpgradeFacts(session, source, inventory, manifest, 'run')
      if (!accepted || accepted.environmentDigest !== current.environmentDigest)
        throw new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
          category: 'source-changed',
        })
      if (p.phase === 'validated') {
        const plan = await readEpochPlan(session)
        if (plan.payload.bootUpgradeFactsDigest !== valueDigest(current))
          await persistEpochPlan(
            session,
            createMigrationPlanDocument({
              ...plan.payload,
              bootUpgradeFactsDigest: valueDigest(current),
            }),
            'validated',
            true,
          )
      }
      if (
        (await inventory.verifyUnchanged(target.trace().artifacts({ runId: p.run!.runId }))).length
      )
        throw new EpochSwitchError('v3-content-drift', { category: 'content-drift' })
    }
    assertApproved(session.journal)
    await mirrorApprovals(session, target)
    deps.progress?.({ phase: 'activation', detail: 'prepare', boundary: true })
    const receipt = await prepareActivation(session, target)
    if (session.journal.payload.phase === 'validated') {
      await target.prepareActivation(
        receipt,
        receipt.payload.previousPointer.bytesBase64 === null
          ? null
          : Buffer.from(receipt.payload.previousPointer.bytesBase64, 'base64'),
      )
      const health = await target.healthCheck(deps.probes ?? [])
      if (!health.passed || !health.catalogAdmitted || health.probes.some((p) => !p.passed))
        throw new EpochSwitchError('v3-health-failed', { category: 'health-failed' })
      deps.faults?.('after-health-check')
      await session.save({
        phase: 'activation-prepared',
        activation: {
          receiptDigest: receipt.digest,
          receiptPath: 'activation-receipt.json',
          pointerDigest: null,
          preparedAt: receipt.payload.preparedAt,
          activatedAt: null,
        },
      })
    }
    await source?.close()
    source = undefined
    const health = await target.healthCheck(deps.probes ?? [])
    if (!health.passed || !health.catalogAdmitted || health.probes.some((p) => !p.passed))
      throw new EpochSwitchError('v3-health-failed', { category: 'health-failed' })
    await deps.quiesce.assertHeld(input.operationId)
    if (receipt.payload.restoreFiles.length) {
      if (!deps.restoreFiles) throw new EpochSwitchError('v3-restore-files-adapter-required')
      await deps.restoreFiles.apply(receipt.payload.restoreFiles)
    }
    const observed = await deps.activation.observe(input.operationId)
    if (observed.pointsAt === 'other')
      throw new EpochSwitchError('v3-pointer-receipt-mismatch', {
        category: 'pointer-receipt-mismatch',
      })
    const activated =
      observed.pointsAt === 'target'
        ? observed
        : await deps.activation.activate({
            journal: session.journal,
            receiptDigest: receipt.digest,
            pointer: epochDeploymentCapabilities(p.deployment).externalSwitch
              ? null
              : activationPointer(receipt),
          })
    await session.save({
      phase: 'activated',
      status: 'running',
      failure: null,
      activation: {
        ...session.journal.payload.activation!,
        pointerDigest: activated.pointerDigest,
        activatedAt: receipt.payload.preparedAt,
      },
    })
    deps.progress?.({ phase: 'activation', detail: 'activated', boundary: true })
    deps.faults?.('after-activated-journal')
    return epochSwitchStatus(deps, session.journal)
  } finally {
    try {
      await source?.close()
    } finally {
      await target?.close()
    }
  }
}
