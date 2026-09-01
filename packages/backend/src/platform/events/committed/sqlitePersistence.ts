// RFC-349 — SQLite adapter for the committed-event Promise port. The legacy
// synchronous store remains the single SQLite behavior implementation.
import type { DbClient } from '@/db/client'
import {
  acceptCommittedEventDelivery,
  claimNextCommittedEventDelivery,
  committedEventDeliveryHealth,
  committedEventDeliveryPage,
  getStoredCommittedEvents,
  rejectCommittedEventDelivery,
  retryCommittedEventDelivery,
} from './sqliteStore'
import type { CommittedEventDeliveryPersistencePort } from './persistence'

export function createSqliteCommittedEventDeliveryPersistence(
  db: DbClient,
): CommittedEventDeliveryPersistencePort {
  return {
    async getStored(eventIds) {
      return getStoredCommittedEvents(db, eventIds)
    },
    async claimNext(input) {
      return claimNextCommittedEventDelivery({ db, ...input })
    },
    async accept(input) {
      acceptCommittedEventDelivery({ db, ...input })
    },
    async reject(input) {
      return rejectCommittedEventDelivery({ db, ...input })
    },
    async retry(input) {
      return retryCommittedEventDelivery(db, input)
    },
    async deliveryPage(input) {
      return committedEventDeliveryPage(db, input)
    },
    async health() {
      return committedEventDeliveryHealth(db)
    },
  }
}
