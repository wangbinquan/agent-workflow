// RFC-509 — the execution terminal wake: find the mission of an execution, record one wake hint, then drive it.
import type { MissionPersistence } from './ports/missionStore'

export interface DevelopmentMissionExecutionTerminalObserver {
  agent(executionRef: string): Promise<void>
  script(executionRef: string): Promise<void>
}

export interface DevelopmentMissionExecutionTerminalObserverDependencies {
  readonly store: Pick<MissionPersistence, 'recordWakeHint'>
  readonly missionIdOfExecutionRef: (executionRef: string) => Promise<string | null>
  readonly drive: (missionId: string) => Promise<unknown>
  readonly newId: () => string
  readonly now: () => number
}

export function createMissionExecutionTerminalObserver(
  deps: DevelopmentMissionExecutionTerminalObserverDependencies,
): DevelopmentMissionExecutionTerminalObserver {
  const notify =
    (deliveryPrefix: 'agent-exec' | 'script-exec') =>
    async (executionRef: string): Promise<void> => {
      const missionId = await deps.missionIdOfExecutionRef(executionRef)
      if (missionId === null) return
      await deps.store.recordWakeHint({
        id: deps.newId(),
        missionId,
        source: 'agent-execution',
        deliveryKey: `${deliveryPrefix}:${executionRef}`,
        now: deps.now(),
      })
      await deps.drive(missionId).then(
        () => undefined,
        () => undefined,
      )
    }
  return Object.freeze({
    agent: notify('agent-exec'),
    script: notify('script-exec'),
  })
}
