import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import type { EpochSwitchStatusView, EpochSwitchSummaryView } from '../../public/types'
import type { EpochSwitchJournal } from '../../domain/epochSwitch/model'
import { phaseIndex, rollbackEligibility } from '../../domain/epochSwitch/transitions'
import type { EpochSwitchDependencies } from './session'

export function epochSwitchSummary(journal: EpochSwitchJournal): EpochSwitchSummaryView {
  const p = journal.payload
  return {
    operationId: p.operationId,
    kind: p.kind,
    phase: p.phase,
    status: p.status,
    sourceProvider: p.source.provider,
    targetProvider: p.target.provider,
    targetGenerationId: p.target.generationId,
    runId: p.run?.runId ?? null,
    updatedAt: p.updatedAt,
    failure: p.failure,
  }
}

export async function epochSwitchStatus(
  deps: EpochSwitchDependencies,
  journal: EpochSwitchJournal,
): Promise<EpochSwitchStatusView> {
  const p = journal.payload
  let firstLiveWriteAt = p.firstLiveWriteAt
  let validation = null
  if (
    p.target.generationId &&
    p.target.location &&
    p.run &&
    phaseIndex(p.phase) >= phaseIndex('converting') &&
    !['abandoned', 'rolled-back'].includes(p.status)
  ) {
    const installed = await deps.journal.readArtifact(
      p.operationId,
      `runs/${p.run.runId}/target-installed.json`,
    )
    if (installed) {
      const target = await deps.target.open({
        generationId: p.target.generationId,
        provider: p.target.provider,
        location: p.target.location,
        faults: deps.faults,
      })
      try {
        firstLiveWriteAt = await target.firstLiveWriteAt()
        validation = (await target.trace().migrationRun(p.run.runId))?.validation ?? null
      } finally {
        await target.close()
      }
    }
  }
  const rollback = (await deps.journal.readArtifact(p.operationId, 'completion-started.json'))
    ? { allowed: false, reason: 'reverse-migration-required' }
    : rollbackEligibility({ ...journal, payload: { ...p, firstLiveWriteAt } })
  // A finished operation has no next switch step; say where the installation stands instead.
  const finished =
    p.status === 'rolled-back'
      ? [
          'Rolled back: epoch 1 is active again and its daemon can be started. The target generation and migration metadata are kept.',
          'To switch again, start a new operation: db migration plan',
        ]
      : p.status === 'abandoned'
        ? ['Discarded: nothing was switched. To switch, start a new operation: db migration plan']
        : p.status === 'completed'
          ? [
              'Completed: epoch 2 is active. The epoch-1 source, backup and migration metadata are kept; nothing is deleted automatically.',
            ]
          : null
  return {
    ...epochSwitchSummary(journal),
    journal,
    validation,
    firstLiveWriteAt,
    rollback,
    ...(p.status === 'awaiting-approval' && p.plan && p.run
      ? {
          approval: {
            operationId: p.operationId,
            runId: p.run.runId,
            planDigest: p.plan.digest,
            approvalDigest: p.plan.approvalDigest,
            planPath: epochDeploymentCapabilities(p.deployment).localPaths ? p.plan.path : null,
          },
        }
      : {}),
    guidance: finished ?? [
      ...(p.status === 'awaiting-approval' && phaseIndex(p.phase) >= phaseIndex('quiescing')
        ? [
            'Keep the daemon stopped while reviewing and approving this frozen run; restarting writers requires a new run.',
          ]
        : []),
      ...(p.status === 'awaiting-approval' && p.plan
        ? [
            `Review plans/${p.plan.digest}.json; db migration run ${p.operationId} --approve ${p.plan.approvalDigest}`,
          ]
        : []),
      ...(p.phase === 'activated' && epochDeploymentCapabilities(p.deployment).externalSwitch
        ? [
            'The Job prepared the target. The platform must perform its generation switch before verify.',
          ]
        : []),
      ...(p.phase === 'activated'
        ? ['The migration did not start a daemon. Starting it may record the first business write.']
        : []),
      rollback.allowed
        ? `Before the first business write: db migration rollback ${p.operationId}`
        : `Rollback refused: ${rollback.reason}`,
      ...(p.phase === 'activated'
        ? [
            `After acceptance: db migration verify ${p.operationId}; then db migration complete ${p.operationId}`,
          ]
        : []),
      ...(p.failure?.category === 'source-changed' || p.failure?.category === 'conversion-blocked'
        ? [`Re-plan inside this operation: db migration run ${p.operationId} --new-run`]
        : []),
    ],
  }
}
