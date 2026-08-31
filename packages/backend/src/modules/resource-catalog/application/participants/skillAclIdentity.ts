import type { Skill } from '@agent-workflow/shared'
import { NotFoundError } from '@/util/errors'
import type { SkillAclIdentityParticipant } from '../../public/participants'
import type { SkillAclIdentity } from '../../public/types'
import type { SkillMutationClock, SkillRepository } from '../skills/ports'

const trustedSkillAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: Skill | null): SkillAclIdentity | null {
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

export function createSkillAclIdentityParticipant(input: {
  readonly repository: SkillRepository
  readonly clock: SkillMutationClock
}): SkillAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<SkillAclIdentity | null> {
      return identityOf(await input.repository.get(id))
    },
    async nextUpdatedAt(id: string): Promise<number> {
      const row = await input.repository.get(id)
      if (row === null) throw new NotFoundError('skill-not-found', 'skill not found')
      return input.clock.nextUpdatedAt(row)
    },
  }) as unknown as SkillAclIdentityParticipant
  trustedSkillAclIdentityParticipants.add(participant)
  return participant
}
