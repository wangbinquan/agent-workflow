// RFC-486 (RFC-294 W4-E1 remainder): the route-facing launch operations (agent / workgroup), over the two launch arms.

import { resolveTaskUploadLimits } from '../launchConfiguration'
import { type Actor } from '@/auth/actor'
import { NotFoundError } from '@/util/errors'
import type { TaskExecutionResourceAuthority } from '../ports/taskExecutionResourceSnapshots'
import { DEFAULT_UPLOAD_LIMITS } from '../../domain/uploads'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '../../public/commands'

import type { TaskAuthorizationQueries } from '../ports/taskAuthorization'
import type { TaskExecutionLaunchParticipantDependencies } from './taskExecutionLaunchParticipant'
import {
  createAgentRouteLaunch,
  createWorkgroupRouteLaunch,
  type AgentLaunchCommand,
  type TaskLaunchArms,
  type WorkgroupLaunchCommand,
} from './taskLaunchArms'

/** 路由面额外要一格：把 admitted actor 绑成 provider 的资源目录鉴权句柄。 */
export interface TaskRouteLaunchDependencies extends TaskExecutionLaunchParticipantDependencies {
  readonly resourceAuthorityFor: (actor: Actor) => TaskExecutionResourceAuthority
  /** RFC-486: replay visibility (was built from the raw db here). */
  readonly taskAuthorization: TaskAuthorizationQueries
}

function createTaskLaunchArms(dependencies: TaskRouteLaunchDependencies): TaskLaunchArms {
  // 两个臂都已各自提成独立工厂（plan §5hn 批次一 / 批次二 ③），这里只剩转发。
  return Object.freeze({
    launchAgent: createAgentRouteLaunch(dependencies),
    launchWorkgroup: createWorkgroupRouteLaunch(dependencies),
  })
}

export function createTaskRouteLaunchOperations(
  dependencies: TaskRouteLaunchDependencies,
): Readonly<{
  agent: AgentRouteTaskLaunchOperations
  workgroup: WorkgroupRouteTaskLaunchOperations
}> {
  const arms = createTaskLaunchArms(dependencies)
  const authorization = dependencies.taskAuthorization
  const assertReplayVisible = async (actor: Actor, sourceTaskId: string): Promise<void> => {
    const visible = await authorization.canViewTask({
      subject: {
        userId: actor.user.id,
        canReadAllTasks: actor.permissions.has('tasks:read:all'),
      },
      taskId: sourceTaskId,
    })
    if (!visible) throw new NotFoundError('task-not-found', `task ${sourceTaskId} not found`)
  }

  return Object.freeze({
    agent: Object.freeze({
      uploadLimits: () =>
        dependencies.launchConfiguration === undefined
          ? dependencies.fileUploadLimits()
          : resolveTaskUploadLimits(dependencies.launchConfiguration, DEFAULT_UPLOAD_LIMITS),
      assertReplayVisible,
      async launch(actor: Actor, command: AgentLaunchCommand) {
        return await arms.launchAgent({
          actor,
          command,
          invoker: {
            type: 'user',
            launchKind: command.uploads === undefined ? 'direct-json' : 'direct-multipart',
          },
          resources: dependencies.resourceAuthorityFor(actor),
        })
      },
    }),
    workgroup: Object.freeze({
      assertReplayVisible,
      async launch(actor: Actor, command: WorkgroupLaunchCommand) {
        return await arms.launchWorkgroup({
          actor,
          command,
          invoker: { type: 'user', launchKind: 'direct-json' },
          resources: dependencies.resourceAuthorityFor(actor),
        })
      },
    }),
  })
}
