// RFC-248 PR-2b —— 仓库组服务层（CRUD / 展平 / 两个引用守卫 / 删组归档记忆）。
//
// 布局算法本身在 shared 的纯函数里、由 `rfc248-repo-group-layout.test.ts` 锁；
// 这里锁的是**服务层**该负责的事：规范化落库、保存期就拒环、祖先复查、
// 两个删除守卫、以及设计门 G5 的「删组同事务归档组记忆」。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, memories, repoGroupMembers, repoGroups } from '../src/db/schema'
import {
  RepoGroupHasReferencesError,
  createRepoGroup,
  deleteRepoGroup,
  detachRepoFromAllGroups,
  getRepoGroup,
  getRepoGroupLayoutResponse,
  groupsReferencingRepo,
  listRepoGroups,
  updateRepoGroup,
} from '../src/services/repoGroup'
import { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeRepo(db: DbClient, slug: string): string {
  const id = ulid()
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: `${slug}00000000`.slice(0, 8),
      url: `https://tok:secret@git.example/${slug}.git`,
      urlRedacted: `https://git.example/${slug}.git`,
      localPath: `/tmp/repos/${slug}`,
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return id
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    if (err instanceof DomainError) return err.code
    return `unexpected:${String(err)}`
  }
  return 'no-throw'
}

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    if (err instanceof DomainError) return err.code
    return `unexpected:${String(err)}`
  }
  return 'no-throw'
}

describe('RFC-248 repo group service', () => {
  let db: DbClient
  let appRepo: string
  let sdkRepo: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    appRepo = makeRepo(db, 'app')
    sdkRepo = makeRepo(db, 'sdk')
  })

  const deps = () => ({ db })

  test('建组：挂载路径在落库前就被规范化', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: '全栈',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
          {
            kind: 'repo',
            cachedRepoId: sdkRepo,
            ref: 'v2',
            subdir: '',
            mountPath: 'vendor//sdk/', // 故意写脏
            readonly: true,
          },
        ],
      },
      'u1',
    )
    expect(g.members).toHaveLength(2)
    const m1 = g.members[1]
    expect(m1?.mountPath).toBe('vendor/sdk') // DB 里存的是规范形态
    expect(m1?.readonly).toBe(true)
    expect(g.flatRepoCount).toBe(2)
  })

  test('URL 只出脱敏形态——凭证绝不回传（RFC-204）', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    const m = g.members[0]
    expect(m?.kind === 'repo' && m.repoUrlRedacted).toBe('https://git.example/app.git')
    expect(JSON.stringify(g)).not.toContain('secret')
  })

  test('组名大小写不敏感冲突 → 409', async () => {
    await createRepoGroup(
      deps(),
      {
        name: 'FullStack',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    expect(
      await codeOfAsync(() =>
        createRepoGroup(
          deps(),
          {
            name: 'fullstack',
            description: '',
            members: [
              {
                kind: 'repo',
                cachedRepoId: sdkRepo,
                ref: '',
                subdir: '',
                mountPath: '',
                readonly: false,
              },
            ],
          },
          null,
        ),
      ),
    ).toBe('repo-group-name-conflict')
  })

  test('非法挂载路径 → 422 且带成员下标（UI 要就地标红）', async () => {
    const code = await codeOfAsync(() =>
      createRepoGroup(
        deps(),
        {
          name: 'g',
          description: '',
          members: [
            {
              kind: 'repo',
              cachedRepoId: appRepo,
              ref: '',
              subdir: '',
              mountPath: '../escape',
              readonly: false,
            },
          ],
        },
        null,
      ),
    )
    expect(code).toBe('mount-path-traversal')
  })

  test('subdir 走同一套规范化（同样不许 .. / 绝对路径）', async () => {
    expect(
      await codeOfAsync(() =>
        createRepoGroup(
          deps(),
          {
            name: 'g',
            description: '',
            members: [
              {
                kind: 'repo',
                cachedRepoId: appRepo,
                ref: '',
                subdir: '/etc',
                mountPath: '',
                readonly: false,
              },
            ],
          },
          null,
        ),
      ),
    ).toBe('mount-path-absolute')
  })

  test('引用不存在的仓 / 组 → 422', async () => {
    expect(
      await codeOfAsync(() =>
        createRepoGroup(
          deps(),
          {
            name: 'g',
            description: '',
            members: [
              {
                kind: 'repo',
                cachedRepoId: 'nope',
                ref: '',
                subdir: '',
                mountPath: '',
                readonly: false,
              },
            ],
          },
          null,
        ),
      ),
    ).toBe('repo-group-member-not-found')
  })

  test('组套组：layout 端点给出展平后的完整布局与来源链', async () => {
    const inner = await createRepoGroup(
      deps(),
      {
        name: '底座',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: sdkRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    const outer = await createRepoGroup(
      deps(),
      {
        name: '订单域',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
          { kind: 'group', childGroupId: inner.id, mountPath: 'base', readonly: true },
        ],
      },
      null,
    )
    const layout = getRepoGroupLayoutResponse(db, outer.id)
    expect(layout.totalRepos).toBe(2)
    expect(layout.maxDepth).toBe(1)
    expect(layout.repos.map((r) => r.mountPath)).toEqual(['', 'base'])
    // D20 只读向内传播取并集。
    expect(layout.repos[1]?.readonly).toBe(true)
    expect(layout.repos[1]?.viaGroups.map((v) => v.name)).toEqual(['订单域', '底座'])
  })

  test('自引用在保存时就被拒（不等到启动才炸）', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    expect(
      await codeOfAsync(() =>
        updateRepoGroup(deps(), g.id, {
          name: 'g',
          description: '',
          members: [{ kind: 'group', childGroupId: g.id, mountPath: 'x', readonly: false }],
        }),
      ),
    ).toBe('repo-group-cycle')
  })

  test('改内层组把外层顶到重复挂点 → 保存时就拒（祖先复查）', async () => {
    // 单查自己不够：内层加一个成员可能让某个**定义一个字都没改**的外层组变得
    // 无法展平。不查的话那个外层组会在下次启动时才炸，那时用户已经不记得是哪
    // 一次编辑导致的了。
    const inner = await createRepoGroup(
      deps(),
      {
        name: 'inner',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: sdkRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    await createRepoGroup(
      deps(),
      {
        name: 'outer',
        description: '',
        members: [
          { kind: 'group', childGroupId: inner.id, mountPath: 'base', readonly: false },
          // 外层自己占了 base/dup
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: 'base/dup',
            readonly: false,
          },
        ],
      },
      null,
    )
    // 给内层加一个也落到 base/dup 的成员 → 外层展平后重复挂点。
    const code = await codeOfAsync(() =>
      updateRepoGroup(deps(), inner.id, {
        name: 'inner',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: sdkRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: 'dup',
            readonly: false,
          },
        ],
      }),
    )
    expect(code).toBe('mount-path-duplicate')
  })

  test('PUT 让 version 自增', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    expect(g.version).toBe(1)
    const g2 = await updateRepoGroup(deps(), g.id, {
      name: 'g',
      description: '改了',
      members: [
        {
          kind: 'repo',
          cachedRepoId: appRepo,
          ref: '',
          subdir: '',
          mountPath: '',
          readonly: false,
        },
      ],
    })
    expect(g2.version).toBe(2)
    expect(g2.description).toBe('改了')
  })

  test('删组被别的组引用 → 409 并列出引用者；force 才摘', async () => {
    const inner = await createRepoGroup(
      deps(),
      {
        name: 'inner',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: sdkRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    await createRepoGroup(
      deps(),
      {
        name: 'outer',
        description: '',
        members: [{ kind: 'group', childGroupId: inner.id, mountPath: 'base', readonly: false }],
      },
      null,
    )
    let caught: unknown
    try {
      deleteRepoGroup(db, inner.id)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RepoGroupHasReferencesError)
    expect((caught as RepoGroupHasReferencesError).referencingGroups[0]?.name).toBe('outer')

    const r = deleteRepoGroup(db, inner.id, { force: true })
    expect(r.detachedReferences).toBe(1)
    expect(listRepoGroups(db).map((g) => g.name)).toEqual(['outer'])
    // 外层组本身保留，只是少了那个成员。
    expect(getRepoGroup(db, listRepoGroups(db)[0]!.id).members).toHaveLength(0)
  })

  test('设计门 G5：删组把绑在它上面的记忆置 archived（不硬删），并回报条数', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    for (const title of ['m1', 'm2']) {
      db.run(sql`
        INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
        VALUES (${ulid()}, 'repo_group', ${g.id}, ${title}, 'b', '[]', 'approved', 'manual', ${Date.now()}, 1)
      `)
    }
    expect(getRepoGroup(db, g.id).boundMemories).toBe(2)

    const r = deleteRepoGroup(db, g.id)
    expect(r.archivedMemories).toBe(2)
    // 不硬删——用户知识保住了。
    const rows = db.select().from(memories).all()
    expect(rows).toHaveLength(2)
    expect(rows.every((m) => m.status === 'archived')).toBe(true)
    // archived 被 memoryInject 的 status='approved' 过滤排除 ⇒ 注入立即停止。
    const stillApproved = db
      .select()
      .from(memories)
      .where(and(eq(memories.scopeType, 'repo_group'), eq(memories.status, 'approved')))
      .all()
    expect(stillApproved).toHaveLength(0)
  })

  test('已 archived 的记忆不重复计数', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    db.run(sql`
      INSERT INTO memories (id, scope_type, scope_id, title, body_md, tags, status, source_kind, created_at, version)
      VALUES (${ulid()}, 'repo_group', ${g.id}, 'old', 'b', '[]', 'archived', 'manual', ${Date.now()}, 1)
    `)
    expect(getRepoGroup(db, g.id).boundMemories).toBe(0)
    expect(deleteRepoGroup(db, g.id).archivedMemories).toBe(0)
  })

  test('D13 删仓守卫：groupsReferencingRepo 去重，detach 摘干净', async () => {
    const g1 = await createRepoGroup(
      deps(),
      {
        name: 'g1',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
          // 同一个仓在同一个组里出现两次（D14 允许）——引用列表必须去重。
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: 'release',
            subdir: '',
            mountPath: 'compare',
            readonly: false,
          },
        ],
      },
      null,
    )
    await createRepoGroup(
      deps(),
      {
        name: 'g2',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    const refs = groupsReferencingRepo(db, appRepo)
    expect(refs.map((r) => r.name).sort()).toEqual(['g1', 'g2'])
    expect(detachRepoFromAllGroups(db, appRepo)).toBe(3) // g1 两行 + g2 一行
    expect(groupsReferencingRepo(db, appRepo)).toEqual([])
    expect(getRepoGroup(db, g1.id).members).toHaveLength(0)
  })

  test('外键挡住悬空的 child_group_id——坏数据进不了库', () => {
    // 服务层的 member-not-found 校验之外还有 DB 兜底：`child_group_id` 上的外键
    // 让「并发删组留下悬空引用」这件事在存储层就不可能发生。
    expect(() =>
      db
        .insert(repoGroupMembers)
        .values({
          groupId: ulid(),
          memberIndex: 0,
          kind: 'group',
          childGroupId: 'ghost',
          mountPath: 'x',
        })
        .run(),
    ).toThrow()
  })

  test('列表在某个组展平失败（成环）时不整体 500——该组 flatRepoCount 记 0', async () => {
    // 环是**外键挡不住**的坏形态（两端的组都真实存在）。服务层在保存期会拒，
    // 但直写 SQL 或历史数据仍可能造出来，列表页不能因此整个 500——否则用户
    // 连进去修的入口都没有。
    const g1 = await createRepoGroup(
      deps(),
      {
        name: 'g1',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    const g2 = await createRepoGroup(
      deps(),
      {
        name: 'g2',
        description: '',
        members: [{ kind: 'group', childGroupId: g1.id, mountPath: 'a', readonly: false }],
      },
      null,
    )
    // 绕过服务层的保存期环检测，直写一条把 g1 → g2 的边补上，成环。
    db.insert(repoGroupMembers)
      .values({
        groupId: g1.id,
        memberIndex: 1,
        kind: 'group',
        childGroupId: g2.id,
        mountPath: 'b',
      })
      .run()

    const items = listRepoGroups(db)
    expect(items).toHaveLength(2)
    expect(items.every((i) => i.flatRepoCount === 0)).toBe(true)
    // 但真去展平时必须给出具体错误，而不是空布局。
    expect(codeOf(() => getRepoGroupLayoutResponse(db, g1.id))).toBe('repo-group-cycle')
  })

  test('删不存在的组 → 404', () => {
    expect(codeOf(() => deleteRepoGroup(db, 'nope'))).toBe('repo-group-not-found')
  })

  test('删组级联清掉自己的成员行', async () => {
    const g = await createRepoGroup(
      deps(),
      {
        name: 'g',
        description: '',
        members: [
          {
            kind: 'repo',
            cachedRepoId: appRepo,
            ref: '',
            subdir: '',
            mountPath: '',
            readonly: false,
          },
        ],
      },
      null,
    )
    deleteRepoGroup(db, g.id)
    expect(db.select().from(repoGroupMembers).all()).toHaveLength(0)
    expect(db.select().from(repoGroups).all()).toHaveLength(0)
  })
})
