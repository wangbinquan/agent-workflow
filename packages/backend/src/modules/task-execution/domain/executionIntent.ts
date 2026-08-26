// RFC-328 — canonical continuation intent and replay-authorization rules.

import { createHash } from 'node:crypto'

export const TASK_EXECUTION_INTENT_KINDS = [
  'launch',
  'resume',
  'retry-repository-preparation',
  'retry-node',
  'sync-workflow',
  'gate-continuation',
  'recovery',
] as const
export type TaskExecutionIntentKind = (typeof TASK_EXECUTION_INTENT_KINDS)[number]

export const TASK_EXECUTION_INTENT_STATES = [
  'pending',
  'claimed',
  'completed',
  'canceled',
  'failed',
] as const
export type TaskExecutionIntentState = (typeof TASK_EXECUTION_INTENT_STATES)[number]

export const TASK_EXECUTION_INTENT_SOURCES = [
  'rest',
  'mcp',
  'scheduler',
  'auto',
  'boot',
  'internal',
] as const
export type TaskExecutionIntentSource = (typeof TASK_EXECUTION_INTENT_SOURCES)[number]

export const ACTOR_REPLAY_COMMANDS = [
  'resume',
  'retry-repository-preparation',
  'retry-node',
  'sync-workflow',
] as const
export type ActorReplayCommand = (typeof ACTOR_REPLAY_COMMANDS)[number]

export interface LineageSlot {
  readonly stableNodeKey: string
  readonly frozenOccurrenceKey: string
  readonly workflowRevision: number | null
}

export interface ContinuationScope {
  readonly executionLineageId: string
  readonly continuationSlotKey: string
  readonly slotPath: readonly LineageSlot[]
  readonly operationGeneration: number
}

export interface CanonicalContinuationRequest {
  readonly taskId: string
  readonly kind: TaskExecutionIntentKind
  readonly source: TaskExecutionIntentSource
  readonly actorUserId: string | null
  readonly expectedTaskRevision: number
  readonly scope: ContinuationScope
  readonly payload: Readonly<Record<string, unknown>>
}

export function isActorReplayCommand(kind: TaskExecutionIntentKind): kind is ActorReplayCommand {
  return (ACTOR_REPLAY_COMMANDS as readonly string[]).includes(kind)
}

/**
 * Actor presence alone is never replay authority.  Only one of the four
 * existing manual continuation commands may authorize a new operation
 * generation.  Gate/answer/auto/boot paths remain ordinary continuations.
 */
export function mayAuthorizeReplay(input: {
  kind: TaskExecutionIntentKind
  source: TaskExecutionIntentSource
  actorUserId: string | null
}): boolean {
  return (
    input.actorUserId !== null &&
    (input.source === 'rest' || input.source === 'mcp') &&
    isActorReplayCommand(input.kind)
  )
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function continuationRequestHash(request: CanonicalContinuationRequest): string {
  // Actor identity is audit metadata, not business input.  Retrying the same
  // command through REST/MCP therefore converges on one operation hash.
  const canonical = {
    taskId: request.taskId,
    kind: request.kind,
    source: request.source,
    expectedTaskRevision: request.expectedTaskRevision,
    scope: request.scope,
    payload: request.payload,
  }
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex')
}

export function encodeLineageSlotPath(path: readonly LineageSlot[]): string {
  if (path.length === 0) throw new Error('lineage slot path must not be empty')
  for (const slot of path) {
    if (slot.stableNodeKey.length === 0 || slot.frozenOccurrenceKey.length === 0) {
      throw new Error('lineage slot keys must not be empty')
    }
  }
  return canonicalJson(path)
}

export function decodeLineageSlotPath(raw: string): readonly LineageSlot[] {
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('invalid-lineage-slot-path')
  }
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== 'object') throw new Error('invalid-lineage-slot-path')
    const value = entry as Record<string, unknown>
    if (
      typeof value.stableNodeKey !== 'string' ||
      value.stableNodeKey.length === 0 ||
      typeof value.frozenOccurrenceKey !== 'string' ||
      value.frozenOccurrenceKey.length === 0 ||
      !(
        value.workflowRevision === null ||
        (typeof value.workflowRevision === 'number' && Number.isInteger(value.workflowRevision))
      )
    ) {
      throw new Error('invalid-lineage-slot-path')
    }
    return {
      stableNodeKey: value.stableNodeKey,
      frozenOccurrenceKey: value.frozenOccurrenceKey,
      workflowRevision: value.workflowRevision as number | null,
    }
  })
}

export function lineagePathHasPrefix(
  candidate: readonly LineageSlot[],
  prefix: readonly LineageSlot[],
): boolean {
  if (prefix.length > candidate.length) return false
  return prefix.every((slot, index) => {
    const value = candidate[index]
    return (
      value !== undefined &&
      value.stableNodeKey === slot.stableNodeKey &&
      value.frozenOccurrenceKey === slot.frozenOccurrenceKey &&
      value.workflowRevision === slot.workflowRevision
    )
  })
}

export type IntentTerminalAction =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'fail'; code: string }>
  | Readonly<{ kind: 'cancel' }>
  | Readonly<{ kind: 'shutdown-suspend' }>
  | Readonly<{ kind: 'rebind-recovery'; successorIntentId: string }>

export function terminalIntentState(action: IntentTerminalAction): TaskExecutionIntentState {
  switch (action.kind) {
    case 'complete':
      return 'completed'
    case 'cancel':
      return 'canceled'
    case 'fail':
    case 'shutdown-suspend':
    case 'rebind-recovery':
      return 'failed'
  }
}
