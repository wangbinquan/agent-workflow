// RFC-370 H8 / v3 V8 — the hosted code-host event ingress, assembled once by
// the hosted bootstrap. No dependency on a local service, provider credential,
// signature header or direct webhook endpoint: in a hosted deployment events
// arrive only through CrewStation, and each source binding's channel comes
// from the deployment configuration (`AW_EVENT_SOURCES`).
import type { Hono } from 'hono'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  createCrewStationEventIngress,
  type CrewStationEventPublisher,
} from '../application/crewStationEventIngress'
import { mountCrewStationEventRoutes } from '../inbound/http/crewstationEvents'
import { createCrewStationEventInbox } from '../infrastructure/crewstation/eventInbox'
import { validateCrewStationEventSources } from '../infrastructure/crewstation/eventContract'

export type { CrewStationEventPublisher } from '../application/crewStationEventIngress'

/** What the hosted assembly wires: the public delivery route and the background worker. */
export interface CrewStationEventIngress {
  /** Mount `POST /integrations/crewstation/events` among the public routes (before authentication). */
  mount(app: Hono): void
  /** Admit and publish the due frozen targets; the hosted event-center loop runs it. */
  runPending(publisher: CrewStationEventPublisher): Promise<number>
}

export function composeCrewStationEventIngress(input: {
  readonly db: PersistenceDb
  readonly installationId: string
  readonly sources: unknown
  readonly fence: CrewStationMutationFence
  readonly verifySource: (token: string) => Promise<boolean>
  readonly now?: () => number
}): CrewStationEventIngress {
  const sources = validateCrewStationEventSources(input.sources)
  const ingress = createCrewStationEventIngress({
    inbox: createCrewStationEventInbox({
      db: input.db,
      installationId: input.installationId,
      fence: input.fence,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
  })
  return Object.freeze({
    mount: (app: Hono) =>
      mountCrewStationEventRoutes(app, { ingress, sources, verifySource: input.verifySource }),
    runPending: (publisher: CrewStationEventPublisher) => ingress.runPending(publisher),
  })
}

export {
  validateCrewStationEventSources as readCrewStationEventSources,
  validateCrewStationEventSubscriptions,
} from '../infrastructure/crewstation/eventContract'
