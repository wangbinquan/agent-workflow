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

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, memories, repoGroups } from '../src/db/schema'

// Historical 0131-only ORM projection. The current production schema no
// longer exports the table removed by migration 0134.
const legacyRepoGroupAttachments = sqliteTable(
  'repo_group_members',
  {
    groupId: text('group_id').notNull(),
    memberIndex: integer('member_index').notNull(),
    kind: text('kind', { enum: ['repo', 'group'] }).notNull(),
    cachedRepoId: text('cached_repo_id'),
    ref: text('ref').notNull().default(''),
    subdir: text('subdir').notNull().default(''),
    childGroupId: text('child_group_id'),
    mountPath: text('mount_path').notNull().default(''),
    readonly: integer('readonly', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => ({ pk: primaryKey({ columns: [table.groupId, table.memberIndex] }) }),
)

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const legacyMigrations = mkdtempSync(join(tmpdir(), 'rfc248-through-0133-'))
cpSync(MIGRATIONS, legacyMigrations, { recursive: true })
const legacyJournalPath = join(legacyMigrations, 'meta', '_journal.json')
const legacyJournal = JSON.parse(readFileSync(legacyJournalPath, 'utf8')) as {
  entries: Array<{ idx: number }>
}
legacyJournal.entries = legacyJournal.entries.filter((entry) => entry.idx <= 132)
writeFileSync(legacyJournalPath, `${JSON.stringify(legacyJournal, null, 2)}\n`)
afterAll(() => rmSync(legacyMigrations, { recursive: true, force: true }))

function makeRepo(db: DbClient, slug: string): string {
  const id = ulid()
  const now = Date.now()
  const url = `https://git.example/${slug}.git`
  // This fixture intentionally stops at 0133, where the historical plaintext
  // column still exists. Use raw SQL instead of the HEAD ORM projection (0147
  // removes that column) so the frozen physical schema remains authoritative.
  db.run(sql`
    INSERT INTO cached_repos (
      id, url_hash, url, url_redacted, local_path, default_branch,
      last_fetched_at, created_at
    ) VALUES (
      ${id}, ${slug.padEnd(8, '0').slice(0, 8)}, ${url}, ${url},
      ${`/tmp/repos/${slug}`}, 'main', ${now}, ${now}
    )
  `)
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
    db = createInMemoryDb(legacyMigrations)
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
    db.insert(legacyRepoGroupAttachments)
      .values({ groupId: g, memberIndex: 0, kind: 'repo', cachedRepoId: r, mountPath: '' })
      .run()
    // 两个都给 → CHECK 失败
    expect(() =>
      db
        .insert(legacyRepoGroupAttachments)
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
        .insert(legacyRepoGroupAttachments)
        .values({ groupId: g, memberIndex: 2, kind: 'repo', mountPath: 'y' })
        .run(),
    ).toThrow()
  })

  test('kind=group 不得携带 ref / subdir（D19：内层组的 ref 听它自己的）', () => {
    const outer = makeGroup(db, 'outer')
    const inner = makeGroup(db, 'inner')
    db.insert(legacyRepoGroupAttachments)
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
        .insert(legacyRepoGroupAttachments)
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
    db.insert(legacyRepoGroupAttachments)
      .values({ groupId: g, memberIndex: 0, kind: 'repo', cachedRepoId: r, mountPath: '' })
      .run()
    db.run(sql`PRAGMA foreign_keys = ON`)
    db.delete(repoGroups)
      .where(sql`id = ${g}`)
      .run()
    expect(db.select().from(legacyRepoGroupAttachments).all()).toHaveLength(0)
  })

  test('cached_repo_id **不**级联——删仓必须走显式守卫（D13）', () => {
    // 静默级联会让组悄悄少一个仓，用户下次启动才发现。
    const g = makeGroup(db, 'g')
    const r = makeRepo(db, 'app')
    db.insert(legacyRepoGroupAttachments)
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

describe('T19c —— migration ↔ ORM schema 一致性（设计门二轮 P2-1）', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(legacyMigrations)
  })

  // drizzle 的 `schema.ts` **表达不了**下面这几样东西：表达式唯一索引
  // （`lower(name)`）、CHECK 约束、以及本 RFC 刻意不加 cascade 的两条外键。
  // 它们只存在于 migration SQL 里。若有人按 ORM schema 重新生成迁移，这些约束
  // 会被**静默抹掉**——组名唯一没了、kind 枚举没了、删仓的显式守卫被 FK 缺失
  // 架空。这一组测试从 `sqlite_master` 读真实 DDL 来钉死它们。

  function ddlOf(table: string): string {
    const rows = db.all<{ sql: string }>(
      sql`SELECT sql FROM sqlite_master WHERE type='table' AND name=${table}`,
    )
    return rows[0]?.sql ?? ''
  }

  test('repo_groups 的 lower(name) 表达式唯一索引存在', () => {
    const idx = db.all<{ name: string; sql: string }>(
      sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='repo_groups'`,
    )
    const ci = idx.find((i) => i.name === 'idx_repo_groups_name_ci')
    expect(ci).toBeDefined()
    expect(ci?.sql.toLowerCase()).toContain('lower(')
    expect(ci?.sql.toLowerCase()).toContain('unique')
  })

  test('repo_group_members 的三条 CHECK 都在 DDL 里', () => {
    const ddl = ddlOf('repo_group_members')
    expect(ddl).toContain("`kind` IN ('repo','group')")
    // kind ⇄ 两个外键之一的互斥
    expect(ddl).toContain('cached_repo_id')
    expect(ddl).toContain('child_group_id')
    // D19：组成员不带 ref / subdir
    expect(ddl.replace(/\s+/g, ' ')).toContain(
      "CHECK (`kind` = 'repo' OR (`ref` = '' AND `subdir` = ''))",
    )
    expect((ddl.match(/CHECK/g) ?? []).length).toBe(3)
  })

  test('两条外键刻意**不带** ON DELETE CASCADE（删除走显式守卫，D13）', () => {
    const fks = db.all<{ table: string; from: string; on_delete: string }>(
      sql`SELECT "table", "from", "on_delete" FROM pragma_foreign_key_list('repo_group_members')`,
    )
    const byFrom = new Map(fks.map((f) => [f.from, f]))
    // group_id 级联（成员是组的一部分，组没了成员就该没）
    expect(byFrom.get('group_id')?.on_delete).toBe('CASCADE')
    // 这两条**不**级联——静默级联会让组悄悄少一个仓
    expect(byFrom.get('cached_repo_id')?.on_delete).toBe('NO ACTION')
    expect(byFrom.get('child_group_id')?.on_delete).toBe('NO ACTION')
  })

  test('task_repos 的四个新列都是 migration 里声明的形态', () => {
    const cols = db.all<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      sql`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('task_repos')`,
    )
    const by = new Map(cols.map((c) => [c.name, c]))
    expect(by.get('mount_path')).toMatchObject({ notnull: 1, dflt_value: "''" })
    expect(by.get('subdir')).toMatchObject({ notnull: 1, dflt_value: "''" })
    expect(by.get('readonly')).toMatchObject({ notnull: 1, dflt_value: '0' })
    expect(by.get('gitignore_commit')?.notnull).toBe(0) // 可空：叶子仓没有预置 commit
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
