// RFC-319 B14 —— 融合（记忆 → 技能）的可见性与决定权（INTENT-58 / INTENT-X3）。
//
// 一次融合会**改写一个托管技能的正文并递增它的版本**，而技能正文是往后每一次
// 任务都会读到的东西。所以「谁能看见这次融合」「谁能拍板」是两条真实的边界：
//   * 看得见 ⇒ 提案 diff、被吸收的记忆清单、融合意图全部可读；
//   * 拍得了板 ⇒ 他可以把任意内容合进别人的技能，而技能改了不会通知任何人。
//
// 判据取自源码单一事实源：
//   列表 / 详情 / 待审计数（routes/fusions.ts:104,148,131）—— 非 `resource-acl:bypass`
//     的调用方只看得到 `ownerUserId === 自己` 的行；详情对非 owner 与不存在**同形 404**。
//   `approveFusion` / `rejectFusion` / `cancelFusion`（services/fusion.ts:1415,1521,1720）
//     —— `canDecide` 不过则 `fusion-forbidden`。
//
// 这条用例只需要融合**行存在**，不需要它跑完：隔离面在 `running` 阶段就已成立。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const PASSWORD = 'Rfc319FusionPass!1'
const NEVER_EXISTED = '01JZZZZZZZZZZZZZZZZZZZZZZZ'

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

/** 拒绝正文里会回显调用方自己送进去的 id；比较前归一，见 human-gate-access.spec.ts。 */
function normalizeRefusal(body: string, askedId: string): string {
  return body.split(askedId).join('<asked-id>')
}

/**
 * 一个**有权限、无归属**的陌生人。
 *
 * 角色选择是这条用例最容易搞砸的地方：`manager` 自带 `resource-acl:bypass`
 * （permission.ts 的 MANAGER_EXTRA），他本来就该看得见所有融合——拿他当
 * 「陌生人」，隔离断言会恒真。
 *
 * 反过来 `user` 基线已经覆盖了融合面需要的全部权限（`skills:read` /
 * `skills:update` / `tasks:execute` / `memory:update` 都在 USER_RESOURCE_*
 * 与 USER_EXECUTE 里，被 spread 进 USER_BASELINE），而**没有** bypass。
 * 所以纯 `user` 恰好是这里要的形状：他打过来被拒，只可能是因为归属，
 * 不可能是因为缺权限——显式再授一遍反而会被服务端判 `user-permission-redundant`。
 */
async function stranger(): Promise<string> {
  const username = `rfc319-fusion-outsider-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    }),
    `seed ${username}`,
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    }),
    `login ${username}`,
  )
  return sessionToken
}

async function launchFusion(): Promise<string> {
  const skill = await jsonOf<{ id: string }>(
    await req('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-fusion-skill-${++sequence}`,
        description: 'RFC-319 fusion fixture',
        bodyMd: '# fixture\n',
      }),
    }),
    'seed skill',
  )
  // 融合只吃 approved 的记忆（fusion-engine 的 `fusion-memory-not-approved`），
  // 而手工建的记忆初始是 candidate —— 必须先 promote（见 memory-access.spec.ts）。
  const memory = await jsonOf<{ memory: { id: string } }>(
    await req('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'global',
        scopeId: null,
        title: `rfc319-fusion-memory-${sequence}`,
        bodyMd: 'Always use two spaces for indentation in this repository.',
      }),
    }),
    'seed memory',
  )
  await jsonOf(
    await req(`/api/memories/${memory.memory.id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ action: 'approve' }),
    }),
    'promote memory',
  )
  const fusion = await jsonOf<{ id: string }>(
    await req('/api/fusions', {
      method: 'POST',
      body: JSON.stringify({
        skillId: skill.id,
        memoryIds: [memory.memory.id],
        intent: 'RFC-319 fixture fusion',
      }),
    }),
    'launch fusion',
  )
  return fusion.id
}

// ---------------------------------------------------------------------------
// INTENT-58 —— 可见性隔离：列表 / 详情 / 待审计数三个面
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-58: a fusion is scoped to its owner across all three read surfaces — list, detail and the pending badge', async () => {
  const fusionId = await launchFusion()
  const outsider = await stranger()

  // 前提：owner 自己看得到（否则「别人看不到」不说明任何问题）。
  expect((await req(`/api/fusions/${fusionId}`)).status).toBe(200)
  expect(
    (await jsonOf<Array<{ id: string }>>(await req('/api/fusions'), 'owner lists')).map(
      (f) => f.id,
    ),
  ).toContain(fusionId)

  // ① 列表
  const listed = await jsonOf<Array<{ id: string }>>(
    await req('/api/fusions', undefined, outsider),
    'outsider lists fusions',
  )
  expect(
    listed.map((f) => f.id),
    '别人的融合出现在陌生人的列表里 ⇒ 提案 diff 与被吸收的记忆清单一并可读',
  ).not.toContain(fusionId)

  // ② 详情：与「不存在」同形（归一掉调用方自己送进去的 id 之后逐字节相等）。
  const hidden = await req(`/api/fusions/${fusionId}`, undefined, outsider)
  const absent = await req(`/api/fusions/${NEVER_EXISTED}`, undefined, outsider)
  expect(hidden.status).toBe(absent.status)
  expect(
    normalizeRefusal(await hidden.text(), fusionId),
    '「存在但不属于我」与「不存在」响应不同 ⇒ 可以枚举别人的融合',
  ).toBe(normalizeRefusal(await absent.text(), NEVER_EXISTED))

  // ③ 待审徽标：计数不得把别人的算进来。这个面最容易被漏——它是个数字，
  //    错了不会有任何症状，只是导航栏上多一个点。
  const badge = await jsonOf<{ count: number }>(
    await req('/api/fusions/pending-count', undefined, outsider),
    'outsider reads pending badge',
  )
  const ownerBadge = await jsonOf<{ count: number }>(
    await req('/api/fusions/pending-count'),
    'owner reads pending badge',
  )
  expect(
    badge.count,
    '陌生人的待审计数把别人的融合算了进去 ⇒ 数字本身就是一次存在性泄露',
  ).toBeLessThanOrEqual(ownerBadge.count)
  expect(badge.count).toBe(0)
})

// ---------------------------------------------------------------------------
// INTENT-X3 —— 决定权：跨用户的 approve / reject / cancel 全部被拒
// ---------------------------------------------------------------------------

test('RFC-319 INTENT-X3: no one but the fusion owner can approve, reject or cancel it', async () => {
  const fusionId = await launchFusion()
  const outsider = await stranger()

  const attempts: string[] = []
  const calls = [
    ['approve', `/api/fusions/${fusionId}/approve`, {}],
    ['reject', `/api/fusions/${fusionId}/reject`, { feedback: 'merge it anyway' }],
    ['cancel', `/api/fusions/${fusionId}/cancel`, {}],
  ] as const
  for (const [what, path, body] of calls) {
    const res = await req(path, { method: 'POST', body: JSON.stringify(body) }, outsider)
    if (res.ok) attempts.push(`${what} → ${res.status}`)
    else {
      // 三条写路径的拒绝形状必须是**决定权**层的 `fusion-forbidden`，
      // 而不是别的什么原因——否则这条断言可能只是「参数不对」。
      const code = ((await res.json()) as { code?: string }).code
      expect(
        code,
        `${what} 的拒绝码是 ${code}，不是 fusion-forbidden ⇒ 拒绝可能来自别的原因，` +
          `这条用例就证明不了决定权边界`,
      ).toBe('fusion-forbidden')
    }
  }
  expect(
    attempts,
    '陌生人对别人的融合做出了决定 ⇒ 他可以把任意内容合进别人的技能，而技能改了不通知任何人',
  ).toEqual([])

  // 融合确实没被陌生人推进。判据只排除**他的三个动作会产生的那两个终态**，
  // 而不是白名单 `['running','awaiting_approval']`——融合引擎任务可能因为它
  // 自己的原因失败（环境、runtime），那与「陌生人有没有得逞」无关。写成白名单
  // 会让这条断言在一个与它无关的原因下变红（RES-28 就是这么在 CI 上炸的）。
  const after = await jsonOf<{ status: string }>(
    await req(`/api/fusions/${fusionId}`),
    'owner re-reads the fusion',
  )
  expect(
    after.status,
    'approve 被拒了，融合却变成了 done ⇒ 别人的技能被合进了不该有的内容',
  ).not.toBe('done')
  expect(after.status, 'cancel 被拒了，融合却变成了 canceled ⇒ 陌生人取消了别人的工作').not.toBe(
    'canceled',
  )
})
