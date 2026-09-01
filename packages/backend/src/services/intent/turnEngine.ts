// RFC-234 §0/§3.3/§7 (T5) — the intent turn engine.
//
// One turn = one ephemeral system-agent run (no opencode resume — multi-turn
// is full context replay):
//   mint turn row (envelope nonce persisted SAME tx — design-gate P2-1)
//   → build dump (fresh manifest, fences captured = commit baseline)
//   → INTENT.md + protocol block → runSystemAgent (natural runtime, Semaphore)
//   → parse envelope (summary + changeset XOR questions + optional requests)
//   → settle under context-epoch CAS: a superseded/cancelled turn archives as
//     error and NEVER installs a draft (design-gate P0-3); a valid changeset
//     mints an IMMUTABLE draft revision (design-gate P1-5).
//
// Budgets (config): generate / question round caps per session. Boot recovery
// + scratch GC live in ./maintenance.ts.

import { z } from 'zod'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  INTENT_RESOURCE_TYPES,
  type IntentResourceType,
  INTENT_LIMITS,
  IntentMountRequestsSchema,
  IntentQuestionsSchema,
  buildProtocolBlock,
  canonicalIntentJson,
  maskDiagnosticsText,
  parseIntentChangeset,
  type IntentQuestion,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { createLogger, type Logger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { generateEnvelopeNonce } from '@/services/nodeRunMint'
import { extractLastEnvelope, parseEnvelope } from '@/services/envelope'
import {
  releaseSystemAgentScratch,
  runSystemAgent,
  type SystemAgentRunOptions,
  type SystemAgentRunResult,
} from '@/services/systemAgentRun'
import type { SystemAgentOutputEvidence } from '@/services/runtime/types'
import { IntentTurnSessionEventSink } from './turnSession'
import { buildIntentDump } from './dumpBuilder'
import { parseHandleWatermark } from './manifest'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'
import { buildIntentDoc, privilegesFromLens, type IntentDocTurn } from './intentDoc'
import { validateDraftChangeset } from './resolveChangeset'
import { sessionManifest, type ReservedIntentTurn, type IntentTurnRow } from './session'
import { sha256Hex } from '@/util/hash'
import { normalizeIntentWorkflowCreateLayouts } from '@/modules/intent/domain/workflowCreateLayout'
import type { IntentResourceCatalogBinding } from './resourceCatalog'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPersistence,
  IntentResolvedRuntime,
  IntentTurnRuntimeResolver,
} from '@/modules/intent/public/operations'

export const INTENT_BUILDER_AGENT_NAME = 'aw-intent-builder'
export const INTENT_SCRATCH_DIRNAME = 'intent-scratch'

/** Frozen in source (distiller precedent — memoryDistiller.ts DISTILLER_SYSTEM_PROMPT).
 *  Deliberately English-only and short: INTENT.md carries the full contract. */
export const INTENT_BUILDER_SYSTEM_PROMPT = `You are the agent-workflow intent builder — a resource architect.
Read INTENT.md in your working directory FIRST; it defines the platform model,
the session goal and history, and your exact output contract. Explore
inventory/ and mounted/ as needed. Use the ordinary runtime tools available to
you when they help produce a correct result; return the final result through
the required envelope on stdout.
Never invent identifiers: reference existing resources by their res#…
handles and new ones by $new:… tempRefs. Secret values must be the ‹secret›
sentinel. When the intent is ambiguous, ask structured questions instead of
guessing.`

export interface IntentTurnConfig {
  runtime: IntentResolvedRuntime
  /** Output-language directive text; null → mirror the user's input language. */
  lang: string | null
  timeoutMs: number
  stdoutCapBytes: number
  maxGenerateRounds: number
  maxQuestionRounds: number
  extraInstructions: string | null
  scratchRetentionHours?: number
  /** RFC-348 D5b — the runtime an agent inherits when it omits `runtime` (name + protocol). */
  effectiveDefaultRuntime?: { name: string; protocol: string }
}

export interface RunIntentTurnDeps {
  persistence: IntentPersistence
  appHome: string
  config: IntentTurnConfig
  readonly resourceCatalog: IntentResourceCatalogBinding
  readonly dumpAuxiliary: IntentDumpAuxiliaryQueries
  /** Test seam — defaults to runSystemAgent. */
  runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  /** WS seam (T7 wires the broadcaster); default noop. */
  onSessionEvent?: (event: {
    type: string
    sessionId: string
    turnId?: string
    eventSeq?: number
  }) => void
  log?: Logger
}

export interface IntentTurnOutcome {
  turnId: string
  kind: 'questions' | 'changeset' | 'error'
  errorCode?: string
  draftRevision?: number
}

const intentSem = new Semaphore(2)
const liveTurnAborts = new Map<string, AbortController>()

export type MissingEnvelopeReason =
  | 'output-cap-hit'
  | 'no-assistant-text'
  | 'terminal-without-envelope'
  | 'assistant-stopped-without-envelope'
  | 'runtime-shape-unknown'

export function classifyMissingEnvelope(
  evidence: SystemAgentOutputEvidence | undefined,
): MissingEnvelopeReason {
  if (evidence === undefined) return 'runtime-shape-unknown'
  if (
    evidence.eventTextCapHit ||
    evidence.observedAssistantTextBytes > evidence.retainedAssistantTextBytes
  ) {
    return 'output-cap-hit'
  }
  if (!evidence.assistantTextSeen) return 'no-assistant-text'
  if (evidence.terminalResult !== 'not-observed') return 'terminal-without-envelope'
  if (evidence.assistantTextSeen) return 'assistant-stopped-without-envelope'
  return 'runtime-shape-unknown'
}

/**
 * RFC-348 D4 (RFC-235 D33) — the resource type the user picked when opening the
 * session, read off the first user turn's `hint` and parsed against the roster.
 * Free text (pre-RFC-348 sessions) and absence both mean "no preference".
 */
export function requestedArtifactTypeOf(
  turns: readonly { role: string; kind: string; contentJson: string }[],
): IntentResourceType | null {
  // `kind === 'message'` is only ever a USER turn (agent turns are questions /
  // changeset / error), so the turn role needs no comparison here — and the
  // RFC-305 architecture lock treats `role === 'user'` as an account-role predicate.
  const first = turns.find((t) => t.kind === 'message')
  if (first === undefined) return null
  let hint: unknown
  try {
    hint = (JSON.parse(first.contentJson) as { hint?: unknown }).hint
  } catch {
    return null
  }
  const parsed = z.enum(INTENT_RESOURCE_TYPES).safeParse(hint)
  return parsed.success ? parsed.data : null
}

function turnDisplayText(turn: IntentTurnRow): string {
  const content = JSON.parse(turn.contentJson) as Record<string, unknown>
  switch (turn.kind) {
    case 'message':
      return String(content.message ?? '')
    case 'answers':
    case 'mount-approval':
      return JSON.stringify(content)
    case 'questions':
      return `asked: ${JSON.stringify(content.questions ?? [])}`
    case 'changeset':
      return String(content.summary ?? '(changeset)')
    case 'error':
      return `error: ${String(content.code ?? 'unknown')}`
    default:
      return ''
  }
}

/** Abort the in-flight turn of a session (owner-gated at the route layer).
 *  Returns false when nothing was in flight. */
export function abortIntentTurn(sessionId: string): boolean {
  const controller = liveTurnAborts.get(sessionId)
  if (controller === undefined) return false
  controller.abort()
  return true
}

/** Cancel either a live runtime or the durable reservation before fireTurn has
 * installed its AbortController. Reservation-first generation deliberately
 * creates that short window; leaving the old map-only cancel here would show
 * an enabled Cancel action that returns false while the row remains running. */
export async function cancelIntentTurn(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
): Promise<boolean> {
  if (abortIntentTurn(sessionId)) return true
  return await persistence.cancelReservedTurn({
    ownerUserId: actor.user.id,
    sessionId,
    now: Date.now(),
  })
}

/** Settle a reservation that could not even resolve its runtime configuration.
 * The user-visible running row already exists, so leaving it live would create
 * an unrecoverable phantom turn. Exact slot + nonce checks make a concurrent
 * cancel/supersede a no-op instead of overwriting its newer state. */
export async function settleReservedIntentTurnStartFailure(
  persistence: IntentPersistence,
  input: {
    sessionId: string
    actor: Actor
    reservation: ReservedIntentTurn
    detail: string
  },
): Promise<boolean> {
  const detail = maskDiagnosticsText(input.detail).slice(0, 2048)
  const settled = await persistence.settleReservedTurnStartFailure({
    ownerUserId: input.actor.user.id,
    sessionId: input.sessionId,
    turnId: input.reservation.turnId,
    envelopeNonce: input.reservation.envelopeNonce,
    detail,
    now: Date.now(),
  })
  if (settled) liveTurnAborts.delete(input.sessionId)
  return settled
}

export async function runIntentTurn(
  deps: RunIntentTurnDeps,
  input: { sessionId: string; actor: Actor; reservation?: ReservedIntentTurn },
): Promise<IntentTurnOutcome> {
  const log = deps.log ?? createLogger('intentTurn')
  const runFn = deps.runFn ?? runSystemAgent
  const now = Date.now()
  const turnId = input.reservation?.turnId ?? ulid()
  const envelopeNonce = input.reservation?.envelopeNonce ?? generateEnvelopeNonce()

  // ── mint the running turn + take the in-flight slot (one tx; nonce persists
  // with the row — design-gate P2-1) ──
  const minted = await deps.persistence.beginTurn({
    ownerUserId: input.actor.user.id,
    sessionId: input.sessionId,
    turnId,
    envelopeNonce,
    now,
    maxGenerateRounds: deps.config.maxGenerateRounds,
    ...(input.reservation === undefined
      ? {}
      : {
          reservation: {
            turnId: input.reservation.turnId,
            envelopeNonce: input.reservation.envelopeNonce,
            budget: input.reservation.budget,
          },
        }),
  })
  deps.onSessionEvent?.({ type: 'intent.turn.started', sessionId: input.sessionId, turnId })

  const launchRevision = minted.session.contextRevision
  const controller = new AbortController()
  liveTurnAborts.set(input.sessionId, controller)
  const sessionEventSink = new IntentTurnSessionEventSink(deps.persistence, turnId, (eventSeq) => {
    deps.onSessionEvent?.({
      type: 'intent.turn.execution.updated',
      sessionId: input.sessionId,
      turnId,
      eventSeq,
    })
  })
  const markSessionCapture = async (
    state: 'complete' | 'incomplete',
    reason?: 'post-exit-flush-timeout',
  ): Promise<void> => {
    try {
      await sessionEventSink.markTerminal(state, reason)
    } catch (error) {
      // Session capture is auxiliary evidence. Never replace a valid Intent
      // questions/changeset/error outcome with an observation write failure.
      log.warn('intent-turn-session-terminal-write-failed', {
        sessionId: input.sessionId,
        turnId,
        err: maskDiagnosticsText(error instanceof Error ? error.message : String(error)),
      })
    }
  }

  const settle = async (
    kind: 'questions' | 'changeset' | 'error',
    content: Record<string, unknown>,
    opts: {
      runMeta?: Record<string, unknown>
      scratchRetained?: boolean
      draft?: { changesetJson: string; canonicalJson: string; validationJson: string }
      budgetDelta?: { generateRounds?: number; questionRounds?: number }
    } = {},
  ): Promise<IntentTurnOutcome> => {
    const settled = await deps.persistence.settleTurn({
      sessionId: input.sessionId,
      turnId,
      launchRevision,
      kind,
      content,
      ...(opts.runMeta === undefined ? {} : { runMetaJson: JSON.stringify(opts.runMeta) }),
      scratchRetained: opts.scratchRetained === true,
      ...(opts.budgetDelta === undefined ? {} : { budgetDelta: opts.budgetDelta }),
      ...(opts.draft === undefined
        ? {}
        : {
            draft: {
              changesetJson: opts.draft.changesetJson,
              validationJson: opts.draft.validationJson,
              draftHash: `sha256:${sha256Hex(opts.draft.canonicalJson)}`,
            },
          }),
      now: Date.now(),
    })
    liveTurnAborts.delete(input.sessionId)
    deps.onSessionEvent?.({ type: 'intent.turn.finished', sessionId: input.sessionId, turnId })
    return settled
  }

  try {
    // ── context assembly ──
    const manifestBefore = sessionManifest(minted.session)
    const roots = manifestBefore
      .filter((e) => e.root)
      .map((e) => ({ resourceType: e.resourceType, resourceId: e.resourceId }))
    const dump = await buildIntentDump({
      actor: input.actor,
      resourceCatalog: deps.resourceCatalog,
      appHome: deps.appHome,
      mounts: roots,
      priorManifest: manifestBefore,
      // RFC-291 面 F — the rebuilt manifest drops evicted/deleted entries, so
      // its ordinals alone can go backwards; the persisted watermark is what
      // keeps a handle from being re-minted for a different resource.
      handleWatermark: parseHandleWatermark(minted.session.handleWatermarkJson),
      envelopeNonce,
      runtimeInventory: deps.dumpAuxiliary.runtimeInventory,
      loadAgentPorts: deps.dumpAuxiliary.loadAgentPorts,
      platformInventory: deps.dumpAuxiliary.platformInventory,
      ...(deps.config.effectiveDefaultRuntime === undefined
        ? {}
        : { effectiveDefaultRuntime: deps.config.effectiveDefaultRuntime }),
    })
    // Persist the fresh manifest (fences captured now = the commit baseline
    // for whatever draft this turn produces).
    await deps.persistence.refreshTurnManifest({
      sessionId: input.sessionId,
      turnId,
      launchRevision,
      manifest: dump.manifest,
      handleWatermarkJson: JSON.stringify(dump.handleWatermark),
      updatedAt: Date.now(),
    })

    const allTurns = (await deps.persistence.listTurns(input.sessionId)).filter(
      (candidate) => candidate.id !== turnId,
    )
    const docTurns: IntentDocTurn[] = allTurns.map((t) => ({
      seq: t.seq,
      role: t.role,
      kind: t.kind === 'running' ? 'error' : t.kind,
      text: turnDisplayText(t),
    }))
    const lastAgentTurn = [...allTurns].reverse().find((t) => t.role === 'agent')
    const pendingQuestions: IntentQuestion[] =
      lastAgentTurn?.kind === 'questions'
        ? ((JSON.parse(lastAgentTurn.contentJson) as { questions?: IntentQuestion[] }).questions ??
          [])
        : []
    const currentDraft =
      minted.session.currentDraftId === null
        ? undefined
        : ((await deps.persistence.findDraft(minted.session.currentDraftId)) ?? undefined)
    const validationErrors =
      currentDraft === undefined
        ? []
        : ((JSON.parse(currentDraft.validationJson) as { errors?: string[] }).errors ?? [])

    const intentDoc = buildIntentDoc({
      sessionTitle: minted.session.title,
      turns: docTurns,
      currentDraftJson: currentDraft?.changesetJson ?? null,
      validationErrors,
      pendingQuestions,
      hiddenDependencyNote:
        dump.hiddenDependencies.length === 0
          ? null
          : `Some mounted resources depend on resources you cannot see (${dump.hiddenDependencies
              .map((h) => `${h.parentHandle}: ${h.count}`)
              .join(', ')}). Propose copies or ask the user instead of guessing their contents.`,
      // RFC-291 面 C — id-only, never the name: these resources are ones the
      // actor can no longer see, so echoing their names would leak them.
      unavailableMountNote:
        dump.unavailableMounts.length === 0
          ? null
          : `Mounted resources unavailable this epoch (deleted, or no longer visible to you): ${dump.unavailableMounts
              .map((m) => `${m.handle} (${m.resourceType})`)
              .join(
                ', ',
              )}. They are absent from mounted/; do not guess their contents, and do not target them with an update.`,
      envelopeNonce,
      langDirective:
        deps.config.lang === null
          ? 'Write generated artifact prose (descriptions, prompts) in the language the user used in their intent.'
          : `Write generated artifact prose (descriptions, prompts) in: ${deps.config.lang}.`,
      // RFC-253 / RFC-269 — derive from the SAME lens the read redaction and the
      // two author gates read, inverted once here. Recomputing the two
      // `permissions.has(...)` checks locally would be a second source of truth
      // for "may this session author privileged nodes".
      privileges: privilegesFromLens(privilegedNodeLensFor(input.actor)),
      requestedArtifactType: requestedArtifactTypeOf(allTurns),
    })

    // Protocol tail: the SHARED block renders "list ALL these ports" with a
    // combined example — feeding it all four ports made models emit changeset
    // AND questions together (live deepseek run, 2026-07-28 → every turn died
    // on intent-ports-exclusive). Render the mainline shape (summary +
    // changeset) and state the exclusive/optional forms explicitly beside it.
    const prompt = `Read INTENT.md, inventory/ and mounted/ in your working directory, then produce this turn's result.${buildProtocolBlock(
      ['summary', 'changeset'],
      undefined,
      envelopeNonce,
    )}
EXCLUSIVITY RULE — emit EXACTLY ONE of \`changeset\` or \`questions\`, never both and never neither:
- Default (you can produce the build/modify result now): emit \`summary\` + \`changeset\` exactly as shown above.
- Only when you are blocked on user decisions: OMIT the \`changeset\` port entirely and emit \`summary\` plus <port name="questions">[{"id":"q1","question":"…","options":["…"],"multiSelect":false}]</port>.
- In either mode you MAY add <port name="requests">[{"resourceType":"agent","name":"…","reason":"…"}]</port> to SUGGEST mounting existing resources you could not find in mounted/; suggestions are approval-gated and never auto-applied.`
    const systemPrompt =
      deps.config.extraInstructions === null
        ? INTENT_BUILDER_SYSTEM_PROMPT
        : `${INTENT_BUILDER_SYSTEM_PROMPT}\n\n## Administrator instructions\n\n${deps.config.extraInstructions}`

    // ── run ──
    const releaseSlot = await intentSem.acquire()
    let result: SystemAgentRunResult
    try {
      result = await runFn({
        feature: 'intent-builder',
        agentName: INTENT_BUILDER_AGENT_NAME,
        systemPrompt,
        prompt,
        protocol: deps.config.runtime.protocol,
        runtimeBinary: deps.config.runtime.binaryPath,
        // RFC-237 (P1-2): RFC-154 config-dir profile of the selected runtime
        // row (folded over the protocol default by resolveInternalAgentRuntime)
        // — a custom claude fork that changed its discovery surface still lands
        // in the private per-run dir. opencode ignores both fields.
        configDirEnv: deps.config.runtime.configDir.env,
        configDirName: deps.config.runtime.configDir.name,
        model: deps.config.runtime.model,
        isSandbox: deps.config.runtime.isSandbox,
        seedFiles: [{ path: 'INTENT.md', content: intentDoc }, ...dump.seedFiles],
        scratchParent: join(deps.appHome, INTENT_SCRATCH_DIRNAME),
        scratchName: turnId,
        timeoutMs: deps.config.timeoutMs,
        maxEventTextBytes: deps.config.stdoutCapBytes,
        abortSignal: controller.signal,
        eventSink: sessionEventSink,
        // Intent owns the second phase: protocol failures keep the successful
        // runtime scratch for bounded forensics; valid results release it.
        retainScratchOnSuccess: true,
        log,
      })
    } finally {
      releaseSlot()
    }
    await markSessionCapture(
      result.status === 'unreaped' ? 'incomplete' : 'complete',
      result.status === 'unreaped' ? 'post-exit-flush-timeout' : undefined,
    )

    let scratchReleaseFailed = false
    const buildRunMeta = (): Record<string, unknown> => ({
      runtime: deps.config.runtime.name,
      model: deps.config.runtime.model ?? null,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      status: result.status,
      outputEvidence: result.outputEvidence,
      ...(result.stderrTail === '' ? {} : { stderrTail: result.stderrTail }),
      // RFC-237 impl-gate P2 — the terminal claude is_error text (masked in
      // runSystemAgent) persists with the turn so "Not logged in"-class causes
      // are actionable, not just `intent-run-result-error`.
      ...(result.resultError === undefined ? {} : { resultError: result.resultError }),
      ...(result.scratchRetained
        ? { scratchRetentionHours: deps.config.scratchRetentionHours ?? 24 }
        : {}),
      ...(scratchReleaseFailed ? { scratchReleaseFailed: true } : {}),
    })
    let runMeta = buildRunMeta()
    const releaseScratch = (): void => {
      if (!result.scratchRetained) return
      const released = releaseSystemAgentScratch({
        scratchDir: result.scratchDir,
        expectedParent: join(deps.appHome, INTENT_SCRATCH_DIRNAME),
        expectedName: turnId,
      })
      if (released.removed) result = { ...result, scratchRetained: false }
      else {
        scratchReleaseFailed = true
        log.warn('intent-scratch-release-failed', { turnId, reason: released.reason })
      }
      runMeta = buildRunMeta()
    }
    if (result.status !== 'ok') {
      return settle(
        'error',
        {
          code: `intent-run-${result.status}`,
        },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }

    // ── envelope ──
    const envelope = extractLastEnvelope(result.eventText, envelopeNonce)
    if (envelope === null) {
      return settle(
        'error',
        {
          code: 'intent-envelope-missing',
          reason: classifyMissingEnvelope(result.outputEvidence),
        },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }
    const parsed = parseEnvelope(
      envelope,
      ['summary', 'changeset', 'questions', 'requests'],
      envelopeNonce,
    )
    if (parsed.malformedPorts.length > 0) {
      return settle(
        'error',
        { code: 'intent-envelope-malformed', ports: parsed.malformedPorts },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }
    const summary = (parsed.ports.get('summary') ?? '').trim().slice(0, 2048)
    const changesetText = (parsed.ports.get('changeset') ?? '').trim()
    const questionsText = (parsed.ports.get('questions') ?? '').trim()
    const requestsText = (parsed.ports.get('requests') ?? '').trim()
    if ((changesetText === '') === (questionsText === '')) {
      return settle(
        'error',
        {
          code: 'intent-ports-exclusive',
          detail: `exactly one of changeset|questions required (changeset present=${
            changesetText !== ''
          }, questions present=${questionsText !== ''})`,
        },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }

    let mountRequests: unknown[] = []
    if (requestsText !== '') {
      try {
        const parsedRequests = IntentMountRequestsSchema.safeParse(JSON.parse(requestsText))
        if (parsedRequests.success) mountRequests = parsedRequests.data
      } catch {
        /* invalid requests are dropped — they are suggestions only */
      }
    }

    if (questionsText !== '') {
      let questions: unknown
      try {
        questions = JSON.parse(questionsText)
      } catch (err) {
        return settle(
          'error',
          { code: 'intent-questions-invalid', detail: (err as Error).message },
          { runMeta, scratchRetained: result.scratchRetained },
        )
      }
      const q = IntentQuestionsSchema.safeParse(questions)
      if (!q.success) {
        return settle(
          'error',
          {
            code: 'intent-questions-invalid',
            detail: q.error.issues.map((i) => i.message).join('; '),
          },
          { runMeta, scratchRetained: result.scratchRetained },
        )
      }
      releaseScratch()
      const budget = minted.budget
      if (budget.questionRounds >= deps.config.maxQuestionRounds) {
        return settle(
          'error',
          { code: 'intent-question-budget-exhausted' },
          { runMeta, scratchRetained: result.scratchRetained },
        )
      }
      return settle(
        'questions',
        { summary, questions: q.data, mountRequests },
        { runMeta, scratchRetained: result.scratchRetained, budgetDelta: { questionRounds: 1 } },
      )
    }

    const cs = parseIntentChangeset(changesetText)
    if (!cs.ok) {
      return settle(
        'error',
        {
          code: 'intent-changeset-invalid',
          // JSON syntax failures are not synonymous with truncation. The GLM
          // live probe emitted a short, normally-stopped response with one
          // delimiter missing, so keep the hint factual and conditional.
          errors:
            cs.errors[0]?.startsWith('changeset-json-invalid') === true
              ? [
                  ...cs.errors.slice(0, 32),
                  'hint: verify every JSON object/array delimiter; if the response was truncated, emit fewer or smaller ops this turn',
                ]
              : cs.errors.slice(0, 32),
        },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }
    const normalized = normalizeIntentWorkflowCreateLayouts(cs.changeset)
    const canonicalJson = canonicalIntentJson(normalized.changeset)
    const canonicalBytes = Buffer.byteLength(canonicalJson, 'utf8')
    if (canonicalBytes > INTENT_LIMITS.maxChangesetBytes) {
      return settle(
        'error',
        {
          code: 'intent-changeset-invalid',
          errors: [
            `changeset-too-large: ${canonicalBytes} bytes > ${INTENT_LIMITS.maxChangesetBytes} after workflow auto-layout (split into multiple submissions)`,
          ],
        },
        { runMeta, scratchRetained: result.scratchRetained },
      )
    }
    releaseScratch()
    if (cs.jsonRepair !== undefined) {
      log.warn('intent-changeset-json-repaired', {
        sessionId: input.sessionId,
        turnId,
        repairKind: cs.jsonRepair.kind,
        repairOffset: cs.jsonRepair.offset,
      })
    }
    const report = validateDraftChangeset(dump.manifest, normalized.changeset, {
      agentBranchPorts: dump.agentBranchPorts,
    })
    report.errors.unshift(...normalized.errors)
    return settle(
      'changeset',
      {
        summary,
        opCount: normalized.changeset.ops.length,
        blockingErrors: report.errors.length,
        credentialFindings: report.credentialFindings.length,
        mountRequests,
        ...(cs.jsonRepair === undefined ? {} : { jsonRepair: cs.jsonRepair }),
      },
      {
        runMeta,
        scratchRetained: result.scratchRetained,
        budgetDelta: { generateRounds: 1 },
        draft: {
          changesetJson: canonicalJson,
          canonicalJson,
          validationJson: JSON.stringify(report),
        },
      },
    )
  } catch (err) {
    await markSessionCapture('complete')
    log.error('intent-turn-crashed', {
      sessionId: input.sessionId,
      turnId,
      err: err instanceof Error ? err.message : String(err),
    })
    return settle('error', {
      code: 'intent-turn-crashed',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Resolve the per-turn runtime + knobs from config.json (design §5). */
export async function resolveIntentTurnConfig(
  runtimeResolver: IntentTurnRuntimeResolver,
  cfg: {
    intentBuilderRuntime?: string
    intentBuilderLang?: string
    intentBuilderTurnTimeoutMs?: number
    intentBuilderStdoutCapBytes?: number
    intentBuilderMaxGenerateRounds?: number
    intentBuilderMaxQuestionRounds?: number
    intentBuilderExtraInstructions?: string
    intentBuilderScratchRetentionHours?: number
    defaultRuntime?: string
  },
): Promise<IntentTurnConfig> {
  const resolved = await runtimeResolver.resolve({
    runtimeName: cfg.intentBuilderRuntime ?? null,
    defaultRuntime: cfg.defaultRuntime ?? null,
  })
  return {
    runtime: resolved.runtime,
    effectiveDefaultRuntime: resolved.effectiveDefaultRuntime,
    lang: cfg.intentBuilderLang ?? null,
    timeoutMs: cfg.intentBuilderTurnTimeoutMs ?? 600_000,
    stdoutCapBytes: cfg.intentBuilderStdoutCapBytes ?? 8 * 1024 * 1024,
    maxGenerateRounds: cfg.intentBuilderMaxGenerateRounds ?? 50,
    maxQuestionRounds: cfg.intentBuilderMaxQuestionRounds ?? 5,
    extraInstructions: cfg.intentBuilderExtraInstructions ?? null,
    scratchRetentionHours: cfg.intentBuilderScratchRetentionHours ?? 24,
  }
}
