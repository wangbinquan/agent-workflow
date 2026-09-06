import { parseTriggerContextJson, type WorkflowDefinition } from '@agent-workflow/shared'
import { assertTriggerPreflight } from '@/services/execution/triggerPreflight'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { ConflictError } from '@/util/errors'
import { createWorkgroupTaskRoomApplication } from '../application/workgroups/workgroupTaskRoom'
import {
  validateWorkflowDef,
  type ValidatorContext,
} from '../infrastructure/legacy/workflow.validator'
import {
  createWorkgroupTaskRoomTransactionRunner,
  type WorkgroupTaskRoomActiveUserDirectory,
  type WorkgroupTaskRoomDependencies,
  type WorkgroupTaskRoomDynamicWorkflowOperations,
} from '../infrastructure/workgroupTaskRoom'
import { createWorkgroupTaskRoomCommands } from '../infrastructure/workgroupTaskRoomCommands'
import { createWorkgroupTaskRoomQueries } from '../infrastructure/workgroupTaskRoomQueries'
import type { WorkgroupTaskRoomModule } from '../public/operations'

/**
 * RFC-359 W4-D19b —— 工作组任务房一份装配（此前 SQLite 走 legacy engine 上的薄驱动、PG 走原生实现）。
 * 一笔事务同时交给 Resource Catalog 与 TaskExecution 两半参与者；两个 provider 走同一条路。
 */
export function composeWorkgroupTaskRoom(
  dependencies: WorkgroupTaskRoomDependencies,
): WorkgroupTaskRoomModule {
  const transaction = createWorkgroupTaskRoomTransactionRunner(dependencies)
  return createWorkgroupTaskRoomApplication({
    commands: createWorkgroupTaskRoomCommands(dependencies, transaction),
    queries: createWorkgroupTaskRoomQueries(transaction),
  })
}

/** 房间只关心「这些人还在不在岗」；身份目录由 bootstrap 交进来，判据只有一份。 */
export function composeWorkgroupTaskRoomActiveUsers(input: {
  readonly userDirectory: {
    lookup(userIds: readonly string[]): Promise<readonly { id: string; status: string }[]>
  }
}): WorkgroupTaskRoomActiveUserDirectory {
  const directory: WorkgroupTaskRoomActiveUserDirectory = {
    async findActiveUserIds(userIds) {
      const users = await input.userDirectory.lookup(userIds)
      return new Set(users.filter((user) => user.status === 'active').map((user) => user.id))
    },
  }
  return Object.freeze(directory)
}

/**
 * 「另存为工作流」只用到工作流目录 create 操作的一个投影：拿授权上下文 + 一份 JSON 提交，回一行 id/name。
 * 按结构声明而不是引 `CommandOperationDescriptor`，是为了不让 Resource Catalog 的装配去认平台的操作契约；
 * `Promise<O> | O` 与授权上下文的宽松形状都照抄描述符，好让两个 bootstrap 直接把 `operations.create` 递进来。
 */
export interface WorkgroupTaskRoomWorkflowCreation {
  invoke(
    authority: never,
    input: { readonly submission: { readonly kind: 'json-body'; readonly body: string } },
  ):
    | Promise<{ readonly id: string; readonly name: string }>
    | { readonly id: string; readonly name: string }
}

/**
 * 动态工作流的「确认前复核」与「另存为工作流」：一份判据两个 bootstrap 共用。
 * 复核是三层——触发上下文预检、通用工作流校验（按当前库存）、v1 动态工作流校验（按当前 agent 池）；
 * 任一层出 error 级问题就以 `dw-generated-def-stale` 打回，让用户带反馈重新生成。
 */
export function composeWorkgroupTaskRoomDynamicWorkflow(input: {
  readonly validationContext: { load(): Promise<ValidatorContext> }
  readonly workflows: WorkgroupTaskRoomWorkflowCreation
}): WorkgroupTaskRoomDynamicWorkflowOperations {
  const operations: WorkgroupTaskRoomDynamicWorkflowOperations = {
    async validateGenerated(_authority, request): Promise<WorkflowDefinition> {
      assertTriggerPreflight({
        root: request.definition,
        closureJson: null,
        source: parseTriggerContextJson(request.triggerContextJson),
      })
      const generic = validateWorkflowDef(request.definition, await input.validationContext.load())
      const dynamic = validateDynamicWorkflowDef(request.definition, request.poolAgentIds)
      const issues = [...generic.issues, ...dynamic.issues].filter(
        (issue) => (issue.severity ?? 'error') === 'error',
      )
      if (issues.length > 0) {
        throw new ConflictError(
          'dw-generated-def-stale',
          'the generated workflow no longer validates against the current agent pool — reject with feedback to regenerate',
          { issues },
        )
      }
      return request.definition
    },
    async create(authority, request) {
      const created = await input.workflows.invoke(authority as never, {
        submission: { kind: 'json-body', body: JSON.stringify(request) },
      })
      return { id: created.id, name: created.name }
    },
  }
  return Object.freeze(operations)
}
