// RFC-248 PR-2 —— 锁 migration 0131（repo_groups / repo_group_members +
// tasks / task_repos 新列）与 0132（memories.scope_type 扩到 repo_group）。
//
// 0132 是**表重建**，风险等级远高于普通 ALTER。设计门 G2 抓到的坑：初稿让照抄
// `0048_rfc101_fusion.sql`，但 0048 早于 RFC-223，缺 `fused_into_skill_id` 列与
// `idx_memories_fused_skill_id` 索引——照抄会静默丢掉整列融合溯源数据。权威基线
// 是 `0117_rfc223_fusion_provenance.sql:119-190`。本文件的 fused 溯源那条测试
// 就是这个坑的红/绿证据：把 0132 的列清单退回 0048 那版，它立刻变红。
//
// 0117 的 rename-first 顺序也不是风格选择：memories 带两条**自引用 FK**
// （supersedes_id / superseded_by_id → memories.id），把 `__new_memories` rename
// 成 `memories` 时 SQLite 是否重写这两条自引用**依赖 legacy_alter_table 模式**，
// 而 daemon 迁移期跑在 foreign_keys=OFF、直连 migrator 与测试跑在 ON。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, memories, repoGroupMembers, repoGroups } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeRepo(db: DbClient, slug: string): string {
  const id = ulid()
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: slug.padEnd(8, '0').slice(0, 8),
      url: `https://git.example/${slug}.git`,
      localPath: `/tmp/repos/${slug}`,
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return id
}

function makeGroup(db: DbClient, name: string): string {
  const id = ulid()
  const now = Date.now()
  db.insert(repoGroups).values({ id, name, description: '', createdAt: now, updatedAt: now }).run()
  return id
}

describe('migration 0131 — repo_groups / repo_group_members', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('组名大小写不敏感唯一', () => {
    makeGroup(db, '全栈')
    expect(() => makeGroup(db, '全栈')).toThrow()
    makeGroup(db, 'FullStack')
    // lower(name) 唯一索引：`fullstack` 与 `FullStack` 撞。
    expect(() => makeGroup(db, 'fullstack')).toThrow()
  })

  test('kind=repo 必须带 cached_repo_id 且不带 child_group_id', () => {
    const g = makeGroup(db, 'g')
    const r = makeRepo(db, 'app')
    db.insert(repoGroupMembers)
      .values({ groupId: g, memberIndex: 0, kind: 'repo', cachedRepoId: r, mountPath: '' })
      .run()
    // 两个都给 → CHECK 失败
    expect(() =>
      db
        .insert(repoGroupMembers)
        .values({
          groupId: g,
          memberIndex: 1,
          kind: 'repo',
          cachedRepoId: r,
          childGroupId: g,
          mountPath: 'x',
        })
        .run(),
    ).toThrow()
    // 都不给 → CHECK 失败
    expect(() =>
      db
        .insert(repoGroupMembers)
        .values({ groupId: g, memberIndex: 2, kind: 'repo', mountPath: 'y' })
        .run(),
    ).toThrow()
  })

  test('kind=group 不得携带 ref / subdir（D19：内层组的 ref 听它自己的）', () => {
    const outer = makeGroup(db, 'outer')
    const inner = makeGroup(db, 'inner')
    db.insert(repoGroupMembers)
      .values({
        groupId: outer,
        memberIndex: 0,
        kind: 'group',
        childGroupId: inner,
        mountPath: 'b',
      })
      .run()
    expect(() =>
      db
        .insert(repoGroupMembers)
        .values({
          groupId: outer,
          memberIndex: 1,
          kind: 'group',
          childGroupId: inner,
          mountPath: 'c',
          ref: 'main',
        })
        .run(),
    ).toThrow()
  })

  test('kind 只接受 repo / group', () => {
    // 走裸 SQL 而不是 drizzle + @ts-expect-error：这里要验证的是**DB CHECK 真的
    // 兜底**，裸 SQL 才是真正绕过类型层的写法（drizzle 的判别联合会在字面量层面
    // 就把非法 kind 连带整个对象一起拒掉，@ts-expect-error 反而挂错了位置）。
    const g = makeGroup(db, 'g')
    expect(() =>
      db.run(sql`
        INSERT INTO repo_group_members (group_id, member_index, kind, child_group_id, mount_path)
        VALUES (${g}, 0, 'wat', ${g}, '')
      `),
    ).toThrow()
  })

  test('删组级联删成员行', () => {
    const g = makeGroup(db, 'g')
    const r = makeRepo(db, 'app')
    db.insert(repoGroupMembers)
      .values({ groupId: g, memberIndex: 0, kind: 'repo', cachedRepoId: r, mountPath: '' })
      .run()
    db.run(sql`PRAGMA foreign_keys = ON`)
    db.delete(repoGroups)
      .where(sql`id = ${g}`)
      .run()
    expect(db.select().from(repoGroupMembers).all()).toHaveLength(0)
  })

  test('cached_repo_id **不**级联——删仓必须走显式守卫（D13）', () => {
    // 静默级联会让组悄悄少一个仓，用户下次启动才发现。
    const g = makeGroup(db, 'g')
    const r = makeRepo(db, 'app')
    db.insert(repoGroupMembers)
      .values({ groupId: g, memberIndex: 0, kind: 'repo', cachedRepoId: r, mountPath: '' })
      .run()
    db.run(sql`PRAGMA foreign_keys = ON`)
    expect(() =>
      db
        .delete(cachedRepos)
        .where(sql`id = ${r}`)
        .run(),
    ).toThrow()
  })

  test('tasks / task_repos 的新列存在且默认值正确', () => {
    const taskCols = db.all<{ name: string; dflt_value: string | null }>(
      sql`SELECT name, dflt_value FROM pragma_table_info('tasks')`,
    )
    const names = taskCols.map((c) => c.name)
    expect(names).toContain('repo_group_id')
    expect(names).toContain('repo_group_name')

    const trCols = db.all<{ name: string; dflt_value: string | null; notnull: number }>(
      sql`SELECT name, dflt_value, "notnull" FROM pragma_table_info('task_repos')`,
    )
    const byName = new Map(trCols.map((c) => [c.name, c]))
    expect(byName.has('mount_path')).toBe(true)
    expect(byName.has('subdir')).toBe(true)
    expect(byName.has('readonly')).toBe(true)
    expect(byName.has('gitignore_commit')).toBe(true)
    // mount_path 是 NOT NULL DEFAULT ''——存量行 backfill 后不能有 NULL。
    expect(byName.get('mount_path')?.notnull).toBe(1)
  })
})

describe('migration 0132 — memories.scope_type 扩到 repo_group', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function insertMemory(scopeType: string, scopeId: string | null): void {
    db.run(sql`
      INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
      VALUES (${ulid()}, ${scopeType}, ${scopeId}, 't', 'b', '[]', 'approved', 'manual', ${Date.now()}, 1)
    `)
  }

  test('repo_group 被 CHECK 接受', () => {
    expect(() => insertMemory('repo_group', ulid())).not.toThrow()
    expect(db.select().from(memories).all()).toHaveLength(1)
  })

  test('四种旧 scope 仍然接受（重建没有收窄枚举）', () => {
    for (const s of ['agent', 'workflow', 'repo']) insertMemory(s, ulid())
    insertMemory('global', null)
    expect(db.select().from(memories).all()).toHaveLength(4)
  })

  test('未知 scope 仍被 CHECK 拒绝', () => {
    expect(() => insertMemory('repogroup', ulid())).toThrow()
    expect(() => insertMemory('', ulid())).toThrow()
  })

  test('repo_group 属于「非 global」一侧——scope_id 必填', () => {
    expect(() => insertMemory('repo_group', null)).toThrow()
  })

  test('global ↔ NULL scope_id 的不变量没被重建破坏', () => {
    expect(() => insertMemory('global', ulid())).toThrow()
  })

  test('RFC-223 的融合溯源列与索引都还在（照抄 0048 就会红）', () => {
    const cols = db
      .all<{ name: string }>(sql`SELECT name FROM pragma_table_info('memories')`)
      .map((c) => c.name)
    expect(cols).toContain('fused_into_skill_id')
    expect(cols).toContain('fused_into_skill_version')
    expect(cols).toContain('fused_fusion_id')
    // 24 列——0117 的权威列集，一列不多一列不少。
    expect(cols).toHaveLength(24)

    const idx = db
      .all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories' AND name LIKE 'idx_memories_%'`,
      )
      .map((r) => r.name)
      .sort()
    expect(idx).toEqual([
      'idx_memories_fused_skill_id',
      'idx_memories_scope_status',
      'idx_memories_source',
      'idx_memories_status_created',
      'idx_memories_supersedes',
    ])
  })

  test('fused 的双向 CHECK 没被重建弄丢', () => {
    // status='fused' ⟺ fused_into_skill IS NOT NULL ⟺ fused_into_skill_id IS NOT NULL
    expect(() =>
      db.run(sql`
        INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
        VALUES (${ulid()}, 'repo', ${ulid()}, 't', 'b', '[]', 'fused', 'manual', ${Date.now()}, 1)
      `),
    ).toThrow()
  })

  test('两条自引用 FK 在重建后仍指向 memories 自己', () => {
    // rename-first 顺序就是为了这条：先建 `__new_memories` 再 rename 的话，
    // 自引用可能被 SQLite 留在 `__new_memories` 上（依赖 legacy_alter_table 模式）。
    const fks = db.all<{ table: string; from: string }>(
      sql`SELECT "table", "from" FROM pragma_foreign_key_list('memories')`,
    )
    const selfRefs = fks.filter((f) => f.table === 'memories').map((f) => f.from)
    expect(selfRefs.sort()).toEqual(['superseded_by_id', 'supersedes_id'])
    expect(db.all(sql`PRAGMA foreign_key_check('memories')`)).toHaveLength(0)
  })

  test('迁移用的临时断言表不留在库里', () => {
    const leftovers = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE name LIKE '%rfc248_assert%' OR name LIKE '__old_memories'`,
    )
    expect(leftovers).toHaveLength(0)
  })
})
