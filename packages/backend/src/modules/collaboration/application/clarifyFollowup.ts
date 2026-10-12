import { beginClarifyFollowup } from './clarifyFollowupActivity'
import type { SaveClarifyDraftInput } from './ports/collaborationRouteOperations'
import {
  clarifyContentKey,
  clarifyFollowupContext,
  parseClarifyEnvelopeBody,
  type ClarifyFollowup,
} from '@agent-workflow/shared'
import { ConflictError, ValidationError } from '@/util/errors'
import type {
  ClarifyFollowupGenerator,
  ClarifyFollowupOperations,
  ClarifyFollowupStore,
} from './ports/clarifyFollowup'

/** Generation has no Task drive authority; only the existing round is extended. */
export function createClarifyFollowupOperations(
  store: ClarifyFollowupStore,
  generator: ClarifyFollowupGenerator,
): ClarifyFollowupOperations {
  const active = new Map<
    string,
    {
      id: string
      abort: AbortController
      result: Promise<{ questionIds: string[] }>
      key: string
      release: () => void
    }
  >()
  const canceled = new Set<string>()
  const cancelKey = (nodeRunId: string, requestId: string) => `${nodeRunId}:${requestId}`
  const append = async (
    nodeRunId: string,
    request: ClarifyFollowup,
    editor: SaveClarifyDraftInput['editor'],
  ) => {
    const requestKey = clarifyContentKey(request)
    const pending = active.get(nodeRunId)
    if (pending) {
      if (pending.id !== request.requestId || pending.key !== requestKey)
        throw new ConflictError(
          'clarify-followup-busy',
          'A follow-up is already being generated for this round.',
        )
      return pending.result
    }
    const abort = new AbortController()
    const release = beginClarifyFollowup(nodeRunId, request.requestId)
    // Defer the body one microtask so identical concurrent requests see the same promise.
    const result = Promise.resolve().then(async () => {
      try {
        const snapshot = await store.read(nodeRunId, request.parentQuestionId)
        const accepted = snapshot.questions.filter(
          (q) => q.mindmap?.requestId === request.requestId,
        )
        if (accepted.length) {
          if (accepted.some((q) => q.mindmap?.requestBasis !== requestKey))
            throw new ConflictError(
              'clarify-followup-request-conflict',
              'This request ID already belongs to another follow-up.',
            )
          return { questionIds: accepted.map((q) => q.id) }
        }
        if (canceled.has(cancelKey(nodeRunId, request.requestId)))
          throw new ConflictError('clarify-followup-canceled', 'Follow-up canceled.')
        if (!snapshot.canAppend)
          throw new ConflictError(
            'clarify-followup-closed',
            'This question no longer accepts follow-ups.',
          )
        const context = clarifyFollowupContext(
          snapshot.questions,
          snapshot.drafts,
          request.parentQuestionId,
        )
        if (clarifyContentKey(context) !== request.basis)
          throw new ConflictError(
            'clarify-followup-stale',
            'The branch changed. Save and retry with its current answers.',
          )
        const prompt = [
          'Ask 1–4 consequential follow-up questions about the selected branch, in the same language as the user. Do not repeat resolved questions. Do not execute the task or produce deliverables.',
          'Return exactly one <workflow-clarify> envelope containing {"questions":[{"id":"q1","title":"...","kind":"single","options":["...","..."],"mindmap":{"categoryPath":["..."]}}]}. Every question needs 2–4 options; do not include a free-text option. Use the parent category. Parent links will be assigned by the framework. No text outside the envelope.',
          JSON.stringify({
            branch: context,
            guidance: snapshot.instruction,
            userRequest: request.instruction,
          }),
        ].join('\n\n')
        if (prompt.length > 128000)
          throw new ValidationError(
            'clarify-followup-context-too-large',
            'This branch exceeds the follow-up context limit.',
          )
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
            if (abort.signal.aborted)
              throw new ConflictError('clarify-followup-canceled', 'Follow-up canceled.')
            throw error
          })
        if (abort.signal.aborted)
          throw new ConflictError('clarify-followup-canceled', 'Follow-up canceled.')
        const match = /^\s*<workflow-clarify>\s*([\s\S]*?)\s*<\/workflow-clarify>\s*$/.exec(text)
        const parsed = match
          ? parseClarifyEnvelopeBody(match[1]!, { maxQuestions: 4, mindmap: true })
          : null
        if (!parsed?.body || parsed.warnings.length)
          throw new ValidationError(
            'clarify-followup-invalid',
            parsed?.errors[0]?.detail ?? 'Expected 1–4 valid classified questions.',
          )
        const parent = snapshot.questions.find((q) => q.id === request.parentQuestionId)!
        const questions = parsed.body.questions.map((q, i) => ({
          ...q,
          id: `fq-${request.requestId}-${i}`,
          mindmap: {
            categoryPath: parent.mindmap!.categoryPath,
            parentQuestionId: parent.id,
            requestId: request.requestId,
            requestBasis: requestKey,
          },
        }))
        await store.append(nodeRunId, request, questions, abort.signal, editor)
        return { questionIds: questions.map((q) => q.id) }
      } finally {
        release()
        active.delete(nodeRunId)
      }
    })
    active.set(nodeRunId, { id: request.requestId, key: requestKey, abort, result, release })
    return result
  }
  return {
    append,
    async cancel(nodeRunId, requestId) {
      canceled.add(cancelKey(nodeRunId, requestId))
      if (canceled.size > 1024) canceled.delete(canceled.values().next().value!)
      const pending = active.get(nodeRunId)
      if (pending?.id === requestId) {
        pending.abort.abort()
        pending.release()
      }
    },
  }
}
