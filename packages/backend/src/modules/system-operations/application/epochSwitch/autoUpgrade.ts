import { persistenceDialect } from '@/platform/persistence/nativeDialect'
import type { EpochSwitchApplication } from '../../public/commands'
import type { EpochSwitchPlanInput, EpochSwitchStatusView } from '../../public/types'
import type {
  AutoUpgradeRecordPort,
  LegacyMigrationFinalizePort,
  EpochTargetProvisioningPort,
  SessionLockPort,
} from '../ports/epochSwitch'
import { classifyEpochInstallation } from '../../domain/epochSwitch/classification'
import {
  autoUpgradeTrigger,
  autoUpgradeRollbackCommitment,
  classifyAutoUpgradeRun,
  evaluateAutoUpgradePlan,
  AUTO_UPGRADE_RETRY_GUIDANCE,
  type AutoUpgradeConclusion,
  type AutoUpgradeSession,
} from '../../domain/epochSwitch/autoUpgrade'
import {
  parseMigrationPlanDocument,
  type MigrationPlanDocument,
} from '../../domain/epochSwitch/documents'
import { epochRunIdentity, phaseIndex } from '../../domain/epochSwitch/transitions'
import type { EpochSwitchJournal } from '../../domain/epochSwitch/model'
import type { EpochSwitchDependencies } from './session'

export interface AutoUpgradeDependencies {
  readonly epoch: EpochSwitchDependencies
  readonly application: EpochSwitchApplication
  readonly records: AutoUpgradeRecordPort
  readonly lock: SessionLockPort
  readonly legacy: LegacyMigrationFinalizePort
  readonly provisioning?: EpochTargetProvisioningPort
  readonly enabled: boolean
  readonly standalone: boolean
  readonly log?: (line: string, warning?: boolean) => void
}

/** RFC-398 §2.4 A–H. All phase authority comes from the existing epoch-switch journal. */
export async function autoUpgrade(
  deps: AutoUpgradeDependencies,
  input: { retry?: boolean } = {},
): Promise<AutoUpgradeConclusion> {
  const { epoch, application: app, records, lock } = deps
  let operationId: string | null = null
  const checkpoint = async (name: string) => {
    await epoch.autoUpgradeCheckpoint?.(name)
  }
  const conclusion = (
    outcome: AutoUpgradeConclusion['outcome'],
    guidance: readonly string[],
    receipt?: Readonly<Record<string, unknown>>,
  ): AutoUpgradeConclusion => ({
    mode: 'auto',
    outcome,
    exitCode: outcome === 'done' || outcome === 'noop' ? 0 : outcome === 'error' ? 1 : 3,
    operationId,
    guidance,
    ...(receipt ? { receipt } : {}),
  })
  const append = (
    kind: Parameters<AutoUpgradeRecordPort['append']>[1],
    data: Readonly<Record<string, unknown>>,
  ) => records.append(operationId!, kind, data)
  const session = async (): Promise<AutoUpgradeSession> =>
    (await records.list()).find((s) => s.operationId === operationId)!
  const refuse = async (reason: string, detail: unknown, guidance: readonly string[]) => {
    await append('refused', { reason, detail, guidance })
    await checkpoint('refused')
    return conclusion('refused', guidance)
  }
  const rollback = async (reason: string, detail: unknown) => {
    if (!(await session()).verificationFailed) await append('verify-failed', { reason, detail })
    await checkpoint('verify-failed')
    await lock.assertHeld()
    await app.rollback({ operationId: operationId! })
    if (!(await session()).records.some((r) => r.kind === 'rolled-back'))
      await append('rolled-back', { reason: 'verification-failed' })
    await append('failed', { reason: 'verification-failed', guidance: AUTO_UPGRADE_RETRY_GUIDANCE })
    return conclusion('failed', [AUTO_UPGRADE_RETRY_GUIDANCE, JSON.stringify(detail)])
  }
  await lock.acquire()
  try {
    // A. Lock precedes inspection; intent precedes finalize, allocation and discovery.
    const sessions = await records.list()
    const installation = await epoch.installation()
    const facts = { ...installation.facts, autoUpgradeSessions: sessions }
    const trigger = autoUpgradeTrigger({
      facts,
      installation: classifyEpochInstallation(facts),
      standalone: deps.standalone,
      enabled: deps.enabled,
      retry: input.retry,
    })
    if (trigger.kind === 'noop') return conclusion('noop', [trigger.reason])
    if (trigger.kind === 'refuse') {
      operationId = trigger.operationId ?? null
      return conclusion('refused', [trigger.guidance ?? trigger.reason])
    }
    operationId =
      trigger.kind === 'resume'
        ? trigger.operationId!
        : (epoch.newOperationId?.() ?? `dbm_e2_${crypto.randomUUID().replaceAll('-', '')}`)
    await lock.bind(operationId)
    if (trigger.kind === 'start')
      await append('intent', {
        candidateBuild: epoch.candidateBuild,
        provider: facts.provider,
        trigger: trigger.reason,
        sessionSequence: (sessions.at(-1)?.sessionSequence ?? 0) + 1,
      })
    await checkpoint('intent')
    let journal = await epoch.journal.read(operationId)
    // B. Published negative evidence commits rollback even if the journal reference was never written.
    const commitment = autoUpgradeRollbackCommitment({
      session: await session(),
      runId: journal?.payload.run?.runId ?? null,
      failure: journal?.payload.failure ?? null,
      artifacts: journal?.payload.run
        ? await records.acceptance(operationId, journal.payload.run.runId)
        : [],
    })
    if (commitment)
      return await rollback(
        commitment,
        journal?.payload.failure ??
          (await records.acceptance(operationId, journal!.payload.run!.runId)),
      )
    if (journal && ['rolled-back', 'abandoned'].includes(journal.payload.status)) {
      await append('failed', { reason: 'external-rollback', status: journal.payload.status })
      return conclusion('failed', [
        'The automatic operation was rolled back or discarded externally. Run agent-workflow db migration auto --retry to start again.',
      ])
    }
    // C. Finalized replay also refreshes a v1 pointer left behind by an interrupted T4 finalize.
    const legacyId =
      facts.rfc349Operation ??
      (facts.pointer?.payload.version === 1 ? facts.pointer.payload.operationId : null)
    if (
      legacyId &&
      !(await session()).records.some(
        (r) => r.kind === 'rfc349-finalized' && r.data.operationId === legacyId,
      )
    ) {
      const status = await deps.legacy.status(legacyId)
      if (!['accepting-writes', 'finalized'].includes(status.phase) || status.rolledBackAt !== null)
        return await refuse('rfc349-operation-unfinished', status, [
          `Use the old binary: db migration status ${legacyId}; db migration resume ${legacyId} or db migration cancel ${legacyId}`,
        ])
      const result = await deps.legacy.finalize(legacyId)
      await append('rfc349-finalized', { operationId: legacyId, result })
    }
    // D. T3 records allocations before creation; nextTargetLocation does the same before a new-run CAS.
    let planInput: EpochSwitchPlanInput = {}
    if (
      persistenceDialect(facts.provider).requiresScratchProfile &&
      (!journal || phaseIndex(journal.payload.phase) < phaseIndex('activated')) &&
      // A persisted source change goes straight to the new-run branch, whose
      // nextTargetLocation provisions the next run. The current run's target may already be
      // retired by an interrupted new-run (retire, then death before the journal CAS), and
      // preparing it again would refuse that retired generation forever.
      classifyAutoUpgradeRun(journal?.payload.failure) !== 'new-run'
    ) {
      if (!deps.provisioning) throw new Error('auto-upgrade-provisioning-required')
      const identity = journal?.payload.run
        ? { runId: journal.payload.run.runId, generationId: journal.payload.target.generationId! }
        : epochRunIdentity(operationId, 0)
      try {
        const prepared = await deps.provisioning.prepare({
          sessionOperationId: operationId,
          ...identity,
        })
        planInput = {
          target: { provider: facts.provider, profileRef: prepared.target.profileRef },
          scratchProfileRef: prepared.scratch.profileRef,
        }
      } catch (error) {
        if (isProvisioningRefusal(error))
          return await refuse(error.code, error.detail, [
            error.message,
            'Prepare the reported empty databases, then run agent-workflow migrate again.',
          ])
        throw error
      }
    }
    let pending = false
    for (;;) {
      await lock.assertHeld()
      journal = await epoch.journal.read(operationId)
      if (journal && classifyAutoUpgradeRun(journal.payload.failure) === 'new-run') {
        try {
          await app.run({ operationId, newRun: true })
        } catch (error) {
          if (isProvisioningRefusal(error))
            return await refuse(error.code, error.detail, [error.message])
          throw error
        }
        continue
      }
      // E. A frozen run's pending plan is authoritative. Never call plan past planned.
      if (journal && ['verified', 'completed'].includes(journal.payload.phase)) break
      if (journal?.payload.phase === 'activated') {
        // G. Every verify error commits rollback before attempting it.
        await checkpoint('before-verify')
        try {
          await app.verify({ operationId })
        } catch (error) {
          return await rollback('verification-failed', describeError(error))
        }
        continue
      }
      let plan: MigrationPlanDocument | null = null
      if (!journal || phaseIndex(journal.payload.phase) <= phaseIndex('planned')) {
        const view = await app.plan(
          journal ? { operationId } : { ...planInput, requestedOperationId: operationId },
        )
        plan = view.plan
        journal = (await epoch.journal.read(operationId))!
      } else if (journal.payload.status === 'awaiting-approval' || pending) {
        const status = (await app.status({ operationId })) as EpochSwitchStatusView
        const reference = status.approval?.planDigest ?? journal.payload.plan?.digest
        if (!reference) throw new Error('auto-upgrade-pending-plan-missing')
        const bytes = await epoch.journal.readArtifact(operationId, `plans/${reference}.json`)
        if (!bytes) throw new Error('auto-upgrade-pending-plan-missing')
        plan = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8'))
        if (
          plan.digest !== reference ||
          plan.payload.target.generationId !== journal.payload.target.generationId
        )
          throw new Error('auto-upgrade-pending-plan-mismatch')
      }
      const runId = journal!.payload.run!.runId
      if (plan) {
        const reapproval = phaseIndex(journal!.payload.phase) > phaseIndex('planned')
        const prior = (await session()).records.filter(
          (r) =>
            r.kind === 'plan-evaluated' && r.data.runId === runId && r.data.reapproval === true,
        )
        if (reapproval && prior.length >= 3)
          return await refuse('approval-retry-limit', { runId }, [
            `Review agent-workflow db migration status ${operationId}; this run requested approval more than three times.`,
          ])
        const evaluation = evaluateAutoUpgradePlan(plan)
        await append('plan-evaluated', {
          runId,
          planDigest: plan.digest,
          approvalDigest: plan.approvalDigest,
          blocks: plan.payload.blocks.length,
          restrictions: evaluation.restrictions,
          reapproval,
        })
        if (evaluation.kind === 'refuse')
          return await refuse('plan-blocked', evaluation.reasons, [
            ...evaluation.reasons.map((reason) => JSON.stringify(reason)),
            `Review agent-workflow db migration status ${operationId}; explicitly acknowledge eligible items with db migration acknowledge ${operationId} --item ID --reason TEXT, then start again.`,
          ])
        await append('approved', { runId, approvalDigest: evaluation.digest })
      }
      pending = false
      const approved = [...(await session()).records]
        .reverse()
        .find((r) => r.kind === 'approved' && r.data.runId === runId)
      // A persisted source-changed failure must go through new-run even after process death.
      let result: unknown = journal!.payload.failure
      if (classifyAutoUpgradeRun(result) !== 'new-run') {
        if (!approved) throw new Error('auto-upgrade-approved-digest-missing')
        try {
          result = await app.run({ operationId, approve: String(approved.data.approvalDigest) })
        } catch (error) {
          result = error
        }
      }
      // F. session.ts records structured failures and then rethrows them.
      switch (classifyAutoUpgradeRun(result)) {
        case 'awaiting-approval':
          pending = true
          continue
        case 'new-run':
          try {
            await app.run({ operationId, newRun: true })
          } catch (error) {
            if (isProvisioningRefusal(error))
              return await refuse(error.code, error.detail, [error.message])
            throw error
          }
          continue
        case 'activated':
          await checkpoint('run-returned')
          continue
        default:
          return conclusion('error', [
            JSON.stringify(describeError(result)),
            `Resume with agent-workflow db migration auto (operation ${operationId}).`,
          ])
      }
    }
    // H. Complete the auto session, not RFC-395's separate retention registration command.
    const s = await session()
    const receipt = await records.receipt(operationId, await buildReceipt(deps, journal!, s))
    await checkpoint('receipt')
    await append('completed', { receipt })
    await checkpoint('completed')
    deps.log?.(`Automatic database upgrade completed: ${JSON.stringify(receipt)}`)
    for (const restriction of receipt.restrictions as readonly unknown[])
      deps.log?.(`restriction: ${JSON.stringify(restriction)}`, true)
    return conclusion(
      'done',
      [
        'Database upgraded and verified. Source, backups and scratch are retained; run db migration complete after operational acceptance.',
      ],
      receipt,
    )
  } catch (error) {
    return conclusion('error', [
      JSON.stringify(describeError(error)),
      'The automatic session remains resumable; run agent-workflow db migration auto.',
    ])
  } finally {
    await lock.release()
  }
}

function describeError(error: unknown): unknown {
  return error instanceof Error ? { ...error, message: error.message } : error
}
function isProvisioningRefusal(
  error: unknown,
): error is Error & { code: string; detail: Readonly<Record<string, unknown>> } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('postgresql-') &&
    'detail' in error
  )
}
async function buildReceipt(
  deps: AutoUpgradeDependencies,
  journal: EpochSwitchJournal,
  session: AutoUpgradeSession,
) {
  const p = journal.payload
  const evaluations = session.records.filter(
    (r) => r.kind === 'plan-evaluated' && r.data.runId === p.run?.runId,
  )
  const checkpoints = [{ phase: 'intent', committedAt: session.records[0]!.at }, ...p.checkpoints]
  return {
    operationId: p.operationId,
    runId: p.run?.runId,
    sourceFingerprint: p.source.fingerprintDigest,
    source: p.source.location,
    target: p.target.location,
    restrictions: evaluations.at(-1)?.data.restrictions ?? [],
    rfc349: session.records.filter((r) => r.kind === 'rfc349-finalized').map((r) => r.data),
    provisioning: session.records.filter((r) => r.kind === 'provisioned').map((r) => r.data),
    retainedDatabases: (await deps.provisioning?.retained()) ?? [],
    backup: p.backup,
    phaseTimings: checkpoints.map((c, i) => ({
      phase: c.phase,
      elapsedMs: Math.max(0, (checkpoints[i + 1]?.committedAt ?? Date.now()) - c.committedAt),
    })),
    rollbackGuidance:
      'Before the first business write use db migration rollback. After daemon startup, restore the pre-switch backup with the old binary; later writes are lost.',
    completedAt: Date.now(),
  }
}
