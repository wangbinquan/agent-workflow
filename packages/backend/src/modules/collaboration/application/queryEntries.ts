// RFC-480 —— collaboration 的读取入口（原直接声明在 `public/queries.ts`：节点 run / 反问的任务访问判定、可见任务集合、问题所属任务、
// 反问指令列表）。模块外零消费，撤出 public；只取命令上下文的 `require*`，按内容归 application。函数体原样迁来。
import type { CollaborationCommandContext, ReviewActor } from '../public/types'
import type {
  CollaborationNodeRunTaskAccessDecision,
  CollaborationClarifyTaskAccessDecision,
} from './ports/collaborationTaskAccess'
import { requireCollaborationTaskAccess } from './commandContext'
import type { ClarifyDirectiveStore } from './ports/clarifyDirectiveStore'
import type { ClarifyDirective } from '@agent-workflow/shared'

export function resolveCollaborationNodeRunTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly nodeRunId: string },
): Promise<CollaborationNodeRunTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveNodeRunTask(input.actor, input.nodeRunId)
}

export function resolveCollaborationClarifyTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly intermediaryNodeRunId: string },
): Promise<CollaborationClarifyTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveClarifyRoundTask(
    input.actor,
    input.intermediaryNodeRunId,
  )
}

export function visibleCollaborationTaskIds(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  return requireCollaborationTaskAccess(context).visibleTaskIds(input.actor, input.taskIds)
}

export function collaborationQuestionTaskId(
  context: CollaborationCommandContext,
  entryId: string,
): Promise<string | null> {
  return requireCollaborationTaskAccess(context).questionTaskId(entryId)
}

/** RFC-482: reads through the directive store the route operations were handed (see setCollaborationClarifyDirective). */
export function listCollaborationClarifyDirectives(
  directives: ClarifyDirectiveStore,
  taskId: string,
): Promise<readonly Readonly<{ nodeId: string; directive: ClarifyDirective }>[]> {
  return directives.listNodeDirectives(taskId)
}
