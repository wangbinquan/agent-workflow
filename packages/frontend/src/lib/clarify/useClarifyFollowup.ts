import { useRef, useState } from 'react'
import type { ClarifyFollowup } from '@agent-workflow/shared'
import { api } from '@/api/client'

interface Operation {
  canceled: boolean
}
interface RoundRequest {
  nodeRunId: string
  request: ClarifyFollowup | null
  operation: Operation | null
}

/** Requests belong to their original round even when the router reuses the page. */
export function useClarifyFollowup(
  nodeRunId: string,
  refresh: (originNodeRunId: string) => Promise<unknown>,
) {
  const rounds = useRef(new Map<string, RoundRequest>())
  const visible = useRef(nodeRunId)
  visible.current = nodeRunId
  const [, changed] = useState(0)
  let round = rounds.current.get(nodeRunId)
  if (!round) {
    round = { nodeRunId, request: null, operation: null }
    rounds.current.set(nodeRunId, round)
  }
  const owner = round
  const notify = () => changed((version) => version + 1)
  return {
    pending: owner.operation !== null,
    async start(input: Omit<ClarifyFollowup, 'requestId'>, flush: () => Promise<void>) {
      if (owner.operation) return
      const operation: Operation = { canceled: false }
      owner.operation = operation
      notify()
      try {
        await flush()
        if (operation.canceled) return
        const previous = owner.request
        const request: ClarifyFollowup =
          previous?.basis === input.basis &&
          previous.parentQuestionId === input.parentQuestionId &&
          JSON.stringify(previous.categoryPath) === JSON.stringify(input.categoryPath) &&
          previous.instruction === input.instruction
            ? previous
            : { ...input, requestId: crypto.randomUUID() }
        owner.request = request
        await api.post(`/api/clarify/${owner.nodeRunId}/followup`, request)
        if (owner.request === request) owner.request = null
        await refresh(owner.nodeRunId)
      } catch (error) {
        // A lost response may already have appended. Keep the request identity
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
      if (!operation) return
      operation.canceled = true
      const request = owner.request
      if (request) await api.delete(`/api/clarify/${owner.nodeRunId}/followup/${request.requestId}`)
      if (owner.request === request) owner.request = null
      if (owner.operation === operation) owner.operation = null
      notify()
    },
  }
}
