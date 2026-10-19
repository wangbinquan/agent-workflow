import { useRef, useState } from 'react'
import type {
  ClarifyFollowup,
  ClarifyFollowupStart,
  ClarifyFollowupStatus,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { useExecutionAvailability } from '@/hooks/useExecutionAvailability'

interface Operation {
  canceled: boolean
}
interface RoundRequest {
  nodeRunId: string
  request: ClarifyFollowup | null
  operation: Operation | null
  /** Generations canceled here; the cached round may report them until it refetches. */
  canceled: Set<string>
}

/**
 * Requests belong to their original round even when the router reuses the page.
 * RFC-372 O8: the daemon generates in the background once it accepts a request;
 * `server` is the round's reported follow-up, so a refreshed page and the other
 * members see the generation and can cancel it too.
 */
export function useClarifyFollowup(
  nodeRunId: string,
  refresh: (originNodeRunId: string) => Promise<unknown>,
  server?: ClarifyFollowupStatus,
) {
  const execution = useExecutionAvailability('task')
  const rounds = useRef(new Map<string, RoundRequest>())
  const visible = useRef(nodeRunId)
  visible.current = nodeRunId
  const [, changed] = useState(0)
  let round = rounds.current.get(nodeRunId)
  if (!round) {
    round = { nodeRunId, request: null, operation: null, canceled: new Set() }
    rounds.current.set(nodeRunId, round)
  }
  const owner = round
  const notify = () => changed((version) => version + 1)
  const running =
    server?.state === 'running' && !owner.canceled.has(server.requestId) ? server : undefined
  // A cancel is not a failure; whoever canceled already knows.
  const failed =
    server?.state === 'failed' && server.error && server.error.code !== 'clarify-followup-canceled'
      ? server.error
      : undefined
  return {
    pending: owner.operation !== null || running !== undefined,
    /** The round's background generation, wherever it was started. */
    running,
    /** The round's last failed generation, shown like a rejected request (status 0:
     *  the round reported it; it was not this page's HTTP failure). */
    failure:
      failed && server
        ? {
            target: server.target,
            instruction: server.instruction,
            error: new ApiError(0, failed.code, failed.message),
          }
        : undefined,
    async start(input: Omit<ClarifyFollowup, 'requestId'>, flush: () => Promise<void>) {
      if (owner.operation || running) return
      execution.assertAvailable()
      const operation: Operation = { canceled: false }
      owner.operation = operation
      notify()
      try {
        await flush()
        if (operation.canceled) return
        execution.assertAvailable()
        const previous = owner.request
        const request: ClarifyFollowup =
          previous?.basis === input.basis &&
          previous.parentQuestionId === input.parentQuestionId &&
          JSON.stringify(previous.categoryPath) === JSON.stringify(input.categoryPath) &&
          previous.instruction === input.instruction
            ? previous
            : { ...input, requestId: crypto.randomUUID() }
        owner.request = request
        await api.post<ClarifyFollowupStart>(`/api/clarify/${owner.nodeRunId}/followup`, request)
        // Accepted: the refreshed round now reports the generation or its questions.
        if (owner.request === request) owner.request = null
        await refresh(owner.nodeRunId)
      } catch (error) {
        // A lost response may already have been accepted. Keep the request identity
        // for retry, and refresh only its original round's query cache.
        await refresh(owner.nodeRunId)
        if (!operation.canceled && visible.current === owner.nodeRunId) throw error
      } finally {
        if (owner.operation === operation) owner.operation = null
        notify()
      }
    },
    async cancel() {
      const operation = owner.operation
      const requestId = owner.request?.requestId ?? running?.requestId
      if (!operation && requestId === undefined) return
      if (operation) operation.canceled = true
      if (requestId !== undefined) {
        await api.delete(`/api/clarify/${owner.nodeRunId}/followup/${requestId}`)
        owner.canceled.add(requestId)
      }
      if (owner.request?.requestId === requestId) owner.request = null
      if (owner.operation === operation) owner.operation = null
      notify()
      await refresh(owner.nodeRunId)
    },
  }
}
