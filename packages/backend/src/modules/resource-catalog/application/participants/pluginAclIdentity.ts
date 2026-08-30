import type { Plugin } from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import type { PluginAclIdentityParticipant } from '../../public/participants'
import type { PluginAclIdentity } from '../../public/types'
import type { PluginMutationClock, PluginRepository } from '../plugins/ports'

const trustedPluginAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: Plugin | null): PluginAclIdentity | null {
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

export function createPluginAclIdentityParticipant(input: {
  readonly repository: PluginRepository
  readonly clock: PluginMutationClock
}): PluginAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<PluginAclIdentity | null> {
      return identityOf(await input.repository.get(id))
    },
    async nextUpdatedAt(id: string): Promise<number> {
      const row = await input.repository.get(id)
      if (row === null) {
        throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
      }
      return input.clock.nextUpdatedAt(row)
    },
  }) as unknown as PluginAclIdentityParticipant
  trustedPluginAclIdentityParticipants.add(participant)
  return participant
}
