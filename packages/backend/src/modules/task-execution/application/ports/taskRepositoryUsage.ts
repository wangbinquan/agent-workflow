import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

export interface TaskRepositoryUsageQueries {
  referencedAmong(
    cachedRepoIds: readonly string[],
  ): Promise<{ readonly mounted: ReadonlySet<string>; readonly requestedOnly: ReadonlySet<string> }>
  countTaskReferences(cachedRepoIds: readonly string[]): Promise<ReadonlyMap<string, number>>
}

export interface TaskRepositorySourceRecords {
  readonly requested: readonly {
    taskId: string
    repoUrl: string | null
    cachedRepoId: string | null
  }[]
  readonly mounts: readonly {
    taskId: string
    ordinal: number
    repoUrl: string | null
    cachedRepoId: string | null
    submoduleInitError: string | null
  }[]
}

export interface TaskRepositorySourceSealingParticipant {
  updateRequestedSource(
    taskId: string,
    patch: { repoUrl?: string | null; cachedRepoId?: string | null },
  ): Promise<void>
  updateMount(
    taskId: string,
    ordinal: number,
    patch: {
      repoUrl?: string | null
      cachedRepoId?: string | null
      submoduleInitError?: string | null
      readonlyDirtyCount?: number | null
    },
  ): Promise<void>
}

export interface TaskRepositorySourceStore {
  listSources(): Promise<TaskRepositorySourceRecords>
  readonly participant: (tx: PersistenceTx) => TaskRepositorySourceSealingParticipant
}
