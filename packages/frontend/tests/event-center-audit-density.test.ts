// Regression for the Event Center activity-page report from 2026-08-30:
// the four-way segmented strip was clipped on the right, repeated the same
// audit hierarchy as peer tabs, and each three-line card consumed too much of
// the viewport. Keep one record-scope filter, one dense table shape, and
// expandable evidence instead of restoring parallel tall card lists.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const FRONTEND = resolve(import.meta.dirname, '..', 'src')
const events = readFileSync(resolve(FRONTEND, 'routes', 'events.tsx'), 'utf8')
const filterBar = readFileSync(resolve(FRONTEND, 'components', 'FilterBar.tsx'), 'utf8')
const deliveries = readFileSync(
  resolve(FRONTEND, 'components', 'webhooks', 'DeliveriesPanel.tsx'),
  'utf8',
)
const styles = readFileSync(resolve(FRONTEND, 'styles.css'), 'utf8')
const activityStart = events.indexOf("{tab === 'deliveries' ? (")
const activityEnd = events.indexOf('{editor !== null ?', activityStart)
const activity = events.slice(activityStart, activityEnd)

describe('Event Center compact activity ledger', () => {
  test('replaces the clipped four-way tab strip with one record-scope filter', () => {
    expect(events).toContain('data-testid="event-delivery-kind-filter"')
    expect(events).toContain("label: zh ? '订阅投递' : 'Subscriber deliveries'")
    expect(events).toContain("label: zh ? '平台投递' : 'Platform deliveries'")
    expect(events).toContain("label: zh ? '来源事件' : 'Source events'")
    expect(events).toContain("label: zh ? 'Webhook 接入' : 'Webhook ingress'")
    expect(activity).not.toContain('event-center-view-switcher')
    expect(events.match(/event-center-view-switcher/g)).toHaveLength(1)
  })

  test('uses the shared compact table and keeps complete evidence behind row expansion', () => {
    expect(events).toContain('data-table data-table--compact event-center-audit-table')
    expect(events).toContain('<OperationsExpandButton')
    expect(events).toContain('<RelativeTime')
    expect(events).toContain('className="event-center-audit-details"')
    expect(events).toContain('delivery.lastErrorSummary')
    expect(events).toContain('event.payloadArtifactRef')
    expect(styles).toContain('.event-center-audit-table__clip')
    expect(styles).toContain('.event-center-audit-details')
    expect(styles).toMatch(
      /\.event-center-page \.event-center-audit \.table-viewport__scroller\s*\{[^}]*overflow-x: auto;[^}]*\}/,
    )
  })

  test('reserves Event Center tab gutters inside the viewport and reuses compact filter chrome', () => {
    expect(styles).toContain(
      '.event-center-page > .operations-surface > .tabs-viewport > .repo-kind-tabs',
    )
    expect(styles).toContain('padding-inline: clamp(16px, 3vw, 22px)')
    expect(filterBar).toContain("props.density === 'compact'")
    expect(deliveries).toContain("density={compact ? 'compact' : 'default'}")
    expect(events).toContain('<DeliveriesPanel canReplay={canManageEndpoints} compact />')
  })
})
