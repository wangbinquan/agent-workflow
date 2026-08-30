import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { ResourceAclDocument, UpdateResourceAclRequest } from './types'

export interface ResourceAclCommands {
  update(context: CommandContext, request: UpdateResourceAclRequest): Promise<ResourceAclDocument>
}
