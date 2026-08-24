// RFC-319 B11 —— 把自己锁在门外之后的本地找回（OPS-022）。
//
// 这条能力的存在前提是一个具体事故：管理员在设置页关掉了密码登录，而唯一的
// OIDC 身份源随后不可用（配置写错、IdP 下线、证书过期）。此时**没有任何 HTTP
// 路径**能把门打开——所有业务端点都要先过登录，而登录已经关了。RFC-221 为此
// 留了一条本地通道：拿着机器上的 `agent-workflow` 二进制直接改策略表。
//
// 所以这条用例必须走**真实形态**才有意义：
//   ① 真的把密码登录关掉（关到登录端点 403 为止）；
//   ② 停掉 daemon；
//   ③ 用**编译后的二进制**、对着**同一个 home** 跑 `auth password-login enable`；
//   ④ 重启 daemon，验证真的能登进去了。
// 少任何一步都证明不了「锁死之后能自救」——尤其是③，用进程内函数调一下
// 只能证明那个函数存在，证明不了发行出去的二进制里有这个子命令。
//
// 判据取自 `cli/auth.ts:26-53`（只认 `password-login <status|enable>`，
// 并明写「daemon token remains retired」——找回密码登录**不**等于把一次性
// 引导票放回来，那是两件事）。

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'

import { runCommandResult } from './command'
import { defaultBinaryPath, startDaemon, type DaemonHandle } from './harness'

test.setTimeout(180_000)

const PASSWORD = 'Rfc319LockoutPass!1'

/**
 * 跑发行二进制的一个子命令。走 `e2e/command.ts` 的受限边界而不是在 spec 里自己
 * 起进程：所有 e2e 子进程都必须带上那份硬超时，否则一个挂住的探针会把整个 shard
 * 卡死。`root-test-entrypoint.test.ts` 对每份 spec 源码做纯子串检查来强制这条。
 */
function runCli(home: string, args: string[]): { out: string; code: number } {
  const res = runCommandResult(defaultBinaryPath(), args, {
    env: { AGENT_WORKFLOW_HOME: home },
  })
  return { out: res.output, code: res.status }
}

test('RFC-319 OPS-022: after password sign-in is switched off, the shipped binary can re-open it locally against the same home', async () => {
  // home 必须由**本用例**持有：`startDaemon()` 不带 home 时，`stop()` 会把它
  // 连同数据库一起删掉，随后 CLI 只会在原地新建一个空库——那样这条用例会
  // 「通过」得毫无意义（实撞：status 报 `bootstrap: required`）。
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc319-lockout-'))
  const first: DaemonHandle = await startDaemon({ home })
  const username = `rfc319-lockout-${Date.now().toString(36)}`
  let opened = false

  try {
    const auth = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }
    const login = async (base: string): Promise<Response> =>
      fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: PASSWORD }),
      })

    const seed = await fetch(`${first.baseUrl}/api/users`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        username,
        displayName: username,
        email: `${username}@example.com`,
        role: 'user',
        password: PASSWORD,
      }),
    })
    expect(seed.ok, `seed user: ${seed.status} ${await seed.text()}`).toBe(true)
    expect((await login(first.baseUrl)).status, '前提：关闭之前能登').toBe(200)

    // 关闭密码登录需要先有一个 enabled 的身份源（否则服务端拒绝，见 IAM-12）。
    // 这里正好复现事故的真实前提：**身份源存在但不可用**——它指向一个不可解析的
    // 主机，所以关掉密码登录之后，门就真的没了。
    const idp = await fetch(`${first.baseUrl}/api/oidc/providers`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        slug: 'rfc319-dead-idp',
        displayName: 'RFC-319 unreachable IdP',
        issuerUrl: 'https://idp.example.invalid',
        clientId: 'rfc319-client',
        clientSecret: 'rfc319-secret',
        scopes: 'openid profile email',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        userinfoEndpoint: null,
        userinfoRequestStyle: 'get_bearer',
        jwksUri: null,
        trustEmailVerified: true,
        usernameClaim: null,
        emailClaim: null,
        subjectClaim: null,
      }),
    })
    expect(idp.ok, `create idp: ${idp.status} ${await idp.text()}`).toBe(true)

    const off = await fetch(`${first.baseUrl}/api/oidc/login-policy`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ passwordLoginEnabled: false }),
    })
    expect(off.ok, `disable password login: ${off.status} ${await off.text()}`).toBe(true)
    expect((await login(first.baseUrl)).status, '前提：密码登录已经真的关上了').toBe(403)

    await first.stop()

    // ③ 二进制 + 同一个 home。先读状态（这是管理员事故现场的第一个动作）。
    const status = runCli(home, ['auth', 'password-login', 'status'])
    expect(status.code, `auth status 退出码非 0: ${status.out}`).toBe(0)
    expect(
      status.out,
      'status 没有如实报出「已关闭」⇒ 事故现场的第一个动作就给不出正确信息',
    ).toContain('password login: disabled')

    const enable = runCli(home, ['auth', 'password-login', 'enable'])
    expect(enable.code, `auth enable 退出码非 0: ${enable.out}`).toBe(0)
    expect(enable.out).toContain('password login enabled')
    // 找回登录 ≠ 把一次性引导票放回来。这是 RFC-221 刻意写在输出里的一句话，
    // 它同时是一条安全承诺：本地通道只开门，不发新的最高权限凭据。
    expect(
      enable.out,
      '本地找回顺手把引导票也放回来了 ⇒ 一条本该只开门的通道变成了权限提升通道',
    ).toContain('daemon token remains retired')

    expect(runCli(home, ['auth', 'password-login', 'status']).out).toContain(
      'password login: enabled',
    )
    // 子命令拼错时必须给可用的用法提示并以非 0 退出，而不是静默什么也不做。
    const misuse = runCli(home, ['auth', 'password-login', 'disable'])
    expect(misuse.code).not.toBe(0)
    expect(misuse.out).toContain('usage: agent-workflow auth password-login <status|enable>')

    // ④ 重启同一个 home：门真的开了。
    const second = await startDaemon({ home })
    opened = true
    try {
      expect(
        (await login(second.baseUrl)).status,
        'CLI 报告已开启，但重启之后仍然登不进去 ⇒ 找回通道只改了个显示值',
      ).toBe(200)
    } finally {
      await second.stop()
    }
  } finally {
    if (!opened) {
      try {
        await first.stop()
      } catch {
        /* 已经停过 */
      }
    }
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// OPS-020 / CFG-31 —— 备份 → 改数据 → 恢复 → 重启：完整往返
// ---------------------------------------------------------------------------

test('RFC-319 OPS-020 & CFG-31: a backup taken now can be armed and applied on the next boot, and an armed restore can be called off before it fires', async () => {
  // 备份唯一的用途是**被恢复**。只测「备份文件生成出来了」等于什么都没测——
  // 一个内容错误、缺表、或者根本装不回去的 tarball 同样能让那条断言通过。
  // 所以这条用例走完整往返，并且刻意在中间制造一处**明确的数据差异**，
  // 让「回到备份时点」这件事有一个可判定的观察点。
  const home = mkdtempSync(join(tmpdir(), 'aw-rfc319-restore-'))
  const first = await startDaemon({ home })
  let handedOff = false

  try {
    const auth = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }
    const agentNames = async (base: string, token: string): Promise<string[]> => {
      const res = await fetch(`${base}/api/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.ok, `list agents: ${res.status} ${await res.clone().text()}`).toBe(true)
      const body = (await res.json()) as
        | { items?: Array<{ name: string }> }
        | Array<{ name: string }>
      const items = Array.isArray(body) ? body : (body.items ?? [])
      return items.map((a) => a.name)
    }

    const before = `rfc319-before-backup-${Date.now().toString(36)}`
    const after = `${before}-after`
    const makeAgent = async (name: string): Promise<void> => {
      const res = await fetch(`${first.baseUrl}/api/agents`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          name,
          description: 'RFC-319 restore fixture',
          outputs: ['answer'],
          readonly: true,
          bodyMd: 'body',
        }),
      })
      expect(res.ok, `create agent ${name}: ${res.status} ${await res.text()}`).toBe(true)
    }

    await makeAgent(before)
    const backup = await fetch(`${first.baseUrl}/api/backup`, { method: 'POST', headers: auth })
    expect(backup.ok, `create backup: ${backup.status} ${await backup.clone().text()}`).toBe(true)
    const { path: backupPath, sizeBytes } = (await backup.json()) as {
      path: string
      sizeBytes: number
    }
    expect(sizeBytes, '备份产物是空的').toBeGreaterThan(0)

    // 备份之后再造一条数据。恢复生效后它必须消失，而备份前那条必须还在——
    // 两个方向都断言，才排除「恢复其实什么都没做」和「恢复把库清空了」。
    await makeAgent(after)
    expect(await agentNames(first.baseUrl, first.token)).toContain(after)

    const armWith = async (): Promise<Response> => {
      const form = new FormData()
      form.set('file', new Blob([readFileSync(backupPath)]), 'backup.tar.gz')
      return fetch(`${first.baseUrl}/api/restore`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${first.token}` },
        body: form,
      })
    }

    // ① 装填 → 待生效；② 取消 → 不再待生效。取消这条是 CFG-31 点名的能力：
    //    「装填了恢复」和「已经恢复了」之间必须留一个可反悔的窗口。
    const staged = await armWith()
    expect(staged.ok, `arm restore: ${staged.status} ${await staged.clone().text()}`).toBe(true)
    expect((await staged.json()).status).toBe('staged')
    const pending = await fetch(`${first.baseUrl}/api/restore/pending`, { headers: auth })
    expect(((await pending.json()) as { pending: unknown }).pending).toBeTruthy()

    const disarm = await fetch(`${first.baseUrl}/api/restore/pending`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(disarm.ok).toBe(true)
    expect(((await disarm.json()) as { cleared: boolean }).cleared).toBe(true)
    const afterDisarm = await fetch(`${first.baseUrl}/api/restore/pending`, { headers: auth })
    expect(
      ((await afterDisarm.json()) as { pending: unknown }).pending,
      '取消之后仍然待生效 ⇒ 用户点了「不恢复了」，下次重启还是会把库换掉',
    ).toBeFalsy()

    // ③ 重新装填，然后重启 —— 交换发生在数据库关闭之后，所以必须真的重启。
    const rearmed = await armWith()
    expect(rearmed.ok, `re-arm restore: ${rearmed.status} ${await rearmed.clone().text()}`).toBe(
      true,
    )
    await first.stop()
    handedOff = true

    const second = await startDaemon({ home })
    try {
      const names = await agentNames(second.baseUrl, second.token)
      expect(names, '恢复之后备份时点的数据不见了 ⇒ 恢复把库换成了别的东西').toContain(before)
      expect(
        names,
        '恢复之后备份之后新增的数据还在 ⇒ 恢复根本没生效，而用户以为回滚了',
      ).not.toContain(after)
      expect(
        (
          (await (
            await fetch(`${second.baseUrl}/api/restore/pending`, {
              headers: { Authorization: `Bearer ${second.token}` },
            })
          ).json()) as { pending: unknown }
        ).pending,
        '恢复生效后待生效标记没清 ⇒ 每次重启都会再恢复一遍',
      ).toBeFalsy()
    } finally {
      await second.stop()
    }
  } finally {
    if (!handedOff) {
      try {
        await first.stop()
      } catch {
        /* 已经停过 */
      }
    }
    rmSync(home, { recursive: true, force: true })
  }
})
