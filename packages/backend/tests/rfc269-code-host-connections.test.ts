// RFC-269 / RFC-277 — 代码平台凭据面与 GitLab TLS 例外的锁。
//
// 这里锁三件事：
//   1. **token 的三形态**：写入明文、存储密封、读取只回尾 4 位。任何一条 GET
//      漏出明文，就等于把管理员的 GitLab 写权限贴在了设置页上。
//   2. **PUT 的保留语义**：只改 base URL 不该要求重录 token；首次配置不给
//      token 必须被拒（否则会存下一个空凭据，然后在真实任务里报 401）。
//   3. **探活四类可区分**：设计门 D7 —— 不可区分的失败让"测试连接"变成安慰剂，
//      管理员看到红叉却不知道该改 token 还是改 base URL 还是找网络。

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import { codeHostConnections } from '../src/db/schema'
import {
  createCodeHostConnectionsService,
  probeCodeHostConnection,
} from '../src/services/codeHost/connections'
import { composeRepositoryTransportCredentials } from '../src/modules/source-control/composition'
import { SQLiteRepositoryTransportCredentialRepository } from '../src/modules/source-control/infrastructure/sqliteRepositoryTransportCredentialRepository'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 7))

// 夹具**不能**长得像真 PAT：`glpat-` / `ghp_` 前缀会命中 gitleaks 的
// gitlab-pat / generic-api-key 规则，让 CI 的密钥扫描红（本地门禁不跑它）。
const SECRET_TOKEN = 'aw-fixture-not-a-real-token-9999' // gitleaks:allow

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>

function codeHostService(db: ReturnType<typeof createInMemoryDb>) {
  const repositoryTransport = composeRepositoryTransportCredentials(
    new SQLiteRepositoryTransportCredentialRepository(db),
    box,
  )
  return createCodeHostConnectionsService({
    secretBox: box,
    repositoryTransport: repositoryTransport.adminConnections,
  })
}

async function harness(opts?: { role?: 'admin' | 'user' | 'manager'; fetchImpl?: FetchStub }) {
  const db = createInMemoryDb(MIGRATIONS)
  const role = opts?.role ?? 'admin'
  const user = await createUser(db, {
    username: `u-${role}`,
    displayName: role,
    role,
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  const app = createApp({
    token: 'a'.repeat(64),
    configPath: '',
    opencodeVersion: null,
    dbVersion: 1,
    db,
    secretBox: box,
    ...(opts?.fetchImpl !== undefined ? { codeHostFetch: opts.fetchImpl } : {}),
  })
  const call = async (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  return { db, app, call, userId: user.id }
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('RFC-269 凭据面 — token 三形态', () => {
  test('PUT 存明文 → 库里是密封值，GET 只回尾 4 位', async () => {
    const { db, call } = await harness()
    const put = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    expect(put.status).toBe(200)

    const row = db
      .select()
      .from(codeHostConnections)
      .where(eq(codeHostConnections.provider, 'gitlab'))
      .all()[0]
    expect(row).toBeDefined()
    expect(row!.tokenEnc).not.toContain(SECRET_TOKEN)
    expect(box.unseal(row!.tokenEnc)).toBe(SECRET_TOKEN)
    expect(row!.tokenHint).toBe('9999')
    expect(row!.rejectUnauthorized).toBe(true)
    expect(row!.repositoryUrlPrefixesJson).toBe('[]')

    const list = await (await call('GET', '/api/code-hosts')).json()
    const gitlab = (list as Array<{ provider: string }>).find((r) => r.provider === 'gitlab')
    expect(gitlab).toMatchObject({
      configured: true,
      baseUrl: 'https://gitlab.corp.example/api/v4',
      repositoryUrlPrefixes: [],
      rejectUnauthorized: true,
      tokenHint: '9999',
    })
  })

  test('明文 token 不出现在任何响应体里（变异断言：整段响应文本搜不到）', async () => {
    const { call } = await harness()
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    for (const [method, path] of [
      ['GET', '/api/code-hosts'],
      ['PUT', '/api/code-hosts/gitlab'],
    ] as const) {
      const res =
        method === 'PUT'
          ? await call('PUT', path, { baseUrl: 'https://gitlab.corp.example/api/v4' })
          : await call('GET', path)
      const text = await res.text()
      expect(text).not.toContain(SECRET_TOKEN)
      expect(text).not.toContain('SUPERSECRET')
    }
  })

  test('两家未配置时也各出现一行（configured:false），前端不必猜', async () => {
    const { call } = await harness()
    const list = (await (await call('GET', '/api/code-hosts')).json()) as Array<{
      provider: string
      configured: boolean
      repositoryUrlPrefixes: string[]
      rejectUnauthorized: boolean
    }>
    expect(list.map((r) => r.provider).sort()).toEqual(['github', 'gitlab'])
    expect(list.every((r) => !r.configured)).toBe(true)
    expect(list.every((r) => r.repositoryUrlPrefixes.length === 0)).toBe(true)
    expect(list.every((r) => r.rejectUnauthorized)).toBe(true)
  })
})

describe('RFC-277 migration — 存量连接安全默认', () => {
  test('0143 给旧行回填 true，并以 CHECK 锁住布尔域与 GitLab-only 边界', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE code_host_connections (
        provider text PRIMARY KEY NOT NULL,
        base_url text NOT NULL,
        token_enc text NOT NULL,
        token_hint text NOT NULL,
        last_test_json text,
        updated_at integer NOT NULL,
        updated_by text
      );
      INSERT INTO code_host_connections
        (provider, base_url, token_enc, token_hint, updated_at)
      VALUES ('gitlab', 'https://gitlab.example/api/v4', 'sealed', '1234', 1);
    `)
    db.exec(readFileSync(resolve(MIGRATIONS, '0143_rfc277_gitlab_tls_verification.sql'), 'utf8'))
    expect(
      db.query('SELECT reject_unauthorized AS rejectUnauthorized FROM code_host_connections').get(),
    ).toEqual({ rejectUnauthorized: 1 })
    expect(() =>
      db
        .query(
          `
        INSERT INTO code_host_connections
          (provider, base_url, reject_unauthorized, token_enc, token_hint, updated_at)
        VALUES ('github', 'https://api.github.com', 2, 'sealed', '5678', 1);
      `,
        )
        .run(),
    ).toThrow()
    expect(() =>
      db
        .query(
          `
        INSERT INTO code_host_connections
          (provider, base_url, reject_unauthorized, token_enc, token_hint, updated_at)
        VALUES ('github', 'https://api.github.com', 0, 'sealed', '5678', 1);
      `,
        )
        .run(),
    ).toThrow()
    db.close()
  })
})

describe('GitLab 仓库 URL 前缀 migration — 存量连接兼容', () => {
  test('0146 给旧行回填空集合，并禁止 GitHub 持有前缀', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE code_host_connections (
        provider text PRIMARY KEY NOT NULL,
        base_url text NOT NULL,
        reject_unauthorized integer NOT NULL DEFAULT 1,
        token_enc text NOT NULL,
        token_hint text NOT NULL,
        last_test_json text,
        updated_at integer NOT NULL,
        updated_by text
      );
      INSERT INTO code_host_connections
        (provider, base_url, token_enc, token_hint, updated_at)
      VALUES ('gitlab', 'https://gitlab.example/api/v4', 'sealed', '1234', 1);
    `)
    db.exec(readFileSync(resolve(MIGRATIONS, '0146_gitlab_repository_url_prefixes.sql'), 'utf8'))
    expect(
      db
        .query(
          'SELECT repository_url_prefixes_json AS repositoryUrlPrefixesJson FROM code_host_connections',
        )
        .get(),
    ).toEqual({ repositoryUrlPrefixesJson: '[]' })
    expect(() =>
      db
        .query(
          `
        INSERT INTO code_host_connections
          (provider, base_url, repository_url_prefixes_json, token_enc, token_hint, updated_at)
        VALUES ('github', 'https://api.github.com', '["https://mirror.example"]', 'sealed', '5678', 1);
      `,
        )
        .run(),
    ).toThrow()
    db.close()
  })
})

describe('RFC-269 凭据面 — PUT 保留 / 清除语义', () => {
  test('省略 token = 保留原值（改 base URL 不必重录）', async () => {
    const { db, call } = await harness()
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    const res = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/gitlab/api/v4',
    })
    expect(res.status).toBe(200)
    const row = db
      .select()
      .from(codeHostConnections)
      .where(eq(codeHostConnections.provider, 'gitlab'))
      .all()[0]
    expect(box.unseal(row!.tokenEnc)).toBe(SECRET_TOKEN)
    expect(row!.baseUrl).toBe('https://gitlab.corp.example/gitlab/api/v4')
  })

  test('首次配置不带 token 被拒 —— 不留下一个必然 401 的空凭据', async () => {
    const { call } = await harness()
    const res = await call('PUT', '/api/code-hosts/github', {
      baseUrl: 'https://api.github.com',
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('code-host-token-required')
  })

  test('GitLab 可保存 false，省略字段更新其它值时保留；resolve 与 wire 同源', async () => {
    const { db, call } = await harness()
    const saved = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
      rejectUnauthorized: false,
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ rejectUnauthorized: false })

    const updated = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/gitlab/api/v4',
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ rejectUnauthorized: false })

    const service = codeHostService(db)
    expect(await service.resolve('gitlab')).toMatchObject({ rejectUnauthorized: false })
    expect((await service.get('gitlab')).rejectUnauthorized).toBe(false)
  })

  test('GitLab 仓库 URL 前缀会归一化、去重并在省略时保留', async () => {
    const { db, call } = await harness()
    const saved = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
      repositoryUrlPrefixes: [
        ' HTTPS://Mirror.Example/platform/ ',
        'https://mirror.example/platform',
        'https://second.example',
      ],
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      repositoryUrlPrefixes: ['https://mirror.example/platform', 'https://second.example'],
    })

    const updated = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/gitlab/api/v4',
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      repositoryUrlPrefixes: ['https://mirror.example/platform', 'https://second.example'],
    })
    expect(
      db
        .select()
        .from(codeHostConnections)
        .where(eq(codeHostConnections.provider, 'gitlab'))
        .all()[0]!.repositoryUrlPrefixesJson,
    ).toBe('["https://mirror.example/platform","https://second.example"]')
    expect(await codeHostService(db).resolve('gitlab')).toMatchObject({
      repositoryUrlPrefixes: ['https://mirror.example/platform', 'https://second.example'],
    })
  })

  test('无效仓库 URL 前缀与 GitHub 非空前缀都明确拒绝', async () => {
    const { call } = await harness()
    const invalid = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
      repositoryUrlPrefixes: ['ssh://git@mirror.example/team'],
    })
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({
      code: 'code-host-repository-url-prefix-invalid',
      details: { index: 0, issue: 'not-http' },
    })

    const github = await call('PUT', '/api/code-hosts/github', {
      baseUrl: 'https://api.github.com',
      token: 'aw-fixture-gh-1234', // gitleaks:allow
      repositoryUrlPrefixes: ['https://mirror.example'],
    })
    expect(github.status).toBe(422)
    expect(await github.json()).toMatchObject({
      code: 'code-host-repository-url-prefixes-unsupported',
    })
  })

  test('GitHub 不能关闭证书校验，不接受一个保存后不生效的假开关', async () => {
    const { call } = await harness()
    const res = await call('PUT', '/api/code-hosts/github', {
      baseUrl: 'https://api.github.com',
      token: 'aw-fixture-gh-1234', // gitleaks:allow
      rejectUnauthorized: false,
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('code-host-tls-option-unsupported')
  })

  test('清除凭据走 DELETE 而不是"传空串"', async () => {
    const { db, call } = await harness()
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    // 空串直接被 schema 拒（min(1)），不会被当成"清除"。
    const emptied = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: '',
    })
    expect(emptied.status).toBe(422)
    expect(
      db.select().from(codeHostConnections).where(eq(codeHostConnections.provider, 'gitlab')).all(),
    ).toHaveLength(1)

    const removed = await call('DELETE', '/api/code-hosts/gitlab')
    expect(removed.status).toBe(200)
    expect(
      db.select().from(codeHostConnections).where(eq(codeHostConnections.provider, 'gitlab')).all(),
    ).toHaveLength(0)
  })

  test('改配置作废上次探活结果 —— 旧绿勾不该盖在新配置上', async () => {
    const { db, call } = await harness()
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    const svc = codeHostService(db)
    await svc.recordTest('gitlab', { ok: true, at: 1, login: 'bot' })
    expect((await svc.get('gitlab')).lastTest?.ok).toBe(true)
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: 'aw-fixture-rotated-0000', // gitleaks:allow
    })
    expect((await svc.get('gitlab')).lastTest).toBeNull()
  })
})

describe('RFC-269 凭据面 — base URL 形态', () => {
  test('GitLab 缺 /api/v4 被拒并点名原因', async () => {
    const { call } = await harness()
    const res = await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example',
      token: SECRET_TOKEN,
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; details?: { issue?: string } }
    expect(body.code).toBe('code-host-base-url-invalid')
    expect(body.details?.issue).toBe('wrong-suffix')
  })

  test('GitLab 子路径部署与 GHES 都被接受', async () => {
    const { call } = await harness()
    expect(
      (
        await call('PUT', '/api/code-hosts/gitlab', {
          baseUrl: 'https://host.example/gitlab/api/v4/',
          token: SECRET_TOKEN,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await call('PUT', '/api/code-hosts/github', {
          baseUrl: 'https://ghes.corp.example/api/v3',
          token: 'aw-fixture-gh-1234', // gitleaks:allow
        })
      ).status,
    ).toBe(200)
  })

  test('未知 provider 404 并点名错误码', async () => {
    const { call } = await harness()
    const res = await call('PUT', '/api/code-hosts/gitea', {
      baseUrl: 'https://x/api/v1',
      token: 't',
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('code-host-provider-unknown')
  })

  test('请求体形状不合法 ⇒ code-host-connection-invalid', async () => {
    const { call } = await harness()
    // baseUrl 缺失 + 多余键：schema 层拒绝，与「base URL 形态不对」是两条不同的错误。
    const res = await call('PUT', '/api/code-hosts/gitlab', { nope: 1 })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('code-host-connection-invalid')
  })
})

describe('RFC-269 凭据面 — 权限', () => {
  test('普通用户读不到也写不了', async () => {
    const { call } = await harness({ role: 'user' })
    expect((await call('GET', '/api/code-hosts')).status).toBe(403)
    expect(
      (await call('PUT', '/api/code-hosts/gitlab', { baseUrl: 'https://h/api/v4', token: 't' }))
        .status,
    ).toBe(403)
  })

  test('manager 也进不了凭据面（凭据是 admin 的 settings 面）', async () => {
    const { call } = await harness({ role: 'manager' })
    expect((await call('GET', '/api/code-hosts')).status).toBe(403)
  })
})

describe('RFC-269 探活 — 四类可区分', () => {
  const base = 'https://gitlab.corp.example/api/v4'

  test('成功回显登录名', async () => {
    const res = await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      fetchImpl: async () => jsonResponse(200, { username: 'aw-bot' }),
    })
    expect(res).toMatchObject({ ok: true, login: 'aw-bot' })
  })

  test('GitLab 仅在显式 false 时传 Bun TLS override，默认保持运行时安全值', async () => {
    const seen: BunFetchRequestInit[] = []
    const capture: FetchStub = async (_url, init) => {
      seen.push(init as BunFetchRequestInit)
      return jsonResponse(200, { username: 'aw-bot' })
    }
    await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      rejectUnauthorized: false,
      fetchImpl: capture,
    })
    await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      fetchImpl: capture,
    })
    expect(seen[0]!.tls).toEqual({ rejectUnauthorized: false })
    expect(seen[1]!.tls).toBeUndefined()
  })

  test('已保存的 false 会进入测试连接请求，而不是只停留在设置页', async () => {
    const seen: BunFetchRequestInit[] = []
    const { call } = await harness({
      fetchImpl: async (_url, init) => {
        seen.push(init as BunFetchRequestInit)
        return jsonResponse(200, { username: 'aw-bot' })
      },
    })
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: base,
      token: SECRET_TOKEN,
      rejectUnauthorized: false,
    })
    const res = await call('POST', '/api/code-hosts/gitlab/test')
    expect(res.status).toBe(200)
    expect(seen[0]!.tls).toEqual({ rejectUnauthorized: false })
  })

  test('401/403 → unauthorized', async () => {
    for (const status of [401, 403]) {
      const res = await probeCodeHostConnection({
        provider: 'gitlab',
        baseUrl: base,
        token: 'bad',
        fetchImpl: async () => jsonResponse(status, { message: 'nope' }),
      })
      expect(res).toMatchObject({ ok: false, code: 'unauthorized' })
    }
  })

  test('404 → not-found（base URL 指到了非 API 根）', async () => {
    const res = await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      fetchImpl: async () => jsonResponse(404, {}),
    })
    expect(res).toMatchObject({ ok: false, code: 'not-found' })
  })

  test('网络错误 → unreachable，且带上原始原因', async () => {
    const res = await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND gitlab.corp.example')
      },
    })
    expect(res).toMatchObject({ ok: false, code: 'unreachable' })
    expect(res.message).toContain('ENOTFOUND')
  })

  test('2xx 但不是身份响应 → bad-response（典型：反代的登录页）', async () => {
    const res = await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: SECRET_TOKEN,
      fetchImpl: async () => new Response('<html>login</html>', { status: 200 }),
    })
    expect(res).toMatchObject({ ok: false, code: 'bad-response' })
  })

  test('GitHub 用 Bearer + login 字段；GitLab 用 PRIVATE-TOKEN + username', async () => {
    const seen: Array<Record<string, string>> = []
    const capture: FetchStub = async (_url, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()))
      return jsonResponse(200, { login: 'gh-bot', username: 'gl-bot' })
    }
    await probeCodeHostConnection({
      provider: 'gitlab',
      baseUrl: base,
      token: 't1',
      fetchImpl: capture,
    })
    await probeCodeHostConnection({
      provider: 'github',
      baseUrl: 'https://api.github.com',
      token: 't2',
      fetchImpl: capture,
    })
    expect(seen[0]!['private-token']).toBe('t1')
    expect(seen[0]!.authorization).toBeUndefined()
    expect(seen[1]!.authorization).toBe('Bearer t2')
    expect(seen[1]!['x-github-api-version']).toBe('2022-11-28')
  })

  test('探活结果只在"测的就是已存值"时回写 —— 草稿值的成功不给坏配置盖绿勾', async () => {
    const { db, call } = await harness({
      fetchImpl: async () => jsonResponse(200, { username: 'aw-bot' }),
    })
    await call('PUT', '/api/code-hosts/gitlab', {
      baseUrl: 'https://gitlab.corp.example/api/v4',
      token: SECRET_TOKEN,
    })
    const svc = codeHostService(db)
    // 只改 TLS 开关的**草稿**也不是已保存配置，成功不能盖绿勾。
    const draft = await call('POST', '/api/code-hosts/gitlab/test', {
      rejectUnauthorized: false,
    })
    expect(((await draft.json()) as { ok: boolean }).ok).toBe(true)
    expect((await svc.get('gitlab')).lastTest).toBeNull()
    // 对着已保存的那套探活才回写
    const stored = await call('POST', '/api/code-hosts/gitlab/test')
    expect(((await stored.json()) as { ok: boolean }).ok).toBe(true)
    expect((await svc.get('gitlab')).lastTest?.ok).toBe(true)
  })

  test('未配置且不带参数的探活给出可读拒绝', async () => {
    const { call } = await harness()
    const res = await call('POST', '/api/code-hosts/github/test')
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('code-host-not-configured')
  })
})

describe('RFC-269 凭据面 — 解封失败按未配置处理', () => {
  test('secret.key 换过导致 unseal 失败 ⇒ resolve 返回 null 而不是空 token', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(codeHostConnections)
      .values({
        provider: 'gitlab',
        baseUrl: 'https://gitlab.corp.example/api/v4',
        // 用另一把钥匙封的密文
        tokenEnc: createSecretBoxFromKey(Buffer.alloc(32, 99)).seal(SECRET_TOKEN),
        tokenHint: '9999',
        updatedAt: Date.now(),
      })
      .run()
    const svc = codeHostService(db)
    expect(await svc.resolve('gitlab')).toBeNull()
    // 但列表仍然显示"已配置"，这样管理员能看到它并重录，而不是面对一个空白页。
    expect((await svc.get('gitlab')).configured).toBe(true)
  })
})
