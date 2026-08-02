// RFC-248 T18 —— /api/repo-groups 六条路由的 HTTP 契约。
//
// 服务层逻辑由 `rfc248-repo-group-service.test.ts` 锁；这里锁的是**线上契约**：
// 状态码、错误码、脱敏、以及权限点声明真的接上了 RFC-247 的路由元数据层。
//
// 其中「POST 带坏 body → 422 repo-group-invalid」这条不是凑数：
// `route-error-code-coverage.test.ts` 有一条守卫要求**每个新路由错误码都被某个
// 测试具名**，否则就是「一条可被客户端触达、却没人说明它行为的失败路径」上线。
// 这条测试就是 `repo-group-invalid` 的具名处。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createApp } from '../src/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let cleanupHarness: (() => void) | undefined
beforeEach(() => {
  cleanupHarness = undefined
})
afterEach(() => {
  cleanupHarness?.()
})

interface Harness {
  db: DbClient
  app: Hono
}

function buildHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-repo-groups-http-'))
  const previousAppHome = process.env.AGENT_WORKFLOW_HOME
  const cleanup = () => {
    rmSync(tmp, { recursive: true, force: true })
    if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previousAppHome
  }
  cleanupHarness = cleanup
  const appHome = join(tmp, 'home')
  try {
    mkdirSync(appHome, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = appHome
    const db = createInMemoryDb(MIGRATIONS)
    const app = createApp({
      token: TOKEN,
      configPath: join(tmp, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 8,
      db,
    })
    return { db, app }
  } catch (error) {
    cleanup()
    cleanupHarness = undefined
    throw error
  }
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

function seedRepo(db: DbClient, slug: string): string {
  const id = ulid()
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: `${slug}00000000`.slice(0, 8),
      url: `https://tok:secret@git.example/${slug}.git`,
      urlRedacted: `https://git.example/${slug}.git`,
      localPath: join(tmpdir(), 'repos', slug),
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return id
}

describe('RFC-248 /api/repo-groups HTTP', () => {
  let h: Harness
  let appRepo: string
  let sdkRepo: string
  beforeEach(() => {
    h = buildHarness()
    appRepo = seedRepo(h.db, 'app')
    sdkRepo = seedRepo(h.db, 'sdk')
  })

  const repoMember = (
    cachedRepoId: string,
    mountPath: string,
    extra: Record<string, unknown> = {},
  ) => ({ kind: 'repo', cachedRepoId, mountPath, ...extra })

  test('GET 空列表', async () => {
    const res = await req(h.app, '/api/repo-groups')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
  })

  test('POST 建组 → 201，且响应里只有脱敏 URL', async () => {
    const res = await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: '全栈',
        members: [repoMember(appRepo, ''), repoMember(sdkRepo, 'vendor/sdk', { readonly: true })],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; flatRepoCount: number; members: unknown[] }
    expect(body.flatRepoCount).toBe(2)
    expect(body.members).toHaveLength(2)
    expect(JSON.stringify(body)).not.toContain('secret')
    expect(JSON.stringify(body)).toContain('https://git.example/app.git')
  })

  test('POST 坏 body → 422 repo-group-invalid', async () => {
    // 这条是 `repo-group-invalid` 的具名处（见文件头注释）。
    const res = await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({ name: '', members: [] }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; error?: { code?: string } }
    expect(body.code ?? body.error?.code).toBe('repo-group-invalid')
  })

  test('POST 完全不是 JSON → 同样 422 repo-group-invalid（不是 500）', async () => {
    const res = await req(h.app, '/api/repo-groups', { method: 'POST', body: 'not json' })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; error?: { code?: string } }
    expect(body.code ?? body.error?.code).toBe('repo-group-invalid')
  })

  test('PUT 坏 body → 422 repo-group-invalid', async () => {
    const created = await (
      await req(h.app, '/api/repo-groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'g', members: [repoMember(appRepo, '')] }),
      })
    ).json()
    const id = (created as { id: string }).id
    const res = await req(h.app, `/api/repo-groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'g' }), // members 缺失
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; error?: { code?: string } }
    expect(body.code ?? body.error?.code).toBe('repo-group-invalid')
  })

  test('非法挂载路径 → 422，错误码来自布局层', async () => {
    const res = await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'g', members: [repoMember(appRepo, '../escape')] }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code?: string; error?: { code?: string } }
    expect(body.code ?? body.error?.code).toBe('mount-path-traversal')
  })

  test('GET /:id 不存在 → 404', async () => {
    const res = await req(h.app, '/api/repo-groups/nope')
    expect(res.status).toBe(404)
  })

  test('GET /:id/layout 给出展平布局', async () => {
    const created = (await (
      await req(h.app, '/api/repo-groups', {
        method: 'POST',
        body: JSON.stringify({
          name: 'g',
          members: [repoMember(appRepo, ''), repoMember(sdkRepo, 'vendor/sdk')],
        }),
      })
    ).json()) as { id: string }
    const res = await req(h.app, `/api/repo-groups/${created.id}/layout`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      totalRepos: number
      maxDepth: number
      repos: Array<{ mountPath: string }>
    }
    expect(body.totalRepos).toBe(2)
    expect(body.maxDepth).toBe(0)
    expect(body.repos.map((r) => r.mountPath)).toEqual(['', 'vendor/sdk'])
  })

  test('PUT 全量替换成员并让 version 自增', async () => {
    const created = (await (
      await req(h.app, '/api/repo-groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'g', members: [repoMember(appRepo, '')] }),
      })
    ).json()) as { id: string; version: number }
    expect(created.version).toBe(1)
    const res = await req(h.app, `/api/repo-groups/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'g',
        description: '改了',
        members: [repoMember(appRepo, ''), repoMember(sdkRepo, 'sdk')],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { version: number; members: unknown[] }
    expect(body.version).toBe(2)
    expect(body.members).toHaveLength(2)
  })

  test('名字冲突 → 409', async () => {
    await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'Dup', members: [repoMember(appRepo, '')] }),
    })
    const res = await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'dup', members: [repoMember(sdkRepo, '')] }),
    })
    expect(res.status).toBe(409)
  })

  test('DELETE 返回归档记忆数、摘除引用数与禁用计划数', async () => {
    const created = (await (
      await req(h.app, '/api/repo-groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'g', members: [repoMember(appRepo, '')] }),
      })
    ).json()) as { id: string }
    const res = await req(h.app, `/api/repo-groups/${created.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      archivedMemories: 0,
      detachedReferences: 0,
      // RFC-248 #10: force 删除时被禁用的定时任务数；这里没有引用它的计划。
      disabledSchedules: 0,
    })
    expect((await (await req(h.app, '/api/repo-groups')).json()) as unknown).toEqual({ items: [] })
  })

  test('删被引用的组 → 409；?force=1 才成功', async () => {
    const inner = (await (
      await req(h.app, '/api/repo-groups', {
        method: 'POST',
        body: JSON.stringify({ name: 'inner', members: [repoMember(sdkRepo, '')] }),
      })
    ).json()) as { id: string }
    await req(h.app, '/api/repo-groups', {
      method: 'POST',
      body: JSON.stringify({
        name: 'outer',
        members: [{ kind: 'group', childGroupId: inner.id, mountPath: 'base' }],
      }),
    })
    const blocked = await req(h.app, `/api/repo-groups/${inner.id}`, { method: 'DELETE' })
    expect(blocked.status).toBe(409)

    const forced = await req(h.app, `/api/repo-groups/${inner.id}?force=1`, { method: 'DELETE' })
    expect(forced.status).toBe(200)
    expect((await forced.json()) as { detachedReferences: number }).toMatchObject({
      detachedReferences: 1,
    })
  })

  test('无认证 → 401（六条路由都在认证门后面）', async () => {
    for (const [method, path] of [
      ['GET', '/api/repo-groups'],
      ['POST', '/api/repo-groups'],
      ['GET', '/api/repo-groups/x'],
      ['GET', '/api/repo-groups/x/layout'],
      ['PUT', '/api/repo-groups/x'],
      ['DELETE', '/api/repo-groups/x'],
    ] as const) {
      const res = await h.app.request(path, { method })
      expect(res.status).toBe(401)
    }
  })
})
