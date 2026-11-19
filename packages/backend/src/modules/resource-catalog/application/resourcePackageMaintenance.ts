import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type { ResourcePackageApplyActivityQuery } from '../public/queries'
import type { ResourcePackageRecoveryEffectsFactory } from './package/recoveryContentEffects'

export type ResourcePackageApplyJournalState = 'prepared' | 'applying' | 'committed' | 'failed'

export interface ResourcePackageApplyJournalSnapshot {
  readonly id: string
  readonly state: ResourcePackageApplyJournalState
  readonly preparedArtifactsJson: string
  readonly receiptJson: string | null
  readonly updatedAt: number
  readonly error?: string | null
}

/** RFC-401 T4：恢复先接管 claim，写回以接管令牌 fencing（与 AtomicApply 恢复场景同一合同）。 */
export interface ResourcePackageApplyJournalPort {
  claim: AtomicApplyRecoveryScene<'resource-package'>['claim']
  compareAndSet: AtomicApplyRecoveryScene<'resource-package'>['compareAndSet']
  list(): Promise<readonly ResourcePackageApplyJournalSnapshot[]>
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

/** RFC-513 — recovered artifacts and recovery effects are alternative selections; giving both is refused. */
export function requireExclusiveRecoverySelection(input: {
  readonly artifacts?: ResourcePackageApplyArtifactRecoveryPort
  readonly recoveryEffectsFactory?: ResourcePackageRecoveryEffectsFactory
}): void {
  if (
    input.artifacts !== undefined &&
    input.artifacts !== null &&
    input.recoveryEffectsFactory !== undefined
  )
    throw new Error('resource-package-recovery-selections-conflict')
}
