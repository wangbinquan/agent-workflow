import { createSwitchReceipt, parseSwitchReceipt } from '../../domain/epochSwitch/documents'
import { EpochSwitchError } from '../../domain/epochSwitch/model'
import type { EpochSwitchSession } from './session'
import { epochSwitchStatus } from './status'

export async function verifyEpochSwitch(session: EpochSwitchSession) {
  const p = session.journal.payload
  if (
    !['activated', 'verified', 'completed'].includes(p.phase) ||
    ['rolled-back', 'abandoned'].includes(p.status)
  )
    throw new EpochSwitchError('v3-verify-requires-activation')
  if (p.phase === 'completed') return epochSwitchStatus(session.deps, session.journal)
  const observation = await session.deps.activation.observe(p.operationId)
  if (observation.pointsAt !== 'target')
    throw new EpochSwitchError('v3-verify-requires-target-authority', {
      category: 'activation-failed',
    })
  const target = await session.deps.target.open({
    provider: p.target.provider,
    generationId: p.target.generationId!,
    location: p.target.location!,
    faults: session.deps.faults,
  })
  try {
    const firstLiveWriteAt = await target.firstLiveWriteAt()
    const bytes = await session.deps.journal.readArtifact(p.operationId, 'switch-receipt.json')
    let receipt = bytes ? parseSwitchReceipt(Buffer.from(bytes).toString('utf8')) : null
    if (!receipt) {
      const health = await target.healthCheck(
        session.deps.acceptanceProbes ?? session.deps.probes ?? [],
      )
      const name = `acceptance-health-${session.journal.payload.revision}.json`
      const artifacts = session.artifacts()
      if (artifacts) {
        const digest = await artifacts.put(name, Buffer.from(JSON.stringify(health)))
        await artifacts.get(name, digest)
      } else await session.write(name, health)
      if (!health.passed || !health.catalogAdmitted || health.probes.some((p) => !p.passed))
        throw new EpochSwitchError('v3-acceptance-failed', { category: 'health-failed' })
      receipt = createSwitchReceipt({
        version: 1,
        kind: 'verified',
        operationId: p.operationId,
        runId: p.run!.runId,
        generationId: p.target.generationId!,
        activationReceiptDigest: p.activation!.receiptDigest,
        pointerDigest: observation.pointerDigest,
        firstLiveWriteAt,
        health,
        retained: [],
        recordedAt: session.now(),
      })
      await session.write('switch-receipt.json', receipt)
    }
    await target.writeSwitchReceipt(receipt)
    session.deps.faults?.('after-switch-receipt')
    await session.save({ phase: 'verified', status: 'running', failure: null, firstLiveWriteAt })
  } finally {
    await target.close()
  }
  return epochSwitchStatus(session.deps, session.journal)
}

export async function completeEpochSwitch(session: EpochSwitchSession) {
  const p = session.journal.payload
  if (p.phase === 'completed') return epochSwitchStatus(session.deps, session.journal)
  if (p.phase !== 'verified' || ['rolled-back', 'abandoned'].includes(p.status))
    throw new EpochSwitchError('v3-completion-requires-verified')
  const observed = await session.deps.activation.observe(p.operationId)
  if (observed.pointsAt !== 'target')
    throw new EpochSwitchError('v3-completion-requires-target-authority')
  const verifiedBytes = await session.deps.journal.readArtifact(
    p.operationId,
    'switch-receipt.json',
  )
  if (!verifiedBytes) throw new EpochSwitchError('v3-verification-receipt-missing')
  const verified = parseSwitchReceipt(Buffer.from(verifiedBytes).toString('utf8'))
  const target = await session.deps.target.open({
    generationId: p.target.generationId!,
    provider: p.target.provider,
    location: p.target.location!,
    faults: session.deps.faults,
  })
  try {
    const bytes = await session.deps.journal.readArtifact(p.operationId, 'completion-receipt.json')
    let receipt = bytes ? parseSwitchReceipt(Buffer.from(bytes).toString('utf8')) : null
    if (!receipt) {
      if (!(await session.artifact('completion-started.json')))
        await session.write('completion-started.json', {
          operationId: p.operationId,
          runId: p.run!.runId,
          generationId: p.target.generationId,
          startedAt: session.now(),
        })
      const retained = await session.deps.retention.retain({
        operationId: p.operationId,
        source: p.source.location,
      })
      receipt = createSwitchReceipt({
        ...verified.payload,
        kind: 'completed',
        firstLiveWriteAt: await target.firstLiveWriteAt(),
        retained,
        recordedAt: session.now(),
      })
      await session.write('completion-receipt.json', receipt)
    }
    await target.writeSwitchReceipt(receipt)
    await session.save({
      phase: 'completed',
      status: 'completed',
      firstLiveWriteAt: receipt.payload.firstLiveWriteAt,
      completion: { at: receipt.payload.recordedAt, retained: receipt.payload.retained },
      failure: null,
    })
  } finally {
    await target.close()
  }
  return epochSwitchStatus(session.deps, session.journal)
}
