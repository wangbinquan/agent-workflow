import type { SaveClarifyDraftInput } from './ports/collaborationRouteOperations'
import {
  CLARIFY_MINDMAP_QUESTION_GUIDANCE,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyFormatExample,
  parseClarifyEnvelopeBody,
  type ClarifyFollowup,
  type ClarifyFollowupStart,
  type ClarifyFollowupStatus,
} from '@agent-workflow/shared'
import { ConflictError, DomainError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import type {
  ClarifyFollowupActivity,
  ClarifyFollowupEvents,
  ClarifyFollowupGenerator,
  ClarifyFollowupInFlight,
  ClarifyFollowupOperations,
  ClarifyFollowupSnapshot,
  ClarifyFollowupStore,
  ClarifyFollowupTaskContext,
} from './ports/clarifyFollowup'

const log = createLogger('clarifyFollowup')

/** A failed or canceled generation stays visible this long unless another one starts. */
export const CLARIFY_FOLLOWUP_FAILURE_TTL_MS = 10 * 60_000

/** Generation has no Task drive authority; only the existing round is extended. */
export function createClarifyFollowupOperations(
  store: ClarifyFollowupStore,
  generator: ClarifyFollowupGenerator,
  activity: ClarifyFollowupActivity,
  options: { readonly events?: ClarifyFollowupEvents; readonly now?: () => number } = {},
): ClarifyFollowupOperations {
  const now = options.now ?? Date.now
  const canceledError = () => new ConflictError('clarify-followup-canceled', 'Follow-up canceled.')
  const canceled = new Set<string>()
  const failures = new Map<string, ClarifyFollowupStatus & { failedAt: number }>()
  const cancelKey = (nodeRunId: string, requestId: string) => `${nodeRunId}:${requestId}`
  const announce = (nodeRunId: string, snapshot: ClarifyFollowupSnapshot) =>
    options.events?.changed({ taskId: snapshot.taskId, nodeRunId, roundId: snapshot.roundId })
  // Same code and message the HTTP layer would answer for this error.
  const remember = (nodeRunId: string, inFlight: ClarifyFollowupInFlight, error: unknown) => {
    if (!(error instanceof DomainError))
      log.error('clarify follow-up generation failed', {
        nodeRunId,
        message: error instanceof Error ? error.message : String(error),
      })
    failures.delete(nodeRunId)
    failures.set(nodeRunId, {
      requestId: inFlight.requestId,
      state: 'failed',
      ...(inFlight.instruction !== undefined ? { instruction: inFlight.instruction } : {}),
      target: typeof inFlight.target === 'string' ? inFlight.target : [...inFlight.target],
      startedAt: inFlight.startedAt,
      error:
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: 'internal-error', message: 'internal server error' },
      failedAt: now(),
    })
    if (failures.size > 1024) failures.delete(failures.keys().next().value!)
  }
  /** Checks the request against the round and builds the prompt, or finds it already applied. */
  const prepare = async (
    nodeRunId: string,
    request: ClarifyFollowup,
    requestKey: string,
  ): Promise<{ questionIds: string[] } | { snapshot: ClarifyFollowupSnapshot; prompt: string }> => {
    const target = request.parentQuestionId ?? request.categoryPath!
    const snapshot = await store.read(nodeRunId, target)
    const accepted = snapshot.questions.filter((q) => q.mindmap?.requestId === request.requestId)
    if (accepted.length) {
      if (accepted.some((q) => q.mindmap?.requestBasis !== requestKey))
        throw new ConflictError(
          'clarify-followup-request-conflict',
          'This request ID already belongs to another follow-up.',
        )
      return { questionIds: accepted.map((q) => q.id) }
    }
    if (canceled.has(cancelKey(nodeRunId, request.requestId))) throw canceledError()
    if (!snapshot.canAppend)
      throw new ConflictError(
        'clarify-followup-closed',
        'This question no longer accepts follow-ups.',
      )
    const context = clarifyFollowupContext(snapshot.questions, snapshot.drafts, target)
    if (clarifyContentKey(context) !== request.basis)
      throw new ConflictError(
        'clarify-followup-stale',
        'The branch changed. Save and retry with its current answers.',
      )
    // Background only: an unavailable source never blocks a follow-up.
    let taskContext: ClarifyFollowupTaskContext | null = null
    if (generator.context)
      taskContext = await generator
        .context({ askingNodeRunId: snapshot.askingNodeRunId, taskId: snapshot.taskId })
        .catch(() => null)
    const prompt = [
      'Ask 1–4 consequential follow-up questions about the selected branch, in the same language as the user. Do not repeat resolved questions. Do not execute the task or produce deliverables.',
      'Return exactly one <workflow-clarify> envelope. Every question needs 2–4 options; do not include a free-text option. Choose single or multi according to whether the actual alternatives are mutually exclusive or compatible. The framework assigns attachment to the selected question or category. No text outside the envelope.',
      clarifyFormatExample(undefined, true),
      typeof target === 'string'
        ? 'Deepen the selected question, respecting its ancestor answers.'
        : target.length
          ? 'Add missing questions directly under the selected categoryPath. These are peer questions, not follow-ups to any one existing question. Address userRequest explicitly and consider the existing branch answers without repeating them.'
          : 'Add missing questions across the mindmap. Assign each question a meaningful categoryPath, reusing existing categories where appropriate. Address userRequest explicitly without repeating resolved questions.',
      ...(taskContext
        ? [
            "taskContext is the original task input and the asking agent's instruction. Use it only as background; do not ask about anything it already settles.",
          ]
        : []),
      CLARIFY_MINDMAP_QUESTION_GUIDANCE,
      JSON.stringify({
        ...(taskContext ? { taskContext } : {}),
        branch: context,
        configuredCategoryPaths: snapshot.categoryPaths ?? [],
        ...(typeof target === 'string' ? {} : { categoryPath: target }),
        guidance: snapshot.instruction,
        userRequest: request.instruction,
      }),
    ].join('\n\n')
    if (prompt.length > 128000)
      throw new ValidationError(
        'clarify-followup-context-too-large',
        'This branch exceeds the follow-up context limit.',
      )
    return { snapshot, prompt }
  }
  const generate = async (
    nodeRunId: string,
    request: ClarifyFollowup,
    inFlight: ClarifyFollowupInFlight,
    { snapshot, prompt }: { snapshot: ClarifyFollowupSnapshot; prompt: string },
    editor: SaveClarifyDraftInput['editor'],
  ): Promise<string[]> => {
    const { abort } = inFlight
    const text = await generator
      .generate({
        askingNodeRunId: snapshot.askingNodeRunId,
        taskId: snapshot.taskId,
        requestId: request.requestId,
        prompt,
        signal: abort.signal,
      })
      .catch((error: unknown) => {
        // A real native CLI rejects when canceled. Preserve the same
        // recoverable cancellation result as a late resolved response.
        if (abort.signal.aborted) throw canceledError()
        throw error
      })
    if (abort.signal.aborted) throw canceledError()
    const match = /^\s*<workflow-clarify>\s*([\s\S]*?)\s*<\/workflow-clarify>\s*$/.exec(text)
    const parsed = match
      ? parseClarifyEnvelopeBody(match[1]!, { maxQuestions: 4, mindmap: true })
      : null
    if (!parsed?.body || parsed.warnings.length)
      throw new ValidationError(
        'clarify-followup-invalid',
        parsed?.errors[0]?.detail ?? 'Expected 1–4 valid classified questions.',
      )
    const parent = snapshot.questions.find((q) => q.id === request.parentQuestionId)
    const questions = parsed.body.questions.map((q, i) => ({
      ...q,
      id: `fq-${request.requestId}-${i}`,
      mindmap: {
        categoryPath: parent
          ? parent.mindmap!.categoryPath
          : request.categoryPath!.length
            ? request.categoryPath!
            : q.mindmap!.categoryPath,
        ...(parent ? { parentQuestionId: parent.id } : {}),
        requestId: request.requestId,
        requestBasis: inFlight.requestKey,
      },
    }))
    await store.append(nodeRunId, request, questions, abort.signal, editor)
    return questions.map((q) => q.id)
  }
  /** The registered generation for this request: an identical retry shares it. */
  const launch = (
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ): ClarifyFollowupInFlight => {
    const requestKey = clarifyContentKey(request)
    const pending = activity.current(nodeRunId)
    if (pending) {
      if (pending.requestId !== request.requestId || pending.requestKey !== requestKey)
        throw new ConflictError(
          'clarify-followup-busy',
          'A follow-up is already being generated for this round.',
        )
      return pending
    }
    const accepted = Promise.withResolvers<ClarifyFollowupStart>()
    const result = Promise.withResolvers<{ questionIds: string[] }>()
    // A caller waits for one of the two; the other must not surface as unhandled.
    accepted.promise.catch(() => {})
    result.promise.catch(() => {})
    const inFlight: ClarifyFollowupInFlight = {
      requestId: request.requestId,
      requestKey,
      instruction: request.instruction,
      target: request.parentQuestionId ?? request.categoryPath!,
      startedAt: now(),
      abort: new AbortController(),
      generating: false,
      accepted: accepted.promise,
      result: result.promise,
    }
    // Register before any work starts, so identical concurrent requests share
    // this generation and the round seal sees it immediately.
    const release = activity.begin(nodeRunId, inFlight)
    void (async () => {
      let prepared: Awaited<ReturnType<typeof prepare>>
      try {
        prepared = await prepare(nodeRunId, request, requestKey)
        if (!('questionIds' in prepared) && inFlight.abort.signal.aborted) throw canceledError()
      } catch (error) {
        release()
        accepted.reject(error)
        result.reject(error)
        return
      }
      if ('questionIds' in prepared) {
        release()
        accepted.resolve({ state: 'done', questionIds: prepared.questionIds })
        result.resolve({ questionIds: prepared.questionIds })
        return
      }
      inFlight.generating = true
      failures.delete(nodeRunId)
      accepted.resolve({ state: 'running' })
      announce(nodeRunId, prepared.snapshot)
      try {
        const questionIds = await generate(nodeRunId, request, inFlight, prepared, editor)
        release()
        result.resolve({ questionIds })
      } catch (error) {
        remember(nodeRunId, inFlight, error)
        release()
        result.reject(error)
      }
      announce(nodeRunId, prepared.snapshot)
    })().catch((error: unknown) => {
      // Every step above settles the request itself; nothing is expected here.
      log.error('clarify follow-up bookkeeping failed', {
        nodeRunId,
        message: error instanceof Error ? error.message : String(error),
      })
    })
    return inFlight
  }
  return {
    start: async (nodeRunId, request, editor) => await launch(nodeRunId, request, editor).accepted,
    append: async (nodeRunId, request, editor) => await launch(nodeRunId, request, editor).result,
    status(nodeRunId) {
      const pending = activity.current(nodeRunId)
      if (pending?.generating && !pending.abort.signal.aborted)
        return {
          requestId: pending.requestId,
          state: 'running',
          target: typeof pending.target === 'string' ? pending.target : [...pending.target],
          startedAt: pending.startedAt,
        }
      const failure = failures.get(nodeRunId)
      if (!failure) return undefined
      if (now() - failure.failedAt >= CLARIFY_FOLLOWUP_FAILURE_TTL_MS) {
        failures.delete(nodeRunId)
        return undefined
      }
      const { failedAt: _failedAt, ...status } = failure
      return status
    },
    async cancel(nodeRunId, requestId) {
      canceled.add(cancelKey(nodeRunId, requestId))
      if (canceled.size > 1024) canceled.delete(canceled.values().next().value!)
      const pending = activity.current(nodeRunId)
      if (pending?.requestId === requestId) pending.abort.abort()
    },
  }
}
