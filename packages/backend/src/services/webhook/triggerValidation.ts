// RFC-257 T8 — 触发器保存期静态校验（design §4.2 / AC-14 前半）。
// 三层：①模板变量 ⊆ 所选事件类型交集可用集（shared templateVarIssues）；
// ②workflow 面的输入映射 kind-aware 校验（git→event-branch、text→template、
// enum/files/upload 不可映射——gate 只见字符串，不懂映射语义，这层必须在此做）；
// ③「彩排渲染 + 完整 gate」：用合成事件渲染出完全体 payload 交给
// assertScheduledTargetUsable（ACL/builtin/upload/launch-shape 全复用，等价于
// 验证「一个典型事件到来时这个触发器能启动」）——fire 期跑的是同一个 gate，
// 保存期彩排让配置错误在保存时暴露而不是 fire 后逐次失败。
import type {
  CodeHostEvent,
  CodeHostEventType,
  WebhookInputMapping,
  WebhookLaunchKind,
  WebhookLaunchPayloadTemplate,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import { WebhookWorkflowPayloadTemplateSchema, templateVarIssues } from '@agent-workflow/shared'

export type TriggerValidationIssue = {
  code:
    | 'unknown-template-var'
    | 'template-var-unavailable'
    | 'unknown-input'
    | 'required-input-unmapped'
    | 'input-kind-unmappable'
    | 'input-mapping-kind-mismatch'
    | 'scratch-auto-register-conflict'
  detail: string
}

type DefInput = WorkflowDefinition['inputs'][number]

export type WebhookTriggerSaveCandidate = Readonly<{
  launchKind: WebhookLaunchKind
  launchRefId: string
  launchPayload: unknown
  eventTypes: ReadonlyArray<CodeHostEventType>
  autoRegisterRepos: boolean
}>

/** workflow 面：输入映射与 workflow 定义的 kind-aware 对账。 */
export function validateWorkflowInputMappings(
  defInputs: ReadonlyArray<DefInput>,
  mappings: Record<string, WebhookInputMapping>,
): TriggerValidationIssue[] {
  const issues: TriggerValidationIssue[] = []
  const byKey = new Map(defInputs.map((i) => [i.key, i]))
  for (const [key, mapping] of Object.entries(mappings)) {
    const def = byKey.get(key)
    if (def === undefined) {
      issues.push({ code: 'unknown-input', detail: key })
      continue
    }
    if (def.kind === 'git') {
      if (mapping.kind !== 'event-branch') {
        issues.push({
          code: 'input-mapping-kind-mismatch',
          detail: `${key}: git-kind input requires the event-branch mapping`,
        })
      }
    } else if (def.kind === 'text') {
      if (mapping.kind !== 'template') {
        issues.push({
          code: 'input-mapping-kind-mismatch',
          detail: `${key}: text-kind input requires a template mapping`,
        })
      }
    } else {
      // enum/files/upload：packed 语义无法从事件构造（design §4.2）。
      issues.push({
        code: 'input-kind-unmappable',
        detail: `${key}: ${def.kind}-kind inputs cannot be event-mapped`,
      })
    }
  }
  for (const def of defInputs) {
    if (def.required === true && !(def.key in mappings)) {
      issues.push({ code: 'required-input-unmapped', detail: def.key })
    }
  }
  return issues
}

/** 全量保存期静态校验（模板变量层 + workflow 映射层；gate 彩排由调用方跑）。 */
export function staticTriggerIssues(
  kind: WebhookLaunchKind,
  payload: WebhookLaunchPayloadTemplate,
  eventTypes: ReadonlyArray<CodeHostEventType>,
  workflowInputs: ReadonlyArray<DefInput> | null,
): TriggerValidationIssue[] {
  const issues: TriggerValidationIssue[] = templateVarIssues(kind, payload, eventTypes).map(
    (i) => ({ code: i.code, detail: i.varName }),
  )
  if (kind === 'workflow' && workflowInputs !== null) {
    const parsed = WebhookWorkflowPayloadTemplateSchema.parse(payload)
    issues.push(...validateWorkflowInputMappings(workflowInputs, parsed.inputs))
  }
  return issues
}

/**
 * 彩排事件：每个可选字段都给占位值，让渲染出的 payload 是「最完整形态」，
 * gate 的 launch-shape 校验（required 端口 / unknown key / upload 拒绝）在
 * 保存期就能全量执行。字段值本身无语义（gate 不检查内容）。
 */
export function rehearsalEvent(eventType: CodeHostEventType): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: null,
    eventType,
    repoPath: 'rehearsal/repo',
    repoHttpUrl: 'https://rehearsal.invalid/repo.git',
    repoSshUrl: 'git@rehearsal.invalid:repo.git',
    branch: 'rehearsal-branch',
    targetBranch: 'main',
    mrIid: '1',
    mrTitle: 'rehearsal',
    commitSha: '0000000000000000000000000000000000000000',
    commentText: '/rehearsal',
    author: { username: 'rehearsal-user' },
    pipelineStatus: 'failed',
    raw: {},
  }
}
