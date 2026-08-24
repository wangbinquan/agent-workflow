// RFC-319 B8 —— 仓库 / 仓库组的治理面（REPO-07/13/23/24）。
//
// 这四条锁的是**删除与凭据**，两件事都属于「错了以后没法从界面上看出来」的类别：
//
//   * 删除挡板：镜像和仓库组都可能被别的东西引用（任务、上层组、计划任务）。
//     挡板漏掉一次，用户的编排会静默少一个仓，而他要到下次启动才发现——那时已经
//     想不起是哪次删除造成的（`gitRepoCache.ts:1598` 原话）。
//   * 凭据脱敏：带 token 的仓库 URL 一旦以明文出现在任何 wire 回执里，那个 token
//     就等于泄露了。最容易漏的不是正常路径，是**失败路径**——克隆失败时把
//     git 的原始 stderr 直接回显出去。
//
// 判据取自源码单一事实源：
//   `deleteCachedRepo` / `CachedRepoHasReferencesError`（gitRepoCache.ts:1593）
//   `deleteRepoGroup` / `RepoGroupHasReferencesError`（repoGroup.ts:44,618）
//   `clipAndRedact` / `redactGitUrl`（repoBatchImport.ts:496-506）

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { initGitRepo, repoRemoteUrl } from './command'
import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let daemon: DaemonHandle
const scratch: string[] = []
let sequence = 0

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

async function req(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
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

function fixtureRepo(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aw-rfc319-${label}-`))
  writeFileSync(join(dir, 'README.md'), `# ${label}\n`, 'utf-8')
  initGitRepo(dir)
  scratch.push(dir)
  return dir
}

interface ImportRow {
  status: string
  message: string | null
  cachedRepoId?: string | null
}

/** 跑一次 batch-import 并等它收敛。返回**整段回执文本** —— 脱敏断言要看全文。 */
async function batchImport(urls: readonly string[]): Promise<{ rows: ImportRow[]; raw: string }> {
  const started = await jsonOf<{ batchId: string; state: string; rows: ImportRow[] }>(
    await req('/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),
    'batch import',
  )
  let raw = ''
  let snapshot = started
  const deadline = Date.now() + 60_000
  while (snapshot.state !== 'completed' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150))
    const res = await req(`/api/cached-repos/imports/${started.batchId}`)
    raw = await res.text()
    expect(res.ok, `batch status: ${res.status} ${raw}`).toBe(true)
    snapshot = JSON.parse(raw) as typeof started
  }
  expect(snapshot.state, `批量导入没有在期限内收敛: ${raw}`).toBe('completed')
  return { rows: snapshot.rows, raw }
}

async function cachedRepoIdFor(url: string): Promise<string> {
  const list = await jsonOf<{ items: Array<{ id: string; urlRedacted: string }> }>(
    await req('/api/cached-repos'),
    'list cached repos',
  )
  // urlRedacted 对无凭据的 file:// URL 就是原样，直接匹配即可。
  const hit = list.items.find((row) => row.urlRedacted === url)
  expect(hit, `导入完成后镜像不在列表里: ${JSON.stringify(list.items)}`).toBeTruthy()
  return hit!.id
}

// ---------------------------------------------------------------------------
// REPO-13 —— 带凭据的 URL 永不以明文出现在 wire 上（重点是失败路径）
// ---------------------------------------------------------------------------

test('RFC-319 REPO-13: a repo URL carrying a token never appears in cleartext on any wire response', async () => {
  // 这个 host 不可解析（RFC 2606 保留了 .invalid），所以克隆必然失败——
  // 失败正是我们要看的那条路径：git 的 stderr 里会带着完整的 URL。
  const secret = 'ghp_rfc319SUPERSECRETtokenVALUE'
  const url = `https://x-access-token:${secret}@example.invalid/org/private-repo.git`

  const { rows, raw } = await batchImport([url])
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status, '这个 URL 本该克隆失败——它成功了说明前提不成立').not.toBe('done')

  // 整段回执逐字节不含 token。断言放在**原始文本**上而不是解析后的某个字段，
  // 是因为泄露最可能发生在没人想到的字段里（message / detail / stderr 摘录）。
  // 变异实证记录：真正被这条断言咬住的是 `rowToWire` 的两次 `redactGitUrl`
  // （repoBatchImport.ts:505-506）——把它们换成原样回显，这里立刻转红。
  // 反过来，把 `clipAndRedact` 的脱敏摘掉**不会**让它红：本机 git 对无法解析的
  // host 报错时并不回显 URL 里的密码段。所以这条用例锁的是**回执字段**的脱敏，
  // 而不是错误消息的脱敏——后者仍只有单测守着，这里写清免得下一个人误读。
  expect(
    raw.includes(secret),
    '导入回执里出现了明文 token ⇒ 用户填进来的凭据顺着 wire 泄露了出去',
  ).toBe(false)
  expect(raw, '脱敏后应留下可辨认的占位，否则用户看不出自己填的是哪个仓').toContain(
    'example.invalid',
  )

  // 列表面同样不许漏。
  const listRaw = await (await req('/api/cached-repos')).text()
  expect(listRaw.includes(secret), '镜像列表回执里出现了明文 token').toBe(false)

  // 批次详情面（第三个读法）也不许漏。
  const importsRaw = raw
  expect(importsRaw.includes('x-access-token:' + secret)).toBe(false)
})

// ---------------------------------------------------------------------------
// REPO-07 —— 删除被引用的镜像：先 409，再强制删除
// ---------------------------------------------------------------------------

test('RFC-319 REPO-07: deleting a mirror that a repo group still points at is refused, and force removes it', async () => {
  const repoDir = fixtureRepo(`mirror-${++sequence}`)
  const url = repoRemoteUrl(repoDir)
  const rows = (await batchImport([url])).rows
  expect(rows[0]!.status, `导入应当成功: ${JSON.stringify(rows)}`).toBe('done')
  const mirrorId = await cachedRepoIdFor(url)

  const group = await jsonOf<{ id: string }>(
    await req('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-holder-${sequence}`,
        description: '',
        nodes: [{ path: '', attachment: { kind: 'repo', repoUrl: url } }],
      }),
    }),
    'create holding group',
  )

  const refused = await req(`/api/cached-repos/${mirrorId}`, { method: 'DELETE' })
  expect(
    refused.status,
    '被仓库组引用的镜像被直接删掉了 ⇒ 用户手工编排的组会静默少一个仓，' +
      '而他要到下次启动才发现（gitRepoCache.ts:1598）',
  ).toBe(409)
  const detail = (await refused.json()) as {
    code: string
    details?: { referencingGroups?: Array<{ id: string }> }
  }
  expect(detail.code).toBe('cached-repo-has-references')
  expect(
    detail.details?.referencingGroups?.map((g) => g.id) ?? [],
    '409 没点名是谁在引用 ⇒ 用户在对话框里看不到该去哪里摘引用',
  ).toContain(group.id)

  // 镜像确实还在（拒绝不是「删了再报错」）。
  const stillThere = await jsonOf<{ items: Array<{ id: string }> }>(
    await req('/api/cached-repos'),
    'list after refusal',
  )
  expect(stillThere.items.map((r) => r.id)).toContain(mirrorId)

  // 强制删除放行——否则上面那条可能只是「这个镜像根本删不掉」。
  const forced = await req(`/api/cached-repos/${mirrorId}?force=1`, { method: 'DELETE' })
  expect(forced.status, `强制删除失败: ${await forced.text()}`).toBe(200)
  const after = await jsonOf<{ items: Array<{ id: string }> }>(
    await req('/api/cached-repos'),
    'list after force',
  )
  expect(after.items.map((r) => r.id)).not.toContain(mirrorId)
})

// ---------------------------------------------------------------------------
// REPO-24 / REPO-23 —— 删除被引用的仓库组：409 → 强制删除并连带清理
// ---------------------------------------------------------------------------

test('RFC-319 REPO-24 & REPO-23: deleting a nested repo group is refused while a parent points at it, and force detaches references and archives its memories', async () => {
  const repoDir = fixtureRepo(`group-${++sequence}`)
  const url = repoRemoteUrl(repoDir)
  expect((await batchImport([url])).rows[0]!.status).toBe('done')

  const child = await jsonOf<{ id: string }>(
    await req('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-child-${sequence}`,
        description: '',
        nodes: [{ path: '', attachment: { kind: 'repo', repoUrl: url } }],
      }),
    }),
    'create child group',
  )
  const parent = await jsonOf<{ id: string }>(
    await req('/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-parent-${sequence}`,
        description: '',
        nodes: [
          { path: '', attachment: null },
          { path: 'vendor', attachment: { kind: 'group', childGroupId: child.id } },
        ],
      }),
    }),
    'create parent group',
  )

  // 组上挂一条记忆——强制删除时它应当被归档，而不是变成指向空 scope 的孤儿。
  await jsonOf(
    await req('/api/memories', {
      method: 'POST',
      body: JSON.stringify({
        scopeType: 'repo_group',
        scopeId: child.id,
        title: `rfc319-group-memory-${sequence}`,
        bodyMd: 'This memory is bound to a group that is about to be deleted.',
      }),
    }),
    'seed group memory',
  )

  const refused = await req(`/api/repo-groups/${child.id}`, { method: 'DELETE' })
  expect(refused.status, '被上层组引用的子组被直接删掉了 ⇒ 父组的编排静默塌了一层').toBe(409)
  const detail = (await refused.json()) as {
    code: string
    details?: { referencingGroups?: Array<{ id: string }> }
  }
  expect(detail.code).toBe('repo-group-has-references')
  expect(detail.details?.referencingGroups?.map((g) => g.id) ?? []).toContain(parent.id)
  expect((await req(`/api/repo-groups/${child.id}`)).status, '被拒的删除却真删了').toBe(200)

  // 强制删除：回执要**如实报出连带影响**。这三个数字是用户判断「我刚才到底
  // 动了多少东西」的唯一依据，报 0 比报错更坏。
  const forced = await jsonOf<{
    archivedMemories: number
    detachedReferences: number
    disabledSchedules: number
  }>(await req(`/api/repo-groups/${child.id}?force=1`, { method: 'DELETE' }), 'force delete group')
  expect(forced.detachedReferences, '强制删除没有报出被摘掉的上层引用').toBeGreaterThanOrEqual(1)
  expect(forced.archivedMemories, '组被删了，挂在它上面的记忆却没被归档 ⇒ 孤儿 scope').toBe(1)

  expect((await req(`/api/repo-groups/${child.id}`)).status).toBe(404)
  // 父组还在，且已经不再指向那个子组。
  const parentAfter = await jsonOf<{ nodes: Array<{ attachment: unknown }> }>(
    await req(`/api/repo-groups/${parent.id}`),
    'read parent after force delete',
  )
  expect(
    JSON.stringify(parentAfter.nodes),
    '父组仍然挂着已被删除的子组 id ⇒ 下次展开会指向空',
  ).not.toContain(child.id)
})

// ---------------------------------------------------------------------------
// REPO-35 —— 代码平台推送凭据：只回尾 4 位，且令牌通道完全够不着
// ---------------------------------------------------------------------------

test('RFC-319 REPO-35: a stored code-host push token is never readable back — only a four-character hint — and no token can reach the account credential routes at all', async () => {
  // 这组路由存的是**用户本人的**代码平台推送令牌。它有两条不容协商的边界：
  //   ① 存进去就再也读不出来。回读面只有 `tokenHint`（最多 4 字符）——
  //      一个能把令牌读回来的「查看」按钮，等于把每个人的代码平台账号
  //      暴露给任何能拿到一次会话的人。
  //   ② 三条路由都是 `tokenAccess: 'never'`。模型 / MCP 通道永远够不着它们:
  //      让 agent 能读或能改用户的推送凭据，是本仓最不该出现的能力。
  const secret = 'glpat-rfc319SUPERSECRETpushTOKEN9x7Q'

  // 个人推送凭据挂在**某一条已配置的代码平台连接**上：generation / digest 必须
  // 与那条连接当前的值逐字相等，否则服务端以 `code-host-push-credential-stale`
  // 拒绝（连接一变，所有人的个人凭据同时作废——这是设计意图，不是巧合）。
  const connection = await jsonOf<{
    connectionGeneration: string
    endpointBindingDigest: string
  }>(
    await req('/api/code-hosts/gitlab', {
      method: 'PUT',
      body: JSON.stringify({
        baseUrl: 'https://gitlab.example.invalid/api/v4',
        token: 'glpat-rfc319PLATFORMlevelTOKEN',
      }),
    }),
    'configure code host',
  )

  const put = await req('/api/account/code-host-push-credentials/gitlab', {
    method: 'PUT',
    body: JSON.stringify({
      token: secret,
      connectionGeneration: connection.connectionGeneration,
      endpointBindingDigest: connection.endpointBindingDigest,
    }),
  })
  expect(put.status, `store push credential: ${await put.clone().text()}`).toBe(200)
  const putRaw = await put.text()
  expect(
    putRaw.includes(secret),
    '写入回执里回显了刚存进去的令牌 ⇒ 凭据在它最该消失的那一刻被送了回来',
  ).toBe(false)

  const listRes = await req('/api/account/code-host-push-credentials')
  const listRaw = await listRes.text()
  expect(listRes.ok, `list credentials: ${listRes.status} ${listRaw}`).toBe(true)
  expect(
    listRaw.includes(secret),
    '列表回执里出现了明文令牌 ⇒ 任何拿到一次会话的人都能读走用户的代码平台账号',
  ).toBe(false)

  const row = (
    JSON.parse(listRaw) as {
      items: Array<{ provider: string; configured: boolean; tokenHint: string | null }>
    }
  ).items.find((item) => item.provider === 'gitlab')
  expect(row?.configured, '存完之后却报告未配置').toBe(true)
  expect(row?.tokenHint ?? '', 'tokenHint 长于 4 字符 ⇒ 回读面泄露的比设计允许的多').toHaveLength(4)
  expect(
    secret.endsWith(row!.tokenHint!),
    'tokenHint 不是令牌的尾 4 位 ⇒ 它认不出自己存的是哪一个',
  ).toBe(true)

  // ② 令牌通道对这组路由有**两道门**，但只有第一道能从 HTTP 面证明：
  //    第一道——`account:self` 不是可授予的 PAT scope（实测 `pat-scope-ungrantable`），
  //      而且令牌也不继承它，所以任何令牌打这三条路由都会先撞权限门。
  //    第二道——三条路由都是 `tokenAccess: 'never'`（纵深防御）。
  //    **变异实证记录**：把三处 `tokenAccess` 全改成 `'allow'`，这条用例仍然绿——
  //      因为权限门先触发。也就是说通道门在 HTTP 面**不可达**，它由路由注册表的
  //      单测守着。这里写清楚，免得下一个人误以为这条用例覆盖了 tokenAccess。
  //    下面断言的因此是**行为**：没有任何令牌能读到或改动这组凭据。
  const ungrantable = await req('/api/auth/pats', {
    method: 'POST',
    body: JSON.stringify({
      name: `rfc319-cred-self-${++sequence}`,
      scopes: ['account:self'],
      purpose: 'general',
    }),
  })
  expect(
    ungrantable.status,
    'account:self 竟然可以授予令牌 ⇒ 账号自服务面对模型通道敞开了第一道口子',
  ).toBe(422)
  expect((await ungrantable.json()).details.ungrantable).toContain('account:self')

  const pat = await jsonOf<{ token: string }>(
    await req('/api/auth/pats', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-cred-${++sequence}`,
        scopes: ['agents:update'],
        purpose: 'general',
      }),
    }),
    'mint pat',
  )
  for (const [what, init] of [
    ['GET', undefined],
    [
      'PUT',
      {
        method: 'PUT',
        body: JSON.stringify({
          token: 'glpat-rfc319REPLACEDbyTOKENchannel',
          connectionGeneration: connection.connectionGeneration,
          endpointBindingDigest: connection.endpointBindingDigest,
        }),
      } as RequestInit,
    ],
    ['DELETE', { method: 'DELETE' } as RequestInit],
  ] as const) {
    const path =
      what === 'GET'
        ? '/api/account/code-host-push-credentials'
        : '/api/account/code-host-push-credentials/gitlab'
    const res = await fetch(`${daemon.baseUrl}${path}`, {
      ...(init ?? {}),
      headers: { Authorization: `Bearer ${pat.token}`, 'Content-Type': 'application/json' },
    })
    expect(res.ok, `令牌通道完成了 ${what} ⇒ 模型 / MCP 能读或能改用户本人的代码平台推送凭据`).toBe(
      false,
    )
  }

  // 令牌那三次调用一次也没改到东西：hint 还是原来那个。
  const afterRaw = await (await req('/api/account/code-host-push-credentials')).text()
  const after = (
    JSON.parse(afterRaw) as { items: Array<{ provider: string; tokenHint: string | null }> }
  ).items.find((item) => item.provider === 'gitlab')
  expect(after?.tokenHint, '令牌通道被拒了，凭据却变了').toBe(row!.tokenHint)
})
