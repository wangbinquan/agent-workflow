// RFC-319 B10 —— 事件响应规则的增删改与权限分层（EVENT-30/31）。
//
// 响应规则是「某类事件发生时自动启动一份工作」的定义。它有两个安静的失败方向：
//
//   * **模板引用漂移**：规则里写 `{{trigger.x.y}}`，而那个事件根本不声明 y。
//     不在创建时拦，就要等真事件来了才发现——那时启动的是一份参数为空的工作，
//     而没有人在看。
//   * **越权改写**：规则决定「什么事件会自动开工」。谁能改它，谁就能让平台在
//     别人的仓库上跑东西。分层坏掉不会有任何报错，只会多出一次没人预期的执行。
//
// 判据取自源码单一事实源：
//   `EventResponseRuleService`（modules/event-center/application/eventResponseRules.ts:120-180）
//     —— create 落 ownerUserId；update/remove 先过 `#requireOwnedRule`，
//        非 owner 且无 override-owner ⇒ **NotFound**（与不存在同形，不是 403）。
//   `assertResponseTargetContract`（domain/responseRule.ts:146）
//   角色分层（schemas/permission.ts）：user 只有 `event-automation-rules:read`；
//     manager 另有 create/update/delete；`:override-owner` 只在管理档。

import { expect, test } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

const PASSWORD = 'Rfc319EventRulePass!1'

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

async function seedActor(role: 'user' | 'manager'): Promise<string> {
  const username = `rfc319-evt-${role}-${++sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role,
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

async function seedWorkflow(): Promise<string> {
  const created = await jsonOf<{ id: string }>(
    await req('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-evt-wf-${++sequence}`,
        description: 'RFC-319 event response fixture',
        definition: { $schema_version: 1, nodes: [], edges: [] },
      }),
    }),
    'seed workflow',
  )
  return created.id
}

/** 一份形状合法的规则草稿；调用方按需覆盖字段。 */
function draft(workflowId: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    name: `rfc319-rule-${++sequence}`,
    enabled: true,
    eventTypeRef: { id: 'code-host.branch.pushed', revision: 1 },
    subjectMatch: 'prefix',
    subjectPattern: 'rfc319/',
    target: {
      kind: 'workflow',
      refId: workflowId,
      nameTemplate: 'push on {{trigger.code_host.branch}}',
      inputs: { repo: '{{trigger.code_host.repo_path}}' },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// EVENT-30 —— 规则的增删改，含模板引用与主体匹配的校验
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-30: an event response rule round-trips through create / update / delete, and refuses a template that names a parameter the event never declares', async () => {
  const manager = await seedActor('manager')
  const workflowId = await seedWorkflow()

  const created = await jsonOf<{ id: string; subjectPattern: string; ownerUserId: string }>(
    await req(
      '/api/event-center/response-rules',
      { method: 'POST', body: JSON.stringify(draft(workflowId)) },
      manager,
    ),
    'create response rule',
  )
  expect(created.subjectPattern).toBe('rfc319/')

  const listed = await jsonOf<{ items: Array<{ id: string }> }>(
    await req('/api/event-center/response-rules', undefined, manager),
    'list response rules',
  )
  expect(listed.items.map((r) => r.id)).toContain(created.id)

  // 改：换主体匹配方式。这条同时验了「exact 必须带 pattern」的耦合规则还活着。
  const updated = await jsonOf<{ subjectMatch: string; subjectPattern: string }>(
    await req(
      `/api/event-center/response-rules/${created.id}`,
      {
        method: 'PUT',
        body: JSON.stringify(
          draft(workflowId, { subjectMatch: 'exact', subjectPattern: 'rfc319/exact' }),
        ),
      },
      manager,
    ),
    'update response rule',
  )
  expect(updated.subjectMatch).toBe('exact')
  expect(updated.subjectPattern).toBe('rfc319/exact')

  // 主体匹配与 pattern 的互斥约束：all 不许带 pattern，非 all 必须带。
  for (const bad of [
    { subjectMatch: 'all', subjectPattern: 'still-here' },
    { subjectMatch: 'prefix', subjectPattern: null },
  ]) {
    const res = await req(
      '/api/event-center/response-rules',
      { method: 'POST', body: JSON.stringify(draft(workflowId, bad)) },
      manager,
    )
    expect(res.status, `形状矛盾的草稿被接受了: ${JSON.stringify(bad)}`).toBe(422)
    expect((await res.json()).code).toBe('event-response-rule-invalid')
  }

  // 模板引用了这个事件没有声明的参数 ⇒ 必须在**创建时**就拒绝。
  // 放过去的话，真事件来的那天启动的是一份参数为空的工作，而没有人在看。
  const badRef = await req(
    '/api/event-center/response-rules',
    {
      method: 'POST',
      body: JSON.stringify(
        draft(workflowId, {
          target: {
            kind: 'workflow',
            refId: workflowId,
            nameTemplate: 'uses {{trigger.code_host.no_such_field}}',
            inputs: {},
          },
        }),
      ),
    },
    manager,
  )
  expect(
    badRef.status,
    '规则模板引用了事件未声明的参数却被接受 ⇒ 真事件来时会启动一份参数为空的工作',
  ).toBe(422)
  expect((await badRef.json()).code).toBe('event-response-template-ref-invalid')

  // 删：删完列表里没有了，再删一次是 404（不是静默成功）。
  await jsonOf(
    await req(`/api/event-center/response-rules/${created.id}`, { method: 'DELETE' }, manager),
    'delete response rule',
  )
  const after = await jsonOf<{ items: Array<{ id: string }> }>(
    await req('/api/event-center/response-rules', undefined, manager),
    'list after delete',
  )
  expect(after.items.map((r) => r.id)).not.toContain(created.id)
  expect(
    (await req(`/api/event-center/response-rules/${created.id}`, { method: 'DELETE' }, manager))
      .status,
    '重复删除静默成功 ⇒ 调用方分不清「我删掉了」和「它本来就不在」',
  ).toBe(404)
})

// ---------------------------------------------------------------------------
// EVENT-31 —— 三档权限：user 只读 / manager 只管自己的 / 管理档跨 owner
// ---------------------------------------------------------------------------

test('RFC-319 EVENT-31: rule authoring is tiered — a plain user can only read, a manager cannot touch another manager rule, and an access administrator can', async () => {
  const workflowId = await seedWorkflow()
  const alice = await seedActor('manager')
  const bob = await seedActor('manager')
  const reader = await seedActor('user')

  const rule = await jsonOf<{ id: string }>(
    await req(
      '/api/event-center/response-rules',
      { method: 'POST', body: JSON.stringify(draft(workflowId)) },
      alice,
    ),
    'alice creates a rule',
  )

  // ① 普通用户：读得到（规则不是秘密），但一个写动作都做不了。
  const readable = await jsonOf<{ items: Array<{ id: string }> }>(
    await req('/api/event-center/response-rules', undefined, reader),
    'plain user lists rules',
  )
  expect(readable.items.map((r) => r.id)).toContain(rule.id)
  for (const [what, res] of [
    [
      'create',
      await req(
        '/api/event-center/response-rules',
        { method: 'POST', body: JSON.stringify(draft(workflowId)) },
        reader,
      ),
    ],
    [
      'update',
      await req(
        `/api/event-center/response-rules/${rule.id}`,
        { method: 'PUT', body: JSON.stringify(draft(workflowId)) },
        reader,
      ),
    ],
    [
      'delete',
      await req(`/api/event-center/response-rules/${rule.id}`, { method: 'DELETE' }, reader),
    ],
  ] as const) {
    expect(res.status, `普通用户完成了 ${what} ⇒ 任何人都能让平台自动在别人的仓库上开工`).toBe(403)
  }

  // ② 另一个 manager：有写权限，但**不是这条规则的 owner**。
  //    拒绝形状是 404 而不是 403——规则 id 的存在性不该从错误码泄露出去。
  const notFound = await req(
    `/api/event-center/response-rules/${rule.id}`,
    { method: 'PUT', body: JSON.stringify(draft(workflowId, { name: 'hijacked' })) },
    bob,
  )
  expect(
    notFound.status,
    '别人的 manager 改掉了这条规则 ⇒ 他可以把自动开工指向任何他想要的工作流',
  ).toBe(404)
  expect((await notFound.json()).code).toBe('event-response-rule-not-found')
  expect(
    (await req(`/api/event-center/response-rules/${rule.id}`, { method: 'DELETE' }, bob)).status,
  ).toBe(404)

  // 规则确实没被动过。
  const intact = await jsonOf<{ items: Array<{ id: string; name: string }> }>(
    await req('/api/event-center/response-rules', undefined, alice),
    'alice re-reads her rule',
  )
  expect(intact.items.find((r) => r.id === rule.id)?.name).not.toBe('hijacked')

  // ③ 持 override-owner 的管理档可以跨 owner 管理——否则上面两条可能只是
  //    「这条规则谁都改不了」，分层就没被证明。
  const admin = await req(`/api/event-center/response-rules/${rule.id}`, {
    method: 'PUT',
    body: JSON.stringify(draft(workflowId, { name: 'retargeted-by-admin' })),
  })
  expect(admin.status, `管理档也跨不过 owner: ${await admin.clone().text()}`).toBe(200)
  expect((await admin.json()).name).toBe('retargeted-by-admin')
})
