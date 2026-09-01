// RFC-345 T4b — bootstrap-owned binding for the current Intent lifecycle.

import {
  createLegacyIntentApplyResourceSession,
  type LegacyIntentApplyResourceDependencies,
  type LegacyIntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'
import type { ResourceCatalogAclIdentityReadPort } from '../application/ports/providerResourceCatalogPersistence'
import {
  createPostgresqlIntentApplyResourceSession,
  type PostgresqlIntentApplyResourceSession,
  type PostgresqlIntentApplyResourceSessionOptions,
} from '../infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants'
import {
  createPostgresqlIntentApplyResourcePortFactory,
  type PostgresqlIntentApplyResourcePortFactoryDependencies,
} from '../infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts'

export function composeIntentApplyResourceBinding(
  dependencies: LegacyIntentApplyResourceDependencies,
  aclIdentities: ResourceCatalogAclIdentityReadPort,
) {
  return Object.freeze({
    createSession(options: LegacyIntentApplyResourceSessionOptions) {
      return createLegacyIntentApplyResourceSession(options, dependencies, aclIdentities)
    },
  })
}

export interface PostgresqlIntentApplyResourceCompositionDependencies extends PostgresqlIntentApplyResourcePortFactoryDependencies {
  readonly aclIdentities: ResourceCatalogAclIdentityReadPort
}

/**
 * Exact PostgreSQL binding consumed by Intent's provider-owned atomic commit
 * port. The factory closes over Resource Catalog persistence/lifecycles; the
 * caller supplies only the admitted authority pair and later its reserved
 * transaction.
 */
export function composePostgresqlIntentApplyResourceBinding(
  input: PostgresqlIntentApplyResourceCompositionDependencies,
): Readonly<{
  createSession(
    options: PostgresqlIntentApplyResourceSessionOptions,
  ): PostgresqlIntentApplyResourceSession
}> {
  const factory = createPostgresqlIntentApplyResourcePortFactory(input)
  return Object.freeze({
    createSession(options) {
      return createPostgresqlIntentApplyResourceSession(
        options,
        input.aclIdentities,
        factory.create(options),
      )
    },
  })
}
