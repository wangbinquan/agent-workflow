// RFC-248 PR-4 T31 —— 仓库组记忆注入（D4）。
//
// 这条是本 RFC 的头号特性之一「记忆也可以绑定在仓库组上」的落地锁。三条语义
// 必须同时成立，缺一条这个特性就是坏的：
//
//   1. 用组启动 ⇒ 注入**组记忆**。
//   2. 用组启动 ⇒ 同时注入**组内每个成员仓**自己的 repo 记忆（不是只有 repos[0]）。
//      RFC-041 时代一个任务只有一个仓，`repoId` 是单数；组启动后有 N 个。
//   3. **单仓直启不注入它所属任何组的记忆**。组记忆讲的是「这个组合怎么一起干活」，
//      单跑一个仓时无意义；且一个仓可能属于很多组，全注入会爆。
//
// 第 3 条是最容易在重构中被"顺手打通"的——看起来「这个仓属于那个组，那就注入吧」
// 很自然，但那会把无关知识灌进单仓任务的 prompt。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { loadInjectableMemories } from '../src/services/memoryInject'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
})

function seedRepo(slug: string): string {
  const id = ulid()
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: `${slug}00000000`.slice(0, 8),
      urlRedacted: `https://git.example/${slug}.git`,
      localPath: `/tmp/${slug}`,
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return id
}

function seedMemory(scopeType: string, scopeId: string | null, title: string): void {
  db.run(sql`
    INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
    VALUES (${ulid()}, ${scopeType}, ${scopeId}, ${title}, 'body', '[]', 'approved', 'manual', ${Date.now()}, 1)
  `)
}

describe('RFC-248 D4 —— 仓库组记忆注入', () => {
  test('用组启动：注入组记忆 + 组内每个成员仓的 repo 记忆', async () => {
    const fe = seedRepo('fe')
    const be = seedRepo('be')
    const groupId = ulid()
    seedMemory('repo_group', groupId, 'GROUP-RULE')
    seedMemory('repo', fe, 'FE-RULE')
    seedMemory('repo', be, 'BE-RULE')

    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [fe, be],
      repoGroupId: groupId,
    })
    expect(set.byScope.repoGroup.map((m) => m.title)).toEqual(['GROUP-RULE'])
    // 两个成员仓的记忆都在——不是只有 repos[0] 那一个。
    expect(set.byScope.repo.map((m) => m.title).sort()).toEqual(['BE-RULE', 'FE-RULE'])
  })

  test('单仓直启：**不**注入它所属组的记忆（repoGroupId=null）', async () => {
    const fe = seedRepo('fe')
    const groupId = ulid()
    seedMemory('repo_group', groupId, 'GROUP-RULE')
    seedMemory('repo', fe, 'FE-RULE')

    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [fe],
      repoGroupId: null, // 单仓直启
    })
    expect(set.byScope.repoGroup).toEqual([])
    expect(set.byScope.repo.map((m) => m.title)).toEqual(['FE-RULE'])
  })

  test('别的组的记忆不会串进来', async () => {
    const fe = seedRepo('fe')
    const mine = ulid()
    const other = ulid()
    seedMemory('repo_group', mine, 'MINE')
    seedMemory('repo_group', other, 'OTHER')

    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [fe],
      repoGroupId: mine,
    })
    expect(set.byScope.repoGroup.map((m) => m.title)).toEqual(['MINE'])
  })

  test('只有 approved 的组记忆进注入——archived / candidate 不进', async () => {
    const groupId = ulid()
    seedMemory('repo_group', groupId, 'OK')
    for (const st of ['archived', 'candidate', 'rejected', 'superseded']) {
      db.run(sql`
        INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
        VALUES (${ulid()}, 'repo_group', ${groupId}, ${'NO-' + st}, 'b', '[]', ${st}, 'manual', ${Date.now()}, 1)
      `)
    }
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [],
      repoGroupId: groupId,
    })
    expect(set.byScope.repoGroup.map((m) => m.title)).toEqual(['OK'])
  })

  test('删组把记忆置 archived ⇒ 注入立即停止（G5 的闭环验证）', async () => {
    const groupId = ulid()
    seedMemory('repo_group', groupId, 'RULE')
    const before = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [],
      repoGroupId: groupId,
    })
    expect(before.byScope.repoGroup).toHaveLength(1)

    db.run(sql`UPDATE memories SET status='archived' WHERE scope_type='repo_group'`)
    const after = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [],
      repoGroupId: groupId,
    })
    expect(after.byScope.repoGroup).toEqual([])
  })

  test('空 repoIds 跳过 repo 档（scratch 任务）', async () => {
    seedMemory('global', null, 'G')
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      repoIds: [],
      repoGroupId: null,
    })
    expect(set.byScope.repo).toEqual([])
    expect(set.byScope.global.map((m) => m.title)).toEqual(['G'])
  })

  test('同一个仓在组里出现两次（D14）不会把它的记忆注入两遍', async () => {
    const app = seedRepo('app')
    seedMemory('repo', app, 'APP-RULE')
    const set = await loadInjectableMemories(db, {
      agentIds: [],
      workflowId: null,
      // 调用方已去重，但即便没去重，IN (...) 也只会命中一次行。
      repoIds: [app, app],
      repoGroupId: null,
    })
    expect(set.byScope.repo.map((m) => m.title)).toEqual(['APP-RULE'])
  })
})
