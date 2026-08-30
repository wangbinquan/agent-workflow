import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const FRONTEND = resolve(import.meta.dirname, '..', 'src')
const events = readFileSync(resolve(FRONTEND, 'routes', 'events.tsx'), 'utf8')
const styles = readFileSync(resolve(FRONTEND, 'styles.css'), 'utf8')

describe('RFC-341 Event Center committed delivery operations', () => {
  test('keeps producer and consumer delivery state inside the consolidated activity table', () => {
    expect(events).toContain("value: 'committed'")
    expect(events).toContain("label: zh ? '平台投递' : 'Platform deliveries'")
    expect(events).toContain('/api/event-center/committed-deliveries/page')
    expect(events).toContain('data-testid="event-delivery-kind-filter"')
    expect(events).toContain('committed-delivery-stage-filter')
    expect(events).toContain('committed-delivery-family-filter')
    expect(events).toContain('committed-delivery-aggregate-filter')
    expect(events).toContain('committed-delivery-consumer-filter')
  })

  test('shows shadow ownership, bounded retry state and expandable errors', () => {
    expect(events).toContain("delivery.mode === 'shadow'")
    expect(events).toContain('delivery.attemptCount')
    expect(events).toContain('delivery.nextAttemptAt')
    expect(events).toContain('delivery.lastErrorSummary')
    expect(events).toContain('className="event-center-committed-error"')
    expect(events).toContain('observedLeaseEpoch: delivery.leaseEpoch')
    expect(events).toContain('observedUpdatedAt: Date.parse(delivery.updatedAt)')
    expect(events).toContain('retryCommittedDelivery.mutate(delivery)')
    expect(styles).toContain('.event-center-committed-error')
  })
})
