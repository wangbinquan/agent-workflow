// RFC-344 — context-owned terminal wake participant for bootstrap launchers.

import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createMissionExecutionTerminalObserver,
  type DevelopmentMissionExecutionTerminalObserver,
} from '../application/executionTerminalObserver'
import { missionIdOfExecutionRef } from '../infrastructure/reconcilerReaders'
import { createMissionPersistence } from '../infrastructure/missionStore'
export type { DevelopmentMissionExecutionTerminalObserver } from '../application/executionTerminalObserver'

/** 两个 provider 同一份（RFC-359 W4-D10）：终态观察者只依赖中立的 Mission 持久化与执行引用读面。 */
export function createDevelopmentMissionExecutionTerminalObserver(deps: {
  readonly db: PersistenceDb
  readonly drive: (missionId: string) => Promise<unknown>
}): DevelopmentMissionExecutionTerminalObserver {
  return createMissionExecutionTerminalObserver({
    store: createMissionPersistence(deps.db),
    missionIdOfExecutionRef: (executionRef) => missionIdOfExecutionRef(deps.db, executionRef),
    drive: deps.drive,
    newId: () => ulid(),
    now: () => Date.now(),
  })
}
