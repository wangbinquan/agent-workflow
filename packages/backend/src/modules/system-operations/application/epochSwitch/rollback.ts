import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type { TargetGenerationHandle } from '../ports/epochSwitch'
import {
  createRollbackReceipt,
  parseActivationReceipt,
  parseRollbackReceipt,
} from '../../domain/epochSwitch/documents'
import { EpochSwitchError } from '../../domain/epochSwitch/model'
import { rollbackEligibility } from '../../domain/epochSwitch/transitions'
import { phaseIndex } from '../../domain/epochSwitch/transitions'
import { runArtifact, openEpochTargetIfCreated, type EpochSwitchSession } from './session'
import { epochSwitchStatus } from './status'

export async function rollbackEpochSwitch(session: EpochSwitchSession) {
  const p = session.journal.payload
  if (p.status === 'rolled-back') return epochSwitchStatus(session.deps, session.journal)
  const completionStarted = await session.artifact('completion-started.json')
  const eligibility = rollbackEligibility(session.journal)
  if (!eligibility.allowed || completionStarted)
    throw new EpochSwitchError('reverse-migration-required', {
      category: 'reverse-migration-required',
    })
  const activationBytes = await session.deps.journal.readArtifact(
    p.operationId,
    'activation-receipt.json',
  )
  const activation = activationBytes
    ? parseActivationReceipt(Buffer.from(activationBytes).toString('utf8'))
    : null
  let installed = false
  let activationReceiptDigest: string | null = null
  let target: TargetGenerationHandle | undefined
  try {
    if (phaseIndex(p.phase) >= phaseIndex('converting'))
      target = (await openEpochTargetIfCreated(session)) ?? undefined
    installed = target !== undefined
    if (target) {
      const firstLiveWriteAt = await target.firstLiveWriteAt()
      if (firstLiveWriteAt !== null) {
        throw new EpochSwitchError('reverse-migration-required', {
          category: 'reverse-migration-required',
        })
      }
      if (!session.deps.targetEvidence) throw new EpochSwitchError('v3-target-evidence-required')
      const evidence = await session.deps.targetEvidence(p.target.generationId!, p.target.location!)
      if (!evidence) throw new EpochSwitchError('v3-target-evidence-missing')
      activationReceiptDigest = evidence.activationReceiptDigest
    }
    if (phaseIndex(p.phase) >= phaseIndex('quiescing')) {
      await session.deps.quiesce.quiesce({ operationId: p.operationId, drainTimeoutMs: 30_000 })
      await session.deps.quiesce.assertHeld(p.operationId)
    }
    if (target) {
      await session.write(runArtifact(session.journal, 'target-installed.json'), {
        generationId: target.generationId,
      })
      if ((await target.retireIfUnwritten()) === 'written')
        throw new EpochSwitchError('reverse-migration-required', {
          category: 'reverse-migration-required',
        })
      await session.write('rollback-retired.json', {
        generationId: p.target.generationId,
        runId: p.run!.runId,
      })
      session.deps.faults?.('after-retire')
    }
    const observed = await session.deps.activation.observe(p.operationId)
    if (observed.pointsAt === 'other')
      throw new EpochSwitchError('v3-rollback-pointer-changed', { category: 'rollback-incomplete' })
    if (activation?.payload.restoreFiles.length) {
      if (!session.deps.restoreFiles)
        throw new EpochSwitchError('v3-restore-files-adapter-required')
      await session.deps.restoreFiles.rollback(activation.payload.restoreFiles)
    }
    if (observed.pointsAt === 'target') {
      if (!activation)
        throw new EpochSwitchError('v3-rollback-activation-receipt-missing', {
          category: 'rollback-incomplete',
        })
      await target?.close()
      target = undefined
      await session.deps.activation.restorePrevious({
        previousBytes:
          activation.payload.previousPointer.bytesBase64 === null
            ? null
            : Buffer.from(activation.payload.previousPointer.bytesBase64, 'base64'),
        firstLiveWriteAt: null,
      })
    }
    const previous = activation?.payload.previousPointer ?? p.source.pointer
    const bytes = await session.deps.journal.readArtifact(p.operationId, 'rollback-receipt.json')
    const receipt = bytes
      ? parseRollbackReceipt(Buffer.from(bytes).toString('utf8'))
      : createRollbackReceipt({
          version: 1,
          kind: 'rolled-back',
          operationId: p.operationId,
          runId: p.run?.runId ?? null,
          generationId: installed ? p.target.generationId : null,
          activationReceiptDigest,
          previousPointerDigest: previous.digest,
          restoredPointerDigest: previous.digest,
          firstLiveWriteAt: null,
          targetState: installed ? 'retired' : 'not-created',
          restoredFiles: activation?.payload.restoreFiles ?? [],
          recordedAt: session.now(),
        })
    await session.write('rollback-receipt.json', receipt)
    session.deps.faults?.('after-rollback-file')
    if (installed) {
      target ??= await session.deps.target.open({
        provider: p.target.provider,
        generationId: p.target.generationId!,
        location: p.target.location!,
        faults: session.deps.faults,
      })
      await target.writeSwitchReceipt(receipt)
    }
    await session.save({
      status: 'rolled-back',
      rollback: { at: receipt.payload.recordedAt, receiptDigest: receipt.digest },
      failure: null,
    })
  } finally {
    await target?.close()
  }
  return epochSwitchStatus(session.deps, session.journal)
}

export async function discardEpochSwitch(session: EpochSwitchSession, confirm: true) {
  if (confirm !== true) throw new EpochSwitchError('v3-discard-confirm-required')
  if (session.journal.payload.status === 'abandoned')
    return epochSwitchStatus(session.deps, session.journal)
  if (session.journal.payload.status !== 'rolled-back') await rollbackEpochSwitch(session)
  const p = session.journal.payload
  if (p.run && (await session.artifact(runArtifact(session.journal, 'target-installed.json'))))
    await session.deps.target.discard({
      generationId: p.target.generationId!,
      location: p.target.location!,
      destination: epochArtifactPath(
        session.deps.journal.operationRoot(p.operationId),
        `discarded/${p.target.generationId}`,
      ),
    })
  await session.save({ status: 'abandoned' })
  return epochSwitchStatus(session.deps, session.journal)
}
