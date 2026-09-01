import { WorkgroupSystemTemplateSchema, type WorkgroupSystemTemplate } from '@agent-workflow/shared'
export {
  parseStoredTemplateMetadata,
  type StoredWorkgroupTemplateMetadata,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'

export interface BuiltWorkgroupSystemMessage {
  authorKind: 'system'
  bodyMd: string
  templateKey: WorkgroupSystemTemplate['key']
  templateParamsJson: string
}

/** Atomically validates typed params and produces the durable English fallback. */
export function buildSystemMessage(input: WorkgroupSystemTemplate): BuiltWorkgroupSystemMessage {
  const template = WorkgroupSystemTemplateSchema.parse(input)
  return {
    authorKind: 'system',
    bodyMd: renderEnglishFallback(template),
    templateKey: template.key,
    templateParamsJson: JSON.stringify(template.params),
  }
}

export function parseStoredSystemTemplate(
  key: string | null,
  paramsJson: string | null,
): WorkgroupSystemTemplate | null {
  if (key === null || paramsJson === null) return null
  try {
    const parsed = WorkgroupSystemTemplateSchema.safeParse({ key, params: JSON.parse(paramsJson) })
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function renderEnglishFallback(template: WorkgroupSystemTemplate): string {
  switch (template.key) {
    case 'assignmentAgentUnresolvable':
      return `assignment '${template.params.title}' failed: agent for @${template.params.member} unresolvable`
    case 'assignmentFailed':
      return `assignment '${template.params.title}' failed: ${template.params.detail}`
    case 'assignmentProtocolViolation':
      return `assignment '${template.params.title}' failed: protocol violation (${template.params.detail})`
    case 'assignmentReportedFailed':
      return `assignment '${template.params.title}' reported failed by @${template.params.member}: ${template.params.detail}`
    case 'assignmentCanceledByMember':
      return `assignment '${template.params.title}' canceled by a task member`
    case 'messageTurnFailed':
      return `message turn for ${template.params.member} failed: ${template.params.detail}`
    case 'freeCollabConverged':
      return `free-collab converged — ${template.params.count} task(s) done:\n${template.params.details}`
    case 'freeCollabConvergedEmpty':
      return 'free-collab converged with no completed tasks'
    case 'leaderNudge':
      return 'Autonomous mode: you ended a round without dispatching work or declaring done. If the goal is complete, emit wg_decision done; otherwise dispatch the next assignment(s) or say what is blocking.'
    case 'maxRoundsFailed':
      return `workgroup hit max_rounds (${template.params.maxRounds})`
    case 'freeCollabDeadlock':
      return 'free_collab deadlock: open tasks but no claimable agent member'
    case 'internalDriveError':
      return `internal error driving ${template.params.item}: ${template.params.detail}`
    case 'completionGateWaiting':
      return `completion gate: waiting for human confirmation${template.params.summary ? ` — ${template.params.summary}` : ''}`
    case 'zeroDeltaDone':
      return (
        `⚠️ ${template.params.count} assignment(s) completed but the canonical worktree has no changes — ` +
        'outputs may not have merged. Check that each worker wrote inside its own working copy ' +
        '(relative paths), not an absolute path outside it.'
      )
    case 'leaderAgentUnresolvable':
      return `leader agent unresolvable (${template.params.member}) — failing task`
    case 'roundCapDispatchIgnored':
      return (
        'Round cap reached — new assignments in this final wrap-up round were ignored. ' +
        'Aggregating the completed work.'
      )
    case 'tasksAddRejected':
      return `wg_tasks_add from @${template.params.member} rejected: ${template.params.detail}`
    case 'duplicateTasksDropped':
      return `${template.params.count} duplicate task(s) from @${template.params.member} dropped (title dedup)`
    case 'visibilityMessagesDropped':
      return `${template.params.count} message(s) from @${template.params.member} dropped (visibility switches)`
    case 'batchAgentUnresolvable':
      return `batch for @${template.params.member} skipped: agent unresolvable`
    case 'batchFailed':
      return `batch of ${template.params.count} task(s) for @${template.params.member} failed: ${template.params.detail}`
    case 'batchProtocolViolation':
      return `batch for @${template.params.member}: protocol violation after retries (${template.params.detail})`
    default: {
      const unreachable: never = template
      return unreachable
    }
  }
}
