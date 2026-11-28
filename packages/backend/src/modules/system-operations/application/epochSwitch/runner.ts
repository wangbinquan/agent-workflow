import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  createBootUpgradeFacts,
  type BootUpgradeFacts,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import type { PreparedConversion } from '@/platform/persistence/migration/conversion/engine'
import type { ConversionPlanSection } from '@/platform/persistence/migration/conversion/plan'
import {
  RESOLUTION_LIST_LIMIT,
  type ConversionSummary,
} from '@/platform/persistence/migration/conversion/sink'
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
  type MigrationPlanDocument,
} from '../../domain/epochSwitch/documents'
import { EpochSwitchError, createEpochSwitchJournal } from '../../domain/epochSwitch/model'
import { assertApproved, newEpochRun, phaseIndex } from '../../domain/epochSwitch/transitions'
import { buildEpochPlan } from '../../domain/epochSwitch/planDocument'
import { CONVERSION_MATERIAL_CHANGED, type PlanPin } from '../../domain/epochSwitch/planPin'
import { mergePlanResolutions } from '../../domain/epochSwitch/resolutions'
import {
  readEpochPlan,
  runArtifact,
  sourcePort,
  sourceRequest,
  openEpochTargetIfCreated,
  pointerEvidence,
  epochContentRoot,
  epochContentManifest,
  currentPinnedMaterial,
  directRunMismatch,
  planPinName,
  readPinnedPlan,
  readPlanPin,
  type EpochSwitchSession,
} from './session'
import {
  automaticTaskCensus,
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
    // RFC-626: the backup of a direct run carries what the old database can hold, as its
    // source access does; whether a row can be converted is the conversion's decision.
    ...(session.deps.direct ? { resolution: 'automatic' as const } : {}),
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

function materialChanged(differences: readonly string[]): EpochSwitchError {
  return new EpochSwitchError(CONVERSION_MATERIAL_CHANGED, {
    category: 'source-changed',
    message: `${CONVERSION_MATERIAL_CHANGED}: ${differences.join(', ')}`,
  })
}

/**
 * RFC-626 §4.2: the second comparison with the binary that began the run. The first one reads
 * the pin before anything is opened; here the source is open, so the rule set — which depends
 * on the source's catalog and the boot facts — is compared as well, against the plan the run
 * registered in the new database. A difference is a reason to start a new run. A run that
 * does not bind for another reason (same converter, other data or plan) stays what it was:
 * an internal error of the sink.
 */
function assertRegisteredMaterial(
  registered: ConversionPlanSection,
  current: ConversionPlanSection,
): void {
  const differences = (
    ['candidateBuild', 'converterVersion', 'ruleSetDigest', 'targetContractDigest'] as const
  ).filter((name) => registered[name] !== current[name])
  if (differences.length) throw materialChanged(differences)
}

/**
 * RFC-626 §4.2: the first act of a direct run's execution step. Only an approved plan without
 * blocks reaches this point (`approve` precedes it), so a plan refused for a condition of the
 * target is never pinned and is made again once the condition is repaired.
 */
async function pinEpochPlan(session: EpochSwitchSession): Promise<void> {
  const p = session.journal.payload
  if (phaseIndex(p.phase) > phaseIndex('planned')) return
  if ((await readPlanPin(session.deps, session.journal)) !== null) return
  const plan = await readEpochPlan(session)
  const pin: PlanPin = {
    version: 1,
    runId: p.run!.runId,
    planDigest: plan.digest,
    approvalDigest: plan.approvalDigest,
    ...currentPinnedMaterial(session.deps, session.journal),
  }
  await session.write(planPinName(session.journal), pin)
  await session.deps.autoUpgradeCheckpoint?.('plan-pinned')
}

/** The plan a pinned run executes, whatever the journal names as its current plan. */
async function pinnedEpochPlan(session: EpochSwitchSession): Promise<MigrationPlanDocument> {
  const pin = await readPlanPin(session.deps, session.journal)
  if (pin === null || pin === 'unreadable') throw materialChanged(['plan-not-pinned'])
  try {
    return await readPinnedPlan(session.deps, session.journal, pin)
  } catch (error) {
    if (error instanceof EpochSwitchError) throw error
    // The plan document no longer parses: its strict form changed with the binary.
    throw materialChanged(['plan-document'])
  }
}

/**
 * RFC-626 §4.2: give up the new database of a run whose binary changed. The ordinary way opens
 * the generation first, and opening requires the generation's contract and structure digests
 * to be the running binary's — exactly what differs here. Retiring by the identity the journal
 * stored touches migration metadata only and compares neither.
 */
async function retireStoredGeneration(session: EpochSwitchSession): Promise<void> {
  const p = session.journal.payload
  const installed = await session.artifact(runArtifact(session.journal, 'target-installed.json'))
  let outcome: Awaited<ReturnType<EpochSwitchSession['deps']['target']['retire']>>
  try {
    outcome = await session.deps.target.retire({
      generationId: p.target.generationId!,
      provider: p.target.provider,
      location: p.target.location!,
    })
  } catch (error) {
    // Without the installation marker nothing was built there that could be retired.
    if (installed) throw error
    return
  }
  if (outcome === 'written')
    throw new EpochSwitchError('reverse-migration-required', {
      category: 'reverse-migration-required',
    })
}

/**
 * RFC-626 §4.2 step 3: the inventory of a direct run is the one its plan step took; the plan
 * names the listing and its digest. The listing is the canonical text of the manifest, so its
 * bytes are published as the frozen manifest without serializing 168 MB once more, and in the
 * process that wrote it the manifest itself is handed over without parsing those bytes.
 *
 * The listing is the one file of the plan step that is written without being flushed. When it
 * cannot be read back (the machine lost power after the plan was saved) the inventory is taken
 * again and accepted only if it is the manifest the plan names; content that differs from the
 * pinned plan needs a new run.
 */
async function adoptPlannedManifest(
  session: EpochSwitchSession,
  plan: MigrationPlanDocument,
  source: FrozenSourceHandle,
  manifestName: string,
): Promise<FreezeContentManifest> {
  const { deps } = session
  const operationId = session.journal.payload.operationId
  const listing = plan.payload.contentManifestPath
  const bytes = listing ? await deps.journal.readArtifact(operationId, listing) : null
  if (listing && bytes) {
    // The plan step of this very process wrote the listing: what it listed is taken as it is.
    // Any other process (a restart after the plan was pinned) parses the file.
    let listed: FreezeContentManifest | null =
      deps.content.takeCaptured?.(
        epochArtifactPath(deps.journal.operationRoot(operationId), listing),
      ) ?? null
    if (!listed)
      try {
        listed = JSON.parse(Buffer.from(bytes).toString('utf8')) as FreezeContentManifest
      } catch {
        listed = null
      }
    if (listed?.digest === plan.payload.contentManifestDigest) {
      await deps.journal.writeOnce(operationId, manifestName, bytes)
      return listed
    }
  }
  const manifest = await deps.content.capture({
    progress: deps.progress,
    source,
    root: epochContentRoot(session),
    destination: epochArtifactPath(
      deps.journal.operationRoot(operationId),
      runArtifact(session.journal, 'frozen/content-listing.json'),
    ),
  })
  if (manifest.digest !== plan.payload.contentManifestDigest)
    throw new EpochSwitchError('v3-content-changed-since-plan-new-run-required', {
      category: 'source-changed',
    })
  await session.write(manifestName, manifest)
  return manifest
}

/**
 * RFC-626 §4.2: the execution step of a direct run, from its pinned plan to `validated`.
 *
 * Each step happens once. The frozen copy and the working copy are the plan step's, re-opened;
 * the inventory is the plan step's; there is one backup, taken from the frozen source; the boot
 * facts are compared once with the plan's; the conversion is prepared, the new database is
 * created and the run is registered with the prepared plan (which names the tasks the
 * conversion ends), and the conversion writes straight into it; the target is finalized once
 * and validated once with that result. The plan of the actual result is then approved by the
 * session's callback in this same call.
 *
 * Every step is guarded by what it left behind, so a process that died anywhere continues
 * here: the fixed artifacts are written once with the same bytes, the journal saves follow the
 * phase they find, and committed units are skipped by the sink.
 */
async function convertDirectly(
  session: EpochSwitchSession,
  quiesce: QuiesceReceipt,
  opened: {
    source(handle: FrozenSourceHandle): void
    target(handle: TargetGenerationHandle): void
  },
): Promise<'validated' | 'awaiting-approval'> {
  const { deps } = session
  const pinned = await pinnedEpochPlan(session)
  // The plan step is over: what it built to make the plan is not needed again.
  deps.reclaim?.()
  const frozenName = runArtifact(session.journal, 'frozen/preflight.json')
  let evidence = await session.artifact<FrozenEvidence>(frozenName)
  if (!evidence) {
    // The pointer the activation will replace, read once writers are known to be stopped.
    const pointer = pointerEvidence((await deps.installation()).pointerBytes)
    if (pointer.digest !== session.journal.payload.source.pointer.digest)
      await session.save({ source: { ...session.journal.payload.source, pointer } })
  }
  // The plan is pinned: an old database that is no longer the one the plan froze ends this
  // run. The identity comes from the frozen evidence once it exists, from the plan before.
  const expected = evidence
    ? {
        watermark: evidence.watermark,
        preUpgradeWatermark: evidence.preUpgrade?.watermark ?? null,
        sourceGenerationId: evidence.preflight.sourceGenerationId,
      }
    : {
        watermark: pinned.payload.source.watermark,
        preUpgradeWatermark: pinned.payload.source.preUpgradeWatermark,
        sourceGenerationId: pinned.payload.source.generationId,
      }
  // Re-opening reports nothing: the freeze of this upgrade was the plan step's.
  const source = await sourcePort(session).freeze({
    ...sourceRequest(session),
    progress: undefined,
    expected,
  })
  opened.source(source)
  if (
    source.watermark !== expected.watermark ||
    (source.preUpgrade?.preflight.watermark ?? null) !== expected.preUpgradeWatermark
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
  const manifest =
    (await session.artifact<FreezeContentManifest>(manifestName)) ??
    (await adoptPlannedManifest(session, pinned, source, manifestName))
  deps.faults?.('after-content-manifest')
  let backup = await readBackup(session)
  if (backup) {
    // A receipt read back is all a new process knows of the backup: verify it once.
    if (
      backup.contentManifestDigest !== manifest.digest ||
      !(await deps.backup.matches(backup, source.watermark))
    )
      throw new EpochSwitchError('v3-final-backup-watermark-mismatch', {
        category: 'backup-failed',
      })
  } else {
    // Just created from this frozen source: its receipt is the evidence, nothing is re-read.
    backup = await createBackup(session, source, manifest, 'final')
    if (backup.sourceWatermark !== source.watermark)
      throw new EpochSwitchError('v3-final-backup-watermark-mismatch', {
        category: 'backup-failed',
      })
  }
  // The phases of the manual flow, in its order; here nothing separates the three saves.
  if (session.journal.payload.phase === 'planned')
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
  if (session.journal.payload.phase === 'backed-up') {
    const quiesceName = runArtifact(session.journal, 'quiesce.json')
    if (!(await session.artifact(quiesceName))) await session.write(quiesceName, quiesce)
    await session.save({ phase: 'quiescing' })
  }
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
  // The backup is written; the conversion starts from what is still needed.
  deps.reclaim?.()
  const inventory = await deps.content.open({
    source,
    manifest: epochContentManifest(session, manifest),
    root: epochContentRoot(session),
    resolution: 'automatic',
  })
  // One comparison with the facts the plan was made for; no rehearsal and no second plan.
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
    (priorBootFacts &&
      createBootUpgradeFacts(priorBootFacts.facts).environmentDigest !==
        priorBootFacts.environmentDigest) ||
    capturedBootFacts.environmentDigest !==
      (priorBootFacts?.environmentDigest ?? pinned.payload.bootUpgradeEnvironmentDigest)
  )
    throw new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
      category: 'source-changed',
    })
  const bootUpgradeFacts = priorBootFacts ?? capturedBootFacts
  if (!priorBootFacts) await session.write(bootFactsName, bootUpgradeFacts)
  const request = conversionRequest(
    session,
    source,
    inventory,
    manifest.digest,
    evidence.planTime,
    backup,
    bootUpgradeFacts,
  )
  if (session.journal.payload.phase === 'frozen') await session.save({ phase: 'converting' })
  const p = session.journal.payload
  const runId = p.run!.runId
  const summaryName = runArtifact(session.journal, 'summary.json')
  let summary = await session.artifact<ConversionSummary>(summaryName)
  let prepared: PreparedConversion | undefined
  let target: TargetGenerationHandle
  let sink: ReturnType<TargetGenerationHandle['openRun']>
  try {
    if (!summary) {
      // Staging, lookups and — because the run has to be registered with the plan that names
      // them — the tasks this conversion ends, before a target exists.
      if (!deps.conversion.prepare)
        throw new EpochSwitchError('v3-direct-conversion-prepare-required')
      prepared = await deps.conversion.prepare(request)
      deps.progress?.({
        phase: 'conversion',
        detail: `${prepared.plan.settlements?.length ?? 0} unfinished task(s) ended by the upgrade`,
        boundary: true,
      })
    }
    const conversionPlan = summary?.plan ?? prepared!.plan
    target =
      (await openEpochTargetIfCreated(session)) ??
      (await deps.target.create({
        generationId: p.target.generationId!,
        provider: p.target.provider,
        location: p.target.location!,
        operationId: p.operationId,
        runId,
        role: p.role,
        sourceGenerationId: source.preflight.sourceGenerationId,
        now: evidence.planTime,
        faults: deps.faults,
      }))
    opened.target(target)
    await session.write(runArtifact(session.journal, 'target-installed.json'), {
      generationId: target.generationId,
    })
    deps.faults?.('after-target-install')
    const registered = await target.trace().migrationRun(runId)
    if (registered) assertRegisteredMaterial(registered.conversionPlan, conversionPlan)
    sink = target.openRun(
      {
        version: 1,
        runId,
        operationId: p.operationId,
        ordinal: p.run!.ordinal,
        kind: p.kind,
        role: p.role,
        sourceProvider: p.source.provider,
        sourceEpoch: 1,
        sourceKind: source.preflight.kind,
        targetProvider: p.target.provider,
        targetEpoch: 2,
        migrationPlanDigest: pinned.digest,
        approvalDigest: pinned.approvalDigest,
        conversionPlan,
        emptyTables: p.inputs.emptyTables,
        startedAt: evidence.planTime,
      },
      { resolution: 'automatic' },
    )
    if (!summary) {
      const runSink = sink
      const handle = target
      let loadedUnits = 0
      deps.progress?.({ phase: 'load', detail: 'start', boundary: true })
      summary = await prepared!.run({
        async open(binding) {
          const result = await runSink.open(binding)
          await mirrorApprovals(session, handle)
          deps.faults?.('after-run-open')
          return result
        },
        async commitUnit(output) {
          // Rows the target refused go back to the engine, which sets their source rows aside.
          const refused = await runSink.commitUnit(output)
          if (refused) return refused
          deps.progress?.({
            phase: 'load',
            detail: output.receipt.rule.id,
            completed: ++loadedUnits,
            unit: 'units',
          })
        },
        finish: (result) => runSink.finish(result),
      })
      deps.progress?.({
        phase: 'conversion',
        detail:
          `${summary.resolutions?.setAside.total ?? 0} row(s) set aside, ` +
          `${summary.resolutions?.missingContent.total ?? 0} content reference(s) recorded as missing`,
        boundary: true,
      })
      deps.progress?.({
        phase: 'load',
        detail: 'complete',
        completed: loadedUnits,
        unit: 'units',
        boundary: true,
      })
      await session.write(summaryName, summary)
    }
  } finally {
    prepared?.close()
  }
  deps.faults?.('after-finish')
  await deps.autoUpgradeCheckpoint?.('conversion-finished')
  // A block that survived automatic resolution is one the converter has no answer for.
  if (summary.status === 'blocked' || summary.blocks.length || summary.plan.coverage !== 'complete')
    throw new EpochSwitchError('v3-conversion-blocked', { category: 'conversion-blocked' })
  if ((await sink.loadBlocks()).length)
    throw new EpochSwitchError('v3-load-blocked', { category: 'load-blocked' })
  // The conversion is over and its staging store closed; finalizing and validating read the
  // new database and every content reference once more.
  deps.reclaim?.()
  deps.progress?.({ phase: 'validation', detail: 'constraints and content', boundary: true })
  const finalized = await target.finalize({
    runId,
    dangling: { policies: deps.conversion.references ?? [] },
  })
  if (
    !finalized.deferredConstraintsApplied ||
    !finalized.catalogAdmitted ||
    !finalized.identityVerified ||
    finalized.violations.length
  )
    throw new EpochSwitchError('v3-finalize-failed', { category: 'validation-failed' })
  const storedValidation = (await target.trace().migrationRun(runId))?.validation
  if (
    storedValidation?.passed &&
    (await inventory.verifyUnchanged(target.trace().artifacts({ runId }))).length
  )
    throw new EpochSwitchError('v3-content-drift', { category: 'content-drift' })
  const validation = storedValidation?.passed
    ? storedValidation
    : await target.validate({
        runId,
        preflight: source.preflight,
        preUpgrade: source.preUpgrade?.preflight ?? null,
        inventory,
        probes: deps.probes ?? [],
        // The finalize that just ran; validating does not finalize the target a second time.
        finalized,
      })
  assertValidation(validation)
  deps.progress?.({ phase: 'validation', detail: 'complete', boundary: true })
  deps.faults?.('after-validation')
  const exported = await target.exportReceipts({
    runId,
    operationRoot: deps.journal.operationRoot(p.operationId),
  })
  const exportData = await target.trace().receiptExport(runId)
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
  const run = await target.trace().migrationRun(runId)
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
  // The plan of what actually happened: the conversion's decisions (final with its summary)
  // joined with what finalizing did, and the tasks as they are after the ones that were ended.
  const census = await automaticTaskCensus(
    source,
    new Set((summary.plan.settlements ?? []).map((task) => task.taskId)),
  )
  const actual = buildEpochPlan({
    journal: session.journal,
    source,
    manifest,
    summary,
    bootUpgradeFacts: capturedBootFacts,
    targetPlanDigest: deps.targetPlanDigest(p.target.provider),
    backup,
    backupDestination: pinned.payload.backup.destination,
    estimates: pinned.payload.estimates,
    unfinishedTasks: census.unfinished,
    restoreFiles: pinned.payload.restoreFiles,
    validation,
    resolutions: mergePlanResolutions({
      conversion: summary.resolutions,
      finalize: finalized.dispositions ?? [],
      taskNames: census.names,
      listLimit: RESOLUTION_LIST_LIMIT,
      recordsTable: metaTableName(p.target.provider, 'migration_records'),
    }),
    now: evidence.planTime,
  })
  await persistEpochPlan(session, actual, 'validated', true)
  if (session.journal.payload.status === 'awaiting-approval') {
    // Approved where it stands: the source is open, the boot facts are captured and the
    // content was just verified. Returning would repeat all three on the way back in.
    const digest = await deps.approveActualPlan?.({ runId, plan: actual })
    if (!digest) return 'awaiting-approval'
    await approve(session, digest)
  }
  return 'validated'
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
    // RFC-626 §4.2: a run given up while a binary other than the one that began it runs is
    // retired by its stored identity; this binary's contract may not be the one its new
    // database was built with. Whatever failure gave the run up — the binary change itself,
    // or one found before the binary was replaced (a source change during the conversion) —
    // the pin is compared before the next run is allocated (implementation gate G4-4).
    const binaryChanged =
      deps.direct === true &&
      (session.journal.payload.failure?.detailCode === CONVERSION_MATERIAL_CHANGED ||
        (await directRunMismatch(deps, session.journal)).length > 0)
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
      const target = binaryChanged ? null : await openEpochTargetIfCreated(session)
      try {
        if (binaryChanged) await retireStoredGeneration(session)
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
  // RFC-626 §4.2: before the plan document is parsed and before the new database is opened —
  // either may already fail for a binary other than the one that began this run, and neither
  // failure would start a new run. The automatic session makes this very call to record the
  // difference in the journal before it provisions or opens anything.
  if (deps.direct) {
    const differences = await directRunMismatch(deps, session.journal)
    if (differences.length) throw materialChanged(differences)
  }
  if (session.journal.payload.phase === 'discovered') await planEpochOperation(session)
  await approve(session, input.approve)
  // RFC-626 §4.2: from here on the run writes artifacts that are written once.
  if (deps.direct) await pinEpochPlan(session)
  // A direct run has no backup of the running database: there is no running database.
  if (!deps.direct && session.journal.payload.phase === 'planned') {
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
  // RFC-626 §4.8: the automatic session stopped the daemon before it began; a direct run
  // reports each phase once, and its freeze was reported by the plan step.
  if (!deps.direct) deps.progress?.({ phase: 'freeze', detail: 'quiesce writers', boundary: true })
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
    if (deps.direct && phaseIndex(session.journal.payload.phase) <= phaseIndex('converting')) {
      // RFC-626 §4.2: one pass instead of the staged flow below. The handles are handed out
      // as they are opened so that the `finally` of this function closes them on any exit.
      const outcome = await convertDirectly(session, quiesce, {
        source(handle) {
          source = handle
        },
        target(handle) {
          target = handle
        },
      })
      if (outcome === 'awaiting-approval') return epochSwitchStatus(deps, session.journal)
    } else if (phaseIndex(session.journal.payload.phase) <= phaseIndex('converting')) {
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
      await deps.autoUpgradeCheckpoint?.('conversion-finished')
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
        ...(deps.direct ? { resolution: 'automatic' as const } : {}),
      })
      const accepted = await session.artifact<BootUpgradeFacts>(
        runArtifact(session.journal, 'frozen/boot-upgrade-facts.json'),
      )
      const current = await captureBootUpgradeFacts(session, source, inventory, manifest, 'run')
      if (!accepted || accepted.environmentDigest !== current.environmentDigest)
        throw new EpochSwitchError('v3-boot-environment-changed-new-run-required', {
          category: 'source-changed',
        })
      // RFC-626 §4.2: the comparison with the binary that converted, now with the rule set,
      // has to precede the activation receipt. The receipt is written from this binary's build
      // and published before the target checks it against the registered run; a receipt that
      // fails that check can no longer be replaced by a new run, and the session would stop
      // at the same place on every start. With a published receipt the steps left read it back.
      if (
        deps.direct &&
        !(await deps.journal.readArtifact(p.operationId, 'activation-receipt.json'))
      ) {
        const registered = await target.trace().migrationRun(p.run!.runId)
        if (registered)
          assertRegisteredMaterial(
            registered.conversionPlan,
            deps.conversionPlan(
              conversionRequest(
                session,
                source,
                inventory,
                manifest.digest,
                p.frozen!.planTime,
                await readBackup(session),
                accepted,
              ),
            ),
          )
      }
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
