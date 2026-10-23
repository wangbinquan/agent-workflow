import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'

/** RFC-395 II-a A5：引用按 kind 保留声明顺序与重复项，归一化由原入口决定。 */
export interface AgentReferenceWriteParticipant {
  insert(input: {
    readonly id: string
    readonly agent: CreateAgent
    readonly ownerUserId: string
    readonly now: number
    readonly visibility?: 'public' | 'private'
    readonly builtin?: boolean
  }): Promise<readonly (Agent & { readonly aclRevision: number })[]>
  update(input: {
    readonly current: Agent
    readonly patch: UpdateAgent
    readonly updatedAt: number
    readonly expectedUpdatedAt: number
    readonly expectedAclRevision: number
    readonly ownerUserId?: string
    readonly builtin?: boolean
  }): Promise<readonly (Agent & { readonly aclRevision: number })[]>
}
