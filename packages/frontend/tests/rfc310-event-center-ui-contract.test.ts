import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const FRONTEND = resolve(import.meta.dirname, '..', 'src')
const events = readFileSync(resolve(FRONTEND, 'routes', 'events.tsx'), 'utf8')
const employees = readFileSync(resolve(FRONTEND, 'routes', 'digital-employees.tsx'), 'utf8')
const webhooks = readFileSync(resolve(FRONTEND, 'routes', 'webhooks.tsx'), 'utf8')
const triggers = readFileSync(
  resolve(FRONTEND, 'components', 'webhooks', 'TriggersPanel.tsx'),
  'utf8',
)
const responseRules = readFileSync(
  resolve(FRONTEND, 'components', 'events', 'EventResponseRulesPanel.tsx'),
  'utf8',
)

describe('RFC-310 global Event Center UI contract', () => {
  test('is a global operations route instead of a digital-employee tab', () => {
    expect(events).toContain("path: '/events'")
    expect(events).toContain("title={zh ? '事件中心' : 'Event Center'}")
    expect(events).toContain('数字员工、工作流和集成都可以复用')
    expect(employees).toContain("redirect({ to: '/events' })")
    expect(employees).not.toContain('<EventCenterPanel')
  })

  test('makes the next authoring action and deterministic script boundary visible', () => {
    expect(events).toContain('data-testid="event-source-new"')
    expect(events).toContain('AW_EVENT_INPUT_FILE')
    expect(events).toContain('aw-event-observer@1')
    expect(events).toContain('data-testid="event-source-validate"')
    expect(events).toContain('data-testid="event-source-publish"')
    expect(events).toContain("'state-change'")
    expect(events).toContain("'occurrence'")
    expect(events).toContain("zh ? '参数命名空间' : 'Parameter namespace'")
    expect(events).toContain('key={field.editorKey}')
    expect(events).toContain('triggerNamespaceFromEventKey(event.eventKey)')
    expect(events).not.toContain("namespace: 'custom_event'")
  })

  test('owns Webhook as a push-source family and retires the standalone navigation page', () => {
    expect(events).toContain("{zh ? '事件来源' : 'Sources'}")
    expect(events).toContain('<WebhookEndpointCard')
    expect(events).toContain('<TriggersPanel')
    expect(events).toContain('<DeliveriesPanel')
    expect(webhooks).toContain("to: '/events'")
    expect(webhooks).toContain("? ('sources' as const)")
    expect(webhooks).toContain("? ('subscriptions' as const)")
    expect(webhooks).toContain(
      'Webhook is a push-based source family inside the global Event Center',
    )
  })

  test('makes multicast delivery state explicit instead of consuming the event once', () => {
    expect(events).toContain('一条事件可以同时交给多个消费者')
    expect(events).toContain('每个订阅都会生成自己的投递')
    expect(events).toContain('data-testid="event-delivery-list"')
    expect(events).toContain('delivery.eventId')
    expect(events).toContain('delivery.deliveryId')
  })

  test('authors Digital Employee WorkStart from the published intake contract', () => {
    expect(triggers).toContain("value: 'digital-employee'")
    expect(triggers).toContain('workIntakeAuthoring')
    expect(triggers).toContain('supportedEmployeeIntakeKinds')
    expect(triggers).toContain('authority="webhook:digital-employee:employee-target"')
    expect(triggers).toContain('authority="webhook:digital-employee:employee-body"')
    expect(triggers).toContain('authority="webhook:digital-employee:employee-external-id"')
    expect(triggers).toContain('f.employeeCaseId')
    expect(triggers).toContain('to="/tasks/employee-cases/$caseId"')
  })

  test('selects every public contracted event instead of hard-coding Webhook event names', () => {
    expect(events).toContain('<EventResponseRulesPanel')
    expect(responseRules).toContain('return props.catalog.eventTypes')
    expect(responseRules).toContain('.filter((event) => event.triggerParameters !== null)')
    expect(responseRules).toContain("'/api/event-center/response-rules'")
    expect(responseRules).toContain('event-response-rule-event')
    expect(responseRules).toContain('这里选择的是稳定事实，不选择 Webhook 或轮询方式。')
    expect(responseRules).toContain('selectedEvent.subjectTypeId')
    expect(responseRules).toContain('event:workflow:input')
    expect(responseRules).toContain('event:digital-employee:target')
    expect(events).toContain('现有代码平台 Webhook 规则')
  })
})
