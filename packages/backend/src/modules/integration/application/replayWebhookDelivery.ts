// RFC-437 — Webhook 投递重放用例（自 routes/webhookDeliveries.ts 抽出，规则、错误码与文案逐条不变）。
//
// replay 三规则（multica）：rejected 不可放（绕过拒绝=绕过验签）；重放新建行指回 replayed_from；
// event_uuid=NULL 绕过去重（replay 就是明确要求再跑一次）。GitLab 对失败投递不自动重试
// （RFC-257 设计门 F-6）——replay 是平台侧的主恢复路径。
//
// 可用性（事件中心与支持事件中心投递的分发器都已接线）由 composition 判定：不可用时
// composition 不构造本用例，绑定直接报 409 `webhook-ingress-unavailable`。
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { CODE_HOST_ADAPTERS, replayHeaders } from '../domain/codeHostAdapters'
import { codeHostEventObservations } from '../public/events'
import type { VerifiedWebhookIngressDependencies } from './ports/verifiedWebhookIngress'
import type { WebhookDeliveryRuntime } from './ports/webhookDeliveryRuntime'
import { webhookDeliveryOutcome } from './webhookDeliveryOutcome'

export interface WebhookDeliveryReplayReceipt {
  readonly deliveryId: string
  readonly replayedFrom: string
  readonly status: 'received'
}

export interface WebhookDeliveryReplay {
  replay(deliveryId: string): Promise<WebhookDeliveryReplayReceipt>
}

export interface WebhookDeliveryReplayDependencies {
  readonly runtime: WebhookDeliveryRuntime
  readonly events: Pick<VerifiedWebhookIngressDependencies['events'], 'observe' | 'notify'>
  readonly wakeTerminalControl: (effectId: string | null) => void
  readonly now: () => number
}

export function createWebhookDeliveryReplay(
  deps: WebhookDeliveryReplayDependencies,
): WebhookDeliveryReplay {
  const runtime = deps.runtime
  return Object.freeze({
    async replay(id: string): Promise<WebhookDeliveryReplayReceipt> {
      const row = await runtime.queries.get(id)
      if (!row) throw new NotFoundError('webhook-delivery-not-found', 'delivery not found')
      if (row.status === 'rejected') {
        // 重放验签失败的投递 = 绕过拒绝（multica 规则 1）。
        throw new ConflictError('webhook-delivery-rejected-not-replayable', 'fix the secret first')
      }
      if (row.status === 'received' || row.status === 'processing') {
        throw new ConflictError('webhook-delivery-in-flight', 'delivery is still being processed')
      }
      if (row.bodyJson === null || row.bodyJson === '') {
        // 保留策略把 body 置空后（F-12），重放无料可用。
        throw new ConflictError('webhook-delivery-body-gone', 'body pruned by retention policy')
      }
      const endpoint = await runtime.endpoints.get(row.endpointId)
      if (!endpoint) {
        throw new ConflictError('webhook-endpoint-not-found', 'owning endpoint was deleted')
      }
      const adapter = CODE_HOST_ADAPTERS[endpoint.provider]
      if (!adapter) throw new ConflictError('webhook-provider-unknown', endpoint.provider)
      let parsed: unknown
      try {
        parsed = JSON.parse(row.bodyJson)
      } catch {
        throw new ValidationError('webhook-delivery-body-invalid', 'stored body is not JSON')
      }
      // RFC-259：事件头从审计列重建——GitHub 的事件种类判别在 X-GitHub-Event
      // 头里不在 body 里，空 HeaderBag 会把每条 GitHub 投递的 replay 判成
      // parse-failed（GitLab 判别在 body.object_kind，重建对它是 no-op）。
      const normalized = adapter.normalize(replayHeaders(adapter, row.gitlabEventHeader), parsed)
      if (!normalized.ok) {
        throw new ValidationError('webhook-delivery-unsupported', normalized.detail)
      }
      const event = { ...normalized.event, eventUuid: null }
      const rootDeliveryId = row.replayedFromDeliveryId ?? row.id
      const root = rootDeliveryId === row.id ? row : await runtime.queries.get(rootDeliveryId)
      if (root === null) {
        throw new ConflictError(
          'webhook-delivery-replay-lineage-broken',
          'original delivery is no longer available',
        )
      }
      const isTerminal = event.eventType === 'mr_closed' || event.eventType === 'mr_merged'
      if (isTerminal) {
        if (root.mrStreamRevision === null) {
          throw new ConflictError(
            'webhook-terminal-replay-root-unprotected',
            'the original terminal delivery predates the durable MR/PR control fact',
          )
        }
        if (!(await runtime.queries.hasTerminalControlEffect(rootDeliveryId))) {
          throw new ConflictError(
            'webhook-terminal-replay-effect-missing',
            'the original terminal control effect is unavailable',
          )
        }
      }
      const insert = await runtime.acceptVerifiedDelivery({
        endpointId: endpoint.id,
        event,
        rawBodyBytes: Buffer.from(row.bodyJson, 'utf8'),
        rawBodyText: row.bodyJson,
        eventHeader: row.gitlabEventHeader,
        objectKind: row.objectKind,
        replay: {
          rootDeliveryId,
          terminalRootRevision: isTerminal ? root.mrStreamRevision : null,
        },
      })
      if (insert.kind !== 'inserted') {
        throw new ConflictError('webhook-delivery-replay-conflict', 'replay was deduplicated')
      }
      const deliveryId = insert.deliveryId
      deps.wakeTerminalControl(insert.effectId)
      const occurredAt = deps.now()
      const receipts = await Promise.all(
        codeHostEventObservations({
          endpointId: endpoint.id,
          deliveryId,
          event,
          occurredAt,
        }).map((observation) => deps.events.observe(observation)),
      )
      const published = {
        deliveryCount: receipts.reduce((total, receipt) => total + receipt.deliveryCount, 0),
        deliveryIds: receipts.flatMap((receipt) => receipt.deliveryIds),
      }
      // 与已验证接收同一份结论：有订阅者命中 → matched；无订阅者而终态控制已受理 →
      // matched / terminal-control-accepted；否则 ignored / no-trigger-matched。
      await runtime.deliveries.mark({
        deliveryId,
        ...webhookDeliveryOutcome({
          deliveryCount: published.deliveryCount,
          effectId: insert.effectId,
        }),
      })
      for (const eventDeliveryId of published.deliveryIds) {
        void deps.events.notify(eventDeliveryId).catch(() => {})
      }
      return { deliveryId, replayedFrom: row.id, status: 'received' }
    },
  })
}
