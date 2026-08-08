// RFC-243 PR-3 — the ONE frontend fetch layer for call-workflow references
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
    () => (ref) => {
      // RFC-271 T6e（决策 28）—— 与启动冻结（`execution/closure.ts`）逐条同构：
      //   ① id hint 命中、**且该行仍带选择器里的名字** ⇒ 用它（作者挑的那个）；
      //   ② 否则回退名字规则。
      // 名字守卫保住了这里原本 name-优先想防的那件事（rename + recreate 不得被
      // stale id 静默重绑），同时修掉了它的代价：此前同名两个 call 节点无论各自
      // hint 谁，都被推成同一份端口，而启动会按各自的 id 绑到不同工作流。
      const hinted = ref.id === undefined ? undefined : workflows.find((w) => w.id === ref.id)
      if (hinted !== undefined && (ref.name === undefined || hinted.name === ref.name)) {
        return hinted.definition
      }
      if (ref.name === undefined) return null
      // 名字回退：列表按后端顺序，取首个同名行。
      return workflows.find((w) => w.name === ref.name)?.definition ?? null
    },
    [workflows],
  )
  return { workflowByRef, workflows, isLoading: client !== undefined && rows === undefined }
}
