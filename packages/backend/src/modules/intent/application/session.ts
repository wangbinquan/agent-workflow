// RFC-234 §2/§6 — provider-neutral Intent session application facade.

import { ulid } from 'ulid'
import {
  IntentMountRequestsSchema,
  type AclResourceType,
  type IntentMountApprovalReceipt,
  type IntentMountRequest,
  type IntentMountSuggestionDecision,
  type IntentResourceType,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type {
  IntentContextResourceAuthorization,
  IntentPersistence,
  IntentResourceVisibility,
  IntentSessionRecord,
  IntentTurnRecord,
  ReservedIntentTurnRecord,
} from '@/modules/intent/public/operations'
import type { IntentContextResourceReference } from '@/modules/resource-catalog/public/participants'
import { canAuditIntentSessions } from '@/modules/intent/public/operations'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  allocateHandle,
  createHandleAllocator,
  handleWatermarkOf,
  manifestEntryFor,
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
} from './manifest'

export type IntentSessionRow = IntentSessionRecord
export type IntentTurnRow = IntentTurnRecord
export type IntentSessionListRow = IntentSessionRecord & {
  currentDraftRevision: number | null
  currentDraftContextRevision: number | null
  currentDraftValidationErrors: string[]
  latestAgentTurnKind: IntentTurnRecord['kind'] | null
  latestCommit: null | {
    draftId: string
    state: 'prepared' | 'applying' | 'committed' | 'failed'
  }
}
export type ReservedIntentTurn = ReservedIntentTurnRecord

const TITLE_CAP = 80

export function sessionManifest(row: IntentSessionRow): IntentContextManifest {
  return JSON.parse(row.contextManifestJson) as IntentContextManifest
}

export function canReadIntentSession(actor: Actor, row: IntentSessionRow): boolean {
  return row.ownerUserId === actor.user.id || canAuditIntentSessions(actor)
}

function notFound(sessionId: string): NotFoundError {
  return new NotFoundError('intent-session-not-found', `intent session '${sessionId}' not found`)
}

function assertWritable(actor: Actor, row: IntentSessionRow): void {
  if (row.ownerUserId !== actor.user.id) throw notFound(row.id)
  if (row.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived; reopen it first')
  }
}

export async function getIntentSessionForActor(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
): Promise<IntentSessionRow> {
  const row = await persistence.findSession(sessionId)
  if (row === null || !canReadIntentSession(actor, row)) throw notFound(sessionId)
  return row
}

function validationErrors(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as { errors?: unknown }
    return Array.isArray(parsed.errors)
      ? parsed.errors.filter((item): item is string => typeof item === 'string')
      : ['intent-draft-validation-unreadable']
  } catch {
    return ['intent-draft-validation-unreadable']
  }
}

export async function listIntentSessionsForActor(
  persistence: IntentPersistence,
  actor: Actor,
  opts: {
    status?: 'active' | 'archived'
    all?: boolean
    before?: { updatedAt: number; id: string }
    limit?: number
  } = {},
): Promise<IntentSessionListRow[]> {
  const wantAll = opts.all === true && canAuditIntentSessions(actor)
  const rows = await persistence.listSessions({
    ...(wantAll ? {} : { ownerUserId: actor.user.id }),
    ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.before === undefined ? {} : { before: opts.before }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  })
  return rows.map(({ currentDraftValidationJson, ...row }) => ({
    ...row,
    currentDraftValidationErrors: validationErrors(currentDraftValidationJson),
  }))
}

export async function listIntentTurns(
  persistence: IntentPersistence,
  sessionId: string,
): Promise<IntentTurnRow[]> {
  return [...(await persistence.listTurns(sessionId))]
}

async function buildInitialManifest(
  authorization: IntentContextResourceAuthorization,
  mounts: readonly IntentContextResourceReference[] = [],
): Promise<IntentContextManifest> {
  const manifest: IntentContextManifest = []
  const allocator = createHandleAllocator(manifest)
  for (const ref of mounts) {
    if (!(await authorization.visible(ref))) {
      throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
    }
    if (manifestEntryFor(manifest, ref.resourceType, ref.resourceId) !== undefined) continue
    manifest.push({
      handle: allocateHandle(allocator, ref.resourceType, ref.resourceId),
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root: true,
      detail: false,
    })
  }
  return manifest
}

function turnRecord(input: {
  id: string
  sessionId: string
  seq: number
  role: IntentTurnRecord['role']
  kind: IntentTurnRecord['kind']
  contentJson: string
  contextRevision: number
  envelopeNonce?: string | null
  captureState?: IntentTurnRecord['captureState']
  createdAt: number
}): IntentTurnRecord {
  return {
    ...input,
    envelopeNonce: input.envelopeNonce ?? null,
    runMetaJson: null,
    clientMutationId: null,
    captureState: input.captureState ?? null,
    captureLastEventSeq: 0,
    captureEventBytes: 0,
    captureRootSessionId: null,
    captureIncompleteReason: null,
    scratchRetained: false,
  }
}

async function createIntentSessionInternal(
  persistence: IntentPersistence,
  authorization: IntentContextResourceAuthorization,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: readonly IntentContextResourceReference[]
  },
  reserve: boolean,
): Promise<{ session: IntentSessionRow; turnId: string; reservation?: ReservedIntentTurn }> {
  const message = input.message.trim()
  if (message.length === 0) {
    throw new ValidationError('intent-message-empty', 'intent message must not be empty')
  }
  const mounts = input.mounts ?? []
  const manifest = await buildInitialManifest(authorization, mounts)
  const now = Date.now()
  const sessionId = ulid()
  const userTurnId = ulid()
  const agentTurnId = reserve ? ulid() : null
  const envelopeNonce = reserve ? generateEnvelopeNonce() : null
  const session: IntentSessionRecord = {
    id: sessionId,
    ownerUserId: actor.user.id,
    title: message.length > TITLE_CAP ? `${message.slice(0, TITLE_CAP)}…` : message,
    status: 'active',
    contextRevision: 0,
    contextManifestJson: JSON.stringify(manifest),
    handleWatermarkJson: JSON.stringify(handleWatermarkOf(createHandleAllocator(manifest))),
    currentDraftId: null,
    inFlightTurnId: agentTurnId,
    turnSeq: reserve ? 2 : 1,
    commitSeq: 0,
    budgetJson: JSON.stringify({ generateRounds: 0, questionRounds: 0 }),
    createdAt: now,
    updatedAt: now,
  }
  const userTurn = turnRecord({
    id: userTurnId,
    sessionId,
    seq: 1,
    role: 'user',
    kind: 'message',
    contentJson: JSON.stringify({
      message,
      ...(input.hint === undefined ? {} : { hint: input.hint }),
    }),
    contextRevision: 0,
    createdAt: now,
  })
  const agentTurn =
    agentTurnId === null || envelopeNonce === null
      ? undefined
      : turnRecord({
          id: agentTurnId,
          sessionId,
          seq: 2,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision: 0,
          envelopeNonce,
          captureState: 'live',
          createdAt: now,
        })
  await persistence.createSessionWithAuthorizedResources({
    session,
    userTurn,
    ...(agentTurn === undefined ? {} : { agentTurn }),
    authorization,
    resources: mounts,
  })
  return {
    session,
    turnId: userTurnId,
    ...(agentTurnId === null || envelopeNonce === null
      ? {}
      : {
          reservation: {
            turnId: agentTurnId,
            envelopeNonce,
            launchSession: session,
            budget: { generateRounds: 0, questionRounds: 0 },
          },
        }),
  }
}

export async function createIntentSession(
  persistence: IntentPersistence,
  authorization: IntentContextResourceAuthorization,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: readonly IntentContextResourceReference[]
  },
): Promise<{ session: IntentSessionRow; turnId: string }> {
  return await createIntentSessionInternal(persistence, authorization, actor, input, false)
}

export async function createIntentSessionAndReserveTurn(
  persistence: IntentPersistence,
  authorization: IntentContextResourceAuthorization,
  actor: Actor,
  input: {
    message: string
    hint?: string
    mounts?: readonly IntentContextResourceReference[]
  },
): Promise<{ session: IntentSessionRow; turnId: string; reservation: ReservedIntentTurn }> {
  const created = await createIntentSessionInternal(persistence, authorization, actor, input, true)
  if (created.reservation === undefined) throw new Error('intent reservation missing after create')
  return { ...created, reservation: created.reservation }
}

export async function insertUserTurn(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  kind: 'message' | 'answers' | 'mount-approval',
  content: Record<string, unknown>,
): Promise<{ turnId: string; seq: number }> {
  return await persistence.insertUserTurn({
    ownerUserId: actor.user.id,
    sessionId,
    turn: turnRecord({
      id: ulid(),
      sessionId,
      seq: 0,
      role: 'user',
      kind,
      contentJson: JSON.stringify(content),
      contextRevision: 0,
      createdAt: Date.now(),
    }),
  })
}

function mountRequestKey(request: { resourceType: AclResourceType; name: string }): string {
  return `${request.resourceType}\u0000${request.name}`
}

function uniqueMountRequests(requests: readonly IntentMountRequest[]): IntentMountRequest[] {
  const seen = new Set<string>()
  return requests.filter((request) => {
    const key = mountRequestKey(request)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function decideIntentMountSuggestions(
  persistence: IntentPersistence,
  authorization: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  input: {
    sourceTurnId: string
    expectedTurnSeq: number
    expectedContextRevision: number
    decisions: readonly IntentMountSuggestionDecision[]
  },
): Promise<IntentMountApprovalReceipt> {
  const session = await getIntentSessionForActor(persistence, actor, sessionId)
  assertWritable(actor, session)
  if (
    session.inFlightTurnId !== null ||
    session.turnSeq !== input.expectedTurnSeq ||
    session.contextRevision !== input.expectedContextRevision
  ) {
    throw new ConflictError(
      'intent-approval-stale',
      'the mount suggestions changed; refresh before deciding',
    )
  }
  const sourceTurn = (await persistence.listTurns(sessionId)).find(
    (turn) => turn.id === input.sourceTurnId,
  )
  if (
    sourceTurn === undefined ||
    sourceTurn.role !== 'agent' ||
    (sourceTurn.kind !== 'questions' && sourceTurn.kind !== 'changeset') ||
    sourceTurn.seq !== session.turnSeq ||
    sourceTurn.contextRevision !== session.contextRevision
  ) {
    throw new ConflictError(
      'intent-approval-stale',
      'the mount suggestions changed; refresh before deciding',
    )
  }
  let sourceContent: unknown
  try {
    sourceContent = JSON.parse(sourceTurn.contentJson)
  } catch {
    throw new ValidationError('intent-invalid', 'mount suggestion source is unreadable')
  }
  const sourceRecord =
    typeof sourceContent === 'object' && sourceContent !== null && !Array.isArray(sourceContent)
      ? (sourceContent as Record<string, unknown>)
      : null
  const requestsParse = IntentMountRequestsSchema.safeParse(sourceRecord?.mountRequests)
  if (!requestsParse.success) {
    throw new ValidationError('intent-invalid', 'source turn has no valid mount suggestions')
  }
  const requests = uniqueMountRequests(requestsParse.data)
  const decisions = new Map<string, IntentMountSuggestionDecision>()
  for (const decision of input.decisions) {
    const key = mountRequestKey(decision)
    if (decisions.has(key)) {
      throw new ValidationError('intent-invalid', 'duplicate mount suggestion decision')
    }
    decisions.set(key, decision)
  }
  if (
    decisions.size !== requests.length ||
    requests.some((request) => !decisions.has(mountRequestKey(request)))
  ) {
    throw new ValidationError(
      'intent-invalid',
      'every mount suggestion requires exactly one decision',
    )
  }

  const manifest = sessionManifest(session).map((entry) => ({ ...entry }))
  const approved: IntentMountApprovalReceipt['approved'] = []
  const rejected: IntentMountApprovalReceipt['rejected'] = []
  const authorizedResources: IntentContextResourceReference[] = []
  let changed = false
  for (const request of requests) {
    const decision = decisions.get(mountRequestKey(request))!
    if (decision.action === 'reject') {
      rejected.push({ resourceType: request.resourceType, name: request.name })
      continue
    }
    if (
      !(await authorization.visible({
        resourceType: request.resourceType,
        resourceId: decision.resourceId,
        expectedName: request.name,
      }))
    ) {
      throw new NotFoundError('resource-not-found', `${request.resourceType} not found`)
    }
    const existing = manifestEntryFor(manifest, request.resourceType, decision.resourceId)
    let handle: string
    if (existing !== undefined) {
      handle = existing.handle
      if (!existing.root) {
        existing.root = true
        changed = true
      }
    } else {
      const allocator = createHandleAllocator(
        manifest,
        parseHandleWatermark(session.handleWatermarkJson),
      )
      handle = allocateHandle(allocator, request.resourceType, decision.resourceId)
      manifest.push({
        handle,
        resourceType: request.resourceType,
        resourceId: decision.resourceId,
        root: true,
        detail: false,
      })
      changed = true
    }
    approved.push({
      resourceType: request.resourceType,
      name: request.name,
      resourceId: decision.resourceId,
      handle,
    })
    authorizedResources.push({
      resourceType: request.resourceType,
      resourceId: decision.resourceId,
      expectedName: request.name,
    })
  }
  const approvalTurnId = ulid()
  const approvalTurnSeq = session.turnSeq + 1
  const resultingContextRevision = session.contextRevision + (changed ? 1 : 0)
  const receipt: IntentMountApprovalReceipt = {
    sourceTurnId: sourceTurn.id,
    sourceTurnSeq: sourceTurn.seq,
    approvalTurnId,
    approvalTurnSeq,
    resultingContextRevision,
    approved,
    rejected,
  }
  const status = await persistence.commitMountSuggestionDecision({
    ownerUserId: actor.user.id,
    sessionId,
    sourceTurnId: sourceTurn.id,
    expectedTurnSeq: input.expectedTurnSeq,
    expectedContextRevision: input.expectedContextRevision,
    approvalTurn: turnRecord({
      id: approvalTurnId,
      sessionId,
      seq: approvalTurnSeq,
      role: 'user',
      kind: 'mount-approval',
      contentJson: JSON.stringify(receipt),
      contextRevision: resultingContextRevision,
      createdAt: Date.now(),
    }),
    manifest,
    handleWatermarkJson: JSON.stringify(
      mergeHandleWatermarks(
        parseHandleWatermark(session.handleWatermarkJson),
        handleWatermarkOf(createHandleAllocator(manifest)),
      ),
    ),
    authorization,
    resources: authorizedResources,
  })
  if (status === 'stale') {
    throw new ConflictError(
      'intent-approval-stale',
      'the mount suggestions changed; refresh before deciding',
    )
  }
  return receipt
}

export async function insertUserTurnAndReserve(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  kind: 'message' | 'answers',
  content: Record<string, unknown>,
  maxGenerateRounds: number,
): Promise<{ turnId: string; seq: number; reservation: ReservedIntentTurn }> {
  return await persistence.insertUserTurnAndReserve({
    ownerUserId: actor.user.id,
    sessionId,
    userTurnId: ulid(),
    agentTurnId: ulid(),
    envelopeNonce: generateEnvelopeNonce(),
    kind,
    contentJson: JSON.stringify(content),
    now: Date.now(),
    maxGenerateRounds,
  })
}

export async function reserveIntentRetryTurn(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  maxGenerateRounds: number,
): Promise<ReservedIntentTurn> {
  return await persistence.reserveRetryTurn({
    ownerUserId: actor.user.id,
    sessionId,
    turnId: ulid(),
    envelopeNonce: generateEnvelopeNonce(),
    now: Date.now(),
    maxGenerateRounds,
  })
}

export async function addIntentMount(
  persistence: IntentPersistence,
  authorization: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  ref: IntentContextResourceReference,
): Promise<{ handle: string; contextRevision: number }> {
  const session = await getIntentSessionForActor(persistence, actor, sessionId)
  assertWritable(actor, session)
  if (!(await authorization.visible(ref))) {
    throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
  }
  const manifest = sessionManifest(session).map((entry) => ({ ...entry }))
  const existing = manifestEntryFor(manifest, ref.resourceType, ref.resourceId)
  if (existing?.root === true) {
    throw new ConflictError('intent-mount-exists', 'resource is already mounted')
  }
  let handle: string
  if (existing !== undefined) {
    existing.root = true
    handle = existing.handle
  } else {
    const allocator = createHandleAllocator(
      manifest,
      parseHandleWatermark(session.handleWatermarkJson),
    )
    handle = allocateHandle(allocator, ref.resourceType, ref.resourceId)
    manifest.push({
      handle,
      resourceType: ref.resourceType,
      resourceId: ref.resourceId,
      root: true,
      detail: false,
    })
  }
  const status = await persistence.updateManifestWithAuthorizedResources({
    ownerUserId: actor.user.id,
    sessionId,
    expectedContextRevision: session.contextRevision,
    expectedTurnSeq: session.turnSeq,
    manifest,
    handleWatermarkJson: JSON.stringify(
      mergeHandleWatermarks(
        parseHandleWatermark(session.handleWatermarkJson),
        handleWatermarkOf(createHandleAllocator(manifest)),
      ),
    ),
    updatedAt: Date.now(),
    authorization,
    resources: [ref],
  })
  if (status === 'stale') {
    throw new ConflictError('intent-context-stale', 'the working context changed; refresh first')
  }
  return { handle, contextRevision: session.contextRevision + 1 }
}

export async function removeIntentMount(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  handle: string,
): Promise<{ contextRevision: number }> {
  const session = await getIntentSessionForActor(persistence, actor, sessionId)
  assertWritable(actor, session)
  const manifest = sessionManifest(session).map((entry) => ({ ...entry }))
  const entry = manifest.find((candidate) => candidate.handle === handle)
  if (entry === undefined || !entry.root) {
    throw new NotFoundError('intent-mount-not-found', 'mount not found')
  }
  entry.root = false
  const status = await persistence.updateManifest({
    ownerUserId: actor.user.id,
    sessionId,
    expectedContextRevision: session.contextRevision,
    expectedTurnSeq: session.turnSeq,
    manifest,
    updatedAt: Date.now(),
  })
  if (status === 'stale') {
    throw new ConflictError('intent-context-stale', 'the working context changed; refresh first')
  }
  return { contextRevision: session.contextRevision + 1 }
}

export async function rebaseIntentSession(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
): Promise<{ contextRevision: number }> {
  const session = await getIntentSessionForActor(persistence, actor, sessionId)
  assertWritable(actor, session)
  const status = await persistence.updateManifest({
    ownerUserId: actor.user.id,
    sessionId,
    expectedContextRevision: session.contextRevision,
    expectedTurnSeq: session.turnSeq,
    manifest: sessionManifest(session),
    updatedAt: Date.now(),
  })
  if (status === 'stale') {
    throw new ConflictError('intent-context-stale', 'the working context changed; refresh first')
  }
  return { contextRevision: session.contextRevision + 1 }
}

export async function setIntentSessionStatus(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  status: 'active' | 'archived',
): Promise<void> {
  await persistence.setStatus({
    ownerUserId: actor.user.id,
    sessionId,
    status,
    updatedAt: Date.now(),
  })
}

export async function listIntentProvenanceForActor(
  persistence: IntentPersistence,
  visibility: IntentResourceVisibility,
  actor: Actor,
  ref: { resourceType: IntentResourceType; resourceId: string },
): Promise<
  Array<{ commitId: string; sessionId: string; sessionTitle: string; createdAt: number }>
> {
  if (!(await visibility.visible(ref))) return []
  const audit = canAuditIntentSessions(actor)
  return (await persistence.listProvenance(ref))
    .filter((row) => audit || row.sessionOwnerUserId === actor.user.id)
    .map(({ sessionOwnerUserId: _sessionOwnerUserId, ...row }) => row)
}
