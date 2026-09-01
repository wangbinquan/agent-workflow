// RFC-287 G5 / T14 实现门 —— `file://` 的三条绕过通道。
//
// G5 的意图是「本机路径不得伪装成远端仓库被平台跑起来」。第一版只在两处落了判据
// （启动 schema + 后台保鲜），实现门一口气找出三条没被覆盖的通道。三条的形态各不
// 相同，但根因是同一个：**判据被手抄了两份**，于是每新增一条入口就多一次遗漏机会。
// 修法除了堵住这三条，还把判据收敛成 `isFileSchemeUrl` 单点，三处入口一律引它。
//
// 这个文件按「通道」而不是按「函数」组织：将来加第四条入口时，这里该多一个 describe。

import { describe, expect, test } from 'bun:test'
import {
  StartBatchImportRequestSchema,
  RetryBatchImportRowRequestSchema,
  StartTaskSchema,
  isFileSchemeUrl,
} from '@agent-workflow/shared'
import { selectDueRepos } from '@/services/submoduleRefresh'
import { ulid } from 'ulid'
import { rememberVolatileRepoUrl } from '@/services/repoCredentials'
import { createInMemoryDb } from '@/db/client'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { cachedRepos } from '@/db/schema'
import { MIGRATIONS } from './migration-freeze'

const FILE_URL = 'file:///srv/private/repo'

describe('RFC-287 G5 — 判据单点化', () => {
  test('isFileSchemeUrl 认 scheme 且大小写/空白无关', () => {
    for (const s of [FILE_URL, '  file:///x  ', 'FILE:///x', 'File://host/x']) {
      expect(isFileSchemeUrl(s), s).toBe(true)
    }
    for (const s of [
      'https://e.com/x.git',
      'git@e.com:x.git',
      'ssh://e.com/x',
      '',
      'notfile://x',
    ]) {
      expect(isFileSchemeUrl(s), s).toBe(false)
    }
  })
})

describe('RFC-287 G5 —— 存量 file:// 镜像不可运行（design §10.7 定音口径）', () => {
  // 二轮实现门纠正：一轮我把拒绝加在**注册面**（批量导入 schema），那与 design
  // 相反，而且没堵住真正的洞。design §10.7 写得很直白：公开面自 RFC-204 起不传
  // URL、传 `cachedRepoId`，**schema 层拦 file:// 对存量一个都拦不住**。
  //
  // 真正的收口点是 `resolveRepoSourceSingle` 在两条来源分支汇流成 `sourceUrl` 之后、
  // `resolveCachedRepo` 之前——一处同时覆盖：URL 直填、cachedRepoId 反查、仓库组
  // 成员、多仓循环、sourceTaskId 重放、webhook 命中存量缓存。
  //
  // 「存量可见不可运行」：行照样在、列表照样显示、导入照样允许，只是启动与刷新被拒。
  async function seedFileMirror(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
    const id = ulid()
    const now = Date.now()
    db.insert(cachedRepos)
      .values({
        id,
        urlHash: 'legacy-file',
        urlRedacted: FILE_URL,
        urlEnc: null, // 无密钥的测试形态：unseal 回落到 volatile/redacted
        localPath: '/tmp/aw-legacy-file-mirror',
        lastFetchedAt: now - 1000,
        createdAt: now - 1000,
      })
      .run()
    // 无密钥的测试形态：生产里 URL 存在 `url_enc`，这里用 volatile 记忆让
    // `unsealRepoUrl` 解得出来——否则会先撞「no readable URL」，测不到本条要验的
    // scheme 判据。
    rememberVolatileRepoUrl(db, id, FILE_URL)
    return id
  }

  test('拿存量 file:// 的 cachedRepoId 启动 → 被拒（这是一轮真正漏掉的洞）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedFileMirror(db)
    const { resolveRepoSourceSingle } = await import('@/services/task')
    let msg = ''
    try {
      await resolveRepoSourceSingle(
        { cachedRepoId: id } as never,
        {} as never,
        { store: composeSqliteRepositoryWorkspaceStore(db), appHome: '/tmp/aw-t14-g5' } as never,
      )
    } catch (err) {
      // 判据必须是 `.code`——码在 `.code`，message 里一个字都没有。原来写的是
      // `toMatch(/file-scheme-unsupported|file:\/\/ repositories cannot be launched/i)`，
      // 第一支**永远不匹配**，整条断言其实焊在那句英文散文上：改个措辞就误红，而
      // 换掉错误码反倒不红（四轮门测试有效性自查实测）。
      msg = (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err))
    }
    expect(msg).toBe('repo-url-file-scheme-unsupported')
  })

  test('注册面**不拒**：批量导入仍接受 file://（design 划为不动面）', () => {
    // 反向锁。在注册面拒会误伤允许面，并给人「已经堵住了」的错觉——真正该堵的是
    // 上面那条运行面。
    expect(StartBatchImportRequestSchema.safeParse({ urls: [FILE_URL] }).success).toBe(true)
    expect(RetryBatchImportRowRequestSchema.safeParse({ url: FILE_URL }).success).toBe(true)
  })

  test('schema 层保留 file:// 拒绝，作为直填 URL 时的早报错附加层', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 'x',
      repoUrl: FILE_URL,
      inputs: {},
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('repo-url-file-scheme-unsupported')
  })
})

describe('RFC-287 G5 绕过③ — 后台保鲜对 url_redacted=NULL 的存量行', () => {
  // 过滤器原先只排除「非空字符串且匹配 file」，于是 NULL 行 fail-open 照旧保鲜。
  // NULL 不是理论情形：repairCachedRepoRedaction 在密钥丢失/轮换导致解封失败时会
  // continue，把 url_redacted 原样留在 NULL。
  function seed(
    db: ReturnType<typeof createInMemoryDb>,
    rows: Array<{ id: string; urlRedacted: string | null }>,
  ): void {
    const now = Date.now()
    for (const r of rows) {
      db.insert(cachedRepos)
        .values({
          id: r.id,
          urlHash: `h-${r.id}`,
          urlRedacted: r.urlRedacted,
          urlEnc: 'enc',
          localPath: `/tmp/${r.id}`,
          lastFetchedAt: now,
          lastAutoRefreshAt: null,
          createdAt: now,
        })
        .run()
    }
  }

  test('NULL 的 url_redacted 必须 fail-closed（不知 scheme 就不自动 fetch）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seed(db, [
      { id: 'ok', urlRedacted: 'https://e.com/x.git' },
      { id: 'file', urlRedacted: FILE_URL },
      { id: 'unknown', urlRedacted: null },
      { id: 'blank', urlRedacted: '   ' },
    ])
    const due = await selectDueRepos(composeSqliteRepositoryWorkspaceStore(db), {
      now: Date.now(),
      intervalMs: 1,
      onlyRecentDays: 3650,
    })
    expect(due.map((r) => r.id)).toEqual(['ok'])
  })
})

describe('RFC-287 G5 — 启动面回归（判据换成共享谓词后行为不变）', () => {
  test('repoUrl=file:// 仍被 StartTaskSchema 拒', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 'x',
      repoUrl: FILE_URL,
      inputs: {},
    })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error?.issues)).toContain('repo-url-file-scheme-unsupported')
  })
})
