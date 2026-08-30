import type { Mcp } from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import type { McpAclIdentityParticipant } from '../../public/participants'
import type { McpAclIdentity } from '../../public/types'
import type { McpMutationClock, McpRepository } from '../mcps/ports'

const trustedMcpAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: Mcp | null): McpAclIdentity | null {
  if (row === null) return null
  return Object.freeze({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    visibility: row.visibility ?? 'public',
    aclRevision: row.aclRevision ?? 0,
    updatedAt: row.updatedAt,
  })
}

export function createMcpAclIdentityParticipant(input: {
  readonly repository: McpRepository
  readonly clock: McpMutationClock
}): McpAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<McpAclIdentity | null> {
      return identityOf(await input.repository.get(id))
    },
    async nextUpdatedAt(id: string): Promise<number> {
      const row = await input.repository.get(id)
      if (row === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
      return input.clock.next(row)
    },
  }) as unknown as McpAclIdentityParticipant
  trustedMcpAclIdentityParticipants.add(participant)
  return participant
}
