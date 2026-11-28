import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import type {
  EpochResolutionsView,
  EpochSwitchStatusView,
  EpochSwitchSummaryView,
} from '../../public/types'
import { parseMigrationPlanDocument } from '../../domain/epochSwitch/documents'
import type { EpochSwitchJournal } from '../../domain/epochSwitch/model'
import { resolutionReportLines } from '../../domain/epochSwitch/planDocument'
import { phaseIndex, rollbackEligibility } from '../../domain/epochSwitch/transitions'
import type { EpochSwitchDependencies } from './session'

/**
 * Null for a plan without decisions, which is every plan but the actual result of an automatic
 * upgrade. The summary is a report: a plan this binary cannot read leaves it out and does not
 * fail the status.
 */
async function planResolutions(
  deps: EpochSwitchDependencies,
  journal: EpochSwitchJournal,
): Promise<{ readonly view: EpochResolutionsView; readonly lines: readonly string[] } | null> {
  const plan = journal.payload.plan
  if (!plan) return null
  try {
    const bytes = await deps.journal.readArtifact(
      journal.payload.operationId,
      `plans/${plan.digest}.json`,
    )
    if (!bytes) return null
    const resolutions = parseMigrationPlanDocument(Buffer.from(bytes).toString('utf8')).payload
      .resolutions
    if (!resolutions) return null
    const planPath = epochArtifactPath('plans', `${plan.digest}.json`)
    return {
      view: {
        planDigest: plan.digest,
        planPath,
        totals: resolutions.totals,
        acknowledged: resolutions.acknowledged,
        keptByCode: resolutions.keptByCode,
        listLimit: resolutions.listLimit,
        recordsTable: resolutions.recordsTable,
      },
      // Totals and counts by code; the entries themselves are in the plan.
      lines: [
        ...resolutionReportLines(resolutions, { listed: 0, tasks: false }),
        `The plan lists them: ${planPath}`,
      ],
    }
  } catch {
    return null
  }
}

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
  const auto = (await deps.autoUpgradeRecords?.list())?.some((s) => s.operationId === p.operationId)
  const retained = auto
    ? ((await deps.retainedDatabases?.()) ?? []).filter(
        (row) => row.sessionOperationId === p.operationId,
      )
    : []
  // RFC-626 §3.7: only an automatic upgrade decides anything in place of a person.
  const decisions = auto ? await planResolutions(deps, journal) : null
  return {
    ...epochSwitchSummary(journal),
    ...(auto ? { mode: 'auto' as const } : {}),
    ...(decisions ? { resolutions: decisions.view } : {}),
    ...(retained.length
      ? {
          retainedDatabases: retained.map(({ kind, database, runId, bytes, purpose }) => ({
            kind,
            database,
            runId,
            bytes,
            purpose,
          })),
        }
      : {}),
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
    guidance: (
      finished ?? [
        ...(p.status === 'awaiting-approval' && phaseIndex(p.phase) >= phaseIndex('quiescing')
          ? [
              'Keep the daemon stopped while reviewing and approving this frozen run; restarting writers requires a new run.',
            ]
          : []),
        ...(p.status === 'awaiting-approval' && p.plan
          ? [
              `Review ${epochArtifactPath('plans', `${p.plan.digest}.json`)}; db migration run ${p.operationId} --approve ${p.plan.approvalDigest}`,
            ]
          : []),
        ...(p.phase === 'activated' && epochDeploymentCapabilities(p.deployment).externalSwitch
          ? [
              'The Job prepared the target. The platform must perform its generation switch before verify.',
            ]
          : []),
        ...(p.phase === 'activated'
          ? [
              'The migration did not start a daemon. Starting it may record the first business write.',
            ]
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
      ]
    ).concat(decisions?.lines ?? []),
  }
}
