import type { DbClient } from '@/db/client'
import type { WorkgroupTaskRoomDriver } from '../application/workgroups/workgroupTaskRoom'
import type { WorkgroupTaskRoomCommands } from '../public/commands'
import type { WorkgroupTaskRoomQueries } from '../public/queries'
import type { WorkgroupTaskJsonDocument } from '../public/types'
import { workgroupTaskSubmissionBody } from './workgroupTaskSubmission'
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

/** 与 PostgreSQL adapter 共用同一份判据，见 `workgroupTaskSubmission.ts`。 */
const inputBody = workgroupTaskSubmissionBody

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
      actions.postRoomMessage(authority, input.taskId, inputBody(input.submission)),
    deliverAssignment: (authority, input) =>
      actions.deliverAssignment(
        authority,
        input.taskId,
        input.assignmentId,
        inputBody(input.submission),
      ),
    confirmGate: (authority, input) =>
      actions.confirmGate(authority, input.taskId, inputBody(input.submission)),
    confirmDynamicWorkflow: (authority, input) =>
      actions.dwConfirm(authority, input.taskId, inputBody(input.submission)),
    saveDynamicWorkflow: (authority, input) =>
      actions.dwSaveAsWorkflow(authority, input.taskId, inputBody(input.submission)),
    updateConfig: (authority, input) =>
      actions.updateTaskConfig(authority, input.taskId, inputBody(input.submission)),
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
