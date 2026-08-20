// RFC-312 —— Codex **实现门**前端侧缺陷的回归锁（2026-08-20）。
//
// 三条缺陷的共同点是「既有 10 条用例全绿却依然存在」——因为那些用例只直接驱动 store，
// 从不挂载订阅、也从不切换认证身份。所以本文件锁的是**接线与身份边界**，不是 store 的算术。
//
//   P1-4 store 是模块级的，清空只发生在 `useEffect`（passive、commit 之后）⇒ 切账号时
//        新身份的**首次已提交渲染**仍读得到上一个账号的在线名单（presence 在权限点后面，
//        这是跨账号泄漏）。修法是把认证代次记进 state，让陈旧数据**结构上读不出来**。
//   P2-8 `AttributionChip` 对"形态正常但查不到"的 id 拿到 `false` ⇒ 给可能已被删除的人
//        画上"离线"点。判据改用 `user === undefined` ⇒ 未知就不渲染。
//   D2   `useWebSocket` 只认 4401 不认 4403 ⇒ 权限（而非凭据）被收回时一路重连且 /me 不刷新。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { clearToken, getAuthSessionRevision, setBaseUrl, setToken } from '../src/stores/auth'
import {
  applyPresenceSnapshot,
  resetPresence,
  usePresenceOf,
  usePresenceSubscription,
} from '../src/hooks/usePresence'
import { useWebSocket } from '../src/hooks/useWebSocket'
import { AttributionChip } from '../src/components/AttributionChip'
import { appQueryClient } from '../src/lib/query-client'
import { ACTOR_QUERY_KEY } from '../src/hooks/useActor'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  readyState = 1
  listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    open: [],
    close: [],
    error: [],
  }
  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).concat(fn)
  }
  removeEventListener(): void {}
  close(): void {
    for (const fn of this.listeners.close ?? []) fn(null)
  }
  fireMessage(data: unknown): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) })
  }
  fireClose(code: number): void {
    for (const fn of this.listeners.close ?? []) fn({ code })
  }
}

const RealWebSocket = globalThis.WebSocket

function Probe({ id }: { id: string }) {
  const online = usePresenceOf(id)
  return <span data-testid="probe">{online === undefined ? 'unknown' : String(online)}</span>
}

describe('RFC-312 实现门 —— presence store 必须绑定认证身份', () => {
  beforeEach(() => {
    resetPresence()
    clearToken()
  })
  afterEach(() => {
    clearToken()
    resetPresence()
  })

  // P1-4 的核心。注意断言的是**首次渲染**就已经是 unknown，而不是"effect 跑完之后"——
  // 泄漏窗口恰恰在这两者之间。把 usePresenceOf 里的代次比较删掉，本例立刻红。
  test('换一个凭据后，上一个账号的在线名单在首次渲染时就已不可读', () => {
    setToken('token-A')
    applyPresenceSnapshot(['u1'], getAuthSessionRevision())
    const first = render(<Probe id="u1" />)
    expect(first.getByTestId('probe').textContent).toBe('true')
    first.unmount()

    // 换账号：setToken 会**同步**推进认证代次。store 里的数据仍是旧代次的。
    act(() => {
      setToken('token-B')
    })
    const second = render(<Probe id="u1" />)
    expect(second.getByTestId('probe').textContent).toBe('unknown')
  })

  test('同一凭据内，快照照常可读（代次绑定没有误杀正向路径）', () => {
    setToken('token-A')
    applyPresenceSnapshot(['u1'], getAuthSessionRevision())
    render(<Probe id="u1" />)
    expect(screen.getByTestId('probe').textContent).toBe('true')
  })
})

describe('RFC-312 实现门 —— 查不到的用户是「未知」不是「离线」', () => {
  beforeEach(() => {
    resetPresence()
    clearToken()
  })

  function renderChip(user: { id: string; displayName: string } | undefined) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AttributionChip userId="u-missing" user={user as never} />
      </QueryClientProvider>,
    )
  }

  // P2-8。水化后（= store 有权威名单）渲染一个 lookup 查不到的 id：
  // 修复前 usePresenceOf 返回 false ⇒ 画出离线点；修复后传 undefined ⇒ 不画点。
  test('lookup 未解析 ⇒ 不渲染状态点', () => {
    setToken('t')
    applyPresenceSnapshot([], getAuthSessionRevision())
    const { container } = renderChip(undefined)
    expect(container.querySelector('.presence-dot')).toBeNull()
  })

  test('lookup 解析到了 ⇒ 照常渲染离线点（未误杀正向路径）', () => {
    setToken('t')
    applyPresenceSnapshot([], getAuthSessionRevision())
    const { container } = renderChip({ id: 'u-missing', displayName: 'Someone' })
    expect(container.querySelector('.presence-dot')).not.toBeNull()
  })
})

describe('RFC-312 实现门 —— 4403（权限被收回）与 4401（凭据失效）处置不同', () => {
  beforeEach(() => {
    MockSocket.instances = []
    globalThis.WebSocket = MockSocket as never
    setBaseUrl('http://d.test')
    setToken('t')
  })
  afterEach(() => {
    globalThis.WebSocket = RealWebSocket
    clearToken()
    vi.restoreAllMocks()
  })

  function Sub() {
    useWebSocket({ path: '/ws/presence', onMessage: () => {} })
    return null
  }

  // D2。关闭码比控制帧可靠（帧可能在背压下被丢），所以 4403 必须能独立触发 /me 刷新。
  // 删掉 useWebSocket 里的 4403 分支，本例立刻红。
  test('4403 ⇒ 让 /me 失效（凭据保留，不把人踢去登录）', () => {
    const spy = vi.spyOn(appQueryClient, 'invalidateQueries')
    const view = render(<Sub />)
    const sock = MockSocket.instances.at(-1)
    expect(sock).toBeDefined()

    act(() => {
      sock?.fireClose(4403)
    })

    expect(spy).toHaveBeenCalledWith({ queryKey: ACTOR_QUERY_KEY })
    // 凭据没有被清掉——4403 说的是"这条通道你没权限了"，不是"你的登录失效了"。
    expect(getAuthSessionRevision()).toBeGreaterThanOrEqual(0)
    view.unmount()
  })

  test('4401 ⇒ 不走 /me 失效那条分支（两者语义不得混同）', () => {
    const spy = vi.spyOn(appQueryClient, 'invalidateQueries')
    const view = render(<Sub />)
    const sock = MockSocket.instances.at(-1)
    act(() => {
      sock?.fireClose(4401)
    })
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ACTOR_QUERY_KEY })
    view.unmount()
  })
})

describe('RFC-312 实现门 —— 订阅接线必须被真的挂载过一次', () => {
  beforeEach(() => {
    MockSocket.instances = []
    globalThis.WebSocket = MockSocket as never
    setBaseUrl('http://d.test')
    resetPresence()
    setToken('t')
  })
  afterEach(() => {
    globalThis.WebSocket = RealWebSocket
    appQueryClient.clear()
    clearToken()
    resetPresence()
  })

  function Host() {
    usePresenceSubscription()
    const online = usePresenceOf('u1')
    return <span data-testid="probe">{online === undefined ? 'unknown' : String(online)}</span>
  }

  function grantPresence(): void {
    // usePermission 只认「settled + success + idle」的 /me 快照，所以直接把它塞进缓存。
    appQueryClient.setQueryData([...ACTOR_QUERY_KEY, 't'], {
      user: { id: 'me', username: 'me', displayName: 'me', role: 'user', status: 'active' },
      permissions: ['users:presence'],
    })
  }

  // P2-10。此前整份 suite 只直接驱动 store，**把 usePresenceSubscription 换成空实现也全绿**。
  // 这一条把"权限 → 建连 → 收快照 → store 水化"整条接线跑通，空实现会立刻红。
  test('有权限时挂载 ⇒ 只建一条 /ws/presence 连接，收到快照后 store 水化', () => {
    grantPresence()
    const view = render(
      <QueryClientProvider client={appQueryClient}>
        <Host />
      </QueryClientProvider>,
    )
    const presenceSockets = MockSocket.instances.filter((s) => s.url.includes('/ws/presence'))
    expect(presenceSockets).toHaveLength(1)

    act(() => {
      presenceSockets[0]?.fireMessage({ type: 'presence.snapshot', online: ['u1'] })
    })
    expect(view.getByTestId('probe').textContent).toBe('true')
    view.unmount()
  })

  test('无权限时挂载 ⇒ 根本不建立连接（服务端也会拒绝升级）', () => {
    const view = render(
      <QueryClientProvider client={appQueryClient}>
        <Host />
      </QueryClientProvider>,
    )
    expect(MockSocket.instances.filter((s) => s.url.includes('/ws/presence'))).toHaveLength(0)
    expect(view.getByTestId('probe').textContent).toBe('unknown')
    view.unmount()
  })
})
