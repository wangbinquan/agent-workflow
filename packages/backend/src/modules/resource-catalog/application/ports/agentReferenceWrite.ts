import type { Agent, CreateAgent, UpdateAgent } from '@agent-workflow/shared'

export interface AgentReferenceInsertInput {
  readonly id: string
  readonly agent: CreateAgent
  readonly ownerUserId: string
  readonly now: number
  readonly visibility?: 'public' | 'private'
  readonly builtin?: boolean
}

/**
 * agent 行与有序引用的写入程序：引用按给出的顺序逐行写入。规范化（含 RFC-401 design §2.4 的去重）由唯一的 agent 写入
 * 参与者在调用前完成，本层不改写引用。
 */
export interface AgentReferenceWriteParticipant {
  insert(
    input: AgentReferenceInsertInput,
  ): Promise<readonly (Agent & { readonly aclRevision: number })[]>
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
