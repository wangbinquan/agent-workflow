// RFC-310 —— 「创建对话框造的载荷，真实后端收不收」的端到端契约。
//
// 为什么这条测试存在（两次用户实报事故的共同根因）：
//
//   1. `no route for /api/code/development-adapters` —— 前端端点前缀写错，
//      `/code/config/adapters` 整页 404；
//   2. `adapter content failed schema: Invalid literal value, expected 1` ——
//      前端只 POST `{name, purpose}`，而 adapter 在 create 期就 strict parse。
//
// 两次都穿透了全部本地门禁与 CI。原因不是缺测试，而是**测的两端各自为政**：
// 前端页面测试 mock 掉 fetch、自己写 URL 与 body，写错了照样绿；后端契约测试
// 自己拼载荷，也照样绿。缺的是把两端接起来的那根线。
//
// 这条测试就是那根线：载荷取自 shared 的共用契约
// （`buildDevelopmentConfigCreateBody`——创建对话框调的**同一个函数**），
// 端点取自同一份 `DEVELOPMENT_CONFIG_API_BASE`，打的是 createApp 起的真实 HTTP
// app（真 DB、真路由、真 Zod）。前端改了载荷形状而后端没跟上（或反过来），
// 这里立刻红。
//
// 断言不止于 201：建完之后用户在详情页会**立刻点发布**，所以发布这一下也照打。
// 各族在此处的正确行为不同，如实分档而不是一刀切：
//
//   · adapters —— create 期就 strict parse，最小内容必须**两道都过**，发布 200；
//   · 其余三族 —— 以空草稿起步（内容在详情页深编），发布必须是**具名 422**
//     告诉用户缺什么，不能是 500。employees 此前正是 500 internal-error
//     （裸 `.parse` 抛 ZodError 被兜底），本测试是那条修复的回归锁。

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import {
  ADAPTER_PURPOSES,
  DEVELOPMENT_CONFIG_API_BASE,
  DEVELOPMENT_CONFIG_KINDS,
  buildDevelopmentConfigCreateBody,
  type DevelopmentConfigKind,
} from '@agent-workflow/shared'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { AGENT_CAPABILITY_IDS } from '../src/modules/development-automation/domain/capabilityDefinition'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'c'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  token: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'admin-310-create',
    displayName: 'Admin',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: admin.id })
  return { db, app, token }
}

async function reqAs(
  h: Harness,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${h.token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await h.app.request(path, { ...init, headers })
  const text = await res.text()
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) }
}

/** 创建对话框在各族里交出的那份输入（模板选 capability、adapter 填可执行引用）。 */
function dialogInput(
  kind: DevelopmentConfigKind,
): Parameters<typeof buildDevelopmentConfigCreateBody>[0] {
  return {
    kind,
    name: `contract-${kind}`,
    capabilityId: AGENT_CAPABILITY_IDS[1],
    purpose: ADAPTER_PURPOSES[0],
    executableRef: 'adapters/acquire.ts',
  }
}

describe('RFC-310 — every config create dialog posts something the real backend accepts', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  /**
   * 建完立刻点发布的预期结果。adapter 的最小内容是完整的（create 期 strict
   * parse），发得出去；另外三族以空草稿起步，必须收到**具名** 422。
   */
  const PUBLISH_EXPECTATION: Record<
    DevelopmentConfigKind,
    { status: number; code: string | null }
  > = {
    adapters: { status: 200, code: null },
    employees: { status: 422, code: 'digital-employee-draft-invalid' },
    'action-templates': { status: 422, code: 'action-template-draft-invalid' },
    'verification-profiles': { status: 422, code: 'verification-profile-draft-invalid' },
  }

  for (const kind of DEVELOPMENT_CONFIG_KINDS) {
    test(`${kind}: the dialog's payload creates, reads back, and publish answers in kind`, async () => {
      const base = DEVELOPMENT_CONFIG_API_BASE[kind]
      const created = await reqAs(h, base, {
        method: 'POST',
        body: JSON.stringify(buildDevelopmentConfigCreateBody(dialogInput(kind))),
      })
      // 404 在这里的含义是"端点前缀写错了"（事故 1 的形态），与 422
      // "载荷不合法"（事故 2 的形态）区分开报，红的时候一眼看出是哪种。
      expect({ kind, status: created.status }).toEqual({ kind, status: 201 })
      const id = (created.body as { id: string }).id
      expect(typeof id).toBe('string')

      const read = await reqAs(h, `${base}/${id}`)
      expect({ kind, status: read.status }).toEqual({ kind, status: 200 })

      const expected = PUBLISH_EXPECTATION[kind]
      const published = await reqAs(h, `${base}/${id}/publish`, { method: 'POST' })
      const code = (published.body as { code?: string } | null)?.code ?? null
      expect({
        kind,
        status: published.status,
        code: expected.code === null ? null : code,
      }).toEqual({ kind, status: expected.status, code: expected.code })
      // 5xx 在这条路径上永远是 bug：用户点的是一个正常按钮，得到的必须是
      // "缺什么"，不是"崩了"。
      expect(published.status).toBeLessThan(500)
    })
  }

  test('adapters: every purpose in the closed set is creatable (not just the default)', async () => {
    // 创建对话框让用户选 purpose，而必需 operations 逐 purpose 不同——只测
    // 默认那个等于放过另外两个。
    for (const purpose of ADAPTER_PURPOSES) {
      const res = await reqAs(h, DEVELOPMENT_CONFIG_API_BASE.adapters, {
        method: 'POST',
        body: JSON.stringify(
          buildDevelopmentConfigCreateBody({
            kind: 'adapters',
            name: `contract-adapter-${purpose}`,
            purpose,
            executableRef: `adapters/${purpose}.ts`,
          }),
        ),
      })
      expect({ purpose, status: res.status }).toEqual({ purpose, status: 201 })
    }
  })

  test('automation policies: an invalid draft is refused by name at publish, never 500', async () => {
    // policy 不在统一列表页（它有自己的 rule builder 页），但 publish 路径同形：
    // revise 对草稿完全宽容 ⇒ 用户可以存下一份不合法 JSON，再点发布。此前这里
    // 也是裸 `.parse`，回 500 internal-error。
    const base = '/api/code/automation-policies'
    const created = await reqAs(h, base, {
      method: 'POST',
      body: JSON.stringify({ name: 'invalid-draft-policy', draft: { schemaVersion: 1 } }),
    })
    expect(created.status).toBe(201)
    const id = (created.body as { id: string }).id

    const published = await reqAs(h, `${base}/${id}/publish`, { method: 'POST' })
    expect(published.status).toBe(422)
    expect((published.body as { code: string }).code).toBe('automation-policy-draft-invalid')
  })

  test('the api bases are real mounts (an unmounted prefix must 404, which is what shipped)', async () => {
    // 事故 1 的回归锁：把 adapter 前缀写成 `/api/code/...` 时的真实响应。
    // 同时证明上面的 201 不是因为"什么路径都收"。
    const res = await reqAs(h, '/api/code/development-adapters', {
      method: 'POST',
      body: JSON.stringify({ name: 'wrong-prefix' }),
    })
    expect(res.status).toBe(404)
  })
})
