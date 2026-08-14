// RFC-303 — provider-neutral MR/PR stream identity and state machine.
// Domain-only: no DB, network, task, or filesystem dependency is allowed here.
import { createHash } from 'node:crypto'

import type { CodeHostEvent, CodeHostEventType, CodeHostProvider } from '@agent-workflow/shared'

export const MR_STREAM_KEY_VERSION = 'mr-stream-v1' as const
export const MR_TERMINATION_BINDING_VERSION = 'st1' as const

export type MrStreamIdentity = Readonly<{
  projectId: string
  mrIid: string
  streamKey: string
}>

export type MrStreamStateName = 'open' | 'closed' | 'merged'

export type MrStreamState = Readonly<{
  state: MrStreamStateName
  revision: number
  lastTerminalRevision: number | null
}>

export type MrControlEffectKind = 'fence-closed' | 'fence-merged' | 'clear-closed'

export type LinearizedMrEvent = Readonly<{
  state: MrStreamState
  effectKind: MrControlEffectKind | null
}>

const MR_EVENT_TYPES: ReadonlySet<CodeHostEventType> = new Set([
  'mr_opened',
  'mr_updated',
  'mr_closed',
  'mr_merged',
])

const MR_AUXILIARY_EVENT_TYPES: ReadonlySet<CodeHostEventType> = new Set([
  'note',
  'pipeline_failed',
  'pipeline_succeeded',
])

export function isMrEventType(eventType: CodeHostEventType): boolean {
  return MR_EVENT_TYPES.has(eventType)
}

/**
 * MR events are always MR-associated, even when their identity is malformed.
 * note/pipeline events become MR-associated only when an MR iid is present;
 * branch pipelines still carry projectId and must remain unbound.
 */
export function isMrAssociatedEvent(event: CodeHostEvent): boolean {
  return (
    isMrEventType(event.eventType) ||
    (MR_AUXILIARY_EVENT_TYPES.has(event.eventType) && event.mrIid !== undefined)
  )
}

export function stableMrIdentityOf(event: CodeHostEvent): MrStreamIdentity | null {
  if (!isMrAssociatedEvent(event)) return null
  const projectId = event.projectId?.trim()
  const mrIid = event.mrIid?.trim()
  if (!projectId || !mrIid) return null
  return {
    projectId,
    mrIid,
    streamKey: JSON.stringify([MR_STREAM_KEY_VERSION, projectId, mrIid]),
  }
}

export function sourceTerminationBinding(input: {
  endpointId: string
  projectId: string
  mrIid: string
}): string {
  const tuple = JSON.stringify([
    MR_TERMINATION_BINDING_VERSION,
    input.endpointId,
    input.projectId,
    input.mrIid,
  ])
  return `${MR_TERMINATION_BINDING_VERSION}:${createHash('sha256').update(tuple).digest('hex')}`
}

export function mrFactKey(input: {
  provider: CodeHostProvider
  eventUuid: string | null
  normalizedEventType: CodeHostEventType
  rawBodyBytes: Uint8Array
}): string {
  if (input.eventUuid !== null && input.eventUuid.length > 0) {
    return `id:${input.provider}:${input.eventUuid}`
  }
  const digest = createHash('sha256')
    .update(input.provider)
    .update('\0')
    .update(input.normalizedEventType)
    .update('\0')
    .update(input.rawBodyBytes)
    .digest('hex')
  return `body:v1:${digest}`
}

export function linearizeMrEvent(
  current: MrStreamState | null,
  eventType: CodeHostEventType,
  nextRevision: number,
): LinearizedMrEvent {
  const expectedRevision = (current?.revision ?? 0) + 1
  if (!Number.isSafeInteger(nextRevision) || nextRevision !== expectedRevision) {
    throw new Error(`mr-stream-revision-invalid:${nextRevision}:expected:${expectedRevision}`)
  }

  const currentName = current?.state ?? 'open'
  let state: MrStreamStateName = currentName
  let effectKind: MrControlEffectKind | null = null
  let lastTerminalRevision = current?.lastTerminalRevision ?? null

  if (eventType === 'mr_merged') {
    state = 'merged'
    effectKind = 'fence-merged'
    lastTerminalRevision = nextRevision
  } else if (eventType === 'mr_closed') {
    // merged is absorbing, but the distinct close fact still gets an idempotent
    // effect and revision for audit/replay ordering.
    state = currentName === 'merged' ? 'merged' : 'closed'
    effectKind = 'fence-closed'
    lastTerminalRevision = nextRevision
  } else if (eventType === 'mr_opened') {
    if (currentName === 'closed') {
      state = 'open'
      effectKind = 'clear-closed'
    } else if (currentName === 'merged') {
      state = 'merged'
    } else {
      state = 'open'
    }
  }

  return {
    state: { state, revision: nextRevision, lastTerminalRevision },
    effectKind,
  }
}

export type ProtectedLaunchDecision =
  | { kind: 'unprotected' }
  | { kind: 'control-only'; identity: MrStreamIdentity }
  | { kind: 'invalid-mr-identity' }
  | { kind: 'blocked'; state: 'closed' | 'merged'; identity: MrStreamIdentity }
  | {
      kind: 'protected'
      identity: MrStreamIdentity
      binding: string
      launchRevision: number
    }

export function decideProtectedLaunch(input: {
  cancelOnMrTerminal: boolean
  endpointId: string
  event: CodeHostEvent
  streamState: MrStreamState | null
}): ProtectedLaunchDecision {
  if (!input.cancelOnMrTerminal) return { kind: 'unprotected' }
  if (!isMrAssociatedEvent(input.event)) return { kind: 'unprotected' }

  const identity = stableMrIdentityOf(input.event)
  if (identity === null) return { kind: 'invalid-mr-identity' }
  if (input.event.eventType === 'mr_closed' || input.event.eventType === 'mr_merged') {
    return { kind: 'control-only', identity }
  }
  if (input.streamState?.state === 'closed' || input.streamState?.state === 'merged') {
    return { kind: 'blocked', state: input.streamState.state, identity }
  }
  return {
    kind: 'protected',
    identity,
    binding: sourceTerminationBinding({
      endpointId: input.endpointId,
      projectId: identity.projectId,
      mrIid: identity.mrIid,
    }),
    launchRevision: input.streamState?.revision ?? 0,
  }
}
