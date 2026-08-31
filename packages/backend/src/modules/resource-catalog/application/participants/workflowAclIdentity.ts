import type { WorkflowAclIdentityParticipant } from '../../public/participants'
import type { WorkflowAclIdentity } from '../../public/types'
import type { WorkflowRepository } from '../workflows/ports'

const trustedWorkflowAclIdentityParticipants = new WeakSet<object>()

function identityOf(row: WorkflowAclIdentity | null): WorkflowAclIdentity | null {
  if (row === null) return null
  return Object.freeze({ ...row })
}

export function createWorkflowAclIdentityParticipant(input: {
  readonly repository: WorkflowRepository
}): WorkflowAclIdentityParticipant {
  const participant = Object.freeze({
    async load(id: string): Promise<WorkflowAclIdentity | null> {
      return identityOf(await input.repository.getAclIdentity(id))
    },
  }) as unknown as WorkflowAclIdentityParticipant
  trustedWorkflowAclIdentityParticipants.add(participant)
  return participant
}
