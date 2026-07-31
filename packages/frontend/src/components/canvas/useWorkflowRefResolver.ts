// RFC-242 PR-3 — the ONE frontend fetch layer for call-workflow references
// (design §5.2 consumer surface #1/#3). The canvas, the NodeInspector port
// summary and the CallWorkflowEdit selector all resolve the referenced child
// workflow through this hook so they share a single TanStack Query cache
// entry — the same `['workflows']` key the /workflows list page and the
// /ws/workflows invalidation rules already use (useWorkflowSync RULES).
//
// Provider tolerance: several canvas/inspector unit suites render
// WorkflowCanvas / NodeInspector WITHOUT a QueryClientProvider. `useQuery`
// throws in that case, so this hook subscribes through an explicit
// QueryObserver only when a client exists; without one it degrades to the
// empty inventory (resolver → null ⇒ call-workflow declares no ports, the
// exact pre-resolver behavior of declaredPorts' optional 4th argument).
//
// Resolution contract (task/RFC scope): the LIST endpoint is already
// ACL-filtered, so an invisible or deleted reference is simply absent —
// both collapse to `null` and the Inspector shows one neutral
// "引用不可见或不存在" placeholder (no existence leak). The `'forbidden'`
// branch of shared `WorkflowByRef` stays reserved for surfaces that talk to
// detail endpoints and can observe a real 404/403 split.

import { QueryClientContext, QueryObserver } from '@tanstack/react-query'
import { useContext, useEffect, useMemo, useState } from 'react'
import type { Workflow, WorkflowByRef } from '@agent-workflow/shared'
import { api } from '@/api/client'

/** Cache key shared with the /workflows list page (routes/workflows.tsx). */
export const WORKFLOWS_QUERY_KEY = ['workflows'] as const

export interface WorkflowRefResolver {
  /** Passed as `declaredPorts(..., { workflowByRef })` / `computePorts` 4th arg. */
  workflowByRef: WorkflowByRef
  /** Visible workflows (ACL-filtered server side); [] while loading/unavailable. */
  workflows: Workflow[]
  /** True while a live query exists but has not delivered data yet. */
  isLoading: boolean
}

export function useWorkflowRefResolver(): WorkflowRefResolver {
  const client = useContext(QueryClientContext)
  const [rows, setRows] = useState<Workflow[] | undefined>(() =>
    client?.getQueryData<Workflow[]>(WORKFLOWS_QUERY_KEY),
  )
  useEffect(() => {
    if (client === undefined) return
    // Active observer (not a bare prefetch): /ws/workflows invalidations of
    // ['workflows'] only auto-refetch ACTIVE queries, and the editor route
    // does not mount the list query itself — without this subscription a
    // cross-tab edit would leave stale child-port previews behind.
    const observer = new QueryObserver<Workflow[]>(client, {
      queryKey: [...WORKFLOWS_QUERY_KEY],
      queryFn: ({ signal }) => api.get<Workflow[]>('/api/workflows', undefined, signal),
    })
    setRows(observer.getCurrentResult().data)
    return observer.subscribe((result) => setRows(result.data))
  }, [client])
  // Defensive array guard: shared-cache suites stub fetch with non-list
  // payloads; the resolver must degrade to "unknown", never crash the canvas.
  const workflows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows])
  const workflowByRef = useMemo<WorkflowByRef>(
    () => (nameOrId: string) => {
      // Name is the authoritative selector (design §5.1); id is the local
      // resolution cache — match name first so a rename+recreate can never
      // silently rebind the node through a stale id.
      const hit =
        workflows.find((w) => w.name === nameOrId) ?? workflows.find((w) => w.id === nameOrId)
      return hit?.definition ?? null
    },
    [workflows],
  )
  return { workflowByRef, workflows, isLoading: client !== undefined && rows === undefined }
}
