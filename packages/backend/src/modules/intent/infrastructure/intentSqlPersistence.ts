import { and, inArray, isNotNull, lt, ne, notInArray, sql, type SQLWrapper } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  canonicalJson,
  DEFAULT_CONFIG_DIR_PROFILE,
  IntentMountRequestsSchema,
  IntentQuestionsSchema,
  IntentWorkingSetDeltaSchema,
  type IntentGenerationReceipt,
  type IntentMountRequest,
  type IntentMountSuggestionDecision,
  type IntentWorkingSetChangeDto,
  type IntentWorkingSetDelta,
  type PostIntentCurrentAction,
  type PostIntentIteration,
  type PostIntentRetry,
  type PostIntentWorkingSetChange,
} from '@agent-workflow/shared'

import {
  agents,
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurnEvents,
  intentTurns,
  intentWorkingSetChanges,
  runtimes,
} from '@/db/schema'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import {
  mergeHandleWatermarks,
  parseHandleWatermark,
  type IntentContextManifest,
} from '@/services/intent/manifest'
import type { IntentContextResourceReference } from '@/modules/resource-catalog/public/participants'
import { applyIntentWorkingSetDelta } from '../application/intentWorkingSetDelta'
import type {
  IntentAgentPortNames,
  IntentResolvedRuntime,
  IntentRuntimeInventoryRow,
} from '../application/ports/intentAuxiliaryQueries'
import type {
  IntentApplyJournalRecord,
  IntentContextResourceAuthorization,
  IntentDraftRecord,
  IntentDraftResolutionRecord,
  IntentPersistence,
  IntentSessionListRecord,
  IntentSessionRecord,
  IntentSessionStatus,
  IntentTurnEventRecord,
  IntentTurnRecord,
  IntentWorkingSetChangeRecord,
  ReservedIntentTurnRecord,
} from '../application/ports/intentPersistence'
import {
  allRows,
  authorizeIntentContextResource,
  firstRow,
  mutation,
  type IntentSqlProgramRunner,
  type IntentSqlStatement,
} from './intentSqlProgram'

const sessionColumns = sql`
  ${intentSessions.id} AS "id",
  ${intentSessions.ownerUserId} AS "ownerUserId",
  ${intentSessions.title} AS "title",
  ${intentSessions.status} AS "status",
  ${intentSessions.contextRevision} AS "contextRevision",
  ${intentSessions.contextManifestJson} AS "contextManifestJson",
  ${intentSessions.handleWatermarkJson} AS "handleWatermarkJson",
  ${intentSessions.currentDraftId} AS "currentDraftId",
  ${intentSessions.inFlightTurnId} AS "inFlightTurnId",
  ${intentSessions.turnSeq} AS "turnSeq",
  ${intentSessions.commitSeq} AS "commitSeq",
  ${intentSessions.budgetJson} AS "budgetJson",
  ${intentSessions.createdAt} AS "createdAt",
  ${intentSessions.updatedAt} AS "updatedAt"
`

const turnColumns = sql`
  ${intentTurns.id} AS "id",
  ${intentTurns.sessionId} AS "sessionId",
  ${intentTurns.seq} AS "seq",
  ${intentTurns.role} AS "role",
  ${intentTurns.kind} AS "kind",
  ${intentTurns.contentJson} AS "contentJson",
  ${intentTurns.contextRevision} AS "contextRevision",
  ${intentTurns.envelopeNonce} AS "envelopeNonce",
  ${intentTurns.runMetaJson} AS "runMetaJson",
  ${intentTurns.clientMutationId} AS "clientMutationId",
  ${intentTurns.captureState} AS "captureState",
  ${intentTurns.captureLastEventSeq} AS "captureLastEventSeq",
  ${intentTurns.captureEventBytes} AS "captureEventBytes",
  ${intentTurns.captureRootSessionId} AS "captureRootSessionId",
  ${intentTurns.captureIncompleteReason} AS "captureIncompleteReason",
  ${intentTurns.scratchRetained} AS "scratchRetained",
  ${intentTurns.createdAt} AS "createdAt"
`

const workingSetColumns = sql`
  ${intentWorkingSetChanges.id} AS "id",
  ${intentWorkingSetChanges.sessionId} AS "sessionId",
  ${intentWorkingSetChanges.clientMutationId} AS "clientMutationId",
  ${intentWorkingSetChanges.requestHash} AS "requestHash",
  ${intentWorkingSetChanges.expectedTurnSeq} AS "expectedTurnSeq",
  ${intentWorkingSetChanges.expectedContextRevision} AS "expectedContextRevision",
  ${intentWorkingSetChanges.mode} AS "mode",
  ${intentWorkingSetChanges.deltaJson} AS "deltaJson",
  ${intentWorkingSetChanges.state} AS "state",
  ${intentWorkingSetChanges.error} AS "error",
  ${intentWorkingSetChanges.resultingContextRevision} AS "resultingContextRevision",
  ${intentWorkingSetChanges.resultingTurnId} AS "resultingTurnId",
  ${intentWorkingSetChanges.createdAt} AS "createdAt",
  ${intentWorkingSetChanges.updatedAt} AS "updatedAt"
`

const turnEventColumns = sql`
  ${intentTurnEvents.id} AS "id",
  ${intentTurnEvents.turnId} AS "turnId",
  ${intentTurnEvents.eventSeq} AS "eventSeq",
  ${intentTurnEvents.ts} AS "ts",
  ${intentTurnEvents.kind} AS "kind",
  ${intentTurnEvents.payload} AS "payload",
  ${intentTurnEvents.sessionId} AS "sessionId",
  ${intentTurnEvents.parentSessionId} AS "parentSessionId",
  ${intentTurnEvents.source} AS "source",
  ${intentTurnEvents.externalEventId} AS "externalEventId"
`

const draftColumns = sql`
  ${intentDrafts.id} AS "id",
  ${intentDrafts.sessionId} AS "sessionId",
  ${intentDrafts.revision} AS "revision",
  ${intentDrafts.changesetJson} AS "changesetJson",
  ${intentDrafts.validationJson} AS "validationJson",
  ${intentDrafts.draftHash} AS "draftHash",
  ${intentDrafts.producedByTurnId} AS "producedByTurnId",
  ${intentDrafts.contextRevision} AS "contextRevision",
  ${intentDrafts.createdAt} AS "createdAt"
`

const applyJournalColumns = sql`
  ${intentApplyJournal.id} AS "id",
  ${intentApplyJournal.sessionId} AS "sessionId",
  ${intentApplyJournal.clientMutationId} AS "clientMutationId",
  ${intentApplyJournal.draftId} AS "draftId",
  ${intentApplyJournal.draftHash} AS "draftHash",
  ${intentApplyJournal.state} AS "state",
  ${intentApplyJournal.preparedArtifactsJson} AS "preparedArtifactsJson",
  ${intentApplyJournal.receiptJson} AS "receiptJson",
  ${intentApplyJournal.error} AS "error",
  ${intentApplyJournal.createdAt} AS "createdAt",
  ${intentApplyJournal.updatedAt} AS "updatedAt"
`

interface SqlColumnIdentifier {
  readonly name: string
}

function columnIdentifier(column: SqlColumnIdentifier): SQLWrapper {
  return sql.identifier(column.name)
}

function insertColumnList(...columns: readonly SqlColumnIdentifier[]): SQLWrapper {
  return sql.join(columns.map(columnIdentifier), sql`, `)
}

function numberOf(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
}

function sessionOf(row: IntentSessionRecord): IntentSessionRecord {
  return {
    ...row,
    contextRevision: numberOf(row.contextRevision),
    turnSeq: numberOf(row.turnSeq),
    commitSeq: numberOf(row.commitSeq),
    createdAt: numberOf(row.createdAt),
    updatedAt: numberOf(row.updatedAt),
  }
}

function turnOf(row: IntentTurnRecord): IntentTurnRecord {
  return {
    ...row,
    seq: numberOf(row.seq),
    contextRevision: numberOf(row.contextRevision),
    captureLastEventSeq: numberOf(row.captureLastEventSeq),
    captureEventBytes: numberOf(row.captureEventBytes),
    scratchRetained: row.scratchRetained === true || numberOf(row.scratchRetained) === 1,
    createdAt: numberOf(row.createdAt),
  }
}

function workingSetOf(row: IntentWorkingSetChangeRecord): IntentWorkingSetChangeRecord {
  return {
    ...row,
    expectedTurnSeq: numberOf(row.expectedTurnSeq),
    expectedContextRevision: numberOf(row.expectedContextRevision),
    resultingContextRevision:
      row.resultingContextRevision === null ? null : numberOf(row.resultingContextRevision),
    createdAt: numberOf(row.createdAt),
    updatedAt: numberOf(row.updatedAt),
  }
}

function projectWorkingSet(row: IntentWorkingSetChangeRecord): IntentWorkingSetChangeDto {
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    delta: IntentWorkingSetDeltaSchema.parse(JSON.parse(row.deltaJson)),
    expectedTurnSeq: row.expectedTurnSeq,
    expectedContextRevision: row.expectedContextRevision,
    resultingContextRevision: row.resultingContextRevision,
    resultingTurnId: row.resultingTurnId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function workingSetRequestHash(input: PostIntentWorkingSetChange): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`
}

function* assertAuthorizedResources(
  authorization: IntentContextResourceAuthorization,
  resources: readonly IntentContextResourceReference[],
): Generator<IntentSqlStatement, void, unknown> {
  for (const reference of resources) {
    const identity = yield* authorizeIntentContextResource(authorization, reference)
    if (identity === null) {
      throw new NotFoundError('resource-not-found', `${reference.resourceType} not found`)
    }
  }
}

function eventOf(row: IntentTurnEventRecord): IntentTurnEventRecord {
  return {
    ...row,
    id: numberOf(row.id),
    eventSeq: numberOf(row.eventSeq),
    ts: numberOf(row.ts),
  }
}

function draftOf(row: IntentDraftRecord): IntentDraftRecord {
  return {
    ...row,
    revision: numberOf(row.revision),
    contextRevision: numberOf(row.contextRevision),
    createdAt: numberOf(row.createdAt),
  }
}

function applyJournalOf(row: IntentApplyJournalRecord): IntentApplyJournalRecord {
  return {
    ...row,
    createdAt: numberOf(row.createdAt),
    updatedAt: numberOf(row.updatedAt),
  }
}

interface IntentRuntimeRow {
  readonly name: string
  readonly protocol: IntentResolvedRuntime['protocol']
  readonly binaryPath: string | null
  readonly enabled: boolean
  readonly model: string | null
  readonly variant: string | null
  readonly temperature: number | null
  readonly steps: number | null
  readonly maxSteps: number | null
  readonly isSandbox: boolean
  readonly configDirEnv: string | null
  readonly configDirName: string | null
  readonly extraArgsJson: string | null
}

const runtimeColumns = sql`
  ${runtimes.name} AS "name",
  ${runtimes.protocol} AS "protocol",
  ${runtimes.binaryPath} AS "binaryPath",
  ${runtimes.enabled} AS "enabled",
  ${runtimes.model} AS "model",
  ${runtimes.variant} AS "variant",
  ${runtimes.temperature} AS "temperature",
  ${runtimes.steps} AS "steps",
  ${runtimes.maxSteps} AS "maxSteps",
  ${runtimes.isSandbox} AS "isSandbox",
  ${runtimes.configDirEnv} AS "configDirEnv",
  ${runtimes.configDirName} AS "configDirName",
  ${runtimes.extraArgsJson} AS "extraArgsJson"
`

function parseStringArray(json: string | null): readonly string[] | null {
  if (json === null || json.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')
      ? parsed
      : null
  } catch {
    return null
  }
}

function runtimeOf(row: IntentRuntimeRow): IntentResolvedRuntime {
  const defaults = DEFAULT_CONFIG_DIR_PROFILE[row.protocol]
  const nonEmpty = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? ''
    return trimmed.length === 0 ? null : trimmed
  }
  return {
    name: row.name,
    protocol: row.protocol,
    binaryPath: row.binaryPath,
    configDir: {
      env: nonEmpty(row.configDirEnv) ?? defaults.env,
      name: nonEmpty(row.configDirName) ?? defaults.name,
    },
    model: row.model,
    variant: row.variant,
    temperature: row.temperature === null ? null : numberOf(row.temperature),
    steps: row.steps === null ? null : numberOf(row.steps),
    maxSteps: row.maxSteps === null ? null : numberOf(row.maxSteps),
    isSandbox: row.isSandbox === true || numberOf(row.isSandbox) === 1,
    extraArgs: parseStringArray(row.extraArgsJson),
  }
}

function builtinRuntime(name: IntentResolvedRuntime['protocol']): IntentResolvedRuntime {
  return {
    name,
    protocol: name,
    binaryPath: null,
    configDir: DEFAULT_CONFIG_DIR_PROFILE[name],
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
    extraArgs: null,
  }
}

function portNames(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (typeof entry === 'string') return [entry]
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { readonly name?: unknown }).name === 'string'
      )
        return [(entry as { readonly name: string }).name]
      return []
    })
  } catch {
    return []
  }
}

function sessionInsert(record: IntentSessionRecord): SQLWrapper {
  return sql`INSERT INTO ${intentSessions} (
    ${insertColumnList(
      intentSessions.id,
      intentSessions.ownerUserId,
      intentSessions.title,
      intentSessions.status,
      intentSessions.contextRevision,
      intentSessions.contextManifestJson,
      intentSessions.handleWatermarkJson,
      intentSessions.currentDraftId,
      intentSessions.inFlightTurnId,
      intentSessions.turnSeq,
      intentSessions.commitSeq,
      intentSessions.budgetJson,
      intentSessions.createdAt,
      intentSessions.updatedAt,
    )}
  ) VALUES (
    ${record.id}, ${record.ownerUserId}, ${record.title}, ${record.status},
    ${record.contextRevision}, ${record.contextManifestJson}, ${record.handleWatermarkJson},
    ${record.currentDraftId}, ${record.inFlightTurnId}, ${record.turnSeq},
    ${record.commitSeq}, ${record.budgetJson}, ${record.createdAt}, ${record.updatedAt}
  )`
}

function turnInsert(record: IntentTurnRecord): SQLWrapper {
  return sql`INSERT INTO ${intentTurns} (
    ${insertColumnList(
      intentTurns.id,
      intentTurns.sessionId,
      intentTurns.seq,
      intentTurns.role,
      intentTurns.kind,
      intentTurns.contentJson,
      intentTurns.contextRevision,
      intentTurns.envelopeNonce,
      intentTurns.runMetaJson,
      intentTurns.clientMutationId,
      intentTurns.captureState,
      intentTurns.captureLastEventSeq,
      intentTurns.captureEventBytes,
      intentTurns.captureRootSessionId,
      intentTurns.captureIncompleteReason,
      intentTurns.scratchRetained,
      intentTurns.createdAt,
    )}
  ) VALUES (
    ${record.id}, ${record.sessionId}, ${record.seq}, ${record.role}, ${record.kind},
    ${record.contentJson}, ${record.contextRevision}, ${record.envelopeNonce},
    ${record.runMetaJson}, ${record.clientMutationId}, ${record.captureState},
    ${record.captureLastEventSeq}, ${record.captureEventBytes}, ${record.captureRootSessionId},
    ${record.captureIncompleteReason}, ${record.scratchRetained}, ${record.createdAt}
  )`
}

function budgetOf(session: IntentSessionRecord): {
  readonly generateRounds: number
  readonly questionRounds: number
} {
  let parsed: { generateRounds?: unknown; questionRounds?: unknown } = {}
  try {
    parsed = JSON.parse(session.budgetJson) as typeof parsed
  } catch {
    // Corrupt auxiliary counters retain the legacy zero fallback.
  }
  return {
    generateRounds:
      typeof parsed.generateRounds === 'number' && Number.isInteger(parsed.generateRounds)
        ? parsed.generateRounds
        : 0,
    questionRounds:
      typeof parsed.questionRounds === 'number' && Number.isInteger(parsed.questionRounds)
        ? parsed.questionRounds
        : 0,
  }
}

function assertBudget(session: IntentSessionRecord, maxGenerateRounds: number) {
  const budget = budgetOf(session)
  if (budget.generateRounds + budget.questionRounds >= maxGenerateRounds) {
    throw new ConflictError(
      'intent-budget-exhausted',
      `session reached its generation budget (${maxGenerateRounds}); raise intentBuilderMaxGenerateRounds or archive`,
    )
  }
  return budget
}

function assertWritable(session: IntentSessionRecord, ownerUserId: string): void {
  if (session.ownerUserId !== ownerUserId) {
    throw new NotFoundError('intent-session-not-found', `intent session '${session.id}' not found`)
  }
  if (session.status !== 'active') {
    throw new ConflictError('intent-session-archived', 'session is archived; reopen it first')
  }
}

function* loadSession(id: string) {
  const row = yield* firstRow<IntentSessionRecord>(sql`
    SELECT ${sessionColumns} FROM ${intentSessions} WHERE ${intentSessions.id} = ${id} LIMIT 1
  `)
  return row === null ? null : sessionOf(row)
}

function* assertNoUnsettledApply(sessionId: string) {
  const row = yield* firstRow<{ readonly id: string }>(sql`
    SELECT ${intentApplyJournal.id} AS "id"
    FROM ${intentApplyJournal}
    WHERE ${intentApplyJournal.sessionId} = ${sessionId}
      AND ${intentApplyJournal.state} IN ('prepared', 'applying')
    LIMIT 1
  `)
  if (row !== null) {
    throw new ConflictError(
      'intent-apply-in-flight',
      'a commit is being applied for this session; wait for it to settle',
    )
  }
}

function reservationOf(input: {
  readonly turnId: string
  readonly envelopeNonce: string
  readonly launchSession: IntentSessionRecord
  readonly maxGenerateRounds: number
}): ReservedIntentTurnRecord {
  return {
    turnId: input.turnId,
    envelopeNonce: input.envelopeNonce,
    launchSession: input.launchSession,
    budget: assertBudget(input.launchSession, input.maxGenerateRounds),
  }
}

function requestDigest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

function* findGenerationReplay(
  sessionId: string,
  clientMutationId: string,
  digest: string,
): Generator<IntentSqlStatement, IntentGenerationReceipt | null, unknown> {
  const userTurn = yield* firstRow<IntentTurnRecord>(sql`
    SELECT ${turnColumns} FROM ${intentTurns}
    WHERE ${intentTurns.sessionId} = ${sessionId}
      AND ${intentTurns.clientMutationId} = ${clientMutationId}
    LIMIT 1
  `)
  if (userTurn === null) return null
  let storedDigest: unknown
  try {
    storedDigest = (JSON.parse(userTurn.contentJson) as { requestDigest?: unknown }).requestDigest
  } catch {
    storedDigest = undefined
  }
  if (storedDigest !== digest) {
    throw new ConflictError(
      'intent-mutation-conflict',
      'clientMutationId was already used for a different generation request',
    )
  }
  const agentTurn = yield* firstRow<IntentTurnRecord>(sql`
    SELECT ${turnColumns} FROM ${intentTurns}
    WHERE ${intentTurns.sessionId} = ${sessionId}
      AND ${intentTurns.seq} = ${numberOf(userTurn.seq) + 1}
      AND ${intentTurns.role} = 'agent'
    LIMIT 1
  `)
  if (agentTurn === null) throw new Error('generation mutation has no successor turn')
  return { userTurnId: userTurn.id, agentTurnId: agentTurn.id, replayed: true }
}

function* reserveAfterGenerationUserTurn(input: {
  readonly session: IntentSessionRecord
  readonly clientMutationId: string
  readonly digest: string
  readonly message: string
  readonly content: Record<string, unknown>
  readonly maxGenerateRounds: number
  readonly clearCurrentDraft?: boolean
}) {
  const now = Date.now()
  const userTurnId = ulid()
  const agentTurnId = ulid()
  const envelopeNonce = generateEnvelopeNonce()
  const budget = assertBudget(input.session, input.maxGenerateRounds)
  const userSeq = input.session.turnSeq + 1
  yield* mutation(
    turnInsert({
      id: userTurnId,
      sessionId: input.session.id,
      seq: userSeq,
      role: 'user',
      kind: 'message',
      contentJson: JSON.stringify({
        message: input.message,
        requestDigest: input.digest,
        ...input.content,
      }),
      contextRevision: input.session.contextRevision,
      envelopeNonce: null,
      runMetaJson: null,
      clientMutationId: input.clientMutationId,
      captureState: null,
      captureLastEventSeq: 0,
      captureEventBytes: 0,
      captureRootSessionId: null,
      captureIncompleteReason: null,
      scratchRetained: false,
      createdAt: now,
    }),
  )
  yield* mutation(
    turnInsert({
      id: agentTurnId,
      sessionId: input.session.id,
      seq: userSeq + 1,
      role: 'agent',
      kind: 'running',
      contentJson: '{}',
      contextRevision: input.session.contextRevision,
      envelopeNonce,
      runMetaJson: null,
      clientMutationId: null,
      captureState: 'live',
      captureLastEventSeq: 0,
      captureEventBytes: 0,
      captureRootSessionId: null,
      captureIncompleteReason: null,
      scratchRetained: false,
      createdAt: now,
    }),
  )
  yield* mutation(sql`
    UPDATE ${intentSessions}
    SET ${columnIdentifier(intentSessions.currentDraftId)} = ${input.clearCurrentDraft === true ? null : input.session.currentDraftId},
      ${columnIdentifier(intentSessions.inFlightTurnId)} = ${agentTurnId},
      ${columnIdentifier(intentSessions.turnSeq)} = ${userSeq + 1},
      ${columnIdentifier(intentSessions.updatedAt)} = ${now}
    WHERE ${intentSessions.id} = ${input.session.id}
  `)
  const launchSession = yield* loadSession(input.session.id)
  if (launchSession === null) throw new Error('intent session vanished after reservation')
  return {
    receipt: { userTurnId, agentTurnId, replayed: false } satisfies IntentGenerationReceipt,
    reservation: { turnId: agentTurnId, envelopeNonce, launchSession, budget },
  }
}

function mountRequestKey(request: {
  readonly resourceType: string
  readonly name: string
}): string {
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

function validateCurrentAnswers(
  questions: ReadonlyArray<{
    readonly id: string
    readonly options: string[]
    readonly multiSelect: boolean
  }>,
  answers: PostIntentCurrentAction['answers'],
): void {
  const byId = new Map(answers.map((answer) => [answer.id, answer]))
  if (byId.size !== answers.length) {
    throw new ConflictError('intent-current-action-invalid', 'duplicate question answer')
  }
  if (byId.size !== questions.length || questions.some((question) => !byId.has(question.id))) {
    throw new ConflictError(
      'intent-current-action-invalid',
      'every current question requires exactly one answer',
    )
  }
  for (const question of questions) {
    const answer = byId.get(question.id)!
    if (!question.multiSelect && answer.picked.length !== 1) {
      throw new ConflictError(
        'intent-current-action-invalid',
        `question '${question.id}' accepts one answer`,
      )
    }
    if (answer.picked.some((picked) => !question.options.includes(picked))) {
      throw new ConflictError(
        'intent-current-action-invalid',
        `question '${question.id}' contains an unknown option`,
      )
    }
  }
}

function validateCurrentDecisions(
  requests: readonly IntentMountRequest[],
  decisions: readonly IntentMountSuggestionDecision[],
): Map<string, IntentMountSuggestionDecision> {
  const byKey = new Map<string, IntentMountSuggestionDecision>()
  for (const decision of decisions) {
    const key = mountRequestKey(decision)
    if (byKey.has(key)) {
      throw new ConflictError('intent-current-action-invalid', 'duplicate resource decision')
    }
    byKey.set(key, decision)
  }
  if (
    byKey.size !== requests.length ||
    requests.some((request) => !byKey.has(mountRequestKey(request)))
  ) {
    throw new ConflictError(
      'intent-current-action-invalid',
      'every current resource suggestion requires exactly one decision',
    )
  }
  return byKey
}

/** Provider-independent Intent table protocol. SQLite and PostgreSQL differ
 * only in how the statement generator is executed and transaction-scoped. */
export class IntentSqlPersistence implements IntentPersistence {
  constructor(private readonly runner: IntentSqlProgramRunner) {}

  async resolveIntentRuntime(name: string | null | undefined): Promise<IntentResolvedRuntime> {
    const selected = typeof name === 'string' && name.length > 0 ? name : 'opencode'
    const row = await this.runner.read(function* () {
      return yield* firstRow<IntentRuntimeRow>(sql`
        SELECT ${runtimeColumns} FROM ${runtimes}
        WHERE ${runtimes.name} = ${selected} LIMIT 1
      `)
    })
    if (row !== null) return runtimeOf(row)
    if (selected === 'opencode' || selected === 'claude-code') return builtinRuntime(selected)
    return builtinRuntime('opencode')
  }

  async listIntentRuntimeInventory(): Promise<readonly IntentRuntimeInventoryRow[]> {
    return await this.runner.read(function* () {
      const rows = yield* allRows<IntentRuntimeRow>(sql`
        SELECT ${runtimeColumns} FROM ${runtimes}
        ORDER BY ${runtimes.name}
      `)
      return rows.map((row) => ({
        name: row.name,
        protocol: row.protocol,
        enabled: row.enabled === true || numberOf(row.enabled) === 1,
      }))
    })
  }

  async loadIntentAgentPortNames(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, IntentAgentPortNames>> {
    if (ids.length === 0) return new Map()
    return await this.runner.read(function* () {
      const values = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )
      const rows = yield* allRows<{
        readonly id: string
        readonly inputs: string
        readonly outputs: string
      }>(sql`
        SELECT ${agents.id} AS "id", ${agents.inputs} AS "inputs",
          ${agents.outputs} AS "outputs"
        FROM ${agents}
        WHERE ${agents.id} IN (${values})
      `)
      return new Map(
        rows.map(
          (row) =>
            [row.id, { inputs: portNames(row.inputs), outputs: portNames(row.outputs) }] as const,
        ),
      )
    })
  }

  async findSession(id: string): Promise<IntentSessionRecord | null> {
    return await this.runner.read(function* () {
      return yield* loadSession(id)
    })
  }

  async listSessions(input: {
    readonly ownerUserId?: string
    readonly status?: IntentSessionStatus
    readonly before?: { readonly updatedAt: number; readonly id: string }
    readonly limit?: number
  }): Promise<readonly IntentSessionListRecord[]> {
    const conditions: SQLWrapper[] = []
    if (input.ownerUserId !== undefined) {
      conditions.push(sql`${intentSessions.ownerUserId} = ${input.ownerUserId}`)
    }
    if (input.status !== undefined) conditions.push(sql`${intentSessions.status} = ${input.status}`)
    if (input.before !== undefined) {
      conditions.push(sql`(
        ${intentSessions.updatedAt} < ${input.before.updatedAt}
        OR (${intentSessions.updatedAt} = ${input.before.updatedAt}
          AND ${intentSessions.id} < ${input.before.id})
      )`)
    }
    const where = conditions.length === 0 ? sql`` : sql`WHERE ${sql.join(conditions, sql` AND `)}`
    const limit =
      input.limit === undefined ? sql`` : sql`LIMIT ${Math.max(1, Math.trunc(input.limit))}`
    return await this.runner.read(function* () {
      const sessions = yield* allRows<
        IntentSessionRecord & {
          readonly currentDraftRevision: number | null
          readonly currentDraftContextRevision: number | null
          readonly currentDraftValidationJson: string | null
        }
      >(sql`
        SELECT ${sessionColumns},
          ${intentDrafts.revision} AS "currentDraftRevision",
          ${intentDrafts.contextRevision} AS "currentDraftContextRevision",
          ${intentDrafts.validationJson} AS "currentDraftValidationJson"
        FROM ${intentSessions}
        LEFT JOIN ${intentDrafts} ON ${intentSessions.currentDraftId} = ${intentDrafts.id}
        ${where}
        ORDER BY ${intentSessions.updatedAt} DESC, ${intentSessions.id} DESC
        ${limit}
      `)
      const ids = sessions.map((session) => session.id)
      if (ids.length === 0) return []
      const idList = sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )
      const turns = yield* allRows<{
        readonly sessionId: string
        readonly kind: IntentTurnRecord['kind']
        readonly seq: number
      }>(sql`
        SELECT ${intentTurns.sessionId} AS "sessionId", ${intentTurns.kind} AS "kind",
          ${intentTurns.seq} AS "seq"
        FROM ${intentTurns}
        WHERE ${intentTurns.sessionId} IN (${idList}) AND ${intentTurns.role} = 'agent'
        ORDER BY ${intentTurns.seq} DESC, ${intentTurns.id} DESC
      `)
      const commits = yield* allRows<{
        readonly sessionId: string
        readonly draftId: string
        readonly state: IntentApplyJournalRecord['state']
        readonly createdAt: number
      }>(sql`
        SELECT ${intentApplyJournal.sessionId} AS "sessionId",
          ${intentApplyJournal.draftId} AS "draftId", ${intentApplyJournal.state} AS "state",
          ${intentApplyJournal.createdAt} AS "createdAt"
        FROM ${intentApplyJournal}
        WHERE ${intentApplyJournal.sessionId} IN (${idList})
        ORDER BY ${intentApplyJournal.createdAt} DESC, ${intentApplyJournal.id} DESC
      `)
      const latestTurn = new Map<string, IntentTurnRecord['kind']>()
      for (const turn of turns)
        if (!latestTurn.has(turn.sessionId)) latestTurn.set(turn.sessionId, turn.kind)
      const latestCommit = new Map<
        string,
        { draftId: string; state: IntentApplyJournalRecord['state'] }
      >()
      for (const commit of commits) {
        if (!latestCommit.has(commit.sessionId)) {
          latestCommit.set(commit.sessionId, { draftId: commit.draftId, state: commit.state })
        }
      }
      return sessions.map((row) => ({
        ...sessionOf(row),
        currentDraftRevision:
          row.currentDraftRevision === null ? null : numberOf(row.currentDraftRevision),
        currentDraftContextRevision:
          row.currentDraftContextRevision === null
            ? null
            : numberOf(row.currentDraftContextRevision),
        currentDraftValidationJson: row.currentDraftValidationJson,
        latestAgentTurnKind: latestTurn.get(row.id) ?? null,
        latestCommit: latestCommit.get(row.id) ?? null,
      }))
    })
  }

  async listTurns(sessionId: string): Promise<readonly IntentTurnRecord[]> {
    return await this.runner.read(function* () {
      return (yield* allRows<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.sessionId} = ${sessionId}
        ORDER BY ${intentTurns.seq}
      `)).map(turnOf)
    })
  }

  async findDraft(id: string): Promise<IntentDraftRecord | null> {
    return await this.runner.read(function* () {
      const row = yield* firstRow<IntentDraftRecord>(sql`
        SELECT ${draftColumns} FROM ${intentDrafts}
        WHERE ${intentDrafts.id} = ${id} LIMIT 1
      `)
      return row === null ? null : draftOf(row)
    })
  }

  async loadSessionDetailArtifacts(
    sessionId: string,
  ): ReturnType<IntentPersistence['loadSessionDetailArtifacts']> {
    return await this.runner.read(function* () {
      const drafts = yield* allRows<IntentDraftRecord>(sql`
        SELECT ${draftColumns} FROM ${intentDrafts}
        WHERE ${intentDrafts.sessionId} = ${sessionId}
        ORDER BY ${intentDrafts.revision}
      `)
      const resolutions = yield* allRows<IntentDraftResolutionRecord>(sql`
        SELECT ${intentDraftResolutions.draftId} AS "draftId",
          ${intentDraftResolutions.reason} AS "reason"
        FROM ${intentDraftResolutions}
        WHERE ${intentDraftResolutions.sessionId} = ${sessionId}
      `)
      const commits = yield* allRows<IntentApplyJournalRecord>(sql`
        SELECT ${applyJournalColumns} FROM ${intentApplyJournal}
        WHERE ${intentApplyJournal.sessionId} = ${sessionId}
        ORDER BY ${intentApplyJournal.createdAt}
      `)
      return {
        drafts: drafts.map(draftOf),
        resolutions,
        commits: commits.map(applyJournalOf),
      }
    })
  }

  async beginTurn(
    input: Parameters<IntentPersistence['beginTurn']>[0],
  ): ReturnType<IntentPersistence['beginTurn']> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null || session.ownerUserId !== input.ownerUserId) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      if (session.status !== 'active') {
        throw new ConflictError('intent-session-archived', 'session is archived')
      }
      if (input.reservation !== undefined) {
        const turn = yield* firstRow<IntentTurnRecord>(sql`
          SELECT ${turnColumns} FROM ${intentTurns}
          WHERE ${intentTurns.id} = ${input.turnId} LIMIT 1
        `)
        if (
          session.inFlightTurnId !== input.turnId ||
          turn === null ||
          turn.sessionId !== session.id ||
          turn.role !== 'agent' ||
          turn.kind !== 'running' ||
          turn.envelopeNonce !== input.envelopeNonce ||
          input.reservation.turnId !== input.turnId ||
          input.reservation.envelopeNonce !== input.envelopeNonce
        ) {
          throw new ConflictError(
            'intent-reservation-invalid',
            'the reserved generation turn is no longer current',
          )
        }
        return {
          session,
          seq: numberOf(turn.seq),
          budget: input.reservation.budget,
        }
      }
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      const budget = assertBudget(session, input.maxGenerateRounds)
      const seq = session.turnSeq + 1
      yield* mutation(
        turnInsert({
          id: input.turnId,
          sessionId: session.id,
          seq,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision: session.contextRevision,
          envelopeNonce: input.envelopeNonce,
          runMetaJson: null,
          clientMutationId: null,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: input.now,
        }),
      )
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.inFlightTurnId)} = ${input.turnId},
          ${columnIdentifier(intentSessions.turnSeq)} = ${seq},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${session.id}
      `)
      return { session, seq, budget }
    })
  }

  async cancelReservedTurn(
    input: Parameters<IntentPersistence['cancelReservedTurn']>[0],
  ): Promise<boolean> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (
        session === null ||
        session.ownerUserId !== input.ownerUserId ||
        session.inFlightTurnId === null
      )
        return false
      const turn = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${session.inFlightTurnId} LIMIT 1
      `)
      if (
        turn === null ||
        turn.sessionId !== session.id ||
        turn.role !== 'agent' ||
        turn.kind !== 'running'
      )
        return false
      yield* mutation(sql`
        UPDATE ${intentTurns}
        SET ${columnIdentifier(intentTurns.kind)} = 'error',
          ${columnIdentifier(intentTurns.contentJson)} = ${JSON.stringify({ code: 'intent-run-aborted' })},
          ${columnIdentifier(intentTurns.captureState)} = 'complete'
        WHERE ${intentTurns.id} = ${turn.id}
      `)
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.inFlightTurnId)} = NULL,
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${session.id}
      `)
      return true
    })
  }

  async settleReservedTurnStartFailure(
    input: Parameters<IntentPersistence['settleReservedTurnStartFailure']>[0],
  ): Promise<boolean> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      const turn = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.turnId} LIMIT 1
      `)
      if (
        session === null ||
        session.ownerUserId !== input.ownerUserId ||
        session.inFlightTurnId !== input.turnId ||
        turn === null ||
        turn.sessionId !== session.id ||
        turn.role !== 'agent' ||
        turn.kind !== 'running' ||
        turn.envelopeNonce !== input.envelopeNonce
      )
        return false
      yield* mutation(sql`
        UPDATE ${intentTurns}
        SET ${columnIdentifier(intentTurns.kind)} = 'error',
          ${columnIdentifier(intentTurns.contentJson)} = ${JSON.stringify({
            code: 'intent-runtime-config-unavailable',
            ...(input.detail === '' ? {} : { detail: input.detail }),
          })},
          ${columnIdentifier(intentTurns.captureState)} = 'complete'
        WHERE ${intentTurns.id} = ${turn.id}
      `)
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.inFlightTurnId)} = NULL,
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${session.id}
      `)
      return true
    })
  }

  async refreshTurnManifest(
    input: Parameters<IntentPersistence['refreshTurnManifest']>[0],
  ): Promise<boolean> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (
        session === null ||
        session.inFlightTurnId !== input.turnId ||
        session.contextRevision !== input.launchRevision
      )
        return false
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(input.manifest)},
          ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${JSON.stringify(
            mergeHandleWatermarks(
              parseHandleWatermark(session.handleWatermarkJson),
              parseHandleWatermark(input.handleWatermarkJson),
            ),
          )},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.updatedAt}
        WHERE ${intentSessions.id} = ${session.id}
      `)
      return true
    })
  }

  async settleTurn(
    input: Parameters<IntentPersistence['settleTurn']>[0],
  ): ReturnType<IntentPersistence['settleTurn']> {
    const draftId = input.draft === undefined ? null : ulid()
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError('intent-session-not-found', 'session vanished')
      }
      const superseded =
        session.inFlightTurnId !== input.turnId || session.contextRevision !== input.launchRevision
      const finalKind = superseded ? ('error' as const) : input.kind
      const finalContent: Record<string, unknown> = superseded
        ? { code: 'intent-context-superseded', supersededResult: input.kind }
        : { ...input.content }
      let draftRevision: number | undefined
      if (
        !superseded &&
        input.kind === 'changeset' &&
        input.draft !== undefined &&
        draftId !== null
      ) {
        const previous = yield* firstRow<{ readonly revision: number | null }>(sql`
          SELECT MAX(${intentDrafts.revision}) AS "revision"
          FROM ${intentDrafts}
          WHERE ${intentDrafts.sessionId} = ${session.id}
        `)
        draftRevision = numberOf(previous?.revision ?? 0) + 1
        if (session.currentDraftId !== null && session.currentDraftId !== draftId) {
          yield* mutation(sql`
            INSERT INTO ${intentDraftResolutions} (
              ${insertColumnList(
                intentDraftResolutions.draftId,
                intentDraftResolutions.sessionId,
                intentDraftResolutions.reason,
                intentDraftResolutions.createdAt,
              )}
            ) VALUES (${session.currentDraftId}, ${session.id}, 'superseded', ${input.now})
            ON CONFLICT DO NOTHING
          `)
        }
        yield* mutation(sql`
          INSERT INTO ${intentDrafts} (
            ${insertColumnList(
              intentDrafts.id,
              intentDrafts.sessionId,
              intentDrafts.revision,
              intentDrafts.changesetJson,
              intentDrafts.validationJson,
              intentDrafts.draftHash,
              intentDrafts.producedByTurnId,
              intentDrafts.contextRevision,
              intentDrafts.createdAt,
            )}
          ) VALUES (
            ${draftId}, ${session.id}, ${draftRevision}, ${input.draft.changesetJson},
            ${input.draft.validationJson}, ${input.draft.draftHash}, ${input.turnId},
            ${session.contextRevision}, ${input.now}
          )
        `)
        yield* mutation(sql`
          UPDATE ${intentSessions}
          SET ${columnIdentifier(intentSessions.currentDraftId)} = ${draftId}
          WHERE ${intentSessions.id} = ${session.id}
        `)
        finalContent.draftRevision = draftRevision
      }
      const budget = budgetOf(session)
      const nextBudget = superseded
        ? budget
        : {
            generateRounds: budget.generateRounds + (input.budgetDelta?.generateRounds ?? 0),
            questionRounds: budget.questionRounds + (input.budgetDelta?.questionRounds ?? 0),
          }
      yield* mutation(sql`
        UPDATE ${intentTurns}
        SET ${columnIdentifier(intentTurns.kind)} = ${finalKind},
          ${columnIdentifier(intentTurns.contentJson)} = ${JSON.stringify(finalContent)},
          ${columnIdentifier(intentTurns.runMetaJson)} = ${input.runMetaJson ?? null},
          ${columnIdentifier(intentTurns.scratchRetained)} = ${input.scratchRetained}
        WHERE ${intentTurns.id} = ${input.turnId}
      `)
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.inFlightTurnId)} = ${session.inFlightTurnId === input.turnId ? null : session.inFlightTurnId},
          ${columnIdentifier(intentSessions.budgetJson)} = ${JSON.stringify(nextBudget)},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${session.id}
      `)
      return {
        turnId: input.turnId,
        kind: finalKind,
        ...(finalKind === 'error'
          ? { errorCode: String((finalContent as { code?: unknown }).code ?? 'unknown') }
          : {}),
        ...(draftRevision === undefined ? {} : { draftRevision }),
      }
    })
  }

  async createSession(input: {
    readonly session: IntentSessionRecord
    readonly userTurn: IntentTurnRecord
    readonly agentTurn?: IntentTurnRecord
  }): Promise<void> {
    await this.runner.transaction(function* () {
      yield* mutation(sessionInsert(input.session))
      yield* mutation(turnInsert(input.userTurn))
      if (input.agentTurn !== undefined) yield* mutation(turnInsert(input.agentTurn))
    })
  }

  async createSessionWithAuthorizedResources(input: {
    readonly session: IntentSessionRecord
    readonly userTurn: IntentTurnRecord
    readonly agentTurn?: IntentTurnRecord
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<void> {
    await this.runner.transaction(function* () {
      yield* assertAuthorizedResources(input.authorization, input.resources)
      yield* mutation(sessionInsert(input.session))
      yield* mutation(turnInsert(input.userTurn))
      if (input.agentTurn !== undefined) yield* mutation(turnInsert(input.agentTurn))
    })
  }

  async insertUserTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turn: IntentTurnRecord
  }): Promise<{ readonly turnId: string; readonly seq: number }> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      const seq = session.turnSeq + 1
      yield* mutation(turnInsert({ ...input.turn, seq, contextRevision: session.contextRevision }))
      yield* mutation(sql`
        UPDATE ${intentSessions} SET ${columnIdentifier(intentSessions.turnSeq)} = ${seq},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.turn.createdAt}
        WHERE ${intentSessions.id} = ${input.sessionId}
      `)
      return { turnId: input.turn.id, seq }
    })
  }

  async commitMountSuggestionDecision(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly sourceTurnId: string
    readonly expectedTurnSeq: number
    readonly expectedContextRevision: number
    readonly approvalTurn: IntentTurnRecord
    readonly manifest: readonly unknown[]
    readonly handleWatermarkJson: string
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<'committed' | 'stale'> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      if (
        session.turnSeq !== input.expectedTurnSeq ||
        session.contextRevision !== input.expectedContextRevision
      )
        return 'stale'
      const source = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.sourceTurnId} LIMIT 1
      `)
      if (
        source === null ||
        source.sessionId !== input.sessionId ||
        source.role !== 'agent' ||
        (source.kind !== 'questions' && source.kind !== 'changeset') ||
        numberOf(source.seq) !== input.expectedTurnSeq ||
        numberOf(source.contextRevision) !== input.expectedContextRevision
      )
        return 'stale'
      yield* assertAuthorizedResources(input.authorization, input.resources)
      yield* mutation(turnInsert(input.approvalTurn))
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(input.manifest)},
          ${columnIdentifier(intentSessions.contextRevision)} = ${input.approvalTurn.contextRevision},
          ${columnIdentifier(intentSessions.turnSeq)} = ${input.approvalTurn.seq},
          ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${input.handleWatermarkJson},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.approvalTurn.createdAt}
        WHERE ${intentSessions.id} = ${input.sessionId}
          AND ${intentSessions.contextRevision} = ${input.expectedContextRevision}
          AND ${intentSessions.turnSeq} = ${input.expectedTurnSeq}
      `)
      return 'committed'
    })
  }

  async insertUserTurnAndReserve(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly userTurnId: string
    readonly agentTurnId: string
    readonly envelopeNonce: string
    readonly kind: 'message' | 'answers'
    readonly contentJson: string
    readonly now: number
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly turnId: string
    readonly seq: number
    readonly reservation: ReservedIntentTurnRecord
  }> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      const budget = assertBudget(session, input.maxGenerateRounds)
      const seq = session.turnSeq + 1
      yield* mutation(
        turnInsert({
          id: input.userTurnId,
          sessionId: input.sessionId,
          seq,
          role: 'user',
          kind: input.kind,
          contentJson: input.contentJson,
          contextRevision: session.contextRevision,
          envelopeNonce: null,
          runMetaJson: null,
          clientMutationId: null,
          captureState: null,
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: input.now,
        }),
      )
      yield* mutation(
        turnInsert({
          id: input.agentTurnId,
          sessionId: input.sessionId,
          seq: seq + 1,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision: session.contextRevision,
          envelopeNonce: input.envelopeNonce,
          runMetaJson: null,
          clientMutationId: null,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: input.now,
        }),
      )
      yield* mutation(sql`
        UPDATE ${intentSessions} SET ${columnIdentifier(intentSessions.inFlightTurnId)} = ${input.agentTurnId},
          ${columnIdentifier(intentSessions.turnSeq)} = ${seq + 1}, ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${input.sessionId}
      `)
      return {
        turnId: input.userTurnId,
        seq,
        reservation: {
          turnId: input.agentTurnId,
          envelopeNonce: input.envelopeNonce,
          launchSession: session,
          budget,
        },
      }
    })
  }

  async reserveRetryTurn(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly turnId: string
    readonly envelopeNonce: string
    readonly now: number
    readonly maxGenerateRounds: number
  }): Promise<ReservedIntentTurnRecord> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      const reservation = reservationOf({
        turnId: input.turnId,
        envelopeNonce: input.envelopeNonce,
        launchSession: session,
        maxGenerateRounds: input.maxGenerateRounds,
      })
      const seq = session.turnSeq + 1
      yield* mutation(
        turnInsert({
          id: input.turnId,
          sessionId: input.sessionId,
          seq,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision: session.contextRevision,
          envelopeNonce: input.envelopeNonce,
          runMetaJson: null,
          clientMutationId: null,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: input.now,
        }),
      )
      yield* mutation(sql`
        UPDATE ${intentSessions} SET ${columnIdentifier(intentSessions.inFlightTurnId)} = ${input.turnId},
          ${columnIdentifier(intentSessions.turnSeq)} = ${seq}, ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
        WHERE ${intentSessions.id} = ${input.sessionId}
      `)
      return reservation
    })
  }

  async updateManifest(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly expectedContextRevision: number
    readonly expectedTurnSeq: number
    readonly manifest: readonly unknown[]
    readonly handleWatermarkJson?: string
    readonly updatedAt: number
  }): Promise<'updated' | 'stale'> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      if (
        session.contextRevision !== input.expectedContextRevision ||
        session.turnSeq !== input.expectedTurnSeq
      )
        return 'stale'
      const nextRevision = session.contextRevision + 1
      const changed = yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(input.manifest)},
          ${columnIdentifier(intentSessions.contextRevision)} = ${nextRevision},
          ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${input.handleWatermarkJson ?? session.handleWatermarkJson},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.updatedAt}
        WHERE ${intentSessions.id} = ${input.sessionId}
          AND ${intentSessions.contextRevision} = ${input.expectedContextRevision}
          AND ${intentSessions.turnSeq} = ${input.expectedTurnSeq}
      `)
      return changed === 1 ? 'updated' : 'stale'
    })
  }

  async updateManifestWithAuthorizedResources(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly expectedContextRevision: number
    readonly expectedTurnSeq: number
    readonly manifest: readonly unknown[]
    readonly handleWatermarkJson?: string
    readonly updatedAt: number
    readonly authorization: IntentContextResourceAuthorization
    readonly resources: readonly IntentContextResourceReference[]
  }): Promise<'updated' | 'stale'> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      if (
        session.contextRevision !== input.expectedContextRevision ||
        session.turnSeq !== input.expectedTurnSeq
      )
        return 'stale'
      yield* assertAuthorizedResources(input.authorization, input.resources)
      const nextRevision = session.contextRevision + 1
      const changed = yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(input.manifest)},
          ${columnIdentifier(intentSessions.contextRevision)} = ${nextRevision},
          ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${input.handleWatermarkJson ?? session.handleWatermarkJson},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.updatedAt}
        WHERE ${intentSessions.id} = ${input.sessionId}
          AND ${intentSessions.contextRevision} = ${input.expectedContextRevision}
          AND ${intentSessions.turnSeq} = ${input.expectedTurnSeq}
      `)
      return changed === 1 ? 'updated' : 'stale'
    })
  }

  async setStatus(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly status: IntentSessionStatus
    readonly updatedAt: number
  }): Promise<'updated' | 'unchanged'> {
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null || session.ownerUserId !== input.ownerUserId) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      if (session.status === input.status) return 'unchanged'
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      yield* mutation(sql`
        UPDATE ${intentSessions} SET ${columnIdentifier(intentSessions.status)} = ${input.status},
          ${columnIdentifier(intentSessions.updatedAt)} = ${input.updatedAt}
        WHERE ${intentSessions.id} = ${input.sessionId}
      `)
      return 'updated'
    })
  }

  async listProvenance(input: { readonly resourceType: string; readonly resourceId: string }) {
    return await this.runner.read(function* () {
      const rows = yield* allRows<{
        readonly commitId: string
        readonly sessionId: string
        readonly sessionTitle: string
        readonly sessionOwnerUserId: string
        readonly createdAt: number
      }>(sql`
        SELECT ${intentProvenance.commitId} AS "commitId",
          ${intentProvenance.sessionId} AS "sessionId",
          ${intentSessions.title} AS "sessionTitle",
          ${intentSessions.ownerUserId} AS "sessionOwnerUserId",
          ${intentProvenance.createdAt} AS "createdAt"
        FROM ${intentProvenance}
        INNER JOIN ${intentSessions} ON ${intentSessions.id} = ${intentProvenance.sessionId}
        WHERE ${intentProvenance.resourceType} = ${input.resourceType}
          AND ${intentProvenance.resourceId} = ${input.resourceId}
        ORDER BY ${intentProvenance.createdAt} DESC
      `)
      return rows.map((row) => ({ ...row, createdAt: numberOf(row.createdAt) }))
    })
  }

  async listQueuedWorkingSetSessionIds(): Promise<readonly string[]> {
    return await this.runner.read(function* () {
      const rows = yield* allRows<{ readonly sessionId: string }>(sql`
        SELECT ${intentWorkingSetChanges.sessionId} AS "sessionId"
        FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.state} = 'queued'
        ORDER BY ${intentWorkingSetChanges.createdAt} ASC,
          ${intentWorkingSetChanges.id} ASC
      `)
      return [...new Set(rows.map((row) => row.sessionId))]
    })
  }

  async listTurnIdsForBootRecovery(): Promise<readonly string[]> {
    return await this.runner.read(function* () {
      const rows = yield* allRows<{ readonly turnId: string | null }>(sql`
        SELECT ${intentSessions.inFlightTurnId} AS "turnId"
        FROM ${intentSessions}
        WHERE ${isNotNull(intentSessions.inFlightTurnId)}
        ORDER BY ${intentSessions.id} ASC
      `)
      return rows.flatMap((row) => (row.turnId === null ? [] : [row.turnId]))
    })
  }

  async listRunningTurnIds(turnIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (turnIds.length === 0) return new Set()
    return await this.runner.read(function* () {
      const rows = yield* allRows<{ readonly id: string }>(sql`
        SELECT ${intentTurns.id} AS "id"
        FROM ${intentTurns}
        WHERE ${and(inArray(intentTurns.id, [...turnIds]), sql`${intentTurns.kind} = 'running'`)}
      `)
      return new Set(rows.map((row) => row.id))
    })
  }

  async recoverTurnsOnBoot(input: {
    readonly turnIds: readonly string[]
    readonly now: number
    readonly reason: string
  }): Promise<number> {
    if (input.turnIds.length === 0) return 0
    return await this.runner.transaction(function* () {
      const orphaned = yield* allRows<{
        readonly id: string
        readonly turnId: string | null
      }>(sql`
        SELECT ${intentSessions.id} AS "id",
          ${intentSessions.inFlightTurnId} AS "turnId"
        FROM ${intentSessions}
        WHERE ${and(
          isNotNull(intentSessions.inFlightTurnId),
          inArray(intentSessions.inFlightTurnId, [...input.turnIds]),
        )}
        ORDER BY ${intentSessions.id} ASC
      `)
      for (const session of orphaned) {
        if (session.turnId === null) continue
        const turn = yield* firstRow<{
          readonly captureState: IntentTurnRecord['captureState']
        }>(sql`
          SELECT ${intentTurns.captureState} AS "captureState"
          FROM ${intentTurns}
          WHERE ${intentTurns.id} = ${session.turnId}
        `)
        yield* mutation(sql`
          UPDATE ${intentTurns}
          SET ${columnIdentifier(intentTurns.kind)} = 'error',
            ${columnIdentifier(intentTurns.contentJson)} = ${JSON.stringify({ code: input.reason })},
            ${columnIdentifier(intentTurns.scratchRetained)} = ${true},
            ${columnIdentifier(intentTurns.captureState)} = CASE
              WHEN ${turn?.captureState ?? null} = 'live' THEN 'incomplete'
              ELSE ${intentTurns.captureState}
            END,
            ${columnIdentifier(intentTurns.captureIncompleteReason)} = CASE
              WHEN ${turn?.captureState ?? null} = 'live' THEN 'post-exit-flush-timeout'
              ELSE ${intentTurns.captureIncompleteReason}
            END
          WHERE ${intentTurns.id} = ${session.turnId}
        `)
        yield* mutation(sql`
          UPDATE ${intentSessions}
          SET ${columnIdentifier(intentSessions.inFlightTurnId)} = NULL,
            ${columnIdentifier(intentSessions.updatedAt)} = ${input.now}
          WHERE ${and(
            sql`${intentSessions.id} = ${session.id}`,
            sql`${intentSessions.inFlightTurnId} = ${session.turnId}`,
          )}
        `)
      }
      return orphaned.length
    })
  }

  async markScratchSwept(input: {
    readonly cutoff: number
    readonly excludedTurnIds: readonly string[]
  }): Promise<readonly string[]> {
    return await this.runner.transaction(function* () {
      const predicate = and(
        lt(intentTurns.createdAt, input.cutoff),
        ne(intentTurns.kind, 'running'),
        ...(input.excludedTurnIds.length === 0
          ? []
          : [notInArray(intentTurns.id, [...input.excludedTurnIds])]),
      )
      const rows = yield* allRows<{ readonly id: string }>(sql`
        SELECT ${intentTurns.id} AS "id"
        FROM ${intentTurns}
        WHERE ${predicate}
        ORDER BY ${intentTurns.id} ASC
      `)
      if (rows.length > 0) {
        yield* mutation(sql`
          UPDATE ${intentTurns}
          SET ${columnIdentifier(intentTurns.scratchRetained)} = ${false}
          WHERE ${inArray(
            intentTurns.id,
            rows.map((row) => row.id),
          )}
        `)
      }
      return rows.map((row) => row.id)
    })
  }

  async reserveIteration(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentIteration
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }> {
    const digest = requestDigest(input.request)
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null || session.ownerUserId !== input.ownerUserId) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      const replay = yield* findGenerationReplay(
        input.sessionId,
        input.request.clientMutationId,
        digest,
      )
      if (replay !== null) return { receipt: replay, reservation: null }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      if (
        session.turnSeq !== input.request.expectedTurnSeq ||
        session.contextRevision !== input.request.expectedContextRevision
      ) {
        throw new ConflictError(
          'intent-iteration-stale',
          'the Intent session changed; refresh first',
        )
      }
      if (input.request.mode === 'continue-checkpoint') {
        if (
          session.currentDraftId !== null ||
          session.commitSeq < 1 ||
          session.commitSeq !== input.request.sourceCommitSeq
        ) {
          throw new ConflictError(
            'intent-checkpoint-stale',
            'the latest committed checkpoint changed; refresh before continuing',
          )
        }
        return yield* reserveAfterGenerationUserTurn({
          session,
          clientMutationId: input.request.clientMutationId,
          digest,
          message: input.request.feedback,
          content: {
            iterationMode: input.request.mode,
            sourceCommitSeq: input.request.sourceCommitSeq,
          },
          maxGenerateRounds: input.maxGenerateRounds,
        })
      }
      const draft = yield* firstRow<{
        readonly id: string
        readonly sessionId: string
        readonly revision: number
        readonly draftHash: string
        readonly contextRevision: number
      }>(sql`
        SELECT ${intentDrafts.id} AS "id", ${intentDrafts.sessionId} AS "sessionId",
          ${intentDrafts.revision} AS "revision", ${intentDrafts.draftHash} AS "draftHash",
          ${intentDrafts.contextRevision} AS "contextRevision"
        FROM ${intentDrafts}
        WHERE ${intentDrafts.id} = ${input.request.sourceDraftId}
        LIMIT 1
      `)
      if (
        draft === null ||
        draft.sessionId !== input.sessionId ||
        session.currentDraftId !== draft.id ||
        draft.draftHash !== input.request.sourceDraftHash
      ) {
        throw new ConflictError(
          'intent-draft-superseded',
          'the current draft changed; refresh before iterating',
        )
      }
      if (numberOf(draft.contextRevision) !== session.contextRevision) {
        throw new ConflictError(
          'intent-baseline-stale',
          'the working context changed; refresh first',
        )
      }
      if (input.request.mode === 'regenerate') {
        yield* mutation(sql`
          INSERT INTO ${intentDraftResolutions} (
            ${insertColumnList(
              intentDraftResolutions.draftId,
              intentDraftResolutions.sessionId,
              intentDraftResolutions.reason,
              intentDraftResolutions.createdAt,
            )}
          ) VALUES (${draft.id}, ${input.sessionId}, 'discarded', ${Date.now()})
        `)
        return yield* reserveAfterGenerationUserTurn({
          session,
          clientMutationId: input.request.clientMutationId,
          digest,
          message:
            'Discard the previous candidate and generate a fresh solution for the same intent. Do not restore the discarded draft.',
          content: {
            iterationMode: input.request.mode,
            sourceDraftId: draft.id,
            sourceDraftRevision: numberOf(draft.revision),
          },
          maxGenerateRounds: input.maxGenerateRounds,
          clearCurrentDraft: true,
        })
      }
      return yield* reserveAfterGenerationUserTurn({
        session,
        clientMutationId: input.request.clientMutationId,
        digest,
        message: input.request.feedback,
        content: {
          iterationMode: input.request.mode,
          sourceDraftId: draft.id,
          sourceDraftRevision: numberOf(draft.revision),
        },
        maxGenerateRounds: input.maxGenerateRounds,
      })
    })
  }

  async reserveRetry(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentRetry
    readonly maxGenerateRounds: number
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }> {
    const digest = requestDigest(input.request)
    return await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null || session.ownerUserId !== input.ownerUserId) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      const replay = yield* findGenerationReplay(
        input.sessionId,
        input.request.clientMutationId,
        digest,
      )
      if (replay !== null) return { receipt: replay, reservation: null }
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) {
        throw new ConflictError('intent-turn-in-flight', 'a generation turn is already running')
      }
      yield* assertNoUnsettledApply(input.sessionId)
      if (
        session.turnSeq !== input.request.expectedTurnSeq ||
        session.contextRevision !== input.request.expectedContextRevision
      ) {
        throw new ConflictError(
          'intent-retry-stale',
          'the failed turn changed; refresh before retrying',
        )
      }
      const latest = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.sessionId} = ${input.sessionId} AND ${intentTurns.role} = 'agent'
        ORDER BY ${intentTurns.seq} DESC, ${intentTurns.id} DESC
        LIMIT 1
      `)
      if (
        latest === null ||
        latest.id !== input.request.sourceTurnId ||
        numberOf(latest.seq) !== input.request.expectedTurnSeq ||
        latest.kind !== 'error' ||
        numberOf(latest.contextRevision) !== session.contextRevision
      ) {
        throw new ConflictError(
          'intent-retry-stale',
          'only the latest generation error can be retried',
        )
      }
      return yield* reserveAfterGenerationUserTurn({
        session,
        clientMutationId: input.request.clientMutationId,
        digest,
        message: 'Retry the previous failed generation using the same intent and working context.',
        content: { retryOfTurnId: latest.id },
        maxGenerateRounds: input.maxGenerateRounds,
      })
    })
  }

  async reserveCurrentAction(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentCurrentAction
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly receipt: IntentGenerationReceipt
    readonly reservation: ReservedIntentTurnRecord | null
  }> {
    const digest = requestDigest(input.request)
    const preflight = await this.runner.read(function* () {
      const replay = yield* findGenerationReplay(
        input.sessionId,
        input.request.clientMutationId,
        digest,
      )
      if (replay !== null) return { replay, session: null, source: null, additions: [] as const }
      const session = yield* loadSession(input.sessionId)
      if (session === null || session.ownerUserId !== input.ownerUserId) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      const source = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.request.sourceTurnId}
        LIMIT 1
      `)
      return { replay: null, session, source, additions: [] as const }
    })
    if (preflight.replay !== null) return { receipt: preflight.replay, reservation: null }
    const session = preflight.session!
    const source = preflight.source
    assertWritable(session, input.ownerUserId)
    if (
      session.inFlightTurnId !== null ||
      session.turnSeq !== input.request.expectedTurnSeq ||
      session.contextRevision !== input.request.expectedContextRevision ||
      source === null ||
      source.sessionId !== input.sessionId ||
      source.role !== 'agent' ||
      (source.kind !== 'questions' && source.kind !== 'changeset') ||
      numberOf(source.seq) !== session.turnSeq ||
      numberOf(source.contextRevision) !== session.contextRevision
    ) {
      throw new ConflictError(
        'intent-current-action-stale',
        'the current action changed; refresh first',
      )
    }
    let content: Record<string, unknown>
    try {
      const parsed = JSON.parse(source.contentJson) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      content = parsed as Record<string, unknown>
    } catch {
      throw new ConflictError('intent-current-action-invalid', 'the current action is unreadable')
    }
    const parsedQuestions = IntentQuestionsSchema.safeParse(content.questions)
    const questions = parsedQuestions.success ? parsedQuestions.data : []
    const parsedRequests = IntentMountRequestsSchema.safeParse(content.mountRequests)
    const requests = uniqueMountRequests(parsedRequests.success ? parsedRequests.data : [])
    if (questions.length === 0 && requests.length === 0) {
      throw new ConflictError('intent-current-action-stale', 'there is no current action to submit')
    }
    validateCurrentAnswers(questions, input.request.answers)
    const decisions = validateCurrentDecisions(requests, input.request.decisions)
    const additions: Array<{
      resourceType: IntentMountRequest['resourceType']
      resourceId: string
    }> = []
    const authorizedResources: IntentContextResourceReference[] = []
    for (const request of requests) {
      const decision = decisions.get(mountRequestKey(request))!
      if (decision.action === 'reject') continue
      if (
        !(await input.visibility.visible({
          resourceType: request.resourceType,
          resourceId: decision.resourceId,
          expectedName: request.name,
        }))
      ) {
        throw new NotFoundError('resource-not-found', `${request.resourceType} not found`)
      }
      additions.push({ resourceType: request.resourceType, resourceId: decision.resourceId })
      authorizedResources.push({
        resourceType: request.resourceType,
        resourceId: decision.resourceId,
        expectedName: request.name,
      })
    }
    return await this.runner.transaction(function* () {
      const replay = yield* findGenerationReplay(
        input.sessionId,
        input.request.clientMutationId,
        digest,
      )
      if (replay !== null) return { receipt: replay, reservation: null }
      const fresh = yield* loadSession(input.sessionId)
      if (
        fresh === null ||
        fresh.ownerUserId !== input.ownerUserId ||
        fresh.inFlightTurnId !== null ||
        fresh.turnSeq !== input.request.expectedTurnSeq ||
        fresh.contextRevision !== input.request.expectedContextRevision
      ) {
        throw new ConflictError(
          'intent-current-action-stale',
          'the current action changed; refresh first',
        )
      }
      yield* assertNoUnsettledApply(input.sessionId)
      const freshSource = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.request.sourceTurnId}
        LIMIT 1
      `)
      if (
        freshSource === null ||
        freshSource.sessionId !== input.sessionId ||
        freshSource.role !== 'agent' ||
        (freshSource.kind !== 'questions' && freshSource.kind !== 'changeset') ||
        numberOf(freshSource.seq) !== fresh.turnSeq ||
        numberOf(freshSource.contextRevision) !== fresh.contextRevision
      ) {
        throw new ConflictError(
          'intent-current-action-stale',
          'the current action changed; refresh first',
        )
      }
      yield* assertAuthorizedResources(input.visibility, authorizedResources)
      const applied = applyIntentWorkingSetDelta(
        JSON.parse(fresh.contextManifestJson) as IntentContextManifest,
        parseHandleWatermark(fresh.handleWatermarkJson),
        { additions, removals: [] },
      )
      const now = Date.now()
      const userTurnId = ulid()
      const agentTurnId = ulid()
      const envelopeNonce = generateEnvelopeNonce()
      const budget = assertBudget(fresh, input.maxGenerateRounds)
      const contextRevision = fresh.contextRevision + (applied.changed ? 1 : 0)
      const userSeq = fresh.turnSeq + 1
      yield* mutation(
        turnInsert({
          id: userTurnId,
          sessionId: input.sessionId,
          seq: userSeq,
          role: 'user',
          kind: 'answers',
          contentJson: JSON.stringify({
            answers: input.request.answers,
            mountDecisions: input.request.decisions,
            sourceTurnId: freshSource.id,
            requestDigest: digest,
          }),
          contextRevision,
          envelopeNonce: null,
          runMetaJson: null,
          clientMutationId: input.request.clientMutationId,
          captureState: null,
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: now,
        }),
      )
      yield* mutation(
        turnInsert({
          id: agentTurnId,
          sessionId: input.sessionId,
          seq: userSeq + 1,
          role: 'agent',
          kind: 'running',
          contentJson: '{}',
          contextRevision,
          envelopeNonce,
          runMetaJson: null,
          clientMutationId: null,
          captureState: 'live',
          captureLastEventSeq: 0,
          captureEventBytes: 0,
          captureRootSessionId: null,
          captureIncompleteReason: null,
          scratchRetained: false,
          createdAt: now,
        }),
      )
      yield* mutation(sql`
        UPDATE ${intentSessions}
        SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(applied.manifest)},
          ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${JSON.stringify(applied.handleWatermark)},
          ${columnIdentifier(intentSessions.contextRevision)} = ${contextRevision},
          ${columnIdentifier(intentSessions.inFlightTurnId)} = ${agentTurnId},
          ${columnIdentifier(intentSessions.turnSeq)} = ${userSeq + 1},
          ${columnIdentifier(intentSessions.updatedAt)} = ${now}
        WHERE ${intentSessions.id} = ${input.sessionId}
      `)
      const launchSession = yield* loadSession(input.sessionId)
      if (launchSession === null) throw new Error('intent session vanished after current action')
      return {
        receipt: { userTurnId, agentTurnId, replayed: false },
        reservation: { turnId: agentTurnId, envelopeNonce, launchSession, budget },
      }
    })
  }

  async latestWorkingSetChange(sessionId: string): Promise<IntentWorkingSetChangeRecord | null> {
    return await this.runner.read(function* () {
      const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.sessionId} = ${sessionId}
        ORDER BY ${intentWorkingSetChanges.createdAt} DESC,
          ${intentWorkingSetChanges.id} DESC
        LIMIT 1
      `)
      return row === null ? null : workingSetOf(row)
    })
  }

  async submitWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly request: PostIntentWorkingSetChange
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto
    readonly reservation: ReservedIntentTurnRecord | null
    readonly shouldInterrupt: boolean
  }> {
    const hash = workingSetRequestHash(input.request)
    const now = Date.now()
    const changeId = ulid()
    const admitted = await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      yield* assertNoUnsettledApply(input.sessionId)
      const replay = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.sessionId} = ${input.sessionId}
          AND ${intentWorkingSetChanges.clientMutationId} = ${input.request.clientMutationId}
        LIMIT 1
      `)
      if (replay !== null) {
        const row = workingSetOf(replay)
        if (row.requestHash !== hash) {
          throw new ConflictError(
            'intent-mutation-conflict',
            'clientMutationId was already used for a different working-context request',
          )
        }
        return { row, replayed: true, wasRunning: session.inFlightTurnId !== null }
      }
      if (
        session.turnSeq !== input.request.expectedTurnSeq ||
        session.contextRevision !== input.request.expectedContextRevision
      ) {
        throw new ConflictError(
          'intent-working-set-stale',
          'the session changed; refresh the working context before saving',
        )
      }
      const unresolved = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.sessionId} = ${input.sessionId}
          AND ${intentWorkingSetChanges.state} IN ('queued', 'applying', 'failed')
        LIMIT 1
      `)
      if (unresolved !== null) {
        if (input.request.replacesChangeId !== unresolved.id || unresolved.state === 'applying') {
          throw new ConflictError(
            'intent-working-set-pending',
            'another working-context update is still pending',
            { changeId: unresolved.id },
          )
        }
        yield* mutation(sql`
          UPDATE ${intentWorkingSetChanges}
          SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'canceled',
            ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${now}
          WHERE ${intentWorkingSetChanges.id} = ${unresolved.id}
        `)
      } else if (input.request.replacesChangeId !== undefined) {
        throw new ConflictError(
          'intent-working-set-stale',
          'the working-context update to replace is no longer pending',
        )
      }
      yield* mutation(sql`
        INSERT INTO ${intentWorkingSetChanges} (
          ${insertColumnList(
            intentWorkingSetChanges.id,
            intentWorkingSetChanges.sessionId,
            intentWorkingSetChanges.clientMutationId,
            intentWorkingSetChanges.requestHash,
            intentWorkingSetChanges.expectedTurnSeq,
            intentWorkingSetChanges.expectedContextRevision,
            intentWorkingSetChanges.mode,
            intentWorkingSetChanges.deltaJson,
            intentWorkingSetChanges.state,
            intentWorkingSetChanges.error,
            intentWorkingSetChanges.resultingContextRevision,
            intentWorkingSetChanges.resultingTurnId,
            intentWorkingSetChanges.createdAt,
            intentWorkingSetChanges.updatedAt,
          )}
        ) VALUES (
          ${changeId}, ${input.sessionId}, ${input.request.clientMutationId}, ${hash},
          ${input.request.expectedTurnSeq}, ${input.request.expectedContextRevision},
          ${input.request.mode}, ${canonicalJson(input.request.delta)}, 'queued',
          NULL, NULL, NULL, ${now}, ${now}
        )
      `)
      const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${changeId} LIMIT 1
      `)
      if (row === null) throw new Error('working-context change vanished after insert')
      return {
        row: workingSetOf(row),
        replayed: false,
        wasRunning: session.inFlightTurnId !== null,
      }
    })
    if (admitted.replayed) {
      return { change: projectWorkingSet(admitted.row), reservation: null, shouldInterrupt: false }
    }
    if (!admitted.wasRunning) {
      const activated = await this.activateWorkingSetChange({
        ownerUserId: input.ownerUserId,
        sessionId: input.sessionId,
        maxGenerateRounds: input.maxGenerateRounds,
        visibility: input.visibility,
        changeId: admitted.row.id,
      })
      return {
        change: activated.change ?? projectWorkingSet(admitted.row),
        reservation: activated.reservation,
        shouldInterrupt: false,
      }
    }
    return {
      change: projectWorkingSet(admitted.row),
      reservation: null,
      shouldInterrupt: input.request.mode === 'interrupt',
    }
  }

  async activateWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
    readonly changeId?: string
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto | null
    readonly reservation: ReservedIntentTurnRecord | null
  }> {
    const candidate = await this.runner.read(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) return null
      assertWritable(session, input.ownerUserId)
      if (session.inFlightTurnId !== null) return null
      const idCondition =
        input.changeId === undefined
          ? sql``
          : sql`AND ${intentWorkingSetChanges.id} = ${input.changeId}`
      const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.sessionId} = ${input.sessionId}
          AND ${intentWorkingSetChanges.state} = 'queued'
          ${idCondition}
        ORDER BY ${intentWorkingSetChanges.createdAt}, ${intentWorkingSetChanges.id}
        LIMIT 1
      `)
      return row === null ? null : workingSetOf(row)
    })
    if (candidate === null) return { change: null, reservation: null }
    let delta: IntentWorkingSetDelta
    try {
      delta = IntentWorkingSetDeltaSchema.parse(JSON.parse(candidate.deltaJson))
      for (const ref of delta.additions) {
        if (!(await input.visibility.visible(ref))) {
          throw new NotFoundError('resource-not-found', `${ref.resourceType} not found`)
        }
      }
    } catch (error) {
      const failed = await this.markWorkingSetFailed(candidate.id, error)
      return { change: failed === null ? null : projectWorkingSet(failed), reservation: null }
    }
    try {
      const activated = await this.runner.transaction(function* () {
        const session = yield* loadSession(input.sessionId)
        const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
          SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
          WHERE ${intentWorkingSetChanges.id} = ${candidate.id} LIMIT 1
        `)
        if (session === null || row === null || row.state !== 'queued') return null
        assertWritable(session, input.ownerUserId)
        if (session.inFlightTurnId !== null) return null
        yield* assertNoUnsettledApply(input.sessionId)
        yield* assertAuthorizedResources(input.visibility, delta.additions)
        const applied = applyIntentWorkingSetDelta(
          JSON.parse(session.contextManifestJson) as IntentContextManifest,
          parseHandleWatermark(session.handleWatermarkJson),
          delta,
        )
        const budget = assertBudget(session, input.maxGenerateRounds)
        const now = Date.now()
        const userTurnId = ulid()
        const agentTurnId = ulid()
        const envelopeNonce = generateEnvelopeNonce()
        const contextRevision = session.contextRevision + (applied.changed ? 1 : 0)
        const userSeq = session.turnSeq + 1
        yield* mutation(sql`
          UPDATE ${intentWorkingSetChanges}
          SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'applying',
            ${columnIdentifier(intentWorkingSetChanges.error)} = NULL,
            ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${now}
          WHERE ${intentWorkingSetChanges.id} = ${row.id}
            AND ${intentWorkingSetChanges.state} = 'queued'
        `)
        yield* mutation(
          turnInsert({
            id: userTurnId,
            sessionId: input.sessionId,
            seq: userSeq,
            role: 'user',
            kind: 'message',
            contentJson: JSON.stringify({
              message:
                `Working context refreshed: ${applied.addedHandles.length} added, ` +
                `${applied.removedHandles.length} removed. Continue the intent using the updated context.`,
              workingSetChangeId: row.id,
              addedHandles: applied.addedHandles,
              removedHandles: applied.removedHandles,
            }),
            contextRevision,
            envelopeNonce: null,
            runMetaJson: null,
            clientMutationId: null,
            captureState: null,
            captureLastEventSeq: 0,
            captureEventBytes: 0,
            captureRootSessionId: null,
            captureIncompleteReason: null,
            scratchRetained: false,
            createdAt: now,
          }),
        )
        yield* mutation(
          turnInsert({
            id: agentTurnId,
            sessionId: input.sessionId,
            seq: userSeq + 1,
            role: 'agent',
            kind: 'running',
            contentJson: '{}',
            contextRevision,
            envelopeNonce,
            runMetaJson: null,
            clientMutationId: null,
            captureState: 'live',
            captureLastEventSeq: 0,
            captureEventBytes: 0,
            captureRootSessionId: null,
            captureIncompleteReason: null,
            scratchRetained: false,
            createdAt: now,
          }),
        )
        yield* mutation(sql`
          UPDATE ${intentSessions}
          SET ${columnIdentifier(intentSessions.contextManifestJson)} = ${JSON.stringify(applied.manifest)},
            ${columnIdentifier(intentSessions.handleWatermarkJson)} = ${JSON.stringify(applied.handleWatermark)},
            ${columnIdentifier(intentSessions.contextRevision)} = ${contextRevision},
            ${columnIdentifier(intentSessions.inFlightTurnId)} = ${agentTurnId},
            ${columnIdentifier(intentSessions.turnSeq)} = ${userSeq + 1},
            ${columnIdentifier(intentSessions.updatedAt)} = ${now}
          WHERE ${intentSessions.id} = ${input.sessionId}
        `)
        yield* mutation(sql`
          UPDATE ${intentWorkingSetChanges}
          SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'applied',
            ${columnIdentifier(intentWorkingSetChanges.resultingContextRevision)} = ${contextRevision},
            ${columnIdentifier(intentWorkingSetChanges.resultingTurnId)} = ${agentTurnId},
            ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${now}
          WHERE ${intentWorkingSetChanges.id} = ${row.id}
        `)
        const launchSession = yield* loadSession(input.sessionId)
        const final = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
          SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
          WHERE ${intentWorkingSetChanges.id} = ${row.id} LIMIT 1
        `)
        if (launchSession === null || final === null)
          throw new Error('working-context activation vanished')
        return {
          row: workingSetOf(final),
          reservation: { turnId: agentTurnId, envelopeNonce, launchSession, budget },
        }
      })
      return activated === null
        ? { change: null, reservation: null }
        : { change: projectWorkingSet(activated.row), reservation: activated.reservation }
    } catch (error) {
      const failed = await this.markWorkingSetFailed(candidate.id, error)
      if (failed === null) throw error
      return { change: projectWorkingSet(failed), reservation: null }
    }
  }

  private async markWorkingSetFailed(
    changeId: string,
    error: unknown,
  ): Promise<IntentWorkingSetChangeRecord | null> {
    const message =
      error instanceof DomainError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    return await this.runner.transaction(function* () {
      const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${changeId} LIMIT 1
      `)
      if (row === null || row.state !== 'queued') return row === null ? null : workingSetOf(row)
      yield* mutation(sql`
        UPDATE ${intentWorkingSetChanges}
        SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'failed',
          ${columnIdentifier(intentWorkingSetChanges.error)} = ${message.slice(0, 2000)},
          ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${Date.now()}
        WHERE ${intentWorkingSetChanges.id} = ${changeId}
      `)
      const final = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${changeId} LIMIT 1
      `)
      return final === null ? null : workingSetOf(final)
    })
  }

  async cancelWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly changeId: string
  }): Promise<IntentWorkingSetChangeDto> {
    const row = await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      const found = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${input.changeId} LIMIT 1
      `)
      if (found === null || found.sessionId !== input.sessionId) {
        throw new NotFoundError('intent-working-set-not-found', 'working-context update not found')
      }
      if (found.state === 'applying') {
        throw new ConflictError('intent-working-set-applying', 'working-context update is applying')
      }
      if (found.state === 'queued' || found.state === 'failed') {
        yield* mutation(sql`
          UPDATE ${intentWorkingSetChanges}
          SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'canceled',
            ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${Date.now()}
          WHERE ${intentWorkingSetChanges.id} = ${found.id}
        `)
      }
      const final = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${found.id} LIMIT 1
      `)
      return workingSetOf(final ?? found)
    })
    return projectWorkingSet(row)
  }

  async retryWorkingSetChange(input: {
    readonly ownerUserId: string
    readonly sessionId: string
    readonly changeId: string
    readonly maxGenerateRounds: number
    readonly visibility: IntentContextResourceAuthorization
  }): Promise<{
    readonly change: IntentWorkingSetChangeDto | null
    readonly reservation: ReservedIntentTurnRecord | null
  }> {
    await this.runner.transaction(function* () {
      const session = yield* loadSession(input.sessionId)
      if (session === null) {
        throw new NotFoundError(
          'intent-session-not-found',
          `intent session '${input.sessionId}' not found`,
        )
      }
      assertWritable(session, input.ownerUserId)
      const row = yield* firstRow<IntentWorkingSetChangeRecord>(sql`
        SELECT ${workingSetColumns} FROM ${intentWorkingSetChanges}
        WHERE ${intentWorkingSetChanges.id} = ${input.changeId} LIMIT 1
      `)
      if (row === null || row.sessionId !== input.sessionId) {
        throw new NotFoundError('intent-working-set-not-found', 'working-context update not found')
      }
      if (row.state !== 'failed') {
        throw new ConflictError(
          'intent-working-set-not-failed',
          'only a failed update can be retried',
        )
      }
      yield* mutation(sql`
        UPDATE ${intentWorkingSetChanges}
        SET ${columnIdentifier(intentWorkingSetChanges.state)} = 'queued',
          ${columnIdentifier(intentWorkingSetChanges.error)} = NULL,
          ${columnIdentifier(intentWorkingSetChanges.updatedAt)} = ${Date.now()}
        WHERE ${intentWorkingSetChanges.id} = ${row.id}
      `)
    })
    return await this.activateWorkingSetChange(input)
  }
  async appendTurnEvent(
    input: Parameters<IntentPersistence['appendTurnEvent']>[0],
  ): ReturnType<IntentPersistence['appendTurnEvent']> {
    return await this.runner.transaction(function* () {
      const turn = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.turnId} LIMIT 1
      `)
      if (turn === null || turn.captureState === null) {
        throw new NotFoundError('intent-turn-not-found', 'intent turn capture target not found')
      }
      const current = turnOf(turn)
      if (current.captureState !== 'live') {
        return { eventSeq: current.captureLastEventSeq, duplicate: false, stopped: true }
      }
      if (input.externalEventId !== null) {
        const duplicate = yield* firstRow<{ readonly id: number }>(sql`
          SELECT ${intentTurnEvents.id} AS "id" FROM ${intentTurnEvents}
          WHERE ${intentTurnEvents.turnId} = ${input.turnId}
            AND ${intentTurnEvents.source} = ${input.source}
            AND ${intentTurnEvents.externalEventId} = ${input.externalEventId}
          LIMIT 1
        `)
        if (duplicate !== null) {
          return { eventSeq: current.captureLastEventSeq, duplicate: true, stopped: false }
        }
      }
      if (
        current.captureLastEventSeq >= input.rowLimit ||
        current.captureEventBytes + input.byteLength > input.byteLimit
      ) {
        yield* mutation(sql`
          UPDATE ${intentTurns}
          SET ${columnIdentifier(intentTurns.captureState)} = 'truncated',
            ${columnIdentifier(intentTurns.captureIncompleteReason)} = NULL
          WHERE ${intentTurns.id} = ${input.turnId}
        `)
        return { eventSeq: current.captureLastEventSeq, duplicate: false, stopped: true }
      }
      const eventSeq = current.captureLastEventSeq + 1
      yield* mutation(sql`
        INSERT INTO ${intentTurnEvents} (
          ${insertColumnList(
            intentTurnEvents.turnId,
            intentTurnEvents.eventSeq,
            intentTurnEvents.ts,
            intentTurnEvents.kind,
            intentTurnEvents.payload,
            intentTurnEvents.sessionId,
            intentTurnEvents.parentSessionId,
            intentTurnEvents.source,
            intentTurnEvents.externalEventId,
          )}
        ) VALUES (
          ${input.turnId}, ${eventSeq}, ${input.ts}, ${input.kind}, ${input.payload},
          ${input.sessionId}, ${input.parentSessionId}, ${input.source}, ${input.externalEventId}
        )
      `)
      yield* mutation(sql`
        UPDATE ${intentTurns}
        SET ${columnIdentifier(intentTurns.captureLastEventSeq)} = ${eventSeq},
          ${columnIdentifier(intentTurns.captureEventBytes)} = ${current.captureEventBytes + input.byteLength}
        WHERE ${intentTurns.id} = ${input.turnId}
      `)
      return { eventSeq, duplicate: false, stopped: false }
    })
  }

  async replaceTurnRootSession(
    input: Parameters<IntentPersistence['replaceTurnRootSession']>[0],
  ): ReturnType<IntentPersistence['replaceTurnRootSession']> {
    return await this.runner.transaction(function* () {
      const row = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.turnId} LIMIT 1
      `)
      if (row === null || row.captureState === null) {
        throw new NotFoundError('intent-turn-not-found', 'intent turn capture target not found')
      }
      const turn = turnOf(row)
      if (turn.captureRootSessionId === input.sessionId) {
        return {
          eventSeq: turn.captureLastEventSeq,
          captureState: turn.captureState,
          conflict: false,
        }
      }
      if (
        turn.captureRootSessionId !== null &&
        (input.previousSessionId === undefined ||
          turn.captureRootSessionId !== input.previousSessionId)
      ) {
        yield* mutation(sql`
          UPDATE ${intentTurns}
          SET ${columnIdentifier(intentTurns.captureState)} = 'incomplete',
            ${columnIdentifier(intentTurns.captureIncompleteReason)} = 'stream-persist-failed'
          WHERE ${intentTurns.id} = ${input.turnId}
        `)
        return {
          eventSeq: turn.captureLastEventSeq,
          captureState: 'incomplete' as const,
          conflict: true,
        }
      }
      yield* mutation(sql`
        UPDATE ${intentTurns}
        SET ${columnIdentifier(intentTurns.captureRootSessionId)} = ${input.sessionId}
        WHERE ${intentTurns.id} = ${input.turnId}
      `)
      if (input.previousSessionId !== undefined) {
        yield* mutation(sql`
          UPDATE ${intentTurnEvents}
          SET ${columnIdentifier(intentTurnEvents.sessionId)} = ${input.sessionId}
          WHERE ${intentTurnEvents.turnId} = ${input.turnId}
            AND ${intentTurnEvents.sessionId} = ${input.previousSessionId}
        `)
        yield* mutation(sql`
          UPDATE ${intentTurnEvents}
          SET ${columnIdentifier(intentTurnEvents.parentSessionId)} = ${input.sessionId}
          WHERE ${intentTurnEvents.turnId} = ${input.turnId}
            AND ${intentTurnEvents.parentSessionId} = ${input.previousSessionId}
        `)
      }
      return {
        eventSeq: turn.captureLastEventSeq,
        captureState: turn.captureState,
        conflict: false,
      }
    })
  }

  async readTurnCapture(turnId: string): Promise<IntentTurnRecord | null> {
    return await this.runner.read(function* () {
      const row = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${turnId} LIMIT 1
      `)
      return row === null ? null : turnOf(row)
    })
  }

  async settleTurnCapture(
    input: Parameters<IntentPersistence['settleTurnCapture']>[0],
  ): ReturnType<IntentPersistence['settleTurnCapture']> {
    return await this.runner.transaction(function* () {
      const row = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${input.turnId} LIMIT 1
      `)
      if (row === null || row.captureState === null) {
        return { eventSeq: 0, captureState: null }
      }
      const turn = turnOf(row)
      let state = input.state
      let reason = input.incompleteReason ?? null
      if (
        turn.captureState === 'incomplete' ||
        (turn.captureState === 'truncated' && input.state !== 'incomplete')
      ) {
        state = turn.captureState
        reason = turn.captureIncompleteReason
      }
      if (state !== turn.captureState || reason !== turn.captureIncompleteReason) {
        yield* mutation(sql`
          UPDATE ${intentTurns}
          SET ${columnIdentifier(intentTurns.captureState)} = ${state},
            ${columnIdentifier(intentTurns.captureIncompleteReason)} = ${state === 'incomplete' ? (reason ?? 'stream-persist-failed') : null},
            ${columnIdentifier(intentTurns.captureRootSessionId)} = ${input.rootSessionId === undefined ? turn.captureRootSessionId : input.rootSessionId}
          WHERE ${intentTurns.id} = ${input.turnId}
        `)
      }
      return { eventSeq: turn.captureLastEventSeq, captureState: state }
    })
  }

  async readTurnSession(turnId: string): ReturnType<IntentPersistence['readTurnSession']> {
    return await this.runner.read(function* () {
      const row = yield* firstRow<IntentTurnRecord>(sql`
        SELECT ${turnColumns} FROM ${intentTurns}
        WHERE ${intentTurns.id} = ${turnId} LIMIT 1
      `)
      if (row === null) return null
      const events = yield* allRows<IntentTurnEventRecord>(sql`
        SELECT ${turnEventColumns} FROM ${intentTurnEvents}
        WHERE ${intentTurnEvents.turnId} = ${turnId}
        ORDER BY ${intentTurnEvents.eventSeq}
      `)
      return { turn: turnOf(row), events: events.map(eventOf) }
    })
  }
}
