// RFC-370 H8 / v3 V8 — `POST /integrations/crewstation/events`, CrewStation's
// service-domain delivery of code-host producer events. It exists only in the
// hosted deployment, where it is the only code-host event entry (there is no
// direct webhook ingress). The platform's `cs-events` source token
// authenticates the call; a user identity or an upstream signature never does.
// The answer is 204 once the delivery is durable; every refusal is a typed
// error with its status, rendered by the shared error handler, so CrewStation
// retries it and eventually dead-letters it.
import type { Hono } from 'hono'
import { registerRoute } from '@/routes/registry'
import type { CrewStationEventIngressCommands } from '../../application/crewStationEventIngress'
import {
  CrewStationEventError,
  inboundCrewStationDelivery,
  type CrewStationEventSource,
} from '../../infrastructure/crewstation/eventContract'

const MAX_BODY_BYTES = 1024 * 1024

async function readLimitedBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  if (reader)
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel()
        throw new CrewStationEventError(413, 'event-body-too-large')
      }
      chunks.push(chunk.value)
    }
  return Buffer.concat(chunks)
}

export function mountCrewStationEventRoutes(
  app: Hono,
  deps: {
    readonly ingress: Pick<CrewStationEventIngressCommands, 'receive'>
    readonly sources: readonly CrewStationEventSource[]
    readonly verifySource: (token: string) => Promise<boolean>
  },
): void {
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/integrations/crewstation/events',
      permissions: [],
      tokenAccess: 'allow',
      publicReason:
        'CrewStation service-domain delivery; verifies the signed platform cs-events source token and audience, never user identity or upstream signature headers',
      summary: 'Persist a CrewStation event delivery',
    },
    async (c) => {
      const token = c.req.header('x-cs-source-token')
      if (!token || !(await deps.verifySource(token)))
        throw new CrewStationEventError(401, 'invalid-event-source-token')
      const body = await readLimitedBody(c.req.raw)
      let value: unknown
      try {
        value = JSON.parse(body.toString('utf8'))
      } catch {
        throw new CrewStationEventError(400, 'invalid-event-json')
      }
      await deps.ingress.receive(
        inboundCrewStationDelivery(
          value,
          {
            deliveryId: c.req.header('x-cs-delivery-id'),
            eventType: c.req.header('x-cs-event-type'),
            attempt: c.req.header('x-cs-delivery-attempt'),
          },
          deps.sources,
        ),
      )
      return c.body(null, 204)
    },
  )
}
