// RFC-270 §3 — 前台这一侧的特权节点权限判定，单一来源。
//
// 三个消费点（palette 置灰 / Inspector 占位 / 画布上的不可拖不可删）必须用**同一
// 条**判据，否则会漂移出「palette 拖不出来但画布上能删」这类半开半合的组合。
//
// 判定逻辑抽成纯函数 `privilegedNodeAccessOf`，钩子只负责喂两个布尔值：这样分支
// 全覆盖的测试不需要挂 QueryClientProvider。
//
// **失败关闭**：`usePermission` 在 /me 加载中或失败时返回 false，于是这里判成
// 「无权限」——遮起来。路由守卫那边方向相反（/me 挂了就放行，真边界在后端），
// 两处方向不同是刻意的：这里遮多了只是少看见几个字段，那里拦错了会把管理员挡在
// 配置页外面。

import {
  QueryClientContext,
  QueryObserver,
  type QueryClient,
  type QueryObserverResult,
} from '@tanstack/react-query'
import { useContext, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  NodeKind,
  Permission,
  PrivilegedNodeLens,
  WorkflowDefinition,
} from '@agent-workflow/shared'
import type { PaletteItem } from '@/components/canvas/nodePalette'
import { meQueryOptions, useAuthTokenSnapshot, type MeResponse } from '@/hooks/useActor'

/** 需要 `scripts:author` / `code-host-calls:author` 才能创作与查看的两类节点。 */
export const PRIVILEGED_NODE_KINDS = {
  script: 'scripts:author',
  'code-host-call': 'code-host-calls:author',
} as const satisfies Partial<Record<NodeKind, string>>

export type PrivilegedNodeKind = keyof typeof PRIVILEGED_NODE_KINDS

export interface PrivilegedNodeGrants {
  canAuthorScripts: boolean
  canAuthorCodeHost: boolean
}

export interface PrivilegedNodeAccess extends PrivilegedNodeGrants {
  /** 喂给 shared 判据（`privilegedProjectionChange` / `redactPrivilegedNodes`）。 */
  lens: PrivilegedNodeLens
  /** 这个 NodeKind 对当前用户是不是「特权且无权」。 */
  isProtectedKind: (kind: string) => boolean
  /** 定义里全部受保护节点的 id。画布用它做 draggable / deletable / 连线判定。 */
  protectedNodeIds: (definition: WorkflowDefinition) => Set<string>
  /** palette 条目的置灰理由；`null` = 可用。 */
  paletteDisabledReason: (item: PaletteItem) => string | null
}

/** 纯判定。`t` 只用于产出置灰理由，测试可传恒等桩。 */
export function privilegedNodeAccessOf(
  grants: PrivilegedNodeGrants,
  t: (key: string, options?: Record<string, unknown>) => string,
): PrivilegedNodeAccess {
  const grantOf = (kind: string): boolean | null => {
    if (kind === 'script') return grants.canAuthorScripts
    if (kind === 'code-host-call') return grants.canAuthorCodeHost
    return null
  }
  const isProtectedKind = (kind: string): boolean => grantOf(kind) === false
  return {
    ...grants,
    lens: { scripts: !grants.canAuthorScripts, codeHost: !grants.canAuthorCodeHost },
    isProtectedKind,
    protectedNodeIds: (definition) =>
      new Set(definition.nodes.filter((node) => isProtectedKind(node.kind)).map((node) => node.id)),
    paletteDisabledReason: (item) =>
      isProtectedKind(item.kind)
        ? t('editor.nodePicker.requiresPermission', {
            permission: PRIVILEGED_NODE_KINDS[item.kind as PrivilegedNodeKind],
          })
        : null,
  }
}

/**
 * Provider-tolerant permission read, same shape as `useWorkflowRefResolver`.
 *
 * `WorkflowCanvas` is rendered WITHOUT a QueryClientProvider by a dozen unit
 * suites, and plain `useQuery` throws there — so this subscribes through an
 * explicit observer only when a client exists. No client ⇒ no permissions ⇒
 * FAIL CLOSED, which for those suites means "no privileged nodes to protect"
 * and no behaviour change at all.
 *
 * It goes through the shared `meQueryOptions`, so it is the same cache entry
 * `useActor` uses — not a second request per canvas mount.
 */
function usePermissionsSnapshot(): readonly Permission[] {
  const client = useContext(QueryClientContext)
  const token = useAuthTokenSnapshot()
  const options = useMemo(() => meQueryOptions(token), [token])

  type Snapshot = {
    client: QueryClient | undefined
    token: string | null
    result: Pick<QueryObserverResult<MeResponse | null>, 'data' | 'fetchStatus' | 'status'> | null
  }
  const [snapshot, setSnapshot] = useState<Snapshot>(() => {
    if (client === undefined) return { client, token, result: null }
    const state = client.getQueryState(options.queryKey)
    return {
      client,
      token,
      result:
        state === undefined
          ? null
          : {
              data: client.getQueryData<MeResponse | null>(options.queryKey),
              fetchStatus: state.fetchStatus,
              status: state.status,
            },
    }
  })
  useEffect(() => {
    if (client === undefined) {
      setSnapshot({ client, token, result: null })
      return
    }
    const observer = new QueryObserver<MeResponse | null>(client, options)
    const update = (result: QueryObserverResult<MeResponse | null>) =>
      setSnapshot({ client, token, result })
    update(observer.getCurrentResult())
    return observer.subscribe(update)
  }, [client, options, token])

  // A provider/client or auth-token switch renders before the effect above can
  // subscribe to the new cache entry. Tagging the snapshot identity prevents a
  // one-frame grant leak from the previous actor/client.
  if (snapshot.client !== client || snapshot.token !== token) return []
  const result = snapshot.result
  if (result?.status !== 'success' || result.fetchStatus !== 'idle') return []
  return Array.isArray(result.data?.permissions) ? result.data.permissions : []
}

export function usePrivilegedNodes(): PrivilegedNodeAccess {
  const { t } = useTranslation()
  const permissions = usePermissionsSnapshot()
  const canAuthorScripts = permissions.includes('scripts:author')
  const canAuthorCodeHost = permissions.includes('code-host-calls:author')
  // Memoized so the returned callbacks are referentially stable: the canvas
  // feeds `paletteDisabledReason` into a `useCallback` dep array, and a fresh
  // closure per render would invalidate it (and every memo built on it) on
  // every keystroke in the editor.
  return useMemo(
    () => privilegedNodeAccessOf({ canAuthorScripts, canAuthorCodeHost }, t),
    [canAuthorCodeHost, canAuthorScripts, t],
  )
}
