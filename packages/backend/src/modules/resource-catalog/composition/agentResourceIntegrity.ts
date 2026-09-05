import type { AclResourceType } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { createDatabaseAgentResourceInventoryReadPort } from '../infrastructure/agentResourceInventory'
import { isSkillAvailableThisBoot } from '../infrastructure/legacy/skillBootVerify'
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

/** 数据库句柄直入的装配：一份实现，两个 provider 共用（RFC-359 W4-D14）。消费者只拿到闭合的 source。 */
export function composeDatabaseAgentResourceInventorySource(input: {
  readonly db: ProviderNeutralDatabase
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceInventorySource {
  return composeAgentResourceInventorySource({
    inventory: createDatabaseAgentResourceInventoryReadPort({
      db: input.db,
      skillAvailability,
    }),
    authorization: input.authorization,
  })
}

export function composeDatabaseAgentResourceIntegrity(input: {
  readonly db: ProviderNeutralDatabase
  readonly authorization: ResourceAuthorizationApplication
}): AgentResourceIntegrityComposition {
  return composeAgentResourceIntegrity(composeDatabaseAgentResourceInventorySource(input))
}
