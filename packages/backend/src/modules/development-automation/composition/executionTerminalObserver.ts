// RFC-344 — context-owned terminal wake participant for bootstrap launchers.

import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { MissionPersistence } from '../application/ports/missionStore'
import { missionIdOfExecutionRef } from '../infrastructure/reconcilerReaders'
import { createMissionPersistence } from '../infrastructure/missionStore'

export interface DevelopmentMissionExecutionTerminalObserver {
  agent(executionRef: string): Promise<void>
  script(executionRef: string): Promise<void>
}

function observer(deps: {
  readonly store: Pick<MissionPersistence, 'recordWakeHint'>
  readonly missionIdOfExecutionRef: (executionRef: string) => Promise<string | null>
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  const notify =
    (deliveryPrefix: 'agent-exec' | 'script-exec') =>
    async (executionRef: string): Promise<void> => {
      const missionId = await deps.missionIdOfExecutionRef(executionRef)
      if (missionId === null) return
      await deps.store.recordWakeHint({
        id: ulid(),
        missionId,
        source: 'agent-execution',
        deliveryKey: `${deliveryPrefix}:${executionRef}`,
        now: Date.now(),
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

/** 两个 provider 同一份（RFC-359 W4-D10）：终态观察者只依赖中立的 Mission 持久化与执行引用读面。 */
export function createDevelopmentMissionExecutionTerminalObserver(deps: {
  readonly db: ProviderNeutralDatabase
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  return observer({
    store: createMissionPersistence(deps.db),
    missionIdOfExecutionRef: (executionRef) => missionIdOfExecutionRef(deps.db, executionRef),
    drive: deps.drive,
  })
}
