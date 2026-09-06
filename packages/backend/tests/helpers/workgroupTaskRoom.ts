// RFC-359 W4-D19b —— 测试侧装配工作组任务房的唯一入口。
//
// 合一之前测试是直接 new legacy 的 `buildRoomReads` / `buildWorkgroupTaskActions` 的，那条路已随
// 两份 provider 实现一起退役。房间现在是一份中立实现 + 一份装配，测试要拿到它就得把三个注入接缝
// （TaskExecution / Collaboration 参与者、在岗用户目录、动态工作流操作）都递进去；这里给出一份
// 测试默认值，让各套件只覆盖自己真正关心的那一个。
//
// 恢复执行的驱动端口默认是空操作：它按**部署形态**注入（单进程查工作树 + 内联驱动、多进程交给
// daemon 的续跑 worker），行为断言归 bootstrap 侧的套件，房间自己的套件不该被它影响。

import type { ProviderNeutralDatabase } from '@/db/query'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { composeWorkgroupTaskRoom } from '@/modules/resource-catalog/composition/workgroupTaskRoom'
import type {
  WorkgroupTaskRoomContinuationDriver,
  WorkgroupTaskRoomDynamicWorkflowOperations,
} from '@/modules/resource-catalog/infrastructure/workgroupTaskRoom'
import type { WorkgroupTaskRoomModule } from '@/modules/resource-catalog/public/operations'
import { composeWorkgroupTaskRoomTaskParticipantFactory } from '@/modules/task-execution/composition/workgroupTaskRoomTask'

export interface TestWorkgroupTaskRoomOptions {
  /** 收广播事件；不传就丢弃。 */
  readonly broadcasts?: string[]
  /** 默认「所有人都在岗」——只有考在岗过滤的套件才需要覆盖。 */
  readonly activeUserIds?: (userIds: readonly string[]) => ReadonlySet<string>
  readonly dynamicWorkflow?: Partial<WorkgroupTaskRoomDynamicWorkflowOperations>
  readonly continuation?: Partial<WorkgroupTaskRoomContinuationDriver>
  readonly systemUserId?: string
  readonly now?: () => number
  readonly id?: () => string
}

export function composeTestWorkgroupTaskRoom(
  db: ProviderNeutralDatabase,
  options: TestWorkgroupTaskRoomOptions = {},
): WorkgroupTaskRoomModule {
  const broadcasts = options.broadcasts
  return composeWorkgroupTaskRoom({
    db,
    taskParticipantFactory: composeWorkgroupTaskRoomTaskParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    activeUsers: {
      async findActiveUserIds(userIds) {
        return options.activeUserIds?.(userIds) ?? new Set(userIds)
      },
    },
    dynamicWorkflow: {
      async validateGenerated(authority, request) {
        if (options.dynamicWorkflow?.validateGenerated !== undefined) {
          return await options.dynamicWorkflow.validateGenerated(authority, request)
        }
        return request.definition
      },
      async create(authority, request) {
        if (options.dynamicWorkflow?.create !== undefined) {
          return await options.dynamicWorkflow.create(authority, request)
        }
        return { id: 'workflow-never-created', name: 'never' }
      },
    },
    systemUserId: options.systemUserId ?? 'system',
    continuation: {
      async assertResumable(taskId, verb) {
        await options.continuation?.assertResumable?.(taskId, verb)
      },
      async driveAfterCommit(continuation) {
        await options.continuation?.driveAfterCommit?.(continuation)
      },
    },
    broadcast(taskId, event) {
      broadcasts?.push(`${taskId}:${event.type}`)
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
  })
}

/** 房间的查询面回的是 JSON document；测试大多要的是解出来的那个对象。 */
export function roomDocument<T>(document: { readonly body: string }): T {
  return JSON.parse(document.body) as T
}
