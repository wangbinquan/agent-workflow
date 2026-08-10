// RFC-248 T36 —— **未保存**成员表的干跑展平预览（编辑器右侧实时预览的后端）。
//
// 这条路由存在的理由：`GET /:id/layout` 只服务已存在的组，而用户在编辑器里
// 拖挂载点时组还没保存。要么前端另写一套近似的展平逻辑（然后与服务端慢慢
// 长歪、保存时才发现两边不一致），要么让服务端用**同一份实现**干跑一次。选后者。
//
// 两条必须成立的性质：
//
//  1. **零副作用**。`repoUrl` 形态的成员会触发镜像 clone（写），预览一律不导入
//     ——否则用户每敲错一个字符就在 `cached_repos` 里留一行垃圾。它们只回报
//     `pendingImports` 计数。
//  2. **与真实展平同语义**。组套组、深度上限、循环检测、只读并集、挂载点冲突
//     全部按真实规则报错，而不是「预览通过、保存 422」。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, repoGroupNodes, repoGroups } from '../src/db/schema'
import { previewRepoGroupLayout as previewRepoGroupLayoutImpl } from '../src/services/repoGroup'
import {
  repoGroupNodesFromAttachments,
  type RepoGroupAttachmentSpec,
} from './helpers/repoGroupFixture'

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
      urlHash: `${slug}0000000`.slice(0, 8),
      urlRedacted: `https://git.example/${slug}.git`,
      localPath: `/tmp/${slug}`,
      defaultBranch: 'main',
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
  return id
}

function previewRepoGroupLayout(
  database: DbClient,
  input: { name?: string; attachments: readonly RepoGroupAttachmentSpec[] },
) {
  return previewRepoGroupLayoutImpl(database, {
    ...(input.name === undefined ? {} : { name: input.name }),
    nodes: repoGroupNodesFromAttachments(input.attachments),
  })
}

/** 建一个真实的组（预览里可以被 `kind:'group'` 成员引用）。 */
function seedGroup(name: string, repoIds: readonly string[]): string {
  const id = ulid()
  const now = Date.now()
  db.insert(repoGroups)
    .values({
      id,
      name,
      description: '',
      version: 1,
      createdByUserId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  repoIds.forEach((rid, i) => {
    db.insert(repoGroupNodes)
      .values({
        groupId: id,
        path: i === 0 ? '' : `m${i}`,
        attachmentKind: 'repo',
        cachedRepoId: rid,
        ref: '',
        subdir: '',
        readonly: false,
      })
      .run()
  })
  return id
}

describe('RFC-248 —— 干跑布局预览', () => {
  test('空成员表返回空布局，而不是 422', () => {
    // 用户刚点开「新建」时就是这个状态，那时报错毫无意义。
    const r = previewRepoGroupLayout(db, { attachments: [] })
    expect(r.repos).toEqual([])
    expect(r.totalRepos).toBe(0)
    expect(r.pendingImports).toBe(0)
  })

  test('按 cachedRepoId 的成员正常展平，挂载路径原样带出', () => {
    const app = seedRepo('app')
    const sdk = seedRepo('sdk')
    const r = previewRepoGroupLayout(db, {
      name: '全栈',
      attachments: [
        { kind: 'repo', cachedRepoId: app, ref: '', subdir: '', mountPath: '', readonly: false },
        {
          kind: 'repo',
          cachedRepoId: sdk,
          ref: 'v2',
          subdir: 'packages/core',
          mountPath: 'vendor/sdk',
          readonly: true,
        },
      ],
    })
    expect(r.repos.map((x) => x.mountPath)).toEqual(['', 'vendor/sdk'])
    expect(r.repos[1]).toMatchObject({ ref: 'v2', subdir: 'packages/core', readonly: true })
    expect(r.groupName).toBe('全栈')
  })

  test('**零副作用**：只给 URL 的成员不导入、不落库，只计入 pendingImports', () => {
    const before = db.select().from(cachedRepos).all().length
    const r = previewRepoGroupLayout(db, {
      attachments: [
        {
          kind: 'repo',
          repoUrl: 'https://git.example/new.git',
          ref: '',
          subdir: '',
          mountPath: '',
          readonly: false,
        },
      ],
    })
    expect(r.pendingImports).toBe(1)
    expect(r.repos).toEqual([])
    // 关键：一行镜像都没多。
    expect(db.select().from(cachedRepos).all()).toHaveLength(before)
    // 组表同样不能多出行来——预览是纯读。
    expect(db.select().from(repoGroups).all()).toHaveLength(0)
  })

  test('引用真实子组 ⇒ 递归展平，子组成员带上外层挂载前缀', () => {
    const a = seedRepo('a')
    const b = seedRepo('b')
    const child = seedGroup('child', [a, b])
    const r = previewRepoGroupLayout(db, {
      attachments: [{ kind: 'group', childGroupId: child, mountPath: 'sub', readonly: false }],
    })
    expect(r.repos.map((x) => x.mountPath).sort()).toEqual(['sub', 'sub/m1'])
    // 来源链记录它是经哪个组进来的。
    expect(r.repos[0]?.viaGroups.map((g) => g.name)).toContain('child')
  })

  test('外层标只读 ⇒ 子组成员全部只读（D20 并集）', () => {
    const a = seedRepo('a')
    const child = seedGroup('child', [a])
    const r = previewRepoGroupLayout(db, {
      attachments: [{ kind: 'group', childGroupId: child, mountPath: 'sub', readonly: true }],
    })
    expect(r.repos.every((x) => x.readonly)).toBe(true)
  })

  test('引用不存在的子组 ⇒ 404（而不是静默跳过）', () => {
    expect(() =>
      previewRepoGroupLayout(db, {
        attachments: [{ kind: 'group', childGroupId: 'nope', mountPath: '', readonly: false }],
      }),
    ).toThrow(/not found/i)
  })

  test('挂载点冲突在预览期就报出来——不是「预览通过、保存 422」', () => {
    const a = seedRepo('a')
    const b = seedRepo('b')
    let code = ''
    try {
      previewRepoGroupLayout(db, {
        attachments: [
          { kind: 'repo', cachedRepoId: a, ref: '', subdir: '', mountPath: 'x', readonly: false },
          { kind: 'repo', cachedRepoId: b, ref: '', subdir: '', mountPath: 'x', readonly: false },
        ],
      })
    } catch (e) {
      code = (e as { code?: string }).code ?? ''
    }
    expect(code).not.toBe('')
    // 是可操作的 422（ValidationError），不是 500。
    expect((code.match(/mount/) ?? []).length).toBeGreaterThan(0)
  })

  test('两个成员都想挂根 ⇒ 报错（D2：至多一个挂根）', () => {
    const a = seedRepo('a')
    const b = seedRepo('b')
    expect(() =>
      previewRepoGroupLayout(db, {
        attachments: [
          { kind: 'repo', cachedRepoId: a, ref: '', subdir: '', mountPath: '', readonly: false },
          { kind: 'repo', cachedRepoId: b, ref: '', subdir: '', mountPath: '', readonly: false },
        ],
      }),
    ).toThrow()
  })
})
