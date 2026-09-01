// RFC-344 — context-owned terminal wake participant for bootstrap launchers.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { MissionPersistence } from '../application/ports/missionStore'
import { postgresqlMissionIdOfExecutionRef } from '../infrastructure/postgresqlReconcilerReaders'
import { missionIdOfExecutionRef } from '../infrastructure/sqliteReconcilerReaders'
import { createPostgresqlMissionPersistence } from '../infrastructure/postgresqlMissionStore'
import { createSqliteMissionPersistence } from '../infrastructure/sqliteMissionStore'

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

export function createSqliteDevelopmentMissionExecutionTerminalObserver(deps: {
  readonly db: DbClient
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  return observer({
    store: createSqliteMissionPersistence(deps.db),
    missionIdOfExecutionRef: async (executionRef) => missionIdOfExecutionRef(deps.db, executionRef),
    drive: deps.drive,
  })
}

export function createPostgresqlDevelopmentMissionExecutionTerminalObserver(deps: {
  readonly db: PostgresqlDatabaseClient
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  return observer({
    store: createPostgresqlMissionPersistence(deps.db),
    missionIdOfExecutionRef: (executionRef) =>
      postgresqlMissionIdOfExecutionRef(deps.db, executionRef),
    drive: deps.drive,
  })
}
