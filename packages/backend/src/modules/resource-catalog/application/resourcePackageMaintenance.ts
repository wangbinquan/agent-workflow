import type {
  ResourcePackageApplyConvergenceInput,
  ResourcePackageApplyConvergenceReceipt,
  ResourcePackageApplyMaintenanceCommand,
} from '../public/commands'
import type { ResourcePackageApplyActivityQuery } from '../public/queries'

export type ResourcePackageApplyJournalState = 'prepared' | 'applying' | 'committed' | 'failed'

export interface ResourcePackageApplyJournalSnapshot {
  readonly id: string
  readonly state: ResourcePackageApplyJournalState
  readonly preparedArtifactsJson: string
  readonly receiptJson: string | null
  readonly updatedAt: number
}

export interface ResourcePackageApplyJournalPort {
  list(): Promise<readonly ResourcePackageApplyJournalSnapshot[]>
  settleFailed(input: {
    readonly id: string
    readonly expectedState: 'prepared' | 'applying'
    readonly error: string
    readonly updatedAt: number
  }): Promise<boolean>
}

export interface ResourcePackageApplyArtifactRecoveryPort {
  rollForward(journal: ResourcePackageApplyJournalSnapshot): Promise<void>
  compensate(journal: ResourcePackageApplyJournalSnapshot): Promise<void>
}

export interface ResourcePackageApplyMaintenanceLog {
  warn(message: string, fields: Readonly<Record<string, string>>): void
}

export interface ResourcePackageApplyActivitySource {
  activeApplyIds(): readonly string[]
}

/** Provider-private writer paired with the public read-only activity query. */
export interface ResourcePackageApplyActivityTracker {
  enter(applyId: string): Readonly<{ leave(): void }>
}

const CONVERGENCE_MIN_AGE_MS = 10 * 60 * 1000

export function createResourcePackageApplyMaintenanceCommand(input: {
  readonly journal: ResourcePackageApplyJournalPort
  readonly artifacts: ResourcePackageApplyArtifactRecoveryPort
  readonly now?: () => number
  readonly log?: ResourcePackageApplyMaintenanceLog
}): ResourcePackageApplyMaintenanceCommand {
  const now = input.now ?? Date.now
  return Object.freeze({
    async converge(
      command: ResourcePackageApplyConvergenceInput,
    ): Promise<ResourcePackageApplyConvergenceReceipt> {
      const active = new Set(command.activeApplyIds)
      const reapBefore = now() - CONVERGENCE_MIN_AGE_MS
      let failed = 0
      let rolledForward = 0

      for (const journal of await input.journal.list()) {
        if (journal.state === 'committed') {
          try {
            await input.artifacts.rollForward(journal)
            rolledForward += 1
          } catch (error) {
            input.log?.warn('resource-package-roll-forward-retryable', {
              journalId: journal.id,
              error: error instanceof Error ? error.message : String(error),
            })
          }
          continue
        }
        if (
          journal.state === 'failed' ||
          active.has(journal.id) ||
          journal.updatedAt > reapBefore
        ) {
          continue
        }

        try {
          await input.artifacts.compensate(journal)
        } catch (error) {
          input.log?.warn('resource-package-compensation-retryable', {
            journalId: journal.id,
            error: error instanceof Error ? error.message : String(error),
          })
          continue
        }
        if (
          await input.journal.settleFailed({
            id: journal.id,
            expectedState: journal.state,
            error: 'converged: crashed before commit',
            updatedAt: now(),
          })
        ) {
          failed += 1
        }
      }

      return Object.freeze({ failed, rolledForward })
    },
  })
}

export function createResourcePackageApplyActivityQuery(
  source: ResourcePackageApplyActivitySource,
): ResourcePackageApplyActivityQuery {
  return Object.freeze({
    activeApplyIds: () => Object.freeze([...source.activeApplyIds()]),
  })
}

export function createResourcePackageApplyActivityRegistry(): Readonly<{
  tracker: ResourcePackageApplyActivityTracker
  query: ResourcePackageApplyActivityQuery
}> {
  const active = new Set<string>()
  const tracker: ResourcePackageApplyActivityTracker = Object.freeze({
    enter(applyId: string) {
      if (active.has(applyId)) {
        throw new Error(`resource-package-apply-already-active:${applyId}`)
      }
      active.add(applyId)
      let released = false
      return Object.freeze({
        leave() {
          if (released) return
          released = true
          active.delete(applyId)
        },
      })
    },
  })
  return Object.freeze({
    tracker,
    query: createResourcePackageApplyActivityQuery({
      activeApplyIds: () => [...active],
    }),
  })
}
