import type { Workgroup } from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import type { WorkgroupAclIdentityParticipant } from '../../public/participants'
import type { WorkgroupAclIdentity } from '../../public/types'
import type { WorkgroupMutationClock, WorkgroupRepository } from '../workgroups/ports'

const trustedWorkgroupAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: Workgroup | null): WorkgroupAclIdentity | null {
  if (row === null) return null
  return Object.freeze({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    visibility: row.visibility ?? 'public',
    updatedAt: row.updatedAt,
  })
}

export function createWorkgroupAclIdentityParticipant(input: {
  readonly repository: WorkgroupRepository
  readonly clock: WorkgroupMutationClock
}): WorkgroupAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<WorkgroupAclIdentity | null> {
      return identityOf(await input.repository.get(id))
    },
    async nextUpdatedAt(id: string): Promise<number> {
      const row = await input.repository.get(id)
      if (row === null) {
        throw new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
      }
      return input.clock.nextUpdatedAt(row)
    },
  }) as unknown as WorkgroupAclIdentityParticipant
  trustedWorkgroupAclIdentityParticipants.add(participant)
  return participant
}
