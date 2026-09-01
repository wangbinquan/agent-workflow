import type { DbClient } from '@/db/client'
import { startExecution } from '@/services/execution/executor'
import { FrozenWorkgroupGroupSchema } from './legacyCallClosure'
import { startWorkgroupTaskFromFrozen } from '@/services/workgroup/launch'
import type { ChildExecutionLaunchOperations } from '../application/ports/childExecutionLaunchOperations'
import type {
  ChildWorkflowLaunchRequest,
  ChildWorkgroupLaunchRequest,
} from '../application/ports/childExecutionLaunchOperations'

export function createSqliteChildExecutionLaunchOperations(
  db: DbClient,
): ChildExecutionLaunchOperations {
  return Object.freeze({
    async launchWorkflow(request: ChildWorkflowLaunchRequest) {
      await startExecution(
        db,
        request.actor,
        {
          kind: 'workflow',
          refId: request.workflowId,
          invoker: {
            type: 'node',
            parentTaskId: request.parentTaskId,
            parentNodeRunId: request.parentNodeRunId,
            invocationDepth: request.invocationDepth,
          },
          payload: request.payload,
        },
        {
          db,
          schedulerDriver: request.schedulerDriver,
          materializedSpace: request.materializedSpace,
          callLaunch: {
            parentTaskId: request.parentTaskId,
            parentNodeRunId: request.parentNodeRunId,
            invocationDepth: request.invocationDepth,
            frozenSnapshotJson: request.frozenSnapshotJson,
            refClosureJson: request.refClosureJson,
          },
          ...(request.runtime.triggerContext === undefined
            ? {}
            : { triggerContext: request.runtime.triggerContext }),
          ...(request.runtime.actorUserId === undefined
            ? {}
            : { actorUserId: request.runtime.actorUserId }),
          ...request.runtime.runConfig,
        },
      )
    },
    async launchWorkgroup(request: ChildWorkgroupLaunchRequest) {
      await startWorkgroupTaskFromFrozen(
        db,
        {
          frozenGroup: FrozenWorkgroupGroupSchema.parse(request.frozenGroup.group),
          workgroupId: request.frozenGroup.id,
          goal: request.goal,
          name: request.name,
          collaboratorUserIds: [...request.collaboratorUserIds],
          ...(request.maxDurationMs === undefined ? {} : { maxDurationMs: request.maxDurationMs }),
          ...(request.maxTotalTokens === undefined
            ? {}
            : { maxTotalTokens: request.maxTotalTokens }),
        },
        {
          db,
          schedulerDriver: request.schedulerDriver,
          materializedSpace: request.materializedSpace,
          callLaunch: {
            parentTaskId: request.parentTaskId,
            parentNodeRunId: request.parentNodeRunId,
            invocationDepth: request.invocationDepth,
            frozenSnapshotJson: null,
            refClosureJson: null,
          },
          ...(request.runtime.triggerContext === undefined
            ? {}
            : { triggerContext: request.runtime.triggerContext }),
          ...(request.runtime.actorUserId === undefined
            ? {}
            : { actorUserId: request.runtime.actorUserId }),
          ...request.runtime.runConfig,
        },
      )
    },
  })
}
