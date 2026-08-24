// RFC-319 B17 —— MCP 的 ACL 变更会终止相关的 runtime-test 会话（RES-28）。
//
// runtime-test 会话是一个**活着的模型进程**，它握着这个 MCP 的完整配置：命令行、
// 环境变量、远端地址。把 MCP 从某人眼前收回去，如果不同时掐掉他已经开着的会话，
// 那么「撤销访问」就只是撤销了**列表里的一行**——他手上那个进程照旧连着，
// 照旧能把工具调用打过去。撤权的人不会看到任何异常，被撤权的人也不会。
//
// 判据取自源码单一事实源：
//   `transitionMcpAclRuntimeTestsInTx`（services/mcpRuntimeTestTransitions.ts:103）
//     —— 在 ACL 写入的**同一个事务里**遍历 active 会话；owner 快照判定不再可见
//        ⇒ `endNow(…, 'access-revoked')`；仍可见 ⇒ 只是本回合后阻断
//        （`mcp-config-changed`），因为配置变了但人还在。
//   挂载点：`routes/mcps.ts:621` 的 `afterWriteInTx`。

import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)

const PASSWORD = 'Rfc319McpAclPass!1'

let daemon: DaemonHandle
let sequence = 0
let holdDir: string
let holdFile: string

test.beforeAll(async () => {
  // 前提必须是**确定性**的：撤权那条事务只处理 `status='active'` 的会话
  //（`services/mcpRuntimeTest.ts`），而会话只在某个回合还在飞的时候才是 active。
  // 回合一旦自然收尾，会话转 `ending / session-unusable`，撤权看到的已经不是
  // active、什么也不标 —— 用例随即成为空洞绿或红在 endReason 上。
  holdDir = mkdtempSync(join(tmpdir(), 'aw-rfc319-mcpacl-hold-'))
  holdFile = join(holdDir, 'hold')
  writeFileSync(holdFile, '')
  daemon = await startDaemon({
    stubMode: 'slow',
    extraEnv: { STUB_OPENCODE_HOLD_FILE: holdFile },
  })
})

test.afterAll(async () => {
  releaseHold()
  if (daemon !== undefined) await daemon.stop()
  try {
    rmSync(holdDir, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

/** 放开被扣住的那一回合（stub 见文件消失即返回）。 */
function releaseHold(): void {
  try {
    rmSync(holdFile, { force: true })
  } catch {
    /* best-effort */
  }
}

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
  const username = `rfc319-mcpacl-${++sequence}`
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

test('RFC-319 RES-28: taking an MCP back out of someone view ends the runtime-test session they already have open', async () => {
  // 远端地址指向一个必然连不上的本地端口：这条用例关心的是**会话生命周期**，
  // 不是 MCP 真能不能连通。会话行照样会建出来。
  const mcp = await jsonOf<{ id: string }>(
    await req('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-acl-mcp-${++sequence}`,
        description: 'RFC-319 ACL termination fixture',
        type: 'remote',
        config: { url: 'http://127.0.0.1:1/mcp', timeoutMs: 1_000, oauth: false },
        enabled: true,
      }),
    }),
    'create mcp',
  )

  const acl = await jsonOf<{ aclRevision: number }>(
    await req(`/api/mcps/${mcp.id}/acl`),
    'read acl',
  )
  await jsonOf(
    await req(`/api/mcps/${mcp.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: mcp.id,
        expectedAclRevision: acl.aclRevision,
      }),
    }),
    'publish mcp',
  )

  const guest = await plainUser()
  const detail = await jsonOf<{ operationConfigHash: string }>(
    await req(`/api/mcps/${mcp.id}`, undefined, guest),
    'guest reads mcp',
  )

  // 建会话的回执只有 {sessionId, acceptedTurnId}（实测），状态要另读一次。
  const created = await jsonOf<{ sessionId: string }>(
    await req(
      `/api/mcps/${mcp.id}/runtime-test-sessions`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedMcpConfigHash: detail.operationConfigHash,
          runtimeName: null,
          message: 'rfc319 probe',
          clientCreateId: `01M0RFC319CREATE${sequence.toString().padStart(10, '0')}`,
          clientMessageId: `01M0RFC319MESSAG${sequence.toString().padStart(10, '0')}`,
        }),
      },
      guest,
    ),
    'guest starts a runtime-test session',
  )
  const readSession = async (token?: string): Promise<Response> =>
    req(`/api/mcps/${mcp.id}/runtime-test-sessions/${created.sessionId}`, undefined, token)

  // 等 stub **真的起来**再往下走：它落 `<hold>.started` 之后就一直挂着，
  // 于是这一回合确定性地停在飞行中，而不是靠「跑得够慢」去赌。
  await expect.poll(() => existsSync(`${holdFile}.started`), { timeout: 120_000 }).toBe(true)

  const live = await jsonOf<{ status: string }>(await readSession(), 'read the fresh session')
  expect(live.status, '前提：会话得先是活的，否则「被终止」什么也证明不了').toBe('active')

  // 把 MCP 收回私有。ACL 写入与会话终止在**同一个事务**里，所以读回来就该是终态。
  const afterPublish = await jsonOf<{ aclRevision: number }>(
    await req(`/api/mcps/${mcp.id}/acl`),
    'read acl again',
  )
  await jsonOf(
    await req(`/api/mcps/${mcp.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: mcp.id,
        expectedAclRevision: afterPublish.aclRevision,
      }),
    }),
    'unpublish mcp',
  )

  // 会话行从**管理档**读（被撤权的人现在连这个 MCP 都看不见了，
  // 拿他的令牌去读只会得到 404，那是另一条断言，证明不了会话被终止）。
  const ended = await jsonOf<{ status: string; endReason: string | null }>(
    await readSession(),
    'read the session after revocation',
  )
  expect(
    ended.status,
    '撤销访问之后那个人的 runtime-test 会话还活着 ⇒ 撤的只是列表里的一行，' +
      '他手上那个模型进程照旧握着这个 MCP 的完整配置',
  ).not.toBe('active')
  expect(ended.endReason, '会话是终止了，但没记成 access-revoked ⇒ 事后审计说不清它为什么断').toBe(
    'access-revoked',
  )

  // 被撤权的人现在连这个 MCP 都读不到（与不存在同形）。
  expect((await req(`/api/mcps/${mcp.id}`, undefined, guest)).status).toBe(404)
})
