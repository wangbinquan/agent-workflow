// RFC-030 — TanStack hooks for the /api/mcps/.../probe endpoints.
//
// useMcpProbes()           — list, used on /mcps page
// useMcpProbe(name)        — single, used on /mcps/$name page
// useProbeMcpMutation(name) — POST trigger; invalidates both query keys
//
// All three live in a sibling file so the page + detail + panel components
// share the same cache keys (otherwise we'd race two probes against one
// fresh result).

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  McpOperationResource,
  McpProbe,
  McpProbeOperationReceipt,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'

export const MCP_PROBES_KEY = ['mcps', 'probes'] as const
export const mcpProbeKey = (name: string): readonly unknown[] => ['mcps', name, 'probe']
export const mcpResourceKey = (name: string): readonly unknown[] => ['mcps', name]

let requestSequence = 0
function nextRequestId(): string {
  requestSequence += 1
  return `mcp-probe-${requestSequence}`
}

export function useMcpProbes() {
  return useQuery<McpProbe[]>({
    queryKey: MCP_PROBES_KEY,
    queryFn: ({ signal }) => api.get<McpProbe[]>('/api/mcps/probes', undefined, signal),
  })
}

/**
 * Returns the probe for a given mcp. A 404 `probe-not-found` is mapped to
 * `null` so the detail page can render "never probed" without an error
 * banner — but `mcp-not-found` still surfaces as an error (that's a real
 * data integrity problem the page should show).
 */
export function useMcpProbe(name: string) {
  return useQuery<McpProbe | null>({
    queryKey: mcpProbeKey(name),
    queryFn: async ({ signal }) => {
      try {
        return await api.get<McpProbe>(
          `/api/mcps/${encodeURIComponent(name)}/probe`,
          undefined,
          signal,
        )
      } catch (e) {
        if (e instanceof ApiError && e.code === 'probe-not-found') return null
        throw e
      }
    },
  })
}

export function useProbeMcpMutation(name: string) {
  const qc = useQueryClient()
  const current = useRef<{ requestId: string; expectedHash: string } | null>(null)
  const [resultStale, setResultStale] = useState(false)
  type Variables = { requestId: string; expectedConfigHash: string }
  const mutation = useMutation<McpProbeOperationReceipt, Error, Variables>({
    mutationFn: (variables) =>
      api.post<McpProbeOperationReceipt>(`/api/mcps/${encodeURIComponent(name)}/probe`, {
        expectedConfigHash: variables.expectedConfigHash,
      }),
    onMutate: (variables) => {
      current.current = {
        requestId: variables.requestId,
        expectedHash: variables.expectedConfigHash,
      }
      setResultStale(false)
    },
    onSuccess: (receipt, variables) => {
      const active = current.current
      const resource = qc.getQueryData<McpOperationResource>(mcpResourceKey(name))
      const matchesCurrentRequest =
        active?.requestId === variables.requestId &&
        active.expectedHash === variables.expectedConfigHash
      const matchesCurrentResource =
        receipt.configHashUsed === variables.expectedConfigHash &&
        resource?.operationConfigHash === variables.expectedConfigHash
      // A later local request owns the scope now; an older receipt is simply
      // ignored and must not overwrite that request's success/stale state.
      if (!matchesCurrentRequest) return
      if (!matchesCurrentResource) {
        setResultStale(true)
        void qc.invalidateQueries({ queryKey: mcpResourceKey(name), exact: true })
        void qc.invalidateQueries({ queryKey: mcpProbeKey(name), exact: true })
        void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
        return
      }
      qc.setQueryData<McpProbe>(mcpProbeKey(name), receipt)
      void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
    },
    onError: (error, variables) => {
      const active = current.current
      if (
        active?.requestId !== variables.requestId ||
        active.expectedHash !== variables.expectedConfigHash
      ) {
        return
      }
      if (
        error instanceof ApiError &&
        (error.code === 'resource-operation-stale' ||
          error.code === 'resource-operation-superseded')
      ) {
        setResultStale(true)
        void qc.invalidateQueries({ queryKey: mcpResourceKey(name), exact: true })
        void qc.invalidateQueries({ queryKey: mcpProbeKey(name), exact: true })
        void qc.invalidateQueries({ queryKey: MCP_PROBES_KEY })
      }
    },
  })
  return {
    ...mutation,
    resultStale,
    run(expectedConfigHash: string): void {
      mutation.mutate({ requestId: nextRequestId(), expectedConfigHash })
    },
    runAsync(expectedConfigHash: string): Promise<McpProbeOperationReceipt> {
      return mutation.mutateAsync({ requestId: nextRequestId(), expectedConfigHash })
    },
  }
}
