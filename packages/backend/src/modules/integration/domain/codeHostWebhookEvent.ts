import {
  type CodeHostEvent,
  type CodeHostEventType,
  CodeHostEventTypeSchema,
  CodeHostProviderSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'

export const codeHostWebhookRoutingFactsSchema = z
  .object({
    provider: CodeHostProviderSchema,
    endpointId: z.string().min(1),
    deliveryId: z.string().min(1),
    eventType: CodeHostEventTypeSchema,
    repoPath: z.string().min(1),
    mrIid: z.string().optional(),
    branch: z.string().optional(),
    targetBranch: z.string().optional(),
    commentText: z.string().optional(),
    authorUsername: z.string().optional(),
  })
  .strict()

export type CodeHostWebhookRoutingFacts = z.infer<typeof codeHostWebhookRoutingFactsSchema>

export type CodeHostRoutingValue =
  | null
  | boolean
  | number
  | string
  | CodeHostRoutingValue[]
  | { [key: string]: CodeHostRoutingValue }

export interface CodeHostEventResponseDefinition {
  readonly id: string
  readonly definitionRevision: string
  readonly endpointId: string
  readonly eventTypes: readonly CodeHostEventType[]
  readonly displayName: { readonly 'zh-CN': string; readonly 'en-US': string }
  readonly selector: {
    readonly kind: 'code-host.webhook-rule'
    readonly config: CodeHostRoutingValue
  }
  readonly state: 'active' | 'paused' | 'invalid'
  readonly createdAt: number
  readonly updatedAt: number
}

export function codeHostWebhookRoutingFactsOf(
  endpointId: string,
  deliveryId: string,
  event: CodeHostEvent,
): CodeHostWebhookRoutingFacts {
  return {
    provider: event.provider,
    endpointId,
    deliveryId,
    eventType: event.eventType,
    repoPath: event.repoPath,
    ...(event.mrIid === undefined ? {} : { mrIid: event.mrIid }),
    ...(event.branch === undefined ? {} : { branch: event.branch }),
    ...(event.targetBranch === undefined ? {} : { targetBranch: event.targetBranch }),
    ...(event.commentText === undefined ? {} : { commentText: event.commentText }),
    ...(event.author.username === undefined ? {} : { authorUsername: event.author.username }),
  }
}

/** Selector-only projection: unavailable payload fields can never affect routing. */
export function codeHostSelectorEvent(facts: CodeHostWebhookRoutingFacts): CodeHostEvent {
  return {
    provider: facts.provider,
    eventUuid: null,
    eventType: facts.eventType,
    repoPath: facts.repoPath,
    repoHttpUrl: 'selector://unavailable',
    repoSshUrl: 'selector://unavailable',
    ...(facts.branch === undefined ? {} : { branch: facts.branch }),
    ...(facts.targetBranch === undefined ? {} : { targetBranch: facts.targetBranch }),
    ...(facts.commentText === undefined ? {} : { commentText: facts.commentText }),
    author: facts.authorUsername === undefined ? {} : { username: facts.authorUsername },
    raw: null,
  }
}
