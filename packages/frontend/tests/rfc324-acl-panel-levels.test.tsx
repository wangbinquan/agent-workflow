// RFC-324 —— 权限面板的档位控件，以及 useResourceAccess 的乐观/严格双语义。
//
// 用户对现状的原话是「没有档位可选、心里没底」：后端的 grant 一直只授「可见可用」，
// 而面板上只有所有者 / 可见性 / 授权用户三项，没有任何地方告诉授权者他给出去的是
// 什么。所以本 RFC 的前端交付不是"加一个下拉"，而是让档位在面板里成为可见、可选、
// 默认安全的东西。
//
// 本文件锁 proposal.md §7 的 AC-12，外加 hook 的两条语义（design.md §10.1）：
//   - 判定未到达时**乐观**（UI 保持今天的可交互形态，不为一次网络抖动把 owner
//     锁在自己的资源外面）；
//   - `isResolved` 才是无人值守写入的依据（工作流编辑器的 heal 自动保存据此闸门）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
    },
  }
})

import { api } from '../src/api/client'
import { AclPanel } from '../src/components/AclPanel'
import { Dialog } from '../src/components/Dialog'
import { useResourceAccess } from '../src/hooks/useResourceAccess'
import { setToken } from '../src/stores/auth'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)
const mockedPut = vi.mocked(api.put)

function makeQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
}

function wrap(node: React.ReactElement, qc = makeQueryClient()) {
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function user(id: string, username: string, role: 'user' | 'manager' = 'user') {
  return { id, username, displayName: `DN ${username}`, role, status: 'active' }
}

const ALICE = user('u-alice', 'alice')
const BOSS = user('u-boss', 'boss', 'manager')
const CAROL = user('u-carol', 'carol')

function acl(overrides: Record<string, unknown> = {}) {
  return {
    resourceType: 'agent',
    resourceId: 'a1',
    ownerUserId: 'u-owner',
    owner: user('u-owner', 'owner'),
    visibility: 'private',
    grants: [{ user: ALICE, level: 'read' }],
    canManage: true,
    canEdit: true,
    aclRevision: 3,
    ...overrides,
  }
}

/** 面板会请求 /me、/acl 与用户搜索；三类响应必须保持各自的 wire shape。 */
function installGet(
  aclBody: Record<string, unknown>,
  searchUsers: ReturnType<typeof user>[] = [],
): void {
  mockedGet.mockImplementation(async (url: string) => {
    if (url.endsWith('/acl')) return aclBody
    if (url === '/api/users/search') return searchUsers
    return { source: 'session', user: user('u-owner', 'owner'), permissions: [] }
  })
}

beforeEach(() => {
  setToken('aws_s_test-token')
  mockedGet.mockReset()
  mockedPut.mockReset()
})
afterEach(() => cleanup())

describe('RFC-324 AclPanel —— 逐人档位', () => {
  test('管理态：每个被授权人有一个档位控件，选中值来自服务端', async () => {
    installGet(acl())
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())

    const read = screen.getByTestId(`acl-level-read-${ALICE.id}`)
    const write = screen.getByTestId(`acl-level-write-${ALICE.id}`)
    expect(read.getAttribute('aria-checked'), '服务端说是 read，控件就得显示 read').toBe('true')
    expect(write.getAttribute('aria-checked')).toBe('false')
  })

  test('既有成员是一人一行，不再塞进“添加成员”的搜索框', async () => {
    installGet(acl())
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    const grantRow = await screen.findByTestId(`acl-grant-${ALICE.id}`)
    const searchInput = screen.getByTestId('acl-members-input')

    expect(grantRow.textContent).toContain('DN alice')
    expect(screen.getByTestId(`acl-level-read-${ALICE.id}`)).toBeTruthy()
    expect(searchInput.closest('.chips-input__row')?.textContent).not.toContain('DN alice')
  })

  test('添加成员是一次完整动作：选中后下拉关闭，新成员独立成行且默认只读', async () => {
    installGet(acl(), [CAROL])
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await screen.findByTestId(`acl-grant-${ALICE.id}`)

    const input = screen.getByTestId('acl-members-input')
    fireEvent.mouseDown(input)
    fireEvent.click(await screen.findByTestId('acl-members-option-carol'))

    const carolRow = await screen.findByTestId(`acl-grant-${CAROL.id}`)
    expect(carolRow.textContent).toContain('DN carol')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByTestId(`acl-level-read-${CAROL.id}`).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByTestId('acl-members-remove-carol')).toBeTruthy()
    expect((screen.getByTestId('acl-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('改档位 → 保存：PUT body 里带的是 grants，每项一个 level', async () => {
    installGet(acl())
    mockedPut.mockResolvedValue(acl({ grants: [{ user: ALICE, level: 'write' }], aclRevision: 4 }))
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())

    const save = screen.getByTestId('acl-save') as HTMLButtonElement
    expect(save.disabled, '未改动时保存不可用').toBe(true)

    fireEvent.click(screen.getByTestId(`acl-level-write-${ALICE.id}`))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(mockedPut).toHaveBeenCalled())
    expect(mockedPut).toHaveBeenCalledWith('/api/agents/x/acl', {
      visibility: 'private',
      grants: [{ userId: ALICE.id, level: 'write' }],
      expectedResourceId: 'a1',
      expectedAclRevision: 3,
    })
  })

  test('管理员被授权人带提示：只读档对他无效，面板得说出来', async () => {
    installGet(acl({ grants: [{ user: BOSS, level: 'read' }] }))
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    const note = screen.getByTestId(`acl-level-admin-note-${BOSS.id}`)
    expect(note, '给管理员设只读却不提示，等于让 owner 以为锁住了他').toBeTruthy()
    expect(
      note.textContent !== null && note.textContent.trim().length > 20,
      '提示必须直接说清平台级权限例外，不能退回只有悬浮 title 的警告符号',
    ).toBe(true)
  })

  test('普通被授权人没有那条提示（提示只在真的无效时出现）', async () => {
    installGet(acl())
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    expect(screen.queryByTestId(`acl-level-admin-note-${ALICE.id}`)).toBeNull()
  })

  test('执行面资源切到可编辑时，立刻显示明确的运行风险提示', async () => {
    installGet(acl({ resourceType: 'mcp' }))
    wrap(<AclPanel resourceBaseUrl="/api/mcps/x" invalidateKey={['mcps']} />)
    await screen.findByTestId(`acl-grant-${ALICE.id}`)
    expect(screen.queryByTestId('acl-execution-risk')).toBeNull()

    fireEvent.click(screen.getByTestId(`acl-level-write-${ALICE.id}`))

    const warning = screen.getByTestId('acl-execution-risk')
    expect(warning.textContent !== null && warning.textContent.trim().length > 30).toBe(true)
  })

  // 红→绿对：把 UserPicker 的 `onFocus` 改回无条件 `setOpen(true)`，本条立刻红。
  //
  // 实撞（`e2e-webkit-nightly`，`rfc099-ownership-acl.spec.ts:232` 报
  // `<ul class="user-picker__results"> intercepts pointer events`）：三件事串起来
  // 就是「一打开权限弹窗，下拉自动展开、盖住弹窗自己的按钮」——
  //   ① `Dialog.resolveInitialDialogFocus` 把初始焦点给 `.dialog__body` 里第一个
  //      可聚焦元素；
  //   ② AclPanel 里那正是加人搜索框（<UserPicker> 排在「转让所有者」按钮前面）；
  //   ③ 旧 UserPicker 的 onFocus 无条件展开列表。
  // chromium 上侥幸点得中，webkit 上稳定拦截——所以单测里锁住这条比锁 e2e 更划算。
  test('装进 Dialog 后：加人搜索框拿到焦点也不展开列表（否则盖住转让 / 保存）', async () => {
    installGet(acl())
    wrap(
      <Dialog open onClose={() => {}} title="acl">
        <AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />
      </Dialog>,
    )
    const input = await screen.findByTestId('acl-members-input')

    // 分工说明（不是偷懒）：jsdom 没有布局，`isAvailableFocusTarget` 会把这个 input
    // 判成不可聚焦，于是 Dialog 的初始焦点退回 `.dialog__panel`——**在 jsdom 里复现
    // 不出「焦点自动落到搜索框」这一步**，这也正是它只在真浏览器（且只在 webkit）
    // 暴露的原因。所以这里锁的是**规则**：焦点到了也不许展开。整条链路的集成锁在
    // `e2e/rfc099-ownership-acl.spec.ts`（转让弹窗那一段）。
    fireEvent.focus(input)

    expect(input.getAttribute('aria-expanded'), '拿到焦点不等于用户要看列表').toBe('false')
    expect(
      screen.queryByRole('listbox'),
      '弹窗一打开就挂出一个门户列表，它会盖住下面的转让 / 保存按钮——那是个点不动的弹窗',
    ).toBeNull()
    expect(screen.getByTestId('acl-transfer-owner')).toBeTruthy()

    // 对照：用户真的点下去就该展开，否则上面三条可能只是「列表永远打不开」。
    fireEvent.mouseDown(input)
    expect(input.getAttribute('aria-expanded')).toBe('true')
  })

  // 与上一条成对：**转让弹窗的 picker 必须一打开就展开**。
  //
  // 这半边契约此前只活在 `e2e/rfc099-ownership-acl.spec.ts:290` 里，于是我把
  // 「聚焦不展开」做成全局规则时当场把它改坏了——chromium / macos / windows 四个
  // e2e 分片一起红。两条断言写在一起，是为了让下一个人一眼看见这不是「展开好还是
  // 不展开好」，而是**两个场合各有各的答案**：
  //   · 权限面板的加人搜索框：弹窗里还有转让 / 保存 / 可见性，展开会盖住它们；
  //   · 转让弹窗的 picker：弹窗里除了它什么都没有，展开就是它要做的事，而且
  //     两段式 Escape（第一下关列表、第二下关内层弹窗）依赖它一开始就是展开的。
  // 红→绿对：拿掉 AclPanel 传给转让 picker 的 `openOnMount`，本条立刻红。
  test('转让弹窗的 picker 一打开就展开（两段式 Escape 依赖它）', async () => {
    installGet(acl())
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await screen.findByTestId(`acl-grant-${ALICE.id}`)

    fireEvent.click(screen.getByTestId('acl-transfer-owner'))
    const transferInput = await screen.findByTestId('acl-transfer-input')
    expect(
      transferInput.getAttribute('aria-expanded'),
      '这个弹窗存在的唯一目的就是选人；不展开等于让用户再点一下才开始',
    ).toBe('true')
  })

  test('只读态：档位以文字呈现，没有任何可点的档位控件', async () => {
    installGet(acl({ canManage: false, canEdit: false }))
    wrap(<AclPanel resourceBaseUrl="/api/agents/x" invalidateKey={['agents']} />)
    await waitFor(() => expect(screen.queryByTestId('acl-panel')).toBeTruthy())
    expect(screen.queryByTestId('acl-save')).toBeNull()
    expect(screen.queryByTestId(`acl-level-read-${ALICE.id}`)).toBeNull()
    expect(screen.getByText('DN alice')).toBeTruthy()
  })
})

describe('RFC-324 useResourceAccess —— 乐观 UI，严格自动写', () => {
  function renderAccess(qc = makeQueryClient()) {
    return renderHook(() => useResourceAccess('/api/agents/x'), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    })
  }

  test('判定未到达：canEdit 乐观为真，但 isResolved 为假', async () => {
    // /acl 永不 resolve：模拟一次网络挂起。
    mockedGet.mockImplementation(async (url: string) => {
      if (url.endsWith('/acl')) return new Promise(() => {}) as never
      return { source: 'session', user: user('u-owner', 'owner'), permissions: [] }
    })
    const { result } = renderAccess()
    await waitFor(() => expect(result.current.isResolved).toBe(false))
    expect(
      result.current.canEdit,
      '失败关闭会凭空造出一种新故障：owner 因为一次抖动就编辑不了自己的资源',
    ).toBe(true)
  })

  test('判定到达：canEdit / canManage 逐字来自服务端，isResolved 为真', async () => {
    installGet(acl({ canEdit: false, canManage: false }))
    const { result } = renderAccess()
    await waitFor(() => expect(result.current.isResolved).toBe(true))
    expect(result.current.canEdit).toBe(false)
    expect(result.current.canManage).toBe(false)
  })

  test('响应里没有布尔判定（例如被一个通用 mock 接管）时，不算已解析', async () => {
    mockedGet.mockImplementation(async () => ({ anything: true }) as never)
    const { result } = renderAccess()
    await waitFor(() => expect(mockedGet).toHaveBeenCalled())
    expect(result.current.isResolved, '不是 ACL 的形状就不该被当成判定').toBe(false)
    expect(result.current.canEdit).toBe(true)
  })
})
