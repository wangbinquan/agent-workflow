import type { DbClient } from '@/db/client'
import { parseJsonDocument } from '@/util/jsonDocument'
import type { WorkgroupTaskRoomDriver } from '../application/workgroups/workgroupTaskRoom'
import type { WorkgroupTaskRoomCommands } from '../public/commands'
import type { WorkgroupTaskRoomQueries } from '../public/queries'
import type { WorkgroupTaskJsonDocument } from '../public/types'
import { buildConfigActions } from './legacy/workgroup/configActions'
import { buildDwActions } from './legacy/workgroup/dwActions'
import { buildRoomReads } from './legacy/workgroup/room'
import {
  buildWorkgroupTaskActions,
  type WorkgroupTaskActionDeps,
} from './legacy/workgroup/taskActions'

export interface SqliteWorkgroupTaskRoomDependencies {
  readonly db: DbClient
  readonly configPath: string
  readonly schedulerDriver: WorkgroupTaskActionDeps['schedulerDriver']
  readonly taskRecoveryOperations: WorkgroupTaskActionDeps['taskRecoveryOperations']
}

function inputBody(body: string): unknown {
  return parseJsonDocument(body)
}

function document(value: unknown): WorkgroupTaskJsonDocument {
  return Object.freeze({ kind: 'json-document' as const, body: JSON.stringify(value) })
}

/** SQLite compatibility adapter. All legacy DB-shaped builders stop here. */
export function createSqliteWorkgroupTaskRoomDriver(
  dependencies: SqliteWorkgroupTaskRoomDependencies,
): WorkgroupTaskRoomDriver {
  const core = buildWorkgroupTaskActions(dependencies)
  const actions = {
    ...core,
    ...buildDwActions(dependencies, core),
    ...buildRoomReads(dependencies, core),
    ...buildConfigActions(dependencies, core),
  }
  const commands = Object.freeze<WorkgroupTaskRoomCommands>({
    postMessage: (authority, input) =>
      actions.postRoomMessage(authority, input.taskId, inputBody(input.submission.body)),
    deliverAssignment: (authority, input) =>
      actions.deliverAssignment(
        authority,
        input.taskId,
        input.assignmentId,
        inputBody(input.submission.body),
      ),
    confirmGate: (authority, input) =>
      actions.confirmGate(authority, input.taskId, inputBody(input.submission.body)),
    confirmDynamicWorkflow: (authority, input) =>
      actions.dwConfirm(authority, input.taskId, inputBody(input.submission.body)),
    saveDynamicWorkflow: (authority, input) =>
      actions.dwSaveAsWorkflow(authority, input.taskId, inputBody(input.submission.body)),
    updateConfig: (authority, input) =>
      actions.updateTaskConfig(authority, input.taskId, inputBody(input.submission.body)),
    cancelAssignment: (authority, input) =>
      actions.cancelAssignment(authority, input.taskId, input.assignmentId),
  })
  const queries = Object.freeze<WorkgroupTaskRoomQueries>({
    pendingCount: async (authority) => document(await actions.pendingCount(authority)),
    pending: async (authority) => document({ items: await actions.pendingRows(authority) }),
    room: async (authority, input) =>
      document(await actions.roomAggregate(authority, input.taskId)),
  })
  return Object.freeze({
    commands,
    queries,
  })
}
