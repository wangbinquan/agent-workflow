import {
  CODE_HOST_EVENT_TYPES,
  WEBHOOK_EVENT_VAR_MATRIX,
  eventVarsOf,
  type CodeHostEvent,
  type CodeHostEventType,
  type WebhookTemplateVar,
} from '@agent-workflow/shared'

import type { EventObservationInput } from '@/modules/event-center/public/types'
import { codeHostWebhookRoutingFactsOf } from '../domain/codeHostWebhookEvent'

/** One logical code-platform source; Webhook and polling are observation modes. */
export const CODE_HOST_EVENT_SOURCE_REF = {
  id: 'code-host.activity',
  revision: 1,
} as const

const EVENT_NAMES: Readonly<Record<CodeHostEventType, { 'zh-CN': string; 'en-US': string }>> = {
  push: { 'zh-CN': '分支推送', 'en-US': 'Branch pushed' },
  tag_push: { 'zh-CN': '标签推送', 'en-US': 'Tag pushed' },
  mr_opened: { 'zh-CN': '合并请求已创建', 'en-US': 'Merge request opened' },
  mr_updated: { 'zh-CN': '合并请求已更新', 'en-US': 'Merge request updated' },
  mr_merged: { 'zh-CN': '合并请求已合入', 'en-US': 'Merge request merged' },
  mr_closed: { 'zh-CN': '合并请求已关闭', 'en-US': 'Merge request closed' },
  note: { 'zh-CN': '收到评论', 'en-US': 'Comment received' },
  pipeline_failed: { 'zh-CN': '流水线失败', 'en-US': 'Pipeline failed' },
  pipeline_succeeded: { 'zh-CN': '流水线通过', 'en-US': 'Pipeline succeeded' },
  issue_labeled: { 'zh-CN': '工作项已标记', 'en-US': 'Work item labeled' },
  issue_comment: { 'zh-CN': '工作项收到评论', 'en-US': 'Work item comment received' },
}

const EVENT_DESCRIPTIONS: Readonly<
  Record<CodeHostEventType, { 'zh-CN': string; 'en-US': string }>
> = {
  push: { 'zh-CN': '一个分支已收到新的提交', 'en-US': 'A branch received new commits' },
  tag_push: { 'zh-CN': '一个标签已创建或更新', 'en-US': 'A tag was created or updated' },
  mr_opened: { 'zh-CN': '一个合并请求已经创建', 'en-US': 'A merge request was created' },
  mr_updated: { 'zh-CN': '一个合并请求的内容或状态已经变化', 'en-US': 'A merge request changed' },
  mr_merged: { 'zh-CN': '一个合并请求已经合入', 'en-US': 'A merge request was merged' },
  mr_closed: { 'zh-CN': '一个合并请求已经关闭', 'en-US': 'A merge request was closed' },
  note: { 'zh-CN': '一个合并请求收到了新评论', 'en-US': 'A merge request received a comment' },
  pipeline_failed: { 'zh-CN': '一次流水线运行已经失败', 'en-US': 'A pipeline run failed' },
  pipeline_succeeded: { 'zh-CN': '一次流水线运行已经通过', 'en-US': 'A pipeline run passed' },
  issue_labeled: { 'zh-CN': '一个工作项新增了标签', 'en-US': 'A work item received a label' },
  issue_comment: { 'zh-CN': '一个工作项收到了新评论', 'en-US': 'A work item received a comment' },
}

const FIELD_NAMES: Readonly<
  Record<string, { readonly 'zh-CN': string; readonly 'en-US': string }>
> = {
  event_type: { 'zh-CN': '事件类型', 'en-US': 'Event type' },
  provider: { 'zh-CN': '代码平台', 'en-US': 'Code platform' },
  repo_path: { 'zh-CN': '仓库路径', 'en-US': 'Repository path' },
  repo_http_url: { 'zh-CN': '仓库 HTTP 地址', 'en-US': 'Repository HTTP URL' },
  repo_ssh_url: { 'zh-CN': '仓库 SSH 地址', 'en-US': 'Repository SSH URL' },
  branch: { 'zh-CN': '事件分支', 'en-US': 'Event branch' },
  target_branch: { 'zh-CN': '目标分支', 'en-US': 'Target branch' },
  default_branch: { 'zh-CN': '默认分支', 'en-US': 'Default branch' },
  mr_iid: { 'zh-CN': 'MR / PR 编号', 'en-US': 'MR / PR number' },
  mr_id: { 'zh-CN': 'MR / PR 全局 ID', 'en-US': 'MR / PR global ID' },
  mr_title: { 'zh-CN': 'MR / PR 标题', 'en-US': 'MR / PR title' },
  mr_url: { 'zh-CN': 'MR / PR 地址', 'en-US': 'MR / PR URL' },
  commit_sha: { 'zh-CN': '提交 SHA', 'en-US': 'Commit SHA' },
  commit_before: { 'zh-CN': '推送前 SHA', 'en-US': 'SHA before push' },
  comment_text: { 'zh-CN': '评论正文', 'en-US': 'Comment body' },
  comment_author: { 'zh-CN': '评论作者', 'en-US': 'Comment author' },
  comment_id: { 'zh-CN': '评论 ID', 'en-US': 'Comment ID' },
  comment_thread_id: { 'zh-CN': '评论线程 ID', 'en-US': 'Comment thread ID' },
  comment_url: { 'zh-CN': '评论地址', 'en-US': 'Comment URL' },
  comment_position_json: { 'zh-CN': '行内评论位置', 'en-US': 'Inline comment position' },
  pipeline_status: { 'zh-CN': '流水线状态', 'en-US': 'Pipeline status' },
  pipeline_id: { 'zh-CN': '流水线 ID', 'en-US': 'Pipeline ID' },
  pipeline_url: { 'zh-CN': '流水线地址', 'en-US': 'Pipeline URL' },
  api_base_url: { 'zh-CN': 'API 根地址', 'en-US': 'API base URL' },
  project_id: { 'zh-CN': '项目 ID', 'en-US': 'Project ID' },
  project_web_url: { 'zh-CN': '项目网页地址', 'en-US': 'Project web URL' },
  repo_owner: { 'zh-CN': '仓库所有者', 'en-US': 'Repository owner' },
  repo_name: { 'zh-CN': '仓库名称', 'en-US': 'Repository name' },
  author_id: { 'zh-CN': '事件作者 ID', 'en-US': 'Event author ID' },
  issue_iid: { 'zh-CN': '工作项编号', 'en-US': 'Work item number' },
  issue_title: { 'zh-CN': '工作项标题', 'en-US': 'Work item title' },
  issue_url: { 'zh-CN': '工作项地址', 'en-US': 'Work item URL' },
  issue_body: { 'zh-CN': '工作项正文', 'en-US': 'Work item body' },
  issue_labels: { 'zh-CN': '工作项全部标签', 'en-US': 'Work item labels' },
  added_labels: { 'zh-CN': '本次新增标签', 'en-US': 'Labels added' },
  event_json: { 'zh-CN': '原始事件内容', 'en-US': 'Raw event content' },
}

function fieldName(fieldId: string) {
  return FIELD_NAMES[fieldId] ?? { 'zh-CN': fieldId, 'en-US': fieldId }
}

function businessFieldsOf(
  eventType: CodeHostEventType,
): ReadonlyArray<Exclude<WebhookTemplateVar, 'event_json'>> {
  return WEBHOOK_EVENT_VAR_MATRIX[eventType].filter(
    (fieldId): fieldId is Exclude<WebhookTemplateVar, 'event_json'> => fieldId !== 'event_json',
  )
}

const BUSINESS_EVENT_IDS = {
  push: 'code-host.branch.pushed',
  tag_push: 'code-host.tag.pushed',
  mr_opened: 'code-host.merge-request.opened',
  mr_updated: 'code-host.merge-request.updated',
  mr_merged: 'code-host.merge-request.merged',
  mr_closed: 'code-host.merge-request.closed',
  note: 'code-host.merge-request.comment-received',
  pipeline_failed: 'code-host.pipeline.failed',
  pipeline_succeeded: 'code-host.pipeline.succeeded',
  issue_labeled: 'code-host.issue.labeled',
  issue_comment: 'code-host.issue.comment-received',
} as const satisfies Readonly<Record<CodeHostEventType, string>>

const BUSINESS_SUBJECT_TYPES = {
  push: 'code-host.repository',
  tag_push: 'code-host.repository',
  mr_opened: 'merge-request',
  mr_updated: 'merge-request',
  mr_merged: 'merge-request',
  mr_closed: 'merge-request',
  note: 'merge-request',
  pipeline_failed: 'code-host.pipeline',
  pipeline_succeeded: 'code-host.pipeline',
  issue_labeled: 'code-host.issue',
  issue_comment: 'code-host.issue',
} as const satisfies Readonly<Record<CodeHostEventType, string>>

export function codeHostEventTypeRef(eventType: CodeHostEventType) {
  return { id: `code-host.event.${eventType}`, revision: 1 } as const
}

/** Public business fact. Its identity never contains the observation mechanism. */
export function codeHostBusinessEventTypeRef(eventType: CodeHostEventType) {
  return { id: BUSINESS_EVENT_IDS[eventType], revision: 1 } as const
}

/** Integration-owned catalog contribution admitted by Event Center at bootstrap. */
export const codeHostEventCatalogJson = JSON.stringify({
  typeRef: { typeId: 'integration.code-host', revision: 1 },
  eventSources: [
    {
      sourceId: CODE_HOST_EVENT_SOURCE_REF.id,
      version: CODE_HOST_EVENT_SOURCE_REF.revision,
      ownerTypeId: 'integration.code-host',
      displayName: { 'zh-CN': '代码平台', 'en-US': 'Code platform' },
      description: {
        'zh-CN': '通过 Webhook 实时接收变化，并在有人关注时用短轮询补齐权威状态。',
        'en-US':
          'Receives real-time changes through webhooks and reconciles authoritative state by short polling while subscribed.',
      },
      observationMode: 'hybrid',
      observerProgramRef: { id: 'builtin:development-code-host-observer', revision: 1 },
      pollIntervalMs: 30_000,
      batchSize: 100,
    },
  ],
  eventTypes: CODE_HOST_EVENT_TYPES.flatMap((eventType) => [
    {
      eventTypeId: codeHostBusinessEventTypeRef(eventType).id,
      version: 1,
      subjectTypeId: BUSINESS_SUBJECT_TYPES[eventType],
      payloadSchemaId: 'code-host.business-event.v1',
      displayName: EVENT_NAMES[eventType],
      description: EVENT_DESCRIPTIONS[eventType],
      deliveryClass: 'code-host-business-event',
      sourceRef: CODE_HOST_EVENT_SOURCE_REF,
      triggerParameters: {
        namespace: 'code_host',
        fields: businessFieldsOf(eventType).map((fieldId) => ({
          fieldId,
          displayName: fieldName(fieldId),
          description: {
            'zh-CN': `${fieldName(fieldId)['zh-CN']}，由该代码平台事实确定性注入。`,
            'en-US': `${fieldName(fieldId)['en-US']}, deterministically injected by this code-host fact.`,
          },
        })),
      },
    },
    {
      eventTypeId: codeHostEventTypeRef(eventType).id,
      version: 1,
      subjectTypeId: 'code-host.repository',
      payloadSchemaId: 'code-host.webhook-delivery',
      displayName: EVENT_NAMES[eventType],
      description: EVENT_NAMES[eventType],
      deliveryClass: 'code-host-event',
      sourceRef: CODE_HOST_EVENT_SOURCE_REF,
      // Existing Webhook rules still route on this normalized occurrence matrix,
      // but it is not a second public event taxonomy. New response rules consume
      // the business fact above and therefore never depend on Webhook transport.
      catalogVisibility: 'compatibility',
      triggerParameters: {
        namespace: 'webhook',
        fields: WEBHOOK_EVENT_VAR_MATRIX[eventType].map((fieldId) => ({
          fieldId,
          displayName: { 'zh-CN': fieldId, 'en-US': fieldId },
          description: {
            'zh-CN': `代码平台事件参数 ${fieldId}`,
            'en-US': `Code-host event parameter ${fieldId}`,
          },
        })),
      },
    },
  ]),
})

function businessSubject(input: { readonly deliveryId: string; readonly event: CodeHostEvent }): {
  typeId: string
  subjectRef: string
} {
  const event = input.event
  const repository = `${event.provider}:${event.repoPath}`
  const typeId = BUSINESS_SUBJECT_TYPES[event.eventType]
  if (typeId === 'merge-request') {
    return { typeId, subjectRef: `${repository}!${event.mrIid ?? 'unknown'}` }
  }
  if (typeId === 'code-host.issue') {
    return { typeId, subjectRef: `${repository}#${event.issueIid ?? 'unknown'}` }
  }
  if (typeId === 'code-host.pipeline') {
    return {
      typeId,
      subjectRef: `${repository}:pipeline:${event.pipelineId ?? event.commitSha ?? input.deliveryId}`,
    }
  }
  return { typeId, subjectRef: repository }
}

/**
 * Public fact produced from a verified code-platform push. The companion raw
 * occurrence remains compatibility-only for existing Webhook selectors.
 */
export function codeHostBusinessEventObservation(input: {
  readonly endpointId: string
  readonly deliveryId: string
  readonly event: CodeHostEvent
  readonly occurredAt: number
}): EventObservationInput {
  const allParameters = eventVarsOf(input.event)
  const triggerParameters = Object.fromEntries(
    businessFieldsOf(input.event.eventType).map((field) => [field, allParameters[field]]),
  )
  return {
    sourceRef: CODE_HOST_EVENT_SOURCE_REF,
    eventTypeRef: codeHostBusinessEventTypeRef(input.event.eventType),
    subject: businessSubject(input),
    occurredAt: input.occurredAt,
    dedupeKey: `code-host-fact:${input.endpointId}:${input.event.eventUuid ?? input.deliveryId}`,
    summary: `${EVENT_NAMES[input.event.eventType]['zh-CN']} · ${input.event.repoPath}`,
    payloadArtifactRef: `webhook-delivery:${input.deliveryId}`,
    triggerParameters,
  }
}

export function codeHostEventObservations(input: {
  readonly endpointId: string
  readonly deliveryId: string
  readonly event: CodeHostEvent
  readonly occurredAt: number
}): readonly EventObservationInput[] {
  return [codeHostEventObservation(input), codeHostBusinessEventObservation(input)]
}

export function codeHostEventObservation(input: {
  readonly endpointId: string
  readonly deliveryId: string
  readonly event: CodeHostEvent
  readonly occurredAt: number
}): EventObservationInput {
  const allParameters = eventVarsOf(input.event)
  const triggerParameters = Object.fromEntries(
    WEBHOOK_EVENT_VAR_MATRIX[input.event.eventType].map((field) => [field, allParameters[field]]),
  )
  return {
    sourceRef: CODE_HOST_EVENT_SOURCE_REF,
    eventTypeRef: codeHostEventTypeRef(input.event.eventType),
    subject: {
      typeId: 'code-host.repository',
      subjectRef: `${input.endpointId}:${input.event.repoPath}`,
    },
    occurredAt: input.occurredAt,
    // Provider delivery UUID is stable across transport retries. The raw row
    // id remains the fallback for providers/events without such an identity;
    // explicit platform replay clears eventUuid and therefore stays a new
    // occurrence by design.
    dedupeKey: `webhook:${input.endpointId}:${input.event.eventUuid ?? input.deliveryId}`,
    summary: `${EVENT_NAMES[input.event.eventType]['zh-CN']} · ${input.event.repoPath}`,
    payloadArtifactRef: `webhook-delivery:${input.deliveryId}`,
    routingFactsJson: JSON.stringify(
      codeHostWebhookRoutingFactsOf(input.endpointId, input.deliveryId, input.event),
    ),
    triggerParameters,
  }
}
