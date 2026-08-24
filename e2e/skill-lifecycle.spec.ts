// RFC-319 B5 —— 技能 / MCP / 插件的生命周期（RES-07/09/10/13/14/15/29/44）。
//
// 开工审计对账出：`/skills/$id` 这一整页在 e2e 层几乎是空白。唯二涉及技能详情的浏览器
// spec 是 a11y（只跑 axe）与 skill-import（只测 ZIP 导入那条路），而技能真正会被人用坏
// 的地方——组合保存、文件树、版本回滚、删除、可见性——全部零覆盖：
// `skill-save-button` / `skill-new-path` / `skill-panel-files` / `versionRestore` /
// `skill-in-use` 在 `e2e/` 里都是 0 命中。
//
// 这些能力的失败形态都**不响亮**：并发保存静默覆盖同事的改动、删除留下悬空引用、
// 私有化没生效导致技能内容泄露、PAT 读回未脱敏的密钥。所以判据放在合同层
// （编译后的 daemon + 真 SQLite + 真技能目录），而不是只测 UI 能不能点。

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

async function seedSkill(name: string): Promise<string> {
  const created = await req('/api/skills', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: 'RFC-319 fixture',
      bodyMd: '# fixture\n',
    }),
  })
  return (await jsonOf<{ id: string }>(created, `seed skill ${name}`)).id
}

interface SkillContent {
  description: string
  bodyMd: string
  token?: string
}

const contentOf = async (id: string, token?: string): Promise<SkillContent> =>
  jsonOf<SkillContent>(await req(`/api/skills/${id}/content`, undefined, token), 'read content')

// ---------------------------------------------------------------------------
// RES-07 + RES-09 —— 组合保存与并发冲突
// ---------------------------------------------------------------------------

test('RFC-319 RES-07/09: a combined save persists metadata + body, and a stale token is refused', async () => {
  const id = await seedSkill(`rfc319-save-${++sequence}`)
  const first = await contentOf(id)
  expect(first.token, '详情读没有给出 OCC token ⇒ 后面的并发判据无从谈起').toBeTruthy()

  const saved = await req(`/api/skills/${id}/save`, {
    method: 'POST',
    body: JSON.stringify({
      description: 'saved description',
      bodyMd: '# saved body\n',
      expectedToken: first.token,
    }),
  })
  await jsonOf(saved, 'combined save')

  const after = await contentOf(id)
  expect(after.description, '描述没落库').toBe('saved description')
  expect(after.bodyMd, '正文没落库').toBe('# saved body\n')
  expect(after.token, '保存后 token 没有前进 ⇒ OCC 围栏形同虚设').not.toBe(first.token)

  // 拿**旧** token 再存一次：必须被拒。这正是「两个人同时编辑同一技能」的形态——
  // 静默覆盖同事的改动是不可见的数据损失，用户往往几天后才发现内容被回退。
  const stale = await req(`/api/skills/${id}/save`, {
    method: 'POST',
    body: JSON.stringify({
      description: 'written by a stale tab',
      bodyMd: '# stale\n',
      expectedToken: first.token,
    }),
  })
  const staleBody = await stale.text()
  expect(stale.ok, `陈旧 token 的保存竟然成功了：${staleBody}`).toBe(false)
  expect(stale.status).toBe(409)

  // 而且对方的内容原封不动。
  const final = await contentOf(id)
  expect(final.description, '被拒绝的保存仍然改掉了内容').toBe('saved description')
})

// ---------------------------------------------------------------------------
// RES-10 —— 文件树：写入 / 读回 / 列出 / 删除
// ---------------------------------------------------------------------------

test('RFC-319 RES-10: skill files are written, listed, read back and deleted through the real skill directory', async () => {
  const id = await seedSkill(`rfc319-files-${++sequence}`)
  const path = 'references/notes.md'

  const write = await req(`/api/skills/${id}/file?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: JSON.stringify({ content: '# notes\nfirst revision\n' }),
  })
  await jsonOf(write, 'write skill file')

  const listed = await jsonOf<{ files?: unknown[]; nodes?: unknown[] }>(
    await req(`/api/skills/${id}/files`),
    'list skill files',
  )
  const flat = JSON.stringify(listed)
  expect(flat, '刚写进去的文件没有出现在文件树里').toContain('notes.md')

  const read = await jsonOf<{ content: string }>(
    await req(`/api/skills/${id}/file?path=${encodeURIComponent(path)}`),
    'read skill file',
  )
  expect(read.content, '读回的内容与写入的不一致 ⇒ 技能目录不是单一事实源').toBe(
    '# notes\nfirst revision\n',
  )

  const removed = await req(`/api/skills/${id}/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
  expect(removed.ok, `删除技能文件失败：${await removed.text()}`).toBe(true)
  const afterDelete = await req(`/api/skills/${id}/file?path=${encodeURIComponent(path)}`)
  expect(afterDelete.status, '删掉的文件还读得到').not.toBe(200)
})

// ---------------------------------------------------------------------------
// RES-13 —— 回滚到历史版本
// ---------------------------------------------------------------------------

test('RFC-319 RES-13: restoring an earlier version rewrites the content and keeps the version line moving forward', async () => {
  const id = await seedSkill(`rfc319-restore-${++sequence}`)
  const v1 = await contentOf(id)

  const save = async (body: string, token: string | undefined): Promise<void> => {
    await jsonOf(
      await req(`/api/skills/${id}/save`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: body, expectedToken: token }),
      }),
      `save ${body.trim()}`,
    )
  }
  await save('# version two\n', v1.token)
  const v2 = await contentOf(id)
  await save('# version three\n', v2.token)
  const v3 = await contentOf(id)
  expect(v3.bodyMd).toBe('# version three\n')

  // 版本行的序号字段是 `versionIndex`（skillVersion.ts:181），不是 version/contentVersion。
  const versions = await jsonOf<Array<{ versionIndex: number }>>(
    await req(`/api/skills/${id}/versions`),
    'list versions',
  )
  expect(versions.length, '版本列表为空 ⇒ 回滚无从谈起').toBeGreaterThan(1)
  // 取最早的那一版：它的正文一定不是当前的「version three」。
  const target = versions
    .map((v) => v.versionIndex)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)[0]!
  expect(target, '版本列表里没有可用的 versionIndex').toBeGreaterThan(0)

  const restored = await req(`/api/skills/${id}/versions/${target}/restore`, {
    method: 'POST',
    body: JSON.stringify({ expectedToken: v3.token }),
  })
  await jsonOf(restored, 'restore version')

  const afterRestore = await contentOf(id)
  expect(afterRestore.bodyMd, '回滚之后正文没有变回那一版 ⇒ 「回滚」只是改了个指针').not.toBe(
    '# version three\n',
  )
  expect(afterRestore.token, '回滚没有推进 OCC token ⇒ 别的标签页手里的旧 token 仍然可写').not.toBe(
    v3.token,
  )
})

// ---------------------------------------------------------------------------
// RES-14 + RES-29 —— 删除的两道闸：逐字确认 + 被引用时拒绝
// ---------------------------------------------------------------------------

test('RFC-319 RES-14/29: deleting a referenced skill / mcp / plugin is refused, and delete needs the typed name', async () => {
  const skillId = await seedSkill(`rfc319-referenced-${++sequence}`)
  const mcp = await jsonOf<{ id: string }>(
    await req('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-referenced-mcp-${++sequence}`,
        description: 'referenced fixture',
        type: 'remote',
        config: { url: 'http://127.0.0.1:1/mcp', oauth: false },
        enabled: true,
      }),
    }),
    'seed mcp',
  )
  const plugin = await jsonOf<{ id: string }>(
    await req('/api/plugins', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-referenced-plugin-${++sequence}`,
        spec: daemon.stubOpencode,
        description: 'referenced fixture',
        enabled: true,
      }),
    }),
    'seed plugin',
  )

  // 一个代理同时引用三者。
  await jsonOf(
    await req('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-referencing-agent-${++sequence}`,
        description: 'holds references',
        outputs: ['answer'],
        readonly: true,
        bodyMd: 'body',
        skills: [{ kind: 'managed', skillId }],
        mcp: [mcp.id],
        plugins: [plugin.id],
      }),
    }),
    'seed referencing agent',
  )

  // 三者都不许被删掉——否则代理会留下悬空引用，直到下次真跑任务才崩，
  // 而那时排查成本极高且完全静默。
  const skillContent = await contentOf(skillId)
  const refusedSkill = await req(`/api/skills/${skillId}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: 'irrelevant',
      expectedToken: skillContent.token,
      expectedAclRevision: 0,
    }),
  })
  expect(refusedSkill.ok, '被代理引用的技能仍然被删掉了').toBe(false)

  const refusedMcp = await req(`/api/mcps/${mcp.id}`, { method: 'DELETE' })
  expect(refusedMcp.ok, '被代理引用的 MCP 仍然被删掉了').toBe(false)
  const refusedPlugin = await req(`/api/plugins/${plugin.id}`, { method: 'DELETE' })
  expect(refusedPlugin.ok, '被代理引用的插件仍然被删掉了').toBe(false)

  // 一个**没有**被引用的技能：删除仍然要求逐字输入名字。
  const loneName = `rfc319-lonely-${++sequence}`
  const loneId = await seedSkill(loneName)
  const loneContent = await contentOf(loneId)
  const wrongConfirm = await req(`/api/skills/${loneId}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: `${loneName}-typo`,
      expectedToken: loneContent.token,
      expectedAclRevision: 0,
    }),
  })
  expect(wrongConfirm.ok, '确认串写错也照删 ⇒ 防误删护栏形同虚设').toBe(false)

  const ok = await req(`/api/skills/${loneId}`, {
    method: 'DELETE',
    body: JSON.stringify({
      confirm: loneName,
      expectedToken: loneContent.token,
      expectedAclRevision: 0,
    }),
  })
  expect(ok.ok, `逐字确认之后仍然删不掉：${await ok.text()}`).toBe(true)
  expect((await req(`/api/skills/${loneId}`)).status, '删了却还读得到').toBe(404)
})

// ---------------------------------------------------------------------------
// RES-15 —— 技能可见性：私有化后陌生人不可见，且与不存在同形
// ---------------------------------------------------------------------------

test('RFC-319 RES-15: a private skill is invisible to strangers and its detail is indistinguishable from absent', async () => {
  const name = `rfc319-private-${++sequence}`
  const id = await seedSkill(name)

  const stranger = await req('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      username: `rfc319-skill-stranger-${sequence}`,
      displayName: 'Stranger',
      email: `rfc319-skill-stranger-${sequence}@example.com`,
      role: 'user',
      password: 'Rfc319StrangerPass!1',
    }),
  })
  await jsonOf(stranger, 'seed stranger')
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `rfc319-skill-stranger-${sequence}`,
        password: 'Rfc319StrangerPass!1',
      }),
    }),
    'stranger login',
  )

  // 先公开：陌生人看得见。没有这一步，「看不见」可能只是因为他本来就没权限读技能。
  await jsonOf(
    await req(`/api/skills/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: id,
        expectedAclRevision: 0,
      }),
    }),
    'make public',
  )
  expect(
    (await req(`/api/skills/${id}`, undefined, sessionToken)).status,
    '公开之后陌生人仍然读不到 ⇒ 后面的「私有化生效」证明不了任何东西',
  ).toBe(200)

  // 再私有：列表里消失，详情与不存在同形。
  await jsonOf(
    await req(`/api/skills/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: id,
        expectedAclRevision: 1,
      }),
    }),
    'make private',
  )
  const list = await jsonOf<Array<{ id: string }>>(
    await req('/api/skills', undefined, sessionToken),
    'stranger list',
  )
  expect(
    list.some((row) => row.id === id),
    '私有化之后技能仍然出现在陌生人的列表里',
  ).toBe(false)

  const hidden = await req(`/api/skills/${id}`, undefined, sessionToken)
  const absent = await req('/api/skills/01JZZZZZZZZZZZZZZZZZZZZZZZ', undefined, sessionToken)
  expect(hidden.status, '私有资源的详情与「不存在」状态码不同 ⇒ 存在性泄露').toBe(absent.status)
  expect(await hidden.text(), '私有资源的详情响应体与「不存在」不同形').toBe(await absent.text())
})

// ---------------------------------------------------------------------------
// RES-44 —— PAT 读取时 MCP / 插件的机密必须脱敏
// ---------------------------------------------------------------------------

test('RFC-319 RES-44: reading an MCP through a PAT masks its secrets while a session still sees them', async () => {
  const secret = 'rfc319-super-secret-value'
  const mcp = await jsonOf<{ id: string }>(
    await req('/api/mcps', {
      method: 'POST',
      body: JSON.stringify({
        name: `rfc319-secret-mcp-${++sequence}`,
        description: 'secret fixture',
        type: 'remote',
        config: { url: 'http://127.0.0.1:1/mcp', oauth: false, headers: { 'x-api-key': secret } },
        enabled: true,
      }),
    }),
    'seed secret mcp',
  )

  const username = `rfc319-pat-reader-${sequence}`
  await jsonOf(
    await req('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        username,
        displayName: 'PAT reader',
        email: `${username}@example.com`,
        role: 'admin',
        password: 'Rfc319PatReader!1',
      }),
    }),
    'seed pat reader',
  )
  const { sessionToken } = await jsonOf<{ sessionToken: string }>(
    await fetch(`${daemon.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'Rfc319PatReader!1' }),
    }),
    'pat reader login',
  )
  const minted = await jsonOf<{ token: string; pat: { id: string } }>(
    await fetch(`${daemon.baseUrl}/api/auth/pats`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'rfc319-secret-reader',
        scopes: ['mcps:update'],
        purpose: 'general',
      }),
    }),
    'mint reading pat',
  )

  // 会话读得到明文（这是对照——否则「令牌读不到」可能只是因为谁都读不到）。
  const viaSession = await (await req(`/api/mcps/${mcp.id}`, undefined, sessionToken)).text()
  expect(viaSession, '会话都读不到明文 ⇒ 这条对照失效').toContain(secret)

  // 令牌读到的必须是脱敏后的。
  const viaPat = await (await req(`/api/mcps/${mcp.id}`, undefined, minted.token)).text()
  expect(
    viaPat,
    '通过 PAT 读回了 MCP 的明文密钥。一个被泄露的 API 令牌因此等于泄露了它能看到的' +
      '每一个上游凭据——而令牌本来就是最容易被贴进脚本、日志、CI 变量里的那种凭据',
  ).not.toContain(secret)
})
