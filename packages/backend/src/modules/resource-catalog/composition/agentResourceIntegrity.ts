import type { AclResourceType } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { isSkillAvailableThisBoot } from '../infrastructure/legacy/skillBootVerify'
import { createPostgresqlAgentResourceInventoryReadPort } from '../infrastructure/postgresqlAgentResourceInventory'
import { createSqliteAgentResourceInventoryReadPort } from '../infrastructure/sqliteAgentResourceInventory'
import type {
  AgentResourceInventoryReadPort,
  AgentResourceInventorySource,
} from '../application/agents/ports'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import type { AgentOperationContext } from '../public/participants'
import type { AgentLaunchResourceIntegrityParticipant } from '../public/participants'
import type { AgentResourceIntegrityQueries } from '../public/queries'
import {
  createAgentLaunchResourceIntegrityParticipant,
  createAgentResourceIntegrityQueries,
} from '../application/agents/agentResourceIntegrity'

export interface AgentResourceIntegrityComposition {
  readonly queries: AgentResourceIntegrityQueries
  readonly launch: AgentLaunchResourceIntegrityParticipant
}

/** Close the provider inventory behind public query and launch capabilities. */
export function composeAgentResourceIntegrity(
  source: AgentResourceInventorySource,
): AgentResourceIntegrityComposition {
  return Object.freeze({
    queries: createAgentResourceIntegrityQueries(source),
    launch: createAgentLaunchResourceIntegrityParticipant(source),
  })
}

/** Bind a provider inventory reader to the common visibility application. */
export function composeAgentResourceInventorySource(input: {
  readonly inventory: AgentResourceInventoryReadPort
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceInventorySource {
  return Object.freeze({
    load: () => input.inventory.load(),
    filterVisible<
      T extends {
        readonly id: string
        readonly ownerUserId?: string | null
        readonly visibility?: 'public' | 'private'
      },
    >(
      authority: AgentOperationContext,
      type: AclResourceType,
      rows: readonly T[],
    ): Promise<readonly T[]> {
      return input.authorization.filterVisibleRows(authority, type, rows)
    },
  })
}

const skillAvailability = Object.freeze({
  isAvailable(entry: {
    readonly skill: { readonly id: string }
    readonly reservationState: string | null
    readonly versionState: string | null
  }): boolean {
    return (
      entry.reservationState === 'ready' &&
      isSkillAvailableThisBoot({
        id: entry.skill.id,
        reservationState: entry.reservationState,
        versionState: entry.versionState,
      })
    )
  },
})

/** Provider-private SQLite composition; consumers receive only the closed source. */
export function composeSqliteAgentResourceInventorySource(input: {
  readonly db: DbClient
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceInventorySource {
  return composeAgentResourceInventorySource({
    inventory: createSqliteAgentResourceInventoryReadPort({
      db: input.db,
      skillAvailability,
    }),
    authorization: input.authorization,
  })
}

export function composeSqliteAgentResourceIntegrity(input: {
  readonly db: DbClient
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceIntegrityComposition {
  return composeAgentResourceIntegrity(composeSqliteAgentResourceInventorySource(input))
}

/** Provider-private PostgreSQL composition; consumers receive only the closed source. */
export function composePostgresqlAgentResourceInventorySource(input: {
  readonly db: PostgresqlDatabaseClient
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceInventorySource {
  return composeAgentResourceInventorySource({
    inventory: createPostgresqlAgentResourceInventoryReadPort({
      db: input.db,
      skillAvailability,
    }),
    authorization: input.authorization,
  })
}

export function composePostgresqlAgentResourceIntegrity(input: {
  readonly db: PostgresqlDatabaseClient
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceIntegrityComposition {
  return composeAgentResourceIntegrity(composePostgresqlAgentResourceInventorySource(input))
}
