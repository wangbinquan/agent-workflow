import { describe, expect, test } from 'vitest'

import {
  customEventObserverStarter,
  syncManagedObserverSource,
  type CustomObserverTemplateEvent,
} from '@/lib/events/customEventObserverTemplate'

const event = (
  fields: readonly string[],
  eventKey = 'status.changed',
): CustomObserverTemplateEvent => ({
  eventKey,
  triggerParameters:
    fields.length === 0
      ? null
      : {
          fields: fields.map((fieldId) => ({ fieldId })),
        },
})

describe('custom event observer starter', () => {
  test('refreshes every language template when a managed parameter contract changes', () => {
    const events = [event(['issue_id', 'state'])]

    for (const language of ['node', 'python', 'bash'] as const) {
      const source = syncManagedObserverSource({
        language,
        source: 'old generated source',
        templateManaged: true,
        events,
      })
      expect(source).toContain('issue_id')
      expect(source).toContain('state')
      expect(source).not.toBe('old generated source')
    }
  })

  test('never overwrites a script after the user has edited it', () => {
    const source = '# operator-owned script\nexit 0'
    expect(
      syncManagedObserverSource({
        language: 'bash',
        source,
        templateManaged: false,
        events: [event(['new_parameter'])],
      }),
    ).toBe(source)
  })

  test('renders every event contract while selecting one emitted event explicitly', () => {
    const source = customEventObserverStarter('node', [
      event(['issue_id']),
      event(['approval_id'], 'approval.changed'),
    ])
    expect(source).toContain('case "status.changed"')
    expect(source).toContain('case "approval.changed"')
    expect(source).toContain('const eventKey = "status.changed"')
  })
})
