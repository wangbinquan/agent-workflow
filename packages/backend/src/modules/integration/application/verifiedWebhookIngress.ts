// RFC-370: verified transport deliveries use the same admission/publication
// path. Provider parsing and transport authentication belong to inbound adapters.
import { createLogger } from '@/util/log'
import { codeHostEventObservations } from '../public/events'
import type { VerifiedWebhookIngressCommands } from '../public/commands'
import type { VerifiedWebhookIngressDependencies } from './ports/verifiedWebhookIngress'

const log = createLogger('webhook-ingress')

export function createVerifiedWebhookIngress(
  deps: VerifiedWebhookIngressDependencies,
): VerifiedWebhookIngressCommands {
  return Object.freeze({
    async receive(input) {
      const insert = await deps.persistence.accept(input)
      const deliveryId = insert.deliveryId
      deps.wakeTerminalControl(insert.effectId)
      let published: { deliveryCount: number; deliveryIds: readonly string[] }
      try {
        const occurredAt = deps.now()
        const receipts = await Promise.all(
          codeHostEventObservations({
            endpointId: input.endpointId,
            deliveryId,
            event: input.event,
            occurredAt,
          }).map((observation) => deps.events.observe(observation)),
        )
        published = {
          deliveryCount: receipts.reduce((total, receipt) => total + receipt.deliveryCount, 0),
          deliveryIds: receipts.flatMap((receipt) => receipt.deliveryIds),
        }
      } catch (error) {
        // Preserve resend repair: only a newly inserted audit row releases its
        // provider UUID after publication failure; a duplicate keeps its history.
        if (insert.kind === 'inserted') {
          await deps.audit
            .mark({ deliveryId, status: 'failed', reason: 'internal-error' })
            .catch(() => {})
        }
        throw error
      }
      for (const eventDeliveryId of published.deliveryIds) {
        void deps.events.notify(eventDeliveryId).catch((error: unknown) => {
          log.error('event notification delivery failed', {
            deliveryId,
            eventDeliveryId,
            error: String(error),
          })
        })
      }
      if (published.deliveryCount > 0) {
        await deps.audit.mark({ deliveryId, status: 'matched' })
      } else if (insert.effectId !== null) {
        await deps.audit.mark({
          deliveryId,
          status: 'matched',
          reason: 'terminal-control-accepted',
        })
      } else {
        await deps.audit.mark({ deliveryId, status: 'ignored', reason: 'no-trigger-matched' })
      }
      if (insert.kind === 'duplicate') {
        return { deliveryId, status: 'duplicate', attemptCount: insert.attemptCount }
      }
      if (input.event.mrIid !== undefined) {
        try {
          void deps.events.nudge()
        } catch (error) {
          log.warn('digital employee event observer nudge failed', {
            deliveryId,
            error: String(error),
          })
        }
      }
      void deps.audit.touchEndpointLastDelivery(input.endpointId, deps.now()).catch(() => {})
      return { deliveryId, status: 'received' }
    },
  } satisfies VerifiedWebhookIngressCommands)
}
