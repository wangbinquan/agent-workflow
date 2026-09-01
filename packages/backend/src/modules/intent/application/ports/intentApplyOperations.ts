import type { Actor } from '@/auth/actor'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'

export interface IntentApplyDecision {
  readonly opId: string
  readonly applyMode?: 'modify' | 'copy'
  readonly slots?: Array<{ readonly slotId: string; readonly value: string }>
}

export interface IntentApplyInput {
  readonly sessionId: string
  readonly clientMutationId: string
  readonly draftRevision: number
  readonly draftHash: string
  readonly decisions: IntentApplyDecision[]
}

export interface IntentApplyReceipt {
  readonly journalId: string
  readonly commitSeq: number
  readonly applied: Array<{
    opId: string
    resourceType: string
    resourceId: string
    action: 'create' | 'update'
    fromCopy: boolean
    name: string
  }>
}

/** Provider-neutral command seam consumed by HTTP/CLI transports. */
export interface IntentApplyOperations {
  apply(input: {
    readonly actor: Actor
    readonly authority: ResourceRequestContext
    readonly command: IntentApplyInput
  }): Promise<IntentApplyReceipt>
}
