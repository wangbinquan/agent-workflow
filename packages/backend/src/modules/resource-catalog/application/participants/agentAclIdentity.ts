import type { Agent } from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import type { AgentAclIdentityParticipant } from '../../public/participants'
import type { AgentAclIdentity } from '../../public/types'
import type { AgentMutationClock, AgentRepository } from '../agents/ports'

const trustedAgentAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: Agent | null): AgentAclIdentity | null {
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

export function createAgentAclIdentityParticipant(input: {
  readonly repository: AgentRepository
  readonly clock: AgentMutationClock
}): AgentAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<AgentAclIdentity | null> {
      return identityOf(await input.repository.get(id))
    },
    async nextUpdatedAt(id: string): Promise<number> {
      const row = await input.repository.get(id)
      if (row === null) throw new NotFoundError('agent-not-found', 'agent not found')
      return input.clock.nextUpdatedAt(row)
    },
  }) as unknown as AgentAclIdentityParticipant
  trustedAgentAclIdentityParticipants.add(participant)
  return participant
}
