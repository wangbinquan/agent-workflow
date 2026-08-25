// RFC-319 B7 —— 记忆的可见性与管理权边界（MEM-35/36/37）。
//
// 记忆是**会被注入到下一次任务 prompt 里**的内容。它的访问边界坏掉有两个方向，
// 两个都不响亮：
//   * 读面漏 ⇒ 一个用户能读到他看不见的资源上挂着的记忆（内容泄露，且泄露的是
//     别人沉淀下来的经验与上下文）；
//   * 写面漏 ⇒ 任何看得见的人都能改写/归档别人的记忆，而记忆改了之后只会在下一次
//     任务的 prompt 里悄悄生效，没有任何人会收到通知。
//
// 判据来自 `services/memory.ts` 的两个单一事实源：
//   `canViewMemory`（:778）—— repo / repo_group / global 全员可读；资源 scope 随
//                            绑定资源的可见性；资源不存在则 fail closed。
//   `canManageMemory`（:799）—— repo / repo_group / global **仅** ACL bypass 可管。
//
// 这些规则此前只有内存 DB 单测。这里走编译后的 daemon，连中间件与错误码投影一起锁。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(90_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function req(path: string, init?: RequestInit, token?: string): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token ?? daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

async function jsonOf<T>(res: Response, what: string): Promise<T> {
  const body = await res.text()
  expect(res.ok, `${what}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

async function plainUser(): Promise<string> {
  const username = `rfc319-mem-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: 'Rfc319MemoryPass!1',
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Rfc319MemoryPass!1' }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

async function seedAgent(name: string): Promise<string> {
  return (
    await jsonOf<{ id: string }>(
      await req('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: 'RFC-319 memory fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: 'body',
        }),
      }),
      `seed agent ${name}`,
    )
  ).id
}

/**
 * 建一条记忆。
 *
 * 两处实测出来的契约，都不在任何文档里：
 *   * 回执是 `{ memory: { id, … } }`，不是扁平的 `{ id }`；
 *   * **手工建出来的记忆初始状态是 `candidate`**（未审蒸馏产物同一档），
 *     而列表对没有 `resource-acl:bypass` 的 actor 会把 candidate 整个过滤掉
 *     （memories.ts:128 的 `dropCandidates`）。所以要让普通用户看得见，
 *     必须先 promote。
 */
async function seedMemory(
  scopeType: 'agent' | 'repo' | 'global',
  scopeId: string | null,
  title: string,
  promote = true,
): Promise<string> {
  const created = await jsonOf<{ memory: { id: string } }>(
    await req('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        scopeType,
        scopeId,
        title,
        bodyMd: 'RFC-319 fixture body that is long enough to be meaningful.',
      }),
    }),
    `seed memory ${title}`,
  )
  const id = created.memory.id
  if (promote) {
    const promoted = await req(`/api/memories/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    })
    expect(promoted.ok, `promote ${title}: ${await promoted.text()}`).toBe(true)
  }
  return id
}

const listIds = async (token: string): Promise<string[]> => {
  const res = await req('/api/memories', undefined, token)
  const body = await res.text()
  expect(res.ok, `list memories: ${res.status} ${body}`).toBe(true)
  const parsed = JSON.parse(body) as unknown
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as { rows?: unknown[]; items?: unknown[] }).rows ??
      (parsed as { items?: unknown[] }).items ??
      [])
  return (rows as Array<{ id?: string }>).map((row) => row.id ?? '')
}

// ---------------------------------------------------------------------------
// MEM-36 —— 资源 scope 的记忆随资源可见性
// ---------------------------------------------------------------------------

test('RFC-319 MEM-36: an agent-scoped memory follows the agent visibility — filtered from the list and indistinguishable from absent', async () => {
  const agentId = await seedAgent(`rfc319-mem-agent-${++sequence}`)
  const memoryId = await seedMemory('agent', agentId, `rfc319-agent-memory-${sequence}`)
  const stranger = await plainUser()

  // 先公开那个 agent：陌生人**看得见**这条记忆。没有这一步，后面的「看不见」
  // 可能只是因为他本来就读不到任何记忆。
  await jsonOf(
    await req(`/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agentId,
        expectedAclRevision: 0,
      }),
    }),
    'publish agent',
  )
  expect(
    await listIds(stranger),
    '资源公开时陌生人仍看不到它的记忆 ⇒ 后面的隔离断言证明不了任何东西',
  ).toContain(memoryId)

  // 私有化那个 agent ⇒ 记忆随之从列表消失。
  await jsonOf(
    await req(`/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: agentId,
        expectedAclRevision: 1,
      }),
    }),
    'unpublish agent',
  )
  expect(
    await listIds(stranger),
    '绑定资源已私有，它的记忆仍出现在陌生人的列表里 ⇒ 别人沉淀的上下文被泄露',
  ).not.toContain(memoryId)

  // 详情与「不存在」同形——否则 id 的存在性会从错误码泄露出去。
  const hidden = await req(`/api/memories/${memoryId}`, undefined, stranger)
  const absent = await req('/api/memories/01JZZZZZZZZZZZZZZZZZZZZZZZ', undefined, stranger)
  expect(hidden.status, '不可见记忆的详情与「不存在」状态码不同').toBe(absent.status)
})

// ---------------------------------------------------------------------------
// MEM-37 —— repo / global：全员可读，仅 ACL bypass 可管
// ---------------------------------------------------------------------------

test('RFC-319 MEM-37: repo and global memories are readable by everyone but manageable only with resource-acl:bypass', async () => {
  const globalId = await seedMemory('global', null, `rfc319-global-memory-${++sequence}`)
  const reader = await plainUser()

  // 读面：全员可读（RFC-248 AC-29 明确把 repo / repo_group / global 放在同一档）。
  expect(
    await listIds(reader),
    'global 记忆对普通用户不可见 ⇒ 与 canViewMemory:783-789 的规则相反',
  ).toContain(globalId)
  expect((await req(`/api/memories/${globalId}`, undefined, reader)).status).toBe(200)

  // 写面：普通用户不能改、不能归档、不能删。
  // 这三条要分别打——它们是三个独立的端点，任何一个漏掉授权检查都足以让
  // 「全员可读」变成「全员可写」，而记忆改了只会在下一次任务的 prompt 里悄悄生效。
  const refusals: string[] = []
  const patch = await req(
    `/api/memories/${globalId}`,
    { method: 'PATCH', body: JSON.stringify({ title: 'hijacked' }) },
    reader,
  )
  if (patch.ok) refusals.push(`PATCH → ${patch.status}`)
  const archive = await req(`/api/memories/${globalId}/archive`, { method: 'POST' }, reader)
  if (archive.ok) refusals.push(`archive → ${archive.status}`)
  const removed = await req(`/api/memories/${globalId}`, { method: 'DELETE' }, reader)
  if (removed.ok) refusals.push(`DELETE → ${removed.status}`)
  expect(
    refusals,
    '普通用户改动了 global 记忆。canManageMemory:805-812 明确要求 repo / repo_group / ' +
      'global 仅 ACL bypass 可管——「全员可读」不等于「全员可写」',
  ).toEqual([])

  // 内容确实没被改动。
  const after = await jsonOf<{ title: string }>(
    await req(`/api/memories/${globalId}`),
    'read back global memory',
  )
  expect(after.title, '被拒绝的写入仍然改掉了标题').not.toBe('hijacked')

  // 对照：有 bypass 的账号改得动——否则上面三条可能只是「这个端点对谁都拒」。
  const okPatch = await req(`/api/memories/${globalId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'renamed by an admin' }),
  })
  expect(
    okPatch.ok,
    `具备 ACL bypass 的账号也改不动 ⇒ 上面三条拒绝证明不了针对性：${await okPatch.text()}`,
  ).toBe(true)
})

// ---------------------------------------------------------------------------
// MEM-35 —— 逐行管理权：看得见 ≠ 管得了
// ---------------------------------------------------------------------------

test('RFC-319 MEM-35: a user who can see an agent-scoped memory still cannot edit, archive or delete it', async () => {
  const agentId = await seedAgent(`rfc319-mem-manage-${++sequence}`)
  const memoryId = await seedMemory('agent', agentId, `rfc319-manage-memory-${sequence}`)
  await jsonOf(
    await req(`/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agentId,
        expectedAclRevision: 0,
      }),
    }),
    'publish agent',
  )
  const viewer = await plainUser()

  // 前提：他确实看得见这一行。这条断言把后面的「改不动」精确归因到**管理权**，
  // 而不是可见性——RFC-317 抓到过同形的真事故：五类 ACL 资源的写门只校验「能看见」。
  expect(await listIds(viewer), '前提不成立：这个用户根本看不到那条记忆').toContain(memoryId)

  const leaks: string[] = []
  const patch = await req(
    `/api/memories/${memoryId}`,
    { method: 'PATCH', body: JSON.stringify({ title: 'edited by a viewer' }) },
    viewer,
  )
  if (patch.ok) leaks.push(`PATCH → ${patch.status}`)
  const archived = await req(`/api/memories/${memoryId}/archive`, { method: 'POST' }, viewer)
  if (archived.ok) leaks.push(`archive → ${archived.status}`)
  const deleted = await req(`/api/memories/${memoryId}`, { method: 'DELETE' }, viewer)
  if (deleted.ok) leaks.push(`DELETE → ${deleted.status}`)
  expect(
    leaks,
    '看得见就改得动 ⇒ 写门只校验了可见性。这正是 RFC-317 在五类 ACL 资源上抓到的 P1 形态',
  ).toEqual([])
})

// ---------------------------------------------------------------------------
// MEM-34 —— 候选（未审蒸馏产物）对无 resource-acl:bypass 者不可见
// ---------------------------------------------------------------------------

test('RFC-319 MEM-34: candidate rows stay invisible to non-bypass actors until they are promoted', async () => {
  // 这条规则的用途是：蒸馏出来的东西在有人过目之前，不该出现在任何普通用户面前，
  // 也不该被注入进 prompt。它由 memories.ts:128 的 `dropCandidates` 单点实现——
  // 一行 `filter`，删掉它不会有任何测试变红（在这条用例之前）。
  const candidateId = await seedMemory(
    'global',
    null,
    `rfc319-candidate-${++sequence}`,
    /* promote */ false,
  )
  const reader = await plainUser()

  expect(
    await listIds(reader),
    '未审的候选记忆出现在普通用户的列表里 ⇒ 人审这道门形同虚设',
  ).not.toContain(candidateId)
  // 具备 bypass 的账号看得见（否则上面那条可能只是「谁都看不见」）。
  expect(await listIds(daemon.token)).toContain(candidateId)

  // 人审发布之后，它回到全员可见面。
  const promoted = await req(`/api/memories/${candidateId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  expect(promoted.ok, `promote: ${await promoted.text()}`).toBe(true)
  expect(await listIds(reader), '人审发布之后普通用户仍看不到 ⇒ 发布这个动作没有生效').toContain(
    candidateId,
  )
})

// ---------------------------------------------------------------------------
// MEM-04 —— 对没有管理权的 scope 建记忆被拒
// ---------------------------------------------------------------------------

test('RFC-319 MEM-04: creating a memory on a scope you do not manage is refused @nightly', async () => {
  // 建记忆是**写面**动作：它决定了往后哪些内容会被注入进别人的 prompt。
  // 读得到 ≠ 写得进——这条锁的就是这个不对称（memories.ts:193 的 canManageMemory 前置）。
  const outsider = await plainUser()
  const attempts: string[] = []

  // global：仅 ACL bypass 可管。
  const onGlobal = await req(
    '/api/memories',
    {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'global',
        scopeId: null,
        title: 'injected-by-outsider',
        bodyMd: 'This should never be reachable.',
      }),
    },
    outsider,
  )
  if (onGlobal.ok) attempts.push(`global → ${onGlobal.status}`)

  // 别人的 agent：即便公开可读，也只有 owner / bypass 能往它上面挂记忆。
  const agentId = await seedAgent(`rfc319-mem-writeguard-${++sequence}`)
  await jsonOf(
    await req(`/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: agentId,
        expectedAclRevision: 0,
      }),
    }),
    'publish agent',
  )
  const onAgent = await req(
    '/api/memories',
    {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'agent',
        scopeId: agentId,
        title: 'injected-onto-someone-elses-agent',
        bodyMd: 'This should never be reachable either.',
      }),
    },
    outsider,
  )
  if (onAgent.ok) attempts.push(`public agent → ${onAgent.status}`)

  expect(
    attempts,
    '陌生人往自己管不着的 scope 写进了记忆 ⇒ 他可以给别人的下一次任务 prompt 塞内容',
  ).toEqual([])
  expect(onAgent.status, '公开可读的 agent 上，写被拒的状态码应是 403 而不是 404').toBe(403)
})

// ---------------------------------------------------------------------------
// MEM-10 / MEM-08 —— 驳回候选（终态），以及终态不可再编辑
// ---------------------------------------------------------------------------

test('RFC-319 MEM-10 & MEM-08: rejecting a candidate is terminal — it never becomes visible and can no longer be edited @nightly', async () => {
  const id = await seedMemory('global', null, `rfc319-reject-${++sequence}`, /* promote */ false)

  const rejected = await jsonOf<{ memory: { status: string; approvedAt: number | null } }>(
    await req(`/api/memories/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
    }),
    'reject candidate',
  )
  expect(rejected.memory.status).toBe('rejected')
  expect(
    rejected.memory.approvedAt ?? null,
    '被驳回的候选却带上了 approvedAt ⇒ 注入侧按「已批准」判定时它会溜进 prompt',
  ).toBeNull()

  // 驳回是**终态**：不能再被 approve 洗回可用。
  // （实测记录：rejected 行仍留在列表读面上——`dropCandidates` 只挡 candidate。
  //  那是审计读面，不是注入泄露：注入侧 memoryInject.ts:143 只取 status='approved'，
  //  所以真正要锁死的是「回不到 approved」这件事，而不是「看不看得见」。）
  const relaunder = await req(`/api/memories/${id}/promote`, {
    method: 'POST',
    body: JSON.stringify({ action: 'approve' }),
  })
  expect(
    relaunder.ok,
    '被驳回的候选还能再 approve 一次 ⇒ 人审的「否决」不是终点，它随时可以被翻案回注入面',
  ).toBe(false)

  // MEM-08：终态行不可再编辑——否则「驳回」可以被一次 PATCH 洗回可用状态。
  const edit = await req(`/api/memories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'laundered-back-into-use' }),
  })
  expect(edit.status, '终态记忆仍可编辑 ⇒ 驳回这个动作可以被绕过').toBe(409)
  expect((await edit.json()).code).toBe('memory-terminal-status')
})

// ---------------------------------------------------------------------------
// MEM-19 —— 删除的双重确认门（?confirm=true；token 调用方还要回显标题）
// ---------------------------------------------------------------------------

test('RFC-319 MEM-19: deleting a memory needs ?confirm=true, and a token caller must additionally echo the title @nightly', async () => {
  // 删记忆没有回收站。两道门是**分层**的，且刻意不对称（RFC-247 T20）：
  //   * 人走 UI：一个 `?confirm=true` 就够了——他刚点过对话框；
  //   * token 走 REST/MCP：额外回显标题——它背后没有对话框，「模型决定调用它」
  //     与「行没了」之间不隔任何东西。
  // 挂在 agent scope 上是因为 PAT 拿不到 `resource-acl:bypass`：global 记忆在 token
  // 面上会先撞管理权 403，根本走不到确认门（实测），那样这条用例就什么也证明不了。
  const title = `rfc319-delete-gate-${++sequence}`
  const agentId = await seedAgent(`rfc319-mem-del-agent-${sequence}`)
  const id = await seedMemory('agent', agentId, title)

  // ① 人（session/daemon 源）不带 confirm ⇒ 422，且行还在。
  const naked = await req(`/api/memories/${id}`, { method: 'DELETE' })
  expect(naked.status).toBe(422)
  expect((await naked.json()).code).toBe('confirm-required')
  expect((await req(`/api/memories/${id}`)).status, '被拒的删除却真把行删了').toBe(200)

  const pat = await jsonOf<{ token: string }>(
    await req('/api/auth/pats', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-mem-delete-${sequence}`,
        scopes: ['memory:delete'],
        purpose: 'general',
      }),
    }),
    'mint pat',
  )

  // ② token 即便带了 confirm=true，也必须回显标题。
  const tokenNoEcho = await req(
    `/api/memories/${id}?confirm=true`,
    { method: 'DELETE', body: JSON.stringify({}) },
    pat.token,
  )
  expect(
    tokenNoEcho.status,
    `token 只凭 ?confirm=true 就删掉了记忆: ${await tokenNoEcho.clone().text()}`,
  ).toBe(422)
  expect((await tokenNoEcho.json()).code).toBe('delete-confirm-required')

  const tokenWrongEcho = await req(
    `/api/memories/${id}?confirm=true`,
    { method: 'DELETE', body: JSON.stringify({ confirm: 'some other title' }) },
    pat.token,
  )
  expect(tokenWrongEcho.status).toBe(422)
  expect((await tokenWrongEcho.json()).code).toBe('delete-confirm-mismatch')

  // ③ 回显对了才真删得掉——否则上面两条可能只是「token 压根删不掉任何东西」，
  //    那样这道门是不是生效就无从判断。
  const ok = await req(
    `/api/memories/${id}?confirm=true`,
    { method: 'DELETE', body: JSON.stringify({ confirm: title }) },
    pat.token,
  )
  expect(ok.status, `echo 正确时仍删不掉: ${await ok.clone().text()}`).toBe(200)
  expect((await req(`/api/memories/${id}`)).status).toBe(404)
})

// ---------------------------------------------------------------------------
// MEM-48 —— 列表过滤（search / tag / scope），非法过滤值 422
// ---------------------------------------------------------------------------

test('RFC-319 MEM-48: list filters narrow the result set, and an invalid filter value is refused rather than silently ignored @nightly', async () => {
  const marker = `rfc319-filter-${++sequence}`
  const matching = await seedMemory('global', null, `${marker}-match`)
  const other = await seedMemory('global', null, `rfc319-unrelated-${sequence}`)

  const idsOf = async (query: string): Promise<string[]> => {
    const res = await req(`/api/memories${query}`)
    const body = await res.text()
    expect(res.ok, `${query}: ${res.status} ${body}`).toBe(true)
    return (JSON.parse(body).items as Array<{ id: string }>).map((r) => r.id)
  }

  const searched = await idsOf(`?search=${encodeURIComponent(marker)}`)
  expect(searched).toContain(matching)
  expect(
    searched,
    'search 过滤没把不匹配的行排除掉 ⇒ 过滤器是装饰品，用户翻不到自己要的那条',
  ).not.toContain(other)

  // 非法过滤值必须报错。静默忽略比报错更坏：用户以为自己在看过滤后的结果。
  for (const [query, what] of [
    ['?scopeType=not-a-scope', 'scopeType'],
    ['?status=not-a-status', 'status'],
    ['?include=everything', 'include'],
  ] as const) {
    const res = await req(`/api/memories${query}`)
    expect(res.status, `非法 ${what} 被静默忽略（${res.status}）⇒ 用户看到的是未过滤的全量`).toBe(
      422,
    )
    expect((await res.json()).code).toBe('invalid-filter')
  }
})
