// RFC-370 M3 / v3 V8: a delivery detail states how the delivery was verified and
// where its body came from; a CrewStation-delegated one also names the platform
// event and every platform delivery of it (the raw internal receipt reference
// and the separate raw-JSON inspection route were removed — operators trace a
// delivery with the ids CrewStation's event center shows).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { DeliveriesPanel } from '../src/components/webhooks/DeliveriesPanel'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

let detail: Record<string, unknown>
let client: QueryClient
const row = {
  id: 'delivery',
  endpointId: 'endpoint',
  eventUuid: 'event',
  attemptCount: 1,
  gitlabEventHeader: 'Push Hook',
  objectKind: 'push',
  eventType: 'push',
  repoPath: 'group/repo',
  streamHint: 'group/repo|branch:main',
  status: 'matched',
  statusReason: null,
  replayedFromDeliveryId: null,
  receivedAt: 1700000000000,
}
beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc370-delivery-${crypto.randomUUID()}.test`)
  setToken('token')
  detail = { ...row, terminalControl: null, bodyJson: '{"hello":"world"}' }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/webhook-deliveries')
      return Response.json({ items: [row], total: 1, page: 1, pageCount: 1 })
    if (path === '/api/webhook-deliveries/repos') return Response.json(['group/repo'])
    if (path === '/api/webhook-deliveries/delivery') return Response.json(detail)
    throw new Error(`unexpected delivery request ${path}`)
  })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.restoreAllMocks()
})
async function openDetail() {
  render(
    <QueryClientProvider client={client}>
      <DeliveriesPanel />
    </QueryClientProvider>,
  )
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common.details') }))
  const dialog = await screen.findByRole('dialog', {
    name: i18n.t('webhookDeliveries.detailTitle'),
  })
  await within(dialog).findByText('"hello": "world"', { exact: false })
  return within(dialog)
}

test.each(['en-US', 'zh-CN'])(
  'delegated delivery names its platform event and deliveries and explains the body provenance (%s)',
  async (language) => {
    await i18n.changeLanguage(language)
    detail = {
      ...detail,
      verificationMethod: 'cs-delegated',
      bodyRepresentation: 'reserialized-json',
      platformEvent: {
        eventId: '01a0c12a-de09-7005-b0f9-d55a8676540b',
        eventType: 'gitlab.merge-request.open',
        deliveries: [
          { deliveryId: 'delivery-first', attempt: 1, receivedAt: 1700000000000 },
          { deliveryId: 'delivery-again', attempt: 3, receivedAt: 1700000005000 },
        ],
      },
      replayedFromDeliveryId: 'original-delivery',
    }
    const dialog = await openDetail()
    expect(dialog.getByText(i18n.t('webhookDeliveries.verification.cs-delegated'))).toBeTruthy()
    expect(dialog.getByText(i18n.t('webhookDeliveries.bodySources.reserialized-json'))).toBeTruthy()
    expect(dialog.getByText(i18n.t('hostedEvents.platformEvent'))).toBeTruthy()
    expect(dialog.getByTestId('webhook-delivery-platform-event').textContent).toBe(
      '01a0c12a-de09-7005-b0f9-d55a8676540b',
    )
    expect(dialog.getByText('gitlab.merge-request.open', { exact: false })).toBeTruthy()
    const deliveries = dialog.getByTestId('webhook-delivery-platform-deliveries').textContent ?? ''
    expect(deliveries).toContain(
      i18n.t('hostedEvents.platformDelivery', { deliveryId: 'delivery-first', attempt: 1 }),
    )
    expect(deliveries).toContain(
      i18n.t('hostedEvents.platformDelivery', { deliveryId: 'delivery-again', attempt: 3 }),
    )
    expect(dialog.getByText(i18n.t('webhookDeliveries.delegatedExplanation'))).toBeTruthy()
    expect(dialog.queryByText(i18n.t('webhookDeliveries.verification.direct-signature'))).toBeNull()
  },
)

test('direct signature validation and HTTP body remain distinct even for a rejected request', async () => {
  detail = {
    ...detail,
    status: 'rejected',
    verificationMethod: 'direct-signature',
    bodyRepresentation: 'http-bytes',
    platformEvent: null,
  }
  const dialog = await openDetail()
  expect(dialog.getByText('Direct signature validation')).toBeTruthy()
  expect(dialog.getByText('Upstream HTTP body')).toBeTruthy()
  expect(dialog.queryByText('Platform event')).toBeNull()
  expect(dialog.queryByTestId('webhook-delivery-platform-deliveries')).toBeNull()
  expect(dialog.queryByText(i18n.t('webhookDeliveries.delegatedExplanation'))).toBeNull()
})

test('an older response without verification facts is explicitly unknown', async () => {
  const dialog = await openDetail()
  expect(dialog.getAllByText('Not recorded')).toHaveLength(2)
  expect(dialog.queryByText('Direct signature validation')).toBeNull()
})
