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
//
// fixture 里的「令牌」刻意**不带任何真实供应商前缀**（`glpat-` / `ghp_` …）：
// 仓库的 gitleaks 扫描按前缀 + 熵判定，用真实形状的假令牌会让 Static scans 变红，
// 而那条红与本用例要证的东西毫无关系（实撞，2026-08-24）。这些断言只需要一个
// 足够长、足够独特的字符串，形状不重要。

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
  const secret = 'rfc319-fixture-embedded-credential-9x7Q'
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
