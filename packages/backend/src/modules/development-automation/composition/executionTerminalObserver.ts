// RFC-344 — context-owned terminal wake participant for bootstrap launchers.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { missionIdOfExecutionRef } from '../infrastructure/sqliteReconcilerReaders'
import { createSqliteMissionStore } from '../infrastructure/sqliteMissionStore'

export interface DevelopmentMissionExecutionTerminalObserver {
  agent(executionRef: string): void
  script(executionRef: string): void
}

export function createDevelopmentMissionExecutionTerminalObserver(deps: {
  readonly db: DbClient
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  const store = createSqliteMissionStore(deps.db)
  const notify =
    (deliveryPrefix: 'agent-exec' | 'script-exec') =>
    (executionRef: string): void => {
      const missionId = missionIdOfExecutionRef(deps.db, executionRef)
      if (missionId === null) return
      store.recordWakeHint({
        id: ulid(),
        missionId,
        source: 'agent-execution',
        deliveryKey: `${deliveryPrefix}:${executionRef}`,
        now: Date.now(),
      })
      void deps.drive(missionId).catch(() => undefined)
    }
  return Object.freeze({
    agent: notify('agent-exec'),
    script: notify('script-exec'),
  })
}
