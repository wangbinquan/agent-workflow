// RFC-204 — the P0-a red anchor plus the reuse contract that replaces it.
//
// The vulnerability (permission audit 2026-07-15, P0-3): `cached_repos` is a
// GLOBAL shared pool with no owner column, and `repos:read` lives in the user
// baseline — so `rowToCached` emitting the original `url` handed every logged-in
// user (and every narrowly-scoped PAT) the credentials embedded in everyone
// else's private-repo URLs. Private repos are reached by putting a token in the
// URL, so this was a straight cross-user credential disclosure.
//
// Removing the field alone would have broken "pick a recent repo" in the
// launcher, which is why it sat unfixed: the picker used the plaintext URL as
// its option value. Reuse now travels as `cachedRepoId` and the daemon resolves
// the real URL itself — hence the second block.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { CachedRepoSchema } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { listCachedRepos } from '../src/services/gitRepoCache'
import { normalizeStartTaskRepos } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TOKEN = 'ghp_SUPERSECRET_TOKEN_VALUE'

function seedCredentialedRepo(db: ReturnType<typeof createInMemoryDb>, id: string): void {
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: 'a1b2c3d4',
      // exactly how a private repo is onboarded today
      url: `https://x-access-token:${TOKEN}@github.com/acme/private.git`,
      localPath: '/tmp/repos/a1b2c3d4-private',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
}

describe('RFC-204 P0-a — cached_repos never serves a credential', () => {
  test('the wire schema has no plaintext `url` field at all', () => {
    // Source-level lock: re-adding the field would silently reopen the leak for
    // every consumer, so the contract is asserted on the schema itself.
    expect(Object.keys(CachedRepoSchema.shape)).not.toContain('url')
    expect(Object.keys(CachedRepoSchema.shape)).toContain('urlRedacted')
  })

  test('listCachedRepos output contains no substring of the token', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedCredentialedRepo(db, ulid())

    const items = await listCachedRepos(db)
    expect(items).toHaveLength(1)

    // The whole serialized payload — not just the field we remembered to check.
    // This is what user B would receive from GET /api/cached-repos.
    const wire = JSON.stringify(items)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain('x-access-token:')
    expect(items[0]?.urlRedacted).toContain('github.com/acme/private.git')
  })

  test('a legacy row (url_redacted not yet backfilled) is still safe', async () => {
    // The sealing gate backfills url_redacted; until it runs, rowToCached must
    // fall back to redacting the legacy column rather than emitting it raw.
    const db = createInMemoryDb(MIGRATIONS)
    seedCredentialedRepo(db, ulid())
    const row = db.select().from(cachedRepos).all()[0]
    expect(row?.urlRedacted).toBeNull() // precondition: not backfilled

    const items = await listCachedRepos(db)
    expect(JSON.stringify(items)).not.toContain(TOKEN)
  })

  test('a query-form token in the local path is redacted on the wire', async () => {
    // parseGitUrl keeps `?access_token=` inside parsed.path, so historical cache
    // slugs (and therefore local_path, which IS on the wire) can embed one.
    const db = createInMemoryDb(MIGRATIONS)
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'deadbeef',
        url: `https://github.com/acme/p.git?access_token=${TOKEN}`,
        localPath: `/tmp/repos/deadbeef-p.git?access_token=${TOKEN}`,
        lastFetchedAt: now,
        createdAt: now,
      })
      .run()

    expect(JSON.stringify(await listCachedRepos(db))).not.toContain(TOKEN)
  })
})

describe('RFC-204 — reuse travels as an id, never as a URL', () => {
  test('normalizeStartTaskRepos narrows both source shapes and preserves ref', () => {
    // RFC-248: 这两条原本走 `repos[]`。该数组已退役，函数只剩单仓两形态——
    // 断言的实质（id / url 各自窄化、`ref` 原样保留）不变。
    const byId = normalizeStartTaskRepos({
      cachedRepoId: 'cr_1',
      ref: 'dev',
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(byId).toEqual([{ cachedRepoId: 'cr_1', ref: 'dev' }])

    const byUrl = normalizeStartTaskRepos({
      repoUrl: 'https://github.com/acme/p.git',
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(byUrl).toEqual([{ repoUrl: 'https://github.com/acme/p.git' }])
  })

  test('RFC-248: 杂散的 `repos[]` 不被静默展开成多仓', () => {
    // 纵深防御：顶层退役键守卫已在路由层硬拒 `repos`，但万一某条内部调用绕过了
    // 守卫，这里也**不能**把它当多仓来源——否则就退回到「静默启动在错误工作区」
    // 那个洞。函数只认单仓字段，杂散数组一律无视。
    const stray = normalizeStartTaskRepos({
      repos: [{ repoUrl: 'https://github.com/acme/a.git' }, { repoUrl: 'https://x/b.git' }],
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(stray).toEqual([])

    // 单仓字段仍然生效，杂散数组不干扰它。
    const mixed = normalizeStartTaskRepos({
      repoUrl: 'https://github.com/acme/real.git',
      repos: [{ repoUrl: 'https://github.com/acme/ignored.git' }],
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(mixed).toEqual([{ repoUrl: 'https://github.com/acme/real.git' }])
  })

  test('the framework-internal path spec rides deps.internalSource, not the wire', () => {
    // Fusion / test helpers hand us `{repoPath, baseBranch}` specs that never
    // went through the wire schema. RFC-248 之前它们借道 `repos[]`；现在唯一
    // 通道是 `deps.internalSource`。源码级锁住那条分支原样构造路径规格——
    // 一旦有人把它也改成 url-or-id 形态，materializeSpace 会拿到
    // `{repoUrl: undefined}` 而炸。
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf8')
    expect(src).toContain(
      '[{ repoPath: deps.internalSource.repoPath, baseBranch: deps.internalSource.baseBranch }]',
    )
  })

  test('the legacy single-repo body accepts a cachedRepoId source', () => {
    const single = normalizeStartTaskRepos({
      cachedRepoId: 'cr_9',
    } as unknown as Parameters<typeof normalizeStartTaskRepos>[0])
    expect(single).toEqual([{ cachedRepoId: 'cr_9' }])
  })
})
