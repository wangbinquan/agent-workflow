import type {
  WorkspaceGcTaskPort,
  TaskWorkspacePruneParticipant,
  CachedRepositoryTaskUsagePort,
  TaskRepositorySourceSealingPort,
} from '@/modules/source-control/composition/required-ports'
import type {
  TaskWorkspaceGcQueries,
  TaskWorkspacePruneCommands,
} from '../ports/taskWorkspaceMaintenance'

export function composeWorkspaceGcTaskPort(queries: TaskWorkspaceGcQueries): WorkspaceGcTaskPort {
  return {
    listGcCandidates: () => queries.listGcCandidates(),
    listTasks: (ids) => queries.listTasks(ids),
    listMounts: (id) => queries.listMounts(id),
    existingTaskIds: (ids) => queries.existingTaskIds(ids),
    hasLiveOrRevivableChild: (id) => queries.hasLiveOrRevivableChild(id),
    listStaleWebhookClaims: (before) => queries.listStaleWebhookClaims(before),
    listUnstampedTerminalWorkspaces: () => queries.listUnstampedTerminalWorkspaces(),
  }
}

export function composeTaskWorkspacePruneParticipant(
  commands: TaskWorkspacePruneCommands,
): TaskWorkspacePruneParticipant {
  return {
    claim: (id, now, before) => commands.claim(id, now, before),
    claimIsolation: (id, now) => commands.claimIsolation(id, now),
    reclaimWebhook: (id, expected, now) => commands.reclaimWebhook(id, expected, now),
    finalize: (id, now) => commands.finalize(id, now),
    releaseIsolation: (id, expected) => commands.releaseIsolation(id, expected),
    healMissing: (id, now, expected) => commands.healMissing(id, now, expected),
  }
}

import type {
  TaskRepositoryUsageQueries,
  TaskRepositorySourceStore,
} from '../ports/taskRepositoryUsage'

export function composeCachedRepositoryTaskUsagePort(
  queries: TaskRepositoryUsageQueries,
): CachedRepositoryTaskUsagePort {
  return {
    referencedAmong: (ids) => queries.referencedAmong(ids),
    countTaskReferences: (ids) => queries.countTaskReferences(ids),
  }
}

export function composeTaskRepositorySourceSealingPort(
  store: TaskRepositorySourceStore,
): TaskRepositorySourceSealingPort {
  return { listSources: () => store.listSources(), participant: (tx) => store.participant(tx) }
}
